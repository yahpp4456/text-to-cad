"""Motorized linear stage -- the parts-catalog integration capstone.

A single travel demand (stroke / payload / speed) is reverse-engineered into FOUR
standard parts by the cadpy.parts selection layer, each then GENERATED as a
simplified part and assembled into a working stage:

    stepper motor -> coupling -> ball screw (both ends in bearings)
                  -> screw nut fixed to a carriage -> carriage rides two rails

The frame, carriage deck, bearing pillars, coupling and motor mount are bespoke
structural parts (free-form). The functional/purchased parts are NOT eyeballed:
they come from select_ball_screw / select_linear_guide / select_bearing /
select_stepper (provenance recorded in the SPEC dicts below).

One normalized-free DOF -- the carriage position along X (0..STROKE) -- drives the
nut along the screw and the carriage along the rails. kin()/pose() are the single
source of truth shared by the static STEP, the check_geometry motion sweep, and
the .step.js sidecar.

Coordinate convention
- mm. Screw axis = world +X at (y=0, z=Z_SCREW). Base bottom z=0, +Z up.
- Static STEP pose = carriage at the -X travel end (pos = 0).
"""

from __future__ import annotations

import math

from build123d import Axis, Box, Cylinder, Pos, Rot
from cadpy.assembly import AssemblyHelper, label_shape
from cadpy.parts import (
    ball_screw,
    deep_groove_bearing,
    linear_guide,
    select_ball_screw,
    select_bearing,
    select_linear_guide,
    select_stepper,
    stepper_motor,
)

# --- Stage duty -----------------------------------------------------------
STROKE = 150.0
PAYLOAD_N = 200.0
TARGET_SPEED_MM_S = 200.0
CARRIAGE_LEN = 60.0
SCREW_EFF = 0.9  # ball-screw drive efficiency (estimate, for the torque first cut)

# --- Reverse-engineer the four standard parts from the duty ---------------
SCREW_SPEC = select_ball_screw(
    PAYLOAD_N, travel=STROKE, target_speed_mm_s=TARGET_SPEED_MM_S, accuracy="C7"
)
GUIDE_SPEC = select_linear_guide(PAYLOAD_N, rail_len=STROKE + CARRIAGE_LEN)
# Support bearing sized off the screw root (per the plan). NOTE the simplification:
# the only catalog bore >= root_dia (13.2) is the 6204 (bore 20), so the bearing is
# oversized for this screw and the smooth shaft floats in it with clearance -- a
# representative end support, NOT a journalled fit. A real design would turn the
# screw ends down to a journal and pick a bore that matches it (e.g. a bore-12
# bearing); that needs a bearing seed between bores 13.2 and 20, which this 4-row
# table does not carry. Reported as margin, not a press-fit claim.
BEARING_SPEC = select_bearing(shaft_dia=SCREW_SPEC["root_dia"], radial_load_N=PAYLOAD_N / 2.0)
# Screw thrust -> motor torque: T = F * lead / (2*pi*eff); lead mm -> m.
_MOTOR_TORQUE = PAYLOAD_N * (SCREW_SPEC["lead"] / 1000.0) / (2.0 * math.pi * SCREW_EFF)
MOTOR_SPEC = select_stepper(torque_Nm=_MOTOR_TORQUE)

# --- Layout (mm) ----------------------------------------------------------
BASE_T = 10.0
BASE_X0, BASE_X1 = -64.0, 256.0
BASE_Y = 50.0

RAIL_X0 = 20.0
RAIL_LEN = 210.0
RAIL_Y = 35.0                          # rails at y = +/- RAIL_Y
RAIL_W = GUIDE_SPEC["rail_width"]
RAIL_H = GUIDE_SPEC["rail_height"]
BLOCK_W = GUIDE_SPEC["block_width"]
BLOCK_H = GUIDE_SPEC["block_height"]
BLOCK_LEN = GUIDE_SPEC["block_len"]

RAIL_TOP_Z = BASE_T + RAIL_H
BLOCK_TOP_Z = BASE_T + RAIL_H * 0.3 + BLOCK_H   # carriage block straddles the rail
DECK_T = 8.0
DECK_TOP_Z = BLOCK_TOP_Z + DECK_T

SCREW_LEN = 250.0
NUT_DIA = SCREW_SPEC["nut_dia"]
NUT_LEN = SCREW_SPEC["nut_len"]
Z_SCREW = DECK_TOP_Z + NUT_DIA / 2.0            # nut rests on the carriage deck

# Carriage seated at the -X end; nut and blocks centered under the carriage.
CARRIAGE_X0 = 20.0
CARRIAGE_CX = CARRIAGE_X0 + CARRIAGE_LEN / 2.0
NUT_POS0 = CARRIAGE_CX - NUT_LEN / 2.0
BLOCK_POS0 = CARRIAGE_CX - BLOCK_LEN / 2.0

BRG_OD = BEARING_SPEC["od"]
BRG_W = BEARING_SPEC["width"]
PILLAR_NEG_X0 = 0.0
PILLAR_POS_X0 = SCREW_LEN - BRG_W               # 236
PILLAR_T = BRG_W
PILLAR_Y = 28.0
PILLAR_TOP_Z = Z_SCREW + BRG_OD / 2.0 + 5.0

# Motor end (-X): face, mount plate, coupling.
MOTOR_FACE_X = -28.0
MOTOR_BODY_LEN = MOTOR_SPEC["body_len"]
MOTOR_FACE_W = MOTOR_SPEC["face"]
MOUNT_X0, MOUNT_X1 = -28.0, -20.0
COUPLING_X0, COUPLING_X1 = -12.0, 6.0
COUPLING_R = 7.0


# ===========================================================================
# Bespoke structure
# ===========================================================================
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _xcyl(r, x0, x1, z, y=0.0):
    """A cylinder of radius r whose axis runs along +X from x0 to x1, at (y, z)."""
    return Pos((x0 + x1) / 2.0, y, z) * Rot(0.0, 90.0, 0.0) * Cylinder(r, x1 - x0)


def make_base():
    return _box(BASE_X0, BASE_X1, -BASE_Y, BASE_Y, 0.0, BASE_T)


def make_pillar(x0):
    plate = _box(x0, x0 + PILLAR_T, -PILLAR_Y, PILLAR_Y, BASE_T, PILLAR_TOP_Z)
    bore = _xcyl(BRG_OD / 2.0 + 0.3, x0 - 1.0, x0 + PILLAR_T + 1.0, Z_SCREW)
    return plate - bore


def make_motor_mount():
    plate = _box(MOUNT_X0, MOUNT_X1, -25.0, 25.0, BASE_T, Z_SCREW + 22.0)
    bore = _xcyl(
        MOTOR_SPEC["pilot_dia"] / 2.0 + 0.5, MOUNT_X0 - 1.0, MOUNT_X1 + 1.0, Z_SCREW
    )
    return plate - bore


def make_coupling():
    return _xcyl(COUPLING_R, COUPLING_X0, COUPLING_X1, Z_SCREW)


def make_carriage_deck():
    return _box(
        CARRIAGE_X0, CARRIAGE_X0 + CARRIAGE_LEN, -45.0, 45.0, BLOCK_TOP_Z, DECK_TOP_Z
    )


# ===========================================================================
# Generated standard parts (placed at the seated pose)
# ===========================================================================
def _rotate_to_x(shape):
    """Rotate a +Z-axis generated part so its axis runs along +X."""
    return shape.rotate(Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)), 90.0)


def _screw_shaft():
    scr = ball_screw(
        SCREW_SPEC["screw_dia"], SCREW_SPEC["lead"], SCREW_LEN, NUT_DIA, NUT_LEN, nut_pos=0.0
    )
    shaft = scr.children[0].translate((0.0, 0.0, Z_SCREW))
    return label_shape(shaft, "screw_shaft")


def _screw_nut():
    scr = ball_screw(
        SCREW_SPEC["screw_dia"], SCREW_SPEC["lead"], SCREW_LEN, NUT_DIA, NUT_LEN, nut_pos=NUT_POS0
    )
    nut = scr.children[1].translate((0.0, 0.0, Z_SCREW))
    return label_shape(nut, "screw_nut")


def _guide(side):
    g = linear_guide(RAIL_W, RAIL_H, RAIL_LEN, BLOCK_W, BLOCK_H, BLOCK_LEN, block_pos=BLOCK_POS0)
    y = side * RAIL_Y
    rail = g.children[0].translate((RAIL_X0, y, BASE_T))
    block = g.children[1].translate((0.0, y, BASE_T))
    tag = "pos" if side > 0 else "neg"
    return label_shape(rail, f"rail_{tag}"), label_shape(block, f"guide_block_{tag}")


def _bearing(x0, tag):
    b = deep_groove_bearing(BEARING_SPEC["bore"], BRG_OD, BRG_W)
    placed = _rotate_to_x(b).translate((x0, 0.0, Z_SCREW))
    # relabel the two rings uniquely per bearing instance
    placed.children[0].label = f"bearing_{tag}_outer"
    placed.children[1].label = f"bearing_{tag}_inner"
    return label_shape(placed, f"bearing_{tag}")


def _motor():
    m = MOTOR_SPEC
    motor = stepper_motor(
        m["face"], m["body_len"], m["shaft_dia"], m["shaft_len"],
        pilot_dia=m["pilot_dia"], pilot_len=m["pilot_len"],
    )
    placed = _rotate_to_x(motor).translate((MOTOR_FACE_X, 0.0, Z_SCREW))
    placed.children[0].label = "motor_body"
    placed.children[1].label = "motor_shaft"
    return label_shape(placed, "motor")


# ===========================================================================
# Kinematics -- one source of truth
# ===========================================================================
_MOVING = {"carriage_deck", "guide_block_neg", "guide_block_pos", "screw_nut"}


def kin(pos):
    """Carriage travel (mm) for a position fraction in [0, 1]."""
    return pos * STROKE


def _base_parts():
    rail_neg, block_neg = _guide(-1)
    rail_pos, block_pos = _guide(1)
    return [
        ("base", make_base()),
        ("pillar_neg", make_pillar(PILLAR_NEG_X0)),
        ("pillar_pos", make_pillar(PILLAR_POS_X0)),
        ("motor_mount", make_motor_mount()),
        ("rail_neg", rail_neg),
        ("rail_pos", rail_pos),
        ("screw_shaft", _screw_shaft()),
        ("bearing_neg", _bearing(PILLAR_NEG_X0, "neg")),
        ("bearing_pos", _bearing(PILLAR_POS_X0, "pos")),
        ("motor", _motor()),
        ("coupling", make_coupling()),
        ("carriage_deck", make_carriage_deck()),
        ("guide_block_neg", block_neg),
        ("guide_block_pos", block_pos),
        ("screw_nut", _screw_nut()),
    ]


def _move(name, shape, pos):
    if name in _MOVING:
        return shape.translate((kin(pos), 0.0, 0.0))
    return shape


def pose(pos):
    return [(n, _move(n, s, pos)) for n, s in _base_parts()]


# Intended VOLUME overlaps at the seated pose (declared to the static gate): the
# coupling drives the screw end and grips the motor shaft. The other locating
# fits -- bearing OD in its pillar bore, motor pilot in the mount bore, nut on the
# carriage deck -- are slip fits / face contacts (clearance or gap 0, no volume),
# so they are clear and not declared here.
INTENDED_CONTACT = [
    ("coupling", "screw_shaft"),
    ("coupling", "motor"),
]

# Carriage-group vs static-structure pairs swept over the whole stroke.
_SWEEP_PAIRS = [
    ("screw_nut", "screw_shaft"),
    ("guide_block_neg", "rail_neg"),
    ("guide_block_pos", "rail_pos"),
    ("carriage_deck", "screw_shaft"),
    ("carriage_deck", "pillar_pos"),
    ("carriage_deck", "pillar_neg"),
    ("screw_nut", "bearing_pos"),
    ("carriage_deck", "bearing_pos"),
]


def _travel_poses(samples=24):
    for i in range(samples + 1):
        yield i / samples, pose(i / samples)


def check_geometry(shape):
    """Acceptance gate: static validity + interference, THEN the whole-stroke
    motion sweep -- the stage's selected+generated parts must assemble AND travel
    penetration-free. Seated pose is the baseline so steady mounts ride along."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    assert_motion_clear(
        _travel_poses(),
        _SWEEP_PAIRS,
        baseline=pose(0.0),
        label="carriage travel sweep",
    )


def gen_step():
    asm = AssemblyHelper("motorized_linear_stage")
    for name, shape in pose(0.0):
        asm.add(shape, name)
    asm.linear_frame(
        asm.children[-1], "carriage_axis", Axis((0.0, 0.0, Z_SCREW), (1.0, 0.0, 0.0))
    )
    return asm.build()


if __name__ == "__main__":
    from cadpy.geometry_checks import sweep_interference

    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    print("SELECTED:",
          "screw", SCREW_SPEC["model"], "| guide", GUIDE_SPEC["model"],
          "| bearing", BEARING_SPEC["model"], "| motor", MOTOR_SPEC["model"])
    print("motor torque req (Nm): %.3f" % _MOTOR_TORQUE,
          "margin %.2f" % MOTOR_SPEC["selected_for"]["margin"])
    hits = sweep_interference(_travel_poses(), _SWEEP_PAIRS, baseline=pose(0.0))
    print("motion sweep hits beyond baseline:", len(hits))
    check_geometry(shape)
    print("geometry + motion-sweep checks: passed")
