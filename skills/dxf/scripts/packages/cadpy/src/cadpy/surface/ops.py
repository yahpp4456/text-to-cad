"""殼/實體操作:鏡射、縫合、閉殼成實體、加厚、融合、銳邊圓角。

探針結論(2026-10-10,build123d 0.11 / OCCT 7.9):
- ``Solid.thicken`` 對 t ≥ 曲率半徑的殼照樣回 valid 實體(體積 2.7× 的自交垃圾)→
  ``thicken`` 先用 ``max_abs_curvature`` 設閘:``t < 0.9 / kmax``。
- 縫合公差小於縫隙 → 回 COMPOUND(沒縫上)而不是 SHELL;free edge 數=邊界邊數。
- 閉殼 → ``Solid(shell)`` 體積精確(球 4/3πR³);開放殼成實體必須加厚。
- fuse 三顆球 → 3 面 3 條 107° 銳邊;``fillet`` 只對銳邊,結果 G1。
"""
from __future__ import annotations

from typing import Any

from cadpy.surface.analysis import edge_continuity, free_edges, max_abs_curvature

THICKEN_CURVATURE_SAFETY = 0.9
SHARP_EDGE_DEG = 1.0


def _plane(name: str):
    from build123d import Plane

    return {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}[name]


def mirror_faces(faces: list, plane_name: str) -> list:
    pl = _plane(plane_name)
    return [f.mirror(pl) for f in faces]


def _wrap(topo):
    from build123d import Compound, Face, Shell, Solid
    from OCP.TopAbs import TopAbs_COMPOUND, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopoDS import TopoDS

    st = topo.ShapeType()
    if st == TopAbs_SHELL:
        return Shell(TopoDS.Shell_s(topo))
    if st == TopAbs_FACE:
        return Shell([Face(TopoDS.Face_s(topo))])
    if st == TopAbs_SOLID:
        return Solid(TopoDS.Solid_s(topo))
    if st == TopAbs_COMPOUND:
        return Compound(TopoDS.Compound_s(topo))
    raise ValueError(f"縫合回傳非預期型別 {st}")


def sew(faces: list, tol: float = 0.01) -> tuple[list, int]:
    """縫合面集合 → (殼清單, 自由邊數)。沒縫上(多殼)也照回,由呼叫端決定。"""
    from build123d import Face, Shell
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing

    if not faces:
        raise ValueError("沒有可縫合的面")
    if tol <= 0:
        raise ValueError("縫合公差需 > 0")
    sw = BRepBuilderAPI_Sewing(float(tol))
    for f in faces:
        sw.Add(f.wrapped)
    sw.Perform()
    sewed = sw.SewedShape()
    # 縫合只把「有共享邊」的面包成 SHELL;單面的旋轉體/環/孤立面會以 FACE 留在 COMPOUND 頂層
    #(不屬於任何殼)——每一片自成一殼,否則整個花瓶本體會在有把手時被靜默丟掉。
    # 單一 FACE 結果(只縫一片)走 _wrap 包殼,不再重複掃 loose face(否則同一片會進兩次)。
    from OCP.TopAbs import TopAbs_COMPOUND, TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
    from OCP.TopoDS import TopoDS

    if sewed.ShapeType() == TopAbs_COMPOUND:
        res = _wrap(sewed)
        shells = list(res.shells())
        fmap = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(sewed, TopAbs_FACE, TopAbs_SHELL, fmap)
        for i in range(1, fmap.Extent() + 1):
            if fmap.FindFromIndex(i).Size() == 0:
                shells.append(Shell([Face(TopoDS.Face_s(fmap.FindKey(i)))]))
    else:
        res = _wrap(sewed)
        shells = [res] if isinstance(res, Shell) else list(res.shells())
    if not shells:
        shells = [Shell([f]) for f in faces]
    for sh in shells:
        if not sh.is_valid:
            raise ValueError("縫合後的殼無效(BRepCheck);請檢查面是否重疊或退化")
    return shells, int(sw.NbFreeEdges())


def is_closed(shell) -> bool:
    return not free_edges(shell, polyline_points=2)


def orient_outward(shell):
    """讓殼的法向整體朝外(以 bbox 中心為內側):``thicken`` 的 outward/inward 依此定義。"""
    from build123d import Shell

    bb = shell.bounding_box()
    c = bb.center()
    score = 0.0
    for f in shell.faces():
        try:
            n = f.normal_at(f.center())
            score += (f.center() - c).dot(n) * f.area
        except Exception:  # noqa: BLE001
            continue
    if score < 0:
        return Shell(shell.wrapped.Reversed())
    return shell


def solid_from_shell(shell):
    """閉合殼 → 實體(非閉合丟 ValueError)。"""
    from build123d import Shell, Solid

    free = free_edges(shell, polyline_points=2)
    if free:
        raise ValueError(f"殼未閉合({len(free)} 條開放邊),無法直接成實體;result=solid 請加 thicken 或補面封閉")
    s = Solid(shell)
    if not s.is_valid or s.volume <= 0:
        s = Solid(Shell(shell.wrapped.Reversed()))
    if not s.is_valid or s.volume <= 0:
        raise ValueError("閉殼轉實體失敗(BRepCheck 無效或體積非正)")
    return s


def thicken(shell, t: float, direction: str = "outward"):
    """殼加厚成實體。閘:``t < 0.9 / max|k|``(否則偏移面自交、kernel 仍判 valid)。"""
    from build123d import Solid

    if t <= 0:
        raise ValueError("厚度需 > 0")
    if direction not in ("outward", "inward"):
        raise ValueError("加厚方向需為 outward/inward")
    kmax = max_abs_curvature(shell)
    if kmax > 1e-9 and t >= THICKEN_CURVATURE_SAFETY / kmax:
        rmin = 1.0 / kmax
        raise ValueError(
            f"厚度 {t:g} mm 超過最小曲率半徑 {rmin:.2f} mm 的 {THICKEN_CURVATURE_SAFETY:g} 倍上限"
            f"({THICKEN_CURVATURE_SAFETY / kmax:.2f} mm):偏移面會自交。請降低厚度或放大曲面曲率半徑"
        )
    sh = orient_outward(shell)
    depth = float(t) if direction == "outward" else -float(t)
    try:
        s = Solid.thicken(sh, depth)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"加厚失敗:{type(exc).__name__}: {exc}") from exc
    if not s.is_valid or s.volume <= 0:
        raise ValueError("加厚結果無效(BRepCheck)或體積非正")
    ratio = s.volume / max(shell.area * t, 1e-9)
    if not (0.3 <= ratio <= 3.0):
        raise ValueError(f"加厚體積異常(體積/(面積×厚度)={ratio:.2f});偏移面可能自交")
    return s


def fuse(solids: list):
    from build123d import Compound

    if not solids:
        raise ValueError("沒有可融合的實體")
    if len(solids) == 1:
        return solids[0]
    try:
        r = solids[0].fuse(*solids[1:]).clean()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"融合失敗:{type(exc).__name__}: {exc}") from exc
    sols = list(r.solids())
    if len(sols) == 1:
        r = sols[0]
    if not r.is_valid:
        try:
            r = r.fix()
        except Exception:  # noqa: BLE001
            pass
        if not r.is_valid:
            raise ValueError("融合結果無效(實體是否重合或只相切?)")
        sols = list(r.solids())
    if len(sols) > 1:
        return Compound(sols)
    return r


def cut(solid, cutters: list):
    """本體減去切除體(輪拱/開口)。結果必須仍是單一有效實體。"""
    if not cutters:
        return solid
    # 逐一切除(探針 2026-10-10:多個互相重疊的切除體一次 cut(*tools) 會把本體炸成碎片,
    # 單獨切每一個都正常——滑鼠滾輪槽 + 其鏡射重疊就踩到)。
    r = solid
    try:
        for c in cutters:
            r = r.cut(c)
        r = r.clean()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"切除失敗:{type(exc).__name__}: {exc}") from exc
    sols = list(r.solids())
    if len(sols) != 1:
        raise ValueError(f"切除後本體變成 {len(sols)} 件(切除體把本體切斷了?)")
    r = sols[0]
    if not r.is_valid or r.volume <= 0:
        try:
            r = r.fix()
        except Exception:  # noqa: BLE001
            pass
        if not r.is_valid or r.volume <= 0:
            raise ValueError("切除結果無效(BRepCheck)")
    return r


def sharp_edges(solid, min_deg: float = SHARP_EDGE_DEG) -> list:
    """二面角 > ``min_deg`` 的內邊(build123d Edge)。"""
    from build123d import Edge
    from OCP.TopoDS import TopoDS

    from cadpy.surface.analysis import _edge_face_map

    rows = edge_continuity(solid, samples=3, polyline_points=2)
    want = {r["i"] for r in rows if r["g1Deg"] > min_deg}
    if not want:
        return []
    emap = _edge_face_map(solid)
    return [Edge(TopoDS.Edge_s(emap.FindKey(i))) for i in range(1, emap.Extent() + 1) if i in want]


def fillet_sharp(solid, r: float):
    """對所有銳邊做定半徑圓角;沒有銳邊就原樣回傳。"""
    if r <= 0:
        raise ValueError("圓角半徑需 > 0")
    edges = sharp_edges(solid)
    if not edges:
        return solid
    try:
        out = solid.fillet(float(r), edges)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"圓角失敗(半徑 {r:g} 可能大於鄰面能容納的尺寸,或銳邊相互干擾):{type(exc).__name__}") from exc
    if not out.is_valid or out.volume <= 0:
        raise ValueError("圓角結果無效")
    return out
