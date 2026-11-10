"""Stewart platform (6-UPS hexapod): reference model for PARALLEL mechanisms.

Six telescopic legs (body + rod, ball joint at each end) connect a fixed base
to a moving platform. The platform pose is the INPUT; every leg length follows
from inverse kinematics:  L_i = | c + R * p_i - b_i |.

What this file shows:
  * Static pose by IK. The six pose PARAMS (dx, dy, z0, roll, pitch, yaw) are
    applied through ONE Location (`_pose()`); the platform solid and all six
    leg end points come from that same Location, so they cannot drift apart.
  * `_check_params` turns the mechanism limits into plain messages: leg length
    inside the actuator range (rod stays engaged / does not bottom out) and
    leg elevation inside the ball-joint swing range.
  * MOTION = one trajectory (heave along Z from the current pose). While the
    platform heaves, each leg stays in the vertical plane through its base
    joint, so per leg two coupled dofs are exact: the rod extends along the
    home leg axis (declared first = inner), then body + rod swing about a
    fixed horizontal axis through the base joint (declared after = outer).
    Extension and swing are NOT proportional to the heave, so both carry
    `profile` (closed form sampled at equal heave steps).
  * Pairs list every joint: rod x body (telescoping), body x base and
    rod x platform (ball in socket). With exact kinematics the sweep really
    checks that all 12 ball joints stay seated over the stroke.

A general 6-DOF trajectory would need 3 dofs per leg plus the platform's own;
MOTION is one parameter per group, so pick ONE representative trajectory for
the motion preview and expose the remaining pose freedoms as sliders.
"""
import math

from build123d import Axis, Cylinder, Plane, Pos, Rot, Sphere
from cadpy.assembly import AssemblyHelper

# ---------------------------------------------------------------------------
# Fixed layout constants (mm, deg). Z is up; base top face is z = 0.
# Joint layout is the classic 6-6: base joints in three pairs around
# 0/120/240 deg, platform joints in three pairs around 60/180/300 deg.
# ---------------------------------------------------------------------------
N_LEGS = 6
BASE_T = 12.0            # base plate thickness (below z = 0)
PLAT_T = 10.0            # platform plate thickness
JOINT_HALF_ANGLE = 15.0  # half spacing inside one joint pair
BASE_JOINT_Z = 15.0      # base ball-centre height above the base top face
PLAT_JOINT_DROP = 9.0    # platform ball centre below the plate underside
BALL_R = 9.0
SOCKET_CLR = 0.3         # radial clearance ball <-> socket
CUP_R = 14.0             # socket cup outer radius
NECK_R = 5.0
NECK_LEN = 14.0          # ball centre -> start of the leg tube / rod
BODY_R = 12.0
BODY_LEN = 130.0
BODY_FLOOR = 8.0         # closed bottom of the leg tube
ROD_R = 6.0
ROD_CLR = 0.5            # radial clearance rod <-> bore
ROD_LEN = 120.0
ROD_ENGAGE = 25.0        # rod length that must stay inside the tube
ELEV_MIN = 50.0          # leg elevation limits (ball-joint swing range)
ELEV_MAX = 85.0
PROFILE_N = 16

# Actuator length range between ball centres, from the tube/rod geometry.
LEG_MIN = NECK_LEN + BODY_FLOOR + 2.0 + ROD_LEN + NECK_LEN
LEG_MAX = NECK_LEN + BODY_LEN - ROD_ENGAGE + ROD_LEN + NECK_LEN

PARAMS = {
    "base_joint_r": 130.0,
    "plat_joint_r": 85.0,
    "z0": 200.0,
    "dx": 0.0,
    "dy": 0.0,
    "roll": 0.0,
    "pitch": 0.0,
    "yaw": 0.0,
    "heave": 30.0,
}


def _base_joints():
    r = PARAMS["base_joint_r"]
    a = JOINT_HALF_ANGLE
    angles = (a, 120.0 - a, 120.0 + a, 240.0 - a, 240.0 + a, 360.0 - a)
    return [
        (r * math.cos(math.radians(t)), r * math.sin(math.radians(t)), BASE_JOINT_Z)
        for t in angles
    ]


def _plat_joints_local():
    r = PARAMS["plat_joint_r"]
    a = JOINT_HALF_ANGLE
    angles = (60.0 - a, 60.0 + a, 180.0 - a, 180.0 + a, 300.0 - a, 300.0 + a)
    return [
        (r * math.cos(math.radians(t)), r * math.sin(math.radians(t)), 0.0)
        for t in angles
    ]


def _pose(lift=0.0):
    # The ONE platform pose: joint-plane centre at (dx, dy, z0 + lift).
    p = PARAMS
    return Pos(p["dx"], p["dy"], p["z0"] + lift) * Rot(p["roll"], p["pitch"], p["yaw"])


def _plat_joints(lift=0.0):
    loc = _pose(lift)
    out = []
    for q in _plat_joints_local():
        v = (loc * Pos(*q)).position
        out.append((v.X, v.Y, v.Z))
    return out


def _leg(i, lift=0.0):
    # Inverse kinematics of leg i: (length, elevation deg, unit dir, horiz unit).
    b = _base_joints()[i]
    q = _plat_joints(lift)[i]
    dx, dy, dz = q[0] - b[0], q[1] - b[1], q[2] - b[2]
    rh = math.hypot(dx, dy)
    length = math.sqrt(rh * rh + dz * dz)
    hx, hy = (dx / rh, dy / rh) if rh > 1e-9 else (1.0, 0.0)
    return {
        "len": length,
        "elev": math.degrees(math.atan2(dz, rh)),
        "dir": (dx / length, dy / length, dz / length),
        "h": (hx, hy),
    }


def _check_params():
    p = PARAMS
    if not 5.0 <= p["heave"] <= 80.0:
        raise ValueError(f"heave({p['heave']})須在 5~80 mm")
    if p["plat_joint_r"] + CUP_R + 6.0 > p["base_joint_r"] + 60.0:
        raise ValueError(
            f"plat_joint_r({p['plat_joint_r']})相對 base_joint_r({p['base_joint_r']})過大:平台不可比基座大超過 40 mm"
        )
    for lift, where in ((0.0, "起始姿態"), (p["heave"], "升程終點")):
        for i in range(N_LEGS):
            leg = _leg(i, lift)
            if not LEG_MIN <= leg["len"] <= LEG_MAX:
                raise ValueError(
                    f"第 {i + 1} 支腿在{where}需要長度 {leg['len']:.1f} mm,超出致動器範圍 "
                    f"{LEG_MIN:.0f}~{LEG_MAX:.0f} mm:請調整 z0、heave 或平台位移/傾角"
                )
            if not ELEV_MIN <= leg["elev"] <= ELEV_MAX:
                raise ValueError(
                    f"第 {i + 1} 支腿在{where}的仰角 {leg['elev']:.1f}° 超出球接頭擺角範圍 "
                    f"{ELEV_MIN:.0f}~{ELEV_MAX:.0f}°:請調整 z0、接頭半徑或平台位移/傾角"
                )


def _zcyl(r, z0, z1):
    return Pos(0, 0, (z0 + z1) / 2.0) * Cylinder(r, z1 - z0)


def _base():
    r = PARAMS["base_joint_r"] + 25.0
    base = _zcyl(r, -BASE_T, 0.0)
    for b in _base_joints():
        base += Pos(b[0], b[1], 0) * _zcyl(CUP_R, 0.0, BASE_JOINT_Z)
    for b in _base_joints():
        base -= Pos(*b) * Sphere(BALL_R + SOCKET_CLR)
    return base


def _platform():
    # Built in the platform frame (joint plane = local z 0), then posed.
    r = PARAMS["plat_joint_r"] + 20.0
    plat = _zcyl(r, PLAT_JOINT_DROP, PLAT_JOINT_DROP + PLAT_T)
    for q in _plat_joints_local():
        plat += Pos(q[0], q[1], 0) * _zcyl(CUP_R, 0.0, PLAT_JOINT_DROP)
    for q in _plat_joints_local():
        plat -= Pos(*q) * Sphere(BALL_R + SOCKET_CLR)
    return _pose() * plat


def _leg_parts(i):
    # Leg built along local +Z from the base ball centre, then aimed.
    leg = _leg(i)
    length = leg["len"]
    tube_z0 = NECK_LEN
    tube_z1 = NECK_LEN + BODY_LEN
    body = Sphere(BALL_R) + _zcyl(NECK_R, 0.0, tube_z0) + _zcyl(BODY_R, tube_z0, tube_z1)
    body -= _zcyl(ROD_R + ROD_CLR, tube_z0 + BODY_FLOOR, tube_z1 + 1.0)
    rod_z1 = length - NECK_LEN
    rod = _zcyl(ROD_R, rod_z1 - ROD_LEN, rod_z1) + _zcyl(NECK_R, rod_z1, length)
    rod += Pos(0, 0, length) * Sphere(BALL_R)
    aim = Plane(origin=_base_joints()[i], z_dir=leg["dir"]).location
    return aim * body, aim * rod


def gen_step():
    _check_params()
    asm = AssemblyHelper("stewart_platform")
    asm.add(_base(), "base")
    asm.add(_platform(), "platform")
    for i in range(N_LEGS):
        body, rod = _leg_parts(i)
        asm.add(body, f"leg{i + 1}_body")
        asm.add(rod, f"leg{i + 1}_rod")
    return asm.build()


# Ball x socket, rod x bore: clearance fits, zero overlap by construction.
INTENDED_CONTACT = []


def _leg_profiles(i):
    # (extension end mm, swing end deg, extension ratios, swing ratios)
    home = _leg(i)
    ks = [_leg(i, PARAMS["heave"] * k / PROFILE_N) for k in range(PROFILE_N + 1)]
    ext = [k["len"] - home["len"] for k in ks]
    swing = [k["elev"] - home["elev"] for k in ks]
    return ext[-1], swing[-1], [e / ext[-1] for e in ext], [s / swing[-1] for s in swing]


def _motion():
    dofs = [{
        "id": "heave",
        "label": "升降行程",
        "type": "linear",
        "axis": [0, 0, 1],
        "travel": PARAMS["heave"],
        "moving": ["platform"],
        "pairs": [["platform", f"leg{i + 1}_rod"] for i in range(N_LEGS)],
        "samples": 8,
    }]
    for i in range(N_LEGS):
        n = i + 1
        home = _leg(i)
        ext_end, swing_end, ext_prof, swing_prof = _leg_profiles(i)
        hx, hy = home["h"]
        # inner: rod extends along the home leg axis
        dofs.append({
            "id": f"ext{n}",
            "label": f"腿 {n} 伸長",
            "type": "linear",
            "axis": list(home["dir"]),
            "travel": ext_end,
            "profile": ext_prof,
            "couple": "heave",
            "moving": [f"leg{n}_rod"],
            "pairs": [[f"leg{n}_rod", f"leg{n}_body"]],
            "samples": 8,
        })
        # outer: whole leg swings up about the horizontal axis h x z through
        # the base joint (rotating h toward +Z raises the elevation)
        dofs.append({
            "id": f"swing{n}",
            "label": f"腿 {n} 擺角",
            "type": "revolute",
            "axis": [hy, -hx, 0.0],
            "pivot": list(_base_joints()[i]),
            "angle_deg": swing_end,
            "profile": swing_prof,
            "couple": "heave",
            "moving": [f"leg{n}_body", f"leg{n}_rod"],
            "pairs": [[f"leg{n}_body", "base"]],
            "samples": 8,
        })
    return {"schemaVersion": 1, "dofs": dofs}


MOTION = _motion()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
