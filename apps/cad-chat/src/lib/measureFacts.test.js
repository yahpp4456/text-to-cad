// 防漂移測試:前端 measureFacts 的結果必須逐位等於後端 inspect measure CLI(第二計算源紀律)。
// 真 pickData 取自 motorized_linear_stage 的 runtime.faceReferenceByRowIndex(dbg 抓,含 -0);
// golden 取自 `inspect measure <v1.step> --from --to`(座標系一致已驗證)。
// 動 cadpy.analysis 的 positioning 數學(或 inspect.measure_targets)時,這裡的 golden 要一起更新。
import assert from "node:assert/strict";
import { test } from "node:test";

import { facePositioningFacts, measureBetween } from "./measureFacts.js";

// 真面 pickData(世界座標,與後端 manifest row 同座標系)
const F1 = { center: [-64, 0, 5], normal: [-1, -0, -0], surfaceType: "plane", params: { origin: [-64, -50, 0], axis: [1, 0, 0] } };
const F2 = { center: [256, 0, 5], normal: [1, 0, 0], surfaceType: "plane", params: { origin: [256, -50, 0], axis: [1, 0, 0] } };
const F3 = { center: [96, -50, 5], normal: [-0, -1, -0], surfaceType: "plane", params: { origin: [-64, -50, 0], axis: [0, 1, 0] } };
const CYL = { center: [7, -0, 43.95], normal: null, surfaceType: "cylinder", params: { origin: [-1, 0, 43.95], axis: [1, 0, 0], radius: 23.8 } };

test("平行相對面沿法向 = 後端 golden 320/x/opposed", () => {
  const r = measureBetween(F1, F2);
  assert.equal(r.ok, true);
  assert.equal(r.axis, "x");
  assert.equal(r.signedDistance, 320);
  assert.equal(r.absoluteDistance, 320);
  assert.ok(Math.abs(r.euclideanDistance - 320) < 1e-9);
  assert.equal(r.vectorRelationship.relation, "opposed");
});

test("垂直面(x-normal vs y-normal)= 後端 golden 0/x/perpendicular", () => {
  const r = measureBetween(F1, F3);
  assert.equal(r.ok, true);
  assert.equal(r.axis, "x"); // infer 第二階段取第一個對齊軸(f1=x)
  assert.equal(r.signedDistance, 0);
  assert.ok(Math.abs(r.euclideanDistance - 0) < 1e-9);
  assert.equal(r.vectorRelationship.relation, "perpendicular");
});

test("圓柱→平面(cylinder normal 退回 params.axis)= 後端 golden -63/x/opposed/euclid 91.65", () => {
  const r = measureBetween(CYL, F1);
  assert.equal(r.ok, true);
  assert.equal(r.axis, "x");
  assert.equal(r.signedDistance, -63);
  assert.equal(r.absoluteDistance, 63);
  assert.ok(Math.abs(r.euclideanDistance - 91.65480074715127) < 1e-9);
  assert.equal(r.vectorRelationship.relation, "opposed");
});

test("axisOverride(軸 fallback)生效:f1→f2 沿 y = 0(兩面 y 相同)", () => {
  const r = measureBetween(F1, F2, "y");
  assert.equal(r.ok, true);
  assert.equal(r.axis, "y");
  assert.equal(r.signedDistance, 0);
});

test("非軸對齊兩面 → needAxis(前端露出 x/y/z chip)", () => {
  const skew = { center: [0, 0, 0], normal: [0.577, 0.577, 0.577], surfaceType: "plane", params: { origin: [0, 0, 0] } };
  const skew2 = { center: [1, 1, 1], normal: [0.577, -0.577, 0.577], surfaceType: "plane", params: { origin: [1, 1, 1] } };
  const r = measureBetween(skew, skew2);
  assert.equal(r.ok, false);
  assert.equal(r.needAxis, true);
});

test("缺 pickData → 明確錯誤(不 throw)", () => {
  assert.equal(measureBetween(null, F1).ok, false);
  assert.equal(measureBetween(F1, undefined).ok, false);
});

test("facePositioningFacts:對齊軸平面 → axis+coordinate+對齊旗標", () => {
  const f = facePositioningFacts(F1);
  assert.equal(f.axis, "x");
  assert.equal(f.coordinate, -64);
  assert.equal(f.axisAlignment.aligned, true);
  assert.equal(f.kind, "plane");
});

test("facePositioningFacts:圓柱用 params.axis 當方向 + axisVector", () => {
  const f = facePositioningFacts(CYL);
  assert.deepEqual(f.normal, [1, 0, 0]); // 退回 params.axis
  assert.deepEqual(f.axisVector, [1, 0, 0]);
  assert.equal(f.radius, 23.8);
  assert.equal(f.axis, "x");
});
