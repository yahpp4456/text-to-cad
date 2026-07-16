"""Profile-along-path sweep parts: generic swept solids, the Elocab-EHSL-style
cleanroom cable sleeve, and KCL end clamps.

Coordinate convention (single source of truth):
- the PROFILE is declared in its local XY plane with the centroid at the
  origin: width along X, height along Y, outline traced CCW (winding is a
  construction guarantee -- never mirror a profile);
- the PATH is a 2D polyline-with-arcs in ``(d, e)``. Construction happens in
  a BUILD frame (``(d, e) -> (x=0, y=e, z=d)``, start tangent +Z, profile on
  world XY -- the spike-verified zero-twist configuration), and every public
  exit (finished solid, :func:`path_polyline`, :func:`clamp_location`)
  applies one fixed ``Rot(X=90)``, so the WORLD pose is
  ``(d, e) -> (x=0, y=-d, z=e)``: straights run HORIZONTALLY along -Y, the
  bend offsets vertically (+Z) -- a drag chain lying flat with one run above
  the other, matching the OEM Cable X.stp pose (not an upside-down arch);
- ``at=`` composes ONE rigid transform on top of that world pose (tuple
  offset, ``Location`` or ``Plane``) -- the re-orientation hook. Pass the
  SAME ``at`` to the solid, ``path_polyline`` (SWEEP_PATHS) and
  ``clamp_location``, or the overlay/clamps desync from the body.

Geometry approximations (declared, like gear.py):
- sleeve outline: 2N elliptical arcs -- adjacent pocket ellipses (pitch
  ``pocket_w + 1``) intersect at natural waist points, end pockets run to
  their tips at y=0, so total width == N*(pocket_w+1)+3 in closed form
  (matches the EHSL catalog for the 16-series: 2->37, 6->105, 7->122);
- bores: one full ellipse per pocket, ``bore_w = pocket_w - 2*wall_t``,
  ``bore_h = outer_h - 2*wall_t`` (exact match to the measured OEM
  16-series cross-section: bore 14.0 x 4.7 in a 6.7-high band, wall 1.0);
- ``outer_h`` defaults to ``6.7 * pocket_w / 16`` -- only the 16-series
  height is measured from the OEM STP; other widths scale proportionally
  (override with ``outer_h=`` when a real height is known);
- KCL clamps are plain plates (width C, depth 32.4, thickness 5.75, two
  through holes at B c-c); the catalog slot is omitted and NO screws are
  built (real screws pierce the sleeve edge webs, which would need an
  interference allow-list -- opt-in later).

Kernel gotchas this module guards against (spike-validated on build123d
0.11.0 / OCCT 7.9; keep the guards, the kernel will NOT catch these):
- a path with a tangency break (cusp) sweeps into silent garbage that
  BRepCheck still calls valid -> tangency is guaranteed by construction
  (arcs via three analytic points, corners must carry a fillet radius) and
  witnessed by the volume==area*length closed-form tests;
- an arc radius tighter than the profile half-height self-intersects and is
  ALSO reported valid -> hard ``ValueError`` floor here;
- ``EllipticalCenterArc(..., end_angle=...)`` crashes on 0.11 -> only
  ``start_angle`` + ``arc_size`` is used;
- sweeping a face WITH holes works in this canonical frame but has failed
  on other profile planes (``Solid.sweep`` assert) -> primary path sweeps
  the holed face, and on any kernel error falls back to sweeping outer and
  inner faces separately and subtracting.
"""

from __future__ import annotations

import math
from typing import Any

from cadpy.assembly import label_shape

# KCL catalog constants (PDF p.8): plate thickness / depth / hole diameter.
KCL_PLATE_T = 5.75
KCL_PLATE_DEPTH = 32.4
KCL_HOLE_D = 5.0

_MIN_BEND_CLEARANCE = 0.5  # mm between arc inner fiber and profile edge
_TOL = 1e-9

_PROFILE_KINDS = ("circle", "stadium", "rounded_rect", "polyline")
_PATH_KINDS = ("line", "waypoints", "drag_chain")


# ---------------------------------------------------------------------------
# pure-2D path resolution (no build123d: sampling and frames stay OCP-free)
# ---------------------------------------------------------------------------
def _num(spec: dict, key: str, *, positive: bool = True) -> float:
    v = spec.get(key)
    if not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"path/profile spec 缺少數值欄位 {key!r}")
    if positive and v <= 0:
        raise ValueError(f"{key} must be positive, got {v}")
    return float(v)


def _resolve_path(path: dict) -> list[tuple]:
    """Normalize a path spec into analytic segments in (d, e) coordinates.

    Segments: ``("line", (d0,e0), (d1,e1))`` or ``("arc", (cd,ce), r, a0, a1)``
    with angles in radians and the sweep running a0 -> a1 (signed, |a1-a0|>0).
    One list feeds all three consumers: wire construction, arc-length sampling
    (:func:`path_polyline`) and end frames (:func:`clamp_location`).
    """
    if not isinstance(path, dict):
        raise ValueError("path spec 必須是 dict")
    kind = path.get("kind")
    if kind == "line":
        length = _num(path, "length")
        return [("line", (0.0, 0.0), (length, 0.0))]
    if kind == "drag_chain":
        sa = _num(path, "straight_a")
        sb = _num(path, "straight_b")
        r = _num(path, "bend_r")
        # bottom straight +d, 180-degree turn toward +e, top straight -d
        return [
            ("line", (0.0, 0.0), (sa, 0.0)),
            ("arc", (sa, r), r, -math.pi / 2.0, math.pi / 2.0),
            ("line", (sa, 2.0 * r), (sa - sb, 2.0 * r)),
        ]
    if kind == "waypoints":
        return _resolve_waypoints(path)
    if kind == "spline":
        raise ValueError(
            "spline 路徑 v1 未支援(取樣無法零 OCP 保證與核心一致);"
            "請用 waypoints + radius 圓角折線"
        )
    raise ValueError(f"path.kind 必須是 {_PATH_KINDS} 之一,got {kind!r}")


def _resolve_waypoints(path: dict) -> list[tuple]:
    pts = path.get("points")
    if not isinstance(pts, (list, tuple)) or len(pts) < 2:
        raise ValueError("waypoints 路徑至少要 2 個點")
    P = []
    for p in pts:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise ValueError("waypoints 的每個點必須是 [d, e] 兩元素")
        d, e = float(p[0]), float(p[1])
        if not (math.isfinite(d) and math.isfinite(e)):
            raise ValueError("waypoints 座標必須是有限數")
        P.append((d, e))
    n_corners = len(P) - 2
    radius = path.get("radius", 0.0)
    if isinstance(radius, (list, tuple)):
        radii = [float(r) for r in radius]
        if len(radii) != n_corners:
            raise ValueError(
                f"radius list 長度 {len(radii)} 必須等於內部轉角數 {n_corners}"
            )
    else:
        radii = [float(radius)] * n_corners

    segs: list[tuple] = []
    cursor = P[0]
    for i in range(1, len(P) - 1):
        prev_pt, corner, next_pt = P[i - 1], P[i], P[i + 1]
        u = _unit((corner[0] - prev_pt[0], corner[1] - prev_pt[1]))
        w = _unit((next_pt[0] - corner[0], next_pt[1] - corner[1]))
        cross = u[0] * w[1] - u[1] * w[0]
        dot = max(-1.0, min(1.0, u[0] * w[0] + u[1] * w[1]))
        turn = math.atan2(cross, dot)  # signed exterior angle
        if abs(turn) < 1e-9:
            continue  # collinear corner: nothing to fillet
        if abs(abs(turn) - math.pi) < 1e-6:
            raise ValueError(f"waypoints 第 {i} 點是 180° 反折,路徑無法相切")
        r = radii[i - 1]
        if r <= 0:
            raise ValueError(
                f"waypoints 第 {i} 點轉角必須給正的圓角半徑(禁尖角,radius={r})"
            )
        t = r * math.tan(abs(turn) / 2.0)
        len_in = math.hypot(corner[0] - cursor[0], corner[1] - cursor[1])
        len_out = math.hypot(next_pt[0] - corner[0], next_pt[1] - corner[1])
        if t > len_in + _TOL or t > len_out + _TOL:
            raise ValueError(
                f"waypoints 第 {i} 點圓角半徑 {r} 過大(切點越出相鄰段)"
            )
        A = (corner[0] - u[0] * t, corner[1] - u[1] * t)  # arc start
        B = (corner[0] + w[0] * t, corner[1] + w[1] * t)  # arc end
        if math.hypot(A[0] - cursor[0], A[1] - cursor[1]) > _TOL:
            segs.append(("line", cursor, A))
        # center: along the corner bisector, distance r / cos(|turn|/2)
        bis = _unit((w[0] - u[0], w[1] - u[1]))
        m = r / math.cos(abs(turn) / 2.0)
        O = (corner[0] + bis[0] * m, corner[1] + bis[1] * m)
        a0 = math.atan2(A[1] - O[1], A[0] - O[0])
        a1 = a0 + turn  # arc sweep equals the (signed) turn angle
        segs.append(("arc", O, r, a0, a1))
        cursor = B
    end = P[-1]
    if math.hypot(end[0] - cursor[0], end[1] - cursor[1]) > _TOL:
        segs.append(("line", cursor, end))
    if not segs:
        raise ValueError("waypoints 路徑長度為零")
    return segs


def _unit(v: tuple[float, float]) -> tuple[float, float]:
    n = math.hypot(v[0], v[1])
    if n < _TOL:
        raise ValueError("waypoints 含零長段(相鄰點重合)")
    return (v[0] / n, v[1] / n)


def _seg_length(seg: tuple) -> float:
    if seg[0] == "line":
        (_, p0, p1) = seg
        return math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    (_, _c, r, a0, a1) = seg
    return abs(a1 - a0) * r


def _seg_point(seg: tuple, s: float) -> tuple[float, float]:
    """Point at arc length ``s`` from the segment start (s in [0, len])."""
    if seg[0] == "line":
        (_, p0, p1) = seg
        L = _seg_length(seg)
        t = 0.0 if L < _TOL else s / L
        return (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t)
    (_, c, r, a0, a1) = seg
    a = a0 + math.copysign(s / r, a1 - a0)
    return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))


def _path_end_frame(segs: list[tuple]) -> tuple[tuple, tuple]:
    """Return (end_point, end_tangent) in (d, e), both exact."""
    seg = segs[-1]
    if seg[0] == "line":
        (_, p0, p1) = seg
        return p1, _unit((p1[0] - p0[0], p1[1] - p0[1]))
    (_, c, r, a0, a1) = seg
    p = (c[0] + r * math.cos(a1), c[1] + r * math.sin(a1))
    sign = 1.0 if a1 > a0 else -1.0
    return p, (-math.sin(a1) * sign, math.cos(a1) * sign)


def _to_world(p: tuple[float, float]) -> tuple[float, float, float]:
    """(d, e) -> BUILD frame (0, e, d)(內部建構座標;世界姿態在出口轉)。"""
    return (0.0, p[1], p[0])


def _orient_point(p) -> list[float]:
    """BUILD frame -> WORLD pose, pure math(= Rot(X=90):(x,y,z)->(x,-z,y))。
    path_polyline 的零 OCP 保證靠這個純函數版本。"""
    return [p[0], -p[2], p[1]]


def _orient_location():
    """BUILD frame -> WORLD pose as a build123d Location(出口統一套用)。"""
    from build123d import Rot

    return Rot(X=90)


def path_polyline(path: dict, samples: int = 64, *, at=None) -> list[list[float]]:
    """Equal-arc-length world-coordinate samples of a path spec.

    Pure analytic math (no OCP import) for ``at`` of None or an (x, y, z)
    tuple, so generators can build module-level ``SWEEP_PATHS`` cheaply even
    under ``validate.py --motion-only``. A ``Location``/``Plane`` ``at``
    transforms through build123d (the generator already paid that import).
    """
    if not isinstance(samples, int) or samples < 2:
        raise ValueError("samples 至少要 2")
    segs = _resolve_path(path)
    lens = [_seg_length(s) for s in segs]
    total = sum(lens)
    pts: list[list[float]] = []
    for i in range(samples):
        s = total * i / (samples - 1)
        for seg, L in zip(segs, lens):
            if s <= L + _TOL:
                p = _seg_point(seg, min(s, L))
                break
            s -= L
        pts.append(_orient_point(_to_world(p)))  # BUILD -> WORLD(純數學,零 OCP)
    if at is None:
        return pts
    if isinstance(at, (list, tuple)) and len(at) == 3:
        ox, oy, oz = (float(v) for v in at)
        return [[x + ox, y + oy, z + oz] for x, y, z in pts]
    loc = _as_location(at)
    from build123d import Vertex

    # Location * Vector is NOT supported (rmul scales); go through a Vertex.
    # Vertex.X/Y/Z read the RAW geometry point and ignore .moved() location --
    # only .center() applies it (spike-verified; the naive read is silently
    # untransformed).
    out = []
    for p in pts:
        c = Vertex(*p).moved(loc).center()
        out.append([c.X, c.Y, c.Z])
    return out


# ---------------------------------------------------------------------------
# profile faces
# ---------------------------------------------------------------------------
def _signed_area(pts) -> float:
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return a / 2.0


def _orient(p, q, r) -> float:
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _segs_cross(a0, a1, b0, b1) -> bool:
    d1, d2 = _orient(a0, a1, b0), _orient(a0, a1, b1)
    d3, d4 = _orient(b0, b1, a0), _orient(b0, b1, a1)
    return ((d1 > _TOL and d2 < -_TOL) or (d1 < -_TOL and d2 > _TOL)) and (
        (d3 > _TOL and d4 < -_TOL) or (d3 < -_TOL and d4 > _TOL)
    )


def _is_simple_polygon(pts) -> bool:
    n = len(pts)
    for i in range(n):
        a0, a1 = pts[i], pts[(i + 1) % n]
        for j in range(i + 1, n):
            if j == i or (j + 1) % n == i or (i + 1) % n == j:
                continue
            if _segs_cross(a0, a1, pts[j], pts[(j + 1) % n]):
                return False
    return True


def _profile_faces(profile: dict, wall_t: float | None):
    """Build (solid_or_holed_face, outer_face, inner_faces, y_extents).

    ``y_extents`` is (min_y, max_y) of the outer profile -- the bend
    clearance check needs the true extents, not a symmetric half-height.
    """
    if not isinstance(profile, dict):
        raise ValueError("profile spec 必須是 dict")
    kind = profile.get("kind")
    if kind not in _PROFILE_KINDS:
        raise ValueError(f"profile.kind 必須是 {_PROFILE_KINDS} 之一,got {kind!r}")
    t = 0.0 if wall_t is None else float(wall_t)
    if t < 0:
        raise ValueError("wall_t 不可為負")

    from build123d import (
        BuildSketch,
        Circle,
        Mode,
        RectangleRounded,
        SlotOverall,
        offset,
    )

    def _shrunk(inset: float):
        """Outer shape shrunk by ``inset`` (analytic per kind)."""
        with BuildSketch() as sk:
            if kind == "circle":
                d = _num(profile, "d")
                if inset >= d / 2.0 - _TOL:
                    raise ValueError("wall_t 必須小於 d/2")
                Circle(d / 2.0 - inset)
            elif kind == "stadium":
                w, h = _num(profile, "w"), _num(profile, "h")
                if w < h:
                    raise ValueError("stadium 需要 w >= h(寬過高請對調)")
                if inset >= h / 2.0 - _TOL:
                    raise ValueError("wall_t 必須小於 h/2")
                SlotOverall(w - 2.0 * inset, h - 2.0 * inset)
            elif kind == "rounded_rect":
                w, h = _num(profile, "w"), _num(profile, "h")
                r = _num(profile, "r")
                if r >= min(w, h) / 2.0:
                    raise ValueError("rounded_rect 的 r 必須小於 min(w,h)/2")
                if inset >= min(w, h) / 2.0 - _TOL:
                    raise ValueError("wall_t 必須小於 min(w,h)/2")
                RectangleRounded(
                    w - 2.0 * inset, h - 2.0 * inset, max(r - inset, 1e-3)
                )
            else:
                raise AssertionError(kind)
        return sk.sketch

    if kind == "polyline":
        outer = _polyline_face(profile)
        inners = []
        if t > 0:
            shr = offset(outer, amount=-t)
            faces = shr.faces() if hasattr(shr, "faces") else []
            if len(faces) != 1 or shr.area < _TOL:
                raise ValueError(
                    "polyline 輪廓內縮 wall_t 失敗(過細或分裂);減小 wall_t"
                )
            inners = [shr]
    else:
        outer = _shrunk(0.0)
        inners = [] if t <= 0 else [_shrunk(t)]

    if not inners:
        holed = outer
    else:
        holed = outer
        for f in inners:
            holed = holed - f
        if len(holed.faces()) != 1:
            raise ValueError("空心輪廓布林失敗(內外輪廓相交?)")
    bb = outer.bounding_box()
    return holed, outer, inners, (bb.min.Y, bb.max.Y)


def _polyline_face(profile: dict):
    pts_in = profile.get("points")
    if not isinstance(pts_in, (list, tuple)) or len(pts_in) < 3:
        raise ValueError("polyline 輪廓至少要 3 個點")
    pts = []
    for p in pts_in:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise ValueError("polyline 的每個點必須是 [x, y]")
        pts.append((float(p[0]), float(p[1])))
    if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < _TOL:
        pts = pts[:-1]  # drop explicit closing point
    if len(pts) < 3:
        raise ValueError("polyline 輪廓至少要 3 個相異點")
    area = _signed_area(pts)
    if abs(area) < _TOL:
        raise ValueError("polyline 輪廓面積為零")
    if area < 0:
        pts = list(reversed(pts))  # normalize winding to CCW (never mirror)
    if not _is_simple_polygon(pts):
        raise ValueError("polyline 輪廓自交")
    # center centroid at the origin (profile convention)
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    pts = [(x - cx, y - cy) for x, y in pts]

    from build123d import BuildLine, BuildSketch, Polyline, fillet, make_face

    fillet_r = float(profile.get("fillet_r", 0.0) or 0.0)
    with BuildSketch() as sk:
        with BuildLine():
            Polyline(*pts, close=True)
        make_face()
        if fillet_r > 0:
            fillet(sk.vertices(), radius=fillet_r)
    return sk.sketch


# ---------------------------------------------------------------------------
# sweep core
# ---------------------------------------------------------------------------
def _path_wire(segs: list[tuple]):
    """Analytic segments -> a connected build123d Wire.

    Arcs go through three computed points (start / midpoint / end), which
    pins the arc side unambiguously -- no RadiusArc sign guessing.
    """
    from build123d import BuildLine, Line, ThreePointArc

    with BuildLine() as bl:
        for seg in segs:
            if seg[0] == "line":
                (_, p0, p1) = seg
                Line(_to_world(p0), _to_world(p1))
            else:
                (_, c, r, a0, a1) = seg
                am = (a0 + a1) / 2.0
                p0 = (c[0] + r * math.cos(a0), c[1] + r * math.sin(a0))
                pm = (c[0] + r * math.cos(am), c[1] + r * math.sin(am))
                p1 = (c[0] + r * math.cos(a1), c[1] + r * math.sin(a1))
                ThreePointArc(_to_world(p0), _to_world(pm), _to_world(p1))
    wires = bl.wires()
    if len(wires) != 1:
        raise ValueError("路徑段未連成單一 wire(內部錯誤)")
    return wires[0]


def _check_bend_clearance(segs: list[tuple], y_extents: tuple[float, float]) -> None:
    """Reject arcs tighter than the profile fiber on the bend's inner side.

    The kernel accepts such self-intersecting sweeps as "valid" (spiked), so
    this floor is the only guard. Inner side: the profile's local +y is the
    path's left-of-travel by construction, so an arc whose center sits left
    presses the +y fiber inward, and vice versa.
    """
    min_y, max_y = y_extents
    for seg in segs:
        if seg[0] != "arc":
            continue
        (_, c, r, a0, a1) = seg
        # left-of-travel at arc start: for CCW arcs (a1>a0) the center IS on
        # the left; for CW arcs it is on the right.
        inner_extent = max_y if a1 > a0 else -min_y
        clearance = r - max(inner_extent, 0.0)
        if clearance < _MIN_BEND_CLEARANCE:
            raise ValueError(
                f"彎徑過緊:bend_r={r:g} 對輪廓內側纖維 {max(inner_extent, 0.0):g} "
                f"的餘隙 {clearance:g} < {_MIN_BEND_CLEARANCE}(掃出會自交,"
                "kernel 不會抓)"
            )


def _as_location(at):
    from build123d import Location, Plane

    if at is None:
        return Location()
    if isinstance(at, Location):
        return at
    if isinstance(at, Plane):
        return at.location
    if isinstance(at, (list, tuple)) and len(at) == 3:
        return Location(tuple(float(v) for v in at))
    raise ValueError("at 必須是 None / (x,y,z) / Location / Plane")


def _sweep_solid_from_faces(holed, outer, inners, path_wire):
    """Holed-face single sweep first; fall back to outer/inner sweeps + cut."""
    from build123d import Transition, sweep

    try:
        body = sweep(sections=holed, path=path_wire, transition=Transition.TRANSFORMED)
        if len(body.solids()) == 1:
            return body
    except Exception:
        pass  # fall back below (documented 0.11 Solid.sweep holed-face assert)
    body = sweep(sections=outer, path=path_wire, transition=Transition.TRANSFORMED)
    for f in inners:
        body = body - sweep(sections=f, path=path_wire, transition=Transition.TRANSFORMED)
    return body


def _finish_swept(body, at, label: str):
    solids = body.solids()
    if len(solids) != 1:
        raise ValueError(
            f"掃出結果不是單一實體(得到 {len(solids)} 個)——路徑相切或彎徑設定有誤"
        )
    solid = solids[0].moved(_orient_location())  # BUILD -> WORLD(拖鏈平放姿態)
    if at is not None:
        solid = solid.moved(_as_location(at))
    label_shape(solid, label)
    return solid


def swept_solid(
    profile: dict,
    path: dict,
    *,
    wall_t: float | None = None,
    at=None,
    label: str = "swept",
) -> Any:
    """Sweep a closed profile along a path; ``wall_t`` > 0 makes a hollow tube.

    ``profile`` / ``path`` are plain-dict specs (see the module docstring for
    the coordinate convention)::

        profile: {"kind": "circle", "d": 10}
                 {"kind": "stadium", "w": 20, "h": 8}
                 {"kind": "rounded_rect", "w": 20, "h": 8, "r": 2}
                 {"kind": "polyline", "points": [[x, y], ...], "fillet_r": 0}
        path:    {"kind": "line", "length": 300}
                 {"kind": "waypoints", "points": [[d, e], ...], "radius": 80}
                 {"kind": "drag_chain", "straight_a": 300, "bend_r": 80,
                  "straight_b": 300}
    """
    segs = _resolve_path(path)
    holed, outer, inners, y_extents = _profile_faces(profile, wall_t)
    _check_bend_clearance(segs, y_extents)
    body = _sweep_solid_from_faces(holed, outer, inners, _path_wire(segs))
    return _finish_swept(body, at, label)


# ---------------------------------------------------------------------------
# cleanroom sleeve (Elocab EHSL style)
# ---------------------------------------------------------------------------
def sleeve_dims(
    pockets: int, pocket_w: float, *, wall_t: float = 1.0, outer_h: float | None = None
) -> dict[str, Any]:
    """Closed-form sleeve cross-section dimensions (shared by the profile
    builder, generators and the tests)."""
    if not isinstance(pockets, int) or pockets < 1:
        raise ValueError("pockets 必須是 >= 1 的整數")
    if pocket_w < 6.0:
        raise ValueError("pocket_w 過小(< 6mm)")
    if outer_h is None:
        outer_h = 6.7 * pocket_w / 16.0  # declared approximation (see docstring)
    if wall_t <= 0 or wall_t >= outer_h / 2.0:
        raise ValueError("wall_t 必須在 (0, outer_h/2) 內")
    rx = (pocket_w + 4.0) / 2.0
    ry = outer_h / 2.0
    pitch = pocket_w + 1.0
    total_w = (pockets - 1) * pitch + 2.0 * rx  # == pockets*(pocket_w+1)+3
    bore_rx = (pocket_w - 2.0 * wall_t) / 2.0
    bore_ry = ry - wall_t
    if bore_rx <= 0 or bore_ry <= 0:
        raise ValueError("wall_t 過大,內腔尺寸歸零")
    theta_w = math.degrees(math.acos((pitch / 2.0) / rx))  # waist angle
    cx0 = -total_w / 2.0 + rx
    return {
        "pockets": pockets,
        "pocket_w": float(pocket_w),
        "wall_t": float(wall_t),
        "outer_h": float(outer_h),
        "total_w": total_w,
        "rx": rx,
        "ry": ry,
        "pitch": pitch,
        "bore_rx": bore_rx,
        "bore_ry": bore_ry,
        "theta_w": theta_w,
        "pocket_centers": [cx0 + i * pitch for i in range(pockets)],
    }


def _sleeve_faces(dims: dict[str, Any]):
    from build123d import (
        BuildLine,
        BuildSketch,
        Ellipse,
        EllipticalCenterArc,
        Locations,
        Mode,
        make_face,
    )

    cxs = dims["pocket_centers"]
    rx, ry, theta_w = dims["rx"], dims["ry"], dims["theta_w"]
    n = dims["pockets"]

    def outer_arcs():
        # NEVER end_angle= (0.11 crash); one CCW upper + one lower arc per
        # pocket, meeting neighbours exactly at the waist points.
        for i, cx in enumerate(cxs):
            a_left = 180.0 if i == 0 else 180.0 - theta_w
            a_right = 0.0 if i == n - 1 else theta_w
            EllipticalCenterArc(
                (cx, 0), rx, ry, start_angle=a_right, arc_size=a_left - a_right
            )
            EllipticalCenterArc(
                (cx, 0), rx, ry, start_angle=-a_left, arc_size=a_left - a_right
            )

    with BuildSketch() as sk:
        with BuildLine():
            outer_arcs()
        make_face()
        for cx in cxs:
            with Locations((cx, 0)):
                Ellipse(dims["bore_rx"], dims["bore_ry"], mode=Mode.SUBTRACT)
    holed = sk.sketch

    with BuildSketch() as sko:
        with BuildLine():
            outer_arcs()
        make_face()
    outer = sko.sketch

    inners = []
    for cx in cxs:
        with BuildSketch() as skb:
            with Locations((cx, 0)):
                Ellipse(dims["bore_rx"], dims["bore_ry"])
        inners.append(skb.sketch)
    return holed, outer, inners


def sleeve_profile(
    pockets: int, pocket_w: float, *, wall_t: float = 1.0, outer_h: float | None = None
) -> Any:
    """The hollow sleeve cross-section as a 2D face (exposed for tests to
    measure widths/walls without paying a sweep)."""
    dims = sleeve_dims(pockets, pocket_w, wall_t=wall_t, outer_h=outer_h)
    holed, _outer, _inners = _sleeve_faces(dims)
    return holed


def default_bend_r(pocket_w: float, *, factor: float = 10.0) -> float:
    """Catalog rule: bend radius = 7.5x..10x the max cable OD (= pocket_w/2)."""
    if not 7.5 <= factor <= 10.0:
        raise ValueError("factor 必須在 [7.5, 10](型錄彎徑規則)")
    return factor * pocket_w / 2.0


def cleanroom_sleeve(
    pockets: int,
    pocket_w: float,
    *,
    wall_t: float = 1.0,
    outer_h: float | None = None,
    path: dict | None = None,
    at=None,
    label: str = "sleeve",
) -> Any:
    """Hollow N-pocket cleanroom cable sleeve swept along ``path``.

    Default path is a drag-chain U (straights 300, bend radius from the
    catalog rule). The returned solid is labeled ``label``.
    """
    dims = sleeve_dims(pockets, pocket_w, wall_t=wall_t, outer_h=outer_h)
    if path is None:
        path = {
            "kind": "drag_chain",
            "straight_a": 300.0,
            "bend_r": default_bend_r(pocket_w),
            "straight_b": 300.0,
        }
    segs = _resolve_path(path)
    _check_bend_clearance(segs, (-dims["ry"], dims["ry"]))
    holed, outer, inners = _sleeve_faces(dims)
    body = _sweep_solid_from_faces(holed, outer, inners, _path_wire(segs))
    return _finish_swept(body, at, label)


# ---------------------------------------------------------------------------
# KCL end clamps
# ---------------------------------------------------------------------------
def kcl_clamp(
    size: str | None = None,
    *,
    sleeve_width: float | None = None,
    sleeve_h: float = 6.7,
    label_prefix: str = "kcl",
) -> Any:
    """KCL clamp pair (top + bottom plate) in the canonical path-start frame.

    Exactly one of ``size`` ("2A".."7A") or ``sleeve_width`` (auto-select via
    :func:`cadpy.parts.select.select_kcl_clamp`) must be given. Plates span
    ``z in [0, 32.4]`` (into the path) and press the sleeve crown faces at
    ``y = +/- sleeve_h / 2`` (tangent, zero-volume contact -- no
    INTENDED_CONTACT entry needed). Place at a path end with
    :func:`clamp_location`.
    """
    if (size is None) == (sleeve_width is None):
        raise ValueError("size 與 sleeve_width 必須恰給一個")
    from cadpy.parts.select import select_kcl_clamp
    from cadpy.parts.specs_io import load_specs

    if size is not None:
        rows = [r for r in load_specs("kcl_clamps") if r["size"] == size]
        if not rows:
            raise ValueError(f"kcl_clamps 無此 size:{size!r}(2A~7A)")
        row = rows[0]
    else:
        row = select_kcl_clamp(None, sleeve_width)
    if sleeve_h <= 0:
        raise ValueError("sleeve_h 必須為正")

    from build123d import Align, Box, Compound, Cylinder, Pos, Rot

    C, B = float(row["C"]), float(row["B"])

    def plate(y0: float, name: str):
        p = Pos(0, y0, 0) * Box(
            C, KCL_PLATE_T, KCL_PLATE_DEPTH,
            align=(Align.CENTER, Align.MIN, Align.MIN),
        )
        for sx in (-1.0, 1.0):
            hole = (
                Pos(sx * B / 2.0, y0 + KCL_PLATE_T / 2.0, KCL_PLATE_DEPTH / 2.0)
                * Rot(X=90)
                * Cylinder(KCL_HOLE_D / 2.0, KCL_PLATE_T * 3.0)
            )
            p = p - hole
        label_shape(p, name)
        return p

    top = plate(sleeve_h / 2.0, f"{label_prefix}_top")
    bottom = plate(-sleeve_h / 2.0 - KCL_PLATE_T, f"{label_prefix}_bottom")
    return Compound(label=label_prefix, children=[top, bottom])


def clamp_location(path: dict, end: str = "start", *, at=None) -> Any:
    """Rigid placement for a clamp pair at a path end.

    ``start`` is the identity (the canonical frame). ``end`` places local +Z
    pointing BACK along the path (plates cover the last 32.4 mm) with the
    width axis kept on world X; the top/bottom pair is y-symmetric so the
    transported-frame sign flip at a 180-degree turn is immaterial.
    """
    from build123d import Location, Plane

    segs = _resolve_path(path)
    if end == "start":
        loc = Location()
    elif end == "end":
        p, tangent = _path_end_frame(segs)
        tw = _to_world(tangent)
        loc = Plane(
            origin=_to_world(p), x_dir=(1, 0, 0), z_dir=(-tw[0], -tw[1], -tw[2])
        ).location
    else:
        raise ValueError("end 必須是 'start' 或 'end'")
    loc = _orient_location() * loc  # BUILD -> WORLD(與 _finish_swept 同一顆旋轉)
    base = _as_location(at)
    return base * loc if at is not None else loc


def check_geometry(shape: Any, *, sweep_args: dict | None = None) -> None:
    """Acceptance gate: valid solid(s); multi-part compounds additionally get
    the undeclared-interference check. Swept parts are static -- ``sweep_args``
    only exists for family-signature parity and is rejected if given."""
    if sweep_args is not None:
        raise ValueError("掃出家族是靜態件;sweep_args 不適用")
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="swept part")
    children = getattr(shape, "children", None) or []
    if len(children) >= 2:
        assert_no_interference(shape)


# ---------------------------------------------------------------------------
# 2D preview loops (pure math, zero OCP -- the sweep-window's profile pane)
# ---------------------------------------------------------------------------
def _ellipse_arc(cx, rx, ry, a0_deg, a1_deg, n):
    """Sample an ellipse arc (center (cx, 0)) from a0 to a1 degrees, n+1 pts."""
    out = []
    for i in range(n + 1):
        a = math.radians(a0_deg + (a1_deg - a0_deg) * i / n)
        out.append([cx + rx * math.cos(a), ry * math.sin(a)])
    return out


def _extend(loop: list, pts: list) -> None:
    """Append points, dropping a duplicated shared boundary point."""
    start = 1 if loop and math.hypot(loop[-1][0] - pts[0][0], loop[-1][1] - pts[0][1]) < 1e-9 else 0
    loop.extend(pts[start:])


def sleeve_profile_loops(
    pockets: int,
    pocket_w: float,
    *,
    wall_t: float = 1.0,
    outer_h: float | None = None,
    samples_per_arc: int = 24,
) -> list[list[list[float]]]:
    """Sleeve cross-section as closed 2D loops (display-only, for the viewer's
    sweep-window profile pane): ``[outer, bore_0, ..., bore_{N-1}]``.

    Mirrors ``_sleeve_faces`` term-for-term (same ellipse arcs cut at the waist
    angle from :func:`sleeve_dims`), but samples pure analytic points -- no
    build123d import, so generators can build SWEEP_VIEW cheaply even under
    ``validate.py --motion-only``. Loops are implicitly closed (no repeated
    first point).
    """
    if not isinstance(samples_per_arc, int) or samples_per_arc < 4:
        raise ValueError("samples_per_arc 至少要 4")
    dims = sleeve_dims(pockets, pocket_w, wall_t=wall_t, outer_h=outer_h)
    cxs = dims["pocket_centers"]
    rx, ry, theta_w = dims["rx"], dims["ry"], dims["theta_w"]
    n = dims["pockets"]

    outer: list[list[float]] = []
    # top side, left -> right (phi decreasing 180 -> 0 across pockets)
    for i, cx in enumerate(cxs):
        a_left = 180.0 if i == 0 else 180.0 - theta_w
        a_right = 0.0 if i == n - 1 else theta_w
        _extend(outer, _ellipse_arc(cx, rx, ry, a_left, a_right, samples_per_arc))
    # bottom side, right -> left (phi decreasing 0 -> -180)
    for i in range(n - 1, -1, -1):
        a_left = 180.0 if i == 0 else 180.0 - theta_w
        a_right = 0.0 if i == n - 1 else theta_w
        _extend(outer, _ellipse_arc(cxs[i], rx, ry, -a_right, -a_left, samples_per_arc))
    # closing point duplicates the first (phi -180 == 180) -> drop it
    if math.hypot(outer[-1][0] - outer[0][0], outer[-1][1] - outer[0][1]) < 1e-9:
        outer.pop()

    loops = [outer]
    for cx in cxs:
        bore = _ellipse_arc(cx, dims["bore_rx"], dims["bore_ry"], 0.0, 360.0, 2 * samples_per_arc)
        bore.pop()  # implicit close
        loops.append(bore)
    return loops


def profile_loops(
    profile: dict, wall_t: float | None = None, samples: int = 96
) -> list[list[list[float]]]:
    """Generic profile spec -> closed 2D loops (display-only). ``[outer]`` or
    ``[outer, inner]`` when ``wall_t`` > 0 (analytic inset, mirroring the
    ``_shrunk`` formulas). ``polyline`` returns the outer loop only (a true
    2D offset needs the kernel -- declared limitation), and ``fillet_r`` is
    NOT rendered (corners stay sharp in the preview)."""
    if not isinstance(profile, dict):
        raise ValueError("profile spec 必須是 dict")
    kind = profile.get("kind")
    if kind not in _PROFILE_KINDS:
        raise ValueError(f"profile.kind 必須是 {_PROFILE_KINDS} 之一,got {kind!r}")
    if not isinstance(samples, int) or samples < 8:
        raise ValueError("samples 至少要 8")
    t = 0.0 if wall_t is None else float(wall_t)
    if t < 0:
        raise ValueError("wall_t 不可為負")

    def circle_loop(r):
        pts = _ellipse_arc(0.0, r, r, 0.0, 360.0, samples)
        pts.pop()
        return pts

    def stadium_loop(w, h):
        # right cap (-90..90) + top line + left cap (90..270) + bottom line
        r = h / 2.0
        c = w / 2.0 - r
        cap = max(8, samples // 4)
        loop: list[list[float]] = []
        _extend(loop, [[p[0] + c, p[1]] for p in _ellipse_arc(0.0, r, r, -90.0, 90.0, cap)])
        _extend(loop, [[-c, r]])
        _extend(loop, [[p[0] - c, p[1]] for p in _ellipse_arc(0.0, r, r, 90.0, 270.0, cap)])
        _extend(loop, [[c, -r]])
        if math.hypot(loop[-1][0] - loop[0][0], loop[-1][1] - loop[0][1]) < 1e-9:
            loop.pop()
        return loop

    def rrect_loop(w, h, r):
        cap = max(4, samples // 8)
        cx_, cy_ = w / 2.0 - r, h / 2.0 - r
        loop: list[list[float]] = []
        for ccx, ccy, a0 in ((cx_, cy_, 0.0), (-cx_, cy_, 90.0), (-cx_, -cy_, 180.0), (cx_, -cy_, 270.0)):
            _extend(loop, [[p[0] + ccx, p[1] + ccy] for p in _ellipse_arc(0.0, r, r, a0, a0 + 90.0, cap)])
        if math.hypot(loop[-1][0] - loop[0][0], loop[-1][1] - loop[0][1]) < 1e-9:
            loop.pop()
        return loop

    if kind == "circle":
        d = _num(profile, "d")
        if t > 0 and t >= d / 2.0 - _TOL:
            raise ValueError("wall_t 必須小於 d/2")
        loops = [circle_loop(d / 2.0)]
        if t > 0:
            loops.append(circle_loop(d / 2.0 - t))
        return loops
    if kind == "stadium":
        w, h = _num(profile, "w"), _num(profile, "h")
        if w < h:
            raise ValueError("stadium 需要 w >= h(寬過高請對調)")
        if t > 0 and t >= h / 2.0 - _TOL:
            raise ValueError("wall_t 必須小於 h/2")
        loops = [stadium_loop(w, h)]
        if t > 0:
            loops.append(stadium_loop(w - 2 * t, h - 2 * t))
        return loops
    if kind == "rounded_rect":
        w, h = _num(profile, "w"), _num(profile, "h")
        r = _num(profile, "r")
        if r >= min(w, h) / 2.0:
            raise ValueError("rounded_rect 的 r 必須小於 min(w,h)/2")
        if t > 0 and t >= min(w, h) / 2.0 - _TOL:
            raise ValueError("wall_t 必須小於 min(w,h)/2")
        loops = [rrect_loop(w, h, r)]
        if t > 0:
            loops.append(rrect_loop(w - 2 * t, h - 2 * t, max(r - t, 1e-3)))
        return loops
    # polyline: validated + winding/centroid normalized like _polyline_face,
    # but outer loop only (2D offset needs the kernel)
    pts_in = profile.get("points")
    if not isinstance(pts_in, (list, tuple)) or len(pts_in) < 3:
        raise ValueError("polyline 輪廓至少要 3 個點")
    pts = [(float(p[0]), float(p[1])) for p in pts_in]
    if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < _TOL:
        pts = pts[:-1]
    area = _signed_area(pts)
    if abs(area) < _TOL:
        raise ValueError("polyline 輪廓面積為零")
    if area < 0:
        pts = list(reversed(pts))
    if not _is_simple_polygon(pts):
        raise ValueError("polyline 輪廓自交")
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    return [[[x - cx, y - cy] for x, y in pts]]
