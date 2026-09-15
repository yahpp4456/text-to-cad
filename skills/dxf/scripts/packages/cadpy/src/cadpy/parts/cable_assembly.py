"""Cleanroom cable assembly builder driven entirely by a CABLE_SPEC dict.

The "per-layer length" family (``models/cable_*_per_layer``) is **one**
implementation parameterised by data:

    CABLE_SPEC = {
      "layers": N,               # 層數(= 帶表的 level 數)
      "riser_module": i,         # 加高模組在固定架堆疊中的索引(底起 0)
      "measured": {...},         # 量測/型錄常數(見 cable_spec._DEFAULT_M + 固定架細節)
      "bands": [ {key, level, n, bore, web, edge, x}, ... ]
    }
    PARAMS = {"L1".."LN", "width", "head_h", "mount_h", "bottom_leg"}

so changing the layer count or a band row is a **data** edit (cad-chat's
``rewriteSpec``), not a code edit -- that is what lets the spec form offer
「層數」and「帶型」without asking an LLM to rewrite a generator.

Geometry:
- one :func:`cadpy.parts.cleanroom_sleeve` per band row, swept along that
  layer's drag-chain U path (closed form in :mod:`cadpy.parts.cable_spec`);
- both ends get an N-module rack stack built by :func:`rack_module` -- the
  OEM 線架 reproduced feature-for-feature from the customer STEPs (2026-08-25
  face census, tmp/rack_local.py, X and Y both ends):
  clamp land / relief groove / guide slot / through-slot / fastener group /
  label recess, split into top+bottom halves at the layer plane;
- rack1 (bottom end) hosts levels 0..N-1 bottom-up, rack2 (top end) reversed.

The OEM guide slot is a CATALOG width (99.2 ref) -- narrower than the 105
band rows by 2.9 per side.  The elastomer sleeve edges are squeezed by the
clamp in real life; the OEM CAD simply overlaps (measured ~294 mm^3 total on
X rack1).  We reproduce that verbatim, so the generators must declare the
overlapping pairs: use :func:`intended_contact` (computed from CABLE_SPEC, so
layer/band edits via rewriteSpec keep the allow-list in step).

``bands`` conventions: ``web``/``edge`` are overrides on the EHSL closed form
and ``web = 0`` means "don't override" (CABLE_SPEC is JSON-compatible, so it
has no ``None``); ``x`` is the band centre in the reference-width coordinate
system and scales with ``width``.
"""

from __future__ import annotations

import math

from cadpy.parts.cable_spec import (
    _DEFAULT_M,
    check as _check,
    derive as _derive,
    layer_key,
)

__all__ = [
    "band_path",
    "band_at",
    "band_args",
    "sweep_paths",
    "rack_module",
    "intended_contact",
    "build",
]


def _m_of(spec: dict) -> dict:
    from cadpy.parts.cable_spec import _m_of as _base

    return _base(spec)


def band_path(layer: dict) -> dict:
    """該層的掃出路徑 spec(拖鏈 U;與 SWEEP_PATHS 共用同一份)。"""
    return {
        "kind": "drag_chain",
        "straight_a": layer["straight_a"],
        "bend_r": layer["r"],
        "straight_b": layer["straight_b"],
    }


def band_at(band: dict, layer: dict, s: float, tip: float) -> tuple:
    """帶的世界定位:x 隨 width 等比、y 對齊下端頭、z 是該層窗口高。"""
    return (float(band.get("x", 0.0)) * s, -tip, layer["z_bot"])


def band_args(band: dict, s: float, m: dict) -> tuple:
    """帶的 sleeve 參數(等比縮放 X 向:bore/web/edge;厚度不縮)。"""
    kw = {
        "wall_t": float(m["wall_t"]),
        "outer_h": float(m["outer_h"]),
        "edge": float(band["edge"]) * s,
    }
    web = band.get("web") or None  # 0 = 不覆寫 EHSL 腰腹板閉式(JSON 沒有 None)
    if web is not None:
        kw["web"] = float(web) * s
    pocket_w = float(band["bore"]) * s + 2.0 * float(m["wall_t"])
    return int(band["n"]), pocket_w, kw


def sweep_paths(params: dict, spec: dict, m: dict | None = None) -> list[dict]:
    """3D 視圖的路徑中心虛線 overlay:**每層一條**(不是每帶一條)。
    同層並排的窄條共用同一條中心線,畫在該層帶群的 x 中心——這也讓收割上限
    (generation._SWEEP_PATHS_MAX = 8)在 N 大時不會靜默截斷。"""
    from cadpy.parts import path_polyline, sleeve_dims

    mm = _m_of(spec) if m is None else {**_m_of(spec), **m}
    d = _derive(params, spec, mm)
    s = d["s"]
    tip = d["tip_offset"]
    n = int(spec["layers"])
    out = []
    for lvl in range(n):
        rows = [b for b in spec["bands"] if int(b["level"]) == lvl]
        if not rows:
            continue
        lo = hi = None
        for band in rows:
            cnt, pw, kw = band_args(band, s, mm)
            half = sleeve_dims(cnt, pw, **kw)["total_w"] / 2.0
            xc = float(band.get("x", 0.0)) * s
            lo = xc - half if lo is None else min(lo, xc - half)
            hi = xc + half if hi is None else max(hi, xc + half)
        layer = d["layers"][lvl]
        out.append(
            {
                "label": f"{layer_key(lvl, n)}_path",
                "points": path_polyline(
                    band_path(layer), 96, at=((lo + hi) / 2.0, -tip, layer["z_bot"])
                ),
            }
        )
    return out


def _wbox(x0, x1, y0, y1, z0, z1):
    """min/max 角點 → Box(切削用;比「中心+半長」少一類正負號錯)。"""
    from build123d import Box, Pos

    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _hex_prism(af: float, z0: float, z1: float):
    """六角柱(對邊距 af,**對邊面朝 ±Y** = OEM 螺帽袋方向),z 從 z0 到 z1。"""
    from build123d import Polyline, Pos, extrude, make_face

    r = af / math.sqrt(3.0)  # 外接圓半徑
    pts = [
        (r, 0.0),
        (r / 2.0, af / 2.0),
        (-r / 2.0, af / 2.0),
        (-r, 0.0),
        (-r / 2.0, -af / 2.0),
        (r / 2.0, -af / 2.0),
    ]
    return Pos(0, 0, z0) * extrude(make_face(Polyline(*pts, close=True)), amount=z1 - z0)


def rack_module(wd: float, y_hi: float, z0: float, mod_h: float, z_split: float,
                m: dict | None = None, s: float = 1.0):
    """OEM 同款固定架單模組(KCL 線架,2026-08-25 對客戶 X/Y STEP 四疊逐面普查
    重建;所有常數見 cable_spec._DEFAULT_M 的固定架細節段)。

    座標:y_hi = 近端面(連接器側),彎側端面在 y_hi - rack_depth;開口對稱於
    層平面 z_split。X 向:板寬 wd,槽寬/標籤隨 s 等比、孔位貼板緣固定距、
    孔徑/深度全型錄。特徵(近端面 → 彎側):

    - 前段導引槽:寬 slot_w*s(型錄 99.2,**與帶排寬無關**)、高 outer_h+0.9
      (上下各 0.45),深 25.4;
    - 浮凸解除槽:全寬 0.6 深槽,高 outer_h+2.0(上下各比帶面多 1.0);
    - 彎側夾持地台:全寬 6.4 深,開口**恰 = outer_h**(真夾持面,零體積面接觸);
    - 貫穿長槽:寬 pin_d、圓端在 ±(wd/2-pin_edge),整模高貫穿(取代舊版兩支
      銷孔——OEM 是長槽不是孔);
    - 緊固群 ±(wd/2-bolt_edge):中央 M5 通孔(bolt_v=12.75 到近端面,非板深
      中心),兩側 ±screw_off 各一支埋頭小螺絲(90° 錐 + d3.5 桿 + 過層平面前
      2.15 轉 d4.1 讓孔)通到對面**六角螺帽袋**(對邊 5.5、深 2.0、對邊面朝
      ±y);screw_from_top=0 埋頭在模組底面(X 款)、=1 相反(Y 款);
    - 標籤凹槽:兩外面各一,39*s × 4 × 0.35 深,彎側端面內縮 1.9;
    - 四立邊 R1 圓角(先圓角後切削,與 OEM 面普查一致)。

    回 (bottom, top) 半板,於 z_split 剖開(OEM 兩件式線架)。"""
    from build123d import Axis, Box, Cone, Cylinder, Keep, Plane, Pos, fillet, split

    mm = {**_DEFAULT_M, **(m or {})}
    depth = float(mm["rack_depth"])
    oh = float(mm["outer_h"])
    y_lo = y_hi - depth
    blk = Pos(0, y_hi - depth / 2.0, z0 + mod_h / 2.0) * Box(wd, depth, mod_h)
    blk = fillet(blk.edges().filter_by(Axis.Z), float(mm["corner_r"]))

    # --- 電纜開口三段(彎側 → 近端面) ---
    land = float(mm["clamp_land"])
    rw = float(mm["relief_w"])
    ext = float(mm["relief_ext"])
    cl = float(mm["slot_clear"])
    half_slot = float(mm["slot_w"]) * s / 2.0
    blk -= _wbox(-wd / 2 - 1, wd / 2 + 1, y_lo - 1, y_lo + land,
                 z_split - oh / 2.0, z_split + oh / 2.0)
    blk -= _wbox(-wd / 2 - 1, wd / 2 + 1, y_lo + land, y_lo + land + rw,
                 z_split - oh / 2.0 - ext, z_split + oh / 2.0 + ext)
    blk -= _wbox(-half_slot, half_slot, y_lo + land + rw, y_hi + 1,
                 z_split - oh / 2.0 - cl, z_split + oh / 2.0 + cl)

    # --- 貫穿長槽(圓端 = 舊「銷孔」位置) ---
    yc = y_hi - float(mm["bolt_v"])
    hxp = wd / 2.0 - float(mm["pin_edge"])
    pr = float(mm["pin_d"]) / 2.0
    blk -= _wbox(-hxp, hxp, yc - pr, yc + pr, z0 - 1, z0 + mod_h + 1)
    for sx in (-1.0, 1.0):
        blk -= Pos(sx * hxp, yc, z0 + mod_h / 2.0) * Cylinder(pr, mod_h + 2)

    # --- 緊固群:M5 通孔 + 2×2 埋頭小螺絲(錐→桿→讓孔→六角螺帽袋) ---
    hxb = wd / 2.0 - float(mm["bolt_edge"])
    top_screw = bool(mm.get("screw_from_top"))
    ck = float(mm["screw_csk_depth"])
    ck_r = float(mm["screw_csk_d"]) / 2.0
    sr = float(mm["screw_d"]) / 2.0
    cb = float(mm["screw_cb_below"])
    nut = float(mm["nut_depth"])
    for sx in (-1.0, 1.0):
        cx = sx * hxb
        blk -= Pos(cx, yc, z0 + mod_h / 2.0) * Cylinder(float(mm["bolt_d"]) / 2.0, mod_h + 2)
        for sy in (-1.0, 1.0):
            cy = yc + sy * float(mm["screw_off"])
            # 錐從鎖入面**精確起錐**(不面外超切):OEM 的錐曲面錨點就在面上,
            # 超切會讓 STEP 曲面參數(RefRadius/Location)與 OEM 不同——實體同形
            # 但逐面普查驗得出來(一模一樣驗收 tmp/rack_census_diff.py 抓過)。
            if top_screw:  # 埋頭在模組頂面、螺帽袋在底面(整疊鏡射)
                cone = (z0 + mod_h - ck, z0 + mod_h, sr, ck_r)
                z35 = (z_split + cb, z0 + mod_h + 1)
                z41 = (z0 - 1, z_split + cb)
                zhx = (z0 - 1, z0 + nut)
            else:
                cone = (z0, z0 + ck, ck_r, sr)
                z35 = (z0 - 1, z_split - cb)
                z41 = (z_split - cb, z0 + mod_h + 1)
                zhx = (z0 + mod_h - nut, z0 + mod_h + 1)
            ca, cb_, rb_, rt_ = cone
            blk -= Pos(cx, cy, (ca + cb_) / 2.0) * Cone(
                bottom_radius=rb_, top_radius=rt_, height=cb_ - ca
            )
            blk -= Pos(cx, cy, (z35[0] + z35[1]) / 2.0) * Cylinder(sr, z35[1] - z35[0])
            blk -= Pos(cx, cy, (z41[0] + z41[1]) / 2.0) * Cylinder(
                float(mm["screw_cb_d"]) / 2.0, z41[1] - z41[0]
            )
            blk -= Pos(cx, cy, 0) * _hex_prism(float(mm["nut_af"]), zhx[0], zhx[1])

    # --- 標籤凹槽(兩外面各一;剖開後各歸一半板) ---
    lw = float(mm["label_w"]) * s / 2.0
    la = y_lo + float(mm["label_off"])
    lb = la + float(mm["label_d"])
    ld = float(mm["label_depth"])
    blk -= _wbox(-lw, lw, la, lb, z0 - 1, z0 + ld)
    blk -= _wbox(-lw, lw, la, lb, z0 + mod_h - ld, z0 + mod_h + 1)

    plane = Plane(origin=(0, 0, z_split), z_dir=(0, 0, 1))
    return (
        split(blk, bisect_by=plane, keep=Keep.BOTTOM),
        split(blk, bisect_by=plane, keep=Keep.TOP),
    )


def intended_contact(params: dict, spec: dict, m: dict | None = None) -> list[list[str]]:
    """OEM 忠實固定座的**微量宣告干涉** allow 清單(給 assert_no_interference)。

    前段導引槽是型錄寬(99.2*s),比 105 帶排窄——彈性護套邊在實物被夾持面
    壓縮,OEM CAD 原樣重疊(X rack1 實測合計 ~294 mm^3)。只宣告**真的跨線**
    的帶 × 其宿主模組上下半板(如 X 預設:兩條 105 帶 + strip_a/strip_d,
    與 OEM 檔實測到干涉的正是同一批);由 CABLE_SPEC 現算,rewriteSpec 改
    層數/帶型後 allow 清單自動跟上。夾持地台開口恰 = outer_h 是零體積面接觸,
    不需要宣告。"""
    from cadpy.parts import sleeve_dims

    mm = _m_of(spec) if m is None else {**_m_of(spec), **m}
    s = float(params["width"]) / float(mm["ref_width"])
    half_slot = float(mm["slot_w"]) * s / 2.0
    n = int(spec["layers"])
    out: list[list[str]] = []
    for band in spec["bands"]:
        cnt, pw, kw = band_args(band, s, mm)
        half = sleeve_dims(cnt, pw, **kw)["total_w"] / 2.0
        xc = float(band.get("x", 0.0)) * s
        if max(xc + half, half - xc) <= half_slot + 1e-9:
            continue  # 整條帶落在導引槽內:相切而已,不宣告
        lvl = int(band["level"])
        for tag, mod_i in (("rack1", lvl + 1), ("rack2", n - lvl)):
            for hh in ("bottom", "top"):
                out.append([str(band["key"]), f"{tag}_m{mod_i}_{hh}"])
    return out


def build(params: dict, spec: dict, m: dict | None = None, *, label: str = "cable"):
    """整組(N 層護套 + 頭尾固定架)。參數違規 → ValueError(人話下限,見
    :func:`cadpy.parts.cable_spec.check`)。"""
    from cadpy.assembly import AssemblyHelper
    from cadpy.parts import cleanroom_sleeve

    mm = _m_of(spec) if m is None else {**_m_of(spec), **m}
    d = _check(params, spec, mm)
    s = d["s"]
    tip = d["tip_offset"]
    n = int(spec["layers"])
    asm = AssemblyHelper(label)

    # --- 護套帶(每層一條或多條並排;整條帶穿過固定架的型錄開口) ---
    for band in spec["bands"]:
        lvl = int(band["level"])
        layer = d["layers"][lvl]
        cnt, pw, kw = band_args(band, s, mm)
        asm.add(
            cleanroom_sleeve(
                cnt, pw, path=band_path(layer), at=band_at(band, layer, s, tip), **kw
            ),
            str(band["key"]),
        )

    # --- 頭尾固定架:幾層就幾組(模組數 = 層數,開口 z = 該層直段中心)---
    # rack1(下端,夾下直段末 rack_depth):z_split = 各層 z_bot,模組(底→頂)hosts level 0..N-1
    # rack2(上端,夾上直段末 rack_depth):z_split = 各層 z_bot + 2r,順序反轉;模組高序兩端相同
    levels = list(range(n))
    racks = (
        ("rack1", -tip, 0.0, {lv: d["layers"][lv]["z_bot"] for lv in levels}, tuple(levels)),
        (
            "rack2",
            0.0,
            d["rack2_base"],
            {lv: d["layers"][lv]["z_bot"] + 2.0 * d["layers"][lv]["r"] for lv in levels},
            tuple(reversed(levels)),
        ),
    )
    for tag, y_hi, base, level_z, hosted in racks:
        z0 = base
        for mod_i, lvl in enumerate(hosted):
            mod_h = d["module_hs"][mod_i]
            bottom, top = rack_module(
                float(params["width"]), y_hi, z0, mod_h, level_z[lvl], m=mm, s=s
            )
            asm.add(bottom, f"{tag}_m{mod_i + 1}_bottom")
            asm.add(top, f"{tag}_m{mod_i + 1}_top")
            z0 += mod_h
    return asm.build()
