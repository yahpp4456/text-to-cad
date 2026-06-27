"""Parametric simplified ball screw (L3 substitute part).

A screw shaft (smooth major-diameter cylinder, no thread) + a nut (bored cylinder)
that travels along it with running clearance. An envelope/motion proxy; the real
thread/ball track is step.parts' job. Built along +X, x in [0, screw_len]; the nut
rides at ``nut_pos``.

Like the linear guide, the nut TRAVELS, so the gate sweeps it the length of the
screw (clearance is constant, so it must stay penetration-free) and refuses a
``nut_pos`` that would run the nut off the screw.
"""

from __future__ import annotations

from typing import Any

from cadpy.assembly import label_shape

_CLEARANCE = 0.5  # running clearance between nut bore and screw major dia (mm)


def _x_cylinder(radius, x0, x1):
    from build123d import Cylinder, Pos, Rot

    return Pos((x0 + x1) / 2.0, 0.0, 0.0) * Rot(0.0, 90.0, 0.0) * Cylinder(radius, x1 - x0)


def _screw(screw_dia, screw_len):
    return _x_cylinder(screw_dia / 2.0, 0.0, screw_len)


def _nut(screw_dia, nut_dia, nut_len, nut_pos):
    outer = _x_cylinder(nut_dia / 2.0, nut_pos, nut_pos + nut_len)
    bore = _x_cylinder(screw_dia / 2.0 + _CLEARANCE, nut_pos - 1.0, nut_pos + nut_len + 1.0)
    return outer - bore


def _check_nut_pos(screw_len, nut_len, nut_pos):
    travel = screw_len - nut_len
    if travel < 0:
        raise ValueError(f"screw_len {screw_len} shorter than nut_len {nut_len}")
    if not -1e-9 <= nut_pos <= travel + 1e-9:
        raise ValueError(
            f"nut_pos {nut_pos} runs the nut off the screw [0, {travel}]"
        )
    return travel


def ball_screw(
    screw_dia: float,
    lead: float,
    screw_len: float,
    nut_dia: float,
    nut_len: float,
    *,
    nut_pos: float = 0.0,
    label_prefix: str = "screw",
) -> Any:
    """Screw shaft + nut compound, nut at ``nut_pos`` along the screw.

    ``lead`` is carried for provenance (it does not change the smooth envelope).
    Returns a labeled Compound(``<prefix>_shaft``, ``<prefix>_nut``). Raises if
    ``nut_pos`` is outside ``[0, screw_len - nut_len]`` (off the screw) or if the
    nut bore would not clear the screw.
    """
    if min(screw_dia, lead, screw_len, nut_dia, nut_len) <= 0:
        raise ValueError("all ball-screw dimensions must be positive")
    if nut_dia <= screw_dia + 2.0 * _CLEARANCE:
        raise ValueError("nut_dia must exceed the screw major dia plus clearance")
    _check_nut_pos(screw_len, nut_len, nut_pos)

    from build123d import Compound

    shaft = _screw(screw_dia, screw_len)
    nut = _nut(screw_dia, nut_dia, nut_len, nut_pos)
    label_shape(shaft, f"{label_prefix}_shaft")
    label_shape(nut, f"{label_prefix}_nut")
    return Compound(label=label_prefix, children=[shaft, nut])


def ball_screw_poses(
    screw_dia,
    lead,
    screw_len,
    nut_dia,
    nut_len,
    *,
    samples: int = 20,
    label_prefix: str = "screw",
):
    """Yield (nut_pos, parts) frames sweeping the nut along the whole screw
    (built once; only the nut translates)."""
    travel = _check_nut_pos(screw_len, nut_len, 0.0)
    shaft = _screw(screw_dia, screw_len)
    label_shape(shaft, f"{label_prefix}_shaft")
    nut0 = _nut(screw_dia, nut_dia, nut_len, 0.0)
    label_shape(nut0, f"{label_prefix}_nut")
    for i in range(samples + 1):
        pos = travel * i / samples
        yield pos, [
            (f"{label_prefix}_shaft", shaft),
            (f"{label_prefix}_nut", nut0.translate((pos, 0.0, 0.0))),
        ]


def check_geometry(shape: Any, *, sweep_args: dict | None = None) -> None:
    """Acceptance gate: valid solids, no static interference (the nut bore clears
    the screw), and -- when ``sweep_args`` is given -- a full-length sweep that
    confirms the constant running clearance holds along the travel.

    Honest scope: the nut is a uniform annulus translated along the screw axis past
    a uniform shaft, so the overlap is translation-invariant (identically the
    static clearance at every frame). The sweep cannot detect localized binding for
    this shape; the "off the screw" guard is the constructor's ``nut_pos`` range
    check. A travelling nut that meets a non-uniform obstacle is caught at the
    assembly level (see motorized_linear_stage)."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="ball-screw part")
    assert_no_interference(shape)
    if sweep_args is not None:
        prefix = sweep_args.get("label_prefix", "screw")
        seated = next(iter(ball_screw_poses(**sweep_args)))[1]
        assert_motion_clear(
            ball_screw_poses(**sweep_args),
            [(f"{prefix}_shaft", f"{prefix}_nut")],
            baseline=seated,
            label="nut sweep",
        )
