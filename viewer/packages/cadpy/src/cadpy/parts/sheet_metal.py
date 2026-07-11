"""Parametric sheet-metal fold tree: base panel + edge flanges / hem / jog.

One declarative tree is the single source of truth with three outputs:
``folded()`` (bent 3D solid), ``flat()`` (flat-pattern solid, thickness ``t``)
and ``dxf()`` (ezdxf flat-pattern drawing, CUT / BEND_* layers). Unfold length
uses the neutral-fiber closed form BA = theta_rad * (R + K*t); no bend table.

Geometry approximations (declared, like gear.py):
- bends are EXACT cylindrical sectors (inner R, outer R+t), panels are exact
  prisms; the fuse uses overlap tabs of x half-width ``_FUSE_EPS`` recessed to
  z in [delta, t-delta] so every contact is transversal (no tangent fuse, no
  outer-surface step); tab volume is fully contained in panel+sector, so the
  folded volume matches the closed form to numerical noise.
- flat pattern = neutral-fiber unfold in the BASE panel's local frame (1:1).

Coordinate convention (single source of truth):
- every panel is declared in its LOCAL XY plane, material occupies z in [0, t];
- outlines are CCW; edge i runs pts[i] -> pts[i+1], outward normal to the
  right of the edge direction;
- ``angle`` is the sweep angle folded up FROM FLAT (90 = an upright wall);
  positive folds toward +Z (inner radius on the z=t side), negative folds down;
  |angle| in (0, 180];
- the bend arc consumes material OUTSIDE the declared outline (bend outside):
  the folded outer size = declared outline + (R+t) per 90-degree flange.
  ``placement="inside"`` insets that edge by R+t first, so the folded outer
  face lands exactly on the declared outline (boxes declare outer sizes);
- flange-panel local x is measured from the bend tangent (x=0 at the seam),
  y runs along the parent edge from the requested span start. Corner relief
  may trim the panel's y-range [y0, y1] but never shifts its origin.

DXF layers: closed cut contours on ``CUT``; one bend CENTER line per bend
(at x = BA/2 in the strap) on ``BEND_UP_<deg>`` / ``BEND_DOWN_<deg>``
(lowercased names contain "bend" -- the skills/dxf layer convention -- and
carry the fold angle so non-90 parts stay manufacturable downstream).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

from cadpy.assembly import label_shape

DEFAULT_K_FACTOR = 0.44  # mild steel, air bending; override per part or per bend
_FUSE_EPS = 0.2   # 3D seam tab half-width (spike-validated: zero volume error)
_FLAT_EPS = 0.2   # 2D strap end extension (fully inside panels; fuse aid only)
_TOL = 1e-9


def bend_allowance(
    angle_deg: float, radius: float, thickness: float,
    k_factor: float = DEFAULT_K_FACTOR,
) -> float:
    """Unfolded arc length BA = theta_rad * (R + K*t) (theta by magnitude)."""
    return math.radians(abs(angle_deg)) * (radius + k_factor * thickness)


def jog_web(offset: float, angle_deg: float, radius: float, thickness: float) -> float:
    """Jog web length w so two opposite ``angle`` bends realise ``offset``.

    Mid-plane closed form: offset = w*sin(theta) + 2*(R + t/2)*(1 - cos(theta))
    => w = (|offset| - 2*(R + t/2)*(1 - cos)) / sin. May return <= 0 (the
    caller turns that into a ValueError naming the minimal feasible offset).
    """
    th = math.radians(abs(angle_deg))
    return (abs(offset) - 2.0 * (radius + thickness / 2.0) * (1.0 - math.cos(th))) / math.sin(th)


# ---------------------------------------------------------------------------
# pure-2D helpers (no build123d: validation and the flat-overlap gate run cheap)
# ---------------------------------------------------------------------------
def _signed_area(pts: Sequence[tuple[float, float]]) -> float:
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return a / 2.0


def _is_simple_polygon(pts) -> bool:
    """No two non-adjacent edges may properly cross or overlap."""
    n = len(pts)
    for i in range(n):
        a0, a1 = pts[i], pts[(i + 1) % n]
        for j in range(i + 1, n):
            if j == i or (j + 1) % n == i or (i + 1) % n == j:
                continue
            if _segs_cross(a0, a1, pts[j], pts[(j + 1) % n]):
                return False
    return True


def _orient(p, q, r) -> float:
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def _segs_cross(a0, a1, b0, b1) -> bool:
    """Proper crossing (shared endpoints / grazing touches do not count)."""
    d1, d2 = _orient(a0, a1, b0), _orient(a0, a1, b1)
    d3, d4 = _orient(b0, b1, a0), _orient(b0, b1, a1)
    return ((d1 > _TOL and d2 < -_TOL) or (d1 < -_TOL and d2 > _TOL)) and (
        (d3 > _TOL and d4 < -_TOL) or (d3 < -_TOL and d4 > _TOL)
    )


def _point_in_poly(pt, pts) -> bool:
    """Strictly inside (ray casting; boundary points count as outside)."""
    x, y = pt
    inside = False
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        # on-edge -> not strictly inside
        if abs(_orient((x0, y0), (x1, y1), pt)) < 1e-7:
            lo, hi = min(x0, x1) - 1e-9, max(x0, x1) + 1e-9
            lo2, hi2 = min(y0, y1) - 1e-9, max(y0, y1) + 1e-9
            if lo <= x <= hi and lo2 <= y <= hi2:
                return False
        if (y0 > y) != (y1 > y):
            xi = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
            if xi > x:
                inside = not inside
    return inside


def _polys_overlap(a, b) -> bool:
    """Positive-area overlap of two simple polygons (touching is fine)."""
    for i in range(len(a)):
        for j in range(len(b)):
            if _segs_cross(a[i], a[(i + 1) % len(a)], b[j], b[(j + 1) % len(b)]):
                return True
    # containment without edge crossings (use vertex + edge midpoints)
    def probes(poly):
        n = len(poly)
        for i in range(n):
            yield poly[i]
            yield ((poly[i][0] + poly[(i + 1) % n][0]) / 2.0,
                   (poly[i][1] + poly[(i + 1) % n][1]) / 2.0)

    return any(_point_in_poly(p, b) for p in probes(a)) or any(
        _point_in_poly(p, a) for p in probes(b)
    )


def _dist_point_seg(pt, a, b) -> float:
    ax, ay = a
    vx, vy = b[0] - ax, b[1] - ay
    L2 = vx * vx + vy * vy
    if L2 < _TOL:
        return math.hypot(pt[0] - ax, pt[1] - ay)
    u = max(0.0, min(1.0, ((pt[0] - ax) * vx + (pt[1] - ay) * vy) / L2))
    return math.hypot(pt[0] - (ax + u * vx), pt[1] - (ay + u * vy))


def _xf_apply(xf, pt):
    """xf = (c, s, tx, ty): rotation-then-translate (rigid, no mirror)."""
    c, s, tx, ty = xf
    return (c * pt[0] - s * pt[1] + tx, s * pt[0] + c * pt[1] + ty)


def _xf_compose(outer, inner):
    """outer(inner(pt)) as a single (c, s, tx, ty)."""
    c1, s1, t1x, t1y = outer
    c2, s2, t2x, t2y = inner
    return (
        c1 * c2 - s1 * s2,
        s1 * c2 + c1 * s2,
        c1 * t2x - s1 * t2y + t1x,
        s1 * t2x + c1 * t2y + t1y,
    )


_XF_ID = (1.0, 0.0, 0.0, 0.0)


# ---------------------------------------------------------------------------
# fold-tree data model
# ---------------------------------------------------------------------------
@dataclass
class _Hole:
    x: float
    y: float
    d: float


@dataclass
class _Bend:
    edge: int
    span_req: tuple[float, float] | None   # None = full edge (resolved late)
    angle: float                           # signed; + folds toward +Z
    radius: float
    k_factor: float
    label: str
    child: "_Node"
    span_eff: tuple[float, float] | None = None   # after relief trim


@dataclass
class _Node:
    label: str
    kind: str                               # "base" | "flange"
    outline: list[tuple[float, float]] | None   # base: set now; flange: at finalize
    web: float = 0.0                        # flange only (local x extent)
    holes: list[_Hole] = field(default_factory=list)
    cutouts: list[list[tuple[float, float]]] = field(default_factory=list)
    bends: list[_Bend] = field(default_factory=list)
    relief_cuts: list[tuple[int, float]] = field(default_factory=list)  # (vertex, s)
    y_range: tuple[float, float] | None = None  # flange only: [y0, y1] after relief


class Panel:
    """Handle onto one fold-tree node; created by base()/flange(), not directly."""

    def __init__(self, sm: "SheetMetal", node: _Node):
        self._sm = sm
        self._node = node

    # -- edge resolution ----------------------------------------------------
    _RECT_EDGES = {"y-": 0, "x+": 1, "y+": 2, "x-": 3}

    def _edge_index(self, edge: int | str) -> int:
        node = self._node
        if isinstance(edge, str):
            if node.kind == "flange" and edge == "tip":
                return 1
            if node.kind == "base" and self._sm._base_is_rect and edge in self._RECT_EDGES:
                return self._RECT_EDGES[edge]
            raise ValueError(self._sm._err(
                f"面板「{node.label}」不認得邊 {edge!r}:基材矩形用 \"x+\"/\"x-\"/"
                f"\"y+\"/\"y-\",凸緣面板用 \"tip\"(遠端邊)或邊索引 0-3"))
        n = 4 if node.outline is None else len(node.outline)
        if not 0 <= edge < n:
            raise ValueError(self._sm._err(
                f"面板「{node.label}」邊索引 {edge} 超出範圍(0..{n - 1})"))
        if node.kind == "flange" and edge == 3:
            raise ValueError(self._sm._err(
                f"面板「{node.label}」的邊 3 是折彎縫(seam),不能再掛凸緣"))
        return edge

    # -- features ------------------------------------------------------------
    def flange(
        self,
        edge: int | str,
        *,
        angle: float = 90.0,
        length: float | None = None,
        web: float | None = None,
        radius: float | None = None,
        k_factor: float | None = None,
        span: tuple[float, float] | None = None,
        placement: str = "outside",
        label: str | None = None,
    ) -> "Panel":
        sm = self._sm
        sm._assert_open()
        node = self._node
        e = self._edge_index(edge)
        r = sm.bend_radius if radius is None else float(radius)
        k = sm.k_factor if k_factor is None else float(k_factor)
        a = float(angle)
        lbl = label or f"flange_{sm._n_bends}"

        if not 0.0 < abs(a) <= 180.0:
            raise ValueError(sm._err(
                f"凸緣「{lbl}」角度 {a:g}° 不合法:|angle| 必須在 (0, 180]"))
        if r < sm.thickness / 2.0 - _TOL:
            raise ValueError(sm._err(
                f"凸緣「{lbl}」內半徑 {r:g} mm 小於半板厚 {sm.thickness / 2.0:g} mm"
                f"(空氣折彎做不出),請加大 radius"))
        if not 0.0 < k <= 0.5:
            raise ValueError(sm._err(
                f"凸緣「{lbl}」k_factor {k:g} 超出中性層物理範圍 (0, 0.5]"))
        if (length is None) == (web is None):
            raise ValueError(sm._err(
                f"凸緣「{lbl}」length 與 web 恰須給一個(length=外緣腳長僅限 90°;"
                f"任意角度用 web=切線到板尾長)"))
        if length is not None:
            if abs(abs(a) - 90.0) > _TOL:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」angle={a:g}° 時外緣尺寸 length 語意不明,"
                    f"請改用 web=(切線到板尾的腹板長)"))
            w = float(length) - (r + sm.thickness)
            if w < sm.min_flange - _TOL:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」外緣腳長 {length:g} mm 扣除折彎 (R+t)="
                    f"{r + sm.thickness:g} 後腹板僅 {w:.2f} mm,低於最小凸緣長 "
                    f"{sm.min_flange:g} mm(約 4×板厚,折彎模夾持下限)"))
        else:
            w = float(web)
            if w < sm.min_flange - _TOL:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」腹板 {w:g} mm 低於最小凸緣長 {sm.min_flange:g} mm"
                    f"(約 4×板厚,折彎模夾持下限),請加長或以 min_flange= 覆寫"))
        if placement not in ("outside", "inside"):
            raise ValueError(sm._err(
                f"凸緣「{lbl}」placement 只能是 \"outside\" 或 \"inside\""))
        if placement == "inside":
            if span is not None:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」placement=\"inside\" 僅支援全邊(span 不可給)"))
            self._inset_edge(e, r + sm.thickness, lbl)
        if span is not None:
            s0, s1 = float(span[0]), float(span[1])
            if not s0 < s1:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」span {span} 不合法:需 s0 < s1"))
            span = (s0, s1)

        child = _Node(label=lbl, kind="flange", outline=None, web=w)
        node.bends.append(_Bend(
            edge=e, span_req=span, angle=a, radius=r, k_factor=k,
            label=lbl, child=child,
        ))
        sm._n_bends += 1
        return Panel(sm, child)

    def hem(
        self,
        edge: int | str = "tip",
        *,
        length: float,
        gap: float | None = None,
        k_factor: float | None = None,
        label: str | None = None,
    ) -> "Panel":
        """180-degree open hem: inner opening ``gap`` (default = t, so the
        return leaf clears the parent by exactly ``gap``). Sugar for
        flange(angle=180, radius=gap/2, web=length)."""
        sm = self._sm
        g = sm.thickness if gap is None else float(gap)
        lbl = label or f"hem_{sm._n_bends}"
        if g < sm.thickness - _TOL:
            raise ValueError(sm._err(
                f"摺邊「{lbl}」內開口 gap {g:g} mm 小於板厚 {sm.thickness:g} mm"
                f"(開放捲邊內徑至少一板厚)"))
        return self.flange(edge, angle=180.0, web=length, radius=g / 2.0,
                           k_factor=k_factor, label=lbl)

    def jog(
        self,
        edge: int | str = "tip",
        *,
        offset: float,
        length: float,
        angle: float = 90.0,
        radius: float | None = None,
        label: str | None = None,
    ) -> "Panel":
        """Step offset: two opposite ``angle`` bends around a short web, then a
        continuation panel of ``length``. ``offset`` is the signed plate offset
        (+ toward +Z). Returns the continuation Panel."""
        sm = self._sm
        r = sm.bend_radius if radius is None else float(radius)
        a = abs(float(angle))
        lbl = label or f"jog_{sm._n_bends}"
        if not 0.0 < a < 180.0:
            raise ValueError(sm._err(f"轉折「{lbl}」angle 必須在 (0, 180)"))
        w = jog_web(offset, a, r, sm.thickness)
        if w < sm.min_flange - _TOL:
            th = math.radians(a)
            off_min = sm.min_flange * math.sin(th) + 2.0 * (r + sm.thickness / 2.0) * (1.0 - math.cos(th))
            raise ValueError(sm._err(
                f"轉折「{lbl}」offset {offset:g} mm 太小:角度 {a:g}°、內半徑 {r:g} 下"
                f"最小可行 offset 為 {off_min:.2f} mm。請加大 offset、減小 radius,"
                f"或改小 angle"))
        sign = 1.0 if offset >= 0 else -1.0
        mid = self.flange(edge, angle=sign * a, web=w, radius=r, label=f"{lbl}_web")
        return mid.flange("tip", angle=-sign * a, web=length, radius=r, label=lbl)

    def hole(self, x: float, y: float, *, d: float) -> None:
        sm = self._sm
        sm._assert_open()
        if d <= 0:
            raise ValueError(sm._err(f"孔徑 d 必須為正,得 {d:g}"))
        self._node.holes.append(_Hole(float(x), float(y), float(d)))

    def cutout(self, profile: Sequence[tuple[float, float]]) -> None:
        sm = self._sm
        sm._assert_open()
        pts = [(float(x), float(y)) for x, y in profile]
        if len(pts) < 3 or not _is_simple_polygon(pts):
            raise ValueError(sm._err(
                f"面板「{self._node.label}」的 cutout 輪廓需 ≥3 點且不可自交"))
        if _signed_area(pts) < 0:
            pts.reverse()
        self._node.cutouts.append(pts)

    # -- inside placement: shift edge e inward by ``inset`` -------------------
    def _inset_edge(self, e: int, inset: float, lbl: str) -> None:
        sm = self._sm
        node = self._node
        if node.outline is None:
            raise ValueError(sm._err(
                f"凸緣「{lbl}」placement=\"inside\" 只支援基材面板(凸緣面板請改宣告 web)"))
        pts = node.outline
        n = len(pts)
        p0, p1 = pts[e], pts[(e + 1) % n]
        ex, ey = p1[0] - p0[0], p1[1] - p0[1]
        L = math.hypot(ex, ey)
        ex, ey = ex / L, ey / L
        nx, ny = ey, -ex
        for adj in ((e - 1) % n, (e + 1) % n):
            q0, q1 = pts[adj], pts[(adj + 1) % n]
            ax, ay = q1[0] - q0[0], q1[1] - q0[1]
            aL = math.hypot(ax, ay)
            if abs(ax / aL * ex + ay / aL * ey) > 1e-6:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」placement=\"inside\" 需要該邊兩鄰邊與其垂直"
                    f"(矩形/直角輪廓);斜接請改用 placement=\"outside\" 自行內縮輪廓"))
        moved = list(pts)
        moved[e] = (p0[0] - inset * nx, p0[1] - inset * ny)
        moved[(e + 1) % n] = (p1[0] - inset * nx, p1[1] - inset * ny)
        if _signed_area(moved) < _TOL or not _is_simple_polygon(moved):
            raise ValueError(sm._err(
                f"凸緣「{lbl}」placement=\"inside\" 內縮 {inset:g} mm 後基材輪廓退化"
                f"(基材太小裝不下這道折彎),請加大基材或改 outside"))
        for adj in ((e - 1) % n, (e + 1) % n):
            q0, q1 = moved[adj], moved[(adj + 1) % n]
            if math.hypot(q1[0] - q0[0], q1[1] - q0[1]) < sm.min_flange:
                raise ValueError(sm._err(
                    f"凸緣「{lbl}」placement=\"inside\" 內縮後鄰邊過短(<{sm.min_flange:g} mm)"))
        node.outline = moved


class SheetMetal:
    """Sheet-metal fold-tree builder; see the module docstring for conventions."""

    def __init__(
        self,
        *,
        thickness: float,
        bend_radius: float | None = None,
        k_factor: float = DEFAULT_K_FACTOR,
        min_flange: float | None = None,
        min_hole_to_bend: float | None = None,
        corner_relief: str | None = "square",
        relief_size: float | None = None,
        label: str = "sheet_metal",
    ) -> None:
        if thickness <= 0:
            raise ValueError(f"[鈑金 {label}] 板厚必須為正,得 {thickness:g}")
        self.thickness = float(thickness)
        self.bend_radius = self.thickness if bend_radius is None else float(bend_radius)
        if self.bend_radius < self.thickness / 2.0 - _TOL:
            raise ValueError(self._err_static(
                label,
                f"預設內半徑 {self.bend_radius:g} mm 小於半板厚 "
                f"{self.thickness / 2.0:g} mm(空氣折彎做不出)"))
        if not 0.0 < k_factor <= 0.5:
            raise ValueError(self._err_static(
                label, f"k_factor {k_factor:g} 超出中性層物理範圍 (0, 0.5]"))
        self.k_factor = float(k_factor)
        self.min_flange = 4.0 * self.thickness if min_flange is None else float(min_flange)
        self.min_hole_to_bend = (
            2.0 * self.thickness + self.bend_radius
            if min_hole_to_bend is None else float(min_hole_to_bend)
        )
        if corner_relief not in (None, "square"):
            raise ValueError(self._err_static(
                label, f"corner_relief 只支援 \"square\" 或 None,得 {corner_relief!r}"))
        self.corner_relief = corner_relief
        # lower bound keeps the relief notch clear of the _FLAT_EPS strap extension
        s_min = max(self.thickness / 2.0, _FLAT_EPS + 0.05)
        self.relief_size = max(
            s_min, self.thickness if relief_size is None else float(relief_size))
        self.label = label
        self._root: _Node | None = None
        self._base_is_rect = False
        self._n_bends = 0
        self._finalized = False

    # -- error helpers --------------------------------------------------------
    @staticmethod
    def _err_static(label: str, msg: str) -> str:
        return f"[鈑金 {label}] {msg}"

    def _err(self, msg: str) -> str:
        return f"[鈑金 {self.label}] {msg}"

    def _assert_open(self) -> None:
        if self._finalized:
            raise ValueError(self._err(
                "fold tree 已凍結(呼叫過 folded()/flat()/dxf() 後不可再加特徵)"))

    # -- declaration -----------------------------------------------------------
    def base(self, profile: Sequence[tuple[float, float]]) -> Panel:
        if self._root is not None:
            raise ValueError(self._err("base 已宣告過(一件鈑金只有一片基材)"))
        pts = [(float(x), float(y)) for x, y in profile]
        if len(pts) < 3 or not _is_simple_polygon(pts):
            raise ValueError(self._err("基材輪廓需 ≥3 點且不可自交"))
        if abs(_signed_area(pts)) < _TOL:
            raise ValueError(self._err("基材輪廓面積為零"))
        if _signed_area(pts) < 0:
            pts.reverse()
        self._root = _Node(label="base", kind="base", outline=pts)
        return Panel(self, self._root)

    def base_rect(self, size_x: float, size_y: float) -> Panel:
        if size_x <= 0 or size_y <= 0:
            raise ValueError(self._err(f"base_rect 尺寸必須為正,得 {size_x:g}×{size_y:g}"))
        p = self.base([(0.0, 0.0), (size_x, 0.0), (size_x, size_y), (0.0, size_y)])
        self._base_is_rect = True
        return p

    # -- finalize: resolve spans, corner relief, validate, flat-overlap gate ----
    def _finalize(self) -> None:
        if self._finalized:
            return
        if self._root is None:
            raise ValueError(self._err("尚未宣告 base 基材"))
        self._finalize_node(self._root)
        self._flat_gate()
        self._finalized = True

    def _edges(self, node: _Node):
        pts = node.outline
        n = len(pts)
        out = []
        for i in range(n):
            p0, p1 = pts[i], pts[(i + 1) % n]
            ex, ey = p1[0] - p0[0], p1[1] - p0[1]
            L = math.hypot(ex, ey)
            out.append((p0, (ex / L, ey / L), L))
        return out

    def _finalize_node(self, node: _Node) -> None:
        edges = self._edges(node)
        # resolve spans
        for b in node.bends:
            L = edges[b.edge][2]
            s = (0.0, L) if b.span_req is None else b.span_req
            if s[0] < -_TOL or s[1] > L + _TOL:
                raise ValueError(self._err(
                    f"凸緣「{b.label}」span {s} 超出邊長 {L:g} mm"))
            b.span_eff = (max(0.0, s[0]), min(L, s[1]))
        # same-edge spans must not overlap and keep >= t clearance
        by_edge: dict[int, list[_Bend]] = {}
        for b in node.bends:
            by_edge.setdefault(b.edge, []).append(b)
        for e, bs in by_edge.items():
            bs_sorted = sorted(bs, key=lambda b: b.span_eff[0])
            for b0, b1 in zip(bs_sorted, bs_sorted[1:]):
                if b1.span_eff[0] - b0.span_eff[1] < self.thickness - _TOL:
                    raise ValueError(self._err(
                        f"同一邊上的凸緣「{b0.label}」與「{b1.label}」span 重疊或間距"
                        f"小於板厚 {self.thickness:g} mm"))
        # corner relief: both spans touching a shared vertex
        n = len(node.outline)
        s = self.relief_size
        for v in range(n):
            ea, eb = (v - 1) % n, v            # edges meeting at vertex v
            La = edges[ea][2]
            ba = next((b for b in node.bends
                       if b.edge == ea and b.span_eff[1] > La - _TOL), None)
            bb = next((b for b in node.bends
                       if b.edge == eb and b.span_eff[0] < _TOL), None)
            if ba is None or bb is None:
                continue
            if self.corner_relief is None:
                raise ValueError(self._err(
                    f"凸緣「{ba.label}」與「{bb.label}」在角落相接:請開 "
                    f"corner_relief=\"square\" 或自行縮短 span 留角落間隙"))
            if ba.span_eff[1] - ba.span_eff[0] <= s + self.min_flange or \
               bb.span_eff[1] - bb.span_eff[0] <= s + self.min_flange:
                raise ValueError(self._err(
                    f"凸緣「{ba.label}」/「{bb.label}」太窄,釋料 {s:g} mm 後不足"
                    f"最小凸緣寬,請加寬或縮短 span"))
            ba.span_eff = (ba.span_eff[0], La - s)
            bb.span_eff = (s, bb.span_eff[1])
            node.relief_cuts.append((v, s))
        # per-node feature validation
        self._validate_features(node, edges)
        # children: outline = rect(web × span_eff), then recurse
        for b in node.bends:
            y0 = b.span_eff[0] - (b.span_req[0] if b.span_req else 0.0)
            y1 = b.span_eff[1] - (b.span_req[0] if b.span_req else 0.0)
            b.child.y_range = (y0, y1)
            b.child.outline = [(0.0, y0), (b.child.web, y0),
                               (b.child.web, y1), (0.0, y1)]
            self._finalize_node(b.child)

    def _bend_edge_segments(self, node: _Node, edges):
        """Segments that are bend tangents on this node (for hole clearance)."""
        segs = []
        for b in node.bends:
            p0, e, _ = edges[b.edge]
            a = (p0[0] + b.span_eff[0] * e[0], p0[1] + b.span_eff[0] * e[1])
            bpt = (p0[0] + b.span_eff[1] * e[0], p0[1] + b.span_eff[1] * e[1])
            segs.append((a, bpt, b.label))
        if node.kind == "flange":
            y0, y1 = node.y_range
            segs.append(((0.0, y0), (0.0, y1), "折彎縫"))
        return segs

    def _validate_features(self, node: _Node, edges) -> None:
        outline = self._effective_outline(node)
        bend_segs = self._bend_edge_segments(node, edges)
        for h in node.holes:
            c = (h.x, h.y)
            if not _point_in_poly(c, outline):
                raise ValueError(self._err(
                    f"面板「{node.label}」的孔 (x={h.x:g}, y={h.y:g}) 圓心在板外"))
            for i in range(len(outline)):
                d = _dist_point_seg(c, outline[i], outline[(i + 1) % len(outline)])
                if d < h.d / 2.0 + self.thickness - _TOL:
                    raise ValueError(self._err(
                        f"面板「{node.label}」的孔 (x={h.x:g}, y={h.y:g}, d={h.d:g}) "
                        f"距板邊僅 {d - h.d / 2.0:.2f} mm,低於板厚 {self.thickness:g} mm"
                        f"(雷切邊距下限),請移孔或縮孔"))
            if self.min_hole_to_bend > 0:
                for a, bpt, blbl in bend_segs:
                    d = _dist_point_seg(c, a, bpt) - h.d / 2.0
                    if d < self.min_hole_to_bend - _TOL:
                        raise ValueError(self._err(
                            f"面板「{node.label}」的孔 (x={h.x:g}, y={h.y:g}, d={h.d:g}) "
                            f"距折彎「{blbl}」切線僅 {d:.2f} mm,低於 "
                            f"{self.min_hole_to_bend:g} mm(2×板厚+內半徑,折彎會拉變形孔)。"
                            f"請移孔、或以 min_hole_to_bend= 覆寫(設 0 停用)"))
        for cut in node.cutouts:
            for p in cut:
                if not _point_in_poly(p, outline):
                    raise ValueError(self._err(
                        f"面板「{node.label}」的 cutout 頂點 {p} 在板外"))
                if self.min_hole_to_bend > 0:
                    for a, bpt, blbl in bend_segs:
                        if _dist_point_seg(p, a, bpt) < self.min_hole_to_bend - _TOL:
                            raise ValueError(self._err(
                                f"面板「{node.label}」的 cutout 壓到折彎「{blbl}」"
                                f"保留區(距切線 < {self.min_hole_to_bend:g} mm)"))

    def _effective_outline(self, node: _Node) -> list[tuple[float, float]]:
        """Outline with square corner-relief notches applied (vertex detours)."""
        pts = list(node.outline)
        if not node.relief_cuts:
            return pts
        n = len(node.outline)
        edges = self._edges(node)
        out: list[tuple[float, float]] = []
        cut_by_vertex = {v: s for v, s in node.relief_cuts}
        for i, p in enumerate(node.outline):
            if i not in cut_by_vertex:
                out.append(p)
                continue
            s = cut_by_vertex[i]
            e_in = edges[(i - 1) % n][1]
            e_out = edges[i][1]
            out.append((p[0] - s * e_in[0], p[1] - s * e_in[1]))
            out.append((p[0] - s * e_in[0] + s * e_out[0],
                        p[1] - s * e_in[1] + s * e_out[1]))
            out.append((p[0] + s * e_out[0], p[1] + s * e_out[1]))
        return out

    # -- flat traversal (pure numeric; feeds gate, flat(), dxf(), flat_size) ----
    def _flat_geo(self):
        """Finalized flat traversal. Returns (panels, straps, bend_lines) where
        panels = [(node, outline_pts, holes, cutouts)] in GLOBAL flat coords,
        straps = [(bend, corner_pts)], bend_lines = [(p0, p1, angle_signed)]."""
        self._finalize()
        return self._flat_geo_raw()

    def _flat_gate(self) -> None:
        """H2 gate: no two non-adjacent flat members may overlap (silent DXF
        material loss otherwise -- e.g. two flanges unfolding into each other
        across a concave base corner)."""
        panels, straps, _ = self._flat_geo_raw()
        members: list[tuple[str, object, list]] = []
        for node, outline, _h, _c in panels:
            members.append(("panel", node, outline))
        for b, pts in straps:
            members.append(("strap", b, pts))

        def adjacent(m0, m1) -> bool:
            (k0, o0, _), (k1, o1, _) = m0, m1
            if k0 == "strap" and k1 == "panel":
                return o1 is o0.child or any(b is o0 for b in o1.bends)
            if k1 == "strap" and k0 == "panel":
                return adjacent(m1, m0)
            return False

        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                if adjacent(members[i], members[j]):
                    continue
                if _polys_overlap(members[i][2], members[j][2]):
                    n0 = members[i][1].label if members[i][0] == "panel" else f"折彎「{members[i][1].label}」展開帶"
                    n1 = members[j][1].label if members[j][0] == "panel" else f"折彎「{members[j][1].label}」展開帶"
                    raise ValueError(self._err(
                        f"攤平圖自交:「{n0}」與「{n1}」在展開後重疊——這種設計"
                        f"無法從單張板材折出。請縮短凸緣、改折彎方向,或拆成多件"))

    def _flat_geo_raw(self):
        """_flat_geo without triggering _finalize recursion (gate runs inside)."""
        panels, straps, blines = [], [], []

        def walk(node: _Node, xf):
            outline = [_xf_apply(xf, p) for p in self._effective_outline(node)]
            holes = [(_xf_apply(xf, (h.x, h.y)), h.d) for h in node.holes]
            cuts = [[_xf_apply(xf, p) for p in cut] for cut in node.cutouts]
            panels.append((node, outline, holes, cuts))
            edges = self._edges(node)
            for b in node.bends:
                p0, e, _ = edges[b.edge]
                nx, ny = e[1], -e[0]
                ba = bend_allowance(b.angle, b.radius, self.thickness, b.k_factor)
                s0, s1 = b.span_eff
                o = (p0[0] + s0 * e[0], p0[1] + s0 * e[1])
                span_len = s1 - s0
                corners_local = [
                    (o[0] - _FLAT_EPS * nx, o[1] - _FLAT_EPS * ny),
                    (o[0] + (ba + _FLAT_EPS) * nx, o[1] + (ba + _FLAT_EPS) * ny),
                    (o[0] + (ba + _FLAT_EPS) * nx + span_len * e[0],
                     o[1] + (ba + _FLAT_EPS) * ny + span_len * e[1]),
                    (o[0] - _FLAT_EPS * nx + span_len * e[0],
                     o[1] - _FLAT_EPS * ny + span_len * e[1]),
                ]
                straps.append((b, [_xf_apply(xf, p) for p in corners_local]))
                m0 = (o[0] + (ba / 2.0) * nx, o[1] + (ba / 2.0) * ny)
                m1 = (m0[0] + span_len * e[0], m0[1] + span_len * e[1])
                blines.append((_xf_apply(xf, m0), _xf_apply(xf, m1), b.angle))
                s_req0 = b.span_req[0] if b.span_req else 0.0
                oreq = (p0[0] + s_req0 * e[0], p0[1] + s_req0 * e[1])
                local = (e[1], -e[0], oreq[0] + ba * nx, oreq[1] + ba * ny)
                walk(b.child, _xf_compose(xf, local))

        walk(self._root, _XF_ID)
        return panels, straps, blines

    def flat_size(self) -> tuple[float, float]:
        """Flat-pattern bounding box (stock size), pure numeric."""
        panels, straps, _ = self._flat_geo()
        xs, ys = [], []
        for _n, outline, _h, _c in panels:
            xs += [p[0] for p in outline]
            ys += [p[1] for p in outline]
        # straps stay inside panel-hull between panels; still include for safety
        for _b, pts in straps:
            xs += [p[0] for p in pts]
            ys += [p[1] for p in pts]
        return (max(xs) - min(xs), max(ys) - min(ys))

    # -- 3D construction ---------------------------------------------------------
    def _panel_face(self, node: _Node):
        from build123d import Circle, Polygon, Pos

        face = Polygon(*self._effective_outline(node), align=None)
        for h in node.holes:
            face -= Pos(h.x, h.y) * Circle(h.d / 2.0)
        for cut in node.cutouts:
            face -= Polygon(*cut, align=None)
        return face

    @staticmethod
    def _bend_sector(angle_deg: float, r: float, t: float, span_len: float):
        """Annular sector solid in the edge frame E (x=outward, y=along edge,
        z=plate normal). Section drawn once as a wire -> face -> extrude:
        no boolean between coplanar radial faces (spike-validated)."""
        from build123d import CenterArc, Line, Pos, Rot, extrude, make_face

        th, up = abs(angle_deg), angle_deg > 0
        c = (0.0, t + r) if up else (0.0, -r)
        a0 = -90.0 if up else 90.0
        sw = th if up else -th
        outer = CenterArc(c, r + t, start_angle=a0, arc_size=sw)
        inner = CenterArc(c, r, start_angle=a0 + sw, arc_size=-sw)
        face = make_face([outer, Line(outer @ 1, inner @ 0),
                          inner, Line(inner @ 1, outer @ 0)])
        solid = extrude(face, amount=span_len)
        return Pos(0, span_len, 0) * Rot(90, 0, 0) * solid  # (x,y,z)->(x,span-z,y)

    @staticmethod
    def _bend_xform(angle_deg: float, r: float, t: float):
        """Edge frame E -> child panel local frame (child material z in [0,t])."""
        from build123d import Pos, Rot

        th = math.radians(abs(angle_deg))
        if angle_deg > 0:
            rho = r + t
            return Pos(rho * math.sin(th), 0, rho * (1 - math.cos(th))) * Rot(0, -abs(angle_deg), 0)
        rho = r
        return Pos(rho * math.sin(th), 0, -rho * (1 - math.cos(th))) * Rot(0, abs(angle_deg), 0)

    def _seam_tab(self, span0: float, span1: float):
        """Fuse tab at a seam, recessed to z in [delta, t-delta] so both faces
        leave the bend cylinders (every contact transversal; no tangent fuse)."""
        from build123d import Box, Pos

        t = self.thickness
        d = min(_FUSE_EPS, t / 4.0)
        L = span1 - span0
        return Pos(0, (span0 + span1) / 2.0, t / 2.0) * Box(2 * _FUSE_EPS, L, t - 2 * d)

    def _folded_members(self):
        """[(kind, obj, solid)] with kind in {panel, sector}; tabs separate."""
        from build123d import Pos, Rot, extrude

        members, tabs = [], []

        def walk(node: _Node, loc):
            members.append(("panel", node, loc * extrude(self._panel_face(node), amount=self.thickness)))
            edges = self._edges(node)
            for b in node.bends:
                p0, e, _ = edges[b.edge]
                s0, s1 = b.span_eff
                span_len = s1 - s0
                o = (p0[0] + s0 * e[0], p0[1] + s0 * e[1])
                phi = math.degrees(math.atan2(-e[0], e[1]))  # n̂=(e_y,−e_x) heading
                eframe = loc * (Pos(o[0], o[1], 0) * Rot(0, 0, phi))
                members.append(("sector", b, eframe * self._bend_sector(
                    b.angle, b.radius, self.thickness, span_len)))
                tabs.append(eframe * self._seam_tab(0.0, span_len))
                # child location: origin at requested span start; child y0 covers relief
                s_req0 = b.span_req[0] if b.span_req else 0.0
                oreq = (p0[0] + s_req0 * e[0], p0[1] + s_req0 * e[1])
                eframe_req = loc * (Pos(oreq[0], oreq[1], 0) * Rot(0, 0, phi))
                child_loc = eframe_req * self._bend_xform(b.angle, b.radius, self.thickness)
                y0, y1 = b.child.y_range
                tabs.append(child_loc * self._seam_tab(y0, y1))
                walk(b.child, child_loc)

        from build123d import Location

        walk(self._root, Location())
        return members, tabs

    def _assert_no_fold_collision(self, members) -> None:
        """Pairwise overlap of NON-adjacent members (a fused solid hides
        self-penetration from assert_no_interference, so gate before fusing)."""
        from cadpy.geometry_checks import overlap_volume

        def adjacent(m0, m1) -> bool:
            (k0, o0, _), (k1, o1, _) = m0, m1
            if k0 == "sector" and k1 == "panel":
                return o1 is o0.child or any(b is o0 for b in o1.bends)
            if k1 == "sector" and k0 == "panel":
                return adjacent(m1, m0)
            return False

        boxes = [m[2].bounding_box() for m in members]
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                if adjacent(members[i], members[j]):
                    continue
                bi, bj = boxes[i], boxes[j]
                if (bi.min.X > bj.max.X or bj.min.X > bi.max.X or
                        bi.min.Y > bj.max.Y or bj.min.Y > bi.max.Y or
                        bi.min.Z > bj.max.Z or bj.min.Z > bi.max.Z):
                    continue
                vol = overlap_volume(members[i][2], members[j][2])
                if vol > 1e-6:
                    def name(m):
                        return (f"面板「{m[1].label}」" if m[0] == "panel"
                                else f"折彎「{m[1].label}」")
                    raise ValueError(self._err(
                        f"摺疊後自碰:{name(members[i])}與{name(members[j])}重疊 "
                        f"{vol:.1f} mm³。請縮短凸緣 web、調整折彎角度或 span"))

    def folded(self) -> Any:
        """The bent part as ONE labeled valid solid."""
        from functools import reduce
        from operator import add

        self._finalize()
        members, tabs = self._folded_members()
        self._assert_no_fold_collision(members)
        body = reduce(add, [m[2] for m in members] + tabs).clean()
        label_shape(body, self.label)
        return body

    def _flat_face(self):
        from build123d import Circle, Polygon, Pos
        from functools import reduce
        from operator import add

        panels, straps, _ = self._flat_geo()
        faces = []
        for _node, outline, holes, cuts in panels:
            f = Polygon(*outline, align=None)
            for (cx, cy), d in holes:
                f -= Pos(cx, cy) * Circle(d / 2.0)
            for cut in cuts:
                f -= Polygon(*cut, align=None)
            faces.append(f)
        for _b, pts in straps:
            faces.append(Polygon(*pts, align=None))
        sk = reduce(add, faces).clean()
        fl = sk.faces()
        if len(fl) != 1:
            raise ValueError(self._err(
                f"攤平面融合異常:得到 {len(fl)} 個面(預期 1)——請回報此案例"))
        return fl[0]

    def flat(self) -> Any:
        """Flat pattern as ONE labeled solid of thickness t (3D preview twin)."""
        from build123d import extrude

        self._finalize()
        body = extrude(self._flat_face(), amount=self.thickness).clean()
        label_shape(body, f"{self.label}_flat")
        return body

    # -- DXF ---------------------------------------------------------------------
    @staticmethod
    def _wire_polyline_pts(wire) -> list[tuple[float, float]]:
        """Ordered vertex loop of a line-only wire (endpoint-chained, tolerant
        to per-edge orientation flips)."""
        edges = wire.order_edges()
        pts: list[tuple[float, float]] = []
        cur = None
        for ed in edges:
            s, t = ed @ 0, ed @ 1
            s2, t2 = (s.X, s.Y), (t.X, t.Y)
            if cur is not None and math.hypot(s2[0] - cur[0], s2[1] - cur[1]) > 1e-6:
                s2, t2 = t2, s2
            if cur is None:
                pts.append(s2)
            pts.append(t2)
            cur = t2
        if len(pts) > 1 and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 1e-6:
            pts.pop()
        return pts

    def dxf(self) -> Any:
        """Flat pattern as an ezdxf document (gen_dxf envelope: return as-is).

        CUT: closed outer contour + hole circles + cutout loops.
        BEND_UP_<deg> / BEND_DOWN_<deg>: one center line per bend (x=BA/2)."""
        import ezdxf
        from build123d import GeomType

        self._finalize()
        face = self._flat_face()
        _p, _s, blines = self._flat_geo()

        doc = ezdxf.new("R2010")
        doc.units = ezdxf.units.MM
        doc.layers.add("CUT", color=7)
        msp = doc.modelspace()

        def emit_wire(wire):
            edges = wire.edges()
            if len(edges) == 1 and edges[0].geom_type == GeomType.CIRCLE:
                c = edges[0].arc_center
                msp.add_circle((c.X, c.Y), edges[0].radius, dxfattribs={"layer": "CUT"})
                return
            for ed in edges:
                if ed.geom_type != GeomType.LINE:
                    raise ValueError(self._err(
                        f"攤平輪廓含非直線/整圓的邊({ed.geom_type}),DXF 匯出"
                        f"尚未支援此曲線型別"))
            msp.add_lwpolyline(self._wire_polyline_pts(wire), format="xy",
                               close=True, dxfattribs={"layer": "CUT"})

        emit_wire(face.outer_wire())
        for w in face.inner_wires():
            emit_wire(w)

        made_layers = set()
        for p0, p1, angle in blines:
            up = angle > 0
            layer = f"BEND_{'UP' if up else 'DOWN'}_{abs(angle):g}".replace(".", "_")
            if layer not in made_layers:
                doc.layers.add(layer, color=2 if up else 4)
                made_layers.add(layer)
            msp.add_line(p0, p1, dxfattribs={"layer": layer})
        return doc


def check_geometry(shape: Any, *, sweep_args: dict | None = None) -> None:
    """Acceptance gate: valid solid(s); a multi-part compound (sheet part
    assembled with standard parts) additionally checks undeclared interference.
    Sheet metal has no motion sweep -- ``sweep_args`` only exists so the family
    signature matches the others, and is rejected if given. Uniform thickness
    is a CONSTRUCTION guarantee (the builder only makes t-thick prisms and
    R..R+t sectors); tests witness it via the flat bbox height."""
    if sweep_args is not None:
        raise ValueError("鈑金家族沒有運動掃掠;sweep_args 不適用")
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="sheet metal part")
    children = getattr(shape, "children", None) or []
    if len(children) >= 2:
        assert_no_interference(shape)
