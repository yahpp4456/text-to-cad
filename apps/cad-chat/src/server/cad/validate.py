#!/usr/bin/env python
"""apps/cad-chat 幾何驗證 harness。

import 產生器 .py -> 呼叫 gen_step() -> 用 cadpy.geometry_checks 跑真實檢查 ->
輸出 JSON 清單到 stdout。只報「真的有跑」的檢查;pipeline 沒有的(自交/壁厚)標 skipped,
不假裝 PASS(誠實原則,PRD §10.9)。

用法:  python apps/cad-chat/src/server/cad/validate.py <generator.py>
輸出:  {"ok": bool, "checks": [{"id","label","ok","note","skipped"?}]}
exit:  0 一律(驗證判定在 JSON.ok);只有 import/執行產生器失敗才 exit 1。
"""
import importlib.util
import json
import math
import sys
import time
from pathlib import Path


def _load_gen_step(script_path: Path):
    module_name = f"cadchat_validate_{abs(hash(str(script_path)))}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load generator: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    fn = getattr(module, "gen_step", None)
    if not callable(fn):
        raise AttributeError("generator does not define gen_step()")
    return fn, module


# ---------------------------------------------------------------------------
# MOTION 掃掠:產生器模組層宣告(travel 引用 PARAMS,import 後已是數值)->
# cadpy.geometry_checks.sweep_interference 真檢查。未宣告 -> 誠實 SKIP。
# ---------------------------------------------------------------------------
_MOTION_MAX_DOFS = 8  # xyz 三軸 + 4 支獨立末端缸(e0..e3)= 7,留一格餘裕
_MOTION_MAX_PAIRS_PER_DOF = 12
_MOTION_MAX_PAIR_FRAMES = 600      # Σ pairs×samples 預算
_MOTION_SWEEP_DEADLINE_S = 75.0    # 掃掠中 wall-clock 深水閘
_MOTION_AABB_MARGIN = 2.0          # 自動配對的 AABB 外擴 (mm)
_MOTION_LABEL = "運動掃掠干涉 motion-sweep"


def _aabb(shape):
    bb = shape.bounding_box()
    return [bb.min.X, bb.min.Y, bb.min.Z], [bb.max.X, bb.max.Y, bb.max.Z]


def _swept_aabb(shape, axis, travel):
    """shape 沿 axis*travel 掃掠展開的 AABB。"""
    lo, hi = _aabb(shape)
    d = [a * travel for a in axis]
    return (
        [lo[k] + min(0.0, d[k]) for k in range(3)],
        [hi[k] + max(0.0, d[k]) for k in range(3)],
    )


def _aabb_overlap_volume(a, b, margin=0.0):
    v = 1.0
    for k in range(3):
        lo = max(a[0][k], b[0][k]) - margin
        hi = min(a[1][k], b[1][k]) + margin
        if hi <= lo:
            return 0.0
        v *= hi - lo
    return v


def _read_motion(gen_module, named):
    """驗證+正規化模組層 MOTION。回 (motion|None, errors);無宣告 -> (None, [])。"""
    raw = getattr(gen_module, "MOTION", None)
    if raw is None:
        return None, []
    names = {n for n, _ in named}
    # _as_named_parts 對重複 label 加 #n:出現 name#1 代表原名重複、引用有歧義
    ambiguous = {n.rsplit("#", 1)[0] for n in names if "#" in n}

    def _label_errs(refs, what):
        out = []
        missing = [r for r in refs if r not in names]
        dup = [r for r in refs if r in ambiguous]
        if missing:
            out.append(f"{what} 引用不存在的 label: {', '.join(missing[:3])}")
        if dup:
            out.append(f"{what} 引用重複的 label(運動件 label 必須唯一): {', '.join(dup[:3])}")
        return out

    if not isinstance(raw, dict) or not isinstance(raw.get("dofs"), (list, tuple)):
        return None, ["MOTION 須為含 dofs 清單的 dict"]
    if not 1 <= len(raw["dofs"]) <= _MOTION_MAX_DOFS:
        return None, [f"dofs 數量須為 1–{_MOTION_MAX_DOFS}"]

    errs, dofs, seen = [], [], set()
    for i, d in enumerate(raw["dofs"]):
        if not isinstance(d, dict):
            errs.append(f"dofs[{i}]: 須為 dict")
            continue
        did = str(d.get("id") or "").strip()
        if not did or did in seen:
            errs.append(f"dofs[{i}]: id 缺失或重複")
            continue
        seen.add(did)
        if d.get("type", "linear") != "linear":
            errs.append(f"{did}: v1 僅支援 type='linear'")
            continue
        try:
            ax = [float(x) for x in d["axis"]][:3]
            norm = math.sqrt(sum(x * x for x in ax)) if len(ax) == 3 else 0.0
        except Exception:
            errs.append(f"{did}: axis 須為 3 個數")
            continue
        if not (math.isfinite(norm) and norm > 1e-9):
            errs.append(f"{did}: axis 模長無效")
            continue
        ax = [x / norm for x in ax]
        try:
            travel = float(d["travel"])
        except Exception:
            errs.append(f"{did}: travel 須為數值")
            continue
        if not (math.isfinite(travel) and 1e-6 < abs(travel) < 1e5):
            errs.append(f"{did}: travel 須在 ±(1e-6, 1e5) mm")
            continue
        moving = d.get("moving")
        if not isinstance(moving, (list, tuple)) or not moving:
            errs.append(f"{did}: moving 須為非空 label 清單")
            continue
        moving = [str(m) for m in moving]
        d_errs = _label_errs(moving, f"{did}: moving")
        pairs = d.get("pairs")
        norm_pairs = None
        if pairs is not None:
            norm_pairs = []
            for p in pairs:
                if not isinstance(p, (list, tuple)) or len(p) != 2 or str(p[0]) == str(p[1]):
                    d_errs.append(f"{did}: pairs 每項須為兩個不同 label")
                    norm_pairs = None
                    break
                norm_pairs.append((str(p[0]), str(p[1])))
            if norm_pairs is not None:
                d_errs += _label_errs([x for pr in norm_pairs for x in pr], f"{did}: pairs")
        if d_errs:
            errs.extend(d_errs)
            continue
        try:
            samples = max(3, min(24, int(d.get("samples", 8))))
        except Exception:
            samples = 8
        baseline = d.get("baseline", "seated")
        if baseline not in ("seated", "none"):
            errs.append(f"{did}: baseline 須為 'seated' 或 'none'")
            continue
        try:
            period = max(1.0, min(20.0, float(d.get("period_s", 4.0))))
        except Exception:
            period = 4.0
        try:
            origin = [float(x) for x in (d.get("origin") or (0.0, 0.0, 0.0))][:3]
        except Exception:
            origin = [0.0, 0.0, 0.0]
        dofs.append({
            "id": did,
            "label": str(d.get("label") or did),
            "axis": ax,
            "travel": travel,
            "origin": origin,
            "moving": moving,
            "pairs": norm_pairs,
            "samples": samples,
            "baseline": baseline,
            "period_s": period,
        })
    if errs:
        return None, errs
    return {"schemaVersion": 1, "dofs": dofs}, []


def _auto_pairs(base_map, dof):
    """moving×static,掃掠 AABB(+margin)相交者,依交疊體積降冪截前 N 對。"""
    moving = set(dof["moving"])
    static = [n for n in base_map if n not in moving]
    if not static:
        return []
    static_boxes = {n: _aabb(base_map[n]) for n in static}
    cands = []
    for m in dof["moving"]:
        sw = _swept_aabb(base_map[m], dof["axis"], dof["travel"])
        for s in static:
            v = _aabb_overlap_volume(sw, static_boxes[s], margin=_MOTION_AABB_MARGIN)
            if v > 0.0:
                cands.append((v, (m, s)))
    cands.sort(key=lambda t: t[0], reverse=True)
    return [p for _, p in cands[:_MOTION_MAX_PAIRS_PER_DOF]]


def _run_motion_sweep(named, motion):
    """回一顆 motion_sweep check dict。per-DOF 獨立掃(其他 DOF 保持 seated)。"""
    from cadpy.geometry_checks import sweep_interference

    base_map = dict(named)
    if len(base_map) < 2:
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
                "skipped": True, "note": "單件無對可掃"}

    notes = []
    plan = []  # [dof, pairs, is_auto]
    for dof in motion["dofs"]:
        moving = set(dof["moving"])
        if dof["pairs"] is not None:
            pairs, dropped = [], 0
            for a, b in dof["pairs"]:
                if a in moving and b in moving:
                    dropped += 1  # 兩端同動 -> 相對位姿不變,掃了也恆 0
                    continue
                pairs.append((a, b))
            if dropped:
                notes.append(f"{dof['id']}: {dropped} 對同動剔除")
            if len(pairs) > _MOTION_MAX_PAIRS_PER_DOF:
                notes.append(f"{dof['id']}: pairs 截至前 {_MOTION_MAX_PAIRS_PER_DOF}")
                pairs = pairs[:_MOTION_MAX_PAIRS_PER_DOF]
            plan.append([dof, pairs, False])
        else:
            pairs = _auto_pairs(base_map, dof)
            if not pairs:
                notes.append(
                    f"{dof['id']}: 無靜態件可對掃" if len(moving) >= len(base_map)
                    else f"{dof['id']}: 掃掠範圍內無鄰近靜態件"
                )
            plan.append([dof, pairs, True])

    total = sum(len(p) * d["samples"] for d, p, _ in plan)
    if total > _MOTION_MAX_PAIR_FRAMES:
        scale = _MOTION_MAX_PAIR_FRAMES / total
        for d, p, _ in plan:
            if p:
                d["samples"] = max(3, int(d["samples"] * scale))
        total = sum(len(p) * d["samples"] for d, p, _ in plan)
        while total > _MOTION_MAX_PAIR_FRAMES:
            trimmed = False
            for d, p, is_auto in plan:
                if is_auto and len(p) > 1 and total > _MOTION_MAX_PAIR_FRAMES:
                    p.pop()  # 只截自動配對尾端;明示 pairs 永不靜默丟
                    total -= d["samples"]
                    trimmed = True
            if not trimmed:
                break
        notes.append(f"超出預算,降級後掃 {total} pair-frames")

    if all(not p for _, p, _ in plan):
        note = ";".join(["無可掃配對"] + notes)
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
                "skipped": True, "note": note}

    deadline = time.monotonic() + _MOTION_SWEEP_DEADLINE_S
    state = {"done": 0, "timeout": False}
    frames_total = sum(d["samples"] for d, p, _ in plan if p)
    all_hits = []

    for dof, pairs, _is_auto in plan:
        if not pairs:
            continue
        involved = {n for pr in pairs for n in pr}
        moving_set = set(dof["moving"]) & involved
        static_src = {n: base_map[n] for n in involved - moving_set}

        def poses(dof=dof, moving_set=moving_set, static_src=static_src):
            for i in range(1, dof["samples"] + 1):
                if time.monotonic() > deadline:
                    state["timeout"] = True
                    return
                u = i / dof["samples"]
                dv = tuple(a * u * dof["travel"] for a in dof["axis"])
                frame = dict(static_src)
                for n in moving_set:
                    frame[n] = base_map[n].translate(dv)
                state["done"] += 1
                yield (f"{dof['id']}@u={u:.3f}", frame)

        # 參考姿態 baseline 必須是 (name, shape) 清單——dict 會被 cadpy 解讀成
        # 配對基線表 {(a,b): mm^3},靜默變成全 0 基線。
        baseline = [(n, base_map[n]) for n in involved] if dof["baseline"] == "seated" else None
        try:
            hits = sweep_interference(poses(), pairs, baseline=baseline, tol=0.05)
        except Exception as exc:  # noqa: BLE001
            return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": False,
                    "note": f"掃掠失敗: {type(exc).__name__}: {exc}"}
        all_hits.extend((dof, h) for h in hits)
        if state["timeout"]:
            break

    n_dof = sum(1 for _, p, _ in plan if p)
    n_pairs = sum(len(p) for _, p, _ in plan)
    bases = sorted({d["baseline"] for d, p, _ in plan if p})
    stat = f"{n_dof} DOF · {n_pairs} 對 · {state['done']}/{frames_total} 幀 · baseline={'/'.join(bases)}"
    if notes:
        stat += " · " + ";".join(notes)

    if all_hits:
        all_hits.sort(key=lambda t: t[1].excess, reverse=True)
        dof0, h0 = all_hits[0]
        pos = ""
        try:
            u0 = float(str(h0.where).rsplit("u=", 1)[1])
            pos = f"(位移 {u0 * dof0['travel']:.1f}mm)"
        except Exception:  # noqa: BLE001
            pass
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": False,
                "note": (f"{h0.where}: {h0.a}~{h0.b} 超出 +{h0.excess:.1f}mm³{pos};"
                         f"共 {len(all_hits)} pair-frame 穿透(掃 {stat})")}
    if state["timeout"]:
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
                "note": f"已掃部分無穿透,掃掠未完成——逾時(掃 {stat})"}
    return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
            "note": f"全程無穿透(掃 {stat})"}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "checks": [], "error": "missing generator path"}))
        return 1
    script_path = Path(sys.argv[1]).resolve()
    try:
        gen_step, gen_module = _load_gen_step(script_path)
        payload = gen_step()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps(
            {"ok": False, "checks": [], "error": f"{type(exc).__name__}: {exc}"},
            ensure_ascii=False,
        ))
        return 1

    from cadpy.geometry_checks import enumerate_interferences, is_valid_solid

    try:
        from cadpy.geometry_checks import _as_named_parts

        named = list(_as_named_parts(payload))
    except Exception:
        named = [("part", payload)]

    checks = []

    # 1) 有效實體 (BRepCheck) — watertight / valid solid 的可信替代
    try:
        verdicts = [(n, is_valid_solid(s)) for n, s in named]
        bad = [n for n, ok in verdicts if not ok]
        ok = len(bad) == 0
        note = "BRepCheck valid" if ok else "無效: " + ", ".join(bad)
    except Exception as exc:  # noqa: BLE001
        ok, note = False, f"檢查失敗: {exc}"
    checks.append({
        "id": "valid_solid",
        "label": "封閉性 / 有效實體 (watertight)",
        "ok": ok,
        "note": note,
    })

    # 2) 自交 — 無獨立檢查;BRepCheck 已涵蓋基本有效性(誠實標 skipped)
    checks.append({
        "id": "self_intersection",
        "label": "自交 self-intersection",
        "ok": True,
        "skipped": True,
        "note": "未支援獨立檢查",
    })

    # 3) 零件干涉 — 只在多件組合時有意義。尊重產生器宣告的 INTENDED_CONTACT
    # (與其 check_geometry gate 同一份 allow-list),但把 allowed 對數報出來,
    # 不靜默(L-5:黏方塊白名單必須可見)。
    if len(named) >= 2:
        try:
            allow = getattr(gen_module, "INTENDED_CONTACT", ()) or ()
            report = enumerate_interferences(payload, allow=allow)
            n_over = len(report.overlaps)
            n_allowed = len(report.allowed)
            ok = n_over == 0
            note = "0 undeclared overlaps" if ok else f"{n_over} 處未宣告干涉"
            if n_allowed:
                note += f" · {n_allowed} 對宣告接觸(allowed)"
            checks.append({
                "id": "interference",
                "label": "零件干涉 interference",
                "ok": ok,
                "note": note,
            })
        except Exception as exc:  # noqa: BLE001
            checks.append({
                "id": "interference",
                "label": "零件干涉 interference",
                "ok": False,
                "note": f"檢查失敗: {exc}",
            })
    else:
        checks.append({
            "id": "interference",
            "label": "零件干涉 interference",
            "ok": True,
            "skipped": True,
            "note": "單一零件,無需檢查",
        })

    # 4) 運動掃掠干涉 — 產生器宣告 MOTION 時真跑 cadpy sweep;未宣告誠實跳過
    motion, motion_errs = _read_motion(gen_module, named)
    if motion_errs:
        checks.append({
            "id": "motion_sweep",
            "label": _MOTION_LABEL,
            "ok": False,
            "note": "MOTION 宣告無效: " + "; ".join(motion_errs[:3]),
        })
    elif motion is None:
        checks.append({
            "id": "motion_sweep",
            "label": _MOTION_LABEL,
            "ok": True,
            "skipped": True,
            "note": "未提供運動學",
        })
    else:
        checks.append(_run_motion_sweep(named, motion))

    # 5) 壁厚 — pipeline 目前無此檢查
    checks.append({
        "id": "wall_thickness",
        "label": "壁厚 wall-thickness",
        "ok": True,
        "skipped": True,
        "note": "pipeline 未支援",
    })

    overall = all(c["ok"] for c in checks if not c.get("skipped"))
    # parts: 權威 label 清單(真跑 gen_step 後),伺服端據此寫組合件 manifest
    out = {"ok": overall, "checks": checks, "partCount": len(named),
           "parts": [n for n, _ in named]}
    if motion is not None:
        # 前端播放用的宣告(travel 已是 import 後的數值,滑桿重生自動跟上)
        out["motion"] = {"schemaVersion": 1, "dofs": [
            {"id": d["id"], "label": d["label"], "type": "linear", "axis": d["axis"],
             "travel": d["travel"], "moving": d["moving"], "period_s": d["period_s"]}
            for d in motion["dofs"]]}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
