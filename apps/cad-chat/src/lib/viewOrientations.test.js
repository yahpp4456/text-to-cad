import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNormalToFaceView,
  closestViewOrientationId,
  DEFAULT_VIEW_DIRECTION,
  normalToFaceAvailability,
  VIEW_ORIENTATION_PRESET_BY_ID,
  VIEW_ORIENTATION_PRESETS,
  viewOrientationPresetForDirection,
} from "./viewOrientations.js";

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

test("視角預設完整覆蓋六面、十二稜與八角", () => {
  assert.equal(VIEW_ORIENTATION_PRESETS.length, 26);
  assert.equal(new Set(VIEW_ORIENTATION_PRESETS.map((preset) => preset.id)).size, 26);
  assert.deepEqual(
    Object.fromEntries(["face", "edge", "corner"].map((category) => [
      category,
      VIEW_ORIENTATION_PRESETS.filter((preset) => preset.category === category).length,
    ])),
    { face: 6, edge: 12, corner: 8 },
  );
  for (const id of ["x", "xNeg", "y", "yNeg", "z", "zNeg"]) {
    assert.ok(VIEW_ORIENTATION_PRESET_BY_ID[id]);
  }
});

test("每個預設的 up 向量皆為有限、單位且垂直於視線", () => {
  for (const preset of VIEW_ORIENTATION_PRESETS) {
    assert.ok(preset.up.every(Number.isFinite), preset.id);
    assert.ok(Math.abs(Math.hypot(...preset.up) - 1) < 1e-9, preset.id);
    const directionLength = Math.hypot(...preset.direction);
    const direction = preset.direction.map((value) => value / directionLength);
    assert.ok(Math.abs(dot(direction, preset.up)) < 1e-9, preset.id);
  }
});

test("視角 lookup 能解析面、稜、角與目前相機方向", () => {
  assert.equal(viewOrientationPresetForDirection([8, -2, 0])?.id, "x-yNeg");
  assert.equal(viewOrientationPresetForDirection([-1, 3, -9])?.category, "corner");
  assert.equal(viewOrientationPresetForDirection([0, 0, 0]), null);
  assert.equal(closestViewOrientationId([1, 0.01, 0]), "x");
  assert.equal(closestViewOrientationId([1, -1, 1]), "x-yNeg-z");
  // 自訂 presets 參數不得被預 normalize 快取(只給預設清單用)影響
  assert.equal(closestViewOrientationId([0, 1, 0], [{ id: "custom", direction: [0, 2, 0] }]), "custom");
});

test("預設視圖方向離所有 preset 夠遠,不誤標角落 active", () => {
  // [1,-1,0.8] 舊值與角落 [1,-1,1] 的 dot≈0.9949 會過 0.985 閾值,預設視圖
  // 永遠高亮 x-yNeg-z;現值與 viewer 一致(dot≈0.968)。
  assert.equal(closestViewOrientationId(DEFAULT_VIEW_DIRECTION), "");
});

test("正視於只接受資料完整的平面", () => {
  assert.deepEqual(normalToFaceAvailability({
    surfaceType: "cylinder",
    center: [0, 0, 0],
    normal: [1, 0, 0],
  }), {
    available: false,
    reason: "僅平面可使用正視於",
  });
  assert.deepEqual(normalToFaceAvailability({
    surfaceType: "PLANE_SURFACE",
    center: [0, 0, 0],
    normal: [0, 0, 1],
  }), {
    available: true,
    reason: "",
  });
});

test("正視於的 up 近平行視向時跳過該候選,不 normalize 浮點噪聲", () => {
  // 前次轉場殘留的 camera.up ≈ +Z 微偏:投影殘差 ~1e-7,舊實作 normalize 成
  // [1,0,0] 造成噪聲決定的 90° 滾轉;應跳過改用穩定的 [0,1,0]。
  const view = buildNormalToFaceView({
    surfaceType: "plane",
    center: [0, 0, 0],
    normal: [0, 0, 1],
  }, {
    cameraDirection: [0, 0, 1],
    cameraUp: [1e-3, 0, 1],
  });
  assert.deepEqual(view.up, [0, 1, 0]);
});

test("正視於保持相機所在側並投影出穩定的 up", () => {
  const view = buildNormalToFaceView({
    surfaceType: "plane",
    center: [4, 5, 6],
    normal: [0, 0, 2],
    bbox: { min: [2, 3, 6], max: [6, 7, 6] },
  }, {
    cameraDirection: [0, 0, -4],
    cameraUp: [0, 0, 1],
  });
  assert.deepEqual(view, {
    center: [4, 5, 6],
    direction: [0, 0, -1],
    up: [0, 1, 0],
    bounds: { min: [2, 3, 6], max: [6, 7, 6] },
  });
});
