"""Formal design from the motion sketch "horizontal cylinder push tilt platform 30 deg".

Slider-crank tilt platform: a horizontal compact cylinder (SMC CQ2B32, 25 mm
stroke) pushes a rod-end knuckle pin along the line z = hinge_z - lever_drop;
a coupler link (center-to-center link_len) drives a lever arm lever_drop
below the hinge axis, tilting the platform 0..theta_max about the y-directed
hinge pin.

Deviation from the sketch: the hinge axis is raised from z=60 to z=70 so the
45 mm square CQ2 body clears the 10 mm base plate; all joint-relative
geometry (lever_drop 35, link 120, horizontal cylinder axis) is unchanged.
"""
import math

from build123d import Axis, Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper
from cadpy.parts import pneumatic_cylinder

# ---------------------------------------------------------------------------
# Fixed layout constants (mm). HINGE_X / MID_Y / BASE_CX anchor the sketch
# frame. CYL_* are SMC CQ2B32 datasheet values from part sourcing (square
# body 45, rod 16, corner bolt holes 5.5, base length 40). CYL_PROT is the
# fixed rod stick-out at retraction, ROD_EXT0 the pre-extension at theta=0
# so the piston never bottoms out. KN_PIN_OFF is rod tip -> knuckle pin
# center; KN_EMBED is the modeled thread engagement of the rod tip inside
# the knuckle base block.
# ---------------------------------------------------------------------------
HINGE_X = 100.0
MID_Y = 100.0
BASE_CX = 110.0
CYL_BORE = 32.0
CYL_STROKE = 25.0
CYL_ROD_D = 16.0
CYL_BODY_W = 45.0
CYL_CORNER_HOLE = 5.5
CYL_BASE_LEN = 40.0
CYL_BODY_LEN = CYL_BASE_LEN + CYL_STROKE
CYL_PROT = 8.0
ROD_EXT0 = 3.0
KN_PIN_OFF = 14.0
KN_EMBED = 2.0
BOSS_OD = 20.0

PARAMS = {
    "theta_max": 30.0,
    "plat_len": 300.0,
    "plat_wid": 200.0,
    "plat_t": 10.0,
    "lever_drop": 35.0,
    "link_len": 120.0,
    "hinge_z": 70.0,
    "link_t": 8.0,
    "eye_od": 16.0,
    "pin_d": 10.0,
    "base_len": 520.0,
    "base_wid": 260.0,
    "base_t": 10.0,
}


def _geom():
    # Derived layout, single source for builders / checks / MOTION.
    p = PARAMS
    g = {}
    g["axis_z"] = p["hinge_z"] - p["lever_drop"]          # cylinder / link axis height
    g["pin_x0"] = HINGE_X - p["link_len"]                 # rod-end pin x at theta=0
    g["cyl_base_x"] = g["pin_x0"] - KN_PIN_OFF - CYL_PROT - ROD_EXT0 - CYL_BODY_LEN
    g["slot"] = p["link_t"] + 2.0                          # clevis slot width
    g["lev_w"] = g["slot"] + 14.0                          # clevis outer width (7 mm ears)
    g["pin_len"] = g["lev_w"] + 4.0                        # clevis pins, 2 mm proud each side
    g["boss_len"] = p["plat_wid"] + 26.0                   # hinge boss tube length
    g["post_in"] = p["plat_wid"] / 2.0 + 15.0              # post inner face from MID_Y
    g["hp_len"] = p["plat_wid"] + 70.0                     # hinge pin length
    g["plate_x0"] = HINGE_X - 20.0                         # platform plate rear edge
    g["plate_x1"] = g["plate_x0"] + p["plat_len"]
    g["rest_x0"] = g["plate_x1"] - 70.0                    # rest block 50 mm from front edge
    g["rest_top"] = p["hinge_z"] - p["plat_t"] / 2.0
    g["base_x0"] = BASE_CX - p["base_len"] / 2.0
    g["base_x1"] = BASE_CX + p["base_len"] / 2.0
    g["base_y0"] = MID_Y - p["base_wid"] / 2.0
    g["base_y1"] = MID_Y + p["base_wid"] / 2.0
    return g


def _rod_travel():
    # Closed-form rod travel for theta 0 -> theta_max: the lever pin moves
    # +x by L*sin(theta) and rises by dz = L*(1-cos(theta)); the rod-end pin
    # stays on the cylinder axis, so its x also gains the shortened
    # horizontal projection of the link.
    p = PARAMS
    th = math.radians(p["theta_max"])
    lever = p["lever_drop"]
    c = p["link_len"]
    dz = lever * (1.0 - math.cos(th))
    return lever * math.sin(th) + (c - math.sqrt(max(c * c - dz * dz, 0.0)))


def _check_params():
    p = PARAMS
    g = _geom()
    if not 5.0 <= p["theta_max"] <= 40.0:
        raise ValueError(
            f"theta_max({p['theta_max']})須在 5~40°:低於 5° 無意義,高於 40° 超出連桿機構設計範圍"
        )
    if p["link_len"] < 2.0 * p["lever_drop"]:
        raise ValueError(
            f"link_len({p['link_len']})須 ≥ 2×lever_drop({p['lever_drop']}):連桿過短會使傳動角惡化且閉式解不穩定"
        )
    need = ROD_EXT0 + _rod_travel()
    if need > CYL_STROKE - 2.0:
        raise ValueError(
            f"行程不足:θ={p['theta_max']}° 需缸桿伸出 {need:.1f}mm,超過 CQ2 行程 {CYL_STROKE}mm 扣 2mm 餘裕;請降低 theta_max 或 lever_drop"
        )
    if g["axis_z"] - CYL_BODY_W / 2.0 < p["base_t"] + 2.0:
        raise ValueError(
            f"hinge_z({p['hinge_z']})過低:缸軸高 {g['axis_z']:.1f} 使 45mm 方身缸體與底板(頂面 {p['base_t']})淨距不足 2mm;請提高 hinge_z 或降低 lever_drop"
        )
    if g["rest_top"] <= p["base_t"] + 5.0:
        raise ValueError(
            f"hinge_z({p['hinge_z']})過低:平台底面({g['rest_top']:.1f})與底板頂面({p['base_t']})間不足 5mm,無法放前支承塊"
        )
    if not p["pin_d"] + 5.0 <= p["eye_od"] <= 17.0:
        raise ValueError(
            f"eye_od({p['eye_od']})須在 pin_d+5({p['pin_d'] + 5.0})~17:眼壁過薄或與桿端接頭干涉"
        )
    if not 5.0 <= p["link_t"] <= 12.0:
        raise ValueError(f"link_t({p['link_t']})須在 5~12mm:過薄挫曲、過厚超出 clevis 槽設計")
    if not 6.0 <= p["pin_d"] <= 12.0:
        raise ValueError(f"pin_d({p['pin_d']})須在 6~12mm")
    if not 5.0 <= p["plat_t"] <= 20.0:
        raise ValueError(f"plat_t({p['plat_t']})須在 5~20mm")
    if p["plat_len"] < 150.0:
        raise ValueError(f"plat_len({p['plat_len']})須 ≥ 150mm:前支承塊須落在鉸鏈支座之外")
    if p["plat_wid"] + 60.0 > p["base_wid"]:
        raise ValueError(
            f"plat_wid({p['plat_wid']})不可大於 base_wid({p['base_wid']})−60:鉸鏈支座會超出底板"
        )
    if p["base_len"] < 2.0 * p["plat_len"] - 120.0:
        raise ValueError(
            f"base_len({p['base_len']})不足:平台長 {p['plat_len']} 需底板 ≥ {2.0 * p['plat_len'] - 120.0:.0f} 才蓋得住前支承塊"
        )
    if g["base_x0"] > g["cyl_base_x"] - 20.0:
        raise ValueError(
            f"base_len({p['base_len']})不足:汽缸後座(x={g['cyl_base_x'] - 10.0:.0f})會超出底板後緣(x={g['base_x0']:.0f})"
        )


def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _cyl_y(x, z, y0, y1, r):
    c = Cylinder(r, y1 - y0).rotate(Axis((0, 0, 0), (1, 0, 0)), -90.0)
    return c.translate((x, (y0 + y1) / 2.0, z))


def _cyl_x(y, z, x0, x1, r):
    c = Cylinder(r, x1 - x0).rotate(Axis((0, 0, 0), (0, 1, 0)), 90.0)
    return c.translate(((x0 + x1) / 2.0, y, z))


def _frame():
    # Base plate + 2 hinge posts + platform rest block + cylinder riser +
    # rear mounting bracket, fused into one weldment.
    p = PARAMS
    g = _geom()
    base = _box(g["base_x0"], g["base_x1"], g["base_y0"], g["base_y1"], 0.0, p["base_t"])
    posts = []
    for s in (-1.0, 1.0):
        yi = MID_Y + s * g["post_in"]
        yo = MID_Y + s * (g["post_in"] + 10.0)
        posts.append(
            _box(HINGE_X - 25.0, HINGE_X + 25.0, min(yi, yo), max(yi, yo),
                 p["base_t"], p["hinge_z"] + 15.0)
        )
    rest = _box(g["rest_x0"], g["rest_x0"] + 40.0, MID_Y - 30.0, MID_Y + 30.0,
                p["base_t"], g["rest_top"])
    riser = _box(g["cyl_base_x"], g["cyl_base_x"] + CYL_BODY_LEN,
                 MID_Y - 30.0, MID_Y + 30.0,
                 p["base_t"], g["axis_z"] - CYL_BODY_W / 2.0)
    bracket = _box(g["cyl_base_x"] - 10.0, g["cyl_base_x"],
                   MID_Y - 40.0, MID_Y + 40.0,
                   p["base_t"], g["axis_z"] + 30.0)
    frame = base + posts[0] + posts[1] + rest + riser + bracket
    # Hinge pin press bores through both posts
    frame -= _cyl_y(HINGE_X, p["hinge_z"],
                    MID_Y - g["post_in"] - 11.0, MID_Y + g["post_in"] + 11.0,
                    p["pin_d"] / 2.0)
    # 4x base mounting holes, 20 mm inside the plate corners
    for hx in (g["base_x0"] + 20.0, g["base_x1"] - 20.0):
        for hy in (g["base_y0"] + 20.0, g["base_y1"] - 20.0):
            frame -= Pos(hx, hy, p["base_t"] / 2.0) * Cylinder(5.0, p["base_t"] + 2.0)
    # 4x cylinder through-bolt clearance holes in the rear bracket
    for sy in (-1.0, 1.0):
        for sz in (-1.0, 1.0):
            off = CYL_BODY_W / 2.0 - CYL_CORNER_HOLE
            frame -= _cyl_x(MID_Y + sy * off, g["axis_z"] + sz * off,
                            g["cyl_base_x"] - 11.0, g["cyl_base_x"] + 1.0,
                            CYL_CORNER_HOLE / 2.0)
    return frame


def _platform():
    # Plate + hinge boss tube + lever arm with clevis slot, one solid.
    p = PARAMS
    g = _geom()
    plate = _box(g["plate_x0"], g["plate_x1"],
                 MID_Y - p["plat_wid"] / 2.0, MID_Y + p["plat_wid"] / 2.0,
                 p["hinge_z"] - p["plat_t"] / 2.0, p["hinge_z"] + p["plat_t"] / 2.0)
    boss = _cyl_y(HINGE_X, p["hinge_z"],
                  MID_Y - g["boss_len"] / 2.0, MID_Y + g["boss_len"] / 2.0,
                  BOSS_OD / 2.0)
    lever = _box(HINGE_X - 8.0, HINGE_X + 8.0,
                 MID_Y - g["lev_w"] / 2.0, MID_Y + g["lev_w"] / 2.0,
                 g["axis_z"] - 10.0, p["hinge_z"])
    plat = plate + boss + lever
    # Clevis slot for the link rear eye
    plat -= _box(HINGE_X - 9.0, HINGE_X + 9.0,
                 MID_Y - g["slot"] / 2.0, MID_Y + g["slot"] / 2.0,
                 g["axis_z"] - 11.0, g["axis_z"] + 10.0)
    # Boss running bore (0.2 mm clearance on the hinge pin)
    plat -= _cyl_y(HINGE_X, p["hinge_z"],
                   MID_Y - g["boss_len"] / 2.0 - 1.0, MID_Y + g["boss_len"] / 2.0 + 1.0,
                   (p["pin_d"] + 0.2) / 2.0)
    # Clevis pin press bores through the lever ears
    plat -= _cyl_y(HINGE_X, g["axis_z"],
                   MID_Y - g["lev_w"] / 2.0 - 1.0, MID_Y + g["lev_w"] / 2.0 + 1.0,
                   p["pin_d"] / 2.0)
    return plat


def _link():
    # Flat coupler bar, both eyes bored 0.2 mm over pin for the bushed
    # running fits, at the theta=0 pose (horizontal on the cylinder axis).
    p = PARAMS
    g = _geom()
    y0 = MID_Y - p["link_t"] / 2.0
    y1 = MID_Y + p["link_t"] / 2.0
    bar = _box(g["pin_x0"], HINGE_X, y0, y1,
               g["axis_z"] - p["eye_od"] / 2.0, g["axis_z"] + p["eye_od"] / 2.0)
    link = bar
    for ex in (g["pin_x0"], HINGE_X):
        link += _cyl_y(ex, g["axis_z"], y0, y1, p["eye_od"] / 2.0)
    for ex in (g["pin_x0"], HINGE_X):
        link -= _cyl_y(ex, g["axis_z"], y0 - 1.0, y1 + 1.0, (p["pin_d"] + 0.2) / 2.0)
    return link


def _knuckle():
    # Y-knuckle on the rod tip: base block (rod embedded KN_EMBED as thread
    # engagement) + two ears around the link front eye.
    p = PARAMS
    g = _geom()
    x_pin = g["pin_x0"]
    base = _box(x_pin - KN_PIN_OFF - KN_EMBED, x_pin - p["eye_od"] / 2.0 - 1.0,
                MID_Y - 10.0, MID_Y + 10.0,
                g["axis_z"] - 10.0, g["axis_z"] + 10.0)
    ears = _box(x_pin - p["eye_od"] / 2.0 - 1.0, x_pin + 12.0,
                MID_Y - g["lev_w"] / 2.0, MID_Y + g["lev_w"] / 2.0,
                g["axis_z"] - 12.0, g["axis_z"] + 12.0)
    ears -= _box(x_pin - p["eye_od"] / 2.0 - 2.0, x_pin + 13.0,
                 MID_Y - g["slot"] / 2.0, MID_Y + g["slot"] / 2.0,
                 g["axis_z"] - 13.0, g["axis_z"] + 13.0)
    kn = base + ears
    kn -= _cyl_y(x_pin, g["axis_z"],
                 MID_Y - g["lev_w"] / 2.0 - 1.0, MID_Y + g["lev_w"] / 2.0 + 1.0,
                 p["pin_d"] / 2.0)
    return kn


def _pins():
    p = PARAMS
    g = _geom()
    hinge_pin = _cyl_y(HINGE_X, p["hinge_z"],
                       MID_Y - g["hp_len"] / 2.0, MID_Y + g["hp_len"] / 2.0,
                       p["pin_d"] / 2.0)
    pin_plat = _cyl_y(HINGE_X, g["axis_z"],
                      MID_Y - g["pin_len"] / 2.0, MID_Y + g["pin_len"] / 2.0,
                      p["pin_d"] / 2.0)
    pin_rod = _cyl_y(g["pin_x0"], g["axis_z"],
                     MID_Y - g["pin_len"] / 2.0, MID_Y + g["pin_len"] / 2.0,
                     p["pin_d"] / 2.0)
    return hinge_pin, pin_plat, pin_rod


def _cylinder():
    # CQ2B32 proxy built along +Z, rotated to +X, rod pre-extended ROD_EXT0.
    g = _geom()
    cmp = pneumatic_cylinder(
        CYL_BORE, CYL_STROKE, extension=ROD_EXT0, rod_dia=CYL_ROD_D,
        rod_protrusion=CYL_PROT, label_prefix="cyl", body_shape="square",
        body_w=CYL_BODY_W, corner_hole=CYL_CORNER_HOLE, base_len=CYL_BASE_LEN,
    )
    body, rod = cmp.children[0], cmp.children[1]

    def _place(s):
        return s.rotate(Axis((0, 0, 0), (0, 1, 0)), 90.0).translate(
            (g["cyl_base_x"], MID_Y, g["axis_z"])
        )

    return _place(body), _place(rod)


def gen_step():
    _check_params()
    asm = AssemblyHelper("tilt_platform")
    asm.add(_frame(), "frame")
    asm.add(_platform(), "platform")
    asm.add(_link(), "link")
    asm.add(_knuckle(), "knuckle")
    hinge_pin, pin_plat, pin_rod = _pins()
    asm.add(hinge_pin, "hinge_pin")
    asm.add(pin_plat, "pin_plat")
    asm.add(pin_rod, "pin_rod")
    body, rod = _cylinder()
    asm.add(body, "cyl_body")
    asm.add(rod, "cyl_rod")
    return asm.build()


# Pin press fits (hardware x bore, zero-volume by construction) and the two
# deliberate engagements modeled as real overlap (rod inside barrel proxy,
# rod tip threaded into knuckle base).
INTENDED_CONTACT = [
    ("hinge_pin", "frame"),
    ("pin_plat", "platform"),
    ("pin_rod", "knuckle"),
    ("knuckle", "cyl_rod"),
    ("cyl_body", "cyl_rod"),
    ("cyl_body", "frame"),
]

# Closed-chain note: theta (revolute, master) and rod (linear, coupled) are
# synchronized; the coupler link rides with the rod group, so its slight
# rocking (~2.2 deg) is approximated as pure translation. Pairs therefore
# only cover the true sliding/rotating interfaces; link-to-pin fits are
# validated by the closed-form theta=0 pose and bore clearances.
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {
            "id": "theta",
            "label": "前傾角 θ",
            "type": "revolute",
            "axis": [0, -1, 0],
            "pivot": [HINGE_X, MID_Y, PARAMS["hinge_z"]],
            "angle_deg": PARAMS["theta_max"],
            "moving": ["platform", "pin_plat"],
            "pairs": [["platform", "frame"], ["platform", "hinge_pin"]],
            "samples": 16,
        },
        {
            "id": "rod",
            "label": "缸桿行程",
            "type": "linear",
            "axis": [1, 0, 0],
            "travel": _rod_travel(),
            "couple": "theta",
            "moving": ["cyl_rod", "knuckle", "pin_rod", "link"],
            "pairs": [["cyl_rod", "cyl_body"]],
            "samples": 16,
        },
    ],
}


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
