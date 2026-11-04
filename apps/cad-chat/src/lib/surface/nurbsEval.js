// 草稿曲線的瀏覽器端求值(零 three、零依賴 → node --test 可直測)。工作窗的 live 層用它
// 把 surface-draft-v1 的 curves 畫成折線;baked 層則是 sidecar 的 kernel 取樣。
// 精確(與 cadpy.surface.curves 在**參數** t 上逐點重合,golden 測試釘):line / arc3 / circle /
// bezier / nurbs(clamped uniform knots,與 Python _nurbs_edge 同一套 knot 建構)。
// 近似(標 approx:true):spline(插值樣條)——OCCT GeomAPI_Interpolate 的參數化不在 JS 重現,
// 用 Catmull-Rom 過點近似,拖曳時夠用;套用後以 sidecar 折線為準。
const v = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
};
export const vec3 = v;

export function evalLine(points, t) {
  return v.add(points[0], v.scale(v.sub(points[1], points[0]), t));
}

// 三點圓弧:圓心/半徑/平面由 p1,p2,p3 解析;t∈[0,1] 線性映射到從 p1 經 p2 到 p3 的圓心角
export function arc3Frame(points) {
  const [p1, p2, p3] = points;
  const a = v.sub(p2, p1);
  const b = v.sub(p3, p1);
  const n = v.cross(a, b);
  const nn = v.len(n);
  if (nn < 1e-12) return null; // 共線
  const n1 = v.scale(n, 1 / nn);
  // 圓心:p1 + ((|b|²·(a×b)×a + |a|²·b×(a×b)) / (2|a×b|²))
  const num = v.add(v.scale(v.cross(n, a), v.dot(b, b)), v.scale(v.cross(b, n), v.dot(a, a)));
  const c = v.add(p1, v.scale(num, 1 / (2 * nn * nn)));
  const r = v.len(v.sub(p1, c));
  const u = v.norm(v.sub(p1, c));
  const w = v.cross(n1, u);
  const ang = (p) => Math.atan2(v.dot(v.sub(p, c), w), v.dot(v.sub(p, c), u));
  let a2 = ang(p2);
  let a3 = ang(p3);
  if (a2 < 0) a2 += 2 * Math.PI;
  if (a3 < 0) a3 += 2 * Math.PI;
  // p2 必須在 p1→p3 的掃掠內;否則反向掃
  let sweep = a3;
  if (a2 > a3) sweep = a3 - 2 * Math.PI;
  return { center: c, radius: r, u, w, sweep };
}

export function evalArc3(points, t) {
  const f = arc3Frame(points);
  if (!f) return evalLine([points[0], points[2]], t);
  const th = f.sweep * t;
  return v.add(f.center, v.add(v.scale(f.u, f.radius * Math.cos(th)), v.scale(f.w, f.radius * Math.sin(th))));
}

// 圓:法向為 ±Z 時起點 = 中心 +X(與 kernel 同);其他法向起點由 n×Z(或 n×X)決定——點集相同,
// 只有參數起點可能不同(預覽只畫整圈,無影響)。
export function circleFrame(center, normal, r) {
  const n = v.norm(normal);
  let u;
  if (Math.abs(n[2]) > 0.999) u = [1, 0, 0];
  else u = v.norm(v.cross([0, 0, 1], n));
  if (v.len(u) < 1e-9) u = v.norm(v.cross([1, 0, 0], n));
  const w = v.cross(n, u);
  return { center, radius: r, u, w };
}

export function evalCircle(center, normal, r, t) {
  const f = circleFrame(center, normal, r);
  const th = 2 * Math.PI * t;
  return v.add(f.center, v.add(v.scale(f.u, r * Math.cos(th)), v.scale(f.w, r * Math.sin(th))));
}

// Bezier:de Casteljau
export function evalBezier(poles, t) {
  let pts = poles.map((p) => [...p]);
  while (pts.length > 1) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i += 1) next.push(v.add(v.scale(pts[i], 1 - t), v.scale(pts[i + 1], t)));
    pts = next;
  }
  return pts[0];
}

// clamped uniform knot vector(與 Python _nurbs_edge 相同:nk = n−deg+1 個 knot 值 i/(nk−1),
// 兩端重數 deg+1、內部 1)
export function clampedUniformKnots(n, deg) {
  const nk = n - deg + 1;
  const U = [];
  for (let i = 0; i < nk; i += 1) {
    const val = nk === 1 ? 0 : i / (nk - 1);
    const mult = i === 0 || i === nk - 1 ? deg + 1 : 1;
    for (let m = 0; m < mult; m += 1) U.push(val);
  }
  return U;
}

// NURBS:齊次座標 de Boor
export function evalNurbs(poles, degree, weights, t) {
  const n = poles.length;
  const deg = Math.max(1, Math.min(degree, n - 1));
  const U = clampedUniformKnots(n, deg);
  const w = weights && weights.length === n ? weights : poles.map(() => 1);
  const u = Math.min(Math.max(t, 0), 1);
  // span:U[k] ≤ u < U[k+1],k∈[deg, n−1];u=1 → n−1
  let k = n - 1;
  if (u < 1) {
    k = deg;
    while (k < n - 1 && !(u >= U[k] && u < U[k + 1])) k += 1;
  }
  const d = [];
  for (let j = 0; j <= deg; j += 1) {
    const i = k - deg + j;
    d.push([poles[i][0] * w[i], poles[i][1] * w[i], poles[i][2] * w[i], w[i]]);
  }
  for (let r = 1; r <= deg; r += 1) {
    for (let j = deg; j >= r; j -= 1) {
      const i = k - deg + j;
      const den = U[i + deg - r + 1] - U[i];
      const alpha = den > 1e-15 ? (u - U[i]) / den : 0;
      d[j] = d[j].map((x, q) => (1 - alpha) * d[j - 1][q] + alpha * x);
    }
  }
  const [x, y, z, ww] = d[deg];
  return [x / ww, y / ww, z / ww];
}

// 插值樣條近似:Catmull-Rom(uniform),closed 時首尾相接;tangents 不用(預覽層)
export function evalCatmullRom(points, t, closed = false) {
  const n = points.length;
  if (n === 1) return [...points[0]];
  const segs = closed ? n : n - 1;
  const s = Math.min(Math.max(t, 0), 1) * segs;
  const i = Math.min(Math.floor(s), segs - 1);
  const f = s - i;
  const P = (idx) => points[closed ? ((idx % n) + n) % n : Math.min(Math.max(idx, 0), n - 1)];
  const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
  const f2 = f * f, f3 = f2 * f;
  return [0, 1, 2].map((q) => 0.5 * (2 * p1[q] + (-p0[q] + p2[q]) * f + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * f2 + (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * f3));
}

// 單點求值(t∈[0,1])→ {p, approx}
export function evalCurve(curve, t) {
  switch (curve?.kind) {
    case "line": return { p: evalLine(curve.points, t), approx: false };
    case "arc3": return { p: evalArc3(curve.points, t), approx: false };
    case "circle": return { p: evalCircle(curve.center, curve.normal, curve.r, t), approx: false };
    case "bezier": return { p: evalBezier(curve.poles, t), approx: false };
    case "nurbs": return { p: evalNurbs(curve.poles, curve.degree, curve.weights, t), approx: false };
    case "spline": return { p: evalCatmullRom(curve.points, t, !!curve.closed), approx: true };
    default: return null;
  }
}

// 均勻參數取樣 n 點 → {pts, approx};壞曲線回 null
export function sampleCurve(curve, n = 32) {
  const m = Math.max(2, n | 0);
  const pts = [];
  let approx = false;
  for (let i = 0; i < m; i += 1) {
    const r = evalCurve(curve, i / (m - 1));
    if (!r || !r.p.every(Number.isFinite)) return null;
    pts.push(r.p.map((x) => Math.round(x * 1e6) / 1e6));
    approx = approx || r.approx;
  }
  return { pts, approx };
}

// 草稿裡「可拖曳的點」:spline/line/arc3 的 points、bezier/nurbs 的 poles;circle 無(數值編輯)
export function editablePoints(curve) {
  if (!curve) return [];
  if (curve.kind === "circle") return [];
  const arr = curve.kind === "bezier" || curve.kind === "nurbs" ? curve.poles : curve.points;
  return Array.isArray(arr) ? arr : [];
}

export function withEditablePoint(curve, index, point) {
  const key = curve.kind === "bezier" || curve.kind === "nurbs" ? "poles" : "points";
  const arr = (curve[key] || []).map((p, i) => (i === index ? point.map(Number) : [...p]));
  return { ...curve, [key]: arr };
}
