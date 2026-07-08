"""Linear pick station: a SELECTED linear guide carries a SELECTED parallel
pneumatic gripper along a rail; the carriage traverses and the gripper opens and
closes. A minimal two-family integration fixture -- the capstone dogfood for the
``gripper`` parts family (mirrors how motorized_linear_stage/xyz_pickplace_gantry
dogfood the screw/guide/bearing/stepper families): neither part is eyeballed, both
come from the catalog reasoning layer (``select_linear_guide`` + ``select_gripper``),
and the whole assembly must pass a motion sweep, not just sit seated.

Coordinate convention
- Units: millimeters.
- Origin: rail start; rail runs along +X on z >= 0, carriage rides at ``tx``.
- The gripper is mounted just above the carriage (a small bracket clearance, so no
  block-on-block interpenetration -- lesson L-5) and rides with it; its fingers
  point +Z and open along +/-X.

Two normalized DOFs drive everything, and pose() is the single source of truth for
the static STEP and both check_geometry sweeps:
- ``tx`` in [0, 1]: carriage traverse, 0 -> TRAVERSE mm along the rail.
- ``op`` in [0, 1]: gripper opening, 0 -> the selected gripper's stroke (each
  finger moves op*stroke/2).
"""

from __future__ import annotations

from cadpy.assembly import AssemblyHelper
from cadpy.parts import gripper, linear_guide, select_gripper, select_linear_guide

# --- Selected parts: SELECTED for the duty, then GENERATED ------------------
# The guide carries the gripper (+ a light workpiece) and provides the traverse;
# the smallest rail whose dynamic rating covers the load is chosen. rail_len is the
# application traverse (not a selection criterion -- any length is cut to order).
GUIDE_LOAD_N = 150.0
RAIL_LEN = 120.0
GUIDE_SPEC = select_linear_guide(GUIDE_LOAD_N, rail_len=RAIL_LEN)

# A parallel gripper sized to hold ~30 N and open at least 5 mm.
GRIP_FORCE_N = 30.0
GRIP_OPENING_MM = 5.0
GRIPPER_SPEC = select_gripper(GRIP_FORCE_N, opening_mm=GRIP_OPENING_MM)

MOUNT_GAP = 0.5  # bracket clearance between the carriage top and the gripper base

# --- Generated geometry (built once at the seated pose) ---------------------
_GUIDE = linear_guide(
    rail_width=GUIDE_SPEC["rail_width"],
    rail_height=GUIDE_SPEC["rail_height"],
    rail_len=RAIL_LEN,
    block_width=GUIDE_SPEC["block_width"],
    block_height=GUIDE_SPEC["block_height"],
    block_len=GUIDE_SPEC["block_len"],
    block_pos=0.0,
    label_prefix="guide",
)
_RAIL = _GUIDE.children[0]    # guide_rail  (static)
_BLOCK0 = _GUIDE.children[1]  # guide_block (at the rail start)

BLOCK_LEN = GUIDE_SPEC["block_len"]
TRAVERSE = RAIL_LEN - BLOCK_LEN                       # carriage travel along the rail
BLOCK_CX0 = BLOCK_LEN / 2.0                           # carriage center X at tx=0
MOUNT_Z = _BLOCK0.bounding_box().max.Z + MOUNT_GAP    # gripper base sits here

G_BORE = GRIPPER_SPEC["bore"]
G_STROKE = GRIPPER_SPEC["stroke"]

_GRIP = gripper(bore=G_BORE, stroke=G_STROKE, opening=0.0, label_prefix="gripper")
# Seat the gripper (built at the origin) above the carriage center at tx=0.
# translate() drops the label, so re-stamp each part.
_GBODY0 = _GRIP.children[0].translate((BLOCK_CX0, 0.0, MOUNT_Z))
_JAW_A0 = _GRIP.children[1].translate((BLOCK_CX0, 0.0, MOUNT_Z))
_JAW_B0 = _GRIP.children[2].translate((BLOCK_CX0, 0.0, MOUNT_Z))
for _s, _lbl in (
    (_GBODY0, "gripper_body"),
    (_JAW_A0, "gripper_jaw_a"),
    (_JAW_B0, "gripper_jaw_b"),
):
    _s.label = _lbl


# The only intended interpenetrations are the two fingers seated in the gripper
# body. The carriage rides the rail with running clearance (no overlap) and the
# gripper is bracket-mounted above the carriage (MOUNT_GAP, no overlap): no
# structural block-on-block contact is allow-listed (lesson L-5).
INTENDED_CONTACT = [
    ("gripper_body", "gripper_jaw_a"),
    ("gripper_body", "gripper_jaw_b"),
]


def _base_parts():
    """Seated (tx=0, op=0) geometry of every named part."""
    return [
        ("guide_rail", _RAIL),
        ("guide_block", _BLOCK0),
        ("gripper_body", _GBODY0),
        ("gripper_jaw_a", _JAW_A0),
        ("gripper_jaw_b", _JAW_B0),
    ]


def pose(tx: float = 0.0, op: float = 0.0):
    """Every part posed at (traverse ``tx``, opening ``op``), both normalized to
    [0, 1] -> list of (name, shape). The carriage and gripper translate +X by the
    traverse; each finger additionally slides +/-X by half the opening."""
    dx = tx * TRAVERSE
    half = op * G_STROKE / 2.0
    out = []
    for name, shape in _base_parts():
        if name == "guide_rail":
            out.append((name, shape))
        elif name in ("guide_block", "gripper_body"):
            out.append((name, shape.translate((dx, 0.0, 0.0))))
        elif name == "gripper_jaw_a":
            out.append((name, shape.translate((dx - half, 0.0, 0.0))))
        else:  # gripper_jaw_b
            out.append((name, shape.translate((dx + half, 0.0, 0.0))))
    return out


# Pairs swept over each motion. Traverse: the carriage rides the rail and the
# gripper must clear the rail the length of the travel. Grip: the two fingers must
# never collide and must clear the carriage as they open.
_TRAVERSE_PAIRS = [
    ("guide_block", "guide_rail"),
    ("gripper_body", "guide_rail"),
    ("gripper_jaw_a", "guide_rail"),
    ("gripper_jaw_b", "guide_rail"),
]
_GRIP_PAIRS = [
    ("gripper_jaw_a", "gripper_jaw_b"),
    ("gripper_jaw_a", "guide_block"),
    ("gripper_jaw_b", "guide_block"),
]


def _traverse_poses(samples: int = 16):
    for i in range(samples + 1):
        s = i / samples
        yield s, pose(s, 0.0)


def _grip_poses(samples: int = 12):
    for i in range(samples + 1):
        o = i / samples
        yield o, pose(1.0, o)  # open the jaws at the far traverse end


def check_geometry(shape):
    """Acceptance gate: static validity + interference (only the two seated
    fingers), THEN a traverse sweep (carriage the length of the rail, jaws closed)
    and a grip sweep (jaws 0 -> stroke at the far end). Each sweep uses its own
    seated pose as the baseline, so the intended body~jaw contacts ride along and
    only EXCESS overlap is a defect. This is the dogfood: a guide and gripper picked
    by the resolver must assemble AND move penetration-free, not just sit."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    assert_motion_clear(
        _traverse_poses(), _TRAVERSE_PAIRS, baseline=pose(0.0, 0.0), label="traverse sweep"
    )
    assert_motion_clear(
        _grip_poses(), _GRIP_PAIRS, baseline=pose(1.0, 0.0), label="grip sweep"
    )


def gen_step():
    asm = AssemblyHelper("linear_pick_station")
    for name, shape in pose(0.0, 0.0):  # seated
        asm.add(shape, name)
    return asm.build()


if __name__ == "__main__":
    from cadpy.geometry_checks import enumerate_interferences, sweep_interference

    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    print("guide:", GUIDE_SPEC["model"], "C", GUIDE_SPEC["C_dynamic_N"],
          "margin %.2f" % GUIDE_SPEC["selected_for"]["margin"])
    print("gripper:", GRIPPER_SPEC["model"], "bore", GRIPPER_SPEC["bore"],
          "stroke", GRIPPER_SPEC["stroke"], "force", GRIPPER_SPEC["gripping_force_N"],
          "margin %.2f" % GRIPPER_SPEC["selected_for"]["margin"])
    print("TRAVERSE", TRAVERSE, "MOUNT_Z %.2f" % MOUNT_Z)
    rep = enumerate_interferences(shape)
    print("seated overlaps:", [(p.a, p.b, round(p.overlap_volume, 2)) for p in rep.overlaps])
    th = sweep_interference(_traverse_poses(), _TRAVERSE_PAIRS, baseline=pose(0.0, 0.0))
    gh = sweep_interference(_grip_poses(), _GRIP_PAIRS, baseline=pose(1.0, 0.0))
    print(f"traverse sweep hits: {len(th)}; grip sweep hits: {len(gh)}")
    check_geometry(shape)
    print("geometry + motion-sweep checks: passed")
