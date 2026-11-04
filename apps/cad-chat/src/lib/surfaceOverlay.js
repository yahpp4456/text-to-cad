// 曲面分析 overlay 的純資料轉換(零 three 依賴 → node --test 可直測)。
// 輸入:`.{name}.surface.json` sidecar(cadpy.surface.harvest_meta 收割,伺服端已防禦正規化);
// 輸出:每個 overlay 群組的「線段座標平陣列」(直接餵 BufferGeometry position)+ 顏色。
// 防禦與收割同語義:任一點壞 = 整條丟棄,點數 < 2 丟棄。
export const GRADE_COLORS = Object.freeze({ G0: 0xd64848, G1: 0xe0b020, G2: 0x34ab86, flat: 0x8a93a3 });
export const FREE_EDGE_COLOR = 0xff2bd6;
export const CAGE_COLOR = 0x9aa7ff;
export const COMB_COLOR = 0x18a0c4;
export const CURVE_COLOR = 0xffb347;

const good3 = (q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite);

function polylineSegments(pts) {
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every(good3)) return null;
  const segments = new Array((pts.length - 1) * 6);
  for (let i = 0; i < pts.length - 1; i += 1) {
    segments[i * 6 + 0] = pts[i][0];
    segments[i * 6 + 1] = pts[i][1];
    segments[i * 6 + 2] = pts[i][2];
    segments[i * 6 + 3] = pts[i + 1][0];
    segments[i * 6 + 4] = pts[i + 1][1];
    segments[i * 6 + 5] = pts[i + 1][2];
  }
  return segments;
}

// 連續性著色:設計殼內邊(edges)+ 最終形狀邊(finalEdges;融合/圓角後才有)。平面鄰邊
//(端蓋/底板,刻意銳邊)用灰色,不用紅——紅只留給真正的設計面摺線。
export function buildContinuityLines(sidecar) {
  const out = [];
  for (const key of ["edges", "finalEdges"]) {
    for (const e of Array.isArray(sidecar?.[key]) ? sidecar[key] : []) {
      const segments = polylineSegments(e?.pts);
      if (!segments) continue;
      const grade = ["G0", "G1", "G2"].includes(e.grade) ? e.grade : "G0";
      out.push({
        key: `${key}:${e.i}`,
        grade,
        flat: !!e.flat,
        color: e.flat ? GRADE_COLORS.flat : GRADE_COLORS[grade],
        segments,
      });
    }
  }
  return out;
}

export function buildFreeEdgeLines(sidecar) {
  const out = [];
  for (const e of Array.isArray(sidecar?.freeEdges) ? sidecar.freeEdges : []) {
    const segments = polylineSegments(e?.pts);
    if (segments) out.push({ key: `free:${e.i}`, color: FREE_EDGE_COLOR, segments });
  }
  return out;
}

// 控制點籠:極點網的列線 + 行線(rows[i][j] 為 [x,y,z]),外加極點座標(小球用)。
export function buildCageLines(sidecar) {
  const out = [];
  for (const c of Array.isArray(sidecar?.cages) ? sidecar.cages : []) {
    const rows = Array.isArray(c?.rows) ? c.rows : [];
    if (!rows.length || !rows.every((r) => Array.isArray(r) && r.length && r.every(good3))) continue;
    const nv = rows[0].length;
    if (!rows.every((r) => r.length === nv)) continue;
    const segments = [];
    const push = (a, b) => segments.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    for (const r of rows) for (let j = 0; j < nv - 1; j += 1) push(r[j], r[j + 1]);
    for (let j = 0; j < nv; j += 1) for (let i = 0; i < rows.length - 1; i += 1) push(rows[i][j], rows[i + 1][j]);
    out.push({ key: `cage:${c.face}`, face: c.face, color: CAGE_COLOR, segments, poles: rows.flat(), nu: rows.length, nv });
  }
  return out;
}

// 曲率梳:segs = [[p, q], …](q = p + scale·k·n;已在收割時算好長度)
export function buildCombLines(sidecar) {
  const out = [];
  for (const c of Array.isArray(sidecar?.combs) ? sidecar.combs : []) {
    const segs = Array.isArray(c?.segs) ? c.segs : [];
    const segments = [];
    for (const s of segs) {
      if (!Array.isArray(s) || s.length !== 2 || !good3(s[0]) || !good3(s[1])) continue;
      segments.push(...s[0], ...s[1]);
    }
    // 梳尖連線(把每根梳的尖端串起來,視覺上才看得出曲率分布)
    const tips = segs.filter((s) => Array.isArray(s) && s.length === 2 && good3(s[1])).map((s) => s[1]);
    const tipSeg = polylineSegments(tips) || [];
    if (segments.length) out.push({ key: `comb:${c.curve}`, curve: c.curve, color: COMB_COLOR, segments, tipSegments: tipSeg });
  }
  return out;
}

export function buildCurveLines(sidecar) {
  const out = [];
  for (const c of Array.isArray(sidecar?.curves) ? sidecar.curves : []) {
    const segments = polylineSegments(c?.pts);
    if (segments) out.push({ key: `curve:${c.id}`, id: c.id, color: CURVE_COLOR, segments });
  }
  return out;
}

// 一次建全部(Canvas3D useMemo 用);sidecar 空/壞 → null(不建 overlay)。
export function buildSurfaceOverlay(sidecar) {
  if (!sidecar || typeof sidecar !== "object" || sidecar.schemaVersion !== 1) return null;
  return {
    continuity: buildContinuityLines(sidecar),
    freeEdges: buildFreeEdgeLines(sidecar),
    cages: buildCageLines(sidecar),
    combs: buildCombLines(sidecar),
    curves: buildCurveLines(sidecar),
    summary: sidecar.summary || null,
  };
}
