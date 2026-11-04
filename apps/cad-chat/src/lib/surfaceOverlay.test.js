import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCageLines,
  buildCombLines,
  buildContinuityLines,
  buildFreeEdgeLines,
  buildSurfaceOverlay,
  CAGE_COLOR,
  FREE_EDGE_COLOR,
  GRADE_COLORS,
} from "./surfaceOverlay.js";

const SIDECAR = {
  schemaVersion: 1,
  edges: [
    { i: 1, grade: "G2", g1Deg: 0, g2Rel: 0, flat: false, pts: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
    { i: 2, grade: "G0", g1Deg: 90, g2Rel: 0, flat: true, pts: [[0, 1, 0], [1, 1, 0]] },
    { i: 3, grade: "G1", pts: [[0, 0, 0], ["x", 0, 0]] }, // 壞點 → 整條丟
    { i: 4, grade: "weird", pts: [[0, 0, 0], [0, 0, 1]] }, // 未知等級 → G0
  ],
  finalEdges: [{ i: 7, grade: "G1", pts: [[5, 5, 5], [6, 5, 5]] }],
  freeEdges: [{ i: 9, pts: [[0, 0, 0], [0, 9, 0]] }, { i: 10, pts: [[0, 0, 0]] }],
  cages: [
    { face: 1, nu: 2, nv: 3, rows: [[[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 1, 0], [1, 1, 0], [2, 1, 0]]] },
    { face: 2, rows: [[[0, 0, 0], [1, 0, 0]], [[0, 1, 0]]] }, // 行長不一 → 丟
  ],
  combs: [{ curve: "c1", scale: 1, segs: [[[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 2]], [[2, 0, 0], ["bad", 0, 0]]] }],
  curves: [{ id: "c1", pts: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }],
  summary: { ok: true, g2: 1 },
};

test("continuity:等級配色、平面鄰邊灰、壞點整條丟、未知等級退 G0、finalEdges 併入", () => {
  const rows = buildContinuityLines(SIDECAR);
  assert.deepEqual(rows.map((r) => r.key), ["edges:1", "edges:2", "edges:4", "finalEdges:7"]);
  assert.equal(rows[0].color, GRADE_COLORS.G2);
  assert.equal(rows[0].segments.length, 12);
  assert.equal(rows[1].color, GRADE_COLORS.flat);
  assert.equal(rows[1].flat, true);
  assert.equal(rows[2].grade, "G0");
  assert.equal(rows[3].color, GRADE_COLORS.G1);
});

test("freeEdges / cages / combs:線段展開與防禦", () => {
  const free = buildFreeEdgeLines(SIDECAR);
  assert.equal(free.length, 1);
  assert.equal(free[0].color, FREE_EDGE_COLOR);
  const cages = buildCageLines(SIDECAR);
  assert.equal(cages.length, 1);
  // 2×3 網:列線 2×2=4 段、行線 3×1=3 段 → 7 段 × 6 數
  assert.equal(cages[0].segments.length, 7 * 6);
  assert.equal(cages[0].poles.length, 6);
  assert.equal(cages[0].color, CAGE_COLOR);
  const combs = buildCombLines(SIDECAR);
  assert.equal(combs.length, 1);
  assert.equal(combs[0].segments.length, 2 * 6, "壞梳丟棄");
  assert.equal(combs[0].tipSegments.length, 6, "兩個梳尖一段");
});

test("buildSurfaceOverlay:schemaVersion 不符/空 → null;否則五群組 + summary", () => {
  assert.equal(buildSurfaceOverlay(null), null);
  assert.equal(buildSurfaceOverlay({ schemaVersion: 2 }), null);
  const o = buildSurfaceOverlay(SIDECAR);
  assert.deepEqual(Object.keys(o), ["continuity", "freeEdges", "cages", "combs", "curves", "summary"]);
  assert.equal(o.curves.length, 1);
  assert.deepEqual(o.summary, { ok: true, g2: 1 });
  const empty = buildSurfaceOverlay({ schemaVersion: 1 });
  assert.equal(empty.continuity.length + empty.freeEdges.length + empty.cages.length + empty.combs.length, 0);
});
