"""``surface-draft-v1`` spec:OCP-free 正規化與驗證(cad-chat 產品設計模式的草稿契約)。

單一真相是 ``apps/cad-chat/src/lib/surface/surfaceSchema.js``(前後端共用);本模組是
Python 端的鏡射,供 ``SurfaceBuilder`` 在建模前把壞草稿擋在 kernel 之外(ValueError 帶
路徑),兩邊以共用範例檔(``src/lib/surface/examples/*.json``)互鎖防漂移。

文法摘要(與 JS 逐欄一致):
- 頂層:``schemaVersion``=1、``unit``="mm"、``result``∈{solid,shell}、``symmetry``∈{null,XY,XZ,YZ}、
  ``fuse``(bool,預設 true)、``curves``/``surfaces``/``ops``/``analysis``。
- curves:id 唯一(``^[a-z][a-z0-9_]*$``);kind∈{spline,nurbs,bezier,arc3,line,circle}。
- surfaces:op∈{loft,patch,revolve,extrude,ruled,sweep,gordon};引用的曲線/曲面 id 必須先宣告;
  ``role``∈{body,cut,add}(預設 body;cut=閉合殼當切除體,本體融合後減掉——輪拱/開口;
  add=附加體,**切除之後**才融合——輪子/輪轂/裝飾件,不會被切除體一起切掉);
  loft/extrude/revolve/sweep 的 ``capped``(預設 false;自由邊迴圈補平面端蓋成閉殼——輪子/把手/切除體)。
- ops:op∈{sew,thicken,fillet};thicken 只在 result=solid 有意義。
- analysis:``minContinuity``∈{G0,G1,G2}(預設 G1)、``creases``(int≥0,預設 0)、``zebra``(bool)。
"""
from __future__ import annotations

import math
import re
from typing import Any

SCHEMA_VERSION = 1
CURVE_KINDS = ("spline", "nurbs", "bezier", "arc3", "line", "circle")
SURFACE_OPS = ("loft", "patch", "revolve", "extrude", "ruled", "sweep", "gordon")
TOP_OPS = ("sew", "thicken", "fillet")
PLANES = ("XY", "XZ", "YZ")
CONTINUITY = ("G0", "G1", "G2")
THICKEN_DIRS = ("outward", "inward")
SURFACE_ROLES = ("body", "cut", "add")
CAPPED_OPS = ("loft", "extrude", "revolve", "sweep")
_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# 防禦性上限(與 JS 相同):失控草稿不灌爆 builder/前端。
MAX_CURVES = 64
MAX_SURFACES = 32
MAX_POINTS = 64
MAX_NURBS_DEGREE = 5
MAX_BEZIER_POLES = 8


class SpecError(ValueError):
    """草稿不合法;``errors`` 為 ``[{path, message}]``(與 JS validator 同形)。"""

    def __init__(self, errors: list[dict[str, str]]):
        self.errors = errors
        super().__init__("; ".join(f"{e['path']}: {e['message']}" for e in errors) or "invalid spec")


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _vec3(v: Any) -> bool:
    return isinstance(v, (list, tuple)) and len(v) == 3 and all(_is_num(x) for x in v)


def _points(v: Any, lo: int, hi: int = MAX_POINTS) -> bool:
    return isinstance(v, (list, tuple)) and lo <= len(v) <= hi and all(_vec3(p) for p in v)


def validate_spec(raw: Any) -> list[dict[str, str]]:
    """回傳錯誤清單(空=合法)。不丟例外、不改 raw。"""
    errs: list[dict[str, str]] = []

    def err(path: str, msg: str) -> None:
        errs.append({"path": path, "message": msg})

    if not isinstance(raw, dict):
        return [{"path": "", "message": "spec 必須是物件"}]
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        err("schemaVersion", f"必須是 {SCHEMA_VERSION}")
    if raw.get("unit", "mm") != "mm":
        err("unit", "只支援 mm")
    if raw.get("result", "solid") not in ("solid", "shell"):
        err("result", "必須是 solid 或 shell")
    sym = raw.get("symmetry")
    if sym is not None and sym not in PLANES:
        err("symmetry", "必須是 null/XY/XZ/YZ")
    if "fuse" in raw and not isinstance(raw["fuse"], bool):
        err("fuse", "必須是布林")
    rev = raw.get("revision", 0)
    if not (isinstance(rev, int) and not isinstance(rev, bool) and rev >= 0):
        err("revision", "必須是 ≥0 的整數")

    curves = raw.get("curves")
    curve_ids: set[str] = set()
    if not isinstance(curves, list) or not curves:
        err("curves", "至少一條曲線")
        curves = []
    if len(curves) > MAX_CURVES:
        err("curves", f"曲線數上限 {MAX_CURVES}")
    for i, c in enumerate(curves):
        p = f"curves[{i}]"
        if not isinstance(c, dict):
            err(p, "必須是物件")
            continue
        cid = c.get("id")
        if not isinstance(cid, str) or not _ID_RE.match(cid):
            err(f"{p}.id", "id 需為小寫字母開頭的 [a-z0-9_]")
        elif cid in curve_ids:
            err(f"{p}.id", f"id 重複:{cid}")
        else:
            curve_ids.add(cid)
        kind = c.get("kind")
        if kind not in CURVE_KINDS:
            err(f"{p}.kind", f"kind 必須是 {'/'.join(CURVE_KINDS)}")
            continue
        if "plane" in c and c["plane"] is not None and c["plane"] not in PLANES:
            err(f"{p}.plane", "必須是 null/XY/XZ/YZ")
        if "closed" in c and not isinstance(c["closed"], bool):
            err(f"{p}.closed", "必須是布林")
        if kind == "spline":
            if not _points(c.get("points"), 2):
                err(f"{p}.points", f"需 2–{MAX_POINTS} 個 [x,y,z]")
            tg = c.get("tangents")
            if tg is not None:
                if not isinstance(tg, dict):
                    err(f"{p}.tangents", "需為 {start?, end?} 物件")
                else:
                    for k in ("start", "end"):
                        if k in tg and tg[k] is not None and not _vec3(tg[k]):
                            err(f"{p}.tangents.{k}", "需為 [x,y,z]")
                    if any(k not in ("start", "end") for k in tg):
                        err(f"{p}.tangents", "只允許 start/end")
        elif kind == "nurbs":
            deg = c.get("degree")
            if not (isinstance(deg, int) and not isinstance(deg, bool) and 1 <= deg <= MAX_NURBS_DEGREE):
                err(f"{p}.degree", f"degree 需為 1–{MAX_NURBS_DEGREE} 整數")
                deg = None
            poles = c.get("poles")
            if not _points(poles, 2):
                err(f"{p}.poles", f"需 2–{MAX_POINTS} 個 [x,y,z]")
            elif deg is not None and len(poles) < deg + 1:
                err(f"{p}.poles", f"degree {deg} 至少 {deg + 1} 個控制點")
            w = c.get("weights")
            if w is not None:
                if not (isinstance(w, list) and all(_is_num(x) and x > 0 for x in w)):
                    err(f"{p}.weights", "需為正數陣列")
                elif isinstance(poles, list) and len(w) != len(poles):
                    err(f"{p}.weights", "長度需與 poles 相同")
        elif kind == "bezier":
            if not _points(c.get("poles"), 2, MAX_BEZIER_POLES):
                err(f"{p}.poles", f"需 2–{MAX_BEZIER_POLES} 個 [x,y,z]")
        elif kind == "arc3":
            if not _points(c.get("points"), 3, 3):
                err(f"{p}.points", "需恰 3 個 [x,y,z]")
        elif kind == "line":
            if not _points(c.get("points"), 2, 2):
                err(f"{p}.points", "需恰 2 個 [x,y,z]")
        elif kind == "circle":
            if not _vec3(c.get("center")):
                err(f"{p}.center", "需為 [x,y,z]")
            if not _vec3(c.get("normal")):
                err(f"{p}.normal", "需為 [x,y,z]")
            if not (_is_num(c.get("r")) and c["r"] > 0):
                err(f"{p}.r", "半徑需 > 0")

    surfaces = raw.get("surfaces")
    surf_ids: set[str] = set()
    if not isinstance(surfaces, list) or not surfaces:
        err("surfaces", "至少一個曲面")
        surfaces = []
    if len(surfaces) > MAX_SURFACES:
        err("surfaces", f"曲面數上限 {MAX_SURFACES}")

    def ref_curve(path: str, v: Any) -> None:
        if not isinstance(v, str) or v not in curve_ids:
            err(path, f"引用未宣告的曲線:{v!r}")

    for i, s in enumerate(surfaces):
        p = f"surfaces[{i}]"
        if not isinstance(s, dict):
            err(p, "必須是物件")
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not _ID_RE.match(sid):
            err(f"{p}.id", "id 需為小寫字母開頭的 [a-z0-9_]")
        elif sid in surf_ids or sid in curve_ids:
            err(f"{p}.id", f"id 重複:{sid}")
        op = s.get("op")
        if op not in SURFACE_OPS:
            err(f"{p}.op", f"op 必須是 {'/'.join(SURFACE_OPS)}")
            if isinstance(sid, str):
                surf_ids.add(sid)
            continue
        if s.get("role", "body") not in SURFACE_ROLES:
            err(f"{p}.role", "需為 body/cut/add")
        if "capped" in s and not isinstance(s["capped"], bool):
            err(f"{p}.capped", "必須是布林")
        if "capped" in s and op not in CAPPED_OPS:
            err(f"{p}.capped", "只有 loft/extrude/revolve/sweep 支援 capped")
        if op == "loft":
            secs = s.get("sections")
            if not isinstance(secs, list) or len(secs) < 2:
                err(f"{p}.sections", "至少 2 條截面曲線")
            else:
                for j, c in enumerate(secs):
                    ref_curve(f"{p}.sections[{j}]", c)
            if "ruled" in s and not isinstance(s["ruled"], bool):
                err(f"{p}.ruled", "必須是布林")
        elif op == "patch":
            bnd = s.get("boundary")
            if not isinstance(bnd, list) or len(bnd) < 2:
                err(f"{p}.boundary", "至少 2 條邊界曲線(需閉合成環)")
                bnd = []
            else:
                for j, c in enumerate(bnd):
                    ref_curve(f"{p}.boundary[{j}]", c)
            cont = s.get("continuity")
            if cont is not None:
                if not isinstance(cont, dict):
                    err(f"{p}.continuity", "需為 {curveId: {face, level}} 物件")
                else:
                    for k, v in cont.items():
                        if k not in bnd:
                            err(f"{p}.continuity.{k}", "不是本補面的邊界曲線")
                        if not isinstance(v, dict) or v.get("level") not in ("G1", "G2") or not isinstance(v.get("face"), str):
                            err(f"{p}.continuity.{k}", "需為 {face: 曲面id, level: G1|G2}")
                        elif v["face"] not in surf_ids:
                            err(f"{p}.continuity.{k}.face", f"引用未宣告(或尚未宣告)的曲面:{v['face']}")
            pts = s.get("points")
            if pts is not None and not _points(pts, 1, 16):
                err(f"{p}.points", "需為 1–16 個 [x,y,z]")
        elif op == "revolve":
            ref_curve(f"{p}.curve", s.get("curve"))
            ax = s.get("axis")
            if not isinstance(ax, dict) or not _vec3(ax.get("origin")) or not _vec3(ax.get("dir")):
                err(f"{p}.axis", "需為 {origin:[x,y,z], dir:[x,y,z]}")
            elif all(abs(x) < 1e-12 for x in ax["dir"]):
                err(f"{p}.axis.dir", "方向不可為零向量")
            ang = s.get("angle", 360)
            if not (_is_num(ang) and 0 < ang <= 360):
                err(f"{p}.angle", "角度需在 (0, 360]")
        elif op == "extrude":
            ref_curve(f"{p}.curve", s.get("curve"))
            if not _vec3(s.get("dir")) or all(abs(x) < 1e-12 for x in s["dir"]):
                err(f"{p}.dir", "需為非零 [x,y,z]")
            if not (_is_num(s.get("length")) and s["length"] > 0):
                err(f"{p}.length", "長度需 > 0")
        elif op == "ruled":
            cs = s.get("curves")
            if not isinstance(cs, list) or len(cs) != 2:
                err(f"{p}.curves", "需恰 2 條曲線")
            else:
                for j, c in enumerate(cs):
                    ref_curve(f"{p}.curves[{j}]", c)
        elif op == "sweep":
            ref_curve(f"{p}.profile", s.get("profile"))
            ref_curve(f"{p}.rail", s.get("rail"))
            g = s.get("guide")
            if g is not None:
                ref_curve(f"{p}.guide", g)
        elif op == "gordon":
            for key in ("profiles", "guides"):
                lst = s.get(key)
                if not isinstance(lst, list) or len(lst) < 2:
                    err(f"{p}.{key}", "至少 2 條曲線")
                else:
                    for j, c in enumerate(lst):
                        ref_curve(f"{p}.{key}[{j}]", c)
        if isinstance(sid, str):
            surf_ids.add(sid)

    ops = raw.get("ops", [])
    if not isinstance(ops, list):
        err("ops", "必須是陣列")
        ops = []
    seen_ops: set[str] = set()
    for i, o in enumerate(ops):
        p = f"ops[{i}]"
        if not isinstance(o, dict) or o.get("op") not in TOP_OPS:
            err(p, f"op 必須是 {'/'.join(TOP_OPS)}")
            continue
        op = o["op"]
        if op in seen_ops:
            err(p, f"{op} 只能出現一次")
        seen_ops.add(op)
        if op == "sew":
            tol = o.get("tol", 0.01)
            if not (_is_num(tol) and tol > 0):
                err(f"{p}.tol", "公差需 > 0")
        elif op == "thicken":
            if not (_is_num(o.get("t")) and o["t"] > 0):
                err(f"{p}.t", "厚度需 > 0")
            if o.get("dir", "outward") not in THICKEN_DIRS:
                err(f"{p}.dir", "需為 outward/inward")
            if raw.get("result", "solid") == "shell":
                err(p, "result=shell 不可加厚")
        elif op == "fillet":
            if not (_is_num(o.get("r")) and o["r"] > 0):
                err(f"{p}.r", "半徑需 > 0")
            if raw.get("result", "solid") == "shell":
                err(p, "result=shell 不可圓角(只對實體)")

    an = raw.get("analysis", {})
    if an is None:
        an = {}
    if not isinstance(an, dict):
        err("analysis", "必須是物件")
    else:
        if an.get("minContinuity", "G1") not in CONTINUITY:
            err("analysis.minContinuity", "需為 G0/G1/G2")
        cr = an.get("creases", 0)
        if not (isinstance(cr, int) and not isinstance(cr, bool) and cr >= 0):
            err("analysis.creases", "需為 ≥0 整數")
        if "zebra" in an and not isinstance(an["zebra"], bool):
            err("analysis.zebra", "必須是布林")
    return errs


def normalize_spec(raw: Any) -> dict[str, Any]:
    """驗證後回傳填滿預設值的新 dict(JSON 相容:無 tuple、bool 保持 bool)。不合法丟 SpecError。"""
    errs = validate_spec(raw)
    if errs:
        raise SpecError(errs)

    def v3(v: Any) -> list[float]:
        return [float(x) for x in v]

    curves = []
    for c in raw["curves"]:
        n: dict[str, Any] = {"id": c["id"], "kind": c["kind"]}
        if c.get("plane") is not None:
            n["plane"] = c["plane"]
        if c["kind"] == "spline":
            n["points"] = [v3(p) for p in c["points"]]
            n["closed"] = bool(c.get("closed", False))
            tg = c.get("tangents") or {}
            t_out = {k: v3(tg[k]) for k in ("start", "end") if tg.get(k) is not None}
            if t_out:
                n["tangents"] = t_out
        elif c["kind"] == "nurbs":
            n["degree"] = int(c["degree"])
            n["poles"] = [v3(p) for p in c["poles"]]
            if c.get("weights") is not None:
                n["weights"] = [float(w) for w in c["weights"]]
            n["closed"] = bool(c.get("closed", False))
        elif c["kind"] == "bezier":
            n["poles"] = [v3(p) for p in c["poles"]]
        elif c["kind"] in ("arc3", "line"):
            n["points"] = [v3(p) for p in c["points"]]
        elif c["kind"] == "circle":
            n["center"] = v3(c["center"])
            n["normal"] = v3(c["normal"])
            n["r"] = float(c["r"])
        curves.append(n)

    surfaces = []
    for s in raw["surfaces"]:
        n = {"id": s["id"], "op": s["op"], "role": s.get("role", "body")}
        if s["op"] in CAPPED_OPS:
            n["capped"] = bool(s.get("capped", False))
        if s["op"] == "loft":
            n["sections"] = list(s["sections"])
            n["ruled"] = bool(s.get("ruled", False))
        elif s["op"] == "patch":
            n["boundary"] = list(s["boundary"])
            cont = s.get("continuity") or {}
            n["continuity"] = {k: {"face": v["face"], "level": v["level"]} for k, v in cont.items()}
            if s.get("points"):
                n["points"] = [v3(p) for p in s["points"]]
        elif s["op"] == "revolve":
            n["curve"] = s["curve"]
            n["axis"] = {"origin": v3(s["axis"]["origin"]), "dir": v3(s["axis"]["dir"])}
            n["angle"] = float(s.get("angle", 360))
        elif s["op"] == "extrude":
            n["curve"] = s["curve"]
            n["dir"] = v3(s["dir"])
            n["length"] = float(s["length"])
        elif s["op"] == "ruled":
            n["curves"] = list(s["curves"])
        elif s["op"] == "sweep":
            n["profile"] = s["profile"]
            n["rail"] = s["rail"]
            n["guide"] = s.get("guide")
        elif s["op"] == "gordon":
            n["profiles"] = list(s["profiles"])
            n["guides"] = list(s["guides"])
        surfaces.append(n)

    ops = []
    for o in raw.get("ops", []) or []:
        if o["op"] == "sew":
            ops.append({"op": "sew", "tol": float(o.get("tol", 0.01))})
        elif o["op"] == "thicken":
            ops.append({"op": "thicken", "t": float(o["t"]), "dir": o.get("dir", "outward")})
        elif o["op"] == "fillet":
            ops.append({"op": "fillet", "r": float(o["r"])})
    # 固定順序:sew → thicken → fillet(草稿順序不影響語意)
    order = {"sew": 0, "thicken": 1, "fillet": 2}
    ops.sort(key=lambda o: order[o["op"]])
    if not any(o["op"] == "sew" for o in ops):
        ops.insert(0, {"op": "sew", "tol": 0.01})

    an = raw.get("analysis") or {}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "unit": "mm",
        "revision": int(raw.get("revision", 0)),
        "result": raw.get("result", "solid"),
        "symmetry": raw.get("symmetry"),
        "fuse": bool(raw.get("fuse", True)),
        "curves": curves,
        "surfaces": surfaces,
        "ops": ops,
        "analysis": {
            "minContinuity": an.get("minContinuity", "G1"),
            "creases": int(an.get("creases", 0)),
            "zebra": bool(an.get("zebra", True)),
        },
    }


def scalar_params(spec: dict[str, Any]) -> dict[str, float]:
    """草稿裡會升格成產生器 ``PARAMS`` 的純量(鍵固定;與 surfaceGen.mjs 同規則)。"""
    out: dict[str, float] = {}
    for o in spec.get("ops", []):
        if o["op"] == "thicken":
            out["thick"] = float(o["t"])
        elif o["op"] == "fillet":
            out["fillet_r"] = float(o["r"])
    for s in spec.get("surfaces", []):
        if s["op"] == "revolve":
            out.setdefault("revolve_deg", float(s.get("angle", 360)))
    return out


def apply_params(spec: dict[str, Any], params: dict[str, Any] | None) -> dict[str, Any]:
    """把 ``PARAMS`` 現值套回 spec 的對應純量(滑桿重生用);回傳新 dict,不改原件。"""
    if not params:
        return spec
    import copy

    out = copy.deepcopy(spec)
    for o in out.get("ops", []):
        if o["op"] == "thicken" and _is_num(params.get("thick")) and params["thick"] > 0:
            o["t"] = float(params["thick"])
        elif o["op"] == "fillet" and _is_num(params.get("fillet_r")) and params["fillet_r"] > 0:
            o["r"] = float(params["fillet_r"])
    if _is_num(params.get("revolve_deg")) and 0 < params["revolve_deg"] <= 360:
        for s in out.get("surfaces", []):
            if s["op"] == "revolve":
                s["angle"] = float(params["revolve_deg"])
    return out
