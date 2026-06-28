"""Parametric simplified pneumatic-cylinder stand-in (L3 substitute part).

This is a fit/selection/motion proxy, NOT a faithful tie-rod cylinder: a solid
barrel body plus a piston rod that protrudes by ``extension``. The faithful
multi-material geometry is step.parts' job; this only has to occupy the right
envelope and expose the rod motion so a mechanism that consumes it can be checked
for fit and interference.

Built along +Z with the body base at z = 0; the rod exits the +Z end.
"""

from __future__ import annotations

from typing import Any

from cadpy.assembly import label_shape

# The rod stays engaged this far (x bore) inside the barrel even fully extended,
# so the body~rod pair is always intended contact, never a separation defect.
_ROD_ENGAGE = 0.4


def pneumatic_cylinder(
    bore: float,
    stroke: float,
    *,
    extension: float = 0.0,
    rod_dia: float | None = None,
    body_dia: float | None = None,
    rod_protrusion: float = 0.0,
    label_prefix: str = "cyl",
) -> Any:
    """A barrel + rod compound, rod protruding by ``rod_protrusion + extension``.

    ``extension`` in [0, stroke] is the stroke-driven travel; ``rod_protrusion``
    is the fixed amount the rod always sticks out beyond the body face even fully
    RETRACTED (extension 0) -- the exposed rod end a real cylinder presents for a
    clevis/coupling. Default 0 keeps the rod flush at retraction. ``rod_dia`` /
    ``body_dia`` default to bore-proportional values when not given (use the
    selected row's values for a real part). Children are labeled ``<prefix>_body``
    and ``<prefix>_rod`` so an interference check can name and allow their
    (intended) bore contact.
    """
    if bore <= 0 or stroke < 0:
        raise ValueError("bore must be > 0 and stroke >= 0")
    if not -1e-9 <= extension <= stroke + 1e-9:
        raise ValueError(f"extension {extension} must be in [0, stroke={stroke}]")
    if rod_protrusion < 0:
        raise ValueError("rod_protrusion must be >= 0")
    if rod_dia is None:
        rod_dia = 0.4 * bore
    if not 0 < rod_dia < bore:
        raise ValueError(f"rod_dia {rod_dia} must be in (0, bore={bore})")
    if body_dia is None:
        body_dia = 1.3 * bore
    if body_dia <= bore:
        raise ValueError(f"body_dia {body_dia} must be > bore {bore}")

    from build123d import Compound, Cylinder, Pos

    body_len = stroke + 0.6 * bore  # barrel houses the piston travel + caps
    body = Pos(0.0, 0.0, body_len / 2.0) * Cylinder(body_dia / 2.0, body_len)

    engage = _ROD_ENGAGE * bore
    rod_bottom = body_len - engage
    rod_top = body_len + rod_protrusion + extension
    rod = Pos(0.0, 0.0, (rod_bottom + rod_top) / 2.0) * Cylinder(
        rod_dia / 2.0, rod_top - rod_bottom
    )

    label_shape(body, f"{label_prefix}_body")
    label_shape(rod, f"{label_prefix}_rod")
    return Compound(label=label_prefix, children=[body, rod])


def check_geometry(shape: Any) -> None:
    """Acceptance gate for a generated cylinder: valid solids + only the intended
    bore contact (body~rod). No motion sweep here: the rod extends monotonically
    out of the body, so a seated-baseline sweep can only see overlap DECREASE --
    the cylinder's motion is validated in the mechanism that consumes it (the
    rack_pinion full-stroke sweep)."""
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="cylinder part")
    labels = [c.label for c in shape.children]
    assert_no_interference(shape, allow=[tuple(labels)])
