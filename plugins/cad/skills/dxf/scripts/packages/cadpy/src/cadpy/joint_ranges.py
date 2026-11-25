"""How far a joint can really travel before something is hit.

A MOTION declaration says where a joint is driven: from its as-built pose
(``u = 0``) to the end of its stroke (``u = 1``). The sweep checks that range.
It does not say how much room is left beyond either end -- whether the stroke
stops a hair short of a collision, or whether nothing would stop the part at
all. This module searches outward from both ends for the first collision.

Pure search: the caller supplies ``collides(u)``, which poses the mechanism at
``u`` (any real number; ``u`` outside ``[0, 1]`` extrapolates the stroke) and
reports what is hit. No geometry is touched here, so the search is testable on
its own and the caller decides what "hit" means (which pairs, what tolerance).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

Hit = Any


@dataclass(frozen=True)
class Limit:
    """One side of the search.

    ``u`` is the furthest position found clear on this side. ``hit`` is what
    ``collides`` returned at the first colliding position (``None`` when the
    search ran out of extent without a collision -- no stop was found).
    ``blocked`` is True when the declared end itself collides, in which case
    ``u`` is that end and nothing beyond it was searched.
    """

    u: float
    hit: Hit | None
    blocked: bool = False

    @property
    def open(self) -> bool:
        """No collision anywhere in the searched extent."""
        return self.hit is None and not self.blocked


@dataclass(frozen=True)
class FreeTravel:
    lower: Limit   # searched from u = 0 toward negative u
    upper: Limit   # searched from u = 1 toward larger u
    evaluations: int

    @property
    def margin_before(self) -> float:
        """Clear travel below the as-built pose, in units of the stroke (>= 0)."""
        return max(0.0, 0.0 - self.lower.u)

    @property
    def margin_after(self) -> float:
        """Clear travel beyond the end of the stroke, in units of the stroke (>= 0)."""
        return max(0.0, self.upper.u - 1.0)


def _search(collides: Callable[[float], Hit | None], start: float, direction: int, *, step: float,
            max_extent: float, tolerance: float, count: list[int]) -> Limit:
    def probe(u: float) -> Hit | None:
        count[0] += 1
        return collides(u) or None

    hit = probe(start)
    if hit is not None:
        return Limit(start, hit, blocked=True)

    clear = start
    travelled = 0.0
    while travelled < max_extent - 1e-12:
        travelled = min(max_extent, travelled + step)
        u = start + direction * travelled
        hit = probe(u)
        if hit is None:
            clear = u
            continue
        # First collision between `clear` and `u`: bisect down to the tolerance.
        near, far, far_hit = clear, u, hit
        while abs(far - near) > tolerance:
            middle = (near + far) / 2.0
            middle_hit = probe(middle)
            if middle_hit is None:
                near = middle
            else:
                far, far_hit = middle, middle_hit
        return Limit(near, far_hit)
    return Limit(clear, None)


def free_travel(
    collides: Callable[[float], Hit | None],
    *,
    step: float = 0.05,
    max_extent: float = 0.5,
    tolerance: float | None = None,
) -> FreeTravel:
    """Search for the first collision beyond each end of the stroke.

    ``collides(u)`` returns a falsy value when the mechanism is clear at ``u``,
    or a description of the collision. ``step`` is the stride of the outward
    walk and ``max_extent`` how far to walk on each side, both in units of the
    stroke (``max_extent = 0.5`` looks half a stroke beyond each end).
    ``tolerance`` is how tightly the limit is bracketed (default ``step / 16``).

    A collision that begins and ends between two strides -- an obstacle
    narrower than ``step`` that the part passes clean through -- is not seen;
    choose ``step`` no larger than the thinnest thing in the way.
    """
    if not (step > 0 and max_extent >= 0):
        raise ValueError("free_travel: step must be positive and max_extent non-negative")
    tol = step / 16.0 if tolerance is None else float(tolerance)
    if not tol > 0:
        raise ValueError("free_travel: tolerance must be positive")
    count = [0]
    upper = _search(collides, 1.0, +1, step=step, max_extent=max_extent, tolerance=tol, count=count)
    lower = _search(collides, 0.0, -1, step=step, max_extent=max_extent, tolerance=tol, count=count)
    return FreeTravel(lower=lower, upper=upper, evaluations=count[0])
