// 草稿 → 3D 工作窗的 live 層資料(純函數,零 three):每條曲線取樣折線(精確/近似)、
// 可拖曳把手(editablePoints)、symmetry 的鏡射複本(淡顯示,不可拖)、把手半徑(依草稿尺度)。
// useCadViewport.setDraftHandles 吃這個結構畫線與球;Canvas3D 以 useMemo 餵。
import { editablePoints, sampleCurve } from "../surface/nurbsEval.js";

export const DRAFT_SAMPLES = 48;
const MIRROR_AXIS = { XY: 2, XZ: 1, YZ: 0 };

export function mirrorPoint(p, plane) {
  const ax = MIRROR_AXIS[plane];
  if (ax === undefined) return [...p];
  return p.map((x, i) => (i === ax ? -x : x));
}

// 所有可拖點 + 圓(中心±r)的包圍盒;空草稿回 null
export function draftBounds(draft) {
  let min = null;
  let max = null;
  const take = (p) => {
    if (!min) {
      min = [...p];
      max = [...p];
      return;
    }
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  };
  for (const c of draft?.curves || []) {
    for (const p of editablePoints(c)) take(p);
    if (c.kind === "circle" && Array.isArray(c.center)) {
      const r = Number(c.r) || 0;
      take(c.center.map((x) => x - r));
      take(c.center.map((x) => x + r));
    }
  }
  if (!min) return null;
  return { min, max, extent: max.map((x, i) => x - min[i]) };
}

// 把手球半徑:草稿最大邊長的 1.2%,夾在 [0.3, 6]
export function handleRadius(draft) {
  const b = draftBounds(draft);
  const ext = b ? Math.max(...b.extent) : 0;
  return Math.min(6, Math.max(0.3, ext * 0.012));
}

export function buildDraftView(draft, selectedId = null, { samples = DRAFT_SAMPLES } = {}) {
  if (!draft || !Array.isArray(draft.curves)) return null;
  const curves = [];
  const handles = [];
  const sym = draft.symmetry || null;
  for (const c of draft.curves) {
    const s = sampleCurve(c, samples);
    const selected = c.id === selectedId;
    if (s) {
      curves.push({ id: c.id, pts: s.pts, approx: s.approx, selected, mirror: false, closed: !!c.closed });
      if (sym) curves.push({ id: c.id, pts: s.pts.map((p) => mirrorPoint(p, sym)), approx: s.approx, selected: false, mirror: true, closed: !!c.closed });
    }
    editablePoints(c).forEach((p, index) => {
      handles.push({ curveId: c.id, index, p: [...p], plane: c.plane || null, selected });
    });
  }
  return { curves, handles, radius: handleRadius(draft), bounds: draftBounds(draft), symmetry: sym };
}
