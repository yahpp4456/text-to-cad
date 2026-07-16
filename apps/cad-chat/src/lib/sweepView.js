// 掃出工作窗的 2D 純函數層(零 three 零 React → node --test 直測)。
// live 路徑取樣**逐式鏡射** cadpy parts/sweep.py 的 _resolve_path drag_chain
// 分支 + _seg_point 等弧長取樣(同 96 點)——套用後 baked(sidecar)與 live
// 才會逐點重合,不跳動;golden 測試對 python path_polyline 現算值釘死。

function finitePos(v) {
  return Number.isFinite(v) && v > 0;
}

function segLength(seg) {
  if (seg.kind === "line") {
    return Math.hypot(seg.p1[0] - seg.p0[0], seg.p1[1] - seg.p0[1]);
  }
  return Math.abs(seg.a1 - seg.a0) * seg.r;
}

function segPoint(seg, s) {
  if (seg.kind === "line") {
    const L = segLength(seg);
    const t = L < 1e-12 ? 0 : s / L;
    return [seg.p0[0] + (seg.p1[0] - seg.p0[0]) * t, seg.p0[1] + (seg.p1[1] - seg.p0[1]) * t];
  }
  const dir = seg.a1 > seg.a0 ? 1 : -1; // copysign(s/r, a1-a0)
  const a = seg.a0 + dir * (s / seg.r);
  return [seg.c[0] + seg.r * Math.cos(a), seg.c[1] + seg.r * Math.sin(a)];
}

function samplePath(segs, samples) {
  if (!Number.isInteger(samples) || samples < 2) return null;
  const lens = segs.map(segLength);
  const total = lens.reduce((a, b) => a + b, 0);
  const pts = [];
  for (let i = 0; i < samples; i += 1) {
    let s = (total * i) / (samples - 1);
    let p = null;
    for (let j = 0; j < segs.length; j += 1) {
      if (s <= lens[j] + 1e-9) {
        p = segPoint(segs[j], Math.min(s, lens[j]));
        break;
      }
      s -= lens[j];
    }
    pts.push(p || segPoint(segs[segs.length - 1], lens[lens.length - 1]));
  }
  return pts;
}

// 拖鏈 U 形:線 (0,0)→(sa,0)、180° 弧(圓心 (sa,r),−π/2→+π/2)、線 →(sa−sb,2r)。
// 任一值非法回 null(live 層直接隱藏,不畫垃圾)。
export function sampleDragChain(vals, samples = 96) {
  const sa = Number(vals?.straight_a);
  const r = Number(vals?.bend_r);
  const sb = Number(vals?.straight_b);
  if (!finitePos(sa) || !finitePos(r) || !finitePos(sb)) return null;
  const segs = [
    { kind: "line", p0: [0, 0], p1: [sa, 0] },
    { kind: "arc", c: [sa, r], r, a0: -Math.PI / 2, a1: Math.PI / 2 },
    { kind: "line", p0: [sa, 2 * r], p1: [sa - sb, 2 * r] },
  ];
  return samplePath(segs, samples);
}

export function sampleLine(vals, samples = 96) {
  const len = Number(vals?.length);
  if (!finitePos(len)) return null;
  return samplePath([{ kind: "line", p0: [0, 0], p1: [len, 0] }], samples);
}

// 世界點 [x,y,z] → 路徑平面 (d,e) = (−y, z)(世界姿態 (d,e)→(0,−d,e) 的反演;
// x 丟棄——generator 自訂 at 時是近似,display-only)。壞點整條回 []。
export function projectPathTo2D(points3D) {
  if (!Array.isArray(points3D)) return [];
  const out = [];
  for (const p of points3D) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return [];
    out.push([-p[1], p[2]]);
  }
  return out;
}

function fmt(v, decimals) {
  return String(Number(v.toFixed(decimals)));
}

// pts2D((d,e))→ SVG path d;SVG y 軸向下 → y 輸出取 −e。
export function polylineToPathD(pts2D, decimals = 3) {
  if (!Array.isArray(pts2D) || pts2D.length < 2) return "";
  const parts = pts2D.map(
    (p, i) => `${i === 0 ? "M" : "L"} ${fmt(p[0], decimals)} ${fmt(-p[1], decimals)}`,
  );
  return parts.join(" ");
}

// 多閉合迴圈 → 單一 d(每圈 M…Z;首點不重複)。配 fill-rule="evenodd" 鏤空內腔。
export function loopsToPathD(loops, decimals = 3) {
  if (!Array.isArray(loops)) return "";
  const out = [];
  for (const loop of loops) {
    if (!Array.isArray(loop) || loop.length < 2) continue;
    const parts = loop.map(
      (p, i) => `${i === 0 ? "M" : "L"} ${fmt(p[0], decimals)} ${fmt(-p[1], decimals)}`,
    );
    out.push(`${parts.join(" ")} Z`);
  }
  return out.join(" ");
}

// 多組 pts2D 的聯集邊界 → "x y w h"(SVG 座標;pad = max(w,h)*padRatio,零尺寸用 1)。
export function fitViewBox(ptsArrays, padRatio = 0.08) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pts of Array.isArray(ptsArrays) ? ptsArrays : []) {
    for (const p of Array.isArray(pts) ? pts : []) {
      const sx = p[0];
      const sy = -p[1];
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      x0 = Math.min(x0, sx);
      y0 = Math.min(y0, sy);
      x1 = Math.max(x1, sx);
      y1 = Math.max(y1, sy);
    }
  }
  if (!Number.isFinite(x0)) return "0 0 1 1";
  const w = x1 - x0;
  const h = y1 - y0;
  const pad = Math.max(w, h, 1) * padRatio;
  const r3 = (v) => String(Number(v.toFixed(3)));
  return `${r3(x0 - pad)} ${r3(y0 - pad)} ${r3(w + 2 * pad)} ${r3(h + 2 * pad)}`;
}
