// sweepView 純函數單元測(node --test):live 取樣對 python path_polyline 的
// golden 逐位鎖(防前後端取樣漂移——漂了套用瞬間 2D 圖會跳動)。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fitViewBox,
  loopsToPathD,
  polylineToPathD,
  projectPathTo2D,
  sampleDragChain,
  sampleLine,
} from "./sweepView.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("sampleDragChain:golden 對 python path_polyline 逐位(96 點等弧長)", () => {
  const pts = sampleDragChain({ straight_a: 300, bend_r: 80, straight_b: 300 }, 96);
  assert.equal(pts.length, 96);
  // golden 由 .venv python path_polyline(U, 96) 現算((d,e) = (−y, z))
  const golden = {
    0: [0, 0],
    10: [89.61341182, 0],
    33: [295.724259005, 0],
    47: [379.874555242, 75.52167164],
    60: [313.580850291, 158.838826129],
    95: [0, 160],
  };
  for (const [i, [d, e]] of Object.entries(golden)) {
    assert.ok(near(pts[i][0], d) && near(pts[i][1], e), `i=${i}: ${pts[i]} != [${d},${e}]`);
  }
  // 弧段幾何:i=47 距圓心 (300,80) == 80
  assert.ok(near(Math.hypot(pts[47][0] - 300, pts[47][1] - 80), 80));
  // 等弧長:相鄰弦長 max/min < 1.05(直段等距、弧段弦略短)
  const chords = [];
  for (let i = 1; i < pts.length; i += 1) {
    chords.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  assert.ok(Math.max(...chords) / Math.min(...chords) < 1.05);
});

test("sampleLine:等分取樣", () => {
  assert.deepEqual(sampleLine({ length: 120 }, 4), [[0, 0], [40, 0], [80, 0], [120, 0]]);
});

test("非法輸入回 null(live 層隱藏)", () => {
  assert.equal(sampleDragChain({ straight_a: 300, bend_r: 0, straight_b: 300 }), null);
  assert.equal(sampleDragChain({ straight_a: NaN, bend_r: 80, straight_b: 300 }), null);
  assert.equal(sampleDragChain({ straight_a: 300, bend_r: 80, straight_b: 300 }, 1), null);
  assert.equal(sampleLine({ length: -5 }), null);
});

test("projectPathTo2D:世界 (0,−d,e) 反演;壞點整條回 []", () => {
  const de = projectPathTo2D([[0, -89.61341182, 0]]);
  assert.ok(near(de[0][0], 89.61341182, 1e-9) && near(de[0][1], 0, 1e-9));
  assert.deepEqual(projectPathTo2D([[0, 0, 0], [1, 2]]), []);
  assert.deepEqual(projectPathTo2D([[0, 0, NaN]]), []);
  assert.deepEqual(projectPathTo2D("x"), []);
});

test("polylineToPathD / loopsToPathD:SVG y 取負、閉合 Z", () => {
  assert.equal(polylineToPathD([[0, 0], [10, 5]]), "M 0 0 L 10 -5");
  assert.equal(loopsToPathD([[[0, 0], [10, 0], [10, 5]]]), "M 0 0 L 10 0 L 10 -5 Z");
  assert.equal(polylineToPathD([[0, 0]]), "");
  assert.equal(loopsToPathD("x"), "");
});

test("fitViewBox:聯集邊界 + padRatio;空輸入回單位框", () => {
  assert.equal(fitViewBox([[[0, 0], [100, 160]]], 0.08), "-12.8 -172.8 125.6 185.6");
  assert.equal(fitViewBox([]), "0 0 1 1");
});
