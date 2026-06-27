"""Parametric simplified NEMA stepper motor (L3 substitute part).

Square body (NEMA face) + front pilot boss + output shaft. A mounting/envelope
proxy, not a faithful motor. Built along +Z with the mounting face at z = 0, body
below (z < 0), shaft and pilot protruding +Z.
"""

from __future__ import annotations

from typing import Any

from cadpy.assembly import label_shape


def stepper_motor(
    face: float,
    body_len: float,
    shaft_dia: float,
    shaft_len: float,
    *,
    pilot_dia: float | None = None,
    pilot_len: float = 2.0,
    label_prefix: str = "motor",
) -> Any:
    """Square body + pilot boss + shaft.

    Returns a labeled Compound(``<prefix>_body``, ``<prefix>_shaft``). The shaft
    root is embedded in the body (intended contact); the pilot boss is fused into
    the body. ``pilot_dia`` defaults below the face and must stay smaller than it.
    """
    if face <= 0 or body_len <= 0:
        raise ValueError("face and body_len must be positive")
    if not 0 < shaft_dia < face:
        raise ValueError(f"need 0 < shaft_dia ({shaft_dia}) < face ({face})")
    if shaft_len <= 0:
        raise ValueError("shaft_len must be positive")
    if pilot_dia is None:
        pilot_dia = min(22.0, 0.6 * face)
    if not shaft_dia < pilot_dia < face:
        raise ValueError(
            f"need shaft_dia ({shaft_dia}) < pilot_dia ({pilot_dia}) < face ({face})"
        )

    from build123d import Box, Compound, Cylinder, Pos

    body_box = Pos(0.0, 0.0, -body_len / 2.0) * Box(face, face, body_len)
    pilot = Pos(0.0, 0.0, pilot_len / 2.0) * Cylinder(pilot_dia / 2.0, pilot_len)
    body = body_box + pilot

    # Shaft runs from inside the body (root embedded -> intended contact) out past
    # the pilot by shaft_len.
    shaft = Pos(0.0, 0.0, (shaft_len - 4.0) / 2.0) * Cylinder(
        shaft_dia / 2.0, shaft_len + 4.0
    )

    label_shape(body, f"{label_prefix}_body")
    label_shape(shaft, f"{label_prefix}_shaft")
    return Compound(label=label_prefix, children=[body, shaft])


def check_geometry(shape: Any) -> None:
    """Acceptance gate: valid solids; the only interference is the shaft root
    seated in the body (intended)."""
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="motor part")
    labels = [c.label for c in shape.children]
    assert_no_interference(shape, allow=[tuple(labels)])
