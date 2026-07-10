"""3-DOF rod gripper: vertical pick, then left/right tilt.

A parallel two-finger pneumatic gripper hangs from a pneumatic rotary actuator.
Rest pose = fingers point straight DOWN for a vertical pick of a round/rod
stock. After the jaws close, a single revolute DOF tilts the whole gripper
about the horizontal world-Y axis (through the actuator centre) so the held
rod can lean LEFT or RIGHT (same joint, opposite sense of rotation).

3 DOF
- jl / jr: jaws close inward along ±X (each PARAMS['jaw_stroke'] mm).
- tilt: revolute about world Y through the actuator axis; modeled travel is
  0 → +PARAMS['tilt_deg'] (right-hand sense about +Y). Left tilt is the same
  joint driven the other way (−tilt_deg). Static STEP is baked at 0° (vertical).

Fingers carry a V-groove sized for PARAMS['rod_d'] so the contact is rod-ready
rather than flat-pad. The rotary actuator + gripper body are simplified
schematic envelopes (not catalog parts).

Coordinate convention
- mm, +Z up. Robot tool flange mating face at z = 0; tool hangs in −Z.
- Tilt axis = world Y through the actuator body centre.
"""

from __future__ import annotations

import math

from build123d import Axis, Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper

PARAMS = {
    "flange_d": 50.0,       # robot tool flange OD (ISO 9409-1 style)
    "flange_t": 8.0,
    "bolt_pcd": 31.5,       # 4× M6 bolt circle
    "bolt_d": 6.6,
    "rotary_w": 42.0,       # rotary-actuator body X
    "rotary_dy": 42.0,      #                        Y
    "rotary_h": 48.0,       #                        Z
    "hub_d": 18.0,          # output hub dia (tilt axis along Y)
    "hub_len": 12.0,
    "grip_body_w": 72.0,    # parallel-gripper body X
    "grip_body_dy": 34.0,
    "grip_body_h": 26.0,
    "jaw_w": 14.0,
    "jaw_dy": 26.0,
    "jaw_h": 18.0,
    "grip_open": 30.0,      # inner-face separation at OPEN (modeled) pose
    "jaw_stroke": 8.0,      # per-jaw inward close travel
    "finger_len": 44.0,
    "finger_t": 10.0,
    "finger_dy": 18.0,
    "rod_d": 12.0,          # design rod diameter for the V-groove
    "v_depth": 5.0,         # V-groove depth into each finger
    "tilt_deg": 45.0,       # single-side tilt angle (deg); left = −tilt_deg
}


# ---- small builders -------------------------------------------------------
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _zcyl(r, z0, z1, x=0.0, y=0.0):
    return Pos(x, y, (z0 + z1) / 2) * Cylinder(r, z1 - z0)


def _ycyl(r, y0, y1, x=0.0, z=0.0):
    return Pos(x, (y0 + y1) / 2, z) * Cylinder(r, y1 - y0).rotate(
        Axis((0, 0, 0), (1, 0, 0)), 90
    )


def _levels():
    p = PARAMS
    L = {}
    L["z_fl_top"] = 0.0
    L["z_fl_bot"] = -p["flange_t"]
    L["z_rb_top"] = L["z_fl_bot"]
    L["z_rb_bot"] = L["z_rb_top"] - p["rotary_h"]
    L["z_axis"] = (L["z_rb_top"] + L["z_rb_bot"]) / 2.0
    L["plate_t"] = 10.0
    # Keep the plate outside the rotary body's swept radius for ±tilt_deg.
    L["z_plate_top"] = L["z_rb_bot"] - 14.0
    L["z_plate_bot"] = L["z_plate_top"] - L["plate_t"]
    L["z_gb_top"] = L["z_plate_bot"]
    L["z_gb_bot"] = L["z_gb_top"] - p["grip_body_h"]
    L["rail_eng"] = 6.0
    L["z_jaw_top"] = L["z_gb_bot"]
    L["z_jaw_bot"] = L["z_jaw_top"] - p["jaw_h"]
    L["z_fing_top"] = L["z_jaw_bot"] + 4.0
    L["z_fing_bot"] = L["z_jaw_bot"] - p["finger_len"]
    # V-groove centre height: mid finger working length
    L["z_v"] = (L["z_fing_bot"] + L["z_jaw_bot"]) / 2.0
    return L


# ---- subsystem builders ---------------------------------------------------
def _flange():
    p, L = PARAMS, _levels()
    fl = _zcyl(p["flange_d"] / 2, L["z_fl_bot"], L["z_fl_top"])
    fl -= _zcyl(4.0, L["z_fl_bot"] - 1, L["z_fl_top"] + 1)
    r = p["bolt_pcd"] / 2
    for a in (45, 135, 225, 315):
        x = r * math.cos(math.radians(a))
        y = r * math.sin(math.radians(a))
        fl -= _zcyl(p["bolt_d"] / 2, L["z_fl_bot"] - 1, L["z_fl_top"] + 1, x, y)
    return fl


def _rotary_body():
    p, L = PARAMS, _levels()
    return _box(
        -p["rotary_w"] / 2, p["rotary_w"] / 2,
        -p["rotary_dy"] / 2, p["rotary_dy"] / 2,
        L["z_rb_bot"], L["z_rb_top"],
    )


def _rotary_hub():
    p, L = PARAMS, _levels()
    yb = p["rotary_dy"] / 2
    return _ycyl(p["hub_d"] / 2, yb - 6.0, yb + p["hub_len"], x=0.0, z=L["z_axis"])


def _swing_bracket():
    """+Y-side swing arm + bottom plate. Load path stays on the hub side so
    ±tilt about Y clears the rotary body / flange envelope."""
    p, L = PARAMS, _levels()
    yb = p["rotary_dy"] / 2
    ha = L["z_axis"]
    collar = _box(-16, 16, yb + 0.5, yb + p["hub_len"] + 2, ha - 16, ha + 16)
    collar -= _ycyl(p["hub_d"] / 2 + 0.4, yb - 1, yb + p["hub_len"] + 3, x=0.0, z=ha)
    arm = _box(-16, 16, yb + 0.5, yb + 14, L["z_plate_top"], ha - 16)
    # Plate is short in X so ±tilt does not sweep a wide ring into the body.
    plate = _box(-18, 18, -14, yb + 14, L["z_plate_bot"], L["z_plate_top"])
    return collar + arm + plate


def _gripper_body():
    p, L = PARAMS, _levels()
    return _box(
        -p["grip_body_w"] / 2, p["grip_body_w"] / 2,
        -p["grip_body_dy"] / 2, p["grip_body_dy"] / 2,
        L["z_gb_bot"], L["z_gb_top"],
    )


def _jaw(sign):
    p, L = PARAMS, _levels()
    inner = sign * p["grip_open"] / 2
    outer = inner + sign * p["jaw_w"]
    x0, x1 = min(inner, outer), max(inner, outer)
    return _box(
        x0, x1, -p["jaw_dy"] / 2, p["jaw_dy"] / 2,
        L["z_jaw_bot"], L["z_gb_bot"] + L["rail_eng"],
    )


def _finger(sign):
    """Parallel finger with a 90° V-groove for round rod stock.

    The V opens toward the midplane (towards x=0) and is sized so a rod of
    diameter rod_d seats near the groove throat when the jaws are closed.
    """
    p, L = PARAMS, _levels()
    inner = sign * p["grip_open"] / 2
    outer = inner + sign * p["finger_t"]
    x0, x1 = min(inner, outer), max(inner, outer)
    body = _box(
        x0, x1, -p["finger_dy"] / 2, p["finger_dy"] / 2,
        L["z_fing_bot"], L["z_fing_top"],
    )

    # 90° V cutter: a square prism rotated 45° about Y, pushed into the inner face.
    # Depth along X = v_depth; spans the full finger Y and the working Z band.
    vd = p["v_depth"]
    half = vd * math.sqrt(2.0)  # half-diagonal of the 45° square that gives depth vd
    # Centre the cutter so its tip sits vd into the finger from the inner face.
    tip_x = inner - sign * vd
    cutter = (
        Pos(tip_x + sign * (half / math.sqrt(2.0)), 0.0, L["z_v"])
        * Box(half * 2, p["finger_dy"] + 2.0, half * 2)
    ).rotate(Axis((tip_x, 0.0, L["z_v"]), (0.0, 1.0, 0.0)), 45.0)
    # Only cut the working band (leave top mount pad solid for jaw bolts).
    band = _box(
        min(inner, tip_x) - 1.0, max(inner, tip_x) + 1.0,
        -p["finger_dy"] / 2 - 1.0, p["finger_dy"] / 2 + 1.0,
        L["z_fing_bot"] - 1.0, L["z_jaw_bot"] - 2.0,
    )
    groove = cutter & band
    return body - groove


# ---- acceptance contract --------------------------------------------------
INTENDED_CONTACT = [
    ("rotary_body", "arm_flange"),
    ("gripper_body", "swing_bracket"),
    ("rotary_hub", "rotary_body"),
    ("swing_bracket", "rotary_hub"),
    ("finger_left", "jaw_left"),
    ("finger_right", "jaw_right"),
    ("jaw_left", "gripper_body"),
    ("jaw_right", "gripper_body"),
]

_TILT_MOVING = [
    "rotary_hub", "swing_bracket", "gripper_body",
    "jaw_left", "jaw_right", "finger_left", "finger_right",
]
_TILT_PAIRS = [
    ["swing_bracket", "rotary_body"],
    ["swing_bracket", "arm_flange"],
    ["gripper_body", "rotary_body"],
    ["gripper_body", "arm_flange"],
    ["finger_left", "rotary_body"],
    ["finger_right", "rotary_body"],
    ["jaw_left", "rotary_body"],
    ["jaw_right", "rotary_body"],
    ["finger_left", "arm_flange"],
    ["finger_right", "arm_flange"],
]

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {
            "id": "jl",
            "label": "左爪夾合",
            "type": "linear",
            "axis": [1, 0, 0],
            "travel": PARAMS["jaw_stroke"],
            "moving": ["jaw_left", "finger_left"],
            "pairs": [["jaw_left", "gripper_body"]],
            "samples": 8,
        },
        {
            "id": "jr",
            "label": "右爪夾合",
            "type": "linear",
            "axis": [-1, 0, 0],
            "travel": PARAMS["jaw_stroke"],
            "moving": ["jaw_right", "finger_right"],
            "pairs": [["jaw_right", "gripper_body"]],
            "samples": 8,
        },
        # Declared AFTER jaw DOFs so ride-along composes as R_tilt · T_jaw.
        # +tilt_deg = right-hand rotation about +Y (rod leans toward −X);
        # left lean is the same joint at −tilt_deg.
        {
            "id": "tilt",
            "label": "左右傾（+＝右旋向）",
            "type": "revolute",
            "axis": [0, 1, 0],
            "pivot": [0.0, 0.0, _levels()["z_axis"]],
            "angle_deg": PARAMS["tilt_deg"],
            "moving": _TILT_MOVING,
            "pairs": _TILT_PAIRS,
            "samples": 24,
        },
    ],
}


def gen_step():
    L = _levels()
    asm = AssemblyHelper("rod_tilt_gripper")
    asm.add(_flange(), "arm_flange")
    asm.add(_rotary_body(), "rotary_body")
    hub = asm.add(_rotary_hub(), "rotary_hub")
    asm.add(_swing_bracket(), "swing_bracket")
    asm.add(_gripper_body(), "gripper_body")
    asm.add(_jaw(-1), "jaw_left")
    asm.add(_jaw(1), "jaw_right")
    asm.add(_finger(-1), "finger_left")
    asm.add(_finger(1), "finger_right")
    asm.revolute_frame(
        hub,
        "tilt_axis",
        Axis((0.0, 0.0, L["z_axis"]), (0.0, 1.0, 0.0)),
        angular_range=(-PARAMS["tilt_deg"], PARAMS["tilt_deg"]),
    )
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="rod_tilt_gripper")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    from cadpy.geometry_checks import sweep_interference
    from build123d import Axis as BAxis

    shape = gen_step()
    check_geometry(shape)
    print("static OK; children:", len(shape.children))
    print("PARAMS rod_d=", PARAMS["rod_d"], "tilt_deg=", PARAMS["tilt_deg"])
    print("z_axis=", _levels()["z_axis"])

    # Optional full-travel sweeps (not run by scripts/step — MOTION harness owns that).
    parts = {c.label: c for c in shape.children}

    def _jaw_poses(samples=6):
        for i in range(samples + 1):
            u = i / samples
            dx = u * PARAMS["jaw_stroke"]
            posed = []
            for n, s in parts.items():
                if n in ("jaw_left", "finger_left"):
                    posed.append((n, s.translate((dx, 0, 0))))
                elif n in ("jaw_right", "finger_right"):
                    posed.append((n, s.translate((-dx, 0, 0))))
                else:
                    posed.append((n, s))
            yield u, posed

    def _tilt_poses(samples=12, sense=1.0):
        ang = sense * PARAMS["tilt_deg"]
        pivot = (0.0, 0.0, _levels()["z_axis"])
        axis = BAxis(pivot, (0.0, 1.0, 0.0))
        base = [(n, s) for n, s in parts.items()]
        for i in range(samples + 1):
            u = i / samples
            th = u * ang
            posed = []
            for n, s in base:
                if n in _TILT_MOVING:
                    posed.append((n, s.rotate(axis, th)))
                else:
                    posed.append((n, s))
            yield u, posed

    base = [(n, s) for n, s in parts.items()]
    for tag, gen, pairs in (
        ("jl", _jaw_poses, [("jaw_left", "gripper_body")]),
        ("tilt+", lambda: _tilt_poses(sense=1.0), [tuple(p) for p in _TILT_PAIRS]),
        ("tilt-", lambda: _tilt_poses(sense=-1.0), [tuple(p) for p in _TILT_PAIRS]),
    ):
        hits = sweep_interference(gen(), pairs, baseline=base)
        print(f"  {tag} sweep extra hits:", len(hits))
        if hits:
            print("   ", hits[:3])
