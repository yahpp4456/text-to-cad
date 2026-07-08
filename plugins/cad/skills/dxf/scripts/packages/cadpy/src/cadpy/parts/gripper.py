"""Parametric simplified parallel pneumatic gripper (L3 substitute part).

A body block plus two fingers (jaws) that translate symmetrically in +/-X to open
and close. An envelope/motion proxy for a parallel pneumatic gripper (e.g. AirTAC
HFZ): each finger is seated into the body top (intended ``body~jaw`` contact, like
a cylinder rod in its barrel) and the two fingers are always held apart by at
least ``min_gap`` so they never collide. The faithful multi-material mechanism
(pistons, wedge/rack drive) is step.parts' job; this only has to occupy the right
envelope and expose the jaw opening so a mechanism that consumes it can be checked
for fit and interference.

Built with the body base at z = 0; the fingers exit the +Z face and slide along X.
``opening`` in [0, stroke] is the TOTAL jaw separation added beyond the closed gap
(each finger moves ``opening / 2``). The envelope is a bore/stroke-proportional
proxy: only ``bore`` and ``stroke`` come from the catalog; the body/finger sizes
default to proportions that keep the fingers seated on the body at full open.
"""

from __future__ import annotations

from typing import Any

from cadpy.assembly import label_shape


def _resolve_dims(
    bore, stroke, body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage
):
    """Fill any unset dimension with a bore/stroke-proportional default and return
    them all. The defaults keep the fingers seated in the body top and over the
    body footprint at full open, so any positive ``bore``/``stroke`` yields a valid
    substitute."""
    jaw_t = 0.4 * bore if jaw_t is None else jaw_t
    jaw_w = 0.8 * bore if jaw_w is None else jaw_w
    jaw_len = 1.3 * bore if jaw_len is None else jaw_len
    min_gap = 0.5 * bore if min_gap is None else min_gap
    engage = 0.4 * bore if engage is None else engage
    body_h = 1.4 * bore if body_h is None else body_h
    body_w = (jaw_w + 0.5 * bore) if body_w is None else body_w
    # long enough to host both fingers seated over the body at full open, + margin
    body_l = (min_gap + stroke + 2.0 * jaw_t + 0.8 * bore) if body_l is None else body_l
    return body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage


def _body(body_l, body_w, body_h):
    from build123d import Box, Pos

    return Pos(0.0, 0.0, body_h / 2.0) * Box(body_l, body_w, body_h)


def _jaw(jaw_t, jaw_w, jaw_len, body_h, engage, x_center):
    from build123d import Box, Pos

    h = jaw_len + engage  # finger protrudes jaw_len above the body, engage below
    z_center = body_h - engage + h / 2.0  # spans [body_h - engage, body_h + jaw_len]
    return Pos(x_center, 0.0, z_center) * Box(jaw_t, jaw_w, h)


def _jaw_centers(min_gap, jaw_t, opening):
    """(x_center_a, x_center_b) of the two fingers at ``opening`` (a on -X)."""
    off = min_gap / 2.0 + opening / 2.0 + jaw_t / 2.0
    return -off, off


def _check_body_hosts_jaws(body_l, stroke, jaw_t, min_gap):
    """The fingers must stay over the body footprint at full open; raise otherwise
    (the gripper's ``off the body`` guard, like the linear guide's off-rail check)."""
    max_off = min_gap / 2.0 + stroke / 2.0 + jaw_t  # outer-face offset at full open
    if max_off > body_l / 2.0 + 1e-9:
        raise ValueError(
            f"body_l {body_l} too short: fingers run off the body at full open "
            f"(need body_l >= {2.0 * max_off:.3f})"
        )


def gripper(
    bore: float,
    stroke: float,
    *,
    opening: float = 0.0,
    body_l: float | None = None,
    body_w: float | None = None,
    body_h: float | None = None,
    jaw_len: float | None = None,
    jaw_t: float | None = None,
    jaw_w: float | None = None,
    min_gap: float | None = None,
    engage: float | None = None,
    label_prefix: str = "gripper",
) -> Any:
    """Body + two fingers compound, jaws opened by ``opening`` (total separation).

    Returns a labeled Compound(``<prefix>_body``, ``<prefix>_jaw_a``,
    ``<prefix>_jaw_b``). ``jaw_a`` is on -X, ``jaw_b`` on +X; each moves
    ``opening / 2`` outward. Unset dimensions default to bore/stroke proportions.
    Raises if ``opening`` is outside ``[0, stroke]``, if a finger is wider than the
    body, if ``engage`` reaches through the body, or if the body is too short to
    keep the fingers seated at full open.
    """
    if bore <= 0 or stroke < 0:
        raise ValueError("bore must be > 0 and stroke >= 0")
    if not -1e-9 <= opening <= stroke + 1e-9:
        raise ValueError(f"opening {opening} must be in [0, stroke={stroke}]")
    body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage = _resolve_dims(
        bore, stroke, body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage
    )
    if min(body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage) <= 0:
        raise ValueError("all gripper dimensions must be positive")
    if jaw_w > body_w + 1e-9:
        raise ValueError(f"jaw_w {jaw_w} must not exceed body_w {body_w}")
    if engage >= body_h:
        raise ValueError(f"engage {engage} must be less than body_h {body_h}")
    _check_body_hosts_jaws(body_l, stroke, jaw_t, min_gap)

    from build123d import Compound

    body = _body(body_l, body_w, body_h)
    xa, xb = _jaw_centers(min_gap, jaw_t, opening)
    jaw_a = _jaw(jaw_t, jaw_w, jaw_len, body_h, engage, xa)
    jaw_b = _jaw(jaw_t, jaw_w, jaw_len, body_h, engage, xb)
    label_shape(body, f"{label_prefix}_body")
    label_shape(jaw_a, f"{label_prefix}_jaw_a")
    label_shape(jaw_b, f"{label_prefix}_jaw_b")
    return Compound(label=label_prefix, children=[body, jaw_a, jaw_b])


def gripper_poses(
    bore,
    stroke,
    *,
    samples: int = 20,
    label_prefix: str = "gripper",
    body_l=None,
    body_w=None,
    body_h=None,
    jaw_len=None,
    jaw_t=None,
    jaw_w=None,
    min_gap=None,
    engage=None,
):
    """Yield (opening, parts) frames opening the jaws 0 -> stroke (body + fingers
    built once; each finger only translates in +/-X)."""
    body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage = _resolve_dims(
        bore, stroke, body_l, body_w, body_h, jaw_len, jaw_t, jaw_w, min_gap, engage
    )
    _check_body_hosts_jaws(body_l, stroke, jaw_t, min_gap)
    body = _body(body_l, body_w, body_h)
    xa0, xb0 = _jaw_centers(min_gap, jaw_t, 0.0)
    jaw_a0 = _jaw(jaw_t, jaw_w, jaw_len, body_h, engage, xa0)
    jaw_b0 = _jaw(jaw_t, jaw_w, jaw_len, body_h, engage, xb0)
    label_shape(body, f"{label_prefix}_body")
    label_shape(jaw_a0, f"{label_prefix}_jaw_a")
    label_shape(jaw_b0, f"{label_prefix}_jaw_b")
    for i in range(samples + 1):
        o = stroke * i / samples
        yield o, [
            (f"{label_prefix}_body", body),
            (f"{label_prefix}_jaw_a", jaw_a0.translate((-o / 2.0, 0.0, 0.0))),
            (f"{label_prefix}_jaw_b", jaw_b0.translate((o / 2.0, 0.0, 0.0))),
        ]


def check_geometry(shape: Any, *, sweep_args: dict | None = None) -> None:
    """Acceptance gate: valid solids, only the intended ``body~jaw`` contacts (the
    two fingers seated in the body, never touching each other), and -- when
    ``sweep_args`` is given -- an open sweep that confirms the fingers never
    collide along the travel.

    Honest scope: the fingers translate in X as uniform prisms, so both the
    ``body~jaw`` overlap and the ``jaw_a~jaw_b`` separation are translation-invariant
    (identically their closed-pose values at every opening). Opening only pushes the
    fingers APART, so the sweep cannot see a mid-travel collision for this shape; the
    real guards are the constant ``min_gap`` (close side, static) and the
    constructor's ``off the body`` range check (open side). The sweep documents the
    motion and guards a future non-uniform change."""
    from cadpy.geometry_checks import (
        assert_all_valid,
        assert_motion_clear,
        assert_no_interference,
    )

    assert_all_valid(shape, label="gripper part")
    body, jaw_a, jaw_b = (c.label for c in shape.children)
    assert_no_interference(shape, allow=[(body, jaw_a), (body, jaw_b)])
    if sweep_args is not None:
        prefix = sweep_args.get("label_prefix", "gripper")
        seated = next(iter(gripper_poses(**sweep_args)))[1]  # closed pose = baseline
        assert_motion_clear(
            gripper_poses(**sweep_args),
            [(f"{prefix}_jaw_a", f"{prefix}_jaw_b")],
            baseline=seated,
            label="jaw open sweep",
        )
