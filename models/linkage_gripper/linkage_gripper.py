"""Two-finger linkage gripper with replaceable V-jaw pads: reference model for
a closed chain whose MASTER IS THE INPUT.

One push rod (crosshead) drives both fingers through two short links: the
crosshead pin slides along the gripper axis, the finger's crank pin runs on a
circle about the finger pivot, and the link keeps them a fixed distance apart
(circle x circle closed form). Home pose = closed on the workpiece; pushing the
crosshead up by `stroke` opens both fingers symmetrically.

Compare with models/cylinder_tilt_platform (master = output angle):
  * here the master dof is the crosshead stroke (linear in u); the finger
    angles and the link swings are the coupled dofs and carry `profile`;
  * each link swings about its crosshead pin and is carried by the crosshead,
    so its revolute is declared BEFORE the master linear dof (inner first);
  * the left side is the mirror image: same angles, opposite axis.

Gripper detail that matters for a real design (see the layer table below):
fingers, links and the body sit in separate Y layers so nothing but the pins
crosses a layer; every pin is pressed into one part and runs with clearance
in the other; the jaw pads are separate face-mounted parts so the gripping
geometry (V groove, pad thickness = grip width) can be changed without
touching the linkage.
"""
import math

from build123d import Axis, Box, Cylinder, Plane, Pos
from cadpy.assembly import AssemblyHelper

# ---------------------------------------------------------------------------
# Fixed layout constants (mm, deg). X = finger opening direction, Z = gripper
# axis (approach direction, fingertips at +Z), Y = stack-up direction.
# Y layers:  body back plate [-16, -6] | fingers + crosshead [-4, 4] |
#            links [5, 9].  Pins run along Y.
# Right side (+X) is defined here; the left side is mirrored.
# ---------------------------------------------------------------------------
PIVOT_X = 22.0          # finger pivot
PIVOT_Z = 50.0
CRANK_R = 14.0          # pivot -> crank pin
CRANK_ANGLE0 = 200.0    # crank pin direction at home, deg from +X toward +Z
CROSS_PIN_X = 6.0       # crosshead pin offset from the axis
CROSS_PIN_Z0 = 30.0     # crosshead pin height at home (closed)
FINGER_W = 12.0
FINGER_T = 8.0          # layer [-4, 4]
LINK_W = 8.0
LINK_Y0, LINK_Y1 = 5.0, 9.0
PLATE_Y0, PLATE_Y1 = -16.0, -6.0
PIN_R = 2.5
PIN_CLR = 0.2           # radial running clearance
ROD_R = 5.0
ROD_CLR = 0.3
PAD_W = 12.0            # pad width along Y (wider than the finger)
PROFILE_N = 24

PARAMS = {
    "stroke": 5.0,
    "finger_len": 60.0,
    "grip_w": 20.0,
    "pad_h": 22.0,
    "vee_depth": 3.0,
}


def _crank_pin0():
    t = math.radians(CRANK_ANGLE0)
    return PIVOT_X + CRANK_R * math.cos(t), PIVOT_Z + CRANK_R * math.sin(t)


def _link_len():
    kx, kz = _crank_pin0()
    return math.hypot(kx - CROSS_PIN_X, kz - CROSS_PIN_Z0)


def _chain(rise):
    # Closed form at crosshead rise (mm) -> (finger angle change deg,
    # link swing deg), both in the X->Z sense. Crank pin = circle(pivot,
    # CRANK_R) x circle(crosshead pin, link length); the branch is the one
    # continuous with the home pose.
    cx, cz = CROSS_PIN_X, CROSS_PIN_Z0 + rise
    d = math.hypot(cx - PIVOT_X, cz - PIVOT_Z)
    link = _link_len()
    cos_g = (CRANK_R**2 + d * d - link * link) / (2.0 * CRANK_R * d)
    if abs(cos_g) > 1.0:
        raise ValueError("linkage cannot close")
    alpha = math.atan2(cz - PIVOT_Z, cx - PIVOT_X)
    theta = alpha - math.acos(cos_g)
    kx = PIVOT_X + CRANK_R * math.cos(theta)
    kz = PIVOT_Z + CRANK_R * math.sin(theta)
    psi = math.atan2(kz - cz, kx - cx)
    k0x, k0z = _crank_pin0()
    psi0 = math.atan2(k0z - CROSS_PIN_Z0, k0x - CROSS_PIN_X)

    def wrap(a):
        return (a + math.pi) % (2.0 * math.pi) - math.pi

    return (
        math.degrees(wrap(theta - math.radians(CRANK_ANGLE0))),
        math.degrees(wrap(psi - psi0)),
    )


def _profile(k):
    # Ratio of coupled quantity k (0 = finger angle, 1 = link swing) at equal
    # steps of the crosshead stroke.
    end = _chain(PARAMS["stroke"])[k]
    return [_chain(PARAMS["stroke"] * i / PROFILE_N)[k] / end for i in range(PROFILE_N + 1)]


def _check_params():
    p = PARAMS
    if not 2.0 <= p["stroke"] <= 9.0:
        raise ValueError(f"stroke({p['stroke']})須在 2~9 mm:再大連桿會越過死點,手指反向")
    try:
        opening = abs(_chain(p["stroke"])[0])
    except ValueError:
        raise ValueError(f"stroke({p['stroke']})過大:連桿在行程終點無法閉合") from None
    if opening > 40.0:
        raise ValueError(f"stroke({p['stroke']})使單指張開 {opening:.0f}°,超過 40°:請縮小行程")
    if not 40.0 <= p["finger_len"] <= 90.0:
        raise ValueError(f"finger_len({p['finger_len']})須在 40~90 mm:過長夾持力不足且指尖撓度大")
    face = PIVOT_X - FINGER_W / 2.0
    pad_t = face - p["grip_w"] / 2.0
    if not 3.0 <= pad_t <= 12.0:
        raise ValueError(
            f"grip_w({p['grip_w']})須在 {2 * (face - 12.0):.0f}~{2 * (face - 3.0):.0f} mm:夾塊厚度需 3~12 mm"
        )
    if not 10.0 <= p["pad_h"] <= p["finger_len"] - 25.0:
        raise ValueError(f"pad_h({p['pad_h']})須在 10~{p['finger_len'] - 25.0:.0f} mm:夾塊不可伸到曲柄區")
    if not 1.0 <= p["vee_depth"] <= pad_t - 1.5:
        raise ValueError(f"vee_depth({p['vee_depth']})須在 1~{pad_t - 1.5:.1f} mm:V 槽底需留 1.5 mm 以上肉厚")


def _box(x0, x1, y0, y1, z0, z1):
    return Pos((x0 + x1) / 2.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0) * Box(x1 - x0, y1 - y0, z1 - z0)


def _ycyl(x, z, r, y0, y1):
    c = Cylinder(r, y1 - y0).rotate(Axis((0, 0, 0), (1, 0, 0)), -90.0)
    return c.translate((x, (y0 + y1) / 2.0, z))


def _bar(x0, z0, x1, z1, w, y0, y1):
    # Flat bar with round ends between two points in the X-Z plane.
    length = math.hypot(x1 - x0, z1 - z0)
    ang = math.degrees(math.atan2(z1 - z0, x1 - x0))
    bar = _box(0.0, length, y0, y1, -w / 2.0, w / 2.0)
    bar += _ycyl(0.0, 0.0, w / 2.0, y0, y1) + _ycyl(length, 0.0, w / 2.0, y0, y1)
    # +angle in the X->Z sense is a rotation about -Y
    return bar.rotate(Axis((0, 0, 0), (0, -1, 0)), ang).translate((x0, 0.0, z0))


def _mirror(shape):
    # Mirror to the left side (x -> -x). The plane MUST be given: build123d's
    # mirror() defaults to the XY plane (z -> -z), which silently drops the
    # copy below the model instead of across it.
    return shape.mirror(Plane.YZ)


def _body():
    p = PARAMS
    plate = _box(-40.0, 40.0, PLATE_Y0, PLATE_Y1, 0.0, PIVOT_Z + 14.0)
    guide = _box(-14.0, 14.0, PLATE_Y1, 6.0, 0.0, 16.0)
    body = plate + guide
    body -= Pos(0, 0, 8.0) * Cylinder(ROD_R + ROD_CLR, 20.0)
    for sx in (1.0, -1.0):  # pivot pin press bores
        body -= _ycyl(sx * PIVOT_X, PIVOT_Z, PIN_R, PLATE_Y0 - 1.0, PLATE_Y1 + 1.0)
    del p
    return body


def _finger_r():
    p = PARAMS
    kx, kz = _crank_pin0()
    arm = _box(PIVOT_X - FINGER_W / 2.0, PIVOT_X + FINGER_W / 2.0, -FINGER_T / 2.0, FINGER_T / 2.0,
               PIVOT_Z - 6.0, PIVOT_Z + p["finger_len"])
    lug = _bar(PIVOT_X, PIVOT_Z, kx, kz, 10.0, -FINGER_T / 2.0, FINGER_T / 2.0)
    finger = arm + lug
    finger -= _ycyl(PIVOT_X, PIVOT_Z, PIN_R + PIN_CLR, -FINGER_T, FINGER_T)   # runs on the pivot pin
    finger -= _ycyl(kx, kz, PIN_R, -FINGER_T, FINGER_T)                         # crank pin pressed in
    return finger


def _pad_r():
    # Replaceable jaw pad, face-mounted on the finger's inner face, with a
    # 90-degree V groove along Y for round workpieces.
    p = PARAMS
    face = PIVOT_X - FINGER_W / 2.0
    x_in = p["grip_w"] / 2.0
    z1 = PIVOT_Z + p["finger_len"]
    z0 = z1 - p["pad_h"]
    pad = _box(x_in, face, -PAD_W / 2.0, PAD_W / 2.0, z0, z1)
    zc = (z0 + z1) / 2.0
    d = p["vee_depth"]
    vee = Box(d * math.sqrt(2.0), PAD_W + 2.0, d * math.sqrt(2.0)).rotate(Axis((0, 0, 0), (0, 1, 0)), 45.0)
    pad -= vee.translate((x_in, 0.0, zc))
    return pad


def _link_r():
    kx, kz = _crank_pin0()
    link = _bar(CROSS_PIN_X, CROSS_PIN_Z0, kx, kz, LINK_W, LINK_Y0, LINK_Y1)
    for x, z in ((CROSS_PIN_X, CROSS_PIN_Z0), (kx, kz)):
        link -= _ycyl(x, z, PIN_R + PIN_CLR, LINK_Y0 - 1.0, LINK_Y1 + 1.0)
    return link


def _crosshead():
    head = _box(-(CROSS_PIN_X + 4.0), CROSS_PIN_X + 4.0, -FINGER_T / 2.0, FINGER_T / 2.0,
                CROSS_PIN_Z0 - 8.0, CROSS_PIN_Z0 + 5.0)
    rod = Pos(0, 0, (CROSS_PIN_Z0 - 8.0 - 12.0) / 2.0) * Cylinder(ROD_R, CROSS_PIN_Z0 - 8.0 + 12.0)
    head = head + rod
    for sx in (1.0, -1.0):
        head -= _ycyl(sx * CROSS_PIN_X, CROSS_PIN_Z0, PIN_R, -FINGER_T, FINGER_T)
    return head


def gen_step():
    _check_params()
    kx, kz = _crank_pin0()
    asm = AssemblyHelper("linkage_gripper")
    asm.add(_body(), "body")
    asm.add(_crosshead(), "crosshead")
    parts_r = {
        "finger": _finger_r(),
        "pad": _pad_r(),
        "link": _link_r(),
        "pivot_pin": _ycyl(PIVOT_X, PIVOT_Z, PIN_R, PLATE_Y0, FINGER_T / 2.0 + 0.5),
        "crank_pin": _ycyl(kx, kz, PIN_R, -FINGER_T / 2.0, LINK_Y1 + 0.5),
        "cross_pin": _ycyl(CROSS_PIN_X, CROSS_PIN_Z0, PIN_R, -FINGER_T / 2.0, LINK_Y1 + 0.5),
    }
    for name, shape in parts_r.items():
        asm.add(shape, f"{name}_r")
        asm.add(_mirror(shape), f"{name}_l")
    return asm.build()


# Press fits (pin pressed into exactly one part; zero-volume by construction).
# Running fits (pin in link eye / finger pivot bore) keep PIN_CLR and are NOT
# listed. Pads are face-mounted (zero volume), not listed.
INTENDED_CONTACT = [
    ("pivot_pin_r", "body"), ("pivot_pin_l", "body"),
    ("crank_pin_r", "finger_r"), ("crank_pin_l", "finger_l"),
    ("cross_pin_r", "crosshead"), ("cross_pin_l", "crosshead"),
]


def _motion():
    finger_end, swing_end = _chain(PARAMS["stroke"])
    finger_prof, swing_prof = _profile(0), _profile(1)
    dofs = []
    # inner first: each link swings about its crosshead pin (home position)
    for side, sx in (("r", 1.0), ("l", -1.0)):
        dofs.append({
            "id": f"link_swing_{side}",
            "label": "連桿擺角",
            "type": "revolute",
            "axis": [0, -sx, 0],
            "pivot": [sx * CROSS_PIN_X, 0.0, CROSS_PIN_Z0],
            "angle_deg": swing_end,
            "profile": swing_prof,
            "couple": "stroke",
            "moving": [f"link_{side}"],
            "pairs": [[f"link_{side}", f"crank_pin_{side}"], [f"link_{side}", f"cross_pin_{side}"],
                      [f"link_{side}", f"finger_{side}"]],
            "samples": 12,
        })
    # master: the crosshead stroke carries the cross pins and both links
    dofs.append({
        "id": "stroke",
        "label": "推桿行程",
        "type": "linear",
        "axis": [0, 0, 1],
        "travel": PARAMS["stroke"],
        "moving": ["crosshead", "cross_pin_r", "cross_pin_l", "link_r", "link_l"],
        "pairs": [["crosshead", "body"], ["crosshead", "finger_r"], ["crosshead", "finger_l"],
                  ["link_r", "link_l"]],
        "samples": 12,
    })
    for side, sx in (("r", 1.0), ("l", -1.0)):
        dofs.append({
            "id": f"finger_{side}",
            "label": "右指張角" if side == "r" else "左指張角",
            "type": "revolute",
            "axis": [0, -sx, 0],
            "pivot": [sx * PIVOT_X, 0.0, PIVOT_Z],
            "angle_deg": finger_end,
            "profile": finger_prof,
            "couple": "stroke",
            "moving": [f"finger_{side}", f"pad_{side}", f"crank_pin_{side}"],
            "pairs": [[f"finger_{side}", f"pivot_pin_{side}"], [f"finger_{side}", "body"],
                      [f"pad_{side}", "body"]],
            "samples": 12,
        })
    dofs[-2]["pairs"].append(["finger_r", "finger_l"])
    dofs[-2]["pairs"].append(["pad_r", "pad_l"])
    return {"schemaVersion": 1, "dofs": dofs}


MOTION = _motion()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
