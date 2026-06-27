"""Parametric simplified linear motion guide (L3 substitute part).

A profiled rail + a carriage block that straddles it with running clearance and
slides along it. An envelope/motion proxy (no recirculating balls). Built along
+X with the rail on z = 0, x in [0, rail_len]; the block rides at ``block_pos``.

This is a part that TRAVELS, so its acceptance gate includes a motion sweep: the
carriage is swept the length of the rail and must never penetrate it (the running
clearance is constant), and the generator refuses a ``block_pos`` that would run
the carriage off the rail.
"""

from __future__ import annotations

from typing import Any

from cadpy.assembly import label_shape

_CLEARANCE = 0.4  # running clearance between carriage channel and rail (mm)


def _rail(rail_width, rail_height, rail_len):
    from build123d import Box, Pos

    return Pos(rail_len / 2.0, 0.0, rail_height / 2.0) * Box(
        rail_len, rail_width, rail_height
    )


def _block(rail_width, rail_height, block_width, block_height, block_len, block_pos):
    from build123d import Box, Pos

    bottom_z = rail_height * 0.3                 # carriage wraps the upper rail sides
    xc = block_pos + block_len / 2.0
    outer = Pos(xc, 0.0, bottom_z + block_height / 2.0) * Box(
        block_len, block_width, block_height
    )
    # channel cut (rail + clearance), opened through the block bottom
    slot_z0 = bottom_z - 1.0
    slot_z1 = rail_height + _CLEARANCE
    slot = Pos(xc, 0.0, (slot_z0 + slot_z1) / 2.0) * Box(
        block_len + 2.0, rail_width + 2.0 * _CLEARANCE, slot_z1 - slot_z0
    )
    return outer - slot


def _check_block_pos(rail_len, block_len, block_pos):
    travel = rail_len - block_len
    if travel < 0:
        raise ValueError(f"rail_len {rail_len} shorter than block_len {block_len}")
    if not -1e-9 <= block_pos <= travel + 1e-9:
        raise ValueError(
            f"block_pos {block_pos} runs the carriage off the rail [0, {travel}]"
        )
    return travel


def linear_guide(
    rail_width: float,
    rail_height: float,
    rail_len: float,
    block_width: float,
    block_height: float,
    block_len: float,
    *,
    block_pos: float = 0.0,
    label_prefix: str = "guide",
) -> Any:
    """Rail + carriage compound, carriage at ``block_pos`` along the rail.

    Returns a labeled Compound(``<prefix>_rail``, ``<prefix>_block``). Raises if
    ``block_pos`` is outside ``[0, rail_len - block_len]`` (off the rail).
    """
    if min(rail_width, rail_height, rail_len, block_width, block_height, block_len) <= 0:
        raise ValueError("all guide dimensions must be positive")
    if block_width <= rail_width + 2.0 * _CLEARANCE:
        raise ValueError("block_width must exceed the rail width plus clearance")
    _check_block_pos(rail_len, block_len, block_pos)

    from build123d import Compound

    rail = _rail(rail_width, rail_height, rail_len)
    block = _block(
        rail_width, rail_height, block_width, block_height, block_len, block_pos
    )
    label_shape(rail, f"{label_prefix}_rail")
    label_shape(block, f"{label_prefix}_block")
    return Compound(label=label_prefix, children=[rail, block])


def linear_guide_poses(
    rail_width,
    rail_height,
    rail_len,
    block_width,
    block_height,
    block_len,
    *,
    samples: int = 20,
    label_prefix: str = "guide",
):
    """Yield (block_pos, parts) frames sweeping the carriage along the whole rail
    (built once; only the block translates)."""
    travel = _check_block_pos(rail_len, block_len, 0.0)
    rail = _rail(rail_width, rail_height, rail_len)
    label_shape(rail, f"{label_prefix}_rail")
    block0 = _block(
        rail_width, rail_height, block_width, block_height, block_len, 0.0
    )
    label_shape(block0, f"{label_prefix}_block")
    for i in range(samples + 1):
        pos = travel * i / samples
        yield pos, [
            (f"{label_prefix}_rail", rail),
            (f"{label_prefix}_block", block0.translate((pos, 0.0, 0.0))),
        ]


def check_geometry(shape: Any, *, sweep_args: dict | None = None) -> None:
    """Acceptance gate: valid solids, no static interference (running clearance),
    and -- when ``sweep_args`` is given -- a full-rail sweep that confirms the
    constant running clearance holds along the travel.

    Honest scope: the carriage is a uniform cross-section translated along its own
    axis past a uniform rail, so the pairwise overlap is translation-invariant
    (identically the static clearance at every frame). The sweep therefore cannot
    detect localized binding for this shape -- it guards against a future
    non-uniform change and documents the running clearance. The real "off the
    rail" guard is the constructor's ``block_pos`` range check. (Localized
    mid-travel clashes are caught where a part meets a non-uniform obstacle, e.g.
    the motorized_linear_stage carriage vs the bearing pillars.)"""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="guide part")
    assert_no_interference(shape)
    if sweep_args is not None:
        prefix = sweep_args.get("label_prefix", "guide")
        # seated reference pose (carriage at one end) -> its (zero) contact is the
        # baseline; a list of (name, shape) is read as a reference pose, not a
        # pair->volume map.
        seated = next(iter(linear_guide_poses(**sweep_args)))[1]
        assert_motion_clear(
            linear_guide_poses(**sweep_args),
            [(f"{prefix}_rail", f"{prefix}_block")],
            baseline=seated,
            label="carriage sweep",
        )
