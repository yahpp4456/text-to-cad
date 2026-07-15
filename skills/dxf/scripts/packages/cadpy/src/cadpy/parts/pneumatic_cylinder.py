"""Parametric simplified pneumatic-cylinder stand-in (L3 substitute part).

This is a fit/selection/motion proxy, NOT a faithful tie-rod cylinder: a barrel
body plus a piston rod that protrudes by ``extension``. The faithful multi-material
geometry is step.parts' job; this only has to occupy the right envelope and expose
the rod motion so a mechanism that consumes it can be checked for fit and
interference.

Two body shapes share one force/selection model (pneumatic force is pressure x
bore area regardless of shape):

- ``body_shape="round"`` (default): a round barrel of diameter ``body_dia`` -- the
  standard round-body cylinder (SMC CG1, Airtac SC).
- ``body_shape="square"``: a square block of width ``body_w`` with four corner
  through-holes -- the compact cylinder (SMC CQ2). The corner holes are the
  mounting-bolt bores that make a compact cylinder recognisable.

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
    body_shape: str = "round",
    body_w: float | None = None,
    corner_hole: float | None = None,
    base_len: float | None = None,
) -> Any:
    """A barrel + rod compound, rod protruding by ``rod_protrusion + extension``.

    ``extension`` in [0, stroke] is the stroke-driven travel; ``rod_protrusion``
    is the fixed amount the rod always sticks out beyond the body face even fully
    RETRACTED (extension 0) -- the exposed rod end a real cylinder presents for a
    clevis/coupling. Default 0 keeps the rod flush at retraction. ``rod_dia``
    defaults to a bore-proportional value when not given (use the selected row's
    value for a real part). Children are labeled ``<prefix>_body`` and
    ``<prefix>_rod`` so an interference check can name and allow their (intended)
    bore contact.

    Body length is ``base_len + stroke`` when ``base_len`` is given (a compact
    cylinder's datasheet body length), else the heuristic ``stroke + 0.6*bore``.

    ``body_shape``:

    - ``"round"`` -- round barrel; ``body_dia`` defaults to ``1.3*bore`` and must
      exceed the bore. ``body_w`` / ``corner_hole`` are ignored.
    - ``"square"`` -- square block of side ``body_w`` (default ``1.4*bore``, must
      exceed the bore). ``corner_hole`` (if given) drills four mounting-bolt
      through-holes near the corners; it must clear the bore and stay inside the
      block.
    """
    if bore <= 0 or stroke < 0:
        raise ValueError("bore must be > 0 and stroke >= 0")
    if not -1e-9 <= extension <= stroke + 1e-9:
        raise ValueError(f"extension {extension} must be in [0, stroke={stroke}]")
    if rod_protrusion < 0:
        raise ValueError("rod_protrusion must be >= 0")
    if body_shape not in ("round", "square"):
        raise ValueError(f"body_shape must be 'round' or 'square', got {body_shape!r}")
    if rod_dia is None:
        rod_dia = 0.4 * bore
    if not 0 < rod_dia < bore:
        raise ValueError(f"rod_dia {rod_dia} must be in (0, bore={bore})")
    if base_len is not None and base_len <= 0:
        raise ValueError("base_len must be > 0 when given")

    from build123d import Box, Compound, Cylinder, Pos

    body_len = (base_len + stroke) if base_len is not None else (stroke + 0.6 * bore)

    if body_shape == "round":
        if body_dia is None:
            body_dia = 1.3 * bore
        if body_dia <= bore:
            raise ValueError(f"body_dia {body_dia} must be > bore {bore}")
        body = Pos(0.0, 0.0, body_len / 2.0) * Cylinder(body_dia / 2.0, body_len)
    else:  # square
        if body_w is None:
            body_w = 1.4 * bore
        if body_w <= bore:
            raise ValueError(f"body_w {body_w} must be > bore {bore}")
        body = Pos(0.0, 0.0, body_len / 2.0) * Box(body_w, body_w, body_len)
        if corner_hole is not None:
            if corner_hole <= 0:
                raise ValueError("corner_hole must be > 0 when given")
            r = corner_hole / 2.0
            off = body_w / 2.0 - corner_hole  # hole center one hole-dia from the edge
            if off - r <= rod_dia / 2.0:
                raise ValueError(
                    f"corner_hole {corner_hole} too large: holes would reach the rod"
                )
            if off + r >= body_w / 2.0:
                raise ValueError(
                    f"corner_hole {corner_hole} too large: holes fall outside the block"
                )
            for sx in (1.0, -1.0):
                for sy in (1.0, -1.0):
                    body -= Pos(sx * off, sy * off, body_len / 2.0) * Cylinder(
                        r, body_len + 2.0
                    )

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
