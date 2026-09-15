"""Cleanroom-cable "per-layer length" closed form -- **OCP-free** (stdlib only).

This is the single source of truth for the逐層定長 form used by the cable
generators (``models/cable_*_per_layer``) and by cad-chat's live spec check:

* the generators import :func:`derive` / :func:`check` so their ``_derived`` /
  ``_check_params`` are one implementation, not three copies;
* cad-chat spawns :mod:`cadpy.parts.cable_spec` through a tiny CLI
  (``apps/cad-chat/src/server/cad/cable_check.py``) to validate the spec form
  while the user types -- importing a generator would drag in build123d
  (~16 s cold), importing this module costs ~0.2 s.

Inputs
------
``params``  driving dimensions: ``L1..LN`` (client numbering, L1 = innermost),
            ``width``, ``head_h``, ``mount_h``, ``bottom_leg``.
``spec``    structure: ``{"layers": N, "riser_module": i, "bands": [...]}``
            (the generator's ``CABLE_SPEC``; ``bands`` entries need ``bore``).
``m``       measured constants: ``ref_width, outer_h, wall_t, module_h,
            rack_depth, layer_clear`` (the generator's ``_M``).

Geometry (world: X=width, Y=length, Z=height; top rack end face at y=0)::

    zw[lvl]        = window z of layer lvl in the rack stack (module centres)
    r[lvl]         = (mount_h + zw[N-1-lvl] - zw[lvl]) / 2
    straight_a(0)  = bottom_leg + rack_depth              (outer layer)
    tip_offset     = L_outer - 2*straight_a(0) - pi*r[0]
    straight_a(l)  = (L_l - tip_offset - pi*r[l]) / 2
    straight_b(l)  = straight_a(l) + tip_offset
    height         = mount_h + head_h

Level 0 is the OUTER layer (bottom rack module); client numbering is inverted
(``L1`` = innermost = level N-1), see :func:`layer_key`.
"""

from __future__ import annotations

import math

__all__ = [
    "layer_key",
    "module_heights",
    "window_centers",
    "derive",
    "issues",
    "check",
    "u_gap",
]

# 兩個客戶件共用的量測/型錄常數。**規格自帶優先**:CABLE_SPEC["measured"] 覆寫這裡,
# 呼叫端再傳 m 又覆寫一層——所以 cad-chat 的即時檢核只要有 CABLE_SPEC 就能算,
# 不必去讀產生器的 Python `_M`(那是 dict 字面量 + 註解,JSON 讀不到)。
_DEFAULT_M = {
    "ref_width": 118.2,   # 基準寬(固定架板寬)
    "outer_h": 6.7,       # 帶外高
    "wall_t": 1.0,
    "module_h": 11.5,     # 線架單模組高
    "rack_depth": 32.4,   # 模組板深 = 每端夾持段長
    "layer_clear": 0.3,   # 相鄰層中心線最短距離須 >= outer_h + layer_clear
    # 固定架孔位/圓角(KCL-7A 量測;cable_assembly 建模用,閉式不吃)
    "bolt_edge": 5.1,     # M5 通孔到板緣(118.2/2-54;c-c 108)
    "bolt_d": 5.0,
    "pin_edge": 13.5,     # 3.4 貫穿長槽圓端到板緣(118.2/2-45.6)
    "pin_d": 3.4,         # 長槽寬 = 圓端徑
    "corner_r": 1.0,      # 模組四立邊圓角
    # ── OEM 線架模組細節(2026-08-25 tmp/rack_local.py 逐面普查 X/Y 四疊;
    #    cable_assembly.rack_module 建模用,閉式不吃。深度向 v 從近端面(連接器
    #    側)量,z 對稱於層平面;X 向長度隨 s 等比、其餘全型錄固定)──
    "slot_w": 99.2,       # 前段導引槽寬(型錄常數:X/Y 各層帶排寬不同、槽寬全同;
                          #   帶排 105 比槽寬,每側 2.9 壓進頰板 = 微量宣告干涉)
    "slot_clear": 0.45,   # 前段導引槽上下各放 0.45(開口 = outer_h + 0.9)
    "clamp_land": 6.4,    # 彎側夾持地台深(全寬開口恰 = outer_h,真夾持面)
    "relief_w": 0.6,      # 夾持地台與導引槽間的浮凸解除槽寬
    "relief_ext": 1.0,    # 解除槽上下各比帶面多挖 1.0(開口 = outer_h + 2.0)
    "bolt_v": 12.75,      # 螺栓/長槽中心線到近端面(非板深中心 16.2!)
    "screw_off": 6.75,    # 兩支小螺絲對螺栓線的 ±y 偏距(-6.0 與 -19.5)
    "screw_d": 3.5,       # 小螺絲桿孔徑
    "screw_cb_d": 4.1,    # 小螺絲讓孔徑(桿孔過層平面前 2.15 轉讓孔)
    "screw_cb_below": 2.15,
    "screw_csk_d": 7.3,   # 埋頭錐面徑(90° 錐,鎖入面)
    "screw_csk_depth": 1.9,
    "nut_af": 5.5,        # 六角螺帽袋對邊距(對邊面朝 ±y)
    "nut_depth": 2.0,     # 螺帽袋深(在螺帽面)
    "label_w": 39.0,      # 標籤凹槽(每半板外面各一,置中;X 向隨 s 等比)
    "label_d": 4.0,       # 凹槽 y 向長(彎側端面內縮 label_off 起)
    "label_off": 1.9,
    "label_depth": 0.35,
    "screw_from_top": 1,  # 1 = 六角螺帽袋在模組底面/埋頭在頂面 = 客戶確認的實裝方向
                          #   (X/Y 皆同;X 的 OEM STEP 把螺絲建反,照檔量測會踩雷——
                          #    2026-08-25 客戶指正「六角形是底,圓的在上面」)
}


def _m_of(spec: dict, m: dict | None = None) -> dict:
    return {**_DEFAULT_M, **(spec.get("measured") or {}), **(m or {})}


_MIN_POCKET_W = 4.0  # 最窄口袋(bore)縮到這個比例下限就擋(見 issues:width)
_MIN_BOTTOM_LEG = 10.0
_RACK_CLEAR = 5.0  # 上固定頭底面到下固定頭頂面的最小淨距
_STRAIGHT_MARGIN = 10.0  # 直段要容納固定架板深 + 這個餘裕


def layer_key(lvl: int, n: int) -> str:
    """level(0=外層)→ 客戶編號 L1(內層)…LN(外層)。"""
    return f"L{n - lvl}"


def module_heights(params: dict, spec: dict, m: dict | None = None) -> list[float]:
    """固定架模組高,堆疊底起:加高全給 ``riser_module`` 那一格。"""
    n = int(spec["layers"])
    mh = float(_m_of(spec, m)["module_h"])
    riser = float(params["head_h"]) - n * mh
    hs = [mh] * n
    hs[int(spec.get("riser_module", 0))] += riser
    return hs


def window_centers(params: dict, spec: dict, m: dict | None = None) -> list[float]:
    """各層窗口(=該層直段)在固定架堆疊中的 z 中心,底為 0。"""
    zs: list[float] = []
    base = 0.0
    for h in module_heights(params, spec, m):
        zs.append(base + h / 2.0)
        base += h
    return zs


def derive(params: dict, spec: dict, m: dict | None = None) -> dict:
    """閉式派生(不檢查;違規值照算,由 :func:`issues` 判讀)。"""
    m = _m_of(spec, m)
    n = int(spec["layers"])
    s = float(params["width"]) / float(m["ref_width"])
    zw = window_centers(params, spec, m)
    layers = []
    for lvl in range(n):
        layers.append(
            {
                "level": lvl,
                "key": layer_key(lvl, n),
                "L": float(params[layer_key(lvl, n)]),
                # 彎徑由該層在兩固定架的窗口高差決定(rack2 模組順序反轉)
                "r": (float(params["mount_h"]) + zw[n - 1 - lvl] - zw[lvl]) / 2.0,
                "z_bot": zw[lvl],
            }
        )
    # 外層下直段 = 露出長 + 夾持段;外層全長反算兩固定架端頭錯位 tip_offset
    sa_outer = float(params["bottom_leg"]) + float(m["rack_depth"])
    tip = layers[0]["L"] - 2.0 * sa_outer - math.pi * layers[0]["r"]
    for ly in layers:
        sa = (ly["L"] - tip - math.pi * ly["r"]) / 2.0
        ly["straight_a"] = sa  # 下直段(含夾持),path 起點=下端頭
        ly["straight_b"] = sa + tip  # 上直段(含夾持),終點=上端頭 y=0
    l_bb = max(
        tip + ly["straight_a"] + ly["r"] + float(m["outer_h"]) / 2.0 for ly in layers
    )
    return {
        "s": s,
        "zw": zw,
        "module_hs": module_heights(params, spec, m),
        "layers": layers,
        "tip_offset": tip,
        "l_bb": l_bb,
        "rack2_base": float(params["mount_h"]),
        "height": float(params["mount_h"]) + float(params["head_h"]),
    }


# ── 相鄰層巢套餘隙:中心線在側視 (y,z) 平面的最短距離 ──────────────────
# 折線對折線會把彎冠間距低估 ~(Δs)²/8r(客戶層差剛好卡在幾何下限時就誤判)→
# 一側取樣、另一側用解析式(腿=線段公式、弧=圓公式),誤差 ~1e-4。
def _p2s(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0.0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _u_pieces(ly: dict, tip: float) -> dict:
    """一層中心線的解析描述:兩條腿線段 + 朝 -y 的半圓弧。"""
    yc = -tip - ly["straight_a"]
    zb, r = ly["z_bot"], ly["r"]
    return {
        "yc": yc,
        "zc": zb + r,
        "r": r,
        "legs": [((yc, zb), (-tip, zb)), ((yc, zb + 2.0 * r), (0.0, zb + 2.0 * r))],
    }


def _dist_to_u(p, u: dict) -> float:
    best = min(_p2s(p, a, b) for a, b in u["legs"])
    vy, vz = p[0] - u["yc"], p[1] - u["zc"]
    if abs(math.atan2(vz, -vy)) <= math.pi / 2.0:  # 0 = 彎冠,±90° = 兩腿切點
        best = min(best, abs(math.hypot(vy, vz) - u["r"]))
    return best


def _u_samples(u: dict, n_arc: int = 720, n_leg: int = 40) -> list:
    pts = [
        (u["yc"] - u["r"] * math.cos(phi), u["zc"] + u["r"] * math.sin(phi))
        for phi in (-math.pi / 2.0 + math.pi * k / n_arc for k in range(n_arc + 1))
    ]
    for a, b in u["legs"]:
        pts += [
            (a[0] + (b[0] - a[0]) * k / n_leg, a[1] + (b[1] - a[1]) * k / n_leg)
            for k in range(n_leg + 1)
        ]
    return pts


def u_gap(layer_a: dict, layer_b: dict, tip: float) -> float:
    """兩層中心線的最短距離(雙向:一側取樣、另一側解析)。"""
    u1, u2 = _u_pieces(layer_a, tip), _u_pieces(layer_b, tip)
    return min(
        min(_dist_to_u(p, u2) for p in _u_samples(u1)),
        min(_dist_to_u(p, u1) for p in _u_samples(u2)),
    )


def _round_up(x: float, q: float = 0.1) -> float:
    """往上取到 q 的倍數。回報的下限**必須真的可用**——直接四捨五入會落在邊界的
    錯邊(浮點下 42.3999 < 42.4),使用者按「套用下限」還是被擋。"""
    return round(math.ceil(x / q - 1e-9) * q, 6)  # round:0.1 的倍數在二進位下不精確


def _round_dn(x: float, q: float = 0.1) -> float:
    return round(math.floor(x / q + 1e-9) * q, 6)


def _max_inner_length(inner: dict, outer: dict, params: dict, spec: dict, m: dict,
                      gap_min: float, hint: float) -> float:
    """內層在餘隙下的最大可用長度。first-order 估計(hint)只是起點——實際餘隙對
    長度非線性,所以以它為上界做二分,回一個**餵回去一定過**的值。"""
    key = inner["key"]
    lo = min(float(hint), float(inner["L"]))
    hi = float(inner["L"])

    def gap_at(val: float) -> float:
        d = derive(dict(params, **{key: val}), spec, m)
        a = d["layers"][outer["level"]]
        b = d["layers"][inner["level"]]
        return u_gap(a, b, d["tip_offset"])

    # 先確保 lo 這端是「過的」;不過就再往下退(最多退到差 0 為止)
    guard = 0
    while gap_at(lo) < gap_min and guard < 20:
        hi = lo
        lo -= max(1.0, (float(inner["L"]) - lo) * 0.5)
        guard += 1
    for _ in range(24):
        mid = (lo + hi) / 2.0
        if gap_at(mid) >= gap_min:
            lo = mid
        else:
            hi = mid
    return _round_dn(lo)


def issues(params: dict, spec: dict, m: dict | None = None) -> list[dict]:
    """所有違規(不只第一個)。每筆 ``{key, message, min?, max?}``——
    ``key`` 對應 PARAMS 鍵讓表單標紅,``min``/``max`` 是可直接套用的下/上限。
    訊息文字與舊 ``_check_params`` **逐字相同**(UI/煙測都吃這些字)。"""
    m = _m_of(spec, m)
    out: list[dict] = []
    n = int(spec["layers"])
    bands = spec.get("bands") or []
    mh = float(m["module_h"])
    ref_w = float(m["ref_width"])
    outer_h = float(m["outer_h"])
    rack_depth = float(m["rack_depth"])
    layer_clear = float(m.get("layer_clear", 0.3))

    if bands:
        min_w = ref_w * _MIN_POCKET_W / min(float(b["bore"]) for b in bands)
        w_floor = max(45.0, _round_up(min_w))
        if float(params["width"]) < w_floor:
            out.append({
                "key": "width",
                "min": w_floor,
                "message": f"width({params['width']:g})須 >= {w_floor:g}(最窄口袋會縮到 6mm 下限)",
            })
    h_min = n * mh
    if float(params["head_h"]) < h_min - 1e-9:
        out.append({
            "key": "head_h",
            "min": h_min,
            "message": (
                f"head_h({params['head_h']:g})過低:{n} 層 × 線架 {mh:g} = {h_min:g} 是下限"
                "(超出部分才是加高)"
            ),
        })
    mount_floor = float(params["head_h"]) + _RACK_CLEAR
    if float(params["mount_h"]) < mount_floor:
        out.append({
            "key": "mount_h",
            "min": mount_floor,
            "message": (
                f"mount_h({params['mount_h']:g})過低:上固定頭底面須高於下固定頭頂面 >= {_RACK_CLEAR:g}"
                f"(mount_h 至少 head_h + {_RACK_CLEAR:g} = {mount_floor:g})"
            ),
        })
    if float(params["bottom_leg"]) < _MIN_BOTTOM_LEG:
        out.append({
            "key": "bottom_leg",
            "min": _MIN_BOTTOM_LEG,
            "message": (
                f"bottom_leg({params['bottom_leg']:g})過短:彎切點到固定頭至少留 {_MIN_BOTTOM_LEG:g}"
            ),
        })
    if out:
        return out  # 上面幾條會讓派生值失去意義(負彎徑等),先擋

    d = derive(params, spec, m)
    r_floor = outer_h / 2.0 + 0.5
    for ly in d["layers"]:
        if ly["r"] < r_floor:
            out.append({
                "key": "mount_h",
                "message": (
                    f"mount_h({params['mount_h']:g})過低:{ly['key']} 彎徑 {ly['r']:g} 低於下限 {r_floor:g}"
                ),
            })
    need = rack_depth + _STRAIGHT_MARGIN
    tip = d["tip_offset"]
    for ly in d["layers"]:
        pi_r = math.pi * ly["r"]
        if ly["straight_a"] < need:
            l_min = tip + pi_r + 2.0 * need
            out.append({
                "key": ly["key"],
                "min": _round_up(l_min),
                "message": (
                    f"{ly['key']}({ly['L']:g})過短:下直段 {ly['straight_a']:.1f} 低於 {need:g}"
                    f"(固定架 {rack_depth:g} 深 + 餘裕);此配置下 {ly['key']} 至少 {l_min:.1f}"
                ),
            })
        if ly["straight_b"] < need:
            l_min = 2.0 * need - tip + pi_r
            out.append({
                "key": ly["key"],
                "min": _round_up(l_min),
                "message": (
                    f"{ly['key']}({ly['L']:g})過短:上直段 {ly['straight_b']:.1f} 低於 {need:g}"
                    f"(固定架 {rack_depth:g} 深 + 餘裕);此配置下 {ly['key']} 至少 {l_min:.1f}"
                ),
            })
    gap_min = outer_h + layer_clear
    for lvl in range(n - 1):
        outer, inner = d["layers"][lvl], d["layers"][lvl + 1]
        gap = u_gap(outer, inner, tip)
        if gap < gap_min:
            d_r = outer["r"] - inner["r"]
            need_dl = 2.0 * gap_min + (math.pi - 2.0) * d_r
            out.append({
                "key": inner["key"],
                "max": _max_inner_length(
                    inner, outer, params, spec, m, gap_min, outer["L"] - need_dl
                ),
                "message": (
                    f"{inner['key']}({inner['L']:g})與 {outer['key']}({outer['L']:g})巢套餘隙不足:"
                    f"中心線最近 {gap:.1f} < {gap_min:g}(帶厚 {outer_h:g} + 餘隙);"
                    f"相鄰層長度差至少 {need_dl:.1f}(縮短 {inner['key']} 或加長 {outer['key']})"
                ),
            })
    return out


def check(params: dict, spec: dict, m: dict | None = None) -> dict:
    """違規就 raise ValueError(第一筆訊息;產生器的 ``_check_params`` 語意),
    否則回 :func:`derive` 的結果。"""
    bad = issues(params, spec, m)
    if bad:
        raise ValueError(bad[0]["message"])
    return derive(params, spec, m)
