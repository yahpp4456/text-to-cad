"""``SurfaceBuilder``:正規化 spec → 曲線 → 曲面 → 鏡射 → 縫合 → 成形(實體/殼)→ 融合 → 圓角。

設計殼(加厚前)是連續性閘與分析 overlay 的真相來源:加厚/圓角後的側壁、交線本來就是 G0,
不屬於設計面的連續性。builder 建完把 (spec, 設計殼, 最終形狀, 曲線, 面) 登記在程序內
registry(``last_build()``),同程序的 ``check_geometry`` / build-meta 收割 / validate.py
直接取用,不必重算。
"""
from __future__ import annotations

import copy
from typing import Any

from cadpy.surface import analysis as A
from cadpy.surface import ops, surfaces
from cadpy.surface.curves import curve_comb, curve_polyline, make_curve
from cadpy.surface.spec import apply_params, normalize_spec

_LAST: dict[str, Any] | None = None


def last_build() -> dict[str, Any] | None:
    """最近一次 ``SurfaceBuilder.build()`` 的 registry(同程序)。"""
    return _LAST


class SurfaceBuilder:
    def __init__(self, spec: dict[str, Any], params: dict[str, Any] | None = None):
        base = normalize_spec(spec)
        self.spec = normalize_spec(apply_params(base, params)) if params else base
        self.notes: list[str] = []
        self._curves: dict[str, Any] | None = None
        self._faces: dict[str, list] | None = None
        self._shells: list | None = None
        self._cutters: list | None = None
        self._adders: list | None = None
        self._free_count = 0

    # -- 曲線 ----------------------------------------------------------------
    def curves(self) -> dict[str, Any]:
        if self._curves is None:
            self._curves = {c["id"]: make_curve(c) for c in self.spec["curves"]}
        return self._curves

    # -- 曲面 ----------------------------------------------------------------
    def faces(self) -> dict[str, list]:
        if self._faces is not None:
            return self._faces
        cv = self.curves()
        out: dict[str, list] = {}
        for s in self.spec["surfaces"]:
            sid = s["id"]
            op = s["op"]
            try:
                if op == "loft":
                    sh = surfaces.loft([cv[c] for c in s["sections"]], ruled=s.get("ruled", False), capped=s.get("capped", False))
                    out[sid] = sh if isinstance(sh, list) else list(sh.faces())
                elif op == "patch":
                    boundary = [cv[c] for c in s["boundary"]]
                    cons: dict[int, tuple[Any, str]] = {}
                    for i, cid in enumerate(s["boundary"]):
                        ref = s.get("continuity", {}).get(cid)
                        if ref:
                            target = out.get(ref["face"])
                            if not target:
                                raise ValueError(f"補面 {sid} 的鄰面 {ref['face']} 尚未建成")
                            cons[i] = (self._pick_support(target, boundary[i]), ref["level"])
                    f, notes = surfaces.patch(boundary, cons, s.get("points"))
                    self.notes.extend(f"{sid}:{n}" for n in notes)
                    out[sid] = [f]
                elif op == "revolve":
                    r = surfaces.revolve(cv[s["curve"]], s["axis"]["origin"], s["axis"]["dir"], s["angle"], capped=s.get("capped", False))
                    out[sid] = r if isinstance(r, list) else [r]
                elif op == "extrude":
                    r = surfaces.extrude(cv[s["curve"]], s["dir"], s["length"], capped=s.get("capped", False))
                    out[sid] = r if isinstance(r, list) else [r]
                elif op == "ruled":
                    out[sid] = [surfaces.ruled(cv[s["curves"][0]], cv[s["curves"][1]])]
                elif op == "sweep":
                    sh = surfaces.sweep(cv[s["profile"]], cv[s["rail"]], cv[s["guide"]] if s.get("guide") else None, capped=s.get("capped", False))
                    out[sid] = sh if isinstance(sh, list) else list(sh.faces())
                elif op == "gordon":
                    out[sid] = [surfaces.gordon([cv[c] for c in s["profiles"]], [cv[c] for c in s["guides"]])]
                else:  # pragma: no cover — spec 驗證已擋
                    raise ValueError(f"未知曲面運算 {op}")
            except ValueError as exc:
                raise ValueError(f"曲面 {sid}({op}):{exc}") from exc
        self._faces = out
        return out

    @staticmethod
    def _pick_support(faces: list, curve):
        """多面曲面(放樣)裡挑含該邊界曲線的那一面。"""
        if len(faces) == 1:
            return faces[0]
        mid = curve.position_at(0.5)
        return min(faces, key=lambda f: min(((e.position_at(0.5) - mid).length for e in f.edges()), default=1e9))

    # -- 鏡射 + 縫合 → 設計殼 -----------------------------------------------
    def shells(self) -> list:
        if self._shells is not None:
            return self._shells
        roles = {s["id"]: s.get("role", "body") for s in self.spec["surfaces"]}
        groups = [(sid, lst) for sid, lst in self.faces().items() if roles[sid] == "body"]
        all_faces = [f for _, lst in groups for f in lst]
        if not all_faces:
            raise ValueError("沒有 role=body 的曲面(全部都是切除體)")
        sym = self.spec.get("symmetry")
        if sym:
            # 半模鏡射:以**整個曲面運算的面群**為單位判斷——本身就對稱於該平面的群(整顆旋轉球、
            # 跨對稱面的閉合截面放樣、橫跨兩側的翼板)不重複鏡射(重合面會讓縫合/融合失敗、端蓋
            # 會變成孤立的開放面)。逐面判斷會把「幾乎對稱但起點有偏差的閉合樣條端蓋」誤判成非對稱。
            all_faces = all_faces + self._mirror_groups(groups, sym)
        tol = next((o["tol"] for o in self.spec["ops"] if o["op"] == "sew"), 0.01)
        shells, free_count = ops.sew(all_faces, tol)
        self._free_count = free_count
        if sym:
            # 對稱接縫必須至少 G1:截面在對稱面上的切線沒垂直對稱面就會出摺線
            for sh in shells:
                rows = A.edge_continuity(sh, samples=5, polyline_points=2)
                # 平面端蓋落在對稱面上(翼板/底板跨對稱面)是刻意銳邊,不是接縫摺線
                bad = [r for r in rows if r["grade"] == "G0" and not r.get("flat") and self._on_symmetry_plane(sh, r["i"], sym)]
                if bad and self.spec["analysis"]["minContinuity"] != "G0":
                    worst = max(bad, key=lambda r: r["g1Deg"])
                    raise ValueError(
                        f"對稱接縫出現 {worst['g1Deg']:.1f}° 摺線:曲線在對稱面({sym})上的端點切線必須垂直該平面"
                        "(例如 symmetry=XZ 時切線的 y 分量為主、x/z 分量為 0)"
                    )
        self._shells = shells
        return shells

    def _role_solids(self, role: str, what: str) -> list:
        """role=cut/add 的面群 → 鏡射 → 縫合 → 必須閉合 → 實體清單。"""
        roles = {s["id"]: s.get("role", "body") for s in self.spec["surfaces"]}
        groups = [(sid, lst) for sid, lst in self.faces().items() if roles[sid] == role]
        sym = self.spec.get("symmetry")
        solids = []
        for sid, faces in groups:
            fs = list(faces)
            fs_m = self._mirror_groups([(sid, fs)], sym) if sym else []
            for group in (fs, fs_m):
                if not group:
                    continue
                shells, _ = ops.sew(group, 0.01)
                for sh in shells:
                    if not ops.is_closed(sh):
                        raise ValueError(f"{what} {sid} 的殼未閉合(role={role} 需閉合殼:用 capped 放樣/拉伸/掃掠或 360° 旋轉閉合曲線)")
                    solids.append(ops.solid_from_shell(sh))
        return solids

    def cutters(self) -> list:
        """role=cut 的閉殼 → 實體清單(本體融合後減掉)。"""
        if self._cutters is None:
            self._cutters = self._role_solids("cut", "切除體")
        return self._cutters

    def adders(self) -> list:
        """role=add 的閉殼 → 實體清單(切除之後才融合:輪子/裝飾件不被切除體吃掉)。"""
        if self._adders is None:
            self._adders = self._role_solids("add", "附加體")
        return self._adders

    @classmethod
    def _mirror_groups(cls, groups, sym: str) -> list:
        """每個面群整體鏡射;群的 bbox/面積對該平面自對稱者略過。回鏡射出來的新面清單。"""
        out = []
        for _sid, faces in groups:
            fs = list(faces)
            if not fs:
                continue
            mirrored = ops.mirror_faces(fs, sym)
            if not cls._group_self_symmetric(fs, mirrored):
                out.extend(mirrored)
        return out

    @staticmethod
    def _group_self_symmetric(faces, mirrored) -> bool:
        from build123d import Vector

        def bbox(fl):
            lo = Vector(float("inf"), float("inf"), float("inf"))
            hi = Vector(float("-inf"), float("-inf"), float("-inf"))
            for f in fl:
                b = f.bounding_box()
                lo = Vector(min(lo.X, b.min.X), min(lo.Y, b.min.Y), min(lo.Z, b.min.Z))
                hi = Vector(max(hi.X, b.max.X), max(hi.Y, b.max.Y), max(hi.Z, b.max.Z))
            return lo, hi

        lo, hi = bbox(faces)
        mlo, mhi = bbox(mirrored)
        scale = max((hi - lo).length, 1e-6)
        tol = 1e-2 * scale + 1e-3  # 閉合樣條的起點偏差/OCCT bbox 鬆弛量都在 1% 以內
        area = sum(f.area for f in faces)
        marea = sum(f.area for f in mirrored)
        return (
            abs(area - marea) <= 1e-3 * max(area, 1.0)
            and (lo - mlo).length <= tol
            and (hi - mhi).length <= tol
        )

    @staticmethod
    def _self_symmetric(f, m) -> bool:
        from build123d import CenterOf

        bf, bm = f.bounding_box(), m.bounding_box()
        scale = max((bf.max - bf.min).length, 1e-6)
        tol = 1e-3 * scale + 1e-6  # OCCT bbox 有鬆弛量,鏡射前後可差 1e-5 級
        # Face.center() 預設回面上一點(鏡射後不同),要比質心
        return (
            abs(f.area - m.area) <= 1e-4 * max(f.area, 1.0)
            and (bf.min - bm.min).length <= tol
            and (bf.max - bm.max).length <= tol
            and (f.center(CenterOf.MASS) - m.center(CenterOf.MASS)).length <= tol
        )

    @staticmethod
    def _on_symmetry_plane(shell, edge_index: int, sym: str) -> bool:
        from build123d import Edge
        from OCP.TopoDS import TopoDS

        emap = A._edge_face_map(shell)
        e = Edge(TopoDS.Edge_s(emap.FindKey(edge_index)))
        axis = {"XY": "Z", "XZ": "Y", "YZ": "X"}[sym]
        bb = e.bounding_box()
        lo = getattr(bb.min, axis)
        hi = getattr(bb.max, axis)
        return abs(lo) < 1e-3 and abs(hi) < 1e-3

    # -- 成形 ----------------------------------------------------------------
    def build(self):
        """回最終形狀(Solid / Shell / 多件 Compound)並登記 registry。"""
        global _LAST
        from build123d import Compound

        shells = self.shells()
        spec = self.spec
        result = spec["result"]
        thick_op = next((o for o in spec["ops"] if o["op"] == "thicken"), None)
        fillet_op = next((o for o in spec["ops"] if o["op"] == "fillet"), None)
        final: Any
        if result == "shell":
            final = shells[0] if len(shells) == 1 else Compound(shells)
        else:
            solids = []
            for sh in shells:
                if ops.is_closed(sh):
                    solids.append(ops.solid_from_shell(sh))
                elif thick_op:
                    solids.append(ops.thicken(sh, thick_op["t"], thick_op["dir"]))
                else:
                    n_free = len(A.free_edges(sh, polyline_points=2))
                    raise ValueError(
                        f"殼未閉合({n_free} 條開放邊)且未宣告加厚:result=solid 需要 ops 加 thicken,或把邊界補面封閉"
                    )
            if len(solids) > 1 and spec.get("fuse", True):
                final = ops.fuse(solids)
            elif len(solids) > 1:
                final = Compound(solids)
            else:
                final = solids[0]
            cutters = self.cutters()
            if cutters:
                if isinstance(final, Compound):
                    raise ValueError("有切除體時本體必須融合為單一實體(fuse=true;各部件要彼此相交)")
                final = ops.cut(final, cutters)
            adders = self.adders()
            if adders:
                if isinstance(final, Compound):
                    raise ValueError("有附加體時本體必須先是單一實體(fuse=true;各部件要彼此相交)")
                final = ops.fuse([final] + adders)
                if isinstance(final, Compound):
                    raise ValueError(f"附加體沒有碰到本體(融合後仍是 {len(list(final.solids()))} 件):附加體必須與本體相交")
            if fillet_op and not isinstance(final, Compound):
                final = ops.fillet_sharp(final, fillet_op["r"])
        _LAST = {
            "spec": copy.deepcopy(spec),
            "shells": shells,
            "cutters": self._cutters or [],
            "adders": self._adders or [],
            "shape": final,
            "curves": self.curves(),
            "faces": self.faces(),
            "notes": list(self.notes),
            "freeCount": self._free_count,
        }
        return final


# -- 分析 / 閘 ---------------------------------------------------------------
def design_rows(build: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """設計殼(可多殼)的內邊連續性列與開放邊列;邊序號加殼位移避免撞號。"""
    rows: list[dict[str, Any]] = []
    free: list[dict[str, Any]] = []
    offset = 0
    for sh in build["shells"]:
        r = A.edge_continuity(sh)
        f = A.free_edges(sh)
        n = max([x["i"] for x in r] + [x["i"] for x in f] + [0])
        for x in r:
            x["i"] += offset
        for x in f:
            x["i"] += offset
        rows.extend(r)
        free.extend(f)
        offset += n
    return rows, free


def check_surface_model(shape, spec: dict[str, Any], *, build: dict[str, Any] | None = None) -> None:
    """產生器 ``check_geometry`` 用的閘:有效幾何、result=solid 零開放邊、設計殼連續性達標。"""
    from cadpy.geometry_checks import is_valid_solid

    if not is_valid_solid(shape):
        raise AssertionError("曲面模型無效(BRepCheck)")
    spec_n = normalize_spec(spec)
    build = build or _LAST
    if spec_n["result"] == "solid":
        free = A.free_edges(shape, polyline_points=2)
        if free:
            raise AssertionError(f"result=solid 但最終形狀仍有 {len(free)} 條開放邊")
    if build is None:
        rows = A.edge_continuity(shape)
    else:
        rows, _ = design_rows(build)
    an = spec_n["analysis"]
    bad = A.continuity_violations(rows, an["minContinuity"], an["creases"])
    if bad:
        worst = sorted(bad, key=lambda r: (A.GRADE_RANK[r["grade"]], -r["g1Deg"]))[:3]
        desc = "; ".join(f"邊#{r['i']} {r['grade']}(法向夾角 {r['g1Deg']:.2f}°、曲率偏差 {r['g2Rel']:.2f})" for r in worst)
        raise AssertionError(
            f"{len(bad)} 條內邊低於宣告的最低連續性 {an['minContinuity']}:{desc}"
            "(修法:相鄰截面/補面邊給相切或曲率連續約束,或調整 analysis.minContinuity/creases)"
        )


def harvest_meta(module: object, *, max_curve_points: int = 48) -> dict[str, Any] | None:
    """build-meta sidecar 的 ``surface`` 欄位(模組無 ``SURFACE_SPEC`` 或 registry 空 → None)。"""
    raw = getattr(module, "SURFACE_SPEC", None)
    if not isinstance(raw, dict):
        return None
    build = _LAST
    if build is None:
        return None
    try:
        spec = build["spec"]
        rows, free = design_rows(build)
        faces: list[dict[str, Any]] = []
        cages: list[dict[str, Any]] = []
        for sh in build["shells"]:
            f, c = A.face_table(sh, with_cages=len(cages) < A.MAX_CAGE_FACES)
            off = len(faces)
            for x in f:
                x["i"] += off
            for x in c:
                x["face"] += off
            faces.extend(f)
            cages.extend(c)
        shape = build["shape"]
        final_rows: list[dict[str, Any]] = []
        same_topology = len(build["shells"]) == 1 and len(shape.faces()) == len(build["shells"][0].faces())
        if not same_topology:
            final_rows = A.edge_continuity(shape)
        # 曲線折線 + 曲率梳(梳長:最大曲率對應 bbox 對角 8%)
        bb = shape.bounding_box()
        diag = max((bb.max - bb.min).length, 1e-6)
        curves_out = []
        combs = []
        kmax_all = 0.0
        comb_raw = {}
        for cid, e in build["curves"].items():
            curves_out.append({"id": cid, "pts": curve_polyline(e, max_curve_points)})
            cr = curve_comb(e, 32, 1.0)
            comb_raw[cid] = cr
            kmax_all = max(kmax_all, max((x["k"] for x in cr), default=0.0))
        scale = (0.08 * diag / kmax_all) if kmax_all > 1e-9 else 0.0
        for cid, cr in comb_raw.items():
            combs.append({
                "curve": cid,
                "scale": round(scale, 6),
                "segs": [[x["p"], [round(x["p"][k] + scale * x["v"][k], 4) for k in range(3)]] for x in cr],
            })
        return {
            "schemaVersion": 1,
            "result": spec["result"],
            "spec": spec,
            "edges": rows,
            "finalEdges": final_rows,
            "freeEdges": free,
            "faces": faces,
            "cages": cages,
            "curves": curves_out,
            "combs": combs,
            "notes": build.get("notes", []),
            "summary": {
                **A.summarize(rows, free, spec.get("analysis")),
                # 最終形狀的開放邊數(validate.py free_edges 列與快路徑文案同源)
                "finalFree": len(A.free_edges(shape, polyline_points=2)),
            },
        }
    except Exception as exc:  # noqa: BLE001 — 收割是 best-effort
        return {"schemaVersion": 1, "error": f"{type(exc).__name__}: {exc}"}
