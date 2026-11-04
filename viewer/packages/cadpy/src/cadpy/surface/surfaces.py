"""曲面建構:放樣 / 補面 / 旋轉 / 拉伸 / 直紋 / 掃掠(含導軌)/ Gordon。

每個運算都帶建構保證(ValueError 閘),因為 kernel 對下列垃圾照樣判 valid(探針 2026-10-10):
- 放樣截面閉合性不一致 → ThruSections 直接崩或出破面;截面起點錯位 ThruSections 會自動對齊
  (CheckCompatibility),但方向反轉的開放截面會變成交叉扭面 → 這裡檢查相鄰截面方向。
- 補面邊界不閉合 → MakeFilling 出一片飄在空中的面。
- 補面 G2 約束:B-spline/平面/圓柱鄰面可收,**球面鄰面 kernel 拒收**(``BRepFill : The continuity
  is not G0 G1 or G2``)→ 自動降 G1 並回報 ``downgraded``。
- Gordon:輪廓與導引線必須相交(容差內),否則 kernel 例外。
"""
from __future__ import annotations

import math
from typing import Any


def _wire_of(obj):
    from build123d import Edge, Wire

    if isinstance(obj, Wire):
        return obj
    if isinstance(obj, Edge):
        return Wire([obj])
    raise ValueError(f"需要 Edge/Wire,得到 {type(obj).__name__}")


def _endpoints(edge):
    return edge.position_at(0.0), edge.position_at(1.0)


def _cap_faces(wires: list) -> list:
    """閉合平面截面 → 平面端蓋(非平面丟 ValueError)。"""
    from build123d import Face

    caps = []
    for w in wires:
        try:
            caps.append(Face(w))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"端蓋失敗(截面需為閉合平面曲線):{type(exc).__name__}") from exc
        if not caps[-1].is_valid or caps[-1].area < 1e-9:
            raise ValueError("端蓋無效(截面需為閉合平面曲線)")
    return caps


def cap_free_loops(faces: list, tol: float = 0.01) -> list:
    """把面集合縫起來,對每個**閉合的自由邊迴圈**補一片平面端蓋,回 faces + caps。

    通用的 ``capped`` 實作(loft/extrude/revolve<360°/sweep 都適用):半圓環把手、旋轉 180° 的
    環、沿弧掃掠的管,只要開口是平面迴圈就能封成閉殼。非平面迴圈 → ValueError(說明哪個迴圈)。
    自由邊 = 縫合後只有 1 個鄰面的非退化邊;用 ShapeAnalysis_FreeBounds.ConnectEdgesToWires 串成迴圈。
    """
    from build123d import Face, Wire
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
    from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_HSequenceOfShape, TopTools_IndexedDataMapOfShapeListOfShape

    sw = BRepBuilderAPI_Sewing(float(tol))
    for f in faces:
        sw.Add(f.wrapped)
    sw.Perform()
    sewn = sw.SewedShape()
    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(sewn, TopAbs_EDGE, TopAbs_FACE, emap)
    free = TopTools_HSequenceOfShape()
    n_free = 0
    for i in range(1, emap.Extent() + 1):
        e = TopoDS.Edge_s(emap.FindKey(i))
        if BRep_Tool.Degenerated_s(e) or emap.FindFromIndex(i).Size() != 1:
            continue
        free.Append(e)
        n_free += 1
    if n_free == 0:
        raise ValueError("capped 找不到開口(殼已閉合)")
    wires = TopTools_HSequenceOfShape()
    ShapeAnalysis_FreeBounds.ConnectEdgesToWires_s(free, float(tol), False, wires)
    caps = []
    for k in range(1, wires.Length() + 1):
        w = Wire(TopoDS.Wire_s(wires.Value(k)))
        if not w.is_closed:
            raise ValueError(f"第 {k} 個開口迴圈未閉合,無法加端蓋")
        try:
            cap = Face(w)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"第 {k} 個開口迴圈不是平面,無法加端蓋({type(exc).__name__});capped 需要平面開口") from exc
        if not cap.is_valid or cap.area < 1e-9:
            raise ValueError(f"第 {k} 個開口迴圈的端蓋無效(非平面或退化)")
        caps.append(cap)
    if not caps:
        raise ValueError("capped 找不到可封的開口迴圈")
    return list(faces) + caps


def loft(sections: list, *, ruled: bool = False, capped: bool = False):
    """放樣成 ``Shell``(``capped`` 時回含首尾平面端蓋的面清單,供縫成閉殼)。

    閘:≥2 截面、閉合性一致、無零長截面、開放截面方向一致。
    """
    from build123d import Shell

    if len(sections) < 2:
        raise ValueError("放樣至少需要 2 條截面曲線")
    wires = [_wire_of(s) for s in sections]
    closed = [bool(w.is_closed) for w in wires]
    if any(closed) and not all(closed):
        raise ValueError("放樣截面必須全部閉合或全部開放(混用會出破面)")
    for k, w in enumerate(wires):
        if w.length < 1e-6:
            raise ValueError(f"第 {k + 1} 條截面長度為零")
    if not closed[0]:
        # 開放截面:相鄰截面起點-起點距離應小於起點-終點距離(否則方向相反 → 扭面)
        for k in range(len(wires) - 1):
            a0, a1 = _endpoints(wires[k])
            b0, b1 = _endpoints(wires[k + 1])
            if (a0 - b0).length + (a1 - b1).length > (a0 - b1).length + (a1 - b0).length + 1e-6:
                raise ValueError(
                    f"第 {k + 1}/{k + 2} 條截面方向相反(起點對到終點)會扭成交叉面;請把截面點序改成同向"
                )
    try:
        sh = Shell.make_loft(wires, ruled=ruled)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"放樣失敗:{type(exc).__name__}: {exc}") from exc
    if not sh.is_valid:
        raise ValueError("放樣結果無效(BRepCheck);請檢查截面是否自交或退化")
    if capped:
        if not closed[0]:
            raise ValueError("capped 放樣需要閉合截面")
        return cap_free_loops(list(sh.faces()))
    return sh


def revolve(curve, origin, direction, angle: float = 360.0, *, capped: bool = False):
    from build123d import Axis, Face, Vector

    d = Vector(*direction)
    if d.length < 1e-12:
        raise ValueError("旋轉軸方向不可為零向量")
    if not (0 < angle <= 360):
        raise ValueError("旋轉角度需在 (0, 360]")
    try:
        f = Face.revolve(curve, float(angle), Axis(Vector(*origin), d))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"旋轉失敗:{type(exc).__name__}: {exc}") from exc
    if not f.is_valid or f.area < 1e-9:
        raise ValueError("旋轉結果無效(曲線是否穿過或遠離軸?)")
    if capped:
        return cap_free_loops([f])
    return f


def extrude(curve, direction, length: float, *, capped: bool = False):
    """曲線沿方向拉伸成面;``capped`` 時(閉合平面曲線)回 [側面, 底蓋, 頂蓋]。"""
    from build123d import Face, Location, Vector

    d = Vector(*direction)
    if d.length < 1e-12 or length <= 0:
        raise ValueError("拉伸方向不可為零、長度需 > 0")
    vec = d.normalized() * float(length)
    try:
        f = Face.extrude(curve, vec)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"拉伸失敗:{type(exc).__name__}: {exc}") from exc
    if not f.is_valid:
        raise ValueError("拉伸結果無效")
    if capped:
        w0 = _wire_of(curve)
        if not w0.is_closed:
            raise ValueError("capped 拉伸需要閉合曲線")
        return cap_free_loops([f])
    return f


def ruled(c1, c2):
    from build123d import Face

    try:
        f = Face.make_surface_from_curves(c1, c2)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"直紋面失敗:{type(exc).__name__}: {exc}") from exc
    if not f.is_valid or f.area < 1e-9:
        raise ValueError("直紋面退化(兩曲線重合或零面積)")
    return f


def sweep(profile, rail, guide=None, *, capped: bool = False):
    """輪廓沿軌道掃掠成 ``Shell``;``guide`` 給導引軌(``MakePipeShell.SetMode`` aux spine);
    ``capped`` 把兩端平面開口封起來(把手/管件要與本體融合時用)。"""
    from build123d import Shell
    from OCP.TopoDS import TopoDS

    prof_w = _wire_of(profile)
    rail_w = _wire_of(rail)
    if rail_w.length < 1e-6 or prof_w.length < 1e-6:
        raise ValueError("輪廓/軌道長度為零")
    try:
        if guide is None:
            sh = Shell.sweep(prof_w, rail_w)
        else:
            from OCP.BRepFill import BRepFill_TypeOfContact
            from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell

            ps = BRepOffsetAPI_MakePipeShell(rail_w.wrapped)
            ps.SetMode(_wire_of(guide).wrapped, False, BRepFill_TypeOfContact.BRepFill_Contact)
            ps.Add(prof_w.wrapped, False, False)
            ps.Build()
            if not ps.IsDone():
                raise ValueError("導軌掃掠未完成(導引軌需與軌道同向、且與輪廓相交或相鄰)")
            sh = Shell(TopoDS.Shell_s(ps.Shape()))
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"掃掠失敗:{type(exc).__name__}: {exc}") from exc
    if not sh.is_valid:
        raise ValueError("掃掠結果無效(輪廓是否在軌道起點、是否自交?)")
    if capped:
        return cap_free_loops(list(sh.faces()))
    return sh


def gordon(profiles: list, guides: list, tolerance: float = 1e-3):
    """Gordon 曲面(輪廓網 × 導引網)。閘:每條輪廓必須與每條導引線相交(容差內)。"""
    from build123d import Face

    if len(profiles) < 2 or len(guides) < 2:
        raise ValueError("Gordon 曲面需 ≥2 輪廓與 ≥2 導引線")
    tol = max(float(tolerance), 1e-6)
    scale = max((e.length for e in list(profiles) + list(guides)), default=1.0)
    for i, p in enumerate(profiles):
        for j, g in enumerate(guides):
            d = p.distance_to(g)
            if d > max(tol, 1e-4 * scale) * 10:
                raise ValueError(f"輪廓 {i + 1} 與導引線 {j + 1} 不相交(最小距離 {d:.3f} mm);Gordon 曲面要求曲線網互相穿過")
    try:
        f = Face.make_gordon_surface(list(profiles), list(guides), tolerance=tol)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Gordon 曲面失敗:{type(exc).__name__}: {exc}") from exc
    if not f.is_valid or f.area < 1e-9:
        raise ValueError("Gordon 曲面無效")
    return f


def _match_face_edge(face, curve, tol: float):
    """在 ``face`` 的邊裡找與 ``curve`` 幾何重合者(中點 + 兩端點距離 ≤ tol)。"""
    mid = curve.position_at(0.5)
    a, b = _endpoints(curve)
    best = None
    for e in face.edges():
        if e.length < 1e-9:
            continue
        dm = (e.position_at(0.5) - mid).length
        ea, eb = _endpoints(e)
        de = min((ea - a).length + (eb - b).length, (ea - b).length + (eb - a).length)
        score = dm + de
        if best is None or score < best[0]:
            best = (score, e, dm, de)
    if best is None or best[2] > tol or best[3] > 2 * tol:
        return None
    return best[1]


def patch(
    boundary: list,
    constraints: dict[int, tuple[Any, str]] | None = None,
    points: list | None = None,
    *,
    tol: float | None = None,
) -> tuple[Any, list[str]]:
    """邊界補面。``constraints``:{邊界索引: (鄰面 Face, "G1"|"G2")};回 (Face, notes)。

    notes 含自動降級訊息(G2 → G1)與 kernel 回報的誤差。
    """
    from build123d import Face
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeFilling
    from OCP.GeomAbs import GeomAbs_C0, GeomAbs_G1, GeomAbs_G2
    from OCP.gp import gp_Pnt
    from OCP.TopoDS import TopoDS

    constraints = constraints or {}
    if len(boundary) < 2:
        raise ValueError("補面邊界至少 2 條曲線")
    scale = max(e.length for e in boundary)
    tol = tol if tol is not None else max(1e-3 * scale, 1e-3)
    # 閉合檢查:每個端點必須被恰 2 條邊界共用
    ends = []
    for e in boundary:
        a, b = _endpoints(e)
        ends.append(a)
        ends.append(b)
    for k, p in enumerate(ends):
        hits = sum(1 for q in ends if (q - p).length <= tol)
        if hits != 2:
            raise ValueError(
                f"補面邊界不閉合:端點 ({p.X:.2f}, {p.Y:.2f}, {p.Z:.2f}) 有 {hits} 條曲線相接(需恰 2);"
                "請讓相鄰邊界曲線端點重合"
            )
    order_of = {"G1": GeomAbs_G1, "G2": GeomAbs_G2}
    notes: list[str] = []

    def _try(levels: dict[int, str]):
        mf = BRepOffsetAPI_MakeFilling(3, 15, 2, False, 1e-5, 1e-4, 0.01, 0.1, 8, 9)
        for i, e in enumerate(boundary):
            if i in constraints:
                face, _lvl = constraints[i]
                fe = _match_face_edge(face, e, tol)
                if fe is None:
                    raise ValueError(f"補面邊界 {i + 1} 在指定鄰面上找不到重合的邊(是否引用了該曲面的截面/邊界曲線?)")
                mf.Add(fe.wrapped, face.wrapped, order_of[levels[i]], True)
            else:
                mf.Add(e.wrapped, GeomAbs_C0, True)
        for p in points or []:
            mf.Add(gp_Pnt(float(p[0]), float(p[1]), float(p[2])))
        mf.Build()
        if not mf.IsDone():
            raise ValueError("補面未完成")
        f = Face(TopoDS.Face_s(mf.Shape())).fix()
        return f, mf

    levels = {i: lvl for i, (_f, lvl) in constraints.items()}
    try:
        face, mf = _try(levels)
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        if any(l == "G2" for l in levels.values()):
            down = {i: "G1" for i in levels}
            try:
                face, mf = _try(down)
                notes.append(f"G2 約束被 kernel 拒收({type(exc).__name__}),已自動降為 G1")
            except Exception as exc2:  # noqa: BLE001
                raise ValueError(f"補面失敗(G2 與 G1 皆失敗):{type(exc2).__name__}: {exc2}") from exc2
        else:
            raise ValueError(f"補面失敗:{type(exc).__name__}: {exc}") from exc
    if not face.is_valid or face.area < 1e-9:
        raise ValueError("補面結果無效")
    try:
        g0 = mf.G0Error()
        g1 = mf.G1Error()
        notes.append(f"補面誤差 G0={g0:.2e} G1={math.degrees(g1):.3f}°")
        if g0 > 10 * tol:
            raise ValueError(f"補面位置誤差 {g0:.3f} mm 超過容差(邊界曲線是否與鄰面邊不重合?)")
    except ValueError:
        raise
    except Exception:  # noqa: BLE001
        pass
    return face, notes
