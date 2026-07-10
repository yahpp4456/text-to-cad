"""轉向機構 BOX — 齒輪齒條式迴轉缸內部機構(gear family + MOTION couple dogfood)。

幾何與介面尺寸照 ref/3d_sim_examples/sim_steering_box_rackpinion_rotary_cylinder.html:
m0.7 z14 pinion(節圓 Ø9.8)、齒條行程 7.70 mm ↔ 輸出 0→90°(CCW)、
外殼 36×44×23(z56–79)、輸出軸 Ø10、雙活塞齒條沿 Y 滑移。

這是兩個原子概念的 dogfood:
1. ``cadpy.parts.gear``:pinion 齒與齒條齒由 family 生成(漸開線取樣折線齒形),
   嚙合相位用 ``rack_mesh_phase_deg`` 閉式——嚙合面零穿透,INTENDED_CONTACT
   不需要為齒輪嚙合開任何白名單(對比舊 block-tooth 模型的 8 mm³ 容差)。
2. ``MOTION couple``:齒條(linear 主動)與 pinion(revolute 從動)宣告耦合,
   驗證 harness 以同一 u 真滾動掃掠嚙合面;前端播放同相位不打滑。

座標:單位 mm;pinion 軸 = 世界 +Z 過原點(family 嚙合座標系),齒條在 -X 側
沿 Y 滑移;整組再抬到 z 56–79 的殼內(ZAX = 67.5)。靜態姿態 = θ 0°
(齒條在 +Y 端,y_r0 = R·π/4 = +3.85)。
"""

from __future__ import annotations

import math

from build123d import Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper
from cadpy.parts import gear, gear_rack, pitch_radius, rack_mesh_phase_deg

PARAMS = {
    "module": 0.7,       # 齒制模數
    "teeth": 14,         # pinion 齒數
    "gear_width": 7.0,   # pinion 齒寬
    "swing_deg": 90.0,   # 輸出擺角(0→90 CCW)
    "shaft_dia": 10.0,   # 輸出軸徑(§2-13 介面)
}

# --- 由 PARAMS 導出的機構常數(單一真相源;MOTION 與 pose 共用) -----------
_P = PARAMS
RP = pitch_radius(_P["module"], _P["teeth"])          # 節圓半徑 4.9
STROKE = RP * math.radians(_P["swing_deg"])           # 齒條行程 7.70(=R·θ)
RY0 = STROKE / 2.0                                     # 靜態齒條偏置 +3.85(行程中點對稱)
ZAX = 67.5                                             # pinion 軸高(殼 z56–79 中心)

# 齒條-活塞總成(照 sim:雙活塞 y=±11.75、活塞 r5.45 t3.5、缸膛 x=-8)
RACK_TEETH = 9
RACK_W = 6.4
RACK_BACK = 6.0                                        # 背板加厚以承活塞(family back_thick)
BORE_X = -8.0                                          # 缸膛軸線 x
PIS_R, PIS_T, PIS_C = 5.45, 3.5, 11.75                 # 活塞半徑/厚/中心 |y|(齒條局部)

# 外殼(§2-13 介面:36×44×23 @ z56–79;端蓋 y±[18,22] 整體成形)
SHELL = (36.0, 44.0, 23.0)
CAVITY_X = (-12.5, 6.5)
CAVITY_Z = (61.0, 74.0)
BORE_R = 5.5                                           # 缸膛半徑(活塞 5.45 → 餘隙 0.05)
# 軸承 61800 型代理:OD 19 → 座孔留 0.1 滑配;內圈滑配軸 0.05。
# 後軸承比 sim 深移 0.5(z73 起):活塞頂緣 z=ZAX+PIS_R=72.95,sim 的 z72.5
# 起位會被下活塞削到 0.17mm³——sim 只是視覺件,真布林檢查抓得到。
BRG_OD_R, BRG_BORE_R, BRG_W = 9.5, _P["shaft_dia"] / 2.0 + 0.05, 4.0
BRG_FRONT_Z, BRG_REAR_Z = (56.5, 60.5), (73.0, 77.0)
SHAFT_R = _P["shaft_dia"] / 2.0
SHAFT_Z = (47.0, 76.5)                                 # 前伸出接腕轂;後端留 0.5 於座孔內


def _zbox(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _cyl_z(r, z0, z1):
    return Pos(0, 0, (z0 + z1) / 2.0) * Cylinder(r, z1 - z0)


def make_housing():
    """外殼(含整體端蓋):實心箱 − 中央腔 − 缸膛 − 軸承座孔 − 軸通孔。"""
    sx, sy, sz = SHELL
    body = Pos(0, 0, ZAX) * Box(sx, sy, sz)
    body -= _zbox(CAVITY_X[0], CAVITY_X[1], -18.0, 18.0, CAVITY_Z[0], CAVITY_Z[1])
    body -= Pos(BORE_X, 0, ZAX) * Cylinder(BORE_R, 36.0, rotation=(90, 0, 0))
    # 軸承座孔:各自穿透就近端面(前從 z56 進、後從 z79 進),留 0.1 滑配
    body -= _cyl_z(BRG_OD_R + 0.1, ZAX - sz / 2.0 - 0.5, BRG_FRONT_Z[1])
    body -= _cyl_z(BRG_OD_R + 0.1, BRG_REAR_Z[0] - 0.1, ZAX + sz / 2.0 + 0.5)
    body -= Pos(0, 0, ZAX) * Cylinder(SHAFT_R + 0.6, sz + 2.0)  # 軸通孔(貫穿前後壁)
    return body


def make_pinion():
    """pinion 輸出軸:family 齒輪(嚙合相位閉式)+ 前後軸段,單一剛體。"""
    g = gear(
        _P["module"], _P["teeth"], _P["gear_width"],
        tooth_phase_deg=rack_mesh_phase_deg(_P["module"], _P["teeth"], RY0),
        label="pinion",
    ).translate((0, 0, ZAX))
    gz0, gz1 = ZAX - _P["gear_width"] / 2.0, ZAX + _P["gear_width"] / 2.0
    front = Pos(0, 0, (SHAFT_Z[0] + gz0) / 2.0) * Cylinder(SHAFT_R, gz0 - SHAFT_Z[0])
    rear = Pos(0, 0, (gz1 + SHAFT_Z[1]) / 2.0) * Cylinder(SHAFT_R, SHAFT_Z[1] - gz1)
    return g + front + rear


def make_rack():
    """齒條-活塞總成:family 齒條(加厚背板)+ 頸 + 雙活塞,單一剛體。
    建於齒條局部座標(節線 x=0、齒心 y=k·p 格點),再放到 (-RP, RY0, ZAX)。"""
    r = gear_rack(_P["module"], RACK_TEETH, RACK_W, back_thick=RACK_BACK, label="rack")
    x_back0 = -1.25 * _P["module"] - RACK_BACK          # 背板外緣(局部)
    for s in (1, -1):
        neck = _zbox(x_back0, x_back0 + RACK_BACK, s * 9.4 if s > 0 else -10.1,
                     10.1 if s > 0 else -9.4, -2.5, 2.5)
        piston = Pos(BORE_X + RP, s * PIS_C, 0) * Cylinder(PIS_R, PIS_T, rotation=(90, 0, 0))
        r = r + neck + piston
    return r.translate((-RP, RY0, ZAX))


def make_bearing(z_range):
    """深溝軸承代理:單一環(外滑配座孔、內滑配軸——全滑配,零宣告接觸)。"""
    zc, w = sum(z_range) / 2.0, z_range[1] - z_range[0]
    return Pos(0, 0, zc) * Cylinder(BRG_OD_R, w) - Pos(0, 0, zc) * Cylinder(
        BRG_BORE_R, w + 2.0
    )


def _base_parts():
    return [
        ("housing", make_housing()),
        ("rack", make_rack()),
        ("pinion", make_pinion()),
        ("bearing_front", make_bearing(BRG_FRONT_Z)),
        ("bearing_rear", make_bearing(BRG_REAR_Z)),
    ]


# 全滑配設計:嚙合有真實背隙、活塞/軸承/軸全部留餘隙——零宣告接觸是這個
# fixture 的賣點(gear family 的嚙合不需要 allow 白名單)。
INTENDED_CONTACT = []

# --- MOTION:齒條主動(linear)+ pinion 從動(revolute, couple)-----------
# travel 與 angle_deg 引用同一組 PARAMS 導出的常數:travel = -R·θ(rad),
# 掃掠與播放都以同一 u 純滾動;比率錯了 CoupledSweep 會抓(見 test_validate_motion)。
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "stroke", "label": "齒條行程", "type": "linear",
         "axis": [0, 1, 0], "travel": -STROKE,
         "moving": ["rack"],
         "pairs": [["rack", "pinion"], ["rack", "housing"]],
         "samples": 12},
        {"id": "swing", "label": "輸出擺角", "type": "revolute",
         "axis": [0, 0, 1], "pivot": [0.0, 0.0, ZAX],
         "angle_deg": _P["swing_deg"], "couple": "stroke",
         "moving": ["pinion"],
         "pairs": [["pinion", "housing"]],
         "samples": 12},
    ],
}


def pose(u):
    """0→1 的耦合姿態(齒條 -Y 平移、pinion CCW 旋轉,純滾動)。"""
    from build123d import Axis

    out = []
    for name, shape in _base_parts():
        if name == "rack":
            out.append((name, shape.translate((0, -u * STROKE, 0))))
        elif name == "pinion":
            out.append((name, shape.rotate(Axis((0, 0, 0), (0, 0, 1)), u * _P["swing_deg"])))
        else:
            out.append((name, shape))
    return out


def _poses(samples=12):
    for i in range(samples + 1):
        yield i / samples, pose(i / samples)


def check_geometry(shape):
    """靜態:全件有效 + 零未宣告干涉(嚙合本身必須乾淨)。掃掠:harness 依
    MOTION couple 真滾動;本 gate 另用 pose() 掃一次(models 測試自足)。"""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    assert_motion_clear(
        _poses(),
        [("rack", "pinion"), ("rack", "housing"), ("pinion", "housing")],
        baseline=pose(0.0),
        label="rolling swing sweep",
    )


def gen_step():
    asm = AssemblyHelper("steering_box_rack_pinion")
    for name, shape in _base_parts():
        asm.add(shape, name)
    return asm.build()


if __name__ == "__main__":
    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    print("pitch R:", RP, "stroke for", _P["swing_deg"], "deg:", round(STROKE, 4))
    check_geometry(shape)
    print("geometry + rolling-sweep checks: passed")
