"""Parametric simplified deep-groove ball bearing (L3 substitute part).

Two concentric rings (outer + inner) with a raceway gap between them; the balls
are NOT modeled (a fit/envelope proxy, not a faithful bearing). Because the rings
are separated by the raceway gap, a correct part has NO interference at all --
the gate proves the rings do not touch, which a too-thick ring or a swapped
bore/OD would violate.

Built along +Z, ring faces at z in [0, width].
"""

from __future__ import annotations

from typing import Any

from cadpy.assembly import label_shape


def deep_groove_bearing(
    bore: float,
    od: float,
    width: float,
    *,
    label_prefix: str = "brg",
) -> Any:
    """Outer ring + inner ring as concentric annuli with a raceway gap.

    Returns a labeled Compound(``<prefix>_outer``, ``<prefix>_inner``). The gap
    keeps the rings non-touching, mirroring the ball track of a real bearing.
    """
    if not 0 < bore < od:
        raise ValueError(f"need 0 < bore ({bore}) < od ({od})")
    if width <= 0:
        raise ValueError("width must be positive")

    from build123d import Compound, Cylinder, Pos

    pitch = (od + bore) / 4.0           # ball pitch radius
    gap = (od - bore) / 8.0             # half the raceway gap each side of pitch

    def ring(r_outer: float, r_inner: float):
        outer = Pos(0.0, 0.0, width / 2.0) * Cylinder(r_outer, width)
        bore_cut = Pos(0.0, 0.0, width / 2.0) * Cylinder(r_inner, width + 2.0)
        return outer - bore_cut

    outer_ring = ring(od / 2.0, pitch + gap)
    inner_ring = ring(pitch - gap, bore / 2.0)
    label_shape(outer_ring, f"{label_prefix}_outer")
    label_shape(inner_ring, f"{label_prefix}_inner")
    return Compound(label=label_prefix, children=[outer_ring, inner_ring])


def check_geometry(shape: Any) -> None:
    """Acceptance gate: valid solids and NO interference -- the inner and outer
    rings must stay separated by the raceway gap (static part, no motion)."""
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="bearing ring")
    assert_no_interference(shape)
