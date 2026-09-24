"""STEP -> 四視圖工程圖 PDF(白底無圖框,仿客戶原廠圖面形制)。

版面(同一張紙、同一比例):
    左上=俯視(寬x長,長度縱向)   右上=等角
    左下=前視(寬x高)             右下=側視(長x高,U 形輪廓)
標註三個包絡尺寸:俯視左側=總長、前視下方=總寬、前視左側=總高
(數值取實體 bbox——誠實量測,不抄 PARAMS)。
電纜件(解析側視成立時)側視右側再標兩個固定頭尺寸:固定頭高(上固定頭
堆疊高)與固定頭安裝高度(上固定頭底面 − 下固定頭底面),數值取固定座實體
bbox——客戶手繪規格(39.5 / 190)直接在圖上對得到。
STEP 旁若有同名產生器 .py(或 --gen 指定),側視下方附 PARAMS 參數表
(key = value,源碼順序):逐層電纜長 L1/L2/L3 這類「投影量不到」的輸入
規格靠這張表回到圖面上。

投影策略(兩層混合,原因是 OCCT 的兩個毛病互補):
- 精確 HLR(HLRBRep_Algo)線條乾淨,但對本 app 的 B-spline 掃出件會
  **非決定性** access violation(0xC0000005;同一份位元組一次過一次崩,
  native crash 不可 catch)→ 投影一律在**子程序 worker** 跑,崩了主程序不死,
  試一次;
- 網格式 HLR(HLRBRep_PolyAlgo)穩不崩,但相切區線段會被誤判隱藏而**斷線**
  → 只當退路,並對輸出做端點縫合(近距+同向才接,不亂連)。
主程序只做版面與 matplotlib 向量 PDF(單 axes = 全圖同比例)。

用法:drawing_pdf.py <step 路徑> [--out <pdf 路徑>] [--gen <產生器 .py>]
(cwd=repo 根;預設輸出 STEP 同目錄同名 .pdf;--gen 預設找 STEP 旁同名 .py)。
內部:drawing_pdf.py <step> --project-worker exact|poly --views-out <json>
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys

DEFLECTION = 0.08   # mm 弦差(精確 HLR 邊離散)
MESH_LIN = 0.04     # mm 網格線性偏差(退路;細=相切區斷口縮到亞毫米,好縫;
                    # 0.03 更乾淨但耗時翻倍,0.04 是畫質/時間的折衷)
MESH_ANG = 0.08     # rad 網格角偏差(相切區誤判範圍隨之縮小)
LW_SHARP = 0.7      # 銳邊/輪廓線寬(pt)
LW_SMOOTH = 0.3     # 平滑切線邊(圓管縱向線這類)
EXACT_TRIES = 1     # 精確 HLR 子程序嘗試次數(崩潰非決定性;掃出件幾乎必崩,
                    # 多試只是燒時間——退路品質已夠,一次不過就退網格)
WORKER_TIMEOUT = 90 # 秒(單次 worker;匯出端逾時 180s 內留退路時間)

VIEWS = {
    # name: (視線方向 n(朝觀察者), 圖紙 X 方向 vx 或 None)
    "top": ((0, 0, 1), (1, 0, 0)),      # 俯視:x=寬, y=長
    "front": ((0, -1, 0), (1, 0, 0)),   # 前視:x=寬, y=高
    "side": ((1, 0, 0), (0, 1, 0)),     # 側視:x=長, y=高
    "iso": ((1.0 / math.sqrt(3), -1.0 / math.sqrt(3), 1.0 / math.sqrt(3)), None),
}


# ═══════════════════════════ worker:投影 ═══════════════════════════
def _edges_to_polylines(compound):
    """HLR 輸出 compound -> [[(x,y),...]](投影座標系,z 已壓平)。"""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    polys = []
    if compound is None or compound.IsNull():
        return polys
    exp = TopExp_Explorer(compound, TopAbs_EDGE)
    while exp.More():
        edge = TopoDS.Edge_s(exp.Current())
        exp.Next()
        try:
            curve = BRepAdaptor_Curve(edge)
            disc = GCPnts_QuasiUniformDeflection(
                curve, DEFLECTION, curve.FirstParameter(), curve.LastParameter()
            )
            if not disc.IsDone() or disc.NbPoints() < 2:
                continue
            polys.append(
                [(round(disc.Value(i).X(), 4), round(disc.Value(i).Y(), 4))
                 for i in range(1, disc.NbPoints() + 1)]
            )
        except Exception:
            continue  # 單邊離散失敗跳過,不毀整圖
    return polys


def _ax2(n, vx):
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    return (
        gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*n), gp_Dir(*vx))
        if vx is not None
        else gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*n))
    )


def _project_exact(shape, n, vx):
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape

    algo = HLRBRep_Algo()
    algo.Add(shape)
    algo.Projector(HLRAlgo_Projector(_ax2(n, vx)))
    algo.Update()
    algo.Hide()
    hlr = HLRBRep_HLRToShape(algo)
    return {
        "sharp": _edges_to_polylines(hlr.VCompound()) + _edges_to_polylines(hlr.OutLineVCompound()),
        "smooth": _edges_to_polylines(hlr.Rg1LineVCompound()),
    }


def _project_poly(shape, n, vx):
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_PolyAlgo, HLRBRep_PolyHLRToShape

    algo = HLRBRep_PolyAlgo()
    algo.Load(shape)
    algo.Projector(HLRAlgo_Projector(_ax2(n, vx)))
    algo.Update()
    hlr = HLRBRep_PolyHLRToShape()
    hlr.Update(algo)
    return {
        "sharp": _edges_to_polylines(hlr.VCompound()) + _edges_to_polylines(hlr.OutLineVCompound()),
        "smooth": _edges_to_polylines(hlr.Rg1LineVCompound()),
    }


def _measure_cable_extras(shape):
    """量 outer_h(帶厚)與固定座 (y,z) 矩形——供解析側視。非電纜件回 None。"""
    from build123d import Face, Plane

    solids = shape.solids()
    bands = [s for s in solids if s.bounding_box().size.Y >= 40.0]
    racks = [s for s in solids if s.bounding_box().size.Y < 40.0]
    if not bands or not racks:
        return None
    b = bands[0]
    bb = b.bounding_box()
    yc = bb.max.Y - 5.0  # 近連接器端的直段
    try:
        sec = Face.make_rect(
            600, 600, plane=Plane(origin=(0, yc, 0), x_dir=(1, 0, 0), z_dir=(0, 1, 0))
        ).intersect(b)
        outer_h = sec.faces()[0].bounding_box().size.Z
    except Exception:
        return None
    if not (0 < outer_h < 40):
        return None
    rack_rects = []
    for r in racks:
        rb = r.bounding_box()
        rack_rects.append([rb.min.Y, rb.min.Z, rb.max.Y, rb.max.Z])
    return {"outer_h": round(outer_h, 4), "rack_rects": rack_rects}


def _worker(step_path, mode, views_out):
    from build123d import import_step

    shape = import_step(step_path)
    bb = shape.bounding_box()
    lwh = [bb.size.Y, bb.size.X, bb.size.Z]  # 本 repo 慣例:長=Y、寬=X、高=Z
    solid = shape.wrapped
    if mode == "poly":
        from OCP.BRepMesh import BRepMesh_IncrementalMesh

        BRepMesh_IncrementalMesh(solid, MESH_LIN, False, MESH_ANG, True)  # 4 視圖共用
        project = _project_poly
    else:
        project = _project_exact
    views = {name: project(solid, n, vx) for name, (n, vx) in VIEWS.items()}
    extras = None
    try:
        extras = _measure_cable_extras(shape)
    except Exception:
        extras = None
    out = {"mode": mode, "lwh": lwh, "views": views}
    if extras:
        out["cable"] = extras
    with open(views_out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    return 0


# ═══════════════════════ 網格退路的斷線縫合 ═══════════════════════
def _tangent(poly, at_end):
    """折線在端點處「向外」的單位切線(取端點附近一小段,抗單一短facet抖動)。"""
    pts = poly if at_end else poly[::-1]
    ex, ey = pts[-1]
    for px, py in reversed(pts[:-1]):
        dx, dy = ex - px, ey - py
        L = math.hypot(dx, dy)
        if L > 1e-6:
            return dx / L, dy / L
    return 1.0, 0.0


def _stitch(polys, gap, max_turn_deg=70.0):
    """縫合網格 HLR 在相切區丟失的斷口。策略:蒐集所有「端點對」候選
    (距離 < gap),按距離排序後貪婪配對——每端點只用一次、只接互不衝突的對、
    且接點轉角不得成髮夾(> max_turn)以防把不同輪廓的鄰近端點亂接。
    彎曲輪廓的斷口兩端本就帶小角度,故用「轉角上限」而非「必須共線」。"""
    polys = [list(p) for p in polys if len(p) >= 2]
    if len(polys) < 2:
        return polys
    cos_turn = math.cos(math.radians(max_turn_deg))

    # 空間格網索引所有端點:cell -> [(poly_idx, at_end)]
    def cell(p):
        return (int(math.floor(p[0] / gap)), int(math.floor(p[1] / gap)))

    grid: dict = {}
    for i, poly in enumerate(polys):
        for at_end in (False, True):
            grid.setdefault(cell(poly[-1] if at_end else poly[0]), []).append((i, at_end))

    # 蒐集候選對(i<j 去重),距離 < gap 且轉角非髮夾
    cands = []
    for i, poly in enumerate(polys):
        for at_end in (False, True):
            p = poly[-1] if at_end else poly[0]
            tx, ty = _tangent(poly, at_end)
            cx, cy = cell(p)
            for ddx in (-1, 0, 1):
                for ddy in (-1, 0, 1):
                    for (j, j_end) in grid.get((cx + ddx, cy + ddy), []):
                        if j <= i:
                            continue
                        q = polys[j][-1] if j_end else polys[j][0]
                        d = math.hypot(p[0] - q[0], p[1] - q[1])
                        if d >= gap:
                            continue
                        ux, uy = _tangent(polys[j], j_end)
                        # 兩段向外切線應接近反向(接起來連續);-dot >= cos_turn 即可
                        if -(tx * ux + ty * uy) < cos_turn:
                            continue
                        cands.append((d, i, at_end, j, j_end))
    cands.sort(key=lambda c: c[0])

    # union-find(追蹤合併後折線)+ 端點佔用
    parent = list(range(len(polys)))

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    alive = [list(p) for p in polys]
    used = set()  # (poly_idx, at_end) 已接
    for d, i, ie, j, je in cands:
        if (i, ie) in used or (j, je) in used:
            continue
        ri, rj = root(i), root(j)
        if ri == rj:
            continue  # 已同一條(避免自接成環的退化)
        mine, other = alive[ri], alive[rj]
        # 端點必須仍是各自合併折線的「頭」或「尾」(否則已被縫進中段)
        pi = polys[i][-1] if ie else polys[i][0]
        pj = polys[j][-1] if je else polys[j][0]
        mi = math.dist(pi, mine[-1]) < 1e-9
        if not mi and math.dist(pi, mine[0]) >= 1e-9:
            continue
        mj = math.dist(pj, other[-1]) < 1e-9
        if not mj and math.dist(pj, other[0]) >= 1e-9:
            continue
        seq_i = mine if mi else mine[::-1]      # i 端接到尾
        seq_j = other[::-1] if mj else other    # j 端接到頭
        merged = seq_i + seq_j
        parent[rj] = ri
        alive[ri] = merged
        alive[rj] = []
        used.add((i, ie))
        used.add((j, je))
    return [p for p in alive if len(p) >= 2]


# ══════════════ 電纜側視:解析法(不經 HLR,零斷線) ══════════════
# 側視看向 X 軸 → 圖面座標 = 世界 (y, z)。每條護套帶是沿 drag_chain 中心線
# (build meta 的 sweepPaths,世界座標)掃出、厚 outer_h 的絲帶;在側視平面把
# 中心線往法向偏移 ±outer_h/2 得兩條邊,於固定座矩形處截斷(帶穿進固定座被
# 擋),固定座畫成堆疊矩形。網格 HLR 的相切斷線在此完全不存在。
def _offset_curve(cl, half):
    """中心線 [(y,z)...] 往法向偏移 half(>0 左側 / <0 右側)。"""
    out = []
    n = len(cl)
    for i in range(n):
        a = cl[max(0, i - 1)]
        b = cl[min(n - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / L, tx / L  # 左法向
        out.append((cl[i][0] + half * nx, cl[i][1] + half * ny))
    return out


def _cable_side_view(paths_world, outer_h, rack_rects):
    """回 {sharp, smooth}:完整絲帶邊(連續穿過固定座到連接器端,不截斷——
    原廠側視是電纜穿過固定座「框」、線透過去可見)+ 固定座外框矩形。
    paths_world: [[[x,y,z]...]...](中心線);rack_rects: [(y0,z0,y1,z1)...]。"""
    lines = []
    half = outer_h / 2.0
    for cl3 in paths_world:
        cl = [(p[1], p[2]) for p in cl3]  # 投影到 (y, z)
        if len(cl) < 2:
            continue
        for h in (half, -half):
            lines.append(_offset_curve(cl, h))  # 全長,不截斷
    # 固定座:每個 solid 的 (y,z) bbox 畫成外框矩形(堆疊 → 自然顯示分層線)
    for (y0, z0, y1, z1) in rack_rects:
        lines.append([(y0, z0), (y1, z0), (y1, z1), (y0, z1), (y0, z0)])
    return {"sharp": lines, "smooth": []}


# ═══════════════════════════ 主程序:版面 ═══════════════════════════
def _bounds(view):
    xs = [p[0] for k in ("sharp", "smooth") for poly in view[k] for p in poly]
    ys = [p[1] for k in ("sharp", "smooth") for poly in view[k] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def _fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or "0"


class Sheet:
    """單一 axes 的圖紙:視圖平移擺放 + 尺寸標註。"""

    def __init__(self, ax):
        self.ax = ax

    def place(self, view, cx, cy):
        x0, y0, x1, y1 = _bounds(view)
        dx, dy = cx - (x0 + x1) / 2.0, cy - (y0 + y1) / 2.0
        self.last_offset = (dx, dy)  # 視圖座標 → 圖紙座標的平移(附加標註用)
        for key, lw in (("sharp", LW_SHARP), ("smooth", LW_SMOOTH)):
            for poly in view[key]:
                self.ax.plot(
                    [p[0] + dx for p in poly], [p[1] + dy for p in poly],
                    color="black", linewidth=lw, solid_capstyle="round",
                )
        return x0 + dx, y0 + dy, x1 + dx, y1 + dy

    def dim_h(self, x0, x1, y, text, text_size, below=False):
        """水平尺寸線;數字預設在線上方,below=True 放線下方(線緊貼視圖底時用)。"""
        self.ax.annotate(
            "", xy=(x0, y), xytext=(x1, y),
            arrowprops=dict(arrowstyle="<|-|>", color="black", lw=0.6,
                            mutation_scale=8, shrinkA=0, shrinkB=0),
        )
        if below:
            self.ax.text((x0 + x1) / 2.0, y - text_size * 0.4, text,
                         ha="center", va="top", fontsize=8)
        else:
            self.ax.text((x0 + x1) / 2.0, y + text_size * 0.4, text,
                         ha="center", va="bottom", fontsize=8)

    def dim_v(self, y0, y1, x, text, text_size):
        self.ax.annotate(
            "", xy=(x, y0), xytext=(x, y1),
            arrowprops=dict(arrowstyle="<|-|>", color="black", lw=0.6,
                            mutation_scale=8, shrinkA=0, shrinkB=0),
        )
        self.ax.text(x - text_size * 0.4, (y0 + y1) / 2.0, text,
                     ha="right", va="center", fontsize=8, rotation=90)

    def ext_lines(self, pts, lw=0.4):
        for (xa, ya), (xb, yb) in pts:
            self.ax.plot([xa, xb], [ya, yb], color="black", linewidth=lw)


def _read_meta_sweep_paths(step_path):
    """讀 STEP 旁的掃出中心線:先 build meta(.{stem}.step.meta.json 的
    sweepPaths;頂層工作基準有),沒有就退 .{stem}.sweep.json(版本快照只凍結
    這份 sidecar,不凍 meta;paths 條目同形 {label, points})。兩者皆無回 None。
    匯出 scratch 需一併複製才找得到(見 handleExport)。"""
    d = os.path.dirname(os.path.abspath(step_path))
    base = os.path.basename(step_path)
    stem = base[:-5] if base.lower().endswith(".step") else base
    sp = None
    for fname, key in ((f".{stem}.step.meta.json", "sweepPaths"), (f".{stem}.sweep.json", "paths")):
        try:
            with open(os.path.join(d, fname), encoding="utf-8") as f:
                sp = json.load(f).get(key)
        except Exception:
            continue
        if isinstance(sp, list) and sp:
            break
    if not isinstance(sp, list) or not sp:
        return None
    paths = []
    for entry in sp:
        pts = entry.get("points") if isinstance(entry, dict) else None
        if isinstance(pts, list) and len(pts) >= 2:
            paths.append(pts)
    return paths or None


def _read_gen_params(py_path):
    """讀產生器頂部 `PARAMS = {...}`(單層數值 dict;regex 與 pipeline.mjs
    paramValuesFromGenerator 同式)→ [(key, value)] 依源碼順序;無檔/無區塊回 []。"""
    if not py_path:
        return []
    try:
        with open(py_path, encoding="utf-8") as f:
            src = f.read()
    except Exception:
        return []
    m = re.search(r"PARAMS\s*=\s*\{([^{}]*)\}", src)
    if not m:
        return []
    return [(e.group(1), float(e.group(2)))
            for e in re.finditer(r"""["']([^"']+)["']\s*:\s*(-?\d+(?:\.\d+)?)""", m.group(1))]


def _rack_stacks(rack_rects):
    """固定座 (y0,z0,y1,z1) 矩形 → 兩疊固定座的 (y0, z0, y1, z1) 包絡,由低到高。
    同一疊的模組(含上下半板)z 向相接,兩疊之間隔著彎徑淨空 → 以 z 連續性分群;
    不是恰好兩疊(非 cable 件、單端固定座)回 None。"""
    if not rack_rects:
        return None
    rects = sorted(rack_rects, key=lambda r: r[1])
    groups = [[rects[0]]]
    for r in rects[1:]:
        if r[1] > max(q[3] for q in groups[-1]) + 1.0:
            groups.append([r])
        else:
            groups[-1].append(r)
    if len(groups) != 2:
        return None
    return [(min(q[0] for q in g), min(q[1] for q in g),
             max(q[2] for q in g), max(q[3] for q in g)) for g in groups]


def _bottom_leg_measure(paths_world, stacks):
    """最外層(最低)中心線的下直段露出長:彎切點 → 下固定頭近面(客戶手繪的 70)。
    U 形上下腿差 = 2r(直段取樣點精確在直線上 → r 精確);彎心 y 由任一弧上取樣點
    反算 (y_i ± sqrt(r² − (z_i − z_c)²),取樣點精確在弧上)→ 切點 y = 彎心 y,零取樣
    誤差。回 (y_tangent, y_face, z_leg) 或 None(非 U 形 / 下固定頭不在該層高度)。"""
    if not paths_world or not stacks:
        return None
    low = min(paths_world, key=lambda pts: min(p[2] for p in pts))
    zs = [p[2] for p in low]
    z0, z_top = min(zs), max(zs)
    r = (z_top - z0) / 2.0
    if r < 1.0:
        return None
    zc = z0 + r
    leg_y = [p[1] for p in low if abs(p[2] - z0) < 1e-6]
    arc = [p for p in low if z0 + 0.5 < p[2] < z_top - 0.5]
    if not leg_y or not arc:
        return None
    crown = min(arc, key=lambda p: abs(p[2] - zc))
    neg = crown[1] < sum(leg_y) / len(leg_y)  # 彎折朝 -y(本 repo 慣例)或 +y
    yi, zi = arc[0][1], arc[0][2]
    root = math.sqrt(max(0.0, r * r - (zi - zc) ** 2))
    y_c = yi + root if neg else yi - root
    stack = next((s for s in stacks if s[1] - 1e-6 <= z0 <= s[3] + 1e-6), None)
    if stack is None:
        return None
    y_face = stack[0] if neg else stack[2]
    leg = (y_face - y_c) if neg else (y_c - y_face)
    if leg <= 0.5:
        return None
    return y_c, y_face, z0


def _run_worker(step_path, mode, views_out):
    """子程序跑投影;回 dict 或 None(崩潰/逾時/壞輸出一律 None)。"""
    if os.path.exists(views_out):
        os.remove(views_out)
    cmd = [sys.executable, os.path.abspath(__file__), step_path,
           "--project-worker", mode, "--views-out", views_out]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=WORKER_TIMEOUT,
                           env={**os.environ, "PYTHONUTF8": "1"})
    except subprocess.TimeoutExpired:
        print(f"[drawing_pdf] {mode} worker timeout", file=sys.stderr)
        return None
    if r.returncode != 0 or not os.path.exists(views_out):
        print(f"[drawing_pdf] {mode} worker exit {r.returncode}: {r.stderr[-300:]}", file=sys.stderr)
        return None
    try:
        with open(views_out, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        print(f"[drawing_pdf] {mode} worker bad json: {e}", file=sys.stderr)
        return None
    finally:
        try:
            os.remove(views_out)
        except OSError:
            pass


def main():
    args = list(sys.argv[1:])
    if not args:
        print("usage: drawing_pdf.py <step> [--out <pdf>]", file=sys.stderr)
        return 2
    step_path = args[0]
    if "--project-worker" in args:
        mode = args[args.index("--project-worker") + 1]
        views_out = args[args.index("--views-out") + 1]
        return _worker(step_path, mode, views_out)

    out_path = args[args.index("--out") + 1] if "--out" in args else (
        step_path[:-5] + ".pdf" if step_path.lower().endswith(".step") else step_path + ".pdf"
    )
    views_json = out_path + ".views.json"
    # 參數表來源:--gen 指定,否則 STEP 旁同名 .py(models/<dir>/ 與匯出 scratch 皆成立)
    gen_path = args[args.index("--gen") + 1] if "--gen" in args else (
        step_path[:-5] + ".py" if step_path.lower().endswith(".step") else None
    )

    data = None
    tries = 0 if "--force-poly" in args else EXACT_TRIES  # --force-poly:驗退路用
    for attempt in range(tries):
        data = _run_worker(step_path, "exact", views_json)
        if data:
            break
        print(f"[drawing_pdf] exact HLR attempt {attempt + 1} failed", file=sys.stderr)
    if not data:
        data = _run_worker(step_path, "poly", views_json)
    if not data:
        print("[drawing_pdf] all projection workers failed", file=sys.stderr)
        return 1

    L, W, H = data["lwh"]
    views = data["views"]
    if data["mode"] == "poly":
        gap = max(1.2, 0.004 * max(L, W, H))
        # 第二道:大間距但只接「近共線」端點——專補長直段上的斷口(超長件的
        # ISO/前視腿部,網格 HLR 會沿直線丟一整段);近共線+大間距不會亂接
        # (兩條不同輪廓的端點極少剛好共線),故安全。
        gap2 = max(gap, 0.02 * max(L, W, H))
        for v in views.values():
            for key in ("sharp", "smooth"):
                stitched = _stitch(v[key], gap)
                v[key] = _stitch(stitched, gap2, max_turn_deg=12.0)

    # 電纜側視改用解析法(零斷線):有 build meta 的中心線 + worker 量到的
    # outer_h / 固定座矩形時,整塊取代 HLR 的 side 視圖。其餘 3 視圖仍走 HLR。
    cable = data.get("cable")
    meta_paths = _read_meta_sweep_paths(step_path)
    side_analytical = False
    if cable and meta_paths:
        try:
            side_an = _cable_side_view(meta_paths, cable["outer_h"], cable["rack_rects"])
            if side_an["sharp"]:
                views["side"] = side_an
                side_analytical = True
                print("[drawing_pdf] side view: analytical (cable ribbons)", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[drawing_pdf] analytical side failed, keep HLR: {e}", file=sys.stderr)

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    top, front, side, iso = views["top"], views["front"], views["side"], views["iso"]
    gap_v = 0.16 * max(L, W, H)
    fig, ax = plt.subplots()
    ax.set_aspect("equal")
    ax.axis("off")
    sheet = Sheet(ax)

    tb, fb, sb, ib = _bounds(top), _bounds(front), _bounds(side), _bounds(iso)
    col1_w = max(tb[2] - tb[0], fb[2] - fb[0])
    col2_w = max(sb[2] - sb[0], ib[2] - ib[0])
    row2_h = max(fb[3] - fb[1], sb[3] - sb[1])
    row1_h = max(tb[3] - tb[1], ib[3] - ib[1])
    c1x = col1_w / 2.0
    c2x = col1_w + gap_v + col2_w / 2.0
    r2y = row2_h / 2.0
    r1y = row2_h + gap_v + row1_h / 2.0
    tbb = sheet.place(top, c1x, r1y)
    fbb = sheet.place(front, c1x, r2y)
    sheet.place(iso, c2x, r1y)
    sbb = sheet.place(side, c2x, r2y)
    sdx, sdy = sheet.last_offset

    ts = 0.02 * max(L, W, H)
    off = 0.07 * max(L, W, H)

    # 電纜件:側視右側標「固定頭高」(上固定頭堆疊 z 範圍)與「固定頭安裝高度」
    # (上固定頭底面 − 下固定頭底面)——固定座實體 bbox 誠實量測,對應客戶手繪
    # 規格的 39.5 / 190。延伸線從固定座右緣拉出;rack1 底面線即包絡底,與外框重合。
    # 兩個尺寸 z 範圍首尾相接(上固定頭底面共點)→ 串接在同一條垂直尺寸線上
    # (同客戶手繪),數字落在固定頭右側空白;分兩條線時 39.5 的數字會擠進固定頭。
    stacks = _rack_stacks(cable.get("rack_rects")) if (side_analytical and cable) else None
    if stacks:
        (r1y0, r1z0, r1y1, r1z1), (r2y0, r2z0, r2y1, r2z1) = stacks
        x_dim = sbb[2] + off
        sheet.dim_v(r2z0 + sdy, r2z1 + sdy, x_dim, _fmt(r2z1 - r2z0), ts)
        sheet.dim_v(r1z0 + sdy, r2z0 + sdy, x_dim, _fmt(r2z0 - r1z0), ts)
        sheet.ext_lines([((r2y1 + sdx, r2z1 + sdy), (x_dim + ts * 0.5, r2z1 + sdy)),
                         ((r2y1 + sdx, r2z0 + sdy), (x_dim + ts * 0.5, r2z0 + sdy)),
                         ((r1y1 + sdx, r1z0 + sdy), (x_dim + ts * 0.5, r1z0 + sdy))])
        # 下直段露出長(客戶手繪的 70):最外層彎切點 → 下固定頭近面,標在側視下方
        # (參數表在更下面 off*0.6 起,不相撞)。延伸線:切點處從帶底緣、固定頭處從板底角。
        leg = _bottom_leg_measure(meta_paths, stacks)
        if leg:
            y_tan, y_face, z_leg = leg
            y_dim = sbb[1] - off * 0.3
            xa, xb = sorted((y_tan + sdx, y_face + sdx))
            sheet.dim_h(xa, xb, y_dim, _fmt(abs(y_face - y_tan)), ts, below=True)
            sheet.ext_lines([((y_tan + sdx, z_leg - cable["outer_h"] / 2.0 + sdy), (y_tan + sdx, y_dim - ts * 0.5)),
                             ((y_face + sdx, r1z0 + sdy), (y_face + sdx, y_dim - ts * 0.5))])

    # 產生器 PARAMS 參數表(側視下方;逐層電纜長這類投影量不到的輸入規格回到圖面)
    gen_params = _read_gen_params(gen_path)
    if gen_params:
        x_t = c2x - col2_w / 2.0
        y_t = min(sbb[1], fbb[1]) - off * 0.95  # 讓出側視下方 bottom_leg 尺寸線+數字的位置
        lines = ["PARAMS"] + [f"{k} = {_fmt(v)}" for k, v in gen_params]
        ax.text(x_t, y_t, "\n".join(lines), ha="left", va="top", fontsize=7,
                family="monospace", linespacing=1.4)
        ax.update_datalim([[x_t, y_t - ts * 0.9 * len(lines)]])  # 文字不進 autoscale
    xL = tbb[0] - off
    sheet.dim_v(tbb[1], tbb[3], xL, _fmt(L), ts)
    sheet.ext_lines([((tbb[0], tbb[1]), (xL - ts * 0.5, tbb[1])),
                     ((tbb[0], tbb[3]), (xL - ts * 0.5, tbb[3]))])
    yW = fbb[1] - off
    sheet.dim_h(fbb[0], fbb[2], yW, _fmt(W), ts)
    sheet.ext_lines([((fbb[0], fbb[1]), (fbb[0], yW - ts * 0.5)),
                     ((fbb[2], fbb[1]), (fbb[2], yW - ts * 0.5))])
    xH = fbb[0] - off
    sheet.dim_v(fbb[1], fbb[3], xH, _fmt(H), ts)
    sheet.ext_lines([((fbb[0], fbb[1]), (xH - ts * 0.5, fbb[1])),
                     ((fbb[0], fbb[3]), (xH - ts * 0.5, fbb[3]))])

    ax.margins(0.06)
    fig.canvas.draw()
    x0, x1 = ax.get_xlim()
    y0, y1 = ax.get_ylim()
    ratio = (y1 - y0) / (x1 - x0)
    fw = 16.5
    fh = fw * ratio
    if fh > 11.7:
        fh = 11.7
        fw = fh / ratio
    fig.set_size_inches(fw, fh)
    fig.savefig(out_path, format="pdf", bbox_inches="tight", pad_inches=0.3)
    print(f"[drawing_pdf] wrote {out_path} (L={_fmt(L)} W={_fmt(W)} H={_fmt(H)}, "
          f"projection={data['mode']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
