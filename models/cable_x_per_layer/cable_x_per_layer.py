"""Cable X -- 逐層定長版(customer hand-sketch input style)of the Cable X v4
cleanroom cable assembly.  Same measured structure as models/cable_x_v4/
cable_x_v4.py (bands, rack module stacks, holes -- every constant in _M keeps
its provenance there); only the DRIVING dimensions differ:

    v4  : length / width / height   (the OEM drawing's three envelope dims)
    here: L1 / L2 / L3              (each layer's cable cut length, 內層→外層)
          head_h                    (固定頭高 = 線架 11.5 x 層數 + 加高)
          mount_h                   (固定頭安裝高度 = 上固定頭底面高出下固定頭底面)
          bottom_leg                (下直段露出長:外層彎切點 → 下固定頭近面)
          width                     (same as v4)

Source: 客戶範本/20260825/x + customer hand sketch "L1:805 L2:840 L3:870,
39.5, 190, 70"; customer note: 固定頭 39.5 = 疊三層 11.5*3 + 一層加高 5;
if sleeve widths / pocket counts stay, only 總長 / 固定頭高 / 固定頭安裝高度 /
層數 change.  Interpretation (stated assumptions):
  - L1 = innermost layer (smallest bend, 6x14.0 band), L3 = outermost (the
    4 side-by-side strips) -- a nested U needs L1 < L2 < L3;
  - lengths are end-to-end cut lengths INCLUDING the 32.4 clamped in each rack;
  - 190 is measured from the top rack's underside down to the bottom rack's
    base (so overall height = 190 + 39.5 = 229.5);
  - 70 is the exposed straight of the outermost (lowest, visible) layer.

Geometry (world: X=width, Y=length, Z=height; top rack end face at y=0):
- rack1 (bottom) base z=0, rack2 (top) base z=mount_h; each = N_LAYERS
  modules of 11.5 with the riser (head_h - N*11.5) added to the BOTTOM module
  (v4: 16.5/11.5/11.5), window centered in its module; rack1 hosts levels
  0..N-1 bottom-up, rack2 reversed (the v4 pose).
- a layer's bend radius is fixed by the two windows it joins:
      r_lvl = (mount_h + zw[N-1-lvl] - zw[lvl]) / 2
- every layer's path starts flush with rack1's +y face (y = -tip_offset),
  runs -y (bottom straight, incl. 32.4 clamped), turns 180 deg up, returns +y
  to y=0 (top straight, incl. 32.4 clamped):
      L = straight_a + pi*r + straight_b,   straight_b = straight_a + tip_offset
- bottom_leg fixes the OUTER layer's exposed bottom straight; with L_outer
  that gives tip_offset (the rack-to-rack offset); every other layer's two
  straights then follow from its own L -- the bend centers stagger themselves
  (v4's fixed bend_stagger / tip_offset constants are derived here).
- With mount_h=140, head_h=39.5, bottom_leg=92.25 and L = v4's layer lengths
  this reproduces v4 exactly (asserted in __main__).

Layer count = N_LAYERS = number of band levels: adding a layer = one more
band row (level N) + one more L key; the racks grow a module automatically.

Rack modules are the OEM 線架 via cadpy.parts.cable_assembly.rack_module
(2026-08-25 face census on the customer STEPs: clamp land 6.4 opening exactly
outer_h, relief groove, catalog 99.2 guide slot, 3.4 through-slot, M5 bolts +
countersunk screws + hex-nut pockets, label recesses, corner R1; half volumes
reproduce the OEM solids digit-for-digit, asserted in __main__).  Screw
direction is hex-pockets-DOWN / countersinks-UP (screw_from_top=1): customer
correction 2026-08-25 -- the X OEM STEP models the fastener stack inverted,
the Y STEP shows the as-installed orientation.
INTENDED_CONTACT is computed (cable_assembly.intended_contact): the catalog
guide slot is narrower than the 105 band rows, so the sleeve edges overlap
the slot cheeks exactly as in the OEM CAD (elastomer squeezed in real life);
the clamp land grips each band at exactly outer_h = zero-volume face contact
(undeclared).
"""

import math

from cadpy.parts.cable_assembly import (
    build as _cable_build,
    intended_contact as _cable_intended,
    sweep_paths as _cable_sweep_paths,
)
from cadpy.parts.cable_spec import (
    check as _spec_check,
    derive as _spec_derive,
    layer_key as _spec_layer_key,
)

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "L1": 805.0,         # 第 1 層(內層)電纜全長,端到端含兩端固定架夾持段 32.4
    "L2": 840.0,         # 第 2 層(中層)電纜全長
    "L3": 870.0,         # 第 3 層(外層,4 條窄條並排)電纜全長
    "width": 118.2,      # 總寬 = 固定架板寬(電纜/孔位等比隨動)
    "head_h": 39.5,      # 固定頭高 = 線架 11.5 × 層數 + 加高(39.5 = 34.5 + 5)
    "mount_h": 190.0,    # 固定頭安裝高度 = 上固定頭底面高出下固定頭底面
    "bottom_leg": 70.0,  # 下直段露出長:外層彎切點 → 下固定頭近面
}

# 固定滑桿範圍 [min, max, step](paramDefsFromGenerator 讀到就用固定範圍,
# 不受「當前值×2.5」啟發式上限困住)。參數間有幾何耦合(層長差要蓋過彎徑差、
# 直段要容納固定架板深),極端組合由 _check_params 擋並回報下限。
PARAM_RANGES = {
    "L1": [200, 2500, 5],
    "L2": [200, 2500, 5],
    "L3": [200, 2500, 5],
    "width": [50, 250, 2],
    "head_h": [34.5, 80, 0.5],
    "mount_h": [50, 500, 1],
    "bottom_leg": [10, 600, 1],
}

# ===========================================================================
# 工作台宣告(cad-chat 的「無塵電纜工作台」直接讀這幾份)
# ---------------------------------------------------------------------------
# 文法:**JSON 相容**的 dict 字面量——雙引號、無尾逗號、**不得出現 Python 的
# True/False/None**(布林用 1/0,「不覆寫」用 0);多行時收尾的 `}` 頂到第 0 欄。
# cad-chat 以 JSON.parse 直接讀(pipeline.readFlatJsonDecl),Python 這邊照樣是
# 普通 dict —— 層數與帶表因此只有 CABLE_SPEC 這一份真相,不會兩邊漂。
# ===========================================================================
TEMPLATE_META = {"family": "cable", "form": "per_layer", "label": "三層 · 逐層定長", "summary": "客戶手繪型:各層電纜長 L1–L3 + 固定頭高/安裝高度/下直段露出", "unit": "mm", "self_contained": 1}

PARAM_LABELS = {"L1": "第1層(內層)電纜長", "L2": "第2層電纜長", "L3": "第3層(外層)電纜長", "width": "總寬(固定架板寬)", "head_h": "固定頭高", "mount_h": "固定頭安裝高度", "bottom_leg": "下直段露出長"}

PARAM_NOTES = {"L1": "端到端,含兩端固定架夾持段 32.4", "L2": "端到端,含兩端夾持段 32.4", "L3": "端到端,含兩端夾持段 32.4", "head_h": "= 線架 11.5 × 層數 + 加高(39.5 = 34.5 + 5)", "mount_h": "上固定頭底面 → 下固定頭底面;總高 = mount_h + head_h", "bottom_leg": "最外層彎切點 → 下固定頭近面", "width": "固定架板寬;電纜口袋/孔位等比隨動"}

# 電纜結構規格(層數/加高模組位置/帶表)。level 0 = 外層(固定架最底模組)… N-1 = 內層;
# 客戶編號 L1 = 最內層 = level N-1。web=0 表示不覆寫 EHSL 腰腹板閉式(JSON 沒有 None)。
CABLE_SPEC = {
  "layers": 3,
  "riser_module": 0,
  "measured": {"ref_width": 118.2, "outer_h": 6.7, "wall_t": 1.0, "module_h": 11.5, "rack_depth": 32.4, "layer_clear": 0.3, "bolt_edge": 5.1, "bolt_d": 5.0, "pin_edge": 13.5, "pin_d": 3.4, "corner_r": 1.0, "screw_from_top": 1},
  "bands": [
    {"key": "sleeve_inner", "level": 2, "n": 6, "bore": 14.0, "web": 2.5, "edge": 4.25, "x": 0.0},
    {"key": "sleeve_middle", "level": 1, "n": 7, "bore": 11.4, "web": 2.8, "edge": 4.2, "x": 0.0},
    {"key": "strip_a", "level": 0, "n": 1, "bore": 32.0, "web": 0, "edge": 1.5, "x": -32.6},
    {"key": "strip_b", "level": 0, "n": 1, "bore": 32.0, "web": 0, "edge": 1.5, "x": 2.9},
    {"key": "strip_c", "level": 0, "n": 1, "bore": 11.6, "web": 0, "edge": 1.375, "x": 27.95},
    {"key": "strip_d", "level": 0, "n": 1, "bore": 11.6, "web": 0, "edge": 1.375, "x": 42.8}
  ]
}

N_LAYERS = CABLE_SPEC["layers"]  # = 帶表的 level 數

# 量測常數(型錄/實測):與帶表一起住在 CABLE_SPEC,cad-chat 的即時檢核與
# rewriteSpec 因此只要動這一份宣告。缺項由 cable_spec._DEFAULT_M 兜底
# (固定架模組細節常數全在那;screw_from_top=1 = 實裝方向:六角袋朝下、埋頭朝上
# ——2026-08-25 客戶指正。X 的 OEM STEP 檔把螺絲建反,不照抄)。
_M = CABLE_SPEC["measured"]

# 微量宣告干涉:固定架導引槽是型錄寬(99.2),比 105 帶排窄——護套邊在實物被
# 夾持面壓縮,CAD 與 OEM 檔一樣原樣重疊。由 PARAMS/CABLE_SPEC 現算:改層數/
# 帶型(rewriteSpec)後 allow 清單自動跟上,不會漏宣告新層。
INTENDED_CONTACT = _cable_intended(PARAMS, CABLE_SPEC)


def _l_key(lvl):
    """level(0=外層)→ 客戶編號 L1(內層)…LN(外層)。"""
    return _spec_layer_key(lvl, N_LAYERS)


# 閉式派生與護欄的**單一真相**在 cadpy.parts.cable_spec(OCP-free,import 0.08s):
# 兩份 per-layer 範本、Phase 4 的通用產生器、以及 cad-chat 的表單即時檢核
# (/api/cable/check)全部呼叫同一份——訊息文字與下限反算不會兩邊漂。
def _derived(p=None):
    return _spec_derive(p or PARAMS, CABLE_SPEC, _M)


def _check_params(p=None):
    return _spec_check(p or PARAMS, CABLE_SPEC, _M)


# 掃出路徑 overlay:**每層一條**(同層並排窄條共用中心線),避免 N 大時撞到
# generation 的 SWEEP_PATHS 收割上限(8 條)而靜默截斷。
SWEEP_PATHS = _cable_sweep_paths(PARAMS, CABLE_SPEC)


def _build(p):
    """整組幾何——實作在 cadpy.parts.cable_assembly(規格驅動,三份範本共用)。"""
    return _cable_build(p, CABLE_SPEC, label="cable_x_per_layer")


def gen_step():
    return _build(PARAMS)


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="cable_x_per_layer")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    # 1) v4 等價:v4 閉式(層 k:sa=124.65-11.125k, sb=311.125-11.125k, r=82.75-12.75k)
    #    餵成本檔的輸入 → 必須逐位重現 v4 的彎徑/直段/端頭錯位/包絡
    v4 = {"width": 118.2, "head_h": 39.5, "mount_h": 140.0, "bottom_leg": 124.65 - 32.4}
    for k in range(3):
        sa, sb, r = 124.65 - 11.125 * k, 311.125 - 11.125 * k, 82.75 - 12.75 * k
        v4[_l_key(k)] = sa + sb + math.pi * r
    dv = _check_params(v4)
    assert abs(dv["tip_offset"] - 186.475) < 1e-9, dv["tip_offset"]
    for k, ly in enumerate(dv["layers"]):
        assert abs(ly["r"] - (82.75 - 12.75 * k)) < 1e-9, ly
        assert abs(ly["straight_b"] - (311.125 - 11.125 * k)) < 1e-9, ly
        assert abs(ly["straight_a"] - (124.65 - 11.125 * k)) < 1e-9, ly
    assert abs(dv["l_bb"] - 397.225) < 1e-9, dv["l_bb"]
    assert abs(dv["height"] - 179.5) < 1e-9
    assert abs(dv["rack2_base"] - 140.0) < 1e-9
    # 2) 手繪預設閉式
    d = _check_params()
    assert [round(ly["r"], 3) for ly in d["layers"]] == [107.75, 95.0, 82.25], d["layers"]
    assert abs(d["height"] - 229.5) < 1e-9
    assert abs(d["layers"][0]["straight_a"] - (70.0 + 32.4)) < 1e-9
    for ly in d["layers"]:
        assert abs(ly["straight_a"] + math.pi * ly["r"] + ly["straight_b"] - ly["L"]) < 1e-9
    assert d["module_hs"] == [16.5, 11.5, 11.5], d["module_hs"]
    print("tip_offset", round(d["tip_offset"], 3), "l_bb", round(d["l_bb"], 3),
          "straights", [(round(ly["straight_a"], 2), round(ly["straight_b"], 2)) for ly in d["layers"]])
    # 3) 護欄負案
    base = dict(PARAMS)
    for bad in (dict(base, head_h=30.0),            # 3 層 × 11.5 下限
                dict(base, mount_h=40.0),           # 上下固定頭相撞
                dict(base, L2=700.0),               # 中層太短(直段容不下固定架)
                dict(base, L1=865.0),               # 內層頂到中層(餘隙)
                dict(base, L3=845.0),               # 外層太短(中層頂到外層)
                dict(base, width=30.0)):
        try:
            _check_params(bad)
            raise AssertionError(f"guard missed {bad}")
        except ValueError:
            pass
    print("closed-form checks passed")
    # 4) 預設全量建模 + bbox 三軸 + 幾何驗證
    shape = gen_step()
    bb = shape.bounding_box()
    tgt = (PARAMS["width"], d["l_bb"], d["height"])
    got = (bb.size.X, bb.size.Y, bb.size.Z)
    assert all(abs(a - b) < 0.05 for a, b in zip(got, tgt)), (got, tgt)
    print("children:", len(shape.children),
          "bbox:", tuple(round(v, 3) for v in got))
    check_geometry(shape)
    # 4b) 固定架半板體積逐位 = OEM 量測(rack_local.py 普查;screw_from_top=1
    #     客戶指正實裝方向:螺帽袋半板在下 16833.2451/8289.2893、埋頭半板在上)
    vols = {c.label: c.volume for c in shape.children}
    for tag in ("rack1", "rack2"):
        for mod_i, mh in enumerate(d["module_hs"], start=1):
            vb, vt = (16833.2451, 16916.4704) if mh == 16.5 else (8289.2893, 8336.7005)
            assert abs(vols[f"{tag}_m{mod_i}_bottom"] - vb) < 0.01, (tag, mod_i)
            assert abs(vols[f"{tag}_m{mod_i}_top"] - vt) < 0.01, (tag, mod_i)
    print("rack halves match OEM volumes")
    print("sweep paths:", len(SWEEP_PATHS),
          "x", len(SWEEP_PATHS[0]["points"]), "points")
    # 5) 一組非預設完整重建(長件、寬固定頭安裝高度、窄板)
    alt = {"L1": 1000.0, "L2": 1035.0, "L3": 1070.0, "width": 100.0,
           "head_h": 39.5, "mount_h": 250.0, "bottom_leg": 100.0}
    da = _check_params(alt)
    shape2 = _build(alt)
    bb2 = shape2.bounding_box()
    tgt2 = (alt["width"], da["l_bb"], da["height"])
    got2 = (bb2.size.X, bb2.size.Y, bb2.size.Z)
    assert all(abs(a - b) < 0.05 for a, b in zip(got2, tgt2)), (got2, tgt2)
    check_geometry(shape2)
    print("alt rebuild bbox:", tuple(round(v, 3) for v in got2))
    print("static checks passed")
