"""Aluminium-extrusion base cabinet for a 4-axis (SCARA) robot-arm workstation.

Reverse-engineered from the 智應科技 (Wisdom Application) concept layout
115WA503: a PCB label/peel station whose lower pedestal is a 40x40 T-slot
aluminium-extrusion CABINET that carries the SCARA arm + CCD frame on top. This
model is just that base (the "底座"): the frame, a top mounting deck (the arm
work surface), an enclosed cabinet (side/back/floor panels + TWO front doors),
plus levelling feet and casters.

Footprint and height come straight off the drawing (all "約"/approximate):
    width  W = 950 mm  (world X)
    depth  D = 980 mm  (world Y)
    work surface (deck top) = 820 mm above the floor

Coordinate convention
- mm, +Z up, floor at z = 0. Origin at the footprint centre on the floor.
- +X = width (right), +Y = depth (toward the BACK).
- The FRONT (operator / door / PCB-feed side) faces -Y, matching the drawing's
  top view (人員供料 at the bottom = front).
- Seated/static pose = both doors CLOSED and the cabinet levelled (feet down on
  the floor, casters lifted ~3 mm), which is the as-installed state.

The two doors are a real DOF: pose(door_deg=...) swings them open about their
outer hinge axes (left door -deg, right door +deg). pose() is the single source
of truth shared by the static STEP, the door-swing motion sweep, and any sidecar.

NOTE on scope: first-pass modelling geometry, not a manufacturability / tolerance
/ load claim. The 40x40 profile, panel thicknesses, hardware envelopes, and the
deck bolt pattern are conventional choices for a base this size, documented as
assumptions rather than verified against a duty.
"""

from __future__ import annotations

import math

from build123d import Axis, Box, Circle, Cylinder, Polygon, Pos, Rectangle, extrude
from cadpy.assembly import AssemblyHelper, label_shape

# ===========================================================================
# Top-level dimensions (mm)
# ===========================================================================
W = 950.0          # footprint width  (X)
D = 980.0          # footprint depth  (Y)
DECK_TOP = 820.0   # arm work surface above the floor

PROF = 40.0        # 40x40 T-slot extrusion
HP = PROF / 2.0    # profile half-width (20)

# Z stack (floor at 0): levelling foot -> posts -> top rails -> deck.
FOOT_PAD_H = 14.0          # levelling-foot pad height
FOOT_STUD_H = 90.0         # foot threaded stud, pad top -> post bottom
POST_Z0 = FOOT_PAD_H + FOOT_STUD_H          # 104: post / frame bottom
DECK_T = 16.0                                # top mounting plate thickness
DECK_Z1 = DECK_TOP                           # 820
DECK_Z0 = DECK_Z1 - DECK_T                   # 804
POST_Z1 = DECK_Z0                            # 804: posts flush with top-rail tops
POST_LEN = POST_Z1 - POST_Z0                 # 700

RAIL_Z = PROF                                # rail cross-section = 40
BOT_RAIL_Z0 = POST_Z0                        # 104
BOT_RAIL_Z1 = BOT_RAIL_Z0 + RAIL_Z           # 144
TOP_RAIL_Z1 = POST_Z1                        # 804
TOP_RAIL_Z0 = TOP_RAIL_Z1 - RAIL_Z           # 764
BOT_RAIL_CZ = (BOT_RAIL_Z0 + BOT_RAIL_Z1) / 2.0   # 124
TOP_RAIL_CZ = (TOP_RAIL_Z0 + TOP_RAIL_Z1) / 2.0   # 784

# Corner post centres: outer faces flush with the W x D envelope.
PX = W / 2.0 - HP   # 455
PY = D / 2.0 - HP   # 470
POST_IN_X = PX - HP   # 435  (post inner face, X)
POST_IN_Y = PY - HP   # 450  (post inner face, Y)

# Horizontal rails butt BETWEEN the posts (end faces touch post inner faces).
RAIL_X_LEN = 2.0 * POST_IN_X   # 870  (front/back rails, span along X)
RAIL_Y_LEN = 2.0 * POST_IN_Y   # 900  (left/right rails, span along Y)

ENV_X = W / 2.0   # 475  outer face in X
ENV_Y = D / 2.0   # 490  outer face in Y

PANEL_T = 5.0          # side / back / door sheet thickness
FLOOR_T = 6.0          # cabinet floor panel thickness
DOOR_GAP = 1.0         # door stands this far in front of the frame face
CENTER_GAP = 8.0       # gap between the two doors at the centre

DOOR_OPEN_MAX = 110.0  # door swing extent for the motion sweep (deg)


# ===========================================================================
# Small build helpers
# ===========================================================================
def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _rot_pts(pts, k):
    """Rotate a list of 2D points by k*90 deg CCW about the origin."""
    for _ in range(k % 4):
        pts = [(-y, x) for (x, y) in pts]
    return pts


def tslot(length: float):
    """A 40x40 T-slot extrusion of the given length, axis along +Z (z in [0,L]).

    Cross-section: a 40x40 square with a central Ø6.8 tap bore and a T-channel
    milled into each of the four faces -- the recognisable aluminium-extrusion
    profile, built once and re-placed for every post and rail."""
    neck_h = 4.1     # half of the ~8.2 mm slot opening
    chan_h = 7.2     # half of the ~14.4 mm internal channel
    face = HP        # 20: outer face
    neck_d = face - 6.0      # 14: slot neck depth
    chan_d = face - 12.0     # 8 : channel floor
    over = 1.0               # overshoot past the face for a clean cut
    # T-channel cutter for the +Y face (opening upward), centred on x = 0.
    cutter = [
        (-neck_h, face + over), (-neck_h, neck_d),
        (-chan_h, neck_d), (-chan_h, chan_d),
        (chan_h, chan_d), (chan_h, neck_d),
        (neck_h, neck_d), (neck_h, face + over),
    ]
    sk = Rectangle(PROF, PROF) - Circle(3.4)
    for k in range(4):
        sk = sk - Polygon(*_rot_pts(cutter, k))
    return extrude(sk, length)


def _to_x(shape):
    """Orient a +Z extrusion so its length runs along +X (x in [0,L])."""
    return shape.rotate(Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0)), 90.0)


def _to_y(shape):
    """Orient a +Z extrusion so its length runs along +Y (y in [0,L])."""
    return shape.rotate(Axis((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)), -90.0)


# ===========================================================================
# Frame: 4 posts + top frame (4 rails) + bottom frame (4 rails)
# ===========================================================================
def _post(px, py):
    return tslot(POST_LEN).translate((px, py, POST_Z0))


def _rail_x(y, cz):
    return _to_x(tslot(RAIL_X_LEN)).translate((-RAIL_X_LEN / 2.0, y, cz))


def _rail_y(x, cz):
    return _to_y(tslot(RAIL_Y_LEN)).translate((x, -RAIL_Y_LEN / 2.0, cz))


def _frame():
    out = [
        ("post_fl", _post(-PX, -PY)), ("post_fr", _post(PX, -PY)),
        ("post_bl", _post(-PX, PY)), ("post_br", _post(PX, PY)),
        ("top_front", _rail_x(-PY, TOP_RAIL_CZ)), ("top_back", _rail_x(PY, TOP_RAIL_CZ)),
        ("top_left", _rail_y(-PX, TOP_RAIL_CZ)), ("top_right", _rail_y(PX, TOP_RAIL_CZ)),
        ("bot_front", _rail_x(-PY, BOT_RAIL_CZ)), ("bot_back", _rail_x(PY, BOT_RAIL_CZ)),
        ("bot_left", _rail_y(-PX, BOT_RAIL_CZ)), ("bot_right", _rail_y(PX, BOT_RAIL_CZ)),
    ]
    return out


# ===========================================================================
# Deck (top mounting plate) + enclosure panels + cabinet floor
# ===========================================================================
def _deck():
    plate = _box(-ENV_X, ENV_X, -ENV_Y, ENV_Y, DECK_Z0, DECK_Z1)
    cz = (DECK_Z0 + DECK_Z1) / 2.0
    plate = plate - (Pos(0.0, 0.0, cz) * Cylinder(60.0, DECK_T + 2.0))   # cable pass-through Ø120
    for sx in (-1.0, 1.0):                                               # 4x M8 arm-mount holes
        for sy in (-1.0, 1.0):
            plate = plate - (Pos(sx * 60.0, sy * 60.0, cz) * Cylinder(4.5, DECK_T + 2.0))
    return plate


def _panels():
    # Side / back sheets sit flush in their frame openings (edges touch the rails
    # and posts); the cabinet floor rests on the bottom frame.
    return [
        ("panel_left", _box(-ENV_X, -ENV_X + PANEL_T, -POST_IN_Y, POST_IN_Y, BOT_RAIL_Z1, TOP_RAIL_Z0)),
        ("panel_right", _box(ENV_X - PANEL_T, ENV_X, -POST_IN_Y, POST_IN_Y, BOT_RAIL_Z1, TOP_RAIL_Z0)),
        ("panel_back", _box(-POST_IN_X, POST_IN_X, ENV_Y - PANEL_T, ENV_Y, BOT_RAIL_Z1, TOP_RAIL_Z0)),
        ("floor_panel", _box(-POST_IN_X, POST_IN_X, -POST_IN_Y, POST_IN_Y, BOT_RAIL_Z1, BOT_RAIL_Z1 + FLOOR_T)),
    ]


# ===========================================================================
# Doors (front, -Y): two overlay panels + hinges + handles
# ===========================================================================
DOOR_Y1 = -ENV_Y - DOOR_GAP            # -491 door inner face (1 mm proud of frame)
DOOR_Y0 = DOOR_Y1 - PANEL_T            # -496 door outer face
DOOR_Z0 = BOT_RAIL_Z1 + 6.0            # 150
DOOR_Z1 = TOP_RAIL_Z0 - 6.0            # 758
DOOR_OUT_X = PX - HP + 35.0            # 470 door outer edge (overlays the post)
DOOR_HINGE_LX = -DOOR_OUT_X            # -470 left hinge axis X
DOOR_HINGE_RX = DOOR_OUT_X             # 470 right hinge axis X
HINGE_AXIS_Y = -ENV_Y                  # -490 frame front face (hinge hardware seat)
# Swing pivot sits 3 mm proud of the frame face (the hinge-knuckle standoff) so an
# overlay door's hinge-side edge never rotates back into its own post past 90 deg.
DOOR_PIVOT_Y = -ENV_Y - 3.0            # -493
HZ = (DOOR_Z0 + 105.0, DOOR_Z1 - 105.0)   # two hinge heights per door

HANDLE_Y0 = DOOR_Y0 - 16.0             # handle stands 16 mm off the door front


def _door_panel(side):
    """Closed door panel. side=-1 left (hinge on -X edge), +1 right (+X edge)."""
    if side < 0:
        return _box(-DOOR_OUT_X, -CENTER_GAP / 2.0, DOOR_Y0, DOOR_Y1, DOOR_Z0, DOOR_Z1)
    return _box(CENTER_GAP / 2.0, DOOR_OUT_X, DOOR_Y0, DOOR_Y1, DOOR_Z0, DOOR_Z1)


def _handle(side):
    """Bar handle near the door's centre edge, back face flush on the door front."""
    cx = side * 40.0
    return _box(cx - 20.0, cx + 20.0, HANDLE_Y0, DOOR_Y0, 430.0, 470.0)


def _hinges():
    out = []
    for tag, hx in (("l", DOOR_HINGE_LX), ("r", DOOR_HINGE_RX)):
        # Hinge bridges the post front (into y=-485) and the door (out to y=-496).
        x0, x1 = (hx - 5.0, hx + 15.0) if tag == "l" else (hx - 15.0, hx + 5.0)
        for i, hz in enumerate(HZ, start=1):
            out.append((f"hinge_{tag}{i}",
                        _box(x0, x1, DOOR_Y0, HINGE_AXIS_Y + 5.0, hz - 25.0, hz + 25.0)))
    return out


def _swing(shape, side, deg):
    """Swing a door part open by `deg` about its outer vertical hinge axis."""
    if deg == 0.0:
        return shape
    hx = DOOR_HINGE_LX if side < 0 else DOOR_HINGE_RX
    ang = -deg if side < 0 else deg     # both doors open outward (-Y)
    return shape.rotate(Axis((hx, DOOR_PIVOT_Y, 0.0), (0.0, 0.0, 1.0)), ang)


# ===========================================================================
# Levelling feet (4 corners) + casters (inboard on the side rails)
# ===========================================================================
def _foot(px, py):
    pad = Pos(px, py, FOOT_PAD_H / 2.0) * Cylinder(22.0, FOOT_PAD_H)         # z 0..14, Ø44
    stud = Pos(px, py, FOOT_PAD_H + FOOT_STUD_H / 2.0) * Cylinder(10.0, FOOT_STUD_H)  # 14..104
    return pad + stud


def _caster(cx, cy):
    # Tucked flush to the footprint edge (outer face at +-ENV_X) under the side rail.
    plate = _box(cx - 30.0, cx + 30.0, cy - 30.0, cy + 30.0, 96.0, POST_Z0)  # top touches rail
    stem = Pos(cx, cy, 68.0) * Cylinder(18.0, 56.0)                          # z 40..96 swivel
    wheel = (Pos(cx, cy, 41.0) * Cylinder(38.0, 30.0)).rotate(              # Ø76 wheel, axis X
        Axis((cx, cy, 41.0), (0.0, 1.0, 0.0)), 90.0)
    return plate + stem + wheel   # wheel bottom at z=3 (lifted while levelled)


# ===========================================================================
# Kinematics -- one source of truth
# ===========================================================================
def pose(door_deg: float = 0.0):
    """All parts (name, shape) with both doors opened by `door_deg` (deg)."""
    parts = []
    parts += _frame()
    parts.append(("deck", _deck()))
    parts += _panels()

    parts.append(("door_left", _swing(_door_panel(-1), -1, door_deg)))
    parts.append(("door_right", _swing(_door_panel(1), 1, door_deg)))
    parts.append(("handle_left", _swing(_handle(-1), -1, door_deg)))
    parts.append(("handle_right", _swing(_handle(1), 1, door_deg)))
    parts += _hinges()

    parts.append(("foot_fl", _foot(-PX, -PY))); parts.append(("foot_fr", _foot(PX, -PY)))
    parts.append(("foot_bl", _foot(-PX, PY))); parts.append(("foot_br", _foot(PX, PY)))
    _cx = ENV_X - 30.0   # 445: caster outer face flush with the footprint edge
    for nm, cx, cy in (("caster_fl", -_cx, -300.0), ("caster_fr", _cx, -300.0),
                       ("caster_bl", -_cx, 300.0), ("caster_br", _cx, 300.0)):
        parts.append((nm, _caster(cx, cy)))
    return parts


def _door_poses(samples=12):
    for i in range(samples + 1):
        yield i / samples, pose(door_deg=i / samples * DOOR_OPEN_MAX)


# ===========================================================================
# Acceptance contract
# ===========================================================================
# Only hinge HARDWARE legitimately interpenetrates the parts it joins (post +
# door); every structural member meets its neighbour face-to-face (butt joint or
# panel-in-opening), so nothing else is whitelisted. (lesson L-5: the allow-list
# is for hardware joining two parts, never for fusing two structural members.)
INTENDED_CONTACT = []
for _tag, _dr, _pst in (("l", "door_left", "post_fl"), ("r", "door_right", "post_fr")):
    for _i in (1, 2):
        INTENDED_CONTACT += [(f"hinge_{_tag}{_i}", _pst), (f"hinge_{_tag}{_i}", _dr)]

# Door-swing sweep: each door must clear the other door, its pivot post, the
# opposite post, the adjacent side panel, and the other door's handle.
DOOR_PAIRS = [
    ("door_left", "door_right"),
    ("door_left", "post_fl"), ("door_right", "post_fr"),
    ("door_left", "post_fr"), ("door_right", "post_fl"),
    ("door_left", "panel_left"), ("door_right", "panel_right"),
    ("door_left", "handle_right"), ("door_right", "handle_left"),
]


def check_geometry(shape):
    """Acceptance gate: static B-rep validity + interference at the closed pose,
    then a 0 -> 110 deg door-swing sweep proving both doors open without clashing."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    assert_motion_clear(_door_poses(), DOOR_PAIRS, baseline=pose(0.0),
                        label="door swing 0->110deg")


def gen_step():
    asm = AssemblyHelper("scara_arm_base")
    parts = {}
    for name, shape in pose(0.0):
        asm.add(shape, name)
        parts[name] = shape
    asm.revolute_frame(parts["door_left"], "door_left_hinge",
                       Axis((DOOR_HINGE_LX, DOOR_PIVOT_Y, 0.0), (0.0, 0.0, 1.0)))
    asm.revolute_frame(parts["door_right"], "door_right_hinge",
                       Axis((DOOR_HINGE_RX, DOOR_PIVOT_Y, 0.0), (0.0, 0.0, 1.0)))
    return asm.build()


if __name__ == "__main__":
    parts = pose(0.0)
    print("parts:", len(parts))
    names = [n for n, _ in parts]
    assert len(names) == len(set(names)), "duplicate part names"
    print("footprint  W=%.0f D=%.0f  deck_top=%.0f" % (W, D, DECK_TOP))
    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    check_geometry(shape)
    print("geometry + door-swing checks: passed")
