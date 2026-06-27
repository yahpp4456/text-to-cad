"""Rack-and-pinion rotary actuator: a vertical cylinder drives a vertical rack
that meshes a pinion, swinging a mounted platform from 0 to 90 degrees.

The driving cylinder is no longer a hand-written box: it is SELECTED for the
duty (``select_cylinder``) and GENERATED as a simplified standard part
(``cadpy.parts.pneumatic_cylinder``), so its bore/rod/body come from the catalog
reasoning layer, not from eyeballed numbers. The selection provenance
(model/source/confidence/margin) is recorded in CYL_SPEC below.

Coordinate convention
- Units: millimeters.
- Origin: base footprint center, base bottom on z = 0.
- +Z: up / cylinder stroke direction.
- Pinion axis: world +Y, passing through (PINION_X, 0, PINION_Z).
- Static pose modeled here = fully retracted, platform horizontal (swing = 0).

One normalized DOF (swing in [0, 1]) drives everything; kin()/pose() are the
single source of truth reused by the static STEP, the check_geometry motion
sweep, and the .rack_pinion_rotary_actuator.step.js sidecar, so all three stay
kinematically identical.

The pinion pitch radius and the 90 deg swing fix the rack stroke exactly:
    STROKE_90 = PINION_PITCH_R * (pi / 2)   # arc length = R * angle
which is the rod travel the cylinder must deliver (req_stroke).
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
from cadpy.parts import pneumatic_cylinder, select_cylinder

# --- Primary parameters ---------------------------------------------------
BASE_LEN_X = 70.0
BASE_WID_Y = 50.0
BASE_T = 8.0
BASE_CENTER_X = -10.0
BASE_HOLE_D = 5.0
BASE_HOLE_INSET = 9.0

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

# Derived motion constant: the rod travel that yields a 90 deg swing.
STROKE_90 = PINION_PITCH_R * (math.pi / 2.0)

# --- Driving cylinder: SELECTED for the duty, then GENERATED ---------------
# A modest tabletop platform load; the smallest standard bore that delivers it
# at 6 bar with the required stroke is chosen. req_stroke is the actual rod
# travel (STROKE_90), NOT the series' stroke_max -- the generated part is cut to
# the application stroke so the rod cannot over-travel during the sweep.
CYL_LOAD_N = 150.0
CYL_PRESSURE_BAR = 6.0
REQ_STROKE = STROKE_90
CYL_SPEC = select_cylinder(
    load_N=CYL_LOAD_N, pressure_bar=CYL_PRESSURE_BAR, stroke_mm=REQ_STROKE
)
# Cylinder is mounted upright on the base, offset +X so its (selected) body
# diameter clears the pinion support bracket; the rod drives the rack from below.
CYL_X = 9.0
CYL_BASE_Z = BASE_T


def _placed_cylinder():
    """Generated cylinder at FULL extension, placed at the mount.

    Returns (body, rod) where body is static and rod is the rigid piston at its
    topmost (fully extended) position; pose() slides the rod back down by the
    retracted amount. Built fully extended so the rigid rod is long enough to stay
    engaged in the barrel across the whole stroke.
    """
    cyl = pneumatic_cylinder(
        bore=CYL_SPEC["bore"],
        stroke=REQ_STROKE,
        extension=REQ_STROKE,
        rod_dia=CYL_SPEC["rod_dia"],
        body_dia=CYL_SPEC["body_dia"],
    )
    body = cyl.children[0].translate((CYL_X, 0.0, CYL_BASE_Z))
    rod = cyl.children[1].translate((CYL_X, 0.0, CYL_BASE_Z))
    body.label = "cylinder_body"
    rod.label = "piston_rod"
    return body, rod


_CYL_BODY, _CYL_ROD_EXTENDED = _placed_cylinder()
# Rod top at full extension == rack bottom at full swing; subtract the stroke to
# get the seated rack bottom (where the retracted rod top sits).
BODY_TOP_Z = _CYL_BODY.bounding_box().max.Z
RACK_BOTTOM_Z = BODY_TOP_Z  # seated: rack rests on the retracted rod top

# Rack: backing bar on +X side of the pitch line, block teeth pointing -X toward
# the pinion. RACK_BACKLASH only pulls the tooth tips back a touch; it does NOT
# open a static clearance -- the BLOCK teeth still interpenetrate ~34 mm^3 at the
# seated pose (and 34-41 mm^3 across the whole swing, ~1/4 of one tooth). That is
# a block-tooth artifact of the approximation, not real involute contact; it is a
# genuine gear mesh, so it is allow-listed as INTENDED_CONTACT and ridden along by
# the seated motion-sweep baseline. The mesh is not interference-free; it is
# declared intended. (Real involute teeth would roll without this overlap.)
RACK_BACKLASH = 0.5
RACK_TIP_X = (PINION_X + PINION_TIP_R) - RACK_BACKLASH   # front of rack teeth
RACK_TOOTH_DEPTH = 4.0
RACK_BACK_THICK = 8.0
RACK_WID_Y = 12.0
# Rack sits on the -Y side of the pinion (which spans y in [-6, 6]); the driven
# platform is mounted on the +Y side. Offsetting the rack -Y keeps it meshing the
# pinion (overlap y in [-6, 0]) while fully clearing the rotating platform, so the
# swing sweep has no rack~platform clash.
RACK_Y_CENTER = -6.0
RACK_LEN_Z = 60.0
RACK_TEETH_PITCH = 2.0 * math.pi * PINION_PITCH_R / PINION_TEETH

SUPPORT_PLATE_THICK_Y = 8.0
SUPPORT_Y_CENTER = -12.0

PLATFORM_LEN_X = 58.0
PLATFORM_WID_Y = 40.0
PLATFORM_THICK_Z = 6.0
PLATFORM_Y_CENTER = 22.0


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


def make_rack():
    back_min_x = RACK_TIP_X + RACK_TOOTH_DEPTH
    back_center_x = back_min_x + RACK_BACK_THICK / 2.0
    z_center = RACK_BOTTOM_Z + RACK_LEN_Z / 2.0
    rack = Pos(back_center_x, RACK_Y_CENTER, z_center) * Box(
        RACK_BACK_THICK, RACK_WID_Y, RACK_LEN_Z
    )

    # Block teeth along the -X face, spaced at the meshing circular pitch,
    # covering the pinion height across the full stroke.
    tooth_center_x = RACK_TIP_X + RACK_TOOTH_DEPTH / 2.0
    teeth_z0 = PINION_Z - 22.0
    teeth_z1 = PINION_Z + 28.0
    n = int((teeth_z1 - teeth_z0) / RACK_TEETH_PITCH)
    for i in range(n + 1):
        z = teeth_z0 + i * RACK_TEETH_PITCH
        tooth = Pos(tooth_center_x, RACK_Y_CENTER, z) * Box(
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


# ===========================================================================
# Kinematics -- one source of truth for static / sweep / sidecar
# ===========================================================================
SWING_AXIS = Axis((PINION_X, 0.0, PINION_Z), (0.0, 1.0, 0.0))


def kin(swing):
    """Return (travel_mm, angle_deg) for a normalized swing in [0, 1]."""
    travel = swing * STROKE_90
    angle = -swing * 90.0
    return travel, angle


def _base_parts():
    """Seated (swing=0) geometry of every named part."""
    return [
        ("base", make_base()),
        ("support_bracket", make_support_bracket()),
        ("cylinder_body", _CYL_BODY),
        ("piston_rod", _CYL_ROD_EXTENDED),
        ("rack", make_rack()),
        ("pinion", make_pinion()),
        ("platform", make_platform()),
    ]


def _move(name, shape, swing):
    travel, angle = kin(swing)
    if name == "rack":
        return shape.translate((0.0, 0.0, travel))
    if name == "piston_rod":
        # rod is built fully extended; slide it down by the not-yet-extended amount
        return shape.translate((0.0, 0.0, travel - STROKE_90))
    if name in ("pinion", "platform"):
        return shape.rotate(SWING_AXIS, angle)
    return shape  # base, support_bracket, cylinder_body are static


def pose(swing):
    """Every part posed at a swing sample -> list of (name, shape)."""
    return [(n, _move(n, s, swing)) for n, s in _base_parts()]


# Intended contact at the seated pose (declared to the static gate): the rod
# rides in the barrel bore (volume overlap), the rod pushes the rack (a coincident
# face contact -- a compression drive, not interpenetration), the rack meshes the
# pinion, and the platform hub rides the pinion shaft. (rack~platform is NOT a
# contact: the rack runs on the -Y side, the platform on +Y.)
INTENDED_CONTACT = [
    ("cylinder_body", "piston_rod"),
    ("piston_rod", "rack"),
    ("rack", "pinion"),
    ("pinion", "platform"),
]

# Pairs whose clearance is swept over the whole stroke. The rack/pinion mesh is
# the real dogfood: the SELECTED cylinder's rod drives the rack through a rolling
# gear mesh, which must stay penetration-free beyond the seated backlash.
_SWEEP_PAIRS = [
    ("rack", "pinion"),
    ("rack", "platform"),
    ("rack", "support_bracket"),
    ("piston_rod", "cylinder_body"),
    ("piston_rod", "rack"),
]

# The block-tooth mesh is a geometric approximation of an involute gear: its
# block corners dig a few mm^3 past the seated engagement near the pitch point as
# they roll (true involute teeth would not). A dense sweep caps that sliver at
# ~6.2 mm^3, so the mesh pair gets a small allowance (analogous to the DIN-rail
# station's tooling tolerance); every other pair stays strict.
_MESH_TOL = 8.0
_SWEEP_TOL = {None: 0.05, ("rack", "pinion"): _MESH_TOL}


def _swing_poses(samples=24):
    for i in range(samples + 1):
        s = i / samples
        yield s, pose(s)


def check_geometry(shape):
    """Acceptance gate: static validity + interference, THEN the whole-stroke
    motion sweep. The seated pose is the baseline, so the rod-in-bore and gear
    backlash contacts ride along; only EXCESS overlap from the swing is a defect.
    This is the dogfood: a cylinder picked by select_cylinder must drive the real
    mechanism penetration-free, not just sit in it."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
    assert_motion_clear(
        _swing_poses(),
        _SWEEP_PAIRS,
        baseline=pose(0.0),  # seated reference -> its contacts are allowed
        tol=_SWEEP_TOL,
        label="swing sweep",
    )


def gen_step():
    asm = AssemblyHelper("rack_pinion_rotary_actuator")
    for name, shape in pose(0.0):  # seated
        asm.add(shape, name)

    # Documented motion datum (source-of-truth for the sidecar kinematics).
    asm.revolute_frame(asm.children[-2], "swing_axis", SWING_AXIS)
    return asm.build()


if __name__ == "__main__":
    from cadpy.geometry_checks import sweep_interference

    shape = gen_step()
    print("built:", shape.label, "children:", len(shape.children))
    print("cylinder:", CYL_SPEC["model"],
          "bore", CYL_SPEC["bore"], "rod", CYL_SPEC["rod_dia"],
          "margin %.2f" % CYL_SPEC["selected_for"]["margin"],
          "source/conf:", CYL_SPEC["source"][:30], CYL_SPEC["confidence"])
    print("stroke for 90 deg (mm):", round(STROKE_90, 4))
    hits = sweep_interference(_swing_poses(), _SWEEP_PAIRS, baseline=pose(0.0))
    print(f"motion sweep hits beyond baseline: {len(hits)}")
    for h in hits[:6]:
        print("  hit:", h.a, h.b, "excess %.2f" % h.excess, "@ swing", h.where)
    check_geometry(shape)
    print("geometry + motion-sweep checks: passed")
