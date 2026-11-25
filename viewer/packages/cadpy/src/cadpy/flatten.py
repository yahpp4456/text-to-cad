"""Flat patterns from 3D topology: exact 2D geometry for DXF drawings.

Pick the planar faces that make up the flat pattern, lay each one into the XY
plane, fuse them, and — where the cutting process needs it — offset for kerf.
The resulting build123d geometry can be written with :func:`emit_profile`.

**Exact, not sampled.** The union and the offset are OCC boolean and OCC offset
operations on the real faces, so an arc stays an arc: a filleted corner exports
as a DXF polyline arc, a hole as a ``CIRCLE``, and kerf compensation preserves both.
The previous pipeline sampled every wire into a point list, unioned polygons in
shapely, and emitted polylines — which turned every curve into a run of chords
before it ever reached the file, at a resolution nobody chose. Shapely survives
here only as an internal fallback for the unions OCC refuses (see
:func:`union_faces`), and even then only its topology is borrowed.

Ported from earthtojake/text-to-cad ``build123d/_flatten.py`` (MIT License, Copyright (c) 2026 Thompson Labs LLC).
The port documents :func:`emit_profile` and its DXF entities, removes the lazy
import comment, preserves the OCC failure when Shapely is unavailable, and
adds :func:`emit_profile` with adaptive sampling for noncircular curves.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

import build123d


# A projected contour smaller than this is sampling debris, not a cut path.
MIN_CUT_CONTOUR_AREA_MM2 = 0.05
# Merge tolerance for the shapely fallback's rebuilt polygons. Far below any
# fabrication tolerance; it exists to keep duplicate points out of a contour.
POINT_MERGE_TOLERANCE_MM = 0.01


def axis_value(vector: build123d.Vector, axis: str) -> float:
    return {"x": vector.X, "y": vector.Y, "z": vector.Z}[axis]


def snap(value: float, source: float, target: float, *, tolerance: float = 1e-3) -> float:
    return target if abs(value - source) <= tolerance else value


def planar_faces(
    shape: build123d.Shape,
    *,
    normal_axis: str,
    normal_sign: float,
    coordinate_axis: str,
    coordinate: float,
    tolerance: float = 0.02,
    min_area: float = 1e-5,
) -> tuple[build123d.Face, ...]:
    """The planar faces of ``shape`` facing one way at one height.

    This is the selection step of a flat pattern: "every upward face of the top
    surface", "every outward face of the left flange". Raises rather than
    returning nothing — an empty selection means the plane or the sign is wrong,
    and a drawing generated from no faces is an empty file nobody notices.
    """
    matches: list[build123d.Face] = []
    for face in shape.faces():
        if face.geom_type != build123d.GeomType.PLANE:
            continue
        normal = face.normal_at()
        center = face.center()
        if abs(axis_value(normal, normal_axis) - normal_sign) > 0.02:
            continue
        if abs(axis_value(center, coordinate_axis) - coordinate) > tolerance:
            continue
        if face.area <= min_area:
            continue
        matches.append(face)
    if not matches:
        raise RuntimeError(
            "Could not find planar topology faces for DXF projection: "
            f"normal {normal_sign:+.0f}{normal_axis}, {coordinate_axis}={coordinate:.3f}"
        )
    return tuple(matches)


def flatten_face(face: build123d.Face) -> build123d.Face:
    """Lay one planar face into the XY plane, exactly.

    The face is moved by the rigid transform that takes its own plane to XY — no
    sampling, no projection error, and every curve survives as itself. A DXF is
    2D and the engine refuses geometry off the XY plane, so this (or an explicit
    ``bd.Location((0, 0, -z)) * face``) is how a derived face becomes drawable.

    A face whose normal points away from +Z comes back mirrored, because that is
    what looking at it from its own side means. Flip the source face first if you
    want the other handedness.
    """
    plane = build123d.Plane(face)
    return plane.to_local_coords(face)


def flatten_faces(faces: Iterable[build123d.Face]) -> tuple[build123d.Face, ...]:
    """:func:`flatten_face` over a selection."""
    return tuple(flatten_face(face) for face in faces)


def union_faces(faces: Sequence[build123d.Shape]) -> build123d.Shape:
    """Fuse coplanar XY faces into one profile, exactly.

    OCC's boolean is the primary path: overlapping faces merge, shared edges
    disappear, holes survive as inner wires, and arcs stay arcs. Disjoint faces
    come back as a multi-face result, which is a perfectly good nested cut
    layout.

    Shapely is the fallback, and only that. OCC refuses some genuinely
    degenerate inputs — faces that touch along a zero-width sliver, self-
    intersecting projections of a fold — where a tolerant polygon union still
    gives a usable contour. Taking that route costs curvature (the rebuilt
    profile is polygonal), so it is never the default and never silent.
    """
    shapes = [face for face in faces if face is not None]
    if not shapes:
        raise RuntimeError("No faces were given to union into a DXF profile")
    if len(shapes) == 1:
        return shapes[0]
    try:
        fused = shapes[0].fuse(*shapes[1:]).clean()
    except Exception as exact_error:  # noqa: BLE001 - OCC raises many types; the fallback is the point
        return _shapely_union_fallback(shapes, cause=exact_error)
    if not fused.faces():
        return _shapely_union_fallback(shapes, cause=RuntimeError("the exact union was empty"))
    return fused


def offset_profile(shape: build123d.Shape, amount: float) -> build123d.Shape:
    """Kerf / tool-radius compensation, exactly.

    Positive grows the profile (cut outside the line), negative shrinks it (cut
    inside). The offset is OCC's, so a filleted corner offsets to a concentric
    arc rather than to a fan of chords — the single biggest reason this module
    stopped going through shapely.
    """
    if amount == 0.0:
        return shape
    try:
        offset = build123d.offset(shape, amount=amount)
    except Exception as error:  # noqa: BLE001 - OCC/build123d report a consumed profile several ways
        offset = None
        failure: BaseException | None = error
    else:
        failure = None
    if offset is None or not offset.faces():
        raise RuntimeError(
            f"Kerf offset of {amount:+.3f} mm produced no profile. A negative offset "
            "at or beyond half the narrowest feature consumes it entirely — check the "
            "sign (positive grows the cut, negative shrinks it) and the magnitude."
        ) from failure
    return offset


def flat_pattern(
    shape: build123d.Shape,
    *,
    normal_axis: str = "z",
    normal_sign: float = 1.0,
    coordinate_axis: str = "z",
    coordinate: float,
    tolerance: float = 0.02,
    kerf: float = 0.0,
) -> build123d.Shape:
    """Select, flatten, fuse, and optionally kerf-offset — the usual whole job.

    The three steps are separately available above for drawings that need them
    apart (a multi-plane bracket flattens each flange with its own selection
    before one union)."""
    faces = planar_faces(
        shape,
        normal_axis=normal_axis,
        normal_sign=normal_sign,
        coordinate_axis=coordinate_axis,
        coordinate=coordinate,
        tolerance=tolerance,
    )
    profile = union_faces(flatten_faces(faces))
    return offset_profile(profile, kerf) if kerf else profile


# --- the fallback ---------------------------------------------------------------------
# Kept small and internal on purpose. It exists for the unions OCC will not do, and
# it converts curves to chords on the way, so nothing above reaches for it by choice.


def _shapely_union_fallback(shapes: Sequence[build123d.Shape], *, cause: BaseException):
    try:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
    except ModuleNotFoundError as error:
        if error.name != "shapely":
            raise
        raise RuntimeError("exact union failed and shapely is not installed") from cause

    polygons = []
    for shape in shapes:
        for face in shape.faces():
            polygon = Polygon(
                _wire_points(face.outer_wire()),
                [_wire_points(wire) for wire in face.inner_wires() if wire.length > 1e-6],
            )
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            if not polygon.is_empty:
                polygons.append(polygon)
    if not polygons:
        raise RuntimeError(f"Could not union these faces into a DXF profile: {cause}") from cause
    geometry = unary_union(polygons).buffer(0)
    if geometry.is_empty:
        raise RuntimeError(f"Could not union these faces into a DXF profile: {cause}") from cause
    faces = [
        face
        for polygon in (geometry.geoms if geometry.geom_type != "Polygon" else [geometry])
        if polygon.area >= MIN_CUT_CONTOUR_AREA_MM2
        for face in [_face_from_polygon(polygon)]
        if face is not None
    ]
    if not faces:
        raise RuntimeError(f"Could not union these faces into a DXF profile: {cause}") from cause
    return faces[0] if len(faces) == 1 else build123d.Sketch(children=faces)


def _wire_points(wire: build123d.Wire, *, max_segment_mm: float = 0.25) -> list[tuple[float, float]]:
    sample_count = max(16, int(math.ceil(wire.length / max_segment_mm)))
    points: list[tuple[float, float]] = []
    for index in range(sample_count):
        position = wire.position_at(index / sample_count)
        point = (float(position.X), float(position.Y))
        if not points or math.dist(points[-1], point) > POINT_MERGE_TOLERANCE_MM:
            points.append(point)
    while len(points) >= 2 and math.dist(points[0], points[-1]) <= POINT_MERGE_TOLERANCE_MM:
        points.pop()
    return points


def _face_from_polygon(polygon) -> build123d.Face | None:
    outer = _face_from_ring(polygon.exterior)
    if outer is None:
        return None
    for interior in polygon.interiors:
        hole = _face_from_ring(interior)
        if hole is not None:
            outer = outer.cut(hole)
    faces = outer.faces()
    return faces[0] if faces else None


def _face_from_ring(ring) -> build123d.Face | None:
    points = [(float(x), float(y)) for x, y in ring.coords]
    while len(points) >= 2 and math.dist(points[0], points[-1]) <= POINT_MERGE_TOLERANCE_MM:
        points.pop()
    if len(points) < 3:
        return None
    wire = build123d.Polyline(*[(x, y, 0.0) for x, y in points], close=True)
    return build123d.make_face(wire)


def _sample_profile_edge(edge: build123d.Edge, tolerance: float) -> list[build123d.Vector]:
    segments = 8
    samples = [edge @ (i / segments) for i in range(segments + 1)]
    while segments < 1024:
        midpoints = [edge @ ((i + 0.5) / segments) for i in range(segments)]
        if all(
            abs(midpoint - (start + end) * 0.5) <= tolerance
            for start, end, midpoint in zip(samples, samples[1:], midpoints)
        ):
            break
        samples = [p for pair in zip(samples, midpoints) for p in pair] + [samples[-1]]
        segments *= 2
    return samples


def _emit_profile_wire(msp, wire, layer, tolerance, counts):
    edges = wire.order_edges()
    if len(edges) == 1 and edges[0].geom_type == build123d.GeomType.CIRCLE:
        circle = edges[0]
        if circle.is_closed:
            center = circle.arc_center
            msp.add_circle((center.X, center.Y), circle.radius, dxfattribs={"layer": layer})
            counts["circles"] += 1
            return

    points = []
    previous_end = None
    for edge in edges:
        start, end = edge @ 0, edge @ 1
        if previous_end is None:
            # Orient the first edge toward its neighbor, which may itself be reversed.
            reverse = len(edges) > 1 and min(abs(end - (edges[1] @ t)) for t in (0, 1)) > 1e-6
        else:
            reverse = abs(start - previous_end) > 1e-6
        if reverse:
            start, end = end, start
        previous_end = end

        if edge.geom_type == build123d.GeomType.LINE:
            points.append((start.X, start.Y, 0.0))
        elif edge.geom_type == build123d.GeomType.CIRCLE:
            chord = end - start
            chord2 = chord.X**2 + chord.Y**2
            if chord2 < 1e-18:
                raise ValueError("emit_profile: circular arc has coincident endpoints")
            offset = (edge @ 0.5) - start
            cross = chord.X * offset.Y - chord.Y * offset.X
            points.append((start.X, start.Y, -2 * cross / chord2))
            counts["arcs"] += 1
        else:
            samples = _sample_profile_edge(edge, tolerance)
            if reverse:
                samples.reverse()
            points.extend((p.X, p.Y, 0.0) for p in samples[:-1])
            counts["sampled_edges"] += 1

    msp.add_lwpolyline(points, format="xyb", close=True, dxfattribs={"layer": layer})
    counts["polylines"] += 1


def emit_profile(msp, shape, *, layer: str = "CUT", sample_tolerance_mm: float = 0.05) -> dict[str, int]:
    """Write the wires of ``shape``'s faces into an ezdxf layout, exactly where it can."""
    if not callable(getattr(shape, "faces", None)):
        raise TypeError("emit_profile: shape must have a faces() method")
    faces = tuple(shape.faces())
    vertices = shape.vertices() if hasattr(shape, "vertices") else (v for f in faces for v in f.vertices())
    if any(abs(vertex.Z) > 1e-6 for vertex in vertices):
        raise ValueError("emit_profile: geometry is not in the XY plane")
    for face in faces:
        # Horizontal faces have constant Z. OCC can pad spline bounds beyond the tolerance.
        if face.geom_type == build123d.GeomType.PLANE:
            normal = face.normal_at()
            if normal.X == normal.Y == 0:
                continue
        # A tilted circle, for example, can have its only vertex in XY.
        bounds = face.bounding_box()
        if bounds.min.Z < -1e-6 or bounds.max.Z > 1e-6:
            raise ValueError("emit_profile: geometry is not in the XY plane")

    counts = {"circles": 0, "polylines": 0, "arcs": 0, "sampled_edges": 0}
    for face in faces:
        for wire in (face.outer_wire(), *face.inner_wires()):
            _emit_profile_wire(msp, wire, layer, sample_tolerance_mm, counts)
    return counts


# --- a whole flat part ----------------------------------------------------------------
# Not in the upstream module: this fork's generators return an ezdxf document
# from ``gen_dxf``, so a plate needs one call that goes from solid to document.


def plate_dxf(shape: build123d.Shape, *, kerf: float = 0.0, layer: str = "CUT"):
    """The cut profile of a flat, uniform-thickness part as an ezdxf document.

    For a part that is cut from sheet and not bent -- a laser- or waterjet-cut
    plate, a gasket, a panel. The part must lie flat (thickness along Z): its top
    face is taken, laid into XY and written with :func:`emit_profile`, so rounded
    corners and slot ends reach the cutter as arcs.

    Refuses a part that is not a plate. A profile says nothing about a step, a
    blind pocket or a chamfer, and a drawing that silently drops them gets cut
    wrong; the check is that the profile swept through the thickness accounts
    for the whole volume.
    """
    import ezdxf

    box = shape.bounding_box()
    thickness = box.max.Z - box.min.Z
    if thickness <= 1e-6:
        raise ValueError("plate_dxf: 零件沒有厚度(Z 方向尺寸為 0)")
    try:
        profile = flat_pattern(shape, coordinate=box.max.Z, kerf=0.0)
    except RuntimeError as failure:
        raise ValueError("plate_dxf: 找不到朝上的平面頂面——零件要平放(厚度沿 Z 方向)") from failure
    area = sum(face.area for face in profile.faces())
    volume = shape.volume
    if volume <= 0 or abs(area * thickness - volume) > max(1e-6, 1e-3 * volume):
        raise ValueError(
            "plate_dxf: 這個零件不是等厚平板(頂面輪廓×厚度 "
            f"{area * thickness:.1f} mm³ ≠ 體積 {volume:.1f} mm³)——有階梯、盲孔、倒角或斜面,"
            "一張輪廓圖代表不了它"
        )
    if kerf:
        profile = offset_profile(profile, kerf)

    doc = ezdxf.new("R2010")
    doc.units = ezdxf.units.MM
    doc.layers.add(layer, color=7)
    emit_profile(doc.modelspace(), profile, layer=layer)
    return doc
