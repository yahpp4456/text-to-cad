"""Machining recommendations for a milled part, measured on its exact geometry.

Three things a machinist sends a drawing back for, each found on the B-rep rather than
on how the part was modelled:

- ``cnc.sharp_internal_corner`` -- a sharp inside corner no rotating tool makes. A square
  concave edge between two planes is made by an end mill whose end lies on one of the two
  faces and whose flank runs along the other, provided the tool can get there: a ray from
  the edge along that face's normal leaves the part. Where neither face offers such an
  approach (the upright corners of a closed pocket or of a window), the corner needs a
  radius -- or a different process.
- ``cnc.deep_corner`` -- an inside corner radius too small for its height: the tool that
  fits the radius has to stick out the whole height, and beyond a length-to-diameter of
  about four it chatters or breaks.
- ``cnc.deep_hole`` / ``cnc.small_hole`` -- a drilled hole deeper than ten diameters, or
  under 1 mm.

These are recommendations (``warning`` findings), not verdicts: a part that trips one can
still be made -- by EDM, by a longer tool run slowly, by a change of setup. They are
reported only for parts the generator says are machined.

The rules follow the ``sharp_edges``, ``internal_corners`` and ``holes`` families of
text-to-cad's ``cad/build123d/_dfm_cnc.py`` (MIT License, Copyright (c) earthtojake) in
what they look for; the measurement here is a much smaller one (planes, straight edges,
square corners, an end mill along a face normal) and says nothing about tool lists,
setups, threads, pockets' widths, thin walls or turned parts.
"""

from __future__ import annotations

import math
from typing import Any

from .holes import find_holes, is_concave_cylinder

__all__ = ["cnc_advisories", "machined_parts"]

SQUARE_TOLERANCE = math.cos(math.radians(89.0))   # |n1.n2| below this: a square corner
MIN_EDGE_MM = 1.0             # shorter concave edges are slivers, not corners
MAX_CORNER_RATIO = 4.0        # tool stick-out / tool diameter, i.e. height / (2 * radius)
MAX_HOLE_RATIO = 10.0         # depth / diameter
MIN_HOLE_MM = 1.0
MAX_EDGES = 6000              # per part; a part with more is not measured
# Work allowed per part, counted in ray and inside/outside queries -- not seconds, so the
# same part gets the same answer on a busy machine as on an idle one. A part that needs
# more is not reported on at all (half a list of corners would read as the whole list).
MAX_QUERIES = 20_000
_PROBE = 0.02                 # how far off the edge, into the void, a ray starts
_STATIONS = (0.2, 0.5, 0.8)


def machined_parts(module: Any, labels: list[str]) -> list[str]:
    """Which parts the generator declares as machined: module-level ``MACHINED`` is a list
    of part names, or ``True`` for every part. Unknown names are ignored."""
    declared = getattr(module, "MACHINED", None)
    if declared is True:
        return list(labels)
    if isinstance(declared, str):
        declared = [declared]
    if not isinstance(declared, (list, tuple, set, frozenset)):
        return []
    wanted = {str(name) for name in declared}
    return [name for name in labels if name in wanted]


def _fmt(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def _vec(v) -> tuple[float, float, float]:
    return (v.X(), v.Y(), v.Z())


def _add(a, b, k=1.0):
    return (a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2])


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _unit(a):
    n = math.sqrt(_dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-12 else None


class _OverBudget(Exception):
    pass


class _Solid:
    """One solid with what the measurements ask of it: is a point in the material, and
    does a ray from a point reach open space."""

    def __init__(self, solid: Any, budget: list[int]) -> None:
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

        self.solid = solid
        self.budget = budget
        self.rays = IntCurvesFace_ShapeIntersector()
        self.rays.Load(solid, 1e-6)
        self.classifier = BRepClass3d_SolidClassifier(solid)

    def _spend(self) -> None:
        self.budget[0] -= 1
        if self.budget[0] < 0:
            raise _OverBudget()

    def inside(self, point) -> bool:
        from OCP.gp import gp_Pnt
        from OCP.TopAbs import TopAbs_IN

        self._spend()
        self.classifier.Perform(gp_Pnt(*point), 1e-6)
        return self.classifier.State() == TopAbs_IN

    def escapes(self, point, direction) -> bool:
        from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

        self._spend()
        self.rays.Perform(gp_Lin(gp_Pnt(*point), gp_Dir(*direction)), 1e-4, 1e9)
        return self.rays.NbPnt() == 0


def _solids(shape: Any) -> list[Any]:
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    wrapped = getattr(shape, "wrapped", shape)
    found = []
    explorer = TopExp_Explorer(wrapped, TopAbs_SOLID)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


def _plane_normal(face: Any):
    """Outward normal of a planar face, or None for any other surface."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.TopAbs import TopAbs_REVERSED

    surface = BRepAdaptor_Surface(face)
    if surface.GetType() != GeomAbs_Plane:
        return None
    normal = _vec(surface.Plane().Axis().Direction())
    return tuple(-c for c in normal) if face.Orientation() == TopAbs_REVERSED else normal


def _sharp_corners(body: _Solid) -> list[float] | None:
    """Lengths of the square concave straight edges no end mill reaches. None when the part
    has too many edges to measure."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_Line
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS

    try:
        from OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as _EdgeFaces
    except ImportError:
        from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape as _EdgeFaces

    face_of = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    edge_of = getattr(TopoDS, "Edge_s", None) or TopoDS.Edge
    ancestors = _EdgeFaces()
    TopExp.MapShapesAndAncestors_s(body.solid, TopAbs_EDGE, TopAbs_FACE, ancestors)
    if ancestors.Extent() > MAX_EDGES:
        return None
    unmade: list[float] = []
    for index in range(1, ancestors.Extent() + 1):
        faces = ancestors.FindFromIndex(index)
        if faces.Size() != 2:
            continue
        first, second = face_of(faces.First()), face_of(faces.Last())
        if first.IsSame(second):
            continue
        n1, n2 = _plane_normal(first), _plane_normal(second)
        if n1 is None or n2 is None or abs(_dot(n1, n2)) > SQUARE_TOLERANCE:
            continue
        curve = BRepAdaptor_Curve(edge_of(ancestors.FindKey(index)))
        if curve.GetType() != GeomAbs_Line:
            continue
        a, b = curve.FirstParameter(), curve.LastParameter()
        start, end = _vec(curve.Value(a)), _vec(curve.Value(b))
        length = math.dist(start, end)
        if length < MIN_EDGE_MM:
            continue
        middle = _vec(curve.Value((a + b) / 2.0))
        # Concave: a step off the edge along n1 - n2 lands in material (on a convex edge
        # it lands in the open, above one face and outside the other).
        if not body.inside(_add(middle, _unit(_add(n1, n2, -1.0)), _PROBE)):
            continue
        into_void = _unit(_add(n1, n2))
        made = False
        for approach in (n1, n2):
            if all(body.escapes(_add(_vec(curve.Value(a + (b - a) * s)), into_void, _PROBE), approach)
                   for s in _STATIONS):
                made = True
                break
        if not made:
            unmade.append(length)
    return unmade


def _deep_corners(body: _Solid) -> list[tuple[float, float]]:
    """(radius, height) of inside corner rounds whose tool would stick out too far: concave
    partial cylinders that only a tool along their own axis makes. A round a tool reaches
    from the side -- the fillet along the foot of an open step, which a ball or bull-nose
    cutter makes with its axis across the round -- is not a corner, however long it is."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    face_of = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    found: list[tuple[float, float]] = []
    explorer = TopExp_Explorer(body.solid, TopAbs_FACE)
    while explorer.More():
        face = face_of(explorer.Current())
        explorer.Next()
        surface = BRepAdaptor_Surface(face)
        if surface.GetType() != GeomAbs_Cylinder or not is_concave_cylinder(face, surface):
            continue
        swept = abs(surface.LastUParameter() - surface.FirstUParameter())
        if swept > math.pi + 1e-6:
            continue   # more than half a turn: a bore or a hole, not a corner
        radius = surface.Cylinder().Radius()
        height = abs(surface.LastVParameter() - surface.FirstVParameter())
        if radius <= 0 or height / (2.0 * radius) <= MAX_CORNER_RATIO:
            continue
        axis = _vec(surface.Cylinder().Axis().Direction())
        u = (surface.FirstUParameter() + surface.LastUParameter()) / 2.0
        v = (surface.FirstVParameter() + surface.LastVParameter()) / 2.0
        on_wall = _vec(surface.Value(u, v))
        centre = _vec(surface.Cylinder().Axis().Location())
        along = _dot(_add(on_wall, centre, -1.0), axis)
        toward_axis = _unit(_add(_add(centre, axis, along), on_wall, -1.0))
        if toward_axis is None:
            continue
        start = _add(on_wall, toward_axis, min(_PROBE, radius / 2.0))
        if body.escapes(start, toward_axis):
            continue   # open across the round: made from the side, not a corner
        # A tool along the corner's axis has to get in from one end of it.
        if body.escapes(start, axis) or body.escapes(start, tuple(-c for c in axis)):
            found.append((radius, height))
    return found


def cnc_advisories(named_parts: list[tuple[str, Any]], *, max_queries: int = MAX_QUERIES) -> list[dict[str, Any]]:
    """Recommendations for each ``(name, shape)``: dicts of ``rule``, ``severity``
    (``"warning"``), ``message``, ``value``, ``limit``, ``unit`` and ``refs``. Never
    raises; a part that cannot be measured within ``max_queries`` is skipped whole."""
    out: list[dict[str, Any]] = []

    def add(rule: str, message: str, value: float, limit: float, unit: str, part: str) -> None:
        out.append({"rule": rule, "severity": "warning", "message": message, "value": round(float(value), 3),
                    "limit": limit, "unit": unit, "refs": [part]})

    for name, shape in named_parts:
        found: list[tuple] = []
        try:
            _part_advisories(name, shape, max_queries, lambda *args: found.append(args))
        except Exception:  # noqa: BLE001 - over budget or unmeasurable: say nothing of this part
            continue
        for args in found:
            add(*args)
    return out


def _part_advisories(name: str, shape: Any, max_queries: int, add) -> None:
    sharp: list[float] = []
    deep: list[tuple[float, float]] = []
    budget = [max_queries]
    for solid in _solids(shape):
        body = _Solid(solid, budget)
        corners = _sharp_corners(body)
        if corners:
            sharp.extend(corners)
        deep.extend(_deep_corners(body))
    if sharp:
        add("cnc.sharp_internal_corner",
            f"{name}: {len(sharp)} 處內側尖角銑刀做不出來(最長 {_fmt(max(sharp))} mm)——"
            "改成圓角(半徑至少是刀具半徑),或說明這裡用線切割/放電加工",
            len(sharp), 0, "處", name)
    if deep:
        radius, height = max(deep, key=lambda item: item[1] / item[0])
        add("cnc.deep_corner",
            f"{name}: 內圓角 R{_fmt(radius)} 高 {_fmt(height)} mm,刀具伸出長是直徑的 {_fmt(height / (2 * radius))} 倍"
            f"(建議不超過 {_fmt(MAX_CORNER_RATIO)} 倍;共 {len(deep)} 處)——加大圓角或降低這一段的高度",
            height / (2 * radius), MAX_CORNER_RATIO, "倍", name)
    holes = find_holes(shape)
    deep_holes = [h for h in holes if h.depth / h.diameter > MAX_HOLE_RATIO]
    if deep_holes:
        worst = max(deep_holes, key=lambda h: h.depth / h.diameter)
        add("cnc.deep_hole",
            f"{name}: 孔 ⌀{_fmt(worst.diameter)} 深 {_fmt(worst.depth)} mm,深度是直徑的 {_fmt(worst.depth / worst.diameter)} 倍"
            f"(建議不超過 {_fmt(MAX_HOLE_RATIO)} 倍;共 {len(deep_holes)} 個)——需要深孔鑽或從兩側加工",
            worst.depth / worst.diameter, MAX_HOLE_RATIO, "倍", name)
    small = [h for h in holes if h.diameter < MIN_HOLE_MM]
    if small:
        tiny = min(small, key=lambda h: h.diameter)
        add("cnc.small_hole",
            f"{name}: 孔徑 ⌀{_fmt(tiny.diameter)} mm 小於 {_fmt(MIN_HOLE_MM)} mm(共 {len(small)} 個)——微小鑽頭易斷,確認是否必要",
            tiny.diameter, MIN_HOLE_MM, "mm", name)
