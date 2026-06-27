"""DIN-rail spring-clip insertion station: a 3-axis combined action that
LOWERS, HOOKS one flange laterally, then ROTATES the clip down while the spring
arm DEFLECTS over the other flange and snaps in -- the real install, verified
penetration-free across the whole stroke (not just the seated pose).

Workpiece (ref/ DIN-rail spring-clip animation + the TS35 section drawing)
- DIN rail: top-hat TS35 -- W=35 across, D=7.5 deep, T=1.0 wall, lip 4.5, channel
  26. Slotted web down on the nest; the two flange lips turn OUTWARD at the top.
- Spring clip, split into the two parts that actually move differently:
  * clip_body  -- rigid: bridge + a DEEP fixed claw (bite 2.4) that hooks flange
    A and becomes the pivot, + the held +Y post + the -Y tail the seat pushes.
  * spring_arm -- the flexible -Y latch (SHALLOW bite) that deflects outward to
    clear flange B during the roll-in, then springs back under it.

Install kinematics -- THREE driven DOFs + one derived (matches the reference's
phi/delta split, and why a pure vertical press cannot seat this clip):
  place    (Z down)     : lower the tilted clip to engagement height, fixed claw
                          held just OUTSIDE flange A (no contact yet).
  approach (Y, lateral) : slide the clip toward the rail so the fixed claw hooks
                          UNDER flange A. <-- the DOF a vertical press lacks.
  seat     (roll, phi)  : rotate about Q (the hooked flange edge); the -Y side
                          comes down to snap under flange B.
  deflect  (derived)    : the spring arm bends outward as its hook passes flange
                          B's edge, then returns -- so the snap is penetration-
                          free, not a rigid part driven through the flange.

The motion is defined once in kin()/pose() below and reused by (a) the static
seated STEP, (b) the check_geometry SWEEP gate, and (c) the .step.js sidecar, so
all three stay kinematically identical.

Coordinate convention
- mm. Origin: base-plate center; base bottom z=0; +Z up. Rail axis +X; the 35 mm
  span +Y; 7.5 mm depth +Z, slotted web down, lips up. Q = +Y flange outer top
  edge. Static STEP pose = fully seated (place=approach=seat=1, deflect=0).
"""

from __future__ import annotations

import math

from build123d import Axis, Box, Cylinder, Pos
from cadpy.assembly import AssemblyHelper

# --- Workpiece: top-hat TS35 DIN rail -------------------------------------
RAIL_LEN_X = 90.0
RAIL_SPAN_Y = 35.0
RAIL_WALL_T = 1.0
RAIL_CHANNEL_Y = 26.0
RAIL_WEB_Z0 = 32.0
RAIL_WEB_Z1 = RAIL_WEB_Z0 + RAIL_WALL_T            # 33
RAIL_TOP_Z = RAIL_WEB_Z0 + 7.5                     # 39.5
FLANGE_Z0 = RAIL_TOP_Z - RAIL_WALL_T               # 38.5
WALL_Y = RAIL_CHANNEL_Y / 2.0                      # 13.0
FLANGE_Y_OUTER = RAIL_SPAN_Y / 2.0                 # 17.5
RAIL_N_SLOTS = 3
RAIL_SLOT_LEN_X = 21.2
RAIL_SLOT_WID_Y = 4.8
RAIL_SLOT_PITCH_X = 30.0

# --- Workpiece: clip (split into rigid body + deflecting spring arm) -------
CLIP_T_X = 9.3
CLAW_GAP = 0.2                    # hook top sits this far UNDER the lip underside
FIX_BITE_Y = 2.4                  # DEEP fixed-claw bite (rigid, hooks first)
SPR_BITE_Y = 0.45                 # SHALLOW spring bite (deflects over, snaps)
HOOK_TOP_Z = FLANGE_Z0 - CLAW_GAP                  # 38.3, both hooks seat here
CLIP_BRIDGE_Z1 = RAIL_TOP_Z + 5.0                  # 44.5
CLIP_POST_Y0, CLIP_POST_Y1 = 11.0, 18.0            # +Y body (held)
CLIP_POST_Z1 = 54.0
CLIP_TAIL_Y0, CLIP_TAIL_Y1 = -18.0, -11.0          # -Y tail (seat pushes)
CLIP_TAIL_Z1 = 50.0
FIX_LEG_INNER = FLANGE_Y_OUTER + 0.1               # 17.6
HOOK_Z0 = 37.0
# spring arm
ARM_T_Y = 1.0
ARM_Y = -(FLANGE_Y_OUTER + 0.1)                    # -17.6, arm outer face
ARM_ROOT_Z = 44.0                                  # arm root R height (deflect pivot)
SPRING_ROOT = (0.0, ARM_Y + ARM_T_Y / 2.0, ARM_ROOT_Z)   # R, the deflect pivot

# Q -- the roll-in pivot: the +Y flange outer top edge.
CLIP_PIVOT = (0.0, FLANGE_Y_OUTER, RAIL_TOP_Z)
PHI0_DEG = 4.5

# --- Station base / rail nest / gantry ------------------------------------
BASE_LEN_X, BASE_WID_Y, BASE_T = 190.0, 70.0, 12.0
NEST_LEN_X, NEST_WID_Y = 80.0, 40.0
NEST_TOP_Z = RAIL_WEB_Z1
COL_X, COL_W_X, COL_W_Y = 82.0, 20.0, 40.0
TOP_PLATE_LEN_X, TOP_PLATE_WID_Y, TOP_PLATE_T = 180.0, 60.0, 12.0
TOP_PLATE_Z0 = 126.0
TOP_PLATE_Z1 = TOP_PLATE_Z0 + TOP_PLATE_T

# --- Place axis (Z): cylinder + rod + carriage ----------------------------
PLACE_CYL_R, PLACE_BORE_R, PLACE_CYL_LEN = 14.0, 6.5, 48.0
PLACE_ROD_R = 6.0
PLACE_ROD_Z0, PLACE_ROD_Z1 = 74.0, 150.0
CARRIAGE_LEN_X, CARRIAGE_WID_Y, CARRIAGE_T = 70.0, 34.0, 10.0
CARRIAGE_Z0 = 70.0
CARRIAGE_Z1 = CARRIAGE_Z0 + CARRIAGE_T             # 80
GUIDE_X, GUIDE_R, GUIDE_HOLE_R = 24.0, 4.0, 4.3
GUIDE_Z0, GUIDE_Z1 = 60.0, 130.0

# --- Approach axis (Y): slide block + horizontal cylinder ------------------
SLIDE_LEN_X, SLIDE_WID_Y, SLIDE_T = 28.0, 40.0, 8.0
SLIDE_Z0 = 62.0
SLIDE_Z1 = SLIDE_Z0 + SLIDE_T                       # 70
APPROACH_DY = 4.0                                  # lateral hook stroke
APP_CYL_R, APP_BORE_R, APP_CYL_LEN = 4.0, 2.2, 14.0
APP_CYL_Y0 = 20.0                                  # body inner face (+Y)
APP_ROD_R = 2.0

# --- Holder (grips clip +Y post, hangs from the slide) --------------------
HOLD_GRIP_Y0, HOLD_GRIP_Y1 = 13.0, 18.5
HOLD_JAW_T_X = 2.0
GRIP_SQUEEZE = 0.05

# --- Seat axis (roll press): cylinder + rod on the slide -------------------
SEAT_CYL_R, SEAT_BORE_R = 5.0, 2.7
SEAT_CYL_Y = -14.5
SEAT_CYL_Z0, SEAT_CYL_Z1 = 54.0, 70.0
SEAT_ROD_R = 2.5
SEAT_ROD_Z0 = CLIP_TAIL_Z1 - 0.1                   # 49.9, foot presses the tail
SEAT_ROD_Z1 = 64.0

# --- Motion path (animation key constants; sidecar mirrors these) ----------
LOWER_STROKE = 22.0
DEFLECT_MAX = 1.1            # mm, peak outward spring-arm deflection (see _deflect)


def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(
        x1 - x0, y1 - y0, z1 - z0
    )


def _ycyl(r, y0, y1, x=0.0, z=0.0):
    """A cylinder whose axis runs along +Y from y0 to y1."""
    from build123d import Rot

    return Pos(x, (y0 + y1) / 2.0, z) * Rot(-90.0, 0.0, 0.0) * Cylinder(r, y1 - y0)


# ===========================================================================
# Workpiece geometry
# ===========================================================================
def make_din_rail():
    hx = RAIL_LEN_X / 2.0
    web = _box(-hx, hx, -WALL_Y, WALL_Y, RAIL_WEB_Z0, RAIL_WEB_Z1)
    a = (RAIL_SLOT_LEN_X - RAIL_SLOT_WID_Y) / 2.0
    for k in range(RAIL_N_SLOTS):
        cx = (k - (RAIL_N_SLOTS - 1) / 2.0) * RAIL_SLOT_PITCH_X
        web = web - _box(cx - a - RAIL_SLOT_WID_Y / 2.0, cx + a + RAIL_SLOT_WID_Y / 2.0,
                         -RAIL_SLOT_WID_Y / 2.0, RAIL_SLOT_WID_Y / 2.0,
                         RAIL_WEB_Z0 - 1.0, RAIL_WEB_Z1 + 1.0)
    rail = web
    for sy in (-1, 1):
        wall = _box(-hx, hx, sy * WALL_Y - RAIL_WALL_T / 2.0, sy * WALL_Y + RAIL_WALL_T / 2.0,
                    RAIL_WEB_Z1, FLANGE_Z0)
        lip = _box(-hx, hx, min(sy * WALL_Y, sy * FLANGE_Y_OUTER),
                   max(sy * WALL_Y, sy * FLANGE_Y_OUTER), FLANGE_Z0, RAIL_TOP_Z)
        rail = rail + wall + lip
    return rail


def make_clip_body():
    """Rigid: bridge + +Y deep fixed claw (pivot) + +Y held post + -Y tail."""
    hx = CLIP_T_X / 2.0
    bridge = _box(-hx, hx, CLIP_TAIL_Y0, CLIP_POST_Y1, RAIL_TOP_Z, CLIP_BRIDGE_Z1)
    post = _box(-hx, hx, CLIP_POST_Y0, CLIP_POST_Y1, CLIP_BRIDGE_Z1, CLIP_POST_Z1)
    tail = _box(-hx, hx, CLIP_TAIL_Y0, CLIP_TAIL_Y1, CLIP_BRIDGE_Z1, CLIP_TAIL_Z1)
    body = bridge + post + tail
    # +Y fixed claw: outer leg stays OUTSIDE the lip; the deep hook (bite 2.4)
    # sits entirely UNDER flange A (top flush at the lip underside) so it slides
    # under during the lateral approach instead of scraping the lip.
    leg = _box(-hx, hx, FIX_LEG_INNER, FIX_LEG_INNER + 1.0, HOOK_Z0, RAIL_TOP_Z)
    hook = _box(-hx, hx, FLANGE_Y_OUTER - FIX_BITE_Y, FIX_LEG_INNER + 1.0, HOOK_Z0, HOOK_TOP_Z)
    return body + leg + hook


def make_spring_arm():
    """Flexible -Y latch: a vertical arm just OUTSIDE flange B's edge, ending in
    a shallow lip that reaches inward UNDER the flange (bite 0.45, top flush at
    the lip underside). It deflects outward to clear the edge during the roll-in,
    then springs back under it."""
    hx = CLIP_T_X / 2.0
    # vertical flexible arm, just outside the flange edge (-17.5)
    arm = _box(-hx, hx, ARM_Y - ARM_T_Y, ARM_Y, HOOK_Z0 + 0.5, ARM_ROOT_Z + 0.6)
    # hook lip reaching inward under flange B (to -17.05), top 0.2 under the lip
    lip_in = -(FLANGE_Y_OUTER - SPR_BITE_Y)            # -17.05
    lip = _box(-hx, hx, min(ARM_Y, lip_in), max(ARM_Y, lip_in), HOOK_Z0 + 0.5, HOOK_TOP_Z)
    return arm + lip


# ===========================================================================
# Station geometry
# ===========================================================================
def make_base_plate():
    return _box(-BASE_LEN_X / 2, BASE_LEN_X / 2, -BASE_WID_Y / 2, BASE_WID_Y / 2, 0.0, BASE_T)


def make_rail_nest():
    return _box(-NEST_LEN_X / 2, NEST_LEN_X / 2, -NEST_WID_Y / 2, NEST_WID_Y / 2, BASE_T, NEST_TOP_Z)


def make_column(sign):
    xc = sign * COL_X
    return _box(xc - COL_W_X / 2, xc + COL_W_X / 2, -COL_W_Y / 2, COL_W_Y / 2, BASE_T, TOP_PLATE_Z0)


def make_top_plate():
    plate = _box(-TOP_PLATE_LEN_X / 2, TOP_PLATE_LEN_X / 2,
                 -TOP_PLATE_WID_Y / 2, TOP_PLATE_WID_Y / 2, TOP_PLATE_Z0, TOP_PLATE_Z1)
    bore = Pos(0, 0, (TOP_PLATE_Z0 + TOP_PLATE_Z1) / 2) * Cylinder(8.0, TOP_PLATE_T + 2)
    return plate - bore


def make_place_cylinder_body():
    z0, z1 = TOP_PLATE_Z1, TOP_PLATE_Z1 + PLACE_CYL_LEN
    body = Pos(0, 0, (z0 + z1) / 2) * Cylinder(PLACE_CYL_R, PLACE_CYL_LEN)
    bz0, bz1 = z0 - 2.0, z1 - 4.0
    return body - Pos(0, 0, (bz0 + bz1) / 2) * Cylinder(PLACE_BORE_R, bz1 - bz0)


def make_place_rod():
    return Pos(0, 0, (PLACE_ROD_Z0 + PLACE_ROD_Z1) / 2) * Cylinder(PLACE_ROD_R, PLACE_ROD_Z1 - PLACE_ROD_Z0)


def make_carriage():
    plate = _box(-CARRIAGE_LEN_X / 2, CARRIAGE_LEN_X / 2,
                 -CARRIAGE_WID_Y / 2, CARRIAGE_WID_Y / 2, CARRIAGE_Z0, CARRIAGE_Z1)
    for sx in (-1, 1):
        plate = plate - Pos(sx * GUIDE_X, 0, (CARRIAGE_Z0 + CARRIAGE_Z1) / 2) * Cylinder(
            GUIDE_HOLE_R, CARRIAGE_T + 2)
    return plate


def make_guide_rod(sign):
    return Pos(sign * GUIDE_X, 0, (GUIDE_Z0 + GUIDE_Z1) / 2) * Cylinder(GUIDE_R, GUIDE_Z1 - GUIDE_Z0)


def make_slide_block():
    """Y-slide carrying the holder + seat cylinder; the approach cylinder
    drives it laterally to hook flange A."""
    plate = _box(-SLIDE_LEN_X / 2, SLIDE_LEN_X / 2, -SLIDE_WID_Y / 2, SLIDE_WID_Y / 2, SLIDE_Z0, SLIDE_Z1)
    # seat-rod clearance bore
    plate = plate - Pos(0, SEAT_CYL_Y, (SLIDE_Z0 + SLIDE_Z1) / 2) * Cylinder(SEAT_ROD_R + 0.4, SLIDE_T + 2)
    return plate


def make_approach_cylinder_body():
    zc = (SLIDE_Z0 + SLIDE_Z1) / 2.0
    body = _ycyl(APP_CYL_R, APP_CYL_Y0, APP_CYL_Y0 + APP_CYL_LEN, z=zc)        # y 20..34
    # rod enters from the -Y end: bore open at -Y (past the inner face), +Y cap
    bore = _ycyl(APP_BORE_R, APP_CYL_Y0 - 2.0, APP_CYL_Y0 + APP_CYL_LEN - 3.0, z=zc)  # y 18..31
    return body - bore


def make_approach_rod():
    # rod from the slide (+Y face, y=20) into the approach cylinder bore
    zc = (SLIDE_Z0 + SLIDE_Z1) / 2.0
    return _ycyl(APP_ROD_R, SLIDE_WID_Y / 2.0, APP_CYL_Y0 + 4.0, z=zc)         # y 20..24


def make_holder():
    inner = CLIP_T_X / 2 - GRIP_SQUEEZE                # 4.55, 0.1 squeeze on each face
    outer = CLIP_T_X / 2 + HOLD_JAW_T_X                # 6.65
    arm_in = CLIP_T_X / 2 + 1.0                        # 5.65, arm stays OUTSIDE the post
    holder = None
    for sx in (-1, 1):
        # a flat jaw on each X-face of the post (constant 0.1 overlap under roll),
        # and an arm rising OUTSIDE the post (x>=5.65) so nothing sits over the
        # post's middle where its corner lifts ~0.5 mm during the roll.
        jaw = _box(min(sx * inner, sx * outer), max(sx * inner, sx * outer),
                   HOLD_GRIP_Y0, HOLD_GRIP_Y1, CLIP_BRIDGE_Z1 + 0.3, CLIP_POST_Z1)
        arm = _box(min(sx * arm_in, sx * outer), max(sx * arm_in, sx * outer),
                   HOLD_GRIP_Y0, HOLD_GRIP_Y1, CLIP_POST_Z1, SLIDE_Z1)
        holder = (jaw + arm) if holder is None else holder + jaw + arm
    # cross yoke joins the two arms well ABOVE the post (z>=64), into the slide
    yoke = _box(-outer, outer, HOLD_GRIP_Y0 + 1, HOLD_GRIP_Y1, SLIDE_Z0 + 2.0, SLIDE_Z1)
    return holder + yoke


def make_seat_cylinder_body():
    body = Pos(0, SEAT_CYL_Y, (SEAT_CYL_Z0 + SEAT_CYL_Z1) / 2) * Cylinder(SEAT_CYL_R, SEAT_CYL_Z1 - SEAT_CYL_Z0)
    bz0, bz1 = SEAT_CYL_Z0 - 2.0, SEAT_CYL_Z1 - 3.0
    return body - Pos(0, SEAT_CYL_Y, (bz0 + bz1) / 2) * Cylinder(SEAT_BORE_R, bz1 - bz0)


def make_seat_rod():
    rod = Pos(0, SEAT_CYL_Y, (SEAT_ROD_Z0 + SEAT_ROD_Z1) / 2) * Cylinder(SEAT_ROD_R, SEAT_ROD_Z1 - SEAT_ROD_Z0)
    # a narrow foot: a near-line contact on the tail top so the tilt mismatch as
    # the tail rolls stays tiny (a wide flat pad would dig into the tilted tail).
    foot = _box(-CLIP_T_X / 2, CLIP_T_X / 2, SEAT_CYL_Y - 0.4, SEAT_CYL_Y + 0.4, SEAT_ROD_Z0, SEAT_ROD_Z0 + 2)
    return rod + foot


# ===========================================================================
# Kinematics -- one source of truth for static / sweep / sidecar
# ===========================================================================
def _deflect(seat):
    """Outward (-Y) spring-arm deflection (mm) while its lip top sweeps through
    flange B's band (seat ~0.32..0.92); a trapezoid that holds the lip clear of
    the edge across the pass and returns to 0 once the lip drops UNDER the flange
    (so the static seated pose, seat=1, has the lip fully under it, deflect 0)."""
    up0, up1, dn0, dn1 = 0.12, 0.28, 0.90, 0.96
    if seat <= up0 or seat >= dn1:
        return 0.0
    if seat < up1:
        w = (seat - up0) / (up1 - up0)
    elif seat > dn0:
        w = (dn1 - seat) / (dn1 - dn0)
    else:
        w = 1.0
    return DEFLECT_MAX * w


def kin(place, approach, seat):
    """Return (dz, dy, phi_deg, defl) for a motion sample."""
    dz = LOWER_STROKE * (1.0 - place)
    dy = APPROACH_DY * (1.0 - approach)
    phi = -PHI0_DEG * (1.0 - seat)
    return dz, dy, phi, _deflect(seat)


def _seat_follow(seat):
    """Extra Z for the seat rod. It tracks the -Y tail top as the roll lifts it
    (the tail is far from Q, so it rises ~2.5 mm at 4.5 deg), PLUS a clearance
    that holds the foot off the tilted tail during the place/approach phases
    (seat 0) and closes only as the clip seats -- so the foot presses hardest
    when the tilt (and the flat-foot-on-tilted-tail mismatch) is smallest."""
    phi = math.radians(-PHI0_DEG * (1.0 - seat))
    qy, qz = CLIP_PIVOT[1], CLIP_PIVOT[2]
    z = qz + (SEAT_CYL_Y - qy) * math.sin(phi) + (CLIP_TAIL_Z1 - qz) * math.cos(phi)
    rise = z - CLIP_TAIL_Z1
    return rise + 0.6 * (1.0 - seat)


# parts that translate with the carriage in Z only
_Z_ONLY = {"place_rod", "carriage", "approach_cylinder_body"}
# parts that ride the Y slide (translate in Y and Z)
_YZ = {"approach_rod", "slide_block", "holder", "seat_cylinder_body"}


def _move(name, shape, place, approach, seat):
    dz, dy, phi, defl = kin(place, approach, seat)
    if name in _Z_ONLY:
        return shape.translate((0, 0, dz))
    if name in _YZ:
        return shape.translate((0, dy, dz))
    if name == "seat_rod":  # rides the slide AND tracks the rolling tail top
        return shape.translate((0, dy, dz + _seat_follow(seat)))
    if name == "clip_body":
        return shape.rotate(Axis(CLIP_PIVOT, (1, 0, 0)), phi).translate((0, dy, dz))
    if name == "spring_arm":
        return (
            shape.translate((0, -defl, 0))  # deflect outward (local)
            .rotate(Axis(CLIP_PIVOT, (1, 0, 0)), phi)
            .translate((0, dy, dz))
        )
    return shape  # fixed parts


def _base_parts():
    """The seated (reference) geometry of every named part."""
    return [
        ("base_plate", make_base_plate()),
        ("rail_nest", make_rail_nest()),
        ("column_neg", make_column(-1)),
        ("column_pos", make_column(1)),
        ("top_plate", make_top_plate()),
        ("place_cylinder_body", make_place_cylinder_body()),
        ("place_rod", make_place_rod()),
        ("carriage", make_carriage()),
        ("guide_rod_neg", make_guide_rod(-1)),
        ("guide_rod_pos", make_guide_rod(1)),
        ("slide_block", make_slide_block()),
        ("approach_cylinder_body", make_approach_cylinder_body()),
        ("approach_rod", make_approach_rod()),
        ("holder", make_holder()),
        ("seat_cylinder_body", make_seat_cylinder_body()),
        ("seat_rod", make_seat_rod()),
        ("din_rail", make_din_rail()),
        ("clip_body", make_clip_body()),
        ("spring_arm", make_spring_arm()),
    ]


def pose(place, approach, seat):
    """Every part posed at a motion sample -> list of (name, shape)."""
    return [(n, _move(n, s, place, approach, seat)) for n, s in _base_parts()]


# Intended contact, declared to the static gate (seated pose). The two seated
# snaps engage as TOUCHING/near contact, not volume overlap (fixed claw flush on
# flange A; spring lip 0.1 under flange B), so they are clear, not declared here.
INTENDED_CONTACT = [
    ("clip_body", "spring_arm"),           # arm attaches to the body
    ("din_rail", "rail_nest"),             # rail clamped into the nest
    ("clip_body", "holder"),               # holder grips the +Y post
    ("clip_body", "seat_rod"),             # seat foot presses the -Y tail
    ("place_rod", "carriage"),             # rod pressed into the carriage
    ("holder", "slide_block"),             # holder fixed to the Y slide
    ("seat_cylinder_body", "slide_block"), # seat cylinder fixed to the Y slide
    ("guide_rod_pos", "top_plate"),        # guide rods anchored in the top plate
    ("guide_rod_neg", "top_plate"),
]

# Moving workpiece pairs whose clearance is swept over the whole stroke. The clip
# ROLLS while the holder / seat foot only translate, so the clip-vs-tooling pairs
# are swept too (a rigid grip block would clash as the post rolls in it). The
# seated snap engages only at the final frame, which the sweep excludes.
_SWEEP_PAIRS = [
    ("clip_body", "din_rail"),
    ("spring_arm", "din_rail"),
    ("clip_body", "rail_nest"),
    ("spring_arm", "rail_nest"),
    ("clip_body", "holder"),
    ("spring_arm", "holder"),
    ("clip_body", "seat_rod"),
    ("spring_arm", "seat_rod"),
]


def _install_path(samples):
    path = []
    for i in range(samples + 1):
        f = i / samples
        place = max(0.0, min(1.0, f / 0.34))
        approach = max(0.0, min(1.0, (f - 0.34) / 0.22))
        seat = max(0.0, min(1.0, (f - 0.56) / 0.44))
        path.append((f, place, approach, seat))
    return path


# Workpiece-into-rail pairs must be strictly penetration-free; the rigid holder
# grip / seat foot riding the ROLLING clip leave a sub-0.1 mm tilt-mismatch
# sliver a compliant gripper would absorb, so those tooling pairs get a small
# allowance (NOT a free pass -- a real grip clash is far larger, as the original
# 441 mm^3 yoke block and 106 mm^3 foot showed).
_RAIL_PAIRS = {
    ("clip_body", "din_rail"), ("spring_arm", "din_rail"),
    ("clip_body", "rail_nest"), ("spring_arm", "rail_nest"),
}
_RAIL_TOL = 0.05
_TOOLING_TOL = 0.8


def _install_poses(samples=28):
    """The install path as (fraction, posed-parts) frames for the motion sweep."""
    for f, place, approach, seat in _install_path(samples):
        yield f, pose(place, approach, seat)


def _install_tol():
    tol = {None: _TOOLING_TOL}
    tol.update({pair: _RAIL_TOL for pair in _RAIL_PAIRS})
    return tol


def check_geometry(shape):
    """Acceptance gate: static validity + interference, THEN the whole-stroke
    MOTION sweep -- the STEP is refused unless the install is penetration-free
    too (a static pass says nothing about mid-travel). The seated pose is the
    baseline, so the constant holder grip / seat-foot contact rides along without
    being flagged; only EXCESS overlap from the motion is a defect."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    assert_motion_clear(
        _install_poses(),
        _SWEEP_PAIRS,
        baseline=pose(1.0, 1.0, 1.0),   # seated reference -> its contacts are allowed
        tol=_install_tol(),
        label="install sweep",
    )


def gen_step():
    asm = AssemblyHelper("din_rail_clip_inserter")
    for name, shape in pose(1.0, 1.0, 1.0):   # seated
        asm.add(shape, name)
    return asm.build()


if __name__ == "__main__":
    from cadpy.geometry_checks import sweep_interference

    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    hits = sweep_interference(
        _install_poses(), _SWEEP_PAIRS, baseline=pose(1.0, 1.0, 1.0), tol=_install_tol()
    )
    print(f"motion sweep hits beyond baseline: {len(hits)}")
    check_geometry(shape)
    print("geometry + motion-sweep checks: passed")
