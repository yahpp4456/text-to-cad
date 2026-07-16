// sweepOverlay 純函數單元測(node --test,零 three):sidecar paths → 線段平陣列。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSweepSegments } from "./sweepOverlay.js";

test("buildSweepSegments:相鄰點成對展開 + 起終點 + label", () => {
  const out = buildSweepSegments([
    { label: "sleeve_path", points: [[0, 0, 0], [0, 0, 10], [0, 5, 10]] },
  ]);
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.label, "sleeve_path");
  assert.equal(p.pointCount, 3);
  // 2 段 × 每段 6 值:AB、BC(B 重複出現 = LineSegments 成對語意)
  assert.deepEqual(p.segments, [0, 0, 0, 0, 0, 10, 0, 0, 10, 0, 5, 10]);
  assert.deepEqual(p.start, [0, 0, 0]);
  assert.deepEqual(p.end, [0, 5, 10]);
});

test("buildSweepSegments:壞路徑整條丟棄(單點壞不畫半條線)、label 預設", () => {
  const out = buildSweepSegments([
    "not-a-dict",
    { points: [[0, 0, 0]] }, // 少於 2 點
    { points: [[0, 0, 0], [1, 2]] }, // 2 維點
    { points: [[0, 0, 0], [0, 0, NaN]] }, // 非有限數
    { points: [[0, 0, 0], [0, 0, 9]] }, // 唯一合法(無 label → path_N)
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "path_0");
});

test("buildSweepSegments:非陣列輸入 → 空(overlay 靜默不建)", () => {
  assert.deepEqual(buildSweepSegments(null), []);
  assert.deepEqual(buildSweepSegments(undefined), []);
  assert.deepEqual(buildSweepSegments("x"), []);
});
