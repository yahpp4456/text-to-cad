"""Holes of a part, found on its geometry, and the callout a drawing prints for them.

``find_holes`` reads the cylindrical faces of a solid: a hole is a full cylinder whose
material is on the outside. Coaxial walls that meet end to end are one stepped hole (a
counterbore over its bore); walls on one axis that do not meet are separate holes. A
wider wall between two narrower ones is a groove inside a bore, not a hole. Whether an
end is open is asked of the solid itself -- a ray from inside the hole along its axis
either meets the part again within a diameter of that end (a flat, drilled or ball
bottom) or it does not -- never inferred from the part's bounding box.

``group_holes`` gathers holes that are the same hole made several times (same direction,
diameter, depth and counterbore), which is what a drawing calls out once as ``4× ⌀6.6 THRU``.

``callout_text`` is adapted from text-to-cad's ``cad/eng_drawing.py`` (``hole_callout_text``;
MIT License, Copyright (c) earthtojake): the ISO/ASME symbols a shop reads.

Not found here, by design: countersinks (a cone, not a cylinder), threads (the model
carries no thread), slots, holes whose wall is split by another feature so that no
full circle remains, and holes of more than two steps.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

__all__ = ["Hole", "HoleGroup", "callout_text", "find_holes", "group_holes", "is_concave_cylinder"]

FULL_TURN_TOLERANCE = 1e-3      # rad short of 2*pi still counts as a full circle
AXIS_ROUND = 3                  # decimals: walls on the same line within a micron-ish
MEET_TOLERANCE = 1e-4           # axial gap under which two walls meet end to end
MIN_DIAMETER = 0.5
MAX_HOLES = 400


@dataclass
class Hole:
    """One hole. ``top`` is the centre of its mouth (an open end; of a counterbored hole,
    the counterbore's); ``direction`` points from the mouth into the part."""

    top: tuple[float, float, float]
    direction: tuple[float, float, float]
    diameter: float
    depth: float
    thru: bool
    cbore: tuple[float, float] | None = None   # (diameter, depth) of a counterbore at the mouth


@dataclass
class HoleGroup:
    """Holes a drawing calls out once."""

    direction: tuple[float, float, float]
    diameter: float
    depth: float | None       # None when thru
    thru: bool
    cbore: tuple[float, float] | None
    holes: list[Hole] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.holes)


def _fmt(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def callout_text(group: HoleGroup, *, diameter_sign: str = "⌀", cbore_sign: str = "⌴") -> str:
    """``4× ⌀6.6 THRU``, ``⌀5 ↧12``, with a counterbore ``⌴ ⌀11 ↧6.5`` after it. The signs
    are arguments because a font may lack them (the counterbore sign, often)."""
    lead = f"{group.count}× " if group.count > 1 else ""
    size = f"{diameter_sign}{_fmt(group.diameter)}"
    if group.thru:
        size += " THRU"
    elif group.depth is not None:
        size += f" ↧{_fmt(group.depth)}"
    parts = [lead + size]
    if group.cbore:
        diameter, depth = group.cbore
        parts.append(f"{cbore_sign} {diameter_sign}{_fmt(diameter)} ↧{_fmt(depth)}")
    return "  ".join(parts)


def _canonical(direction: tuple[float, float, float]) -> tuple[float, float, float]:
    """A direction and its opposite are one axis: the first non-zero component positive."""
    x, y, z = direction
    for component in (x, y, z):
        if abs(component) > 1e-9:
            if component < 0:
                x, y, z = -x, -y, -z
            break
    return (x + 0.0, y + 0.0, z + 0.0)


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _perpendicular(direction):
    """Some unit vector square to ``direction``."""
    x, y, z = direction
    other = (1.0, 0.0, 0.0) if abs(x) < 0.9 else (0.0, 1.0, 0.0)
    cross = (y * other[2] - z * other[1], z * other[0] - x * other[2], x * other[1] - y * other[0])
    length = math.sqrt(_dot(cross, cross))
    return (cross[0] / length, cross[1] / length, cross[2] / length)


def _along(point, direction, distance):
    return tuple(point[i] + direction[i] * distance for i in range(3))


def is_concave_cylinder(face, surface) -> bool:
    """Whether a cylindrical face's material is on the outside (a hole, an inside corner
    round) rather than the inside (a shaft, an outside round). Read off the face's actual
    outward normal: the face's orientation flag alone does not say, because a cylinder
    surface may itself be left-handed (a mirrored feature), with its own normal pointing
    at the axis."""
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_REVERSED

    u = (surface.FirstUParameter() + surface.LastUParameter()) / 2.0
    v = (surface.FirstVParameter() + surface.LastVParameter()) / 2.0
    point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    surface.D1(u, v, point, du, dv)
    normal = du.Crossed(dv)
    if face.Orientation() == TopAbs_REVERSED:
        normal.Reverse()
    axis = surface.Cylinder().Axis()
    origin, direction = axis.Location(), axis.Direction()
    offset = gp_Vec(origin, point)
    radial = offset - gp_Vec(direction) * offset.Dot(gp_Vec(direction))
    return normal.Dot(radial) < 0.0


def _wall_faces(solid) -> dict:
    """{(direction, axis foot): [(radius, t0, t1, swept), ...]} for the inward-facing
    cylindrical faces of ``solid``, plus the unrounded foot and direction per line."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    face_of = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    lines: dict = {}
    explorer = TopExp_Explorer(solid, TopAbs_FACE)
    while explorer.More():
        face = face_of(explorer.Current())
        explorer.Next()
        surface = BRepAdaptor_Surface(face)
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        if not is_concave_cylinder(face, surface):
            continue   # material inside: a boss or a shaft, not a hole
        cylinder = surface.Cylinder()
        radius = cylinder.Radius()
        if 2 * radius < MIN_DIAMETER:
            continue
        axis = cylinder.Axis()
        location, raw = axis.Location(), axis.Direction()
        origin = (location.X(), location.Y(), location.Z())
        raw_dir = (raw.X(), raw.Y(), raw.Z())
        direction = _canonical(raw_dir)
        sign = 1.0 if _dot(direction, raw_dir) > 0 else -1.0
        base = _dot(origin, direction)
        t0, t1 = sorted((base + sign * surface.FirstVParameter(), base + sign * surface.LastVParameter()))
        foot = _along(origin, direction, -base)   # the point of the axis nearest the origin
        key = (tuple(round(c, AXIS_ROUND) for c in direction), tuple(round(c, AXIS_ROUND) for c in foot))
        swept = abs(surface.LastUParameter() - surface.FirstUParameter())
        line = lines.setdefault(key, {"foot": foot, "direction": direction, "faces": []})
        line["faces"].append((radius, t0, t1, swept))
    return lines


def _segments(faces: list) -> list[tuple[float, float, float]]:
    """Full-circle walls ``(t0, t1, radius)`` on one axis line, in axial order. Faces of
    one radius over one axial range are one wall (a cylinder is often two half faces) and
    must close the circle between them; walls of one radius that meet are one wall."""
    walls: dict = {}
    for radius, t0, t1, swept in faces:
        key = (round(radius, AXIS_ROUND), round(t0, 4), round(t1, 4))
        known = walls.get(key)
        walls[key] = (radius, t0, t1, swept + (known[3] if known else 0.0))
    full = sorted((t0, t1, radius) for radius, t0, t1, swept in walls.values()
                  if swept >= 2 * math.pi - FULL_TURN_TOLERANCE and t1 - t0 > 1e-6)
    merged: list[list[float]] = []
    for t0, t1, radius in full:
        last = merged[-1] if merged else None
        if last and abs(last[2] - radius) < 1e-6 and abs(last[1] - t0) < MEET_TOLERANCE:
            last[1] = t1
        else:
            merged.append([t0, t1, radius])
    return [tuple(wall) for wall in merged]


def _chains(segments: list[tuple[float, float, float]]) -> list[list[tuple[float, float, float]]]:
    """Walls that meet end to end, as stepped holes -- after taking out grooves: a wall
    wider than the walls on both sides of it is a groove in a bore, and the bore runs on
    through it."""
    chains: list[list[tuple[float, float, float]]] = []
    for segment in segments:
        if chains and abs(chains[-1][-1][1] - segment[0]) < MEET_TOLERANCE:
            chains[-1].append(segment)
        else:
            chains.append([segment])
    cleaned = []
    for chain in chains:
        changed = True
        while changed and len(chain) >= 3:
            changed = False
            for at in range(1, len(chain) - 1):
                before, here, after = chain[at - 1], chain[at], chain[at + 1]
                if here[2] > before[2] + 1e-6 and here[2] > after[2] + 1e-6:
                    if abs(before[2] - after[2]) < 1e-6:
                        chain[at - 1:at + 2] = [(before[0], after[1], before[2])]
                    else:
                        del chain[at]
                    changed = True
                    break
        cleaned.append(chain)
    return cleaned


class _Probe:
    """Rays against one solid."""

    def __init__(self, solid) -> None:
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

        self.rays = IntCurvesFace_ShapeIntersector()
        self.rays.Load(solid, 1e-6)

    def closed_within(self, point, direction, reach: float) -> bool:
        """Does a ray from ``point`` meet the solid within ``reach``?"""
        from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

        self.rays.Perform(gp_Lin(gp_Pnt(*point), gp_Dir(*direction)), 0.0, reach)
        return self.rays.NbPnt() > 0


def _solids(shape) -> list:
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    wrapped = getattr(shape, "wrapped", shape)
    found = []
    explorer = TopExp_Explorer(wrapped, TopAbs_SOLID)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


def find_holes(shape) -> list[Hole]:
    """The holes of every solid in ``shape``."""
    holes: list[Hole] = []
    for solid in _solids(shape):
        probe = None
        for line in _wall_faces(solid).values():
            for chain in _chains(_segments(line["faces"])):
                if probe is None:
                    probe = _Probe(solid)
                hole = _hole_of(probe, chain, line["foot"], line["direction"])
                if hole is not None:
                    holes.append(hole)
                if len(holes) >= MAX_HOLES:
                    return holes
    return holes


def _hole_of(probe: _Probe, chain: list, foot, direction) -> Hole | None:
    if len(chain) > 2:
        return None   # more than two steps: leave it to a hand-written note
    start, end = chain[0][0], chain[-1][1]
    backward = tuple(-c for c in direction)
    # An end is open when a ray from just inside it, along the axis, meets nothing within
    # a diameter beyond it: a flat bottom is met at once, a drill point or a ball bottom
    # within a radius, and the far wall of a part the hole passes through is further off.
    # Two rays per end, one on the axis and one half a radius off it: the tip of a drill
    # point is a single point on the axis, which a ray aimed exactly at it can miss.
    inset = min(0.01, (end - start) / 4.0)
    aside = _perpendicular(direction)

    def is_open(at: float, heading, radius: float) -> bool:
        on_axis = _along(foot, direction, at)
        reach = inset + 2.0 * radius
        return not (probe.closed_within(on_axis, heading, reach)
                    or probe.closed_within(_along(on_axis, aside, radius / 2.0), heading, reach))

    open_start = is_open(start + inset, backward, chain[0][2])
    open_end = is_open(end - inset, direction, chain[-1][2])
    if not (open_start or open_end):
        return None   # a closed cavity: not something a drawing calls out as a hole
    cbore = None
    bore = chain[0]
    mouth_at_start = open_start
    if len(chain) == 2:
        wide_first = chain[0][2] > chain[1][2]
        wide, bore = (chain[0], chain[1]) if wide_first else (chain[1], chain[0])
        wide_open = open_start if wide_first else open_end
        if wide_open:
            cbore = (2 * wide[2], wide[1] - wide[0])
            mouth_at_start = wide_first
        else:
            # The wide step is closed off inside the part (a cavity the hole breaks into):
            # what can be drilled and called out is the bore, from its own open end.
            mouth_at_start = not wide_first
            start, end = bore[0], bore[1]
            open_start, open_end = (False, True) if wide_first else (True, False)
    if mouth_at_start:
        top, into = _along(foot, direction, start), direction
    else:
        top, into = _along(foot, direction, end), backward
    thru = open_start and open_end
    depth = (bore[1] - bore[0]) if cbore is not None else (end - start)
    return Hole(top=tuple(round(c, 4) + 0.0 for c in top), direction=tuple(round(c, 6) + 0.0 for c in into),
                diameter=round(2 * bore[2], 4), depth=round(depth, 4), thru=thru,
                cbore=None if cbore is None else (round(cbore[0], 4), round(cbore[1], 4)))


def group_holes(holes: list[Hole]) -> list[HoleGroup]:
    """Same direction, diameter, depth and counterbore -> one callout. Largest count first,
    then by diameter, so the order does not depend on the order faces were visited in."""
    groups: dict = {}
    for hole in holes:
        # A plain through hole has no side; a blind or counterbored one opens on one.
        sided = not hole.thru or hole.cbore is not None
        key = (hole.direction if sided else _canonical(hole.direction), round(hole.diameter, 3),
               None if hole.thru else round(hole.depth, 3), hole.thru, hole.cbore)
        group = groups.get(key)
        if group is None:
            group = groups[key] = HoleGroup(direction=key[0], diameter=hole.diameter,
                                            depth=None if hole.thru else hole.depth, thru=hole.thru,
                                            cbore=hole.cbore)
        group.holes.append(hole)
    ordered = sorted(groups.values(), key=lambda g: (-g.count, g.diameter, g.depth or 0.0, g.direction))
    for group in ordered:
        group.holes.sort(key=lambda h: h.top)
    return ordered
