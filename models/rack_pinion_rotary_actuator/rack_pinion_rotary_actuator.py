"""Rack-and-pinion rotary actuator: a vertical cylinder drives a vertical rack
that meshes a pinion, swinging a mounted platform from 0 to 90 degrees.

Coordinate convention
- Units: millimeters.
- Origin: base footprint center, base bottom on z = 0.
- +Z: up / cylinder stroke direction.
- Pinion axis: world +Y, passing through (PINION_X, 0, PINION_Z).
- Static pose modeled here = fully retracted, platform horizontal (swing = 0).
  Motion (rack/rod rise, pinion/platform swing) is authored in the
  .rack_pinion_rotary_actuator.step.js sidecar for CAD Viewer.

The pinion pitch radius and the 90 deg swing fix the rack stroke exactly:
    STROKE_90 = PINION_PITCH_R * (pi / 2)   # arc length = R * angle
The sidecar reuses the same relation so rack travel and pinion rotation stay
kinematically consistent rather than eyeballed.
"""

from __future__ import annotations

import math

from build123d import (
    Axis,
    Box,
    Cylinder,
    Location,
    Pos,
    Rot,
)
from cadpy.assembly import AssemblyHelper

# --- Primary parameters ---------------------------------------------------
BASE_LEN_X = 70.0
BASE_WID_Y = 50.0
BASE_T = 8.0
BASE_CENTER_X = -10.0
BASE_HOLE_D = 5.0
BASE_HOLE_INSET = 9.0

CYL_OUTER_R = 15.0
CYL_LEN = 40.0
CYL_BORE_R = 6.0
CYL_X = 0.0
ROD_R = 5.0
ROD_BOTTOM_Z = 14.0

PINION_X = -22.0
PINION_Z = 78.0
PINION_PITCH_R = 12.0
PINION_ROOT_R = 10.0
PINION_TIP_R = 15.0
PINION_WIDTH_Y = 12.0
PINION_TEETH = 14
TOOTH_CIRC_W = 3.5
SHAFT_R = 3.0
SHAFT_Y_BACK = -16.0   # into the support bracket (-Y)
SHAFT_Y_FRONT = 30.0   # out to the platform (+Y)

# Rack: backing bar on +X side of the pitch line, block teeth pointing -X
# toward the pinion, with a small backlash gap so the static pose does not
# show tooth interference.
RACK_BACKLASH = 0.5
RACK_TIP_X = (PINION_X + PINION_TIP_R) - RACK_BACKLASH   # front of rack teeth
RACK_TOOTH_DEPTH = 4.0
RACK_BACK_THICK = 8.0
RACK_WID_Y = 12.0
RACK_BOTTOM_Z = 52.0
RACK_LEN_Z = 60.0
RACK_TEETH_PITCH = 2.0 * math.pi * PINION_PITCH_R / PINION_TEETH

SUPPORT_PLATE_THICK_Y = 8.0
SUPPORT_Y_CENTER = -12.0

PLATFORM_LEN_X = 58.0
PLATFORM_WID_Y = 40.0
PLATFORM_THICK_Z = 6.0
PLATFORM_Y_CENTER = 22.0

# Derived motion constant (documented for the sidecar).
STROKE_90 = PINION_PITCH_R * (math.pi / 2.0)


def make_base():
    plate = Pos(BASE_CENTER_X, 0.0, BASE_T / 2.0) * Box(BASE_LEN_X, BASE_WID_Y, BASE_T)
    hx = BASE_LEN_X / 2.0 - BASE_HOLE_INSET
    hy = BASE_WID_Y / 2.0 - BASE_HOLE_INSET
    for sx in (-1, 1):
        for sy in (-1, 1):
            hole = Pos(BASE_CENTER_X + sx * hx, sy * hy, BASE_T / 2.0) * Cylinder(
                BASE_HOLE_D / 2.0, BASE_T + 2.0
            )
            plate = plate - hole
    return plate


def make_cylinder_body():
    z_center = BASE_T + CYL_LEN / 2.0
    body = Pos(CYL_X, 0.0, z_center) * Cylinder(CYL_OUTER_R, CYL_LEN)
    # Hollow bore from the top, leaving a closed bottom cap.
    bore = Pos(CYL_X, 0.0, z_center + 1.0) * Cylinder(CYL_BORE_R, CYL_LEN - 4.0)
    return body - bore


def make_piston_rod():
    rod_top_z = RACK_BOTTOM_Z
    length = rod_top_z - ROD_BOTTOM_Z
    z_center = (ROD_BOTTOM_Z + rod_top_z) / 2.0
    rod = Pos(CYL_X, 0.0, z_center) * Cylinder(ROD_R, length)
    # Clevis pad where the rod meets the rack.
    pad = Pos(CYL_X, 0.0, rod_top_z - 2.0) * Box(2.0 * ROD_R + 4.0, RACK_WID_Y, 6.0)
    return rod + pad


def make_rack():
    back_min_x = RACK_TIP_X + RACK_TOOTH_DEPTH
    back_center_x = back_min_x + RACK_BACK_THICK / 2.0
    z_center = RACK_BOTTOM_Z + RACK_LEN_Z / 2.0
    rack = Pos(back_center_x, 0.0, z_center) * Box(RACK_BACK_THICK, RACK_WID_Y, RACK_LEN_Z)

    # Block teeth along the -X face, spaced at the meshing circular pitch,
    # covering the pinion height across the full stroke.
    tooth_center_x = RACK_TIP_X + RACK_TOOTH_DEPTH / 2.0
    teeth_z0 = PINION_Z - 22.0
    teeth_z1 = PINION_Z + 28.0
    n = int((teeth_z1 - teeth_z0) / RACK_TEETH_PITCH)
    for i in range(n + 1):
        z = teeth_z0 + i * RACK_TEETH_PITCH
        tooth = Pos(tooth_center_x, 0.0, z) * Box(
            RACK_TOOTH_DEPTH, RACK_WID_Y, TOOTH_CIRC_W
        )
        rack = rack + tooth
    return rack


def make_pinion():
    # Build in a local frame with the gear axis along +Z, then rotate the axis
    # to +Y and translate to the pinion center.
    r_mid = (PINION_ROOT_R + PINION_TIP_R) / 2.0
    tooth_radial = (PINION_TIP_R - PINION_ROOT_R) + 2.0

    gear = Cylinder(PINION_ROOT_R, PINION_WIDTH_Y)
    for i in range(PINION_TEETH):
        a = 360.0 * i / PINION_TEETH
        tooth = Rot(0.0, 0.0, a) * (
            Pos(r_mid, 0.0, 0.0) * Box(tooth_radial, TOOTH_CIRC_W, PINION_WIDTH_Y)
        )
        gear = gear + tooth

    # Output shaft along the local +Z axis (becomes world +Y after rotation).
    shaft_len = SHAFT_Y_FRONT - SHAFT_Y_BACK
    shaft_center_local_z = (SHAFT_Y_BACK + SHAFT_Y_FRONT) / 2.0
    shaft = Pos(0.0, 0.0, shaft_center_local_z) * Cylinder(SHAFT_R, shaft_len)
    gear = gear + shaft

    # Rotate local +Z -> world +Y, then place at the pinion center.
    placed = Location((PINION_X, 0.0, PINION_Z)) * Rot(-90.0, 0.0, 0.0) * gear
    return placed


def make_support_bracket():
    plate_x0 = PINION_X - 9.0
    plate_x1 = PINION_X + 9.0
    plate_len_x = plate_x1 - plate_x0
    plate_center_x = (plate_x0 + plate_x1) / 2.0
    plate_z1 = PINION_Z + 8.0
    plate_len_z = plate_z1 - BASE_T
    plate_center_z = (BASE_T + plate_z1) / 2.0
    plate = Pos(plate_center_x, SUPPORT_Y_CENTER, plate_center_z) * Box(
        plate_len_x, SUPPORT_PLATE_THICK_Y, plate_len_z
    )
    # Clearance hole for the rotating shaft.
    bore = Location((PINION_X, SUPPORT_Y_CENTER, PINION_Z)) * Rot(-90.0, 0.0, 0.0) * Cylinder(
        SHAFT_R + 1.0, SUPPORT_PLATE_THICK_Y + 2.0
    )
    plate = plate - bore
    # Triangular-ish gusset approximated by a stepped foot for stiffness.
    foot = Pos(plate_center_x, SUPPORT_Y_CENTER, BASE_T + 6.0) * Box(
        plate_len_x, SUPPORT_PLATE_THICK_Y + 14.0, 12.0
    )
    return plate + foot


def make_platform():
    # Table extends +X from the pinion axis (the inner short edge sits over the
    # pivot), top face up at the retracted pose.
    table_center_x = PINION_X + PLATFORM_LEN_X / 2.0
    table_center_z = PINION_Z + PLATFORM_THICK_Z / 2.0
    table = Pos(table_center_x, PLATFORM_Y_CENTER, table_center_z) * Box(
        PLATFORM_LEN_X, PLATFORM_WID_Y, PLATFORM_THICK_Z
    )
    # Hub clamping onto the shaft just inboard of the table.
    hub = Pos(PINION_X, PLATFORM_Y_CENTER - PLATFORM_WID_Y / 2.0 + 8.0, PINION_Z + 1.0) * Box(
        14.0, 18.0, 14.0
    )
    hub_bore = Location((PINION_X, PLATFORM_Y_CENTER - PLATFORM_WID_Y / 2.0 + 8.0, PINION_Z)) * Rot(
        -90.0, 0.0, 0.0
    ) * Cylinder(SHAFT_R + 0.2, 20.0)
    hub = hub - hub_bore
    return table + hub


def gen_step():
    asm = AssemblyHelper("rack_pinion_rotary_actuator")
    asm.add(make_base(), "base")
    asm.add(make_support_bracket(), "support_bracket")
    asm.add(make_cylinder_body(), "cylinder_body")
    asm.add(make_piston_rod(), "piston_rod")
    asm.add(make_rack(), "rack")
    asm.add(make_pinion(), "pinion")
    asm.add(make_platform(), "platform")

    # Documented motion datums (source-of-truth for the sidecar kinematics).
    asm.revolute_frame(
        asm.children[-2],  # pinion
        "swing_axis",
        Axis((PINION_X, 0.0, PINION_Z), (0.0, 1.0, 0.0)),
    )
    return asm.build()


if __name__ == "__main__":
    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    print("stroke for 90 deg (mm):", round(STROKE_90, 4))
