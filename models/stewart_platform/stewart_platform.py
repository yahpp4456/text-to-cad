"""六軸並聯史都華平台(Stewart platform, 6-UPS):固定底座 + 六支液壓缸(缸筒 + 活塞桿)
+ 動平台,缸兩端球鉸。壓軸展示用的參數化組合件。

座標:單位 mm,Z 向上;底座板底面貼 z=0。六個底座球鉸落在半徑 base_r 的圓上,
分三對(每對夾 30°);六個平台球鉸落在半徑 plat_r 的圓上,錯位 60° 再分三對——
相鄰的底座球鉸與平台球鉸交錯相連,六支缸形成三組「八」字,即標準 6-6 構型。

每支腿兩件:`leg{k}_cyl`(底座球 + 缸筒,一體)與 `leg{k}_rod`(活塞桿 + 平台球,一體);
桿在缸筒內孔滑動(單邊餘隙 1 mm,不接觸)。球鉸各沉入板面 6 mm 當作鉸座(宣告貼合)。

MOTION(剛體示意):heave 沿 +Z 升降、tilt 繞 X 軸(過平台中心)俯仰;動件 = 平台 +
六支活塞桿。並聯機構的真實腿長變化是六缸各自伸縮,剛體播放是等效近似——桿對缸筒會有
小量側移(缸筒外徑刻意留厚,視覺上仍在筒內);精算掃掠會如實把這段側移當干涉報出來,
屬已知限制。
"""

import math

from build123d import Align, Cylinder, Plane, Pos, Sphere
from cadpy.assembly import AssemblyHelper

PARAMS = {
    "base_r": 170.0,      # 底座板半徑
    "base_t": 12.0,       # 底座板厚
    "base_joint_r": 150.0,  # 底座球鉸分佈半徑
    "plat_r": 120.0,      # 動平台半徑
    "plat_t": 10.0,       # 動平台厚
    "plat_joint_r": 100.0,  # 平台球鉸分佈半徑
    "height": 230.0,      # 平台底面高度(home 姿態)
    "pair_half_deg": 15.0,  # 每對球鉸的半夾角
    "cyl_r": 18.0,        # 缸筒外半徑
    "bore_r": 8.0,        # 缸筒內孔半徑
    "rod_r": 7.0,         # 活塞桿半徑
    "ball_r": 14.0,       # 球鉸半徑
    "heave": 20.0,        # 升降行程
    "tilt_deg": 6.0,      # 俯仰角
}

# 六腿配對:底座角 → 平台角(交錯相連成三組「八」字)
_P = PARAMS
_H = _P["pair_half_deg"]
_BASE_DEG = [0 + _H, 120 - _H, 120 + _H, 240 - _H, 240 + _H, 360 - _H]
_PLAT_DEG = [60 - _H, 60 + _H, 180 - _H, 180 + _H, 300 - _H, 300 + _H]


def _pol(r, deg, z):
    a = math.radians(deg)
    return (r * math.cos(a), r * math.sin(a), z)


def _legs():
    """回傳六腿的 (底座球心, 平台球心)。球心各沉入板面 6 mm。"""
    p = PARAMS
    zb = p["base_t"] + p["ball_r"] - 6.0
    zp = p["height"] - p["ball_r"] + 6.0
    return [
        (_pol(p["base_joint_r"], _BASE_DEG[k], zb), _pol(p["plat_joint_r"], _PLAT_DEG[k], zp))
        for k in range(6)
    ]


def _zcyl(r, z0, z1, x=0.0, y=0.0):
    return Pos(x, y, (z0 + z1) / 2) * Cylinder(r, z1 - z0)


def _along(start, u, r, length):
    """從 start 沿單位向量 u 的實心圓柱。"""
    return Plane(origin=start, z_dir=u) * Cylinder(r, length, align=(Align.CENTER, Align.CENTER, Align.MIN))


def _unit(a, b):
    d = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    n = math.sqrt(sum(c * c for c in d))
    return (d[0] / n, d[1] / n, d[2] / n), n


def _base():
    p = PARAMS
    plate = _zcyl(p["base_r"], 0.0, p["base_t"])
    plate -= _zcyl(40.0, -1.0, p["base_t"] + 1.0)  # 中央減重孔
    for k in range(6):  # 六個安裝孔
        x, y, _ = _pol(p["base_r"] - 14.0, 30 + 60 * k, 0)
        plate -= _zcyl(4.5, -1.0, p["base_t"] + 1.0, x, y)
    return plate


def _platform():
    p = PARAMS
    plate = _zcyl(p["plat_r"], p["height"], p["height"] + p["plat_t"])
    plate -= _zcyl(25.0, p["height"] - 1.0, p["height"] + p["plat_t"] + 1.0)  # 中央工具孔
    for k in range(4):  # 工具安裝孔
        x, y, _ = _pol(45.0, 45 + 90 * k, 0)
        plate -= _zcyl(3.5, p["height"] - 1.0, p["height"] + p["plat_t"] + 1.0, x, y)
    return plate


def _leg_cyl(a, b):
    p = PARAMS
    u, L = _unit(a, b)
    body = Pos(*a) * Sphere(p["ball_r"])
    barrel_len = 0.55 * L
    barrel = _along(a, u, p["cyl_r"], barrel_len)
    bore_start = (a[0] + u[0] * 22.0, a[1] + u[1] * 22.0, a[2] + u[2] * 22.0)
    barrel -= _along(bore_start, u, p["bore_r"], barrel_len)  # 從 22 mm 起鑽通到筒口
    return body + barrel


def _leg_rod(a, b):
    p = PARAMS
    u, L = _unit(a, b)
    v = (-u[0], -u[1], -u[2])
    rod_len = 0.62 * L
    rod = _along(b, v, p["rod_r"], rod_len)
    return rod + Pos(*b) * Sphere(p["ball_r"] - 2.0)


INTENDED_CONTACT = [("base", f"leg{k}_cyl") for k in range(6)] + [
    ("platform", f"leg{k}_rod") for k in range(6)
]

_MOVING = ["platform"] + [f"leg{k}_rod" for k in range(6)]
_PAIRS = [[f"leg{k}_rod", f"leg{k}_cyl"] for k in range(6)]

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "heave", "label": "平台升降", "type": "linear", "axis": [0, 0, 1],
         "travel": PARAMS["heave"], "moving": _MOVING, "pairs": _PAIRS, "samples": 8},
        {"id": "tilt", "label": "平台俯仰", "type": "revolute", "axis": [1, 0, 0],
         "pivot": [0.0, 0.0, PARAMS["height"] + PARAMS["plat_t"] / 2],
         "angle_deg": PARAMS["tilt_deg"], "moving": _MOVING, "pairs": _PAIRS, "samples": 12},
    ],
}


def gen_step():
    asm = AssemblyHelper("stewart_platform")
    asm.add(_base(), "base")
    asm.add(_platform(), "platform")
    for k, (a, b) in enumerate(_legs()):
        asm.add(_leg_cyl(a, b), f"leg{k}_cyl")
        asm.add(_leg_rod(a, b), f"leg{k}_rod")
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="stewart_platform")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
