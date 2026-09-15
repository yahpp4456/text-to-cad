"""Cable Y v4 -- 逐層定長版(customer hand-sketch input style) of the customer's
FOUR-layer cleanroom cable assembly (客戶範本/20260825/y/Cable Y v4.step,
drawing 1036.62 x 118.2 x 236).  Sister of models/cable_x_per_layer (same
closed form, same rack module construction); everything in _M was measured on
the OEM STEP (tmp/census_y.json + tmp/measured_y.json, sections through the
top legs at y=0, cylinder survey on the racks):

- 4 nested U layers, level 0 (outer, rack1 bottom module) .. level 3 (inner):
      level 0: 105-wide band, 7 bores 11.4 @ pitch 14.2 (web 2.8, edge 4.2)
      level 1: FOUR side-by-side strips 14.35 / 14.35 / 35 / 35 (mirror of
               Cable X's strip row), bores 11.6 / 11.6 / 32 / 32
      level 2: 105-wide band, 7 bores 11.4 (web 2.8, edge 4.2)
      level 3: 105-wide band, 6 bores 14.0 @ pitch 16.5 (web 2.5, edge 4.25)
  all bands 6.7 high, bore height 4.7 (wall 1.0); the 105 bands sit 0.3 off
  the rack centre in the OEM file (kept);
- each end: a 4-module rack stack, heights bottom-up 11.5 / 11.5 / 16.5 / 11.5
  -- the "加高 5" module is the THIRD one (Cable X had it at the bottom), same
  order at both ends; rack1 hosts levels 0..3 bottom-up, rack2 reversed;
  modules are the OEM 線架 via cadpy.parts.cable_assembly.rack_module (face
  census 2026-08-25: clamp land / relief groove / catalog 99.2 guide slot /
  3.4 through-slot / M5 bolts + countersunk screws + hex-nut pockets / label
  recesses / corner R1) -- Y's screw direction is MIRRORED vs X
  (screw_from_top=1: countersinks on module tops, nut pockets on bottoms, as
  measured on BOTH Y stacks); half volumes reproduce the OEM solids
  digit-for-digit (asserted in __main__);
- OEM pose reproduced by this file's inputs (asserted in __main__):
      mount_h 185.0, head_h 51.0, bottom_leg 102.75, L = OEM layer lengths
      -> bend radii 112.25 / 99.5 / 85.5 / 72.75, tip_offset 788.725,
         envelope 118.2 x 1039.475 x 236.0 (drawing 1036.62 + 2.855).

Customer sketch (2026-08-25, "Y"): L1:1305 L2:1340 L3:1370 L4:1405, 固定頭高
51 (= 11.5 x 4 + 5), 固定頭安裝高度 200, 下直段 70 -- these are the PARAMS
defaults.  Interpretation (same as Cable X, stated assumptions): L1 = innermost
layer, lengths are end-to-end incl. the 32.4 clamped at each rack, 200 is
measured to the bottom rack's base (overall height 251), 70 is the exposed
straight of the outermost (lowest) layer.

Closed form (world: X=width, Y=length, Z=height; top rack end face at y=0):
      r_lvl = (mount_h + zw[N-1-lvl] - zw[lvl]) / 2      (zw = window z's)
      straight_a(outer) = bottom_leg + 32.4
      tip_offset = L_outer - 2*straight_a(outer) - pi*r_outer
      straight_a(lvl) = (L_lvl - tip_offset - pi*r_lvl) / 2
      straight_b(lvl) = straight_a(lvl) + tip_offset
Adjacent layers must clear each other at the bend crown: _check_params samples
the centrelines and demands >= outer_h + 0.3 between neighbours (reported as
the minimum length difference (pi-2)*dr + 2*(outer_h+0.3)).

INTENDED_CONTACT is computed (cable_assembly.intended_contact): the catalog
guide slot (99.2) is narrower than the 105 band rows, so the sleeve edges
overlap the slot cheeks exactly as in the OEM CAD (elastomer squeezed in
real life); the clamp land grips each band at exactly outer_h = zero-volume
face contact (undeclared).
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
    "L1": 1305.0,        # 第 1 層(內層,6×14.0)電纜全長,端到端含兩端固定架夾持段 32.4
    "L2": 1340.0,        # 第 2 層(7×11.4)電纜全長
    "L3": 1370.0,        # 第 3 層(4 條窄條並排)電纜全長
    "L4": 1405.0,        # 第 4 層(外層,7×11.4)電纜全長
    "width": 118.2,      # 總寬 = 固定架板寬(電纜/孔位等比隨動)
    "head_h": 51.0,      # 固定頭高 = 線架 11.5 × 4 層 + 加高 5
    "mount_h": 200.0,    # 固定頭安裝高度 = 上固定頭底面高出下固定頭底面
    "bottom_leg": 70.0,  # 下直段露出長:外層彎切點 → 下固定頭近面
}

PARAM_RANGES = {
    "L1": [300, 3000, 5],
    "L2": [300, 3000, 5],
    "L3": [300, 3000, 5],
    "L4": [300, 3000, 5],
    "width": [50, 250, 2],
    "head_h": [46, 90, 0.5],
    "mount_h": [60, 600, 1],
    "bottom_leg": [10, 800, 1],
}

# ===========================================================================
# 工作台宣告(文法見 models/cable_x_per_layer/cable_x_per_layer.py:JSON 相容、
# 無 True/False/None、多行收尾 `}` 頂第 0 欄;cad-chat 以 JSON.parse 直接讀)
# ===========================================================================
TEMPLATE_META = {"family": "cable", "form": "per_layer", "label": "四層 · 逐層定長", "summary": "客戶手繪型:各層電纜長 L1–L4 + 固定頭高/安裝高度/下直段露出(加高模組在第 3 格)", "unit": "mm", "self_contained": 1}

PARAM_LABELS = {"L1": "第1層(內層)電纜長", "L2": "第2層電纜長", "L3": "第3層電纜長", "L4": "第4層(外層)電纜長", "width": "總寬(固定架板寬)", "head_h": "固定頭高", "mount_h": "固定頭安裝高度", "bottom_leg": "下直段露出長"}

PARAM_NOTES = {"L1": "端到端,含兩端固定架夾持段 32.4", "L2": "端到端,含兩端夾持段 32.4", "L3": "端到端,含兩端夾持段 32.4", "L4": "端到端,含兩端夾持段 32.4", "head_h": "= 線架 11.5 × 層數 + 加高(51 = 46 + 5)", "mount_h": "上固定頭底面 → 下固定頭底面;總高 = mount_h + head_h", "bottom_leg": "最外層彎切點 → 下固定頭近面", "width": "固定架板寬;電纜口袋/孔位等比隨動"}

# 電纜結構規格。level 0 = 外層(固定架最底模組)… N-1 = 內層;客戶編號 L1 = 最內層。
# riser_module 2 = 加高 5 的模組在堆疊第 3 格(Y 量測 11.5/11.5/16.5/11.5,與 X 不同)。
# web=0 表示不覆寫 EHSL 腰腹板閉式(JSON 沒有 None)。
CABLE_SPEC = {
  "layers": 4,
  "riser_module": 2,
  "measured": {"ref_width": 118.2, "outer_h": 6.7, "wall_t": 1.0, "module_h": 11.5, "rack_depth": 32.4, "layer_clear": 0.3, "bolt_edge": 5.1, "bolt_d": 5.0, "pin_edge": 13.5, "pin_d": 3.4, "corner_r": 1.0, "screw_from_top": 1},
  "bands": [
    {"key": "sleeve_outer", "level": 0, "n": 7, "bore": 11.4, "web": 2.8, "edge": 4.2, "x": -0.3},
    {"key": "strip_a", "level": 1, "n": 1, "bore": 11.6, "web": 0, "edge": 1.375, "x": -43.125},
    {"key": "strip_b", "level": 1, "n": 1, "bore": 11.6, "web": 0, "edge": 1.375, "x": -28.275},
    {"key": "strip_c", "level": 1, "n": 1, "bore": 32.0, "web": 0, "edge": 1.5, "x": -3.225},
    {"key": "strip_d", "level": 1, "n": 1, "bore": 32.0, "web": 0, "edge": 1.5, "x": 32.275},
    {"key": "sleeve_middle", "level": 2, "n": 7, "bore": 11.4, "web": 2.8, "edge": 4.2, "x": -0.32},
    {"key": "sleeve_inner", "level": 3, "n": 6, "bore": 14.0, "web": 2.5, "edge": 4.25, "x": -0.32}
  ]
}

N_LAYERS = CABLE_SPEC["layers"]  # = 帶表的 level 數

# 量測常數(型錄/實測):與帶表一起住在 CABLE_SPEC,cad-chat 的即時檢核與
# rewriteSpec 因此只要動這一份宣告。缺項由 cable_spec._DEFAULT_M 兜底
# (固定架模組細節常數全在那;screw_from_top=1 = Y 款埋頭在模組頂面,兩端量測皆同)。
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
    return _cable_build(p, CABLE_SPEC, label="cable_y_per_layer")


def gen_step():
    return _build(PARAMS)


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="cable_y_per_layer")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    # 1) OEM 等價:量測到的 OEM 配置(mount 185 / head 51 / 外層露出 102.75 / 各層
    #    直段 sa 由彎冠 y 反算)餵成本檔輸入 → 必須重現 OEM 彎徑/端頭錯位/包絡
    OEM_SA = [135.15, 124.047, 113.529, 102.404]   # 下直段(含夾持),level 0..3
    OEM_TIP = 788.725                               # 上直段解 y=-395.4238 → 393.3012
    OEM_R = [112.25, 99.5, 85.5, 72.75]             # = (185 + zw[3-k] - zw[k]) / 2
    oem = {"width": 118.2, "head_h": 51.0, "mount_h": 185.0, "bottom_leg": 135.15 - 32.4}
    for k in range(4):
        oem[_l_key(k)] = 2.0 * OEM_SA[k] + OEM_TIP + math.pi * OEM_R[k]
    do = _check_params(oem)
    assert do["module_hs"] == [11.5, 11.5, 16.5, 11.5], do["module_hs"]
    assert [round(z, 4) for z in do["zw"]] == [5.75, 17.25, 31.25, 45.25], do["zw"]
    assert abs(do["tip_offset"] - OEM_TIP) < 1e-6, do["tip_offset"]
    for k, ly in enumerate(do["layers"]):
        assert abs(ly["r"] - OEM_R[k]) < 1e-9, ly
        assert abs(ly["straight_a"] - OEM_SA[k]) < 1e-6, ly
    assert abs(do["l_bb"] - 1039.475) < 1e-3, do["l_bb"]     # census bbox Y
    assert abs(do["height"] - 236.0) < 1e-9
    # 2) 手繪預設閉式
    d = _check_params()
    assert [round(ly["r"], 3) for ly in d["layers"]] == [119.75, 107.0, 93.0, 80.25], d["layers"]
    assert abs(d["height"] - 251.0) < 1e-9
    assert abs(d["layers"][0]["straight_a"] - (70.0 + 32.4)) < 1e-9
    for ly in d["layers"]:
        assert abs(ly["straight_a"] + math.pi * ly["r"] + ly["straight_b"] - ly["L"]) < 1e-9
    print("tip_offset", round(d["tip_offset"], 3), "l_bb", round(d["l_bb"], 3),
          "straights", [(round(ly["straight_a"], 2), round(ly["straight_b"], 2)) for ly in d["layers"]])
    # 3) 護欄負案
    base = dict(PARAMS)
    for bad in (dict(base, head_h=40.0),            # 4 層 × 11.5 下限
                dict(base, mount_h=50.0),           # 上下固定頭相撞
                dict(base, L2=1150.0),              # 太短(直段容不下固定架)
                dict(base, L1=1335.0),              # 內層頂到第 2 層(餘隙)
                dict(base, L3=1345.0),              # 第 3 層頂到第 2 層(餘隙)
                dict(base, width=30.0)):
        try:
            _check_params(bad)
            raise AssertionError(f"guard missed {bad}")
        except ValueError:
            pass
    print("closed-form checks passed")
    # 4) 預設(手繪)全量建模 + bbox 三軸 + 幾何驗證
    shape = gen_step()
    bb = shape.bounding_box()
    tgt = (PARAMS["width"], d["l_bb"], d["height"])
    got = (bb.size.X, bb.size.Y, bb.size.Z)
    assert all(abs(a - b) < 0.05 for a, b in zip(got, tgt)), (got, tgt)
    print("children:", len(shape.children),
          "bbox:", tuple(round(v, 3) for v in got))
    check_geometry(shape)
    print("sweep paths:", len(SWEEP_PATHS),
          "x", len(SWEEP_PATHS[0]["points"]), "points")
    # 5) OEM 配置全量重建:包絡必須逐位重現客戶 STEP(118.2 × 1039.475 × 236.0)
    shape2 = _build(oem)
    bb2 = shape2.bounding_box()
    got2 = (bb2.size.X, bb2.size.Y, bb2.size.Z)
    assert all(abs(a - b) < 0.05 for a, b in zip(got2, (118.2, 1039.475, 236.0))), got2
    check_geometry(shape2)
    # 5b) 固定架半板體積逐位 = OEM 量測(screw_from_top=1 鏡射:螺帽袋半板在下
    #     8289.2893/16833.2451、埋頭半板在上 8336.7005/16916.4704)
    vols = {c.label: c.volume for c in shape2.children}
    for tag in ("rack1", "rack2"):
        for mod_i, mh in enumerate(do["module_hs"], start=1):
            vb, vt = (16833.2451, 16916.4704) if mh == 16.5 else (8289.2893, 8336.7005)
            assert abs(vols[f"{tag}_m{mod_i}_bottom"] - vb) < 0.01, (tag, mod_i)
            assert abs(vols[f"{tag}_m{mod_i}_top"] - vt) < 0.01, (tag, mod_i)
    print("rack halves match OEM volumes")
    print("OEM rebuild bbox:", tuple(round(v, 3) for v in got2))
    print("static checks passed")
