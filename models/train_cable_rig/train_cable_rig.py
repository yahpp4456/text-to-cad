"""車間電纜運動試驗機架 + Stewart 平台(trainsim-01)+ 綠色可用空間 — 單一檔案組合件。

來源
  * 機架:圖面「修改後圖面(1).pdf」(圖 006,2026-11-15)。外框 1000 × 790 × 2000,6060 鋁擠型。
    高度鏈(離地):腳座 130 → 底框 130–190 → 配電空間 190–440 → 承載樑 440–500
    → 墊高樑(三支,沿 Y)500–560 → 基座板底面 560 …… 頂框下緣 1940 → 頂框上緣 2000。
  * 平台:StewartProject `PlatformProfile.RealMachineDefault()`
    (= docs/reference/enclosure-envelope-scripts/envelope.py 的 B、P、HOMEZ、OFFB、OFFP…)。
  * 綠色可用空間:Ø600、從平台頂面起高 920,隨平台剛性移動。920 是 2026-11-16 依腿長軟體限制
    320.5–370.5 掃掠全部可達姿態後,半徑 300 不撞頂框(1940)的可用高度。

座標(使用者 2026-11-16 指定)
  原點 = 機架中心正下方的地面;+X 朝 1000 寬的右邊;+Y 朝 790 寬的上方(出線側 = −Y);+Z 向上。
  平台座標與機架同向:基座板與平台板的頂點朝 ±Y(實機 X/Y 對應仍待安裝時目視確認)。

平台姿態 = PARAMS 的 x/y/z(mm,相對 home)與 yaw/pitch/roll(deg,ZYX:R = Rz·Ry·Rx),
與專案 C# 的 RotationMatrix.ComputeZYX 同一約定。姿態超出腿長軟體限制時直接報錯,不產生模型。

示意(非實際零件外形):腳座、鉸點(以球表示萬向節)、電動缸(缸體 Ø45 + 推桿)。
未畫:腳輪、配電盤托盤、角碼與補強片、測試儀、固定側支架、電纜。
"""
import math

from build123d import Box, Color, Cylinder, Plane, Polygon, Pos, Sphere, extrude
from cadpy.assembly import AssemblyHelper, label_shape

# ---------------------------------------------------------------------------
# 機架(mm)
# ---------------------------------------------------------------------------
FRAME_X = 1000.0          # 外框寬(+X 方向)
FRAME_Y = 790.0           # 外框深(+Y 方向)
FRAME_H = 2000.0          # 含腳座總高
PROFILE = 60.0            # 6060 鋁擠型截面
FOOT_H = 130.0            # 腳座高度(地面 → 底框底面)
ELEC_H = 250.0            # 配電空間淨高
COL_CX = FRAME_X / 2 - PROFILE / 2     # 角柱中心 X = ±470
COL_CY = FRAME_Y / 2 - PROFILE / 2     # 角柱中心 Y = ±365

Z_BOTTOM_FRAME = FOOT_H                          # 130:底框底面
Z_SUPPORT_BEAM = FOOT_H + PROFILE + ELEC_H       # 440:承載樑底面
Z_RISER = Z_SUPPORT_BEAM + PROFILE               # 500:墊高樑底面
Z_BASE_BOTTOM = Z_RISER + PROFILE                # 560:基座板底面
Z_TOP_FRAME = FRAME_H - PROFILE                  # 1940:頂框下緣

RISER_X = (-230.0, 0.0, 230.0)    # 三支墊高樑中心 X(沿 Y 全深)

LEVELER_PAD_D = 100.0     # 調整腳底盤(示意)
LEVELER_PAD_T = 15.0
LEVELER_ROD_D = 16.0

# ---------------------------------------------------------------------------
# Stewart 平台 trainsim-01(與 envelope.py / PlatformProfile.RealMachineDefault 一致)
# 平台框原點 = 平台鉸點平面中心;基座鉸點平面 z = 基座板頂面 + OFFB
# ---------------------------------------------------------------------------
BASE_JOINTS = (
    (127.580, 170.975), (84.279, 195.975), (-211.859, 25.0),
    (-211.859, -25.0), (84.279, -195.975), (127.580, -170.975),
)
PLAT_JOINTS = (
    (154.997, 25.0), (-55.848, 146.731), (-99.149, 121.731),
    (-99.149, -121.731), (-55.848, -146.731), (154.997, -25.0),
)
HOME_Z = 311.945          # home 時平台鉸點平面離基座鉸點平面
OFF_B, BASE_T = 43.659, 10.0    # 基座鉸點高於基座板頂面;基座板厚
OFF_P, PLAT_T = 25.5, 7.5       # 平台鉸點低於平台板底面;平台板厚
BASE_HEX_R = 300.0        # 基座板正六角外接圓半徑(邊長 300,對角 600)
PLAT_HEX_R = 220.0        # 平台板正六角外接圓半徑(邊長 220,對角 440)
HEX_VERTEX_DEG = 30.0     # 頂點方位 30° + 60°k → 有頂點朝 ±Y
LEG_MIN, LEG_MAX = 320.5, 370.5   # 腿長軟體限制(鉸點中心距)

Z_BASE_JOINT = Z_BASE_BOTTOM + BASE_T + OFF_B    # 613.659
PLAT_TOP_LOCAL = OFF_P + PLAT_T                  # 33:平台頂面在平台框的 z

# 鉸點與電動缸(示意尺寸)
BALL_R = 16.0             # 鉸點球半徑
PEDESTAL_R = 20.0         # 鉸點座半徑
NECK_R = 12.0
NECK_LEN = 35.0           # 球心 → 缸體起點
BODY_R = 22.5             # 電動缸最粗處 Ø45
BODY_LEN = 210.0
ROD_R = 10.0

# ---------------------------------------------------------------------------
# 可調參數:平台姿態與綠色可用空間
# ---------------------------------------------------------------------------
PARAMS = {
    "x_mm": 0.0,
    "y_mm": 0.0,
    "z_mm": 0.0,
    "yaw_deg": 0.0,
    "pitch_deg": 0.0,
    "roll_deg": 0.0,
    "space_d_mm": 600.0,   # 綠色可用空間直徑
    "space_h_mm": 920.0,   # 綠色可用空間高度(從平台頂面沿平台法向)
}

COLOR_ALU = Color(0.78, 0.80, 0.83)
COLOR_FOOT = Color(0.20, 0.20, 0.22)
COLOR_BASE = Color(0.35, 0.36, 0.40)
COLOR_PLAT = Color(0.56, 0.36, 0.78)        # 圖上的紫色平台
COLOR_JOINT = Color(0.55, 0.56, 0.60)
COLOR_BODY = Color(0.22, 0.23, 0.26)
COLOR_ROD = Color(0.85, 0.86, 0.88)
COLOR_SPACE = Color(0.30, 0.80, 0.38, 0.35)


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(x1 - x0, y1 - y0, z1 - z0)


def _zcyl(r, z0, z1, x=0.0, y=0.0):
    return Pos(x, y, (z0 + z1) / 2) * Cylinder(r, z1 - z0)


def _hex_prism(r, z0, z1):
    pts = [
        (r * math.cos(math.radians(HEX_VERTEX_DEG + 60 * k)),
         r * math.sin(math.radians(HEX_VERTEX_DEG + 60 * k)))
        for k in range(6)
    ]
    return Pos(0, 0, z0) * extrude(Polygon(*pts, align=None), amount=z1 - z0)


def _rot_zyx(yaw, pitch, roll):
    """R = Rz(yaw)·Ry(pitch)·Rx(roll)(弧度),回傳 3×3 巢狀 tuple(列優先)。"""
    ca, sa = math.cos(yaw), math.sin(yaw)
    cb, sb = math.cos(pitch), math.sin(pitch)
    cg, sg = math.cos(roll), math.sin(roll)
    return (
        (ca * cb, ca * sb * sg - sa * cg, ca * sb * cg + sa * sg),
        (sa * cb, sa * sb * sg + ca * cg, sa * sb * cg - ca * sg),
        (-sb, cb * sg, cb * cg),
    )


def _pose():
    """平台框:原點(世界座標)與旋轉矩陣。"""
    p = PARAMS
    R = _rot_zyx(math.radians(p["yaw_deg"]), math.radians(p["pitch_deg"]), math.radians(p["roll_deg"]))
    origin = (p["x_mm"], p["y_mm"], Z_BASE_JOINT + HOME_Z + p["z_mm"])
    return origin, R


def _plat_location():
    origin, R = _pose()
    x_dir = (R[0][0], R[1][0], R[2][0])
    z_dir = (R[0][2], R[1][2], R[2][2])
    return Plane(origin=origin, x_dir=x_dir, z_dir=z_dir).location


def _plat_joint_world(i):
    origin, R = _pose()
    px, py = PLAT_JOINTS[i]
    return tuple(origin[k] + R[k][0] * px + R[k][1] * py for k in range(3))


def _base_joint_world(i):
    bx, by = BASE_JOINTS[i]
    return (bx, by, Z_BASE_JOINT)


def _leg_vector(i):
    b = _base_joint_world(i)
    q = _plat_joint_world(i)
    d = tuple(q[k] - b[k] for k in range(3))
    length = math.sqrt(sum(c * c for c in d))
    return b, tuple(c / length for c in d), length


def _check_params():
    p = PARAMS
    if not 100.0 <= p["space_d_mm"] <= 880.0:
        raise ValueError(f"space_d_mm({p['space_d_mm']})須在 100~880 mm")
    if not 0.0 < p["space_h_mm"] <= 1400.0:
        raise ValueError(f"space_h_mm({p['space_h_mm']})須在 0~1400 mm")
    bad = []
    for i in range(6):
        length = _leg_vector(i)[2]
        if not LEG_MIN <= length <= LEG_MAX:
            bad.append(f"腿 {i + 1} = {length:.1f}")
    if bad:
        raise ValueError(
            f"此姿態超出腿長軟體限制 {LEG_MIN}~{LEG_MAX} mm:{'、'.join(bad)} mm;請縮小平台位移或傾角"
        )


# ---------------------------------------------------------------------------
# 機架
# ---------------------------------------------------------------------------
def _frame_parts():
    parts = []
    corners = {
        "front_left": (-COL_CX, -COL_CY), "front_right": (COL_CX, -COL_CY),
        "rear_left": (-COL_CX, COL_CY), "rear_right": (COL_CX, COL_CY),
    }
    h = PROFILE / 2
    for name, (cx, cy) in corners.items():
        parts.append(label_shape(
            _box(cx - h, cx + h, cy - h, cy + h, Z_BOTTOM_FRAME, FRAME_H),
            "column", name, color=COLOR_ALU))

    # 每一層周邊框:X 向樑夾在角柱之間(長 880),Y 向樑夾在角柱之間(長 670)
    x_in = FRAME_X / 2 - PROFILE      # 440
    y_in = FRAME_Y / 2 - PROFILE      # 335
    for level, z0 in (("bottom", Z_BOTTOM_FRAME), ("support", Z_SUPPORT_BEAM), ("top", Z_TOP_FRAME)):
        z1 = z0 + PROFILE
        parts.append(label_shape(_box(-x_in, x_in, -COL_CY - h, -COL_CY + h, z0, z1),
                                 f"{level}_beam", "front", color=COLOR_ALU))
        parts.append(label_shape(_box(-x_in, x_in, COL_CY - h, COL_CY + h, z0, z1),
                                 f"{level}_beam", "rear", color=COLOR_ALU))
        parts.append(label_shape(_box(-COL_CX - h, -COL_CX + h, -y_in, y_in, z0, z1),
                                 f"{level}_beam", "left", color=COLOR_ALU))
        parts.append(label_shape(_box(COL_CX - h, COL_CX + h, -y_in, y_in, z0, z1),
                                 f"{level}_beam", "right", color=COLOR_ALU))

    # 承載層中央 X 向樑(y = 0),承托三支墊高樑的中段
    parts.append(label_shape(_box(-x_in, x_in, -h, h, Z_SUPPORT_BEAM, Z_SUPPORT_BEAM + PROFILE),
                             "support_beam", "center", color=COLOR_ALU))

    # 三支墊高樑(沿 Y 全深 790),頂面 = 基座板底面 560
    for name, x in zip(("left", "center", "right"), RISER_X):
        parts.append(label_shape(_box(x - h, x + h, -FRAME_Y / 2, FRAME_Y / 2, Z_RISER, Z_BASE_BOTTOM),
                                 "riser_beam", name, color=COLOR_ALU))

    # 調整腳(示意):底盤 + 螺桿,位於角柱正下方
    for name, (cx, cy) in corners.items():
        foot = _zcyl(LEVELER_PAD_D / 2, 0.0, LEVELER_PAD_T, cx, cy)
        foot += _zcyl(LEVELER_ROD_D / 2, LEVELER_PAD_T, FOOT_H, cx, cy)
        parts.append(label_shape(foot, "leveling_foot", name, color=COLOR_FOOT))
    return parts


# ---------------------------------------------------------------------------
# Stewart 平台
# ---------------------------------------------------------------------------
def _base_plate():
    z_top = Z_BASE_BOTTOM + BASE_T
    plate = _hex_prism(BASE_HEX_R, Z_BASE_BOTTOM, z_top)
    for bx, by in BASE_JOINTS:     # 鉸點座頂面與球底相切
        plate += _zcyl(PEDESTAL_R, z_top, Z_BASE_JOINT - BALL_R, bx, by)
    return plate


def _platform_plate():
    # 在平台框建模(鉸點平面 = z 0),再整體擺到姿態
    plate = _hex_prism(PLAT_HEX_R, OFF_P, OFF_P + PLAT_T)
    for px, py in PLAT_JOINTS:     # 鉸點座底面與球頂相切
        plate += _zcyl(PEDESTAL_R, BALL_R, OFF_P, px, py)
    return _plat_location() * plate


def _leg(i):
    """電動缸:缸體(含基座端球)+ 推桿(含平台端球),沿基座鉸點 → 平台鉸點的軸線。"""
    b, d, length = _leg_vector(i)
    body_end = NECK_LEN + BODY_LEN
    body = Sphere(BALL_R) + _zcyl(NECK_R, 0.0, NECK_LEN) + _zcyl(BODY_R, NECK_LEN, body_end)
    rod = _zcyl(ROD_R, body_end, length) + Pos(0, 0, length) * Sphere(BALL_R)
    aim = Plane(origin=b, z_dir=d).location
    return aim * body, aim * rod


def _green_space():
    p = PARAMS
    z0 = PLAT_TOP_LOCAL
    return _plat_location() * _zcyl(p["space_d_mm"] / 2, z0, z0 + p["space_h_mm"])


# ---------------------------------------------------------------------------
# 組合
# ---------------------------------------------------------------------------
def gen_step():
    _check_params()
    asm = AssemblyHelper("train_cable_rig")
    asm.add_module("frame", _frame_parts())

    stewart = [label_shape(_base_plate(), "base_plate", color=COLOR_BASE)]
    for i in range(6):
        body, rod = _leg(i)
        stewart.append(label_shape(body, "actuator_body", f"leg{i + 1}", color=COLOR_BODY))
        stewart.append(label_shape(rod, "actuator_rod", f"leg{i + 1}", color=COLOR_ROD))
    stewart.append(label_shape(_platform_plate(), "platform_plate", color=COLOR_PLAT))
    asm.add_module("stewart_platform", stewart)

    asm.add(_green_space(), "usable_space", color=COLOR_SPACE)
    return asm.build()


# 缸體 × 推桿在缸口面接觸、球 × 鉸點座相切:皆為零體積接觸,不需宣告。
INTENDED_CONTACT = []


def _flatten(shape):
    out = []
    for child in getattr(shape, "children", None) or []:
        grand = getattr(child, "children", None)
        if grand:
            out.extend(_flatten(child))
        else:
            out.append((str(child.label), child))
    return out


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    parts = _flatten(shape)
    assert_all_valid([s for _, s in parts], label="part")
    assert_no_interference(parts, allow=INTENDED_CONTACT)
