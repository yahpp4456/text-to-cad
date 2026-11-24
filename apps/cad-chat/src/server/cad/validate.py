#!/usr/bin/env python
"""apps/cad-chat 幾何驗證 harness。

import 產生器 .py -> 呼叫 gen_step() -> 用 cadpy.geometry_checks 跑真實檢查 ->
輸出 JSON 清單到 stdout。只列「這支腳本會做」的檢查,每列帶 status:

    ok              量過,通過
    failed          量過,沒過(或宣告本身無效)
    not_checked     該量而沒量到(掃掠逾時、設計模式略過)——**不算通過**
    not_applicable  這個模型不需要這項(單一零件沒有干涉可查、沒宣告 MOTION)

not_checked 與 not_applicable 的列同時標 skipped:true:既有的消費端(agent 的「非 skipped 且
fail 才自修」、教訓庫)把它們當「沒有失敗」,不會把逾時誤認成幾何錯誤。但完整驗證的總判定
(pipeline.mjs fullValidationOk、匯出閘)只認 ok 與 not_applicable:量不到不算通過。

用法:  python apps/cad-chat/src/server/cad/validate.py <generator.py> [--motion-only]
輸出:  {"ok": bool, "complete": bool, "checks": [{"id","label","ok","status","note","skipped"?}]}
       ok = 沒有 failed;complete = 沒有 not_checked。
環境:  CADCHAT_SWEEP_DEADLINE_S  掃掠的時間上限(秒,預設 75)
exit:  0 一律(驗證判定在 JSON.ok);只有 import/執行產生器失敗才 exit 1。
"""
import importlib.util
import json
import os
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
    # 與 cadpy build 路徑同義務:產生器目錄進 sys.path,讓組合件頂層 import 同目錄零件模組
    # (派工模式 <asm>_<part>.py)。獨立程序,不必還原。
    gen_dir = str(Path(script_path).resolve().parent)
    if gen_dir not in sys.path:
        sys.path.insert(0, gen_dir)
    spec.loader.exec_module(module)
    fn = getattr(module, "gen_step", None)
    if not callable(fn):
        raise AttributeError("generator does not define gen_step()")
    return fn, module


# ---------------------------------------------------------------------------
# MOTION 掃掠:產生器模組層宣告(travel 引用 PARAMS,import 後已是數值)->
# cadpy.geometry_checks.sweep_interference 真檢查。未宣告 -> 誠實 SKIP。
# ---------------------------------------------------------------------------
_MOTION_MAX_PAIRS_PER_DOF = 12
_MOTION_MAX_PAIR_FRAMES = 600      # Σ pairs×samples 預算
def _sweep_deadline_s() -> float:
    """掃掠中 wall-clock 深水閘(秒)。可用 CADCHAT_SWEEP_DEADLINE_S 覆寫;壞值用預設。"""
    try:
        value = float(os.environ.get("CADCHAT_SWEEP_DEADLINE_S", ""))
    except ValueError:
        return 75.0
    return value if value >= 0 else 75.0


_MOTION_SWEEP_DEADLINE_S = _sweep_deadline_s()
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
    """驗證+正規化模組層 MOTION。回 (motion|None, errors);無宣告 -> (None, [])。

    正規化本體在 cadpy.motion_decl(單一真相源:build 側 sidecar 收割
    _harvest_build_meta 用同一份,兩邊不可能分歧)。此 wrapper 只負責取模組屬性
    與 named -> labels 降維。
    """
    from cadpy.motion_decl import normalize_motion

    return normalize_motion(getattr(gen_module, "MOTION", None), [n for n, _ in named])


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


def _dof_frame_shape(base_shape, dof, u):
    """base_shape 依 dof 在參數 u 的變換(linear=平移;revolute=繞 pivot 軸轉)。

    位移比 f 由 cadpy.motion_decl.motion_fraction 給:無 profile = u(線性);
    帶 profile(閉鏈連桿的非線性從動)= 節點分段線性內插。與前端播放同一張表。
    """
    from cadpy.motion_decl import motion_fraction

    f = motion_fraction(dof, u)
    if dof.get("type") == "revolute":
        from build123d import Axis

        return base_shape.rotate(
            Axis(tuple(dof["pivot"]), tuple(dof["axis"])), f * dof["angle_deg"]
        )
    dv = tuple(a * f * dof["travel"] for a in dof["axis"])
    return base_shape.translate(dv)


def _run_motion_sweep(named, motion):
    """回一顆 motion_sweep check dict。

    每個「群」獨立掃(其他群保持 seated)。無耦合時一群=一個 DOF(舊語意不變);
    帶 ``couple`` 的從動 dof 併入主動 dof 的群,同一個 u 同步變換——齒輪齒條等
    嚙合傳動因此被「真的滾動」掃掠:跨成員的 pair(如 rack~pinion)保留,
    只有兩端在群內吃到的 dof 完全相同的 pair 才剔除(相對位姿不變)。
    """
    from cadpy.geometry_checks import sweep_interference

    base_map = dict(named)
    if len(base_map) < 2:
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
                "skipped": True, "note": "單件無對可掃"}

    # ── 分群:master(無 couple)+ 其 slaves,按宣告序 ──
    dofs = motion["dofs"]
    slaves_of = {}
    for d in dofs:
        if d.get("couple"):
            slaves_of.setdefault(d["couple"], []).append(d)

    notes = []
    plan = []  # [{gid, members, pairs, owner, samples, auto, baseline}]
    for dof in dofs:
        if dof.get("couple"):
            continue  # 從動併入 master 群
        members = [dof] + slaves_of.get(dof["id"], [])
        members.sort(key=lambda d: dofs.index(d))  # 疊加照宣告序(外層=後宣告)
        gid = "+".join(m["id"] for m in members)
        pairs, owner, auto = [], {}, False
        # 一個件在這個群裡吃到哪些成員 dof(依宣告序)。兩件的清單完全相同才是「同動」:
        # 只看單一 dof 會把「同被主動帶著走、但各自還有不同從動 dof」的一對誤剔——
        # 例:兩支連桿都隨推桿平移,卻各繞自己的銷反向擺動,彼此是有相對運動的。
        def _applied(name, members=members):
            return tuple(mm["id"] for mm in members if name in mm["moving"])

        for m in members:
            moving = set(m["moving"])
            if m["pairs"] is not None:
                kept, dropped = [], 0
                for a, b in m["pairs"]:
                    if a in moving and b in moving and _applied(a) == _applied(b):
                        dropped += 1  # 兩端吃到的 dof 完全相同 -> 相對位姿不變,掃了也恆 0
                        continue
                    kept.append((a, b))
                if dropped:
                    notes.append(f"{m['id']}: {dropped} 對同動剔除")
                if len(kept) > _MOTION_MAX_PAIRS_PER_DOF:
                    notes.append(f"{m['id']}: pairs 截至前 {_MOTION_MAX_PAIRS_PER_DOF}")
                    kept = kept[:_MOTION_MAX_PAIRS_PER_DOF]
            else:
                # 自動配對僅發生在單成員群(motion_decl 強制耦合群明給 pairs)
                kept = _auto_pairs(base_map, m)
                auto = True
                if not kept:
                    notes.append(
                        f"{m['id']}: 無靜態件可對掃" if len(moving) >= len(base_map)
                        else f"{m['id']}: 掃掠範圍內無鄰近靜態件"
                    )
            for p in kept:
                key = tuple(sorted(p))  # 無序去重:master/slave 各宣告一次算同一對
                if key not in owner:
                    pairs.append(p)
                    owner[key] = m
        plan.append({
            "gid": gid, "members": members, "pairs": pairs, "owner": owner,
            "auto": auto, "samples": max(m["samples"] for m in members),
            "baseline": "none" if any(m["baseline"] == "none" for m in members) else "seated",
        })

    total = sum(len(g["pairs"]) * g["samples"] for g in plan)
    if total > _MOTION_MAX_PAIR_FRAMES:
        scale = _MOTION_MAX_PAIR_FRAMES / total
        for g in plan:
            if g["pairs"]:
                g["samples"] = max(3, int(g["samples"] * scale))
        total = sum(len(g["pairs"]) * g["samples"] for g in plan)
        while total > _MOTION_MAX_PAIR_FRAMES:
            trimmed = False
            for g in plan:
                if g["auto"] and len(g["pairs"]) > 1 and total > _MOTION_MAX_PAIR_FRAMES:
                    g["pairs"].pop()  # 只截自動配對尾端;明示 pairs 永不靜默丟
                    total -= g["samples"]
                    trimmed = True
            if not trimmed:
                break
        notes.append(f"超出預算,降級後掃 {total} pair-frames")

    if all(not g["pairs"] for g in plan):
        note = ";".join(["無可掃配對"] + notes)
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
                "skipped": True, "note": note}

    deadline = time.monotonic() + _MOTION_SWEEP_DEADLINE_S
    state = {"done": 0, "timeout": False}
    frames_total = sum(g["samples"] for g in plan if g["pairs"])
    all_hits = []

    for g in plan:
        if not g["pairs"]:
            continue
        involved = {n for pr in g["pairs"] for n in pr}
        member_moving = [(m, set(m["moving"]) & involved) for m in g["members"]]
        group_moving = set().union(*(mv for _, mv in member_moving))
        static_src = {n: base_map[n] for n in involved - group_moving}

        def poses(g=g, member_moving=member_moving, static_src=static_src):
            for i in range(1, g["samples"] + 1):
                if time.monotonic() > deadline:
                    state["timeout"] = True
                    return
                u = i / g["samples"]
                frame = dict(static_src)
                # 成員照宣告序依次施加(對重疊 moving 為世界座標序列合成,
                # 等價前端 premultiply:後宣告者在外層)
                for m, mv in member_moving:
                    for n in mv:
                        frame[n] = _dof_frame_shape(frame.get(n, base_map[n]), m, u)
                state["done"] += 1
                yield (f"{g['gid']}@u={u:.3f}", frame)

        # 參考姿態 baseline 必須是 (name, shape) 清單——dict 會被 cadpy 解讀成
        # 配對基線表 {(a,b): mm^3},靜默變成全 0 基線。
        baseline = [(n, base_map[n]) for n in involved] if g["baseline"] == "seated" else None
        try:
            hits = sweep_interference(poses(), g["pairs"], baseline=baseline, tol=0.05)
        except Exception as exc:  # noqa: BLE001
            return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": False,
                    "note": f"掃掠失敗: {type(exc).__name__}: {exc}"}
        all_hits.extend(
            (g["owner"].get(tuple(sorted((h.a, h.b)))) or g["members"][0], h)
            for h in hits
        )
        if state["timeout"]:
            break

    n_dof = sum(len(g["members"]) for g in plan if g["pairs"])
    n_pairs = sum(len(g["pairs"]) for g in plan)
    coupled = [g["gid"] for g in plan if len(g["members"]) > 1 and g["pairs"]]
    bases = sorted({g["baseline"] for g in plan if g["pairs"]})
    stat = f"{n_dof} DOF · {n_pairs} 對 · {state['done']}/{frames_total} 幀 · baseline={'/'.join(bases)}"
    if coupled:
        stat += f" · 耦合群 {','.join(coupled)}"
    if notes:
        stat += " · " + ";".join(notes)

    if all_hits:
        all_hits.sort(key=lambda t: t[1].excess, reverse=True)
        dof0, h0 = all_hits[0]
        pos = ""
        try:
            from cadpy.motion_decl import motion_fraction

            f0 = motion_fraction(dof0, float(str(h0.where).rsplit("u=", 1)[1]))
            if dof0.get("type") == "revolute":
                pos = f"(轉角 {f0 * dof0['angle_deg']:.1f}°)"
            else:
                pos = f"(位移 {f0 * dof0['travel']:.1f}mm)"
        except Exception:  # noqa: BLE001
            pass
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": False,
                "note": (f"{h0.where}: {h0.a}~{h0.b} 超出 +{h0.excess:.1f}mm³{pos};"
                         f"共 {len(all_hits)} pair-frame 穿透(掃 {stat})")}
    if state["timeout"]:
        # 沒掃完 = 沒量到。已掃的部分沒有穿透,但剩下的幀沒有任何證據,不能說通過。
        return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True, "skipped": True,
                "status": "not_checked",
                "note": f"未量測:掃掠逾時,只掃了一部分(已掃部分無穿透;掃 {stat})"}
    return {"id": "motion_sweep", "label": _MOTION_LABEL, "ok": True,
            "note": f"全程無穿透(掃 {stat})"}


def _status_of(check: dict) -> str:
    """沒有明確標 status 的列:skipped = 該量沒量(not_checked),否則看 ok。"""
    if check.get("skipped"):
        return "not_checked"
    return "ok" if check.get("ok") else "failed"


def main() -> int:
    args = sys.argv[1:]
    motion_only = "--motion-only" in args  # 設計模式:跳過貴檢查,只解析 MOTION 供播放
    positional = [a for a in args if not a.startswith("--")]
    if not positional:
        print(json.dumps({"ok": False, "checks": [], "error": "missing generator path"}))
        return 1
    script_path = Path(positional[0]).resolve()
    try:
        gen_step, gen_module = _load_gen_step(script_path)
        payload = gen_step()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps(
            {"ok": False, "checks": [], "error": f"{type(exc).__name__}: {exc}"},
            ensure_ascii=False,
        ))
        return 1

    from cadpy.geometry_checks import enumerate_interferences, invalid_solid_detail, is_valid_solid

    try:
        from cadpy.geometry_checks import _as_named_parts

        named = list(_as_named_parts(payload))
    except Exception:
        named = [("part", payload)]

    checks = []

    # 1) 有效實體 (BRepCheck) — watertight / valid solid 的可信替代
    if motion_only:
        checks.append({
            "id": "valid_solid",
            "label": "封閉性 / 有效實體 (watertight)",
            "ok": True,
            "skipped": True,
            "note": "設計模式:略過驗證(未驗證)",
        })
    else:
        try:
            bad = [(n, s) for n, s in named if not is_valid_solid(s)]
            ok = len(bad) == 0
            if ok:
                note = "BRepCheck valid"
            else:
                # 每個壞件附上叫得出名字的問題(哪個殼沒封閉、哪個面的線框自交…;面號 = 點選
                # token 的 fN)。叫不出名字的就只列件名——仍然是無效。只展開前 3 件,避免洗版。
                def describe(name, shape):
                    detail = invalid_solid_detail(shape)
                    return f"{name}({detail})" if detail else name

                note = "無效: " + ", ".join(
                    describe(n, s) if i < 3 else n for i, (n, s) in enumerate(bad)
                )
        except Exception as exc:  # noqa: BLE001
            ok, note = False, f"檢查失敗: {exc}"
        checks.append({
            "id": "valid_solid",
            "label": "封閉性 / 有效實體 (watertight)",
            "ok": ok,
            "note": note,
        })

    # 2) 零件干涉 — 只在多件組合時有意義。尊重產生器宣告的 INTENDED_CONTACT
    # (與其 check_geometry gate 同一份 allow-list),但把 allowed 對數報出來,
    # 不靜默(L-5:黏方塊白名單必須可見)。
    if motion_only:
        checks.append({
            "id": "interference",
            "label": "零件干涉 interference",
            "ok": True,
            "skipped": True,
            "note": "設計模式:略過驗證(未驗證)",
        })
    elif len(named) >= 2:
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
            "status": "not_applicable",
            "note": "單一零件,無需檢查",
        })

    # 3) 運動掃掠干涉 — 產生器宣告 MOTION 時真跑 cadpy sweep;未宣告誠實跳過
    motion, motion_errs = _read_motion(gen_module, named)
    if motion_errs:
        # 宣告已知錯誤 = 真 fail(兩條路徑一致;--motion-only 也不偽裝成 skipped,
        # 否則 agent 的「非 skipped 且 fail 才自修」永遠不觸發)。note 前綴與
        # pipeline.designChecksFromMeta / lessons signature 同字。
        checks.append({
            "id": "motion_sweep",
            "label": _MOTION_LABEL,
            "ok": False,
            "note": "MOTION 宣告無效: " + "; ".join(motion_errs[: 2 if motion_only else 3]),
        })
    elif motion is None:
        checks.append({
            "id": "motion_sweep",
            "label": _MOTION_LABEL,
            "ok": True,
            "skipped": True,
            "status": "not_applicable",
            "note": "未提供運動學",
        })
    elif motion_only:
        checks.append({
            "id": "motion_sweep",
            "label": _MOTION_LABEL,
            "ok": True,
            "skipped": True,
            "note": "設計模式:略過掃掠(未驗證)",
        })
    else:
        checks.append(_run_motion_sweep(named, motion))

    # 自交、壁厚:這支腳本沒有這兩項檢查,所以不列(以前各佔一列、永遠 skipped)。

    for check in checks:
        check.setdefault("status", _status_of(check))
    overall = all(c["ok"] for c in checks if not c.get("skipped"))
    complete = not any(c["status"] == "not_checked" for c in checks)
    # parts: 權威 label 清單(真跑 gen_step 後),伺服端據此寫組合件 manifest
    out = {"ok": overall, "complete": complete, "checks": checks, "partCount": len(named),
           "parts": [n for n, _ in named]}
    if motion is not None:
        # 前端播放用的宣告(數值已是 import 後的值,滑桿重生自動跟上);
        # 降維邏輯在 cadpy.motion_decl(與 build sidecar 同源)
        from cadpy.motion_decl import playback_motion

        out["motion"] = playback_motion(motion)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
