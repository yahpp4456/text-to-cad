"""Sheet-metal L bracket carrying a catalog-selected NEMA stepper.

The dogfood fixture for "sheet metal + standard parts in one assembly":
- the bracket is a one-bend ``SheetMetal`` fold tree (base foot + vertical
  wall) with a NEMA pilot clearance hole and four screw clearance holes;
- the motor is SELECTED (``select_stepper``) then generated
  (``stepper_motor``), never hand-sized; mounted on the wall's OUTER face,
  shaft pointing back through the pilot hole (clearance, no contact);
- four M3 screws pass the wall clearance holes (clearance fit -> NO overlap
  with the bracket) and thread INTO the motor body: those four penetrations
  plus the motor's embedded shaft root are the only intended contacts.

Static mount -> no MOTION. ``gen_dxf()`` is the BRACKET flat pattern only
(the motor/screws are purchased parts). No ``folded`` param: flattening an
assembly is meaningless -- the DXF carries the unfold.
"""

from build123d import *  # noqa: F401,F403  (repo generator convention)
from cadpy.assembly import AssemblyHelper
from cadpy.parts import SheetMetal, select_stepper, stepper_motor

# ===========================================================================
# Adjustable design parameters (single-level; sliders re-run this file)
# ===========================================================================
PARAMS = {
    "base_w": 70.0,     # foot plate (X, toward the wall)
    "base_d": 70.0,     # foot plate (Y, along the bend)
    "wall_h": 70.0,     # OUTER wall height (length= semantics)
    "thick": 2.0,       # sheet thickness
    "bend_r": 2.0,      # inner bend radius
    "k_factor": 0.44,
    "torque_Nm": 0.3,   # motor sizing requirement -> select_stepper
    "motor_up": 40.0,   # motor axis height above the base plane (wall local x)
    "screw_d": 3.0,     # mounting screws (M3 rod, no head modeled)
    "foot_hole_d": 6.0, # 2x base mounting holes
}

# NEMA ICS 16 square mounting-hole spacing per frame size (mm)
_NEMA_SCREW_SQUARE = {8: 16.0, 11: 23.0, 14: 26.0, 17: 31.0, 23: 47.14, 34: 69.6}

MOTOR_SPEC = select_stepper(PARAMS["torque_Nm"])

# only pairs with REAL positive-volume overlap: screw threads seated in the
# motor body + the motor's own embedded shaft root. Screw x bracket is a
# CLEARANCE fit (hole d = screw + 0.6) and motor face x wall is planar touch:
# zero volume, deliberately NOT declared.
INTENDED_CONTACT = [
    ("motor_body", "motor_shaft"),
    ("screw_0", "motor_body"),
    ("screw_1", "motor_body"),
    ("screw_2", "motor_body"),
    ("screw_3", "motor_body"),
]


def _check_params():
    p = PARAMS
    face = MOTOR_SPEC["face"]
    sq = _NEMA_SCREW_SQUARE.get(MOTOR_SPEC["nema"], 0.73 * face)
    web = p["wall_h"] - (p["bend_r"] + p["thick"])
    lim = 2.0 * p["thick"] + p["bend_r"]
    if p["motor_up"] - sq / 2.0 - p["screw_d"] < lim:
        raise ValueError(
            f"motor_up({p['motor_up']:g})太低:最下排馬達螺孔距折彎僅 "
            f"{p['motor_up'] - sq / 2.0:g} mm,低於 {lim:g}(2×板厚+內半徑)。"
            f"請抬高 motor_up 或加大 wall_h")
    if p["motor_up"] + sq / 2.0 + p["screw_d"] > web:
        raise ValueError(
            f"wall_h({p['wall_h']:g})不足:最上排馬達螺孔超出牆腹板 {web:g} mm,"
            f"請加高 wall_h 或降低 motor_up")
    if p["base_d"] < face + 2.0 * p["thick"]:
        raise ValueError(
            f"base_d({p['base_d']:g})窄於馬達面寬 {face:g}+2×板厚,馬達掛不下")


def _bracket() -> SheetMetal:
    p = PARAMS
    _check_params()
    face = MOTOR_SPEC["face"]
    sq = _NEMA_SCREW_SQUARE.get(MOTOR_SPEC["nema"], 0.73 * face)
    sm = SheetMetal(thickness=p["thick"], bend_radius=p["bend_r"],
                    k_factor=p["k_factor"], label="bracket")
    base = sm.base_rect(p["base_w"], p["base_d"])
    wall = base.flange("x+", length=p["wall_h"], label="wall")
    # motor interface on the wall (wall local: x above the bend, y along it)
    mx, my = p["motor_up"], p["base_d"] / 2.0
    wall.hole(mx, my, d=MOTOR_SPEC["pilot_dia"] + 1.0)   # pilot clearance
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            wall.hole(mx + sx * sq / 2.0, my + sy * sq / 2.0,
                      d=p["screw_d"] + 0.6)              # screw clearance
    base.hole(p["base_w"] * 0.3, p["base_d"] * 0.25, d=p["foot_hole_d"])
    base.hole(p["base_w"] * 0.3, p["base_d"] * 0.75, d=p["foot_hole_d"])
    return sm


def gen_step():
    from build123d import Cylinder, Pos, Rot

    p = PARAMS
    face_x = p["base_w"] + p["bend_r"] + p["thick"]      # wall OUTER face plane
    sq = _NEMA_SCREW_SQUARE.get(MOTOR_SPEC["nema"], 0.73 * MOTOR_SPEC["face"])
    my = p["base_d"] / 2.0
    mz = (p["bend_r"] + p["thick"]) + p["motor_up"]      # wall local x -> world z

    asm = AssemblyHelper("sheet_stepper_mount")
    asm.add(_bracket().folded(), "bracket")

    m = stepper_motor(
        MOTOR_SPEC["face"], MOTOR_SPEC["body_len"],
        MOTOR_SPEC["shaft_dia"], MOTOR_SPEC["shaft_len"],
        pilot_dia=MOTOR_SPEC["pilot_dia"], pilot_len=MOTOR_SPEC["pilot_len"],
        label_prefix="m",
    )
    # motor local +Z (shaft) -> world -X: face plane lands on the wall outer
    # face, body hangs outside, shaft points back through the pilot hole
    to_world = Pos(face_x, my, mz) * Rot(0, -90, 0)
    asm.add(to_world * m.children[0], "motor_body")
    asm.add(to_world * m.children[1], "motor_shaft")

    # M3 rods: through the wall clearance holes (no contact), 6 mm into the
    # motor body, 4 mm proud on the inside
    for i, (sy, sz) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        screw = Rot(0, 90, 0) * Cylinder(p["screw_d"] / 2.0, 10.0 + p["thick"])
        screw = Pos(face_x - p["thick"] - 4.0 + (10.0 + p["thick"]) / 2.0,
                    my + sy * sq / 2.0, mz + sz * sq / 2.0) * screw
        asm.add(screw, f"screw_{i}")
    return asm.build()


def gen_dxf():
    return _bracket().dxf()   # flat pattern of the sheet part only


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="sheet_stepper_mount")
    assert_no_interference(shape, allow=INTENDED_CONTACT)


if __name__ == "__main__":
    s = gen_step()
    print("children:", len(s.children), "motor:", MOTOR_SPEC["model"])
    check_geometry(s)
    print("flat size:", tuple(round(v, 3) for v in _bracket().flat_size()))
    print("static checks passed")
