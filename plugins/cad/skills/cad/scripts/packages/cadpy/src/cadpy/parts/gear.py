"""Parametric simplified spur gear + rack (L3 substitute parts) with mesh math.

The gear flank is a POLYLINE THROUGH TRUE INVOLUTE POINTS (base circle, pitch
circle, mid-addendum, tip; radial line below the base circle -- standard
practice), the rack flank is the exact straight 20-deg reference profile. That
makes the mesh kinematically honest: with the default 0.05 mm backlash per
flank a correctly PHASED mesh rolls with real clearance at every sample (a
single-chord trapezoid tooth does NOT -- it needs module-scaled thinning), so
rack-pinion mechanisms can be swept for interference with NO intended-contact
allowance. The fully filleted involute with undercut is step.parts' job; this
family only has to occupy the right envelope and mesh cleanly.

Mesh frame convention (single source of truth for the phase math):
- gear axis = +Z through the origin, gear centered on z = 0;
- the rack runs along Y on the -X side, teeth facing +X, pitch line at x = 0
  in the RACK's local frame (place it at x = -pitch_radius to mesh);
- rack tooth centers sit on the y = k * pitch lattice (k integer) in rack
  local coordinates -- :func:`rack_mesh_phase_deg` depends on this;
- pure rolling: gear CCW rotation theta (right-hand +Z) pulls the rack toward
  -Y by ``pitch_radius * theta`` (rack_dy = -R * radians(theta)).
"""

from __future__ import annotations

import math
from typing import Any

from cadpy.assembly import label_shape

# Flank fuse inset: tooth bases reach this far past the root line so the
# boolean fuse with the root cylinder / rack back never leaves a sliver.
_FUSE_INSET = 0.2


def pitch_radius(module: float, teeth: int) -> float:
    """Pitch circle radius m*z/2 (the one number every mesh formula shares)."""
    return module * teeth / 2.0


def rack_mesh_phase_deg(module: float, teeth: int, rack_y_offset: float = 0.0) -> float:
    """Gear ``tooth_phase_deg`` that meshes the rack at ``rack_y_offset``.

    Derivation (pure rolling, mesh frame above): the gear material point at
    angular coordinate phi meets the rack material point at local y = s when
    ``pi - phi = (s + y0) / R``. Rack TOOTH centers (s = k*p) must land on gear
    SPACE centers (phase + (j+0.5)*tau), giving
    ``phase = pi - y0/R - tau/2`` with tau = 2*pi/teeth. Valid for every theta:
    rolling shifts both sides identically.
    """
    rp = pitch_radius(module, teeth)
    tau = 2.0 * math.pi / teeth
    return math.degrees(math.pi - rack_y_offset / rp - tau / 2.0)


def _inv(a: float) -> float:
    """Involute function inv(a) = tan(a) - a."""
    return math.tan(a) - a


def _gear_flank_pts(module, teeth, pressure_angle_deg, backlash):
    """One flank as (r, half_width) pairs root->tip: true involute half-widths
    at the base/pitch/mid-addendum/tip circles, a radial line below the base
    circle. The polyline INSCRIBES the involute (chords of a convex curve), so
    the approximation can only remove material -- it never fattens the tooth,
    which is why the mesh stays clear without module-scaled allowances."""
    alpha = math.radians(pressure_angle_deg)
    rp = pitch_radius(module, teeth)
    rb = rp * math.cos(alpha)
    r_root, r_tip = rp - 1.25 * module, rp + module
    psi_p = (math.pi * module / 4.0 - backlash) / rp  # half tooth angle @ pitch

    def hw(r):
        a_r = math.acos(min(1.0, rb / r))
        psi = psi_p + _inv(alpha) - _inv(a_r)
        if psi <= 0:
            raise ValueError(
                f"tooth degenerates at r={r:.3f} (module {module}, teeth {teeth}, "
                f"backlash {backlash}): reduce backlash"
            )
        return r * math.sin(psi)

    pts = []
    if r_root < rb:
        hw_b = hw(rb)
        pts.append((r_root, hw_b * r_root / rb))  # radial line below base circle
        pts.append((rb, hw_b))
    else:
        pts.append((r_root, hw(r_root)))
    for r in (rp, (rp + r_tip) / 2.0, r_tip):
        pts.append((r, hw(r)))
    return pts


def _validate_tooth(module, teeth, width, pressure_angle_deg, backlash):
    if module <= 0 or width <= 0:
        raise ValueError("module and width must be positive")
    if int(teeth) != teeth or teeth < 2:
        raise ValueError(f"teeth must be an integer >= 2, got {teeth}")
    if backlash < 0:
        raise ValueError("backlash must be >= 0")
    if not 10.0 <= pressure_angle_deg <= 30.0:
        raise ValueError("pressure_angle_deg must be in [10, 30]")
    # rack tip half-width must stay positive (same bound the gear tip obeys)
    tan_a = math.tan(math.radians(pressure_angle_deg))
    if math.pi * module / 4.0 - backlash - module * tan_a <= 0:
        raise ValueError(
            f"tooth tip degenerates: backlash {backlash} too large for module {module}"
        )


def _prism(profile_pts, width):
    """Mirror (x, hw) flank points into a closed polygon and extrude to width
    (centered on z = 0). ``profile_pts`` runs root->tip."""
    from build123d import Polygon, extrude

    poly = [(x, -h) for x, h in profile_pts] + [(x, h) for x, h in reversed(profile_pts)]
    return extrude(Polygon(*poly, align=None), amount=width / 2.0, both=True)


def gear(
    module: float,
    teeth: int,
    width: float,
    *,
    bore: float = 0.0,
    hub_dia: float | None = None,
    hub_len: float = 0.0,
    pressure_angle_deg: float = 20.0,
    tooth_phase_deg: float = 0.0,
    backlash: float = 0.05,
    label: str = "gear",
) -> Any:
    """One labeled spur-gear solid: root cylinder + ``teeth`` involute-polyline
    teeth (+ optional hub), centered on z = 0 with the axis along +Z.

    Tooth CENTERS sit at ``tooth_phase_deg + j * 360/teeth``; use
    :func:`rack_mesh_phase_deg` to phase the gear against a rack. ``bore``
    drills a through hole (must leave a rim inside the root circle). The hub
    (KHK shape-S1 style) extends ``hub_len`` beyond the +Z face. ``teeth`` >= 6
    for a meaningful pinion.
    """
    _validate_tooth(module, teeth, width, pressure_angle_deg, backlash)
    if teeth < 6:
        raise ValueError(f"gear needs teeth >= 6, got {teeth}")
    rp = pitch_radius(module, teeth)
    r_root = rp - 1.25 * module
    if r_root <= 0:
        raise ValueError(f"root radius <= 0 (module {module}, teeth {teeth})")
    if bore < 0 or (bore > 0 and bore / 2.0 >= r_root - 0.5 * module):
        raise ValueError(f"bore {bore} leaves no rim inside root dia {2 * r_root:.2f}")
    if hub_dia is not None:
        if hub_len <= 0 or hub_dia <= bore or hub_dia > 2 * r_root:
            raise ValueError("hub needs hub_len > 0 and bore < hub_dia <= root diameter")

    from build123d import Cylinder, Pos, Rot

    flank = _gear_flank_pts(module, teeth, pressure_angle_deg, backlash)
    r0, hw0 = flank[0]
    flank = [(r0 - _FUSE_INSET, hw0 * (r0 - _FUSE_INSET) / r0)] + flank
    tooth0 = _prism(flank, width)

    body = Cylinder(r_root + 0.05, width)  # centered on z=0
    for j in range(int(teeth)):
        body = body + Rot(0, 0, tooth_phase_deg + 360.0 * j / teeth) * tooth0
    if hub_dia is not None:
        body = body + Pos(0, 0, width / 2.0 + hub_len / 2.0) * Cylinder(
            hub_dia / 2.0, hub_len
        )
    if bore > 0:
        total = width + (hub_len if hub_dia is not None else 0.0)
        body = body - Pos(0, 0, (total - width) / 2.0) * Cylinder(bore / 2.0, total + 2.0)
    label_shape(body, label)
    return body


def gear_rack(
    module: float,
    teeth: int,
    width: float,
    *,
    back_thick: float | None = None,
    pressure_angle_deg: float = 20.0,
    backlash: float = 0.05,
    label: str = "rack",
) -> Any:
    """One labeled rack solid in the rack LOCAL frame: pitch line at x = 0,
    ``teeth`` straight-flank (exact reference profile) teeth facing +X with
    centers on the y = k * pitch lattice (k integer, roughly centered on
    y = 0), back bar toward -X, centered on z = 0. Place at
    x = -pitch_radius(...) to mesh the gear.
    """
    _validate_tooth(module, teeth, width, pressure_angle_deg, backlash)
    back_thick = 2.5 * module if back_thick is None else back_thick
    if back_thick <= 0:
        raise ValueError("back_thick must be positive")

    from build123d import Box, Pos

    pitch = math.pi * module
    tan_a = math.tan(math.radians(pressure_angle_deg))
    hw_pitch = pitch / 4.0 - backlash
    x_root, x_tip = -1.25 * module, module
    x0 = x_root - _FUSE_INSET
    tooth0 = _prism(
        [(x0, hw_pitch - x0 * tan_a), (x_tip, hw_pitch - x_tip * tan_a)], width
    )

    k0 = -((int(teeth) - 1) // 2)
    ks = [k0 + i for i in range(int(teeth))]
    y_lo = ks[0] * pitch - pitch / 2.0
    y_hi = ks[-1] * pitch + pitch / 2.0
    body = Pos(x_root - back_thick / 2.0, (y_lo + y_hi) / 2.0, 0.0) * Box(
        back_thick, y_hi - y_lo, width
    )
    for k in ks:
        body = body + Pos(0.0, k * pitch, 0.0) * tooth0
    label_shape(body, label)
    return body


def rack_pinion_poses(
    module,
    teeth,
    width,
    *,
    rack_teeth,
    angle_deg,
    rack_y_offset: float = 0.0,
    samples: int = 24,
    bore: float = 0.0,
    back_thick=None,
    pressure_angle_deg: float = 20.0,
    backlash: float = 0.05,
    labels=("pinion", "rack"),
):
    """Yield (theta_deg, parts) frames rolling the mesh through ``angle_deg``.

    The gear is phased with :func:`rack_mesh_phase_deg` for the rack at
    ``rack_y_offset`` (rack placed at x = -pitch_radius), then each frame
    rotates the gear by theta and slides the rack by -R * radians(theta):
    pure rolling, so a correct mesh stays clear at EVERY sample."""
    rp = pitch_radius(module, teeth)
    g0 = gear(
        module, teeth, width, bore=bore,
        pressure_angle_deg=pressure_angle_deg, backlash=backlash,
        tooth_phase_deg=rack_mesh_phase_deg(module, teeth, rack_y_offset),
        label=labels[0],
    )
    r0 = gear_rack(
        module, rack_teeth, width, back_thick=back_thick,
        pressure_angle_deg=pressure_angle_deg, backlash=backlash, label=labels[1],
    ).translate((-rp, rack_y_offset, 0.0))
    label_shape(r0, labels[1])

    from build123d import Axis

    axis = Axis((0, 0, 0), (0, 0, 1))
    for i in range(samples + 1):
        theta = angle_deg * i / samples
        dy = -rp * math.radians(theta)
        yield theta, [
            (labels[0], g0.rotate(axis, theta)),
            (labels[1], r0.translate((0.0, dy, 0.0))),
        ]


def check_geometry(shape: Any, *, sweep_args: dict | None = None) -> None:
    """Acceptance gate: valid solid(s); for a multi-part compound (e.g. a meshed
    pinion + rack) the mesh must be interference-FREE with NO allowance -- a
    correctly phased involute-polyline mesh has real backlash clearance, so any
    overlap means the phase or the geometry is wrong. With ``sweep_args`` (the
    :func:`rack_pinion_poses` kwargs) the mesh is additionally ROLLED through
    the whole travel and must stay clear at every sample (strict tol; no
    baseline allowance needed because the seated mesh is already clear)."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="gear part")
    children = getattr(shape, "children", None) or []
    if len(children) >= 2:
        assert_no_interference(shape)
    if sweep_args is not None:
        labels = tuple(sweep_args.get("labels", ("pinion", "rack")))
        assert_motion_clear(
            rack_pinion_poses(**sweep_args),
            [labels],
            label="rack-pinion rolling sweep",
        )
