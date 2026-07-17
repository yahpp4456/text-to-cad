import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";

import {
  buildNormalToViewFromFace,
  centerFromBounds,
  closestOrientationId,
  createPresetDirectionLookup,
  createViewOrientationPresets,
  DEFAULT_VIEW_DIRECTION,
  directionSignsKey,
  dotVector3,
  easeInOutCubic,
  IDENTITY_ORIENTATION_AXES,
  normalizedPresetEntries,
  normalizeVector,
  orientationAxesChanged,
  orientationAxesFromQuaternion,
  projectedUpForDirection,
  VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD
} from "./viewOrientations.js";

const FACE_PRESETS = [
  { id: "z", label: "Z", name: "top", title: "top", direction: [0, 0, 1] },
  { id: "zNeg", label: "-Z", name: "bottom", title: "bottom", direction: [0, 0, -1] },
  { id: "yNeg", label: "-Y", name: "front", title: "front", direction: [0, -1, 0] },
  { id: "y", label: "Y", name: "back", title: "back", direction: [0, 1, 0] },
  { id: "x", label: "X", name: "right", title: "right", direction: [1, 0, 0] },
  { id: "xNeg", label: "-X", name: "left", title: "left", direction: [-1, 0, 0] }
];

function buildPresets() {
  return createViewOrientationPresets({
    facePresets: FACE_PRESETS,
    decoratePreset: (direction, { id, category }) => ({
      label: id,
      name: id,
      title: `${id} ${category}`
    })
  });
}

test("preset factory yields 6 faces, 12 edges and 8 corners in stable order", () => {
  const presets = buildPresets();
  assert.equal(presets.length, 26);
  assert.equal(new Set(presets.map((preset) => preset.id)).size, 26);
  assert.deepEqual(
    ["face", "edge", "corner"].map(
      (category) => presets.filter((preset) => preset.category === category).length
    ),
    [6, 12, 8]
  );
  // Faces first (app order), then edges, then corners — consumers snapshot ids.
  assert.deepEqual(presets.slice(0, 6).map((preset) => preset.id), FACE_PRESETS.map((preset) => preset.id));
  assert.equal(presets[6].category, "edge");
  assert.equal(presets[25].category, "corner");
});

test("every preset up is finite, unit-length and perpendicular to its direction", () => {
  for (const preset of buildPresets()) {
    assert.ok(preset.up.every(Number.isFinite), preset.id);
    assert.ok(Math.abs(Math.hypot(...preset.up) - 1) < 1e-9, preset.id);
    const direction = normalizeVector(preset.direction);
    assert.ok(Math.abs(dotVector3(direction, preset.up)) < 1e-9, preset.id);
  }
});

test("direction lookup and closest-orientation resolution", () => {
  const presets = buildPresets();
  const lookup = createPresetDirectionLookup(presets);
  assert.equal(lookup([8, -2, 0])?.id, "x-yNeg");
  assert.equal(lookup([-1, 3, -9])?.category, "corner");
  assert.equal(lookup([0, 0, 0]), null);

  const entries = normalizedPresetEntries(presets);
  assert.equal(closestOrientationId([1, 0.01, 0], entries, VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD), "x");
  assert.equal(closestOrientationId([1, -1, 1], entries, VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD), "x-yNeg-z");
  assert.equal(closestOrientationId([1, 0.4, 0], entries, 0.999), "");
  assert.equal(closestOrientationId(null, entries, 0.5), "");
});

test("default view direction stays clear of every preset zone", () => {
  // The old cad-chat default [1, -1, 0.8] scored dot ≈ 0.9949 against corner
  // [1, -1, 1] and was permanently mislabeled as that corner being active.
  const entries = normalizedPresetEntries(buildPresets());
  assert.equal(
    closestOrientationId(DEFAULT_VIEW_DIRECTION, entries, VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD),
    ""
  );
});

test("projectedUp skips near-parallel candidates instead of normalizing noise", () => {
  // A camera.up left ≈ +Z by a previous transition projects to a ~1e-7
  // residue; normalizing it rolled the view 90° at random before the guard.
  assert.deepEqual(projectedUpForDirection([0, 0, 1], [1e-3, 0, 1]), [0, 1, 0]);
  // Exact pole with the default preferred up also lands on the stable fallback.
  assert.deepEqual(projectedUpForDirection([0, 0, 1]), [0, 1, 0]);
  // A safely-oblique preferred up is projected, not replaced.
  const up = projectedUpForDirection([1, 0, 0], [0, 0.5, 0.5]);
  assert.ok(Math.abs(dotVector3(up, [1, 0, 0])) < 1e-9);
  assert.ok(up[1] > 0 && up[2] > 0);
});

test("normal-to core keeps the camera side and derives center from bounds", () => {
  const view = buildNormalToViewFromFace({
    center: [4, 5, 6],
    normal: [0, 0, 2],
    bounds: { min: [2, 3, 6], max: [6, 7, 6] },
    cameraDirection: [0, 0, -4],
    cameraUp: [0, 1, 0]
  });
  assert.deepEqual(view, {
    center: [4, 5, 6],
    direction: [0, 0, -1],
    up: [0, 1, 0],
    bounds: { min: [2, 3, 6], max: [6, 7, 6] }
  });
  assert.deepEqual(
    buildNormalToViewFromFace({ center: null, normal: [1, 0, 0], bounds: { min: [2, 4, 6], max: [8, 10, 12] } })?.center,
    [5, 7, 9]
  );
  assert.equal(buildNormalToViewFromFace({ center: [0, 0, 0], normal: null }), null);
  assert.deepEqual(centerFromBounds({ min: [0, 0, 0], max: [2, 2, 2] }), [1, 1, 1]);
  assert.equal(centerFromBounds(null), null);
});

test("orientationAxesFromQuaternion matches THREE applyQuaternion(inverse)", () => {
  const cases = [
    new THREE.Quaternion(),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 2.4)),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-2.7, 0.02, 0.9))
  ];
  for (const quaternion of cases) {
    const axes = orientationAxesFromQuaternion(quaternion);
    const inverse = quaternion.clone().invert();
    for (const [axis, vector] of [["x", [1, 0, 0]], ["y", [0, 1, 0]], ["z", [0, 0, 1]]]) {
      const expected = new THREE.Vector3(...vector).applyQuaternion(inverse);
      for (const [index, component] of ["x", "y", "z"].entries()) {
        assert.ok(
          Math.abs(axes[axis][index] - expected[component]) < 1e-12,
          `${axis}[${index}]`
        );
      }
    }
  }
  assert.equal(orientationAxesFromQuaternion(null), IDENTITY_ORIENTATION_AXES);
});

test("orientationAxesChanged respects the epsilon", () => {
  const base = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  assert.equal(orientationAxesChanged(base, IDENTITY_ORIENTATION_AXES), false);
  assert.equal(orientationAxesChanged(base, { ...base, z: [0, 0.003, 1] }), true);
  assert.equal(orientationAxesChanged(base, { ...base, z: [0, 0.001, 1] }), false);
});

test("misc helpers: signs key and easing endpoints", () => {
  assert.equal(directionSignsKey([8, -2, 0]), "1,-1,0");
  assert.equal(directionSignsKey(null), "0,0,0");
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(-3), 0);
});
