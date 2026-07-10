"""Robotic gripper with a 90-degree pneumatic FLIP joint.

A parallel two-finger pneumatic gripper hangs from a pneumatic ROTARY actuator.
Base pose = fingers point straight DOWN (vertical pick). The rotary actuator
swings the whole gripper +90 deg about the horizontal Y axis so the fingers
point FORWARD (+X) for a horizontal pick. Top face is an ISO 9409-1 style tool
flange to the robot wrist.

Coordinate convention
- mm, +Z up. Robot tool interface (flange mating face) at z = 0; the tool hangs
  in -Z. Flip axis is world Y through the actuator body centre.
- Modeled (built) pose: gripper vertical, fingers down, jaws at the OPEN end of
  their stroke. The two jaw DOFs CLOSE the fingers inward along X.

Motion (MOTION contract: linear + revolute)
- jl / jr: the two jaws close along X (each PARAMS['jaw_stroke'] mm inward).
- flip: a real REVOLUTE DOF — the rotary actuator swings the whole gripper from
  0 -> PARAMS['flip_deg'] (default 90) deg about world Y through the actuator
  axis. Declared AFTER the jaw DOFs so ride-along composes as R_flip . T_jaw.
  The built (static) pose stays vertical (0 deg); the flip is animated + swept.

Rotary actuator + parallel pneumatic gripper are simplified schematic envelopes
(not catalog parts); they are outside the 5 cad_source_part families.
"""

import math

from build123d import Axis, Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper

PARAMS = {
    "flange_d": 50.0,      # robot tool flange outer dia (ISO 9409-1 style)
    "flange_t": 8.0,
    "bolt_pcd": 31.5,      # 4x M6 bolt circle
    "bolt_d": 6.6,         # M6 clearance hole
    "rotary_w": 40.0,      # rotary-actuator body: X width
    "rotary_dy": 40.0,     #                       Y depth
    "rotary_h": 46.0,      #                       Z height
    "hub_d": 18.0,         # actuator output hub dia (flip axis, along Y)
    "hub_len": 12.0,       # hub protrusion beyond the +Y body face
    "grip_body_w": 68.0,   # parallel-gripper body: X
    "grip_body_dy": 32.0,  #                        Y
    "grip_body_h": 24.0,   #                        Z
    "jaw_w": 14.0,         # each jaw carriage X width
    "jaw_dy": 24.0,
    "jaw_h": 18.0,
    "grip_open": 34.0,     # finger inner-face separation at the modeled (open) pose
    "jaw_stroke": 8.0,     # per-jaw inward closing travel
    "finger_len": 40.0,
    "finger_t": 8.0,
    "finger_dy": 16.0,
    "flip_deg": 90.0,      # rotary FLIP angle (deg — the only non-mm param)
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


# ---- positioning table (all z-levels derived from PARAMS) -----------------
# One place owns the vertical stack; every builder reads from here so a slider
# change ripples through consistently.
def _levels():
    p = PARAMS
    L = {}
    L["z_fl_top"] = 0.0
    L["z_fl_bot"] = -p["flange_t"]
    L["z_rb_top"] = L["z_fl_bot"]                          # actuator body under flange
    L["z_rb_bot"] = L["z_rb_top"] - p["rotary_h"]
    L["z_axis"] = (L["z_rb_top"] + L["z_rb_bot"]) / 2      # flip axis (world Y)
    L["plate_t"] = 10.0
    # bracket plate sits well below the body so the whole bracket clears the
    # actuator body's rotational envelope (radius ~30.5 mm about the flip axis)
    # throughout the 0->90 deg flip. 12 mm gap => plate top at radius ~35 mm.
    L["z_plate_top"] = L["z_rb_bot"] - 12.0
    L["z_plate_bot"] = L["z_plate_top"] - L["plate_t"]
    L["z_gb_top"] = L["z_plate_bot"]                       # gripper body under plate
    L["z_gb_bot"] = L["z_gb_top"] - p["grip_body_h"]
    L["rail_eng"] = 6.0                                    # jaw rail engagement into body
    L["z_jaw_top"] = L["z_gb_bot"]
    L["z_jaw_bot"] = L["z_jaw_top"] - p["jaw_h"]
    L["z_fing_top"] = L["z_jaw_bot"] + 4.0                 # 4 mm finger->jaw mount overlap
    L["z_fing_bot"] = L["z_jaw_bot"] - p["finger_len"]
    return L


# ---- subsystem builders ---------------------------------------------------
def _flange():
    p, L = PARAMS, _levels()
    fl = _zcyl(p["flange_d"] / 2, L["z_fl_bot"], L["z_fl_top"])
    fl -= _zcyl(4.0, L["z_fl_bot"] - 1, L["z_fl_top"] + 1)          # centre pilot bore
    r = p["bolt_pcd"] / 2
    for a in (45, 135, 225, 315):
        x = r * math.cos(math.radians(a))
        y = r * math.sin(math.radians(a))
        fl -= _zcyl(p["bolt_d"] / 2, L["z_fl_bot"] - 1, L["z_fl_top"] + 1, x, y)
    return fl


def _rotary_body():
    p, L = PARAMS, _levels()
    return _box(-p["rotary_w"] / 2, p["rotary_w"] / 2,
                -p["rotary_dy"] / 2, p["rotary_dy"] / 2, L["z_rb_bot"], L["z_rb_top"])


def _rotary_hub():
    # output shaft along +Y; rooted 6 mm into the body (shaft-through-body fit)
    p, L = PARAMS, _levels()
    yb = p["rotary_dy"] / 2
    return _ycyl(p["hub_d"] / 2, yb - 6.0, yb + p["hub_len"], x=0.0, z=L["z_axis"])


def _swing_bracket():
    p, L = PARAMS, _levels()
    yb = p["rotary_dy"] / 2                                # actuator +Y face
    ha = L["z_axis"]
    # collar around the output hub: 0.5 mm clear of the body, bore clears the hub
    collar = _box(-16, 16, yb + 0.5, yb + p["hub_len"] + 2, ha - 16, ha + 16)
    collar -= _ycyl(p["hub_d"] / 2 + 0.4, yb - 1, yb + p["hub_len"] + 3, x=0.0, z=ha)
    # vertical arm down the +Y side (0.5 mm clear of the body), below the collar
    arm = _box(-16, 16, yb + 0.5, yb + 14, L["z_plate_top"], ha - 16)
    # bottom plate reaching back under the actuator to centre the gripper
    plate = _box(-20, 20, -16, yb + 14, L["z_plate_bot"], L["z_plate_top"])
    return collar + arm + plate


def _gripper_body():
    p, L = PARAMS, _levels()
    return _box(-p["grip_body_w"] / 2, p["grip_body_w"] / 2,
                -p["grip_body_dy"] / 2, p["grip_body_dy"] / 2, L["z_gb_bot"], L["z_gb_top"])


def _jaw(sign):
    # sign -1 = left jaw (inner face at -grip_open/2), +1 = right jaw. Top rail
    # engages up into the gripper body (declared sliding contact).
    p, L = PARAMS, _levels()
    inner = sign * p["grip_open"] / 2
    outer = inner + sign * p["jaw_w"]
    x0, x1 = min(inner, outer), max(inner, outer)
    return _box(x0, x1, -p["jaw_dy"] / 2, p["jaw_dy"] / 2,
                L["z_jaw_bot"], L["z_gb_bot"] + L["rail_eng"])


def _finger(sign):
    p, L = PARAMS, _levels()
    inner = sign * p["grip_open"] / 2
    outer = inner + sign * p["finger_t"]
    x0, x1 = min(inner, outer), max(inner, outer)
    return _box(x0, x1, -p["finger_dy"] / 2, p["finger_dy"] / 2,
                L["z_fing_bot"], L["z_fing_top"])


# ---- acceptance contract --------------------------------------------------
INTENDED_CONTACT = [
    # rigid bolted stacks
    ("rotary_body", "arm_flange"),
    ("gripper_body", "swing_bracket"),
    # flip pivot: output hub through the body / in the bracket collar bore
    ("rotary_hub", "rotary_body"),
    ("swing_bracket", "rotary_hub"),
    # fingers bolted to jaw carriages
    ("finger_left", "jaw_left"),
    ("finger_right", "jaw_right"),
    # jaw rail sliding in the gripper body
    ("jaw_left", "gripper_body"),
    ("jaw_right", "gripper_body"),
]

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "jl", "label": "左爪夾合", "type": "linear", "axis": [1, 0, 0],
         "travel": PARAMS["jaw_stroke"], "moving": ["jaw_left", "finger_left"],
         "pairs": [["jaw_left", "gripper_body"]], "samples": 8},
        {"id": "jr", "label": "右爪夾合", "type": "linear", "axis": [-1, 0, 0],
         "travel": PARAMS["jaw_stroke"], "moving": ["jaw_right", "finger_right"],
         "pairs": [["jaw_right", "gripper_body"]], "samples": 8},
        # 90° 前傾:繞世界 Y 軸(過致動器軸線 z_axis)旋轉整個夾爪。宣告在爪合之後
        # → ride-along 讓翻轉在外層(R_flip · T_jaw)。samples 較密以抓中程最深穿透。
        {"id": "flip", "label": "90° 前傾翻轉", "type": "revolute", "axis": [0, 1, 0],
         "pivot": [0.0, 0.0, _levels()["z_axis"]], "angle_deg": PARAMS["flip_deg"],
         "moving": ["rotary_hub", "swing_bracket", "gripper_body",
                    "jaw_left", "jaw_right", "finger_left", "finger_right"],
         "pairs": [["swing_bracket", "rotary_body"], ["swing_bracket", "arm_flange"],
                   ["gripper_body", "rotary_body"], ["gripper_body", "arm_flange"],
                   ["finger_left", "rotary_body"], ["finger_right", "rotary_body"],
                   ["jaw_left", "rotary_body"], ["jaw_right", "rotary_body"]],
         "samples": 24},
    ],
}


def gen_step():
    L = _levels()
    asm = AssemblyHelper("flip_gripper")
    asm.add(_flange(), "arm_flange")
    asm.add(_rotary_body(), "rotary_body")
    hub = asm.add(_rotary_hub(), "rotary_hub")
    asm.add(_swing_bracket(), "swing_bracket")
    asm.add(_gripper_body(), "gripper_body")
    asm.add(_jaw(-1), "jaw_left")
    asm.add(_jaw(1), "jaw_right")
    asm.add(_finger(-1), "finger_left")
    asm.add(_finger(1), "finger_right")
    # 原生 revolute 關節基準(= URDF revolute 語義:軸 + pivot),嵌入 STEP 拓撲。
    # 翻轉軸為世界 Y、過致動器軸線 z_axis。
    asm.revolute_frame(hub, "flip_axis", Axis((0.0, 0.0, L["z_axis"]), (0.0, 1.0, 0.0)))
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="flip_gripper")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
