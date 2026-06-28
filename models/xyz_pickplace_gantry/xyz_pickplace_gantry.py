"""XYZ pick-and-place gantry with a 4-nozzle pneumatic head.

THREE motorized ball-screw linear axes (X, Y, Z) arranged as a cantilever
(C-frame) gantry, each REVERSE-ENGINEERED from its own travel/payload/speed duty
by the cadpy.parts selection layer -- ball screw + linear guide + support bearing
+ stepper motor are SELECTED, not eyeballed (provenance in the *_SEL dicts). The
Z carriage carries a head plate with FOUR independent pneumatic nozzles
(SC-series cylinders, also selected); each cylinder strokes its nozzle straight
down on its own DOF, so the four pick/place independently.

Layout (a real C-frame gantry, so the head can descend into open space):
    base -> X axis (flat on the base, travel +X)
         -> riser column (up off the X carriage)
         -> Y axis (elevated, travel +Y, carriage cantilevered out over +Y)
         -> Z-mount bracket -> Z axis (hangs DOWN in front of the Y bed, motor up,
            head descends as z grows)
         -> head plate cantilevered into open +Y air -> 4 cylinders (rods down)
         -> 4 nozzles
Each upper group RIDES the carriage below it: the riser + Y axis + everything
above translate with x; the Z bracket + Z axis + head translate with y too; the
head additionally descends with z. z-elevation and a +Y offset keep the upper
gantry and the descending head clear of the lower axes.

7 DOF: x, y, z (axis travels, mm) and e0..e3 (cylinder extensions, mm). pose() is
the single source of truth shared by the static STEP, every check_geometry motion
sweep, and any sidecar.

Coordinate convention
- mm, +Z up, base bottom at z = 0. World origin at the X-stage local origin.
- A stage is built in a LOCAL frame (travel = local +X, rails on the base plane)
  then rotated/translated into the gantry: X = identity, Y = +90 deg about Z
  (travel -> world +Y), Z = +90 deg about Y (travel -> world -Z, motor up).
- Seated pose = every axis at travel 0 and every cylinder retracted (head up).
"""

from __future__ import annotations

import math

from build123d import Axis, Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper, label_shape
from cadpy.parts import (
    ball_screw,
    deep_groove_bearing,
    linear_guide,
    pneumatic_cylinder,
    select_ball_screw,
    select_bearing,
    select_cylinder,
    select_linear_guide,
    select_stepper,
    stepper_motor,
)

# ===========================================================================
# Duty -> selection (reverse-engineer the standard parts; nothing eyeballed)
# ===========================================================================
SCREW_EFF = 0.9        # ball-screw drive efficiency (estimate, for the torque first cut)
RATED_RPM = 3000.0
CARRIAGE_LEN = 60.0    # carriage body length along travel (per axis)

# Per-axis duty. The carried loads are first-cut SIZING inputs (not measured
# masses): X carries Y+Z+head, Y carries Z+head, Z (vertical) holds/raises the head.
_DUTY = {
    "x": dict(payload_N=250.0, stroke=200.0, speed=300.0),
    "y": dict(payload_N=150.0, stroke=150.0, speed=200.0),
    "z": dict(payload_N=120.0, stroke=80.0, speed=150.0),
}


def _select_axis(payload_N: float, stroke: float, speed: float) -> dict:
    """One travel demand -> the four standard parts for a motorized screw axis."""
    screw = select_ball_screw(
        payload_N, travel=stroke, target_speed_mm_s=speed, accuracy="C7", rated_rpm=RATED_RPM
    )
    guide = select_linear_guide(payload_N, rail_len=stroke + CARRIAGE_LEN)
    bearing = select_bearing(shaft_dia=screw["root_dia"], radial_load_N=payload_N / 2.0)
    # Screw thrust -> motor torque: T = F * lead / (2*pi*eff); lead mm -> m.
    torque = payload_N * (screw["lead"] / 1000.0) / (2.0 * math.pi * SCREW_EFF)
    motor = select_stepper(torque_Nm=torque)
    return {
        "screw": screw, "guide": guide, "bearing": bearing, "motor": motor,
        "torque_req": torque, "stroke": stroke,
    }


X_SEL = _select_axis(**_DUTY["x"])
Y_SEL = _select_axis(**_DUTY["y"])
Z_SEL = _select_axis(**_DUTY["z"])

# Four nozzles: each cylinder sized off a light per-nozzle pick/handling load. The
# catalog's smallest cylinder is SC32 (body dia 42); a real micro-nozzle head
# would use a far smaller bore not present in this 4-row table, so the head is
# sized AROUND the SC32 envelope (reported as the catalog floor, not a fit claim).
N_NOZZLES = 4
CYL_STROKE = 25.0
NOZZLE_PITCH = 62.0    # > body dia (42); the gap also clears the central head arm
CYL_SPEC = select_cylinder(30.0, pressure_bar=6.0, stroke_mm=CYL_STROKE, action="push")
CYL_BORE = CYL_SPEC["bore"]
CYL_ROD = CYL_SPEC["rod_dia"]
CYL_BODY = CYL_SPEC["body_dia"]
CYL_BODY_LEN = CYL_STROKE + 0.6 * CYL_BORE   # pneumatic_cylinder's derived body length
CYL_PROT = 4.0                               # rod stick-out beyond the body face at retraction

X_STROKE = X_SEL["stroke"]
Y_STROKE = Y_SEL["stroke"]
Z_STROKE = Z_SEL["stroke"]


# ===========================================================================
# Small build helpers
# ===========================================================================
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _xcyl(r, x0, x1, z, y=0.0):
    """Cylinder of radius r with its axis along +X from x0 to x1, at (y, z)."""
    return Pos((x0 + x1) / 2.0, y, z) * Cylinder(r, x1 - x0).rotate(
        Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)), 90.0
    )


def _rotate_to_x(shape):
    """Rotate a +Z-axis generated part so its axis runs along +X."""
    return shape.rotate(Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)), 90.0)


# ===========================================================================
# Generic motorized screw stage (LOCAL frame: travel = +X, rails on the base)
# ===========================================================================
def _geom(S: dict) -> dict:
    """Resolve every local dimension of a stage from its selection + stroke."""
    sc, g, b, m = S["screw"], S["guide"], S["bearing"], S["motor"]
    stroke = S["stroke"]
    base_t = 12.0
    rail_h = g["rail_height"]
    block_w = g["block_width"]
    nut_dia = sc["nut_dia"]
    brg_od = b["od"]
    brg_w = b["width"]

    rail_x0 = 24.0
    rail_len = stroke + CARRIAGE_LEN
    screw_len = stroke + CARRIAGE_LEN + 56.0
    carriage_x0 = rail_x0
    carriage_cx = carriage_x0 + CARRIAGE_LEN / 2.0

    rail_y = block_w / 2.0 + 8.0
    base_hy = rail_y + block_w / 2.0 + 8.0
    carr_hy = rail_y + 2.0

    block_top_z = base_t + rail_h * 0.3 + g["block_height"]
    z_screw = block_top_z + nut_dia / 2.0 + 6.0
    carriage_top_z = z_screw + nut_dia / 2.0 + 12.0
    pillar_top_z = z_screw + brg_od / 2.0 + 6.0

    return dict(
        stroke=stroke, base_t=base_t,
        rail_w=g["rail_width"], rail_h=rail_h, rail_len=rail_len,
        block_w=block_w, block_h=g["block_height"], block_len=g["block_len"],
        nut_dia=nut_dia, nut_len=sc["nut_len"], screw_dia=sc["screw_dia"], lead=sc["lead"],
        brg_bore=b["bore"], brg_od=brg_od, brg_w=brg_w,
        m_face=m["face"], m_body=m["body_len"], m_shaft_dia=m["shaft_dia"],
        m_shaft_len=m["shaft_len"], m_pilot_dia=m["pilot_dia"], m_pilot_len=m["pilot_len"],
        rail_x0=rail_x0, screw_len=screw_len, carriage_x0=carriage_x0, carriage_cx=carriage_cx,
        rail_y=rail_y, base_hy=base_hy, carr_hy=carr_hy,
        block_top_z=block_top_z, z_screw=z_screw,
        carriage_top_z=carriage_top_z, pillar_top_z=pillar_top_z,
        motor_face_x=-30.0, coupling_x0=-14.0, coupling_x1=6.0, coupling_r=7.0,
        mount_x0=-30.0, mount_x1=-22.0,
        carriage_midz=(block_top_z + carriage_top_z) / 2.0,
    )


_STAGE_MOVING = {"carriage_body", "guide_block_neg", "guide_block_pos", "screw_nut"}


def _build_stage(G: dict) -> dict:
    """Build a stage at its SEATED pose (carriage travel 0) in the local frame.

    Returns {local_name: shape}. Carriage-group parts (see _STAGE_MOVING) are the
    ones pose() shifts along +X by the travel; everything else is fixed."""
    base_t = G["base_t"]
    z_screw = G["z_screw"]
    parts: dict = {}

    parts["base"] = _box(-40.0, G["screw_len"] + 6.0, -G["base_hy"], G["base_hy"], 0.0, base_t)

    def _pillar(x0):
        plate = _box(x0, x0 + G["brg_w"], -G["base_hy"] + 4.0, G["base_hy"] - 4.0,
                     base_t, G["pillar_top_z"])
        bore = _xcyl(G["brg_od"] / 2.0 + 0.3, x0 - 1.0, x0 + G["brg_w"] + 1.0, z_screw)
        return plate - bore

    parts["pillar_neg"] = _pillar(0.0)
    parts["pillar_pos"] = _pillar(G["screw_len"] - G["brg_w"])

    mount = _box(G["mount_x0"], G["mount_x1"], -25.0, 25.0, base_t, z_screw + 24.0)
    mount = mount - _xcyl(G["m_pilot_dia"] / 2.0 + 0.6, G["mount_x0"] - 1.0,
                          G["mount_x1"] + 1.0, z_screw)
    parts["motor_mount"] = mount

    block_pos0 = (G["carriage_cx"] - G["rail_x0"]) - G["block_len"] / 2.0

    def _rail(side):
        gp = linear_guide(
            G["rail_w"], G["rail_h"], G["rail_len"],
            G["block_w"], G["block_h"], G["block_len"], block_pos=block_pos0,
        )
        y = side * G["rail_y"]
        rail = gp.children[0].translate((G["rail_x0"], y, base_t))
        block = gp.children[1].translate((G["rail_x0"], y, base_t))
        return rail, block

    rail_neg, block_neg = _rail(-1)
    rail_pos, block_pos = _rail(1)
    parts["rail_neg"] = rail_neg
    parts["rail_pos"] = rail_pos

    nut_pos0 = G["carriage_cx"] - G["nut_len"] / 2.0
    scr = ball_screw(
        G["screw_dia"], G["lead"], G["screw_len"], G["nut_dia"], G["nut_len"], nut_pos=nut_pos0,
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
    parts["motor"] = _rotate_to_x(motor).translate((G["motor_face_x"], 0.0, z_screw))
    parts["coupling"] = _xcyl(G["coupling_r"], G["coupling_x0"], G["coupling_x1"], z_screw)

    body = _box(
        G["carriage_x0"], G["carriage_x0"] + CARRIAGE_LEN,
        -G["carr_hy"], G["carr_hy"], G["block_top_z"], G["carriage_top_z"],
    )
    tunnel = _xcyl(
        G["nut_dia"] / 2.0 + 1.0, G["carriage_x0"] - 1.0,
        G["carriage_x0"] + CARRIAGE_LEN + 1.0, z_screw,
    )
    parts["carriage_body"] = body - tunnel
    parts["guide_block_neg"] = block_neg
    parts["guide_block_pos"] = block_pos
    return parts


_GX, _GY, _GZ = _geom(X_SEL), _geom(Y_SEL), _geom(Z_SEL)
_X, _Y, _Z = _build_stage(_GX), _build_stage(_GY), _build_stage(_GZ)


# ===========================================================================
# Gantry placement -- each stage's local frame into the world
# ===========================================================================
# Rotation: (axis-direction through origin, degrees).
_ROT_Y = ((0.0, 0.0, 1.0), 90.0)   # Y stage: local +X -> world +Y
_ROT_Z = ((0.0, 1.0, 0.0), 90.0)   # Z stage: local +X -> world -Z (motor up)


def _place(shape, rot, trans):
    s = shape
    if rot is not None:
        axis_dir, ang = rot
        s = s.rotate(Axis((0.0, 0.0, 0.0), axis_dir), ang)
    return s.translate(trans)


def _emit_stage(prefix, cache, rot, trans, u):
    out = []
    for name, shape in cache.items():
        s = shape.translate((u, 0.0, 0.0)) if name in _STAGE_MOVING else shape
        out.append((f"{prefix}_{name}", _place(s, rot, trans)))
    return out


# X carriage top (riser sits here); riser top (Y axis sits here).
_X_TOP = _GX["carriage_top_z"]                 # 69.95
_X_CARR_CX = _GX["carriage_cx"]                # 54
RISER_TOP = 300.0

# Y stage placement (RotZ +90). T_y.y chosen so the carriage cantilevers into +Y.
_Y_SEAT_Y = 60.0
_Y_T0 = (_X_CARR_CX, _Y_SEAT_Y - _GY["carriage_cx"], RISER_TOP)   # (54, 6, 300)
_Y_TOP_Z = RISER_TOP + _GY["carriage_top_z"]                       # Y carriage top z

# Z stage placement (RotY +90): hang the column DOWN in front (+X) of the Y bed so
# its whole footprint (incl. the back plate) clears the Y stage, motor end up.
_Z_COL_X = 140.0                                                   # world x of the Z screw
_Z_T0 = (_Z_COL_X - _GZ["z_screw"], _Y_SEAT_Y, RISER_TOP + 30.0)   # (96, 60, 330)
# Z carriage world references (local (carriage_cx,0,carriage_midz) -> RotY+90 -> world).
_ZC_X = _GZ["carriage_midz"] + _Z_T0[0]
_ZC_Y = _Z_T0[1]
_ZC_BOT = _Z_T0[2] - (_GZ["carriage_x0"] + CARRIAGE_LEN)          # carriage bottom world z

# Head: cantilever into open +Y air, nozzle row along world X centred on the Z carriage.
_HEAD_CANTILEVER = 62.0
_NOZZLE_Y0 = _ZC_Y + _HEAD_CANTILEVER                             # world y of the nozzle row
_HEAD_X0 = _ZC_X - (N_NOZZLES - 1) * NOZZLE_PITCH / 2.0           # world x of nozzle 0
_HEAD_UNDER0 = _ZC_BOT - 16.0                                     # head-plate underside, seated
_HEAD_PLATE_T = 14.0
_HEAD_EMBED = 2.0


# ===========================================================================
# Bespoke connectors (riser, Z-mount bracket) -- rigid, placed per pose
# ===========================================================================
def _riser(x):
    """Tall column off the X carriage up to the Y axis (rides x)."""
    r = _box(_X_CARR_CX - 24.0, _X_CARR_CX + 24.0, -22.0, 22.0, _X_TOP, RISER_TOP)
    return r.translate((x, 0.0, 0.0))


def _z_bracket(x, y):
    """Bracket from the Y carriage out to the Z column back plate / motor mount.

    Reaches x in [Y carriage, just short of the Z motor] at the Z-column top, and
    bolts the column (z_base + motor_mount) to the Y carriage (rides x, y)."""
    b = _box(_X_CARR_CX - 20.0, _Z_COL_X - 24.0, _ZC_Y - 16.0, _ZC_Y + 26.0,
             _Y_TOP_Z - 8.0, _Y_TOP_Z + 12.0)
    return b.translate((x, y, 0.0))


# ===========================================================================
# Head (4 independent pneumatic nozzles)
# ===========================================================================
def _nozzle():
    stem = Pos(0.0, 0.0, -5.0) * Cylinder(4.0, 10.0)     # z in [-10, 0], top at the rod tip
    cup = Pos(0.0, 0.0, -12.0) * Cylinder(8.0, 6.0)      # z in [-15, -9]
    return stem + cup


def _head_parts(x, y, z, e):
    cx0 = _HEAD_X0 + x
    ny = _NOZZLE_Y0 + y
    under = _HEAD_UNDER0 - z          # head descends as z grows
    out = []

    bar_x0 = cx0 - NOZZLE_PITCH * 0.5
    bar_x1 = cx0 + (N_NOZZLES - 1) * NOZZLE_PITCH + NOZZLE_PITCH * 0.5
    out.append(("head_plate", _box(bar_x0, bar_x1, ny - 15.0, ny + 15.0, under, under + _HEAD_PLATE_T)))

    # Arm from the nozzle bar back to the Z carriage FRONT face (+Y of the screw,
    # so it never crosses the screw); narrow enough to sit in the central nozzle gap.
    out.append((
        "head_arm",
        _box(_ZC_X + x - 8.0, _ZC_X + x + 8.0, _ZC_Y + y + 18.0, ny + 8.0, under, _ZC_BOT - z + 6.0),
    ))

    for i in range(N_NOZZLES):
        cxi = cx0 + i * NOZZLE_PITCH
        cyl = pneumatic_cylinder(
            CYL_BORE, CYL_STROKE, extension=e[i], rod_dia=CYL_ROD, body_dia=CYL_BODY,
            rod_protrusion=CYL_PROT, label_prefix=f"cyl{i}",
        )
        body, rod = cyl.children[0], cyl.children[1]   # leaves at built positions
        def _down(s):
            return s.rotate(Axis((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)), 180.0).translate(
                (cxi, ny, under + _HEAD_EMBED)
            )
        tip_z = (under + _HEAD_EMBED) - (CYL_BODY_LEN + CYL_PROT + e[i])
        out.append((f"cyl{i}_body", label_shape(_down(body), f"cyl{i}_body")))
        out.append((f"cyl{i}_rod", label_shape(_down(rod), f"cyl{i}_rod")))
        out.append((f"nozzle{i}", label_shape(_nozzle().translate((cxi, ny, tip_z)), f"nozzle{i}")))
    return out


# ===========================================================================
# Kinematics -- one source of truth
# ===========================================================================
def pose(x=0.0, y=0.0, z=0.0, e=(0.0, 0.0, 0.0, 0.0)):
    """All parts (name, shape) at gantry state (x, y, z mm; e = 4 cylinder mm)."""
    parts = []
    parts += _emit_stage("x", _X, None, (0.0, 0.0, 0.0), x)
    parts.append(("riser", _riser(x)))
    parts += _emit_stage("y", _Y, _ROT_Y, (_Y_T0[0] + x, _Y_T0[1], _Y_T0[2]), y)
    parts.append(("z_bracket", _z_bracket(x, y)))
    parts += _emit_stage("z", _Z, _ROT_Z, (_Z_T0[0] + x, _Z_T0[1] + y, _Z_T0[2]), z)
    parts += _head_parts(x, y, z, e)
    return parts


def _seated():
    return pose()


def _x_poses(samples=12):
    for i in range(samples + 1):
        yield i / samples, pose(x=i / samples * X_STROKE)


def _y_poses(samples=12):
    for i in range(samples + 1):
        yield i / samples, pose(y=i / samples * Y_STROKE)


def _z_poses(samples=12):
    for i in range(samples + 1):
        yield i / samples, pose(z=i / samples * Z_STROKE)


def _cyl_poses(samples=12):
    for i in range(samples + 1):
        ext = i / samples * CYL_STROKE
        yield i / samples, pose(e=(ext, ext, ext, ext))


# ===========================================================================
# Acceptance contract
# ===========================================================================
INTENDED_CONTACT = []
for _ax in ("x", "y", "z"):
    INTENDED_CONTACT += [
        (f"{_ax}_coupling", f"{_ax}_screw_shaft"),
        (f"{_ax}_coupling", f"{_ax}_motor"),
    ]
INTENDED_CONTACT += [
    ("riser", "x_carriage_body"),
    ("z_bracket", "y_carriage_body"),
    ("z_bracket", "z_base"),
    ("z_bracket", "z_motor_mount"),
    ("head_arm", "z_carriage_body"),
    ("head_arm", "head_plate"),
]
for _i in range(N_NOZZLES):
    INTENDED_CONTACT += [
        (f"cyl{_i}_body", f"cyl{_i}_rod"),
        (f"nozzle{_i}", f"cyl{_i}_rod"),
        ("head_plate", f"cyl{_i}_body"),
    ]


def _stage_pairs(prefix):
    return [
        (f"{prefix}_screw_nut", f"{prefix}_screw_shaft"),
        (f"{prefix}_guide_block_neg", f"{prefix}_rail_neg"),
        (f"{prefix}_guide_block_pos", f"{prefix}_rail_pos"),
        (f"{prefix}_carriage_body", f"{prefix}_pillar_pos"),
        (f"{prefix}_carriage_body", f"{prefix}_pillar_neg"),
        (f"{prefix}_carriage_body", f"{prefix}_screw_shaft"),
        (f"{prefix}_screw_nut", f"{prefix}_bearing_pos"),
    ]


_X_PAIRS = _stage_pairs("x") + [("riser", "x_pillar_pos"), ("riser", "x_motor")]
_Y_PAIRS = _stage_pairs("y") + [("z_bracket", "y_pillar_pos"), ("z_bracket", "y_screw_shaft")]
_Z_PAIRS = _stage_pairs("z") + [("head_arm", "z_pillar_pos"), ("head_plate", "z_screw_shaft")]
_CYL_PAIRS = (
    [(f"nozzle{i}", "head_plate") for i in range(N_NOZZLES)]
    + [(f"cyl{i}_rod", "head_arm") for i in range(N_NOZZLES)]
    + [(f"nozzle{i}", f"nozzle{i + 1}") for i in range(N_NOZZLES - 1)]
)


def check_geometry(shape):
    """Acceptance gate: static validity + interference at the seated pose, THEN a
    per-axis whole-travel motion sweep for X, Y, Z and the 4-cylinder down-stroke.
    Every selected+generated part must assemble AND travel penetration-free."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    base = _seated()
    assert_motion_clear(_x_poses(), _X_PAIRS, baseline=base, label="X travel sweep")
    assert_motion_clear(_y_poses(), _Y_PAIRS, baseline=base, label="Y travel sweep")
    assert_motion_clear(_z_poses(), _Z_PAIRS, baseline=base, label="Z travel sweep")
    assert_motion_clear(_cyl_poses(), _CYL_PAIRS, baseline=base, label="nozzle down-stroke sweep")


def gen_step():
    asm = AssemblyHelper("xyz_pickplace_gantry")
    parts = {}
    for name, shape in _seated():
        asm.add(shape, name)
        parts[name] = shape
    asm.linear_frame(parts["x_carriage_body"], "x_axis", Axis((0.0, 0.0, _X_TOP), (1.0, 0.0, 0.0)))
    asm.linear_frame(parts["y_carriage_body"], "y_axis", Axis((0.0, 0.0, _Y_TOP_Z), (0.0, 1.0, 0.0)))
    asm.linear_frame(parts["z_carriage_body"], "z_axis", Axis((_ZC_X, _ZC_Y, _ZC_BOT), (0.0, 0.0, -1.0)))
    asm.linear_frame(parts["nozzle0"], "nozzle0_stroke", Axis((_HEAD_X0, _NOZZLE_Y0, _HEAD_UNDER0), (0.0, 0.0, -1.0)))
    return asm.build()


if __name__ == "__main__":
    from cadpy.geometry_checks import sweep_interference

    def _models(S):
        return (f"{S['screw']['model']}/{S['guide']['model']}/"
                f"{S['bearing']['model']}/{S['motor']['model']}")

    parts = _seated()
    print("parts:", len(parts))
    print("SELECTED  X:", _models(X_SEL), " Y:", _models(Y_SEL), " Z:", _models(Z_SEL),
          " | cyl:", CYL_SPEC["model"], f"x{N_NOZZLES}")
    print("motor margins  X %.2f  Y %.2f  Z %.2f"
          % (X_SEL["motor"]["selected_for"]["margin"], Y_SEL["motor"]["selected_for"]["margin"],
             Z_SEL["motor"]["selected_for"]["margin"]))
    for tag, ps, pr in (("X", _x_poses, _X_PAIRS), ("Y", _y_poses, _Y_PAIRS),
                        ("Z", _z_poses, _Z_PAIRS), ("cyl", _cyl_poses, _CYL_PAIRS)):
        hits = sweep_interference(ps(), pr, baseline=_seated())
        print(f"  {tag} sweep hits beyond baseline:", len(hits))
    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    check_geometry(shape)
    print("geometry + motion-sweep checks: passed")
