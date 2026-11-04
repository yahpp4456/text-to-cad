"""曲面分析:邊連續性(G0/G1/G2)、開放邊、面曲率統計、控制點籠。

連續性量測(探針定案,2026-10-10):對每條恰有 2 個鄰面的非退化邊,在**同一個邊參數**
取兩面的 pcurve(SameParameter 保證 3D 同點;改用 3D 近似配對會把兩半球量成 3° 的假 G0),
以 ``BRepLProp_SLProps``(N=2)取**依面方向校正**的法向與主曲率:
- G1:兩法向夾角(度)≤ ``G1_TOL_DEG``;
- G2:在切平面內「垂直邊切向」方向的法曲率(Euler 公式由主曲率/主方向算),相對偏差
  ``|k0−k1| / (|k0|+|k1|)`` ≤ ``G2_REL_TOL``(Rhino EdgeContinuity 的相對偏差定義);兩側皆近平坦
  (|k| < ``FLAT_K``)視為 G2。
等級 = 全部取樣點的最差者。OCCT ``LocalAnalysis_SurfaceContinuity`` 在探針中與此判定一致,
但它的 G2 回傳是絕對曲率差、對尺度敏感,故正式量測用相對偏差。
"""
from __future__ import annotations

import math
from typing import Any

G1_TOL_DEG = 0.5
G2_REL_TOL = 0.05
FLAT_K = 1e-4
EDGE_SAMPLES = 7
EDGE_POLYLINE_POINTS = 16
GRADE_RANK = {"G0": 0, "G1": 1, "G2": 2}

# 防禦性上限(sidecar / 前端)
MAX_EDGES = 400
MAX_CAGE_FACES = 32
MAX_CAGE_POLES = 40


def _face_map(shape):
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape.wrapped, TopAbs_FACE, fmap)
    return fmap


def _edge_face_map(shape):
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)
    return emap


def _oriented_props(face, u: float, v: float):
    """回 (oriented normal Vector|None, SLProps, sign)。sign 把主曲率轉成「依面方向」的符號。"""
    from build123d import Vector
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.TopAbs import TopAbs_REVERSED

    props = BRepLProp_SLProps(BRepAdaptor_Surface(face, True), u, v, 2, 1e-6)
    if not props.IsNormalDefined():
        return None, props, 1.0
    n = props.Normal()
    nv = Vector(n.X(), n.Y(), n.Z())
    sign = 1.0
    if face.Orientation() == TopAbs_REVERSED:
        nv = -nv
        sign = -1.0
    return nv, props, sign


def _normal_curvature(props, sign: float, nvec, tangent) -> float:
    """切平面內垂直於 ``tangent`` 的方向之法曲率(Euler)。曲率未定義回 0。"""
    from build123d import Vector
    from OCP.gp import gp_Dir

    if not props.IsCurvatureDefined():
        return 0.0
    dmax = gp_Dir()
    dmin = gp_Dir()
    props.CurvatureDirections(dmax, dmin)
    dm = Vector(dmax.X(), dmax.Y(), dmax.Z())
    b = nvec.cross(tangent)
    if b.length < 1e-12:
        return 0.0
    b = b.normalized()
    c = b.dot(dm)
    kn = props.MaxCurvature() * c * c + props.MinCurvature() * (1.0 - c * c)
    return sign * kn


def _edge_points(edge_topo, n: int) -> tuple[list[list[float]], float]:
    from build123d import Edge

    e = Edge(edge_topo)
    pts = []
    for i in range(n):
        p = e.position_at(i / (n - 1))
        pts.append([round(p.X, 4), round(p.Y, 4), round(p.Z, 4)])
    return pts, float(e.length)


def edge_continuity(
    shape,
    *,
    samples: int = EDGE_SAMPLES,
    g1_tol_deg: float = G1_TOL_DEG,
    g2_rel: float = G2_REL_TOL,
    polyline_points: int = EDGE_POLYLINE_POINTS,
) -> list[dict[str, Any]]:
    """所有「恰 2 鄰面」內邊的連續性列(退化邊/接縫邊略過)。"""
    from build123d import Vector
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Curve2d
    from OCP.TopoDS import TopoDS

    fmap = _face_map(shape)
    emap = _edge_face_map(shape)
    rows: list[dict[str, Any]] = []
    for i in range(1, emap.Extent() + 1):
        if len(rows) >= MAX_EDGES:
            break
        edge = TopoDS.Edge_s(emap.FindKey(i))
        if BRep_Tool.Degenerated_s(edge):
            continue
        faces = [TopoDS.Face_s(f) for f in emap.FindFromIndex(i)]
        if len(faces) != 2 or faces[0].IsSame(faces[1]):
            continue
        f0, f1 = faces
        c0 = BRepAdaptor_Curve2d(edge, f0)
        c1 = BRepAdaptor_Curve2d(edge, f1)
        a0, b0 = c0.FirstParameter(), c0.LastParameter()
        cv = BRepAdaptor_Curve(edge)
        g1max = 0.0
        g2max = 0.0
        n_ok = 0
        for k in range(1, samples + 1):
            t = a0 + (b0 - a0) * k / (samples + 1)
            p0 = c0.Value(t)
            q1 = c1.Value(t)
            n0, pr0, s0 = _oriented_props(f0, p0.X(), p0.Y())
            n1, pr1, s1 = _oriented_props(f1, q1.X(), q1.Y())
            if n0 is None or n1 is None:
                continue
            n_ok += 1
            dot = max(-1.0, min(1.0, n0.normalized().dot(n1.normalized())))
            g1max = max(g1max, math.degrees(math.acos(dot)))
            tv = cv.DN(t, 1)
            tvec = Vector(tv.X(), tv.Y(), tv.Z())
            if tvec.length < 1e-12:
                continue
            tvec = tvec.normalized()
            k0 = _normal_curvature(pr0, s0, n0, tvec)
            k1 = _normal_curvature(pr1, s1, n1, tvec)
            if abs(k0) < FLAT_K and abs(k1) < FLAT_K:
                rel = 0.0
            else:
                den = abs(k0) + abs(k1)
                rel = abs(k0 - k1) / den if den > 1e-12 else 0.0
            g2max = max(g2max, rel)
        if n_ok == 0:
            continue
        grade = "G0" if g1max > g1_tol_deg else ("G2" if g2max <= g2_rel else "G1")
        pts, length = _edge_points(edge, polyline_points)
        # 平面鄰邊(端蓋/底板與曲面相接)是刻意的建構銳邊:仍量、仍回報,但不進連續性閘
        flat = _is_planar(f0) or _is_planar(f1)
        rows.append({
            "i": i,
            "faces": [fmap.FindIndex(f0), fmap.FindIndex(f1)],
            "grade": grade,
            "flat": flat,
            "g1Deg": round(g1max, 4),
            "g2Rel": round(g2max, 4),
            "length": round(length, 3),
            "pts": pts,
        })
    return rows


def _is_planar(face_topo) -> bool:
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane

    try:
        return BRepAdaptor_Surface(face_topo, True).GetType() == GeomAbs_Plane
    except Exception:  # noqa: BLE001
        return False


def free_edges(shape, *, polyline_points: int = EDGE_POLYLINE_POINTS) -> list[dict[str, Any]]:
    """只有 1 個鄰面的非退化邊(開放殼的邊界)。"""
    from OCP.BRep import BRep_Tool
    from OCP.TopoDS import TopoDS

    emap = _edge_face_map(shape)
    out = []
    for i in range(1, emap.Extent() + 1):
        if len(out) >= MAX_EDGES:
            break
        edge = TopoDS.Edge_s(emap.FindKey(i))
        if BRep_Tool.Degenerated_s(edge):
            continue
        if emap.FindFromIndex(i).Size() != 1:
            continue
        pts, length = _edge_points(edge, polyline_points)
        out.append({"i": i, "length": round(length, 3), "pts": pts})
    return out


def face_curvature_stats(face, grid: int = 6) -> dict[str, Any]:
    """面上 grid×grid 取樣的主曲率/高斯曲率範圍(依面方向校正)。"""
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    ad = BRepAdaptor_Surface(face.wrapped if hasattr(face, "wrapped") else face, True)
    u0, u1 = ad.FirstUParameter(), ad.LastUParameter()
    v0, v1 = ad.FirstVParameter(), ad.LastVParameter()
    kmin = math.inf
    kmax = -math.inf
    gmin = math.inf
    gmax = -math.inf
    kabs = 0.0
    topo = face.wrapped if hasattr(face, "wrapped") else face
    n = 0
    for i in range(grid):
        for j in range(grid):
            u = u0 + (u1 - u0) * (i + 0.5) / grid
            v = v0 + (v1 - v0) * (j + 0.5) / grid
            _, pr, sgn = _oriented_props(topo, u, v)
            if not pr.IsCurvatureDefined():
                continue
            a = sgn * pr.MinCurvature()
            b = sgn * pr.MaxCurvature()
            lo, hi = min(a, b), max(a, b)
            kmin = min(kmin, lo)
            kmax = max(kmax, hi)
            g = pr.GaussianCurvature()
            gmin = min(gmin, g)
            gmax = max(gmax, g)
            kabs = max(kabs, abs(lo), abs(hi))
            n += 1
    if n == 0:
        return {"kmin": 0.0, "kmax": 0.0, "kgaussMin": 0.0, "kgaussMax": 0.0, "kabsMax": 0.0, "samples": 0}
    return {
        "kmin": round(kmin, 6),
        "kmax": round(kmax, 6),
        "kgaussMin": round(gmin, 8),
        "kgaussMax": round(gmax, 8),
        "kabsMax": round(kabs, 6),
        "samples": n,
    }


def max_abs_curvature(shape, grid: int = 6) -> float:
    """整個形狀的最大 |主曲率|(加厚閘:t 不得 ≥ 0.9/kabsMax)。"""
    best = 0.0
    for f in shape.faces():
        best = max(best, face_curvature_stats(f, grid)["kabsMax"])
    return best


def surface_type(face) -> str:
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    ad = BRepAdaptor_Surface(face.wrapped, True)
    name = str(ad.GetType())
    return name.split(".")[-1].replace("GeomAbs_", "").lower()


def control_cage(face) -> dict[str, Any] | None:
    """B-spline 面的極點網 ``{"nu","nv","degU","degV","rows":[[[x,y,z],…],…]}``;非 B-spline 回 None。"""
    from OCP.BRep import BRep_Tool
    from OCP.Geom import Geom_BSplineSurface

    s = BRep_Tool.Surface_s(face.wrapped)
    # OCP 的 BRep_Tool.Surface_s 已回具體子類(無 DownCast_s);非 B-spline 面回 None
    bs = s if isinstance(s, Geom_BSplineSurface) else None
    if bs is None:
        return None
    nu, nv = bs.NbUPoles(), bs.NbVPoles()
    if nu > MAX_CAGE_POLES or nv > MAX_CAGE_POLES:
        return None
    rows = []
    for i in range(1, nu + 1):
        row = []
        for j in range(1, nv + 1):
            p = bs.Pole(i, j)
            row.append([round(p.X(), 4), round(p.Y(), 4), round(p.Z(), 4)])
        rows.append(row)
    return {"nu": nu, "nv": nv, "degU": bs.UDegree(), "degV": bs.VDegree(), "rows": rows}


def face_table(shape, *, with_cages: bool = True) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """每面:序號、型別、曲率統計;另回控制點籠清單(上限 MAX_CAGE_FACES)。"""
    faces = []
    cages = []
    for idx, f in enumerate(shape.faces(), start=1):
        st = surface_type(f)
        row = {"i": idx, "type": st}
        row.update(face_curvature_stats(f))
        faces.append(row)
        if with_cages and len(cages) < MAX_CAGE_FACES and st in ("bsplinesurface",):
            cage = control_cage(f)
            if cage:
                cage["face"] = idx
                cages.append(cage)
    return faces, cages


def continuity_violations(rows: list[dict[str, Any]], min_continuity: str, creases: int = 0) -> list[dict[str, Any]]:
    """低於 ``min_continuity`` 的內邊;``creases`` 條 G0 預算內先放行最短的(設計刻意摺線)。"""
    need = GRADE_RANK.get(min_continuity, 1)
    bad = [r for r in rows if GRADE_RANK[r["grade"]] < need and not r.get("flat")]
    if creases > 0 and need >= 1:
        g0 = sorted((r for r in bad if r["grade"] == "G0"), key=lambda r: r["length"])
        allowed = {id(r) for r in g0[:creases]}
        bad = [r for r in bad if id(r) not in allowed]
    return bad


def summarize(rows: list[dict[str, Any]], free: list[dict[str, Any]], spec_analysis: dict[str, Any] | None) -> dict[str, Any]:
    an = spec_analysis or {}
    counts = {"G0": 0, "G1": 0, "G2": 0}
    flat = 0
    for r in rows:
        counts[r["grade"]] += 1
        flat += 1 if r.get("flat") else 0
    bad = continuity_violations(rows, an.get("minContinuity", "G1"), int(an.get("creases", 0)))
    return {
        "g0": counts["G0"],
        "g1": counts["G1"],
        "g2": counts["G2"],
        "free": len(free),
        "flat": flat,
        "minContinuity": an.get("minContinuity", "G1"),
        "creases": int(an.get("creases", 0)),
        "violations": len(bad),
        "ok": not bad,
    }
