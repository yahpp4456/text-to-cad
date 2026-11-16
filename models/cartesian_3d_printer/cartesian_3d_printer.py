"""Cube-frame Cartesian FDM 3D printer (box frame, XY gantry on top, Z bed).

Layout (Z up, origin at the front-left-bottom frame corner):
  * frame   12 x 2020 T-slot extrusions (4 posts, 4 bottom, 4 top) + base plate
  * Y axis  two MGN12 rails on the top side extrusions; each side has its own
            NEMA17 (hanging under a corner plate, shaft up), pulley, front
            idler and a belt loop beside the rail
  * X axis  a 2020 beam riding on the two Y blocks, MGN12 rail on top, NEMA17
            and idler on the gantry end plates, belt loop behind the beam
  * head    carriage plate + front plate + hotend clamp, heatsink, heater
            block, nozzle, part fan, extruder
  * Z axis  cantilever bed at the rear: one lead screw (motor + coupling at
            the bottom) and two guide rods, bed carrier with fused bushings,
            bed plate on four standoffs

The model is built at HOME: toolhead at min X / min Y, bed at the top with
the nozzle 0.3 mm above it. MOTION declares the three independent axes; the
gantry parts ride along on Y, the toolhead on X and Y.

Simplifications (say so to the user): belts are static loops (they do not
run), standard parts are catalog-size proxies, the lead screw is a plain rod,
no fasteners, wiring, endstops or enclosure panels.
"""
import math

from build123d import Axis, Box, Cone, Cylinder, Pos
from cadpy.assembly import AssemblyHelper
from cadpy.parts import ball_screw, linear_guide, load_specs, stepper_motor

# ---------------------------------------------------------------------------
# Catalog rows (dimension source for the proxies) and fixed layout constants.
# ---------------------------------------------------------------------------
GUIDE = next(r for r in load_specs("linear_guides") if r["model"] == "MGN12C")
MOTOR = next(r for r in load_specs("motors") if r["model"] == "NEMA17-40")

E = 20.0                 # extrusion size (2020)
SLOT_W, SLOT_D = 6.2, 6.0
PLATE_T = 6.0            # bracket / gantry plate thickness
PULLEY_R = 6.0
BELT_T, BELT_W, BELT_GAP = 1.5, 6.0, 0.3
RAIL_INSET = 30.0        # Y rail starts this far from the frame front/back
HEAD_W = 50.0            # toolhead carriage width along X
NOZZLE_FWD = 43.0        # nozzle centre in front of the X beam centre line
Y_HOME = 96.0            # X beam centre line y at home (clears front corner plates)
X_MARGIN = 100.0         # nozzle x at home (clears the Y belts)
Z_AXIS_BACK = 45.0       # lead screw / rods this far in front of the rear face
ROD_R, ROD_CLR, ROD_DX = 4.0, 0.2, 50.0
SCREW_D, NUT_D, NUT_LEN = 8.0, 22.0, 15.0
BED_T, STANDOFF_H, CARRIER_T = 4.0, 10.0, 8.0
NOZZLE_GAP = 0.3

PARAMS = {
    "bed_x": 220.0,
    "bed_y": 220.0,
    "z_travel": 200.0,
}


def _check_params():
    p = PARAMS
    for k in ("bed_x", "bed_y"):
        if not 150.0 <= p[k] <= 300.0:
            raise ValueError(f"{k}({p[k]})須在 150~300 mm:小於 150 放不下 Z 軸導桿間距,大於 300 橫樑與懸臂熱床撓度過大")
    if not 100.0 <= p["z_travel"] <= 300.0:
        raise ValueError(f"z_travel({p['z_travel']})須在 100~300 mm:懸臂熱床的導桿長度限制")


def _geom():
    p = PARAMS
    g = {}
    g["W"] = p["bed_x"] + 2.0 * X_MARGIN          # frame outer size
    g["D"] = p["bed_y"] + 180.0
    g["H"] = p["z_travel"] + 220.0
    H = g["H"]
    g["blk_top"] = 0.3 * GUIDE["rail_height"] + GUIDE["block_height"]   # block top above rail base
    g["yc"] = Y_HOME                                # X beam centre line (home)
    g["xc"] = X_MARGIN                              # toolhead / nozzle x (home)
    g["plate_z0"] = H + g["blk_top"]                # gantry end plates sit on the Y blocks
    g["beam_z0"] = g["plate_z0"] + PLATE_T
    g["xrail_z0"] = g["beam_z0"] + E
    g["car_z0"] = g["xrail_z0"] + g["blk_top"]      # toolhead carriage plate bottom
    g["noz_y"] = g["yc"] - NOZZLE_FWD
    g["noz_z"] = H - 60.0                           # nozzle tip
    g["bed_top"] = g["noz_z"] - NOZZLE_GAP
    g["bed_x0"] = g["xc"]
    g["bed_y0"] = g["noz_y"]
    g["car_top"] = g["bed_top"] - BED_T - STANDOFF_H  # bed carrier top face (home)
    g["zx"] = g["W"] / 2.0                          # lead screw x
    g["zy"] = g["D"] - Z_AXIS_BACK                  # lead screw / rods y
    # screw starts 1 mm above the motor shaft tip; the coupling bridges both
    g["screw_z0"] = 4.0 + MOTOR["body_len"] + MOTOR["shaft_len"] + 1.0
    g["screw_len"] = H - 30.0 - g["screw_z0"]
    return g


def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(x1 - x0, y1 - y0, z1 - z0)


def _zcyl(x, y, r, z0, z1):
    return Pos(x, y, (z0 + z1) / 2.0) * Cylinder(r, z1 - z0)


def _extrusion(length):
    # 2020 T-slot proxy along +Z, centred on the axis: square bar with a slot
    # on each face and a centre bore.
    bar = _box(-E / 2, E / 2, -E / 2, E / 2, 0.0, length)
    for ang in (0.0, 90.0, 180.0, 270.0):
        slot = _box(E / 2 - SLOT_D, E / 2 + 1.0, -SLOT_W / 2, SLOT_W / 2, -1.0, length + 1.0)
        bar -= slot.rotate(Axis.Z, ang)
    bar -= _zcyl(0.0, 0.0, 2.1, -1.0, length + 1.0)
    return bar


def _ext_x(x0, x1, y, z):
    return _extrusion(x1 - x0).rotate(Axis((0, 0, 0), (0, 1, 0)), 90.0).translate((x0, y, z))


def _ext_y(y0, y1, x, z):
    return _extrusion(y1 - y0).rotate(Axis((0, 0, 0), (1, 0, 0)), -90.0).translate((x, y0, z))


def _belt_loop(p0, p1, z0):
    # Static belt loop in a horizontal plane around two pulley centres.
    (x0, y0), (x1, y1) = p0, p1
    length = math.hypot(x1 - x0, y1 - y0)
    ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
    r_in = PULLEY_R + BELT_GAP
    r_out = r_in + BELT_T

    def stadium(r):
        s = _box(0.0, length, -r, r, 0.0, BELT_W)
        return s + _zcyl(0.0, 0.0, r, 0.0, BELT_W) + _zcyl(length, 0.0, r, 0.0, BELT_W)

    loop = stadium(r_out) - stadium(r_in)
    return loop.rotate(Axis.Z, ang).translate((x0, y0, z0))


def _motor_up(x, y, face_z):
    # NEMA17 with the shaft pointing +Z; `face_z` = mounting face height.
    m = stepper_motor(MOTOR["face"], MOTOR["body_len"], MOTOR["shaft_dia"], MOTOR["shaft_len"],
                      pilot_dia=MOTOR["pilot_dia"], pilot_len=MOTOR["pilot_len"])
    return m.translate((x, y, face_z))  # whole compound, added as ONE part


def _frame(asm, g):
    W, D, H = g["W"], g["D"], g["H"]
    for name, x, y in (("post_fl", E / 2, E / 2), ("post_fr", W - E / 2, E / 2),
                       ("post_bl", E / 2, D - E / 2), ("post_br", W - E / 2, D - E / 2)):
        asm.add(_extrusion(H).translate((x, y, 0.0)), name)
    for lvl, z in (("bottom", E / 2), ("top", H - E / 2)):
        asm.add(_ext_x(E, W - E, E / 2, z), f"{lvl}_front")
        asm.add(_ext_x(E, W - E, D - E / 2, z), f"{lvl}_back")
        asm.add(_ext_y(E, D - E, E / 2, z), f"{lvl}_left")
        asm.add(_ext_y(E, D - E, W - E / 2, z), f"{lvl}_right")
    asm.add(_box(E, W - E, E, D - E, 0.0, 4.0), "base_plate")


def _y_axis(asm, g):
    W, D, H = g["W"], g["D"], g["H"]
    rail_len = D - 2.0 * RAIL_INSET
    block_pos = g["yc"] - GUIDE["block_len"] / 2.0 - RAIL_INSET
    mhalf = MOTOR["face"] / 2.0
    for side, sx in (("l", 1.0), ("r", -1.0)):
        def X(x, sx=sx):  # mirror an x coordinate for the right side
            return x if sx > 0 else W - x

        cmp = linear_guide(GUIDE["rail_width"], GUIDE["rail_height"], rail_len,
                           GUIDE["block_width"], GUIDE["block_height"], GUIDE["block_len"],
                           block_pos=block_pos, label_prefix=f"y_{side}")
        rail, block = cmp.children
        for child, name in ((rail, f"y_rail_{side}"), (block, f"y_block_{side}")):
            # guide is built along +X: turn it to +Y, then place (each child separately)
            asm.add(child.rotate(Axis.Z, 90.0).translate((X(E / 2), RAIL_INSET, H)), name)
        px = E + mhalf + 1.0                       # pulley / motor centre, inside the frame
        x0, x1 = sorted((X(E), X(E + 2.0 * mhalf + 2.0)))
        my = D - E - mhalf - 1.0                   # rear motor centre y
        iy = E + mhalf + 1.0                       # front idler centre y
        plate = _box(x0, x1, D - E - 2.0 * mhalf - 2.0, D - E, H - PLATE_T, H)
        plate -= _zcyl(X(px), my, MOTOR["pilot_dia"] / 2.0 + 0.6, H - PLATE_T - 1.0, H + 1.0)
        asm.add(plate, f"y_motor_plate_{side}")
        asm.add(_motor_up(X(px), my, H - PLATE_T), f"y_motor_{side}")
        pulley = _zcyl(X(px), my, PULLEY_R, H + 1.0, H + 9.0) - _zcyl(X(px), my, MOTOR["shaft_dia"] / 2.0, H, H + 10.0)
        asm.add(pulley, f"y_pulley_{side}")
        asm.add(_box(x0, x1, E, E + 2.0 * mhalf + 2.0, H - PLATE_T, H), f"y_idler_plate_{side}")
        asm.add(_zcyl(X(px), iy, PULLEY_R, H, H + 9.0), f"y_idler_{side}")
        asm.add(_belt_loop((X(px), iy), (X(px), my), H + 2.0), f"y_belt_{side}")


def _x_axis(asm, g):
    W = g["W"]
    yc, pz, bz = g["yc"], g["plate_z0"], g["beam_z0"]
    by = yc + E / 2 + MOTOR["face"] / 2.0 + 3.0    # X belt / motor centre line y
    mx = E + 2.0
    for side, x0, x1 in (("l", 0.0, 44.0), ("r", W - 44.0, W)):
        asm.add(_box(x0, x1, yc - 22.0, by + MOTOR["face"] / 2.0 + 3.0, pz, pz + PLATE_T), f"gantry_plate_{side}")
    asm.add(_ext_x(24.0, W - 24.0, yc, bz + E / 2), "x_beam")
    rail_x0 = 40.0
    cmp = linear_guide(GUIDE["rail_width"], GUIDE["rail_height"], W - 2.0 * rail_x0,
                       GUIDE["block_width"], GUIDE["block_height"], GUIDE["block_len"],
                       block_pos=g["xc"] - GUIDE["block_len"] / 2.0 - rail_x0, label_prefix="x")
    rail, block = cmp.children
    asm.add(rail.translate((rail_x0, yc, g["xrail_z0"])), "x_rail")
    asm.add(block.translate((rail_x0, yc, g["xrail_z0"])), "x_block")
    top = pz + PLATE_T + MOTOR["body_len"]         # X motor stands on the left gantry plate
    asm.add(_motor_up(mx, by, top), "x_motor")
    pulley = _zcyl(mx, by, PULLEY_R, top + 6.0, top + 14.0) - _zcyl(mx, by, MOTOR["shaft_dia"] / 2.0, top + 5.0, top + 15.0)
    asm.add(pulley, "x_pulley")
    idler = _zcyl(W - mx, by, 4.0, pz + PLATE_T, top + 6.0) + _zcyl(W - mx, by, PULLEY_R, top + 6.0, top + 14.0)
    asm.add(idler, "x_idler")
    asm.add(_belt_loop((mx, by), (W - mx, by), top + 7.0), "x_belt")


def _toolhead(asm, g):
    H, xc, yc, cz = g["H"], g["xc"], g["yc"], g["car_z0"]
    ny = g["noz_y"]
    x0, x1 = xc - HEAD_W / 2.0, xc + HEAD_W / 2.0
    car = _box(x0, x1, yc - 30.0, yc + 11.0, cz, cz + PLATE_T)                 # on the X block
    car += _box(x0, x1, yc - 30.0, yc - 24.0, H - 30.0, cz)                    # front plate
    car += _box(xc - 14.0, xc + 14.0, ny - 14.0, yc - 30.0, H - 30.0, H - 18.0)  # hotend clamp
    car -= _zcyl(xc, ny, 11.0, H - 31.0, H - 17.0)
    asm.add(car, "x_carriage")
    asm.add(_zcyl(xc, ny, 11.0, H - 42.0, H - 16.0), "hotend_heatsink")
    asm.add(_box(xc - 10.0, xc + 10.0, ny - 8.0, ny + 8.0, H - 54.0, H - 42.0), "heater_block")
    asm.add(Pos(xc, ny, H - 57.0) * Cone(0.5, 4.0, 6.0), "nozzle")
    asm.add(_box(xc - 15.0, xc + 15.0, ny - 24.0, ny - 14.0, H - 46.0, H - 16.0), "part_fan")
    asm.add(_box(xc - 21.0, xc + 21.0, yc - 72.0, yc - 30.0, H + 12.0, H + 54.0), "extruder")


def _z_axis(asm, g):
    H, zx, zy = g["H"], g["zx"], g["zy"]
    p = PARAMS
    asm.add(_motor_up(zx, zy, 4.0 + MOTOR["body_len"]), "z_motor")
    asm.add(_zcyl(zx, zy, 9.5, g["screw_z0"] - 15.0, g["screw_z0"] + 12.0), "z_coupling")
    ct = g["car_top"]
    cmp = ball_screw(SCREW_D, 8.0, g["screw_len"], NUT_D, NUT_LEN,
                     nut_pos=(ct - CARRIER_T - 7.0) - g["screw_z0"], label_prefix="z")
    shaft, nut = cmp.children
    for child, name in ((shaft, "z_screw"), (nut, "z_nut")):
        # screw is built along +X: turn +X to +Z, then place (each child separately)
        asm.add(child.rotate(Axis((0, 0, 0), (0, 1, 0)), -90.0).translate((zx, zy, g["screw_z0"])), name)
    for side, sx in (("l", -1.0), ("r", 1.0)):
        asm.add(_zcyl(zx + sx * ROD_DX, zy, ROD_R, 4.0, H - E), f"z_rod_{side}")
    asm.add(_box(zx - 70.0, zx + 70.0, zy - 25.0, g["D"] - E, H - E, H - E + PLATE_T), "z_top_bracket")
    carrier = _box(zx - 70.0, zx + 70.0, g["bed_y0"] + 10.0, zy + 17.0, ct - CARRIER_T, ct)
    for sx in (-1.0, 1.0):
        carrier += _zcyl(zx + sx * ROD_DX, zy, 11.0, ct - CARRIER_T - 20.0, ct)   # fused bushings
        for sy in (-1.0, 1.0):                                                    # bed standoffs
            carrier += _zcyl(zx + sx * 60.0, g["bed_y0"] + p["bed_y"] / 2.0 + sy * 90.0, 5.0, ct, ct + STANDOFF_H)
    for sx in (-1.0, 1.0):
        carrier -= _zcyl(zx + sx * ROD_DX, zy, ROD_R + ROD_CLR, ct - CARRIER_T - 21.0, ct + 1.0)
    carrier -= _zcyl(zx, zy, NUT_D / 2.0, ct - CARRIER_T - 1.0, ct + 1.0)            # nut seat
    asm.add(carrier, "bed_carrier")
    asm.add(_box(g["bed_x0"], g["bed_x0"] + p["bed_x"], g["bed_y0"], g["bed_y0"] + p["bed_y"],
                 g["bed_top"] - BED_T, g["bed_top"]), "bed")


def gen_step():
    _check_params()
    g = _geom()
    asm = AssemblyHelper("cartesian_3d_printer")
    _frame(asm, g)
    _y_axis(asm, g)
    _x_axis(asm, g)
    _toolhead(asm, g)
    _z_axis(asm, g)
    return asm.build()


# Real fits only: shaft in pulley / coupling bores, screw in coupling, nut in
# its seat, heatsink in the clamp. Everything else is face-mated or clear.
INTENDED_CONTACT = [
    ("y_pulley_l", "y_motor_l"), ("y_pulley_r", "y_motor_r"), ("x_pulley", "x_motor"),
    ("z_coupling", "z_motor"), ("z_coupling", "z_screw"),
    ("z_nut", "bed_carrier"),
    ("hotend_heatsink", "x_carriage"),
]

HEAD = ["x_block", "x_carriage", "hotend_heatsink", "heater_block", "nozzle", "part_fan", "extruder"]
GANTRY = ["y_block_l", "y_block_r", "gantry_plate_l", "gantry_plate_r", "x_beam", "x_rail",
          "x_motor", "x_pulley", "x_idler", "x_belt"]

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "y", "label": "Y 行程", "type": "linear", "axis": [0, 1, 0],
         "travel": PARAMS["bed_y"],
         "moving": GANTRY + HEAD,
         "pairs": [["y_block_l", "y_rail_l"], ["y_block_r", "y_rail_r"],
                   ["x_carriage", "y_idler_plate_l"], ["extruder", "y_idler_l"],
                   ["gantry_plate_l", "y_pulley_l"], ["gantry_plate_r", "y_pulley_r"],
                   ["x_carriage", "z_top_bracket"], ["nozzle", "bed"], ["part_fan", "bed"],
                   ["x_carriage", "top_front"]],
         "samples": 8},
        {"id": "x", "label": "X 行程", "type": "linear", "axis": [1, 0, 0],
         "travel": PARAMS["bed_x"],
         "moving": HEAD,
         "pairs": [["x_block", "x_rail"], ["x_carriage", "x_beam"], ["x_carriage", "x_belt"],
                   ["x_carriage", "y_belt_l"], ["x_carriage", "y_belt_r"],
                   ["x_carriage", "y_idler_plate_r"], ["extruder", "gantry_plate_r"],
                   ["nozzle", "bed"]],
         "samples": 8},
        {"id": "z", "label": "Z 行程(熱床下降)", "type": "linear", "axis": [0, 0, -1],
         "travel": PARAMS["z_travel"],
         "moving": ["bed", "bed_carrier", "z_nut"],
         "pairs": [["z_nut", "z_screw"], ["bed_carrier", "z_rod_l"], ["bed_carrier", "z_rod_r"],
                   ["bed_carrier", "z_coupling"], ["bed_carrier", "z_screw"], ["bed", "y_motor_l"],
                   ["bed", "y_motor_r"]],
         "samples": 8},
    ],
}


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
