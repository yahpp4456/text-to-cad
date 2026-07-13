"""Single-axis motorized ball-screw linear stage, 100 mm travel.

底板 + 雙線性導軌/滑塊 + 滾珠螺桿/螺帽 + 雙支撐軸承(座) + 步進馬達/聯軸器 + 載台。
標準件(螺桿/導軌/軸承/馬達)由固定工作條件反算選型(cadpy.parts.select_*),非目測:
  duty = payload 100 N, target speed 200 mm/s, travel 100 mm。
LOCAL = WORLD frame:行程沿 +X,導軌在底板平面,+Z 向上,底板底面 z = 0。
單一 linear DOF 'stroke':載台(carriage)+滑塊+螺帽沿 +X 平移 travel。
座標/運動唯一真相源 = pose(u);靜態 STEP、check_geometry、MOTION 掃掠共用。
"""
from __future__ import annotations

import math

from build123d import Axis, Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper
from cadpy.parts import (
    ball_screw,
    deep_groove_bearing,
    linear_guide,
    select_ball_screw,
    select_bearing,
    load_specs,
    select_linear_guide,
    stepper_motor,
)

# ---------------------------------------------------------------------------
# 可調參數(單層;滑桿重生整塊改寫本 dict)
# ---------------------------------------------------------------------------
PARAMS = {
    "travel": 100.0,        # 行程 (mm)
    "carriage_len": 60.0,   # 載台沿行程方向長度 (mm)
    "base_t": 12.0,         # 底板厚 (mm)
    "rail_span": 36.0,      # 兩線軌中心距 (mm)
    "corner_hole_d": 4.5,   # 四角安裝孔徑 (mm；M4 餘隙孔 ø4.5)
    "corner_inset": 8.0,    # 安裝孔距板邊內縮 (mm)
    "motor_bolt_d": 3.4,    # 馬達鎖付貫穿孔徑 (mm；NEMA17 M3 餘隙孔 ø3.4)
}

# ---------------------------------------------------------------------------
# 固定工作條件 -> 標準件選型(反算,非目測;travel 非選型準則,故用名目值)
# ---------------------------------------------------------------------------
PAYLOAD_N = 100.0
TARGET_SPEED = 200.0     # mm/s
SCREW_EFF = 0.9          # 滾珠螺桿傳動效率(轉矩首算估值)
RATED_RPM = 3000.0
NOM_TRAVEL = 100.0       # 選型名目行程(僅供 provenance;實長由 PARAMS['travel'] 縮放)

_SCREW = select_ball_screw(
    PAYLOAD_N, travel=NOM_TRAVEL, target_speed_mm_s=TARGET_SPEED,
    accuracy="C7", rated_rpm=RATED_RPM,
)
_GUIDE = select_linear_guide(PAYLOAD_N, rail_len=NOM_TRAVEL + 60.0)
_BEARING = select_bearing(shaft_dia=_SCREW["root_dia"], radial_load_N=PAYLOAD_N / 2.0)
_TORQUE = PAYLOAD_N * (_SCREW["lead"] / 1000.0) / (2.0 * math.pi * SCREW_EFF)
# 使用者指定 42 框（NEMA17）馬達；取該框最短堆疊，扭矩（~0.088 Nm）裕度充裕。
MOTOR_NEMA = 17
_m = min(
    (r for r in load_specs("motors")
     if r["nema"] == MOTOR_NEMA and r["holding_torque_Nm"] >= _TORQUE),
    key=lambda r: r["body_len"],
)
_MOTOR = {**_m, "selected_for": {"torque_Nm": _TORQUE,
                                 "margin": _m["holding_torque_Nm"] / _TORQUE}}


# ---------------------------------------------------------------------------
# 參數防呆(跨參數約束;違反擋在幾何核心之前,滑桿誤觸即看到人話)
# 放模組層、只在 gen_step 內呼叫——motion-only 驗證 import 本檔時不觸發。
# ---------------------------------------------------------------------------
def _check_params():
    p = PARAMS
    bl = _GUIDE["block_len"]
    bw = _GUIDE["block_width"]
    if not (0 < p["motor_bolt_d"] < MOTOR_BOLT_PCD - 4.0):
        raise ValueError(
            f"motor_bolt_d({p['motor_bolt_d']}) 超出範圍：需 0–{MOTOR_BOLT_PCD - 4.0} mm（不得大到相鄰孔重疊）"
        )
    if p["travel"] <= 0:
        raise ValueError(f"travel({p['travel']}) 必須 > 0:行程需為正值")
    if p["carriage_len"] < bl:
        raise ValueError(
            f"carriage_len({p['carriage_len']}) 不可小於滑塊長 {bl}:"
            f"載台需完整覆蓋滑塊(合法 ≥ {bl})"
        )
    if p["base_t"] <= 3:
        raise ValueError(f"base_t({p['base_t']}) 過薄:底板厚需 > 3 mm")
    if p["rail_span"] <= bw + 2:
        raise ValueError(
            f"rail_span({p['rail_span']}) 太窄:兩滑塊(各寬 {bw})會相撞,"
            f"中心距需 > {bw + 2}"
        )
    hole_d = p["corner_hole_d"]
    if hole_d <= 0:
        raise ValueError(f"corner_hole_d({hole_d}) 必須 > 0")
    base_hy = p["rail_span"] / 2.0 + bw / 2.0 + 8.0
    inset_min = hole_d / 2.0 + 3.0
    inset_max = base_hy - hole_d / 2.0
    if not (inset_min <= p["corner_inset"] <= inset_max):
        raise ValueError(
            f"corner_inset({p['corner_inset']}) 超出範圍：需 "
            f"{inset_min:.2f}–{inset_max:.2f} mm（下限=孔緣留 3mm 肉厚；上限=不越板中線）"
        )


# ---------------------------------------------------------------------------
# 小建模工具
# ---------------------------------------------------------------------------
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _xcyl(r, x0, x1, z, y=0.0):
    """半徑 r、軸沿 +X 由 x0 到 x1、位於 (y, z) 的圓柱。"""
    return Pos((x0 + x1) / 2.0, y, z) * Cylinder(r, x1 - x0).rotate(
        Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)), 90.0
    )


def _rotate_to_x(shape):
    """把 +Z 軸生成的零件轉成軸沿 +X。"""
    return shape.rotate(Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)), 90.0)


# ---------------------------------------------------------------------------
# 定位常數表(集中;勿散在算式)
# ---------------------------------------------------------------------------
RAIL_X0 = 24.0           # 導軌/載台起點 x
SCREW_END_MARGIN = 56.0  # 螺桿較 (travel+carriage) 兩端多出的總量(容軸承座+聯軸)
MOTOR_FACE_X = -30.0     # 馬達安裝面 x
MOUNT_X0, MOUNT_X1 = -30.0, -22.0   # 馬達座板 x 範圍
COUPLING_X0, COUPLING_X1 = -14.0, 6.0
MOTOR_BOLT_PCD = 31.0    # NEMA17（42 框）標準鎖付方陣邊長 (mm)；孔在 ±15.5 方陣
COUPLING_R = 7.0         # < 軸承內孔半徑(10),穿內孔零接觸;與螺桿端刻意重疊(宣告)


def _geom():
    p = PARAMS
    sc, g, b, m = _SCREW, _GUIDE, _BEARING, _MOTOR
    travel = p["travel"]
    carriage_len = p["carriage_len"]
    base_t = p["base_t"]
    rail_y = p["rail_span"] / 2.0

    rail_h = g["rail_height"]
    block_w = g["block_width"]
    block_h = g["block_height"]
    block_len = g["block_len"]
    nut_dia = sc["nut_dia"]
    brg_od = b["od"]
    brg_w = b["width"]

    rail_len = travel + carriage_len
    screw_len = travel + carriage_len + SCREW_END_MARGIN
    carriage_x0 = RAIL_X0
    carriage_cx = carriage_x0 + carriage_len / 2.0

    base_hy = rail_y + block_w / 2.0 + 8.0
    carr_hy = rail_y + block_w / 2.0        # 載台完整覆蓋滑塊頂面(共平面,零體積接觸)

    block_top_z = base_t + rail_h * 0.3 + block_h
    z_screw = block_top_z + nut_dia / 2.0 + 6.0
    carriage_top_z = z_screw + nut_dia / 2.0 + 12.0
    pillar_top_z = z_screw + brg_od / 2.0 + 6.0

    block_pos0 = (carriage_cx - RAIL_X0) - block_len / 2.0
    nut_pos0 = carriage_cx - sc["nut_len"] / 2.0

    return dict(
        base_t=base_t, screw_len=screw_len, rail_len=rail_len,
        carriage_len=carriage_len, carriage_x0=carriage_x0,
        rail_w=g["rail_width"], rail_h=rail_h,
        block_w=block_w, block_h=block_h, block_len=block_len, block_pos0=block_pos0,
        screw_dia=sc["screw_dia"], lead=sc["lead"], nut_dia=nut_dia,
        nut_len=sc["nut_len"], nut_pos0=nut_pos0,
        brg_bore=b["bore"], brg_od=brg_od, brg_w=brg_w,
        m_face=m["face"], m_body=m["body_len"], m_shaft_dia=m["shaft_dia"],
        m_shaft_len=m["shaft_len"], m_pilot_dia=m["pilot_dia"], m_pilot_len=m["pilot_len"],
        rail_y=rail_y, base_hy=base_hy, carr_hy=carr_hy,
        block_top_z=block_top_z, z_screw=z_screw,
        carriage_top_z=carriage_top_z, pillar_top_z=pillar_top_z,
    )


def _corner_holes(G):
    """四角 M4 餘隙孔（貫穿底板）；+X 對角置於遠端軸承座內側，保留鎖付通路。"""
    r = PARAMS["corner_hole_d"] / 2.0
    inset = PARAMS["corner_inset"]
    base_t = G["base_t"]
    x_lo = -40.0 + inset
    x_hi = (G["screw_len"] - G["brg_w"]) - inset
    y = G["base_hy"] - inset
    holes = None
    for cx in (x_lo, x_hi):
        for cy in (y, -y):
            h = Pos(cx, cy, base_t / 2.0) * Cylinder(r, base_t + 2.0)
            holes = h if holes is None else holes + h
    return holes


# 隨 stroke DOF 平移的載台群
_MOVING = {"carriage", "guide_block_neg", "guide_block_pos", "screw_nut"}


def _seated_parts(G):
    """在 seated pose(u=0)於世界座標建全部件,回 {name: shape}。"""
    base_t = G["base_t"]
    z_screw = G["z_screw"]
    parts = {}

    base = _box(-40.0, G["screw_len"] + 6.0, -G["base_hy"], G["base_hy"], 0.0, base_t)
    parts["base"] = base - _corner_holes(G)

    def _pillar(x0):
        plate = _box(x0, x0 + G["brg_w"], -G["base_hy"] + 4.0, G["base_hy"] - 4.0,
                     base_t, G["pillar_top_z"])
        bore = _xcyl(G["brg_od"] / 2.0 + 0.3, x0 - 1.0, x0 + G["brg_w"] + 1.0, z_screw)
        return plate - bore

    parts["pillar_neg"] = _pillar(0.0)
    parts["pillar_pos"] = _pillar(G["screw_len"] - G["brg_w"])

    mount = _box(MOUNT_X0, MOUNT_X1, -25.0, 25.0, base_t, z_screw + 24.0)
    mount = mount - _xcyl(G["m_pilot_dia"] / 2.0 + 0.6, MOUNT_X0 - 1.0, MOUNT_X1 + 1.0, z_screw)
    _bh = MOTOR_BOLT_PCD / 2.0                     # NEMA17 方陣 ±15.5
    _br = PARAMS["motor_bolt_d"] / 2.0
    for _by in (_bh, -_bh):
        for _bz in (z_screw + _bh, z_screw - _bh):
            mount = mount - _xcyl(_br, MOUNT_X0 - 1.0, MOUNT_X1 + 1.0, _bz, y=_by)
    parts["motor_mount"] = mount

    def _rail(side):
        gp = linear_guide(
            G["rail_w"], G["rail_h"], G["rail_len"],
            G["block_w"], G["block_h"], G["block_len"], block_pos=G["block_pos0"],
        )
        y = side * G["rail_y"]
        rail = gp.children[0].translate((RAIL_X0, y, base_t))
        block = gp.children[1].translate((RAIL_X0, y, base_t))
        return rail, block

    rail_neg, block_neg = _rail(-1)
    rail_pos, block_pos = _rail(1)
    parts["rail_neg"] = rail_neg
    parts["rail_pos"] = rail_pos
    parts["guide_block_neg"] = block_neg
    parts["guide_block_pos"] = block_pos

    scr = ball_screw(
        G["screw_dia"], G["lead"], G["screw_len"], G["nut_dia"], G["nut_len"],
        nut_pos=G["nut_pos0"],
    )
    parts["screw_shaft"] = scr.children[0].translate((0.0, 0.0, z_screw))
    parts["screw_nut"] = scr.children[1].translate((0.0, 0.0, z_screw))

    def _bearing(x0):
        bp = deep_groove_bearing(G["brg_bore"], G["brg_od"], G["brg_w"])
        return _rotate_to_x(bp).translate((x0, 0.0, z_screw))

    parts["bearing_neg"] = _bearing(0.0)
    parts["bearing_pos"] = _bearing(G["screw_len"] - G["brg_w"])

    motor = stepper_motor(
        G["m_face"], G["m_body"], G["m_shaft_dia"], G["m_shaft_len"],
        pilot_dia=G["m_pilot_dia"], pilot_len=G["m_pilot_len"],
    )
    parts["motor"] = _rotate_to_x(motor).translate((MOTOR_FACE_X, 0.0, z_screw))
    parts["coupling"] = _xcyl(COUPLING_R, COUPLING_X0, COUPLING_X1, z_screw)

    body = _box(
        G["carriage_x0"], G["carriage_x0"] + G["carriage_len"],
        -G["carr_hy"], G["carr_hy"], G["block_top_z"], G["carriage_top_z"],
    )
    tunnel = _xcyl(
        G["nut_dia"] / 2.0 + 1.0, G["carriage_x0"] - 1.0,
        G["carriage_x0"] + G["carriage_len"] + 1.0, z_screw,
    )
    parts["carriage"] = body - tunnel
    return parts


_SEATED_CACHE = None


def _seated():
    global _SEATED_CACHE
    if _SEATED_CACHE is None:
        _SEATED_CACHE = _seated_parts(_geom())
    return _SEATED_CACHE


def pose(u=0.0):
    """stroke = u mm 時的全部件 (name, shape)。唯一運動真相源。"""
    out = []
    for name, shape in _seated().items():
        s = shape.translate((u, 0.0, 0.0)) if name in _MOVING else shape
        out.append((name, s))
    return out


# ---------------------------------------------------------------------------
# 運動宣告(harness 據此跑全行程掃掠)
# ---------------------------------------------------------------------------
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {
            "id": "stroke",
            "label": "行程",
            "type": "linear",
            "axis": [1.0, 0.0, 0.0],
            "travel": PARAMS["travel"],
            "moving": ["carriage", "guide_block_neg", "guide_block_pos", "screw_nut"],
            "pairs": [
                ["guide_block_neg", "rail_neg"],
                ["guide_block_pos", "rail_pos"],
                ["screw_nut", "screw_shaft"],
                ["carriage", "pillar_pos"],
                ["carriage", "bearing_pos"],
                ["screw_nut", "bearing_pos"],
            ],
            "samples": 12,
        }
    ],
}


# ---------------------------------------------------------------------------
# 驗收契約
# ---------------------------------------------------------------------------
# 螺帽/滑塊為運行配合(生成器建成間隙孔,靜態零穿透),唯聯軸器刻意夾住螺桿端與馬達軸。
INTENDED_CONTACT = [
    ("coupling", "screw_shaft"),
    ("coupling", "motor"),
]


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference
    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


def gen_step():
    _check_params()
    asm = AssemblyHelper("linear_stage")
    parts = {}
    for name, shape in pose(0.0):
        asm.add(shape, name)
        parts[name] = shape
    asm.linear_frame(
        parts["carriage"], "stroke",
        Axis((0.0, 0.0, _geom()["carriage_top_z"]), (1.0, 0.0, 0.0)),
    )
    return asm.build()


if __name__ == "__main__":
    print("SELECTED  screw:%s  guide:%s  bearing:%s  motor:%s"
          % (_SCREW["model"], _GUIDE["model"], _BEARING["model"], _MOTOR["model"]))
    print("torque_req %.4f Nm  motor margin %.2f"
          % (_TORQUE, _MOTOR["selected_for"]["margin"]))
    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    check_geometry(shape)
    print("geometry checks: passed")
