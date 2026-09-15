"""Cable X v4 -- per-part parametric rebuild of the customer cleanroom cable
assembly (客戶範本/20260825/x/Cable X v4.step; ref copy models/ref-cable-sheath/
cable_x_v4.step), driven by the THREE drawing dimensions only:
length 394.38 x width 118.2 x height 179.5.

Measured structure (tmp/measured_v4.json, sections + face census on the OEM
STEP; every constant in _M carries its source):

- 3 nested U layers, bend-radius step 12.75 (= rack module pitch), bend
  centers staggered 11.125 in Y, top legs 186.475 longer than bottom legs
  (the two connector ends are offset -- the OEM pose);
- layer 1 (innermost U): 105-wide band, 6 bores 14.0 @ pitch 16.5;
  layer 2: 105-wide band, 7 bores 11.4 @ pitch 14.2;
  layer 3 (outermost U): FOUR separate single-bore strips side by side
  (35 / 35 / 14.35 / 14.35 wide -- the drawing's "mixed" row);
  all bands 6.7 high, bore height 4.7 (wall 1.0), waist web and end margin
  measured per band (web/edge overrides on the EHSL closed form);
- each end: a 3-module rack stack (heights 16.5 "線架增厚5" at the stack
  bottom, then 11.5 + 11.5 "線架"), every module = top + bottom half split
  at its layer plane, built by cadpy.parts.cable_assembly.rack_module -- the
  OEM 線架 reproduced feature-for-feature (2026-08-25 face census: bend-side
  clamp land 6.4 deep opening exactly outer_h, 0.6 relief groove, catalog
  99.2-wide guide slot with 0.45 clearance, 3.4 through-slot with round ends
  13.5 from the plate edges, M5 through-bolts on the 12.75 line (c-c 108 at
  width 118.2 = KCL-7A B), four countersunk screws with hex-nut pockets,
  39x4 label recesses, corner fillets R1; half volumes reproduce the OEM
  solids digit-for-digit, asserted in __main__);
- closed forms (defaults reproduce the OEM bbox exactly):
  r_outer = (height - 14) / 2            # windows centered in the modules
  bbox length = length + 2.845           # drawing datum vs envelope, measured
  width scales X only (bores/webs/edges/strip gaps/plates proportional;
  thicknesses, hole diameters, module heights, layer steps stay catalog).

Declared deviations from the OEM file: each band is ONE solid (the OEM splits
bands into leg+bend / top-leg solids -- 24 vs our 18, same shape); and the
module screw direction is hex-pockets-DOWN / countersinks-UP
(screw_from_top=1) -- customer-confirmed installed orientation (2026-08-25):
the X OEM STEP models the fastener stack inverted, the Y STEP is the
as-installed reference.

INTENDED_CONTACT is computed (cable_assembly.intended_contact): the catalog
guide slot (99.2) is narrower than the 105 band rows, so the sleeve edges
overlap the slot cheeks exactly as in the OEM CAD (elastomer squeezed in
real life; OEM X rack1 measures ~294 mm^3 total); the clamp land grips each
band at exactly outer_h = zero-volume face contact (undeclared).
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.assembly import AssemblyHelper
from cadpy.parts import (
    cleanroom_sleeve,
    path_polyline,
)
from cadpy.parts.cable_assembly import (
    intended_contact as _intended_contact,
    rack_module as _rack_module,
)

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "length": 394.38,  # 圖面總長(包絡長 = length + 2.845,見 _M)
    "width": 118.2,    # 總寬 = 固定架板寬(電纜/孔位等比隨動)
    "height": 179.5,   # 總高 = 下固定架底到上固定架頂
}

# 固定滑桿範圍 [min, max, step]:範本要能大幅調參,不受「當前值×2.5」啟發式
# 上限困住(paramDefsFromGenerator 讀到 PARAM_RANGES 就用固定範圍)。長/寬/高
# 之間有幾何耦合(彎徑大要腿夠長),極端組合由 _check_params 擋並回報下限。
PARAM_RANGES = {
    "length": [340, 1500, 5],
    "width": [50, 250, 2],
    "height": [90, 320, 2],
}

# ===========================================================================
# 工作台宣告(文法見 models/cable_x_per_layer/cable_x_per_layer.py:JSON 相容、
# 無 True/False/None、多行收尾 `}` 頂第 0 欄;cad-chat 以 JSON.parse 直接讀)
# ===========================================================================
TEMPLATE_META = {"family": "cable", "form": "envelope", "label": "三層 · 圖面總長寬高", "summary": "客戶工程圖型:length/width/height 三個包絡尺寸驅動(僅 Cable X 結構精確)", "unit": "mm", "self_contained": 1}

PARAM_LABELS = {"length": "圖面總長", "width": "總寬(固定架板寬)", "height": "總高"}

PARAM_NOTES = {"length": "圖面標註長;包絡長 = length + 2.845(量測常數)", "width": "固定架板寬;電纜口袋/孔位等比隨動", "height": "下固定架底 → 上固定架頂"}

CABLE_SPEC = {
  "layers": 3,
  "riser_module": 0,
  "bands": [
    {"key": "sleeve_inner", "level": 2, "n": 6, "bore": 14.0, "web": 2.5, "edge": 4.25, "x": 0.0},
    {"key": "sleeve_middle", "level": 1, "n": 7, "bore": 11.4, "web": 2.8, "edge": 4.2, "x": 0.0},
    {"key": "strip_a", "level": 0, "n": 1, "bore": 32.0, "web": 0, "edge": 1.5, "x": -32.6},
    {"key": "strip_b", "level": 0, "n": 1, "bore": 32.0, "web": 0, "edge": 1.5, "x": 2.9},
    {"key": "strip_c", "level": 0, "n": 1, "bore": 11.6, "web": 0, "edge": 1.375, "x": 27.95},
    {"key": "strip_d", "level": 0, "n": 1, "bore": 11.6, "web": 0, "edge": 1.375, "x": 42.8}
  ]
}

# 量測常數表(tmp/measured_v4.json;逐筆註記出處)
_M = {
    "ref_width": 118.2,     # 基準寬(固定架板寬實測)
    "outer_h": 6.7,         # 帶外高(直段截面)
    "wall_t": 1.0,          # 垂直壁厚 = (6.7-4.7)/2
    "length_margin": 2.845, # 包絡長 397.225 - 圖面 394.38(錨點不明,以常數保真)
    "tip_offset": 186.475,  # 上端頭比下端頭長(78.301-(-108.174))
    "bend_stagger": 11.125, # 相鄰層彎心 y 錯位(彎心 -232.824/-221.699/-210.574)
    "layer_dr": 12.75,      # 相鄰層彎徑差(82.75/70.0/57.25)
    "module_hs": [16.5, 11.5, 11.5],  # 固定架模組高,堆疊底起(增厚5/線架/線架)
    "rack_depth": 32.4,     # 模組板深(= KCL 型錄深)
    "bolt_edge": 5.1,       # M5 通孔到板緣(118.2/2-54;c-c 108 = KCL-7A B)
    "bolt_d": 5.0,
    "pin_edge": 13.5,       # 3.4 孔到板緣(118.2/2-45.6)
    "pin_d": 3.4,
    "corner_r": 1.0,        # 模組四立邊圓角(圓柱面普查 r=1.0)
    # 螺向:六角袋朝下/埋頭朝上 = 客戶確認實裝方向(2026-08-25 指正;本檔的
    # OEM STEP 把螺絲建反——這是對來源檔的刻意宣告偏離,見 docstring)
    "screw_from_top": 1,
    # 帶(bore=內腔寬、web=腰腹板、edge=端緣;x=帶中心,基準寬座標)——單一真相在 CABLE_SPEC
    "bands": CABLE_SPEC["bands"],
}

# 微量宣告干涉:固定架導引槽是型錄寬(99.2),比 105 帶排窄——護套邊在實物被
# 夾持面壓縮,CAD 與 OEM 檔一樣原樣重疊(X rack1 實測合計 ~294 mm^3)。
INTENDED_CONTACT = _intended_contact(PARAMS, CABLE_SPEC)


def _window_centers():
    """Rack-local window (= layer) z centers, stack base at 0 -- windows are
    centered in their modules (measured: 8.25 / 22.25 / 33.75)."""
    hs = _M["module_hs"]
    zs, base = [], 0.0
    for h in hs:
        zs.append(base + h / 2.0)
        base += h
    return zs  # level 0, 1, 2


def _derived(p=None):
    p = p or PARAMS
    m = _M
    s = p["width"] / m["ref_width"]
    zw = _window_centers()                       # [8.25, 22.25, 33.75]
    r_outer = (p["height"] - zw[0] - (sum(m["module_hs"]) - zw[-1])) / 2.0
    # == (height - 8.25 - 5.75) / 2 == (height - 14) / 2
    l_bb = p["length"] + m["length_margin"]
    top_leg_outer = l_bb - r_outer - m["outer_h"] / 2.0
    layers = []
    for lvl in (0, 1, 2):
        k = lvl                                  # level 0=外層(r 最大)… 2=內層
        layers.append({
            "level": lvl,
            "r": r_outer - k * m["layer_dr"],
            "z_bot": zw[lvl],
            "top_leg": top_leg_outer - k * m["bend_stagger"],
        })
    r_inner = layers[2]["r"]
    rack2_base = layers[2]["z_bot"] + 2.0 * r_inner - zw[0]
    return {
        "s": s, "r_outer": r_outer, "r_inner": r_inner, "l_bb": l_bb,
        "layers": layers, "rack2_base": rack2_base, "zw": zw,
    }


def _check_params(p=None):
    p = p or PARAMS
    m = _M
    d = _derived(p)
    min_w = m["ref_width"] * 4.0 / min(b["bore"] for b in m["bands"])
    if p["width"] < max(45.0, round(min_w, 1)):
        raise ValueError(
            f"width({p['width']:g})須 >= {max(45.0, round(min_w, 1)):g}"
            "(最窄口袋會縮到 6mm 下限)")
    # r_inner 下限:彎徑餘隙(帶半高+0.5)與上下固定架淨距 >= 5 取嚴者
    # (rack2_base - rack1_top = 2*r_inner - (Σ模組高 - (zw2-zw0)) >= 5)
    zw = _window_centers()
    r_floor = max(m["outer_h"] / 2.0 + 0.5,
                  (sum(m["module_hs"]) - (zw[2] - zw[0]) + 5.0) / 2.0)
    h_min = 14.0 + 2.0 * (2.0 * m["layer_dr"] + r_floor)
    if d["r_inner"] < r_floor:
        raise ValueError(
            f"height({p['height']:g})過低:內層彎徑 {d['r_inner']:g} 低於下限 "
            f"{r_floor:g}(彎會自交或上下固定架相撞);height 至少 {h_min:g}")
    bottom_leg_inner = d["layers"][2]["top_leg"] - m["tip_offset"]
    need = m["rack_depth"] + 10.0
    if bottom_leg_inner < need:
        l_min = (need + m["tip_offset"] + 2.0 * m["bend_stagger"]
                 + d["r_outer"] + m["outer_h"] / 2.0 - m["length_margin"])
        raise ValueError(
            f"length({p['length']:g})過短:最短下直段 {bottom_leg_inner:g} 低於 "
            f"{need:g}(固定架 32.4 深 + 餘裕);此 height 下 length 至少 "
            f"{l_min:.2f}")
    return d


def _band_args(band, s):
    """帶的 sleeve 參數(等比縮放 X 向:bore/web/edge;厚度不縮)。"""
    kw = {
        "wall_t": _M["wall_t"],
        "outer_h": _M["outer_h"],
        "edge": band["edge"] * s,
    }
    web = band.get("web") or None  # CABLE_SPEC 用 0 表示「不覆寫 EHSL 閉式」(JSON 無 None)
    if web is not None:
        kw["web"] = web * s
    pocket_w = band["bore"] * s + 2.0 * _M["wall_t"]
    return band["n"], pocket_w, kw


def _band_path(layer):
    return {
        "kind": "drag_chain",
        "straight_a": layer["top_leg"] - _M["tip_offset"],  # 下腿(path 起點=下端頭)
        "bend_r": layer["r"],
        "straight_b": layer["top_leg"],                     # 上腿(終點=上端頭 y=0)
    }


def _band_at(band, layer, s):
    return (band["x"] * s, -_M["tip_offset"], layer["z_bot"])


# viewer path-preview overlay: sampled from the SAME specs gen_step sweeps
def _sweep_paths():
    d = _derived()
    paths = []
    for band in _M["bands"]:
        layer = d["layers"][band["level"]]
        paths.append({
            "label": f"{band['key']}_path",
            "points": path_polyline(_band_path(layer), 96,
                                    at=_band_at(band, layer, d["s"])),
        })
    return paths


SWEEP_PATHS = _sweep_paths()


def _build(p):
    d = _check_params(p)
    s = d["s"]
    asm = AssemblyHelper("cable_x_v4")

    # --- 三層護套帶(外層 4 條並排;整條帶穿過固定架的型錄開口) ---
    for band in _M["bands"]:
        layer = d["layers"][band["level"]]
        n, pw, kw = _band_args(band, s)
        asm.add(
            cleanroom_sleeve(n, pw, path=_band_path(layer),
                             at=_band_at(band, layer, s), **kw),
            band["key"],
        )

    # --- 頭尾固定架:幾層就幾組(模組數 = 層數,窗口 z = 該層直段中心) ---
    # rack1(下端,夾下直段末 32.4):窗口 z = 各層 z_bot
    # rack2(上端,夾上直段末 32.4):窗口 z = 各層 z_bot + 2r(堆疊順序反轉)
    racks = (
        ("rack1", -_M["tip_offset"], 0.0,
         {lvl: d["layers"][lvl]["z_bot"] for lvl in (0, 1, 2)},
         (0, 1, 2)),   # 模組(底→頂)hosts level 0,1,2
        ("rack2", 0.0, d["rack2_base"],
         {lvl: d["layers"][lvl]["z_bot"] + 2.0 * d["layers"][lvl]["r"]
          for lvl in (0, 1, 2)},
         (2, 1, 0)),   # 反序:增厚模組(底)夾內層
    )
    for tag, y_hi, base, level_z, hosted in racks:
        z0 = base
        for mod_i, lvl in enumerate(hosted):
            mod_h = _M["module_hs"][mod_i]
            bottom, top = _rack_module(p["width"], y_hi, z0, mod_h, level_z[lvl],
                                       m=_M, s=s)
            asm.add(bottom, f"{tag}_m{mod_i + 1}_bottom")
            asm.add(top, f"{tag}_m{mod_i + 1}_top")
            z0 += mod_h
    return asm.build()


def gen_step():
    return _build(PARAMS)


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="cable_x_v4")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    import math

    # 1) 閉式 vs 量測(預設值必須逐位重現 OEM)
    d = _derived()
    assert abs(d["r_outer"] - 82.75) < 1e-9, d["r_outer"]
    assert abs(d["layers"][1]["r"] - 70.0) < 1e-9
    assert abs(d["r_inner"] - 57.25) < 1e-9
    assert abs(d["layers"][0]["top_leg"] - 311.125) < 1e-9
    assert abs(d["layers"][1]["top_leg"] - 300.0) < 1e-9
    assert abs(d["rack2_base"] - 140.0) < 1e-9
    # 2) 兩組非預設參數:閉式恆等(bbox 目標 = 參數)不需建模即可驗
    for alt in ({"length": 340.0, "width": 100.0, "height": 150.0},
                {"length": 500.0, "width": 130.0, "height": 200.0}):
        da = _check_params(alt)
        l_bb = da["layers"][0]["top_leg"] + da["r_outer"] + _M["outer_h"] / 2.0
        assert abs(l_bb - (alt["length"] + _M["length_margin"])) < 1e-9
        hh = (da["layers"][0]["z_bot"] + 2.0 * da["r_outer"]
              + _M["module_hs"][-1] / 2.0)
        assert abs(hh - alt["height"]) < 1e-9
    # 3) 護欄負案
    for bad in ({"length": 394.38, "width": 118.2, "height": 80.0},
                {"length": 260.0, "width": 118.2, "height": 179.5},
                {"length": 394.38, "width": 30.0, "height": 179.5}):
        try:
            _check_params(bad)
            raise AssertionError(f"guard missed {bad}")
        except ValueError:
            pass
    print("closed-form checks passed")
    # 4) 預設全量建模 + bbox 三軸 + 幾何驗證
    shape = gen_step()
    bb = shape.bounding_box()
    tgt = (PARAMS["width"], PARAMS["length"] + _M["length_margin"],
           PARAMS["height"])
    got = (bb.size.X, bb.size.Y, bb.size.Z)
    assert all(abs(a - b) < 0.05 for a, b in zip(got, tgt)), (got, tgt)
    print("children:", len(shape.children),
          "bbox:", tuple(round(v, 3) for v in got))
    check_geometry(shape)
    # 4b) 固定架半板體積逐位 = OEM 量測(tmp/rack_local.py 逐面普查;客戶指正
    #     螺向後:螺帽袋半板在下 16833.2451/8289.2893、埋頭半板在上)
    vols = {c.label: c.volume for c in shape.children}
    for tag in ("rack1", "rack2"):
        for mod_i, mh in enumerate(_M["module_hs"], start=1):
            vb, vt = (16833.2451, 16916.4704) if mh == 16.5 else (8289.2893, 8336.7005)
            assert abs(vols[f"{tag}_m{mod_i}_bottom"] - vb) < 0.01, (tag, mod_i)
            assert abs(vols[f"{tag}_m{mod_i}_top"] - vt) < 0.01, (tag, mod_i)
    print("rack halves match OEM volumes")
    print("sweep paths:", len(SWEEP_PATHS),
          "x", len(SWEEP_PATHS[0]["points"]), "points")
    # 5) 一組非預設完整重建
    alt = {"length": 340.0, "width": 100.0, "height": 150.0}
    shape2 = _build(alt)
    bb2 = shape2.bounding_box()
    tgt2 = (alt["width"], alt["length"] + _M["length_margin"], alt["height"])
    got2 = (bb2.size.X, bb2.size.Y, bb2.size.Z)
    assert all(abs(a - b) < 0.05 for a, b in zip(got2, tgt2)), (got2, tgt2)
    check_geometry(shape2)
    print("alt rebuild bbox:", tuple(round(v, 3) for v in got2))
    print("static checks passed")
