"""曲線建構(spec → build123d Edge)與取樣(折線 / 曲率梳)。

build123d 一律在呼叫時才 import(套件 import 保持 OCP-free,spec 驗證端免付 kernel 冷啟)。
曲率梳用 ``BRepLProp_CLProps``(N=2)取曲率與主法向;直線段曲率 0 → 梳長 0(不丟)。
"""
from __future__ import annotations

import math
from typing import Any


def _vec(v):
    from build123d import Vector

    return Vector(float(v[0]), float(v[1]), float(v[2]))


def make_curve(c: dict[str, Any]):
    """由正規化後的 curve spec 建 build123d ``Edge``。壞輸入丟 ValueError(帶曲線 id)。"""
    from build123d import Axis, Edge, Plane

    cid = c.get("id", "?")
    kind = c["kind"]
    try:
        if kind == "spline":
            pts = [_vec(p) for p in c["points"]]
            if len(pts) < 2:
                raise ValueError("至少 2 點")
            tg = c.get("tangents") or {}
            tangents = None
            if tg.get("start") is not None or tg.get("end") is not None:
                t0 = _vec(tg["start"]) if tg.get("start") is not None else (pts[1] - pts[0])
                t1 = _vec(tg["end"]) if tg.get("end") is not None else (pts[-1] - pts[-2])
                if t0.length < 1e-12 or t1.length < 1e-12:
                    raise ValueError("端點切線不可為零向量")
                tangents = [t0.normalized(), t1.normalized()]
            closed = bool(c.get("closed", False))
            if closed and len(pts) < 3:
                raise ValueError("閉合樣條至少 3 點")
            return Edge.make_spline(pts, tangents=tangents, periodic=closed)
        if kind == "nurbs":
            return _nurbs_edge(c)
        if kind == "bezier":
            return Edge.make_bezier(*[_vec(p) for p in c["poles"]])
        if kind == "arc3":
            p1, p2, p3 = (_vec(p) for p in c["points"])
            if (p2 - p1).cross(p3 - p1).length < 1e-9:
                raise ValueError("三點共線,無法定圓弧")
            return Edge.make_three_point_arc(p1, p2, p3)
        if kind == "line":
            p1, p2 = (_vec(p) for p in c["points"])
            if (p2 - p1).length < 1e-9:
                raise ValueError("線段長度為零")
            return Edge.make_line(p1, p2)
        if kind == "circle":
            n = _vec(c["normal"])
            if n.length < 1e-12:
                raise ValueError("法向不可為零向量")
            plane = Plane(origin=_vec(c["center"]), z_dir=n)
            return Edge.make_circle(float(c["r"]), plane=plane)
    except ValueError as exc:
        raise ValueError(f"曲線 {cid}({kind}):{exc}") from exc
    except Exception as exc:  # noqa: BLE001 — kernel 例外統一轉 ValueError
        raise ValueError(f"曲線 {cid}({kind})建構失敗:{type(exc).__name__}: {exc}") from exc
    raise ValueError(f"曲線 {cid}:未知 kind {kind!r}")


def _nurbs_edge(c: dict[str, Any]):
    """控制點 NURBS(clamped uniform knots;閉合 v1 不支援)。"""
    from build123d import Edge
    from OCP.Geom import Geom_BSplineCurve
    from OCP.gp import gp_Pnt
    from OCP.TColgp import TColgp_Array1OfPnt
    from OCP.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge

    if c.get("closed"):
        raise ValueError("閉合 NURBS v1 不支援(請用 spline closed 或 circle)")
    poles = c["poles"]
    deg = int(c["degree"])
    n = len(poles)
    if n < deg + 1:
        raise ValueError(f"degree {deg} 至少 {deg + 1} 個控制點")
    arr = TColgp_Array1OfPnt(1, n)
    for i, p in enumerate(poles, start=1):
        arr.SetValue(i, gp_Pnt(float(p[0]), float(p[1]), float(p[2])))
    nk = n - deg + 1  # 內部 knot 數(含兩端)
    knots = TColStd_Array1OfReal(1, nk)
    mults = TColStd_Array1OfInteger(1, nk)
    for i in range(1, nk + 1):
        knots.SetValue(i, (i - 1) / (nk - 1))
        mults.SetValue(i, deg + 1 if i in (1, nk) else 1)
    weights = c.get("weights")
    if weights:
        w = TColStd_Array1OfReal(1, n)
        for i, x in enumerate(weights, start=1):
            w.SetValue(i, float(x))
        curve = Geom_BSplineCurve(arr, w, knots, mults, deg, False, True)
    else:
        curve = Geom_BSplineCurve(arr, knots, mults, deg, False)
    return Edge(BRepBuilderAPI_MakeEdge(curve).Edge())


def curve_polyline(edge, n: int = 48) -> list[list[float]]:
    """等弧長取樣 n 點(前端 baked 折線 / nurbsEval golden)。"""
    n = max(2, int(n))
    out = []
    for i in range(n):
        p = edge.position_at(i / (n - 1))
        out.append([round(p.X, 6), round(p.Y, 6), round(p.Z, 6)])
    return out


def curve_comb(edge, n: int = 32, scale: float = 1.0) -> list[dict[str, Any]]:
    """曲率梳:每個取樣點 ``{"p": [x,y,z], "k": 曲率, "v": [dx,dy,dz]}``,``v = scale·k·主法向``。"""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepLProp import BRepLProp_CLProps
    from OCP.gp import gp_Dir

    n = max(2, int(n))
    cl = BRepLProp_CLProps(BRepAdaptor_Curve(edge.wrapped), 2, 1e-6)
    out = []
    for i in range(n):
        d = i / (n - 1)
        u = edge.param_at(d)
        cl.SetParameter(u)
        p = edge.position_at(d)
        k = 0.0
        v = [0.0, 0.0, 0.0]
        try:
            if cl.IsTangentDefined():
                k = float(cl.Curvature())
                if math.isfinite(k) and k > 1e-9:
                    nd = gp_Dir()
                    cl.Normal(nd)
                    v = [scale * k * nd.X(), scale * k * nd.Y(), scale * k * nd.Z()]
                else:
                    k = 0.0
        except Exception:  # noqa: BLE001 — 奇異點(折點)視為 0
            k = 0.0
        out.append({"p": [round(p.X, 6), round(p.Y, 6), round(p.Z, 6)], "k": round(k, 8), "v": [round(x, 6) for x in v]})
    return out
