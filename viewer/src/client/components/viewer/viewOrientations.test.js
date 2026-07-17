import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closestViewOrientationId,
  VIEW_ORIENTATION_PRESET_BY_ID,
  VIEW_ORIENTATION_PRESETS,
  viewOrientationPresetForDirection
} from "./viewOrientations.js";

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

test("view orientation presets cover six faces, twelve edges, and eight corners", () => {
  assert.equal(VIEW_ORIENTATION_PRESETS.length, 26);
  assert.equal(new Set(VIEW_ORIENTATION_PRESETS.map((preset) => preset.id)).size, 26);
  assert.deepEqual(
    Object.fromEntries(["face", "edge", "corner"].map((category) => [
      category,
      VIEW_ORIENTATION_PRESETS.filter((preset) => preset.category === category).length
    ])),
    { face: 6, edge: 12, corner: 8 }
  );
  for (const legacyId of ["x", "xNeg", "y", "yNeg", "z", "zNeg"]) {
    assert.ok(VIEW_ORIENTATION_PRESET_BY_ID[legacyId]);
  }
});

test("view orientation up vectors are finite, normalized, and perpendicular", () => {
  for (const preset of VIEW_ORIENTATION_PRESETS) {
    assert.ok(preset.direction.every(Number.isFinite), preset.id);
    assert.ok(preset.up.every(Number.isFinite), preset.id);
    assert.ok(Math.abs(Math.hypot(...preset.up) - 1) < 1e-9, preset.id);
    const directionLength = Math.hypot(...preset.direction);
    const normalizedDirection = preset.direction.map((value) => value / directionLength);
    assert.ok(Math.abs(dot(normalizedDirection, preset.up)) < 1e-9, preset.id);
  }
});

test("view orientation lookup resolves exact zones and nearby active cameras", () => {
  assert.equal(viewOrientationPresetForDirection([8, -2, 0])?.id, "x-yNeg");
  assert.equal(viewOrientationPresetForDirection([-1, 3, -9])?.category, "corner");
  assert.equal(viewOrientationPresetForDirection([0, 0, 0]), null);
  assert.equal(closestViewOrientationId([1, 0.01, 0]), "x");
  assert.equal(closestViewOrientationId([1, -1, 1]), "x-yNeg-z");
  assert.equal(closestViewOrientationId([1, 0.4, 0], VIEW_ORIENTATION_PRESETS, 0.999), "");
  // Custom preset lists must not be affected by the default-list normalize cache.
  assert.equal(closestViewOrientationId([0, 1, 0], [{ id: "custom", direction: [0, 2, 0] }]), "custom");
});
