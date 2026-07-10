"""MOTION 宣告(cad-chat 運動學契約)的驗證/正規化 — 單一真相源。

產生器模組層的 ``MOTION`` dict(travel/angle_deg 引用 PARAMS,import 後已是純數值)
在兩處被消費,必須逐位一致:

1. build 側 sidecar 收割(``cadpy.generation._harvest_build_meta``):設計模式零 spawn
   的 ``.{name}.step.meta.json`` 來源;
2. cad-chat 驗證 harness(``apps/cad-chat/src/server/cad/validate.py``):實際模式的
   掃掠前置與 ``--motion-only`` fallback。

本模組刻意**純 stdlib**(不 import OCP/build123d):正規化只做資料驗證,不碰幾何;
幾何掃掠(sweep)留在 validate.py / geometry_checks。錯誤訊息字串是對外契約
(cad-chat 驗證卡 note 與根測試斷言依賴),勿改寫。
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

MOTION_MAX_DOFS = 8  # xyz 三軸 + 4 支獨立末端缸(e0..e3)= 7,留一格餘裕


def normalize_motion(
    raw: object, part_labels: Sequence[str]
) -> tuple[dict | None, list[str]]:
    """驗證+正規化 MOTION 宣告。回 (motion|None, errors);raw=None -> (None, [])。

    ``part_labels`` 須為 ``_as_named_parts`` 產出的 label 清單(重複 label 已帶
    ``#n`` 後綴)。回傳的 motion dict 含完整 dofs(掃掠所需欄位齊備);前端播放
    子集用 :func:`playback_motion` 降維。
    """
    if raw is None:
        return None, []
    names = set(part_labels)
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
    if not 1 <= len(raw["dofs"]) <= MOTION_MAX_DOFS:
        return None, [f"dofs 數量須為 1–{MOTION_MAX_DOFS}"]

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
        dtype = d.get("type", "linear")
        if dtype not in ("linear", "revolute"):
            errs.append(f"{did}: type 僅支援 'linear' 或 'revolute'")
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
        travel = pivot = angle_deg = None
        if dtype == "linear":
            try:
                travel = float(d["travel"])
            except Exception:
                errs.append(f"{did}: travel 須為數值")
                continue
            if not (math.isfinite(travel) and 1e-6 < abs(travel) < 1e5):
                errs.append(f"{did}: travel 須在 ±(1e-6, 1e5) mm")
                continue
        else:  # revolute（URDF 關節:軸 + pivot + 角度限制）
            try:
                pivot = [float(x) for x in d["pivot"]][:3]
            except Exception:
                errs.append(f"{did}: revolute 須提供 pivot(3 個數)")
                continue
            if len(pivot) != 3 or not all(math.isfinite(x) for x in pivot):
                errs.append(f"{did}: pivot 須為 3 個有限數")
                continue
            try:
                angle_deg = float(d["angle_deg"])
            except Exception:
                errs.append(f"{did}: revolute 須提供 angle_deg(數值)")
                continue
            if not (math.isfinite(angle_deg) and 1e-3 < abs(angle_deg) <= 3600.0):
                errs.append(f"{did}: angle_deg 須在 ±(1e-3, 3600] 度")
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
        if dtype == "revolute" and norm_pairs is None:
            d_errs.append(f"{did}: revolute 須明給 pairs(不走線性 AABB 自動配對)")
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
        dof_out = {
            "id": did,
            "label": str(d.get("label") or did),
            "type": dtype,
            "axis": ax,
            "origin": origin,
            "moving": moving,
            "pairs": norm_pairs,
            "samples": samples,
            "baseline": baseline,
            "period_s": period,
        }
        if dtype == "linear":
            dof_out["travel"] = travel
        else:
            dof_out["pivot"] = pivot
            dof_out["angle_deg"] = angle_deg
        couple = d.get("couple")
        if couple is not None:
            dof_out["couple"] = str(couple).strip()
        dofs.append(dof_out)

    # couple(嚙合耦合:齒輪齒條/齒輪對等)第二趟驗證——引用要看得到全部 id。
    # 語意:從動 dof 與主動 dof 由同一參數 u 同步驅動(比率隱含在各自宣告的
    # travel / angle_deg 幅度裡);掃掠與播放都同步,嚙合面才能被真的滾動驗證。
    if not errs:
        ids = {d["id"] for d in dofs}
        coupled_ids = {d["id"] for d in dofs if d.get("couple")}
        for d in dofs:
            cid = d.get("couple")
            if cid is None:
                continue
            if cid == d["id"] or cid not in ids:
                errs.append(f"{d['id']}: couple 須指向另一個存在的 dof id")
                continue
            if cid in coupled_ids:
                errs.append(f"{d['id']}: couple 目標 {cid} 自身也是從動(禁止鏈式耦合)")
            if d["pairs"] is None:
                errs.append(f"{d['id']}: 耦合 dof 必須明給 pairs")
            master = next(m for m in dofs if m["id"] == cid)
            if master["pairs"] is None:
                errs.append(f"{d['id']}: couple 主動 dof {cid} 必須明給 pairs")
    if errs:
        return None, errs
    return {"schemaVersion": 1, "dofs": dofs}, []


def playback_motion(motion: Mapping | None) -> dict | None:
    """把 :func:`normalize_motion` 的完整 dofs 降維成前端播放子集。

    只留 id/label/type/axis/moving/period_s/couple + (travel | pivot/angle_deg);
    掃掠專用欄位(pairs/samples/baseline/origin)不外洩給前端。couple 要透傳:
    前端播放器據此讓從動 dof 跟主動 dof 同相位(嚙合不打滑)。
    """
    if motion is None:
        return None
    play_dofs = []
    for d in motion["dofs"]:
        pd = {
            "id": d["id"],
            "label": d["label"],
            "type": d.get("type", "linear"),
            "axis": d["axis"],
            "moving": d["moving"],
            "period_s": d["period_s"],
        }
        if d.get("type") == "revolute":
            pd["pivot"] = d["pivot"]
            pd["angle_deg"] = d["angle_deg"]
        else:
            pd["travel"] = d["travel"]
        if d.get("couple"):
            pd["couple"] = d["couple"]
        play_dofs.append(pd)
    return {"schemaVersion": 1, "dofs": play_dofs}
