import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CUBE_FACES,
  CUBE_REGION_BREAKS,
  CUBE_REGION_DIRECTIONS,
  directionForCubeRegion,
  insetInterval,
  normalizeOrientationAxes,
  pointForCubeFace,
  polygonPoints,
  projectDirection,
  projectedPoint
} from "./viewCubeMath.js";

test("cube constants cover six faces and a 3x3 region grid", () => {
  assert.equal(CUBE_FACES.length, 6);
  assert.equal(new Set(CUBE_FACES.map((face) => face.id)).size, 6);
  assert.equal(CUBE_REGION_BREAKS.length, 4);
  assert.deepEqual([...CUBE_REGION_DIRECTIONS], [-1, 0, 1]);
});

test("normalizeOrientationAxes falls back per-axis on garbage input", () => {
  const identity = normalizeOrientationAxes(null);
  assert.deepEqual(identity, { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  const mixed = normalizeOrientationAxes({ x: [0, 2, 0], y: "junk", z: [0, 0, 0] });
  assert.deepEqual(mixed.x, [0, 1, 0]);
  assert.deepEqual(mixed.y, [0, 1, 0]);
  assert.deepEqual(mixed.z, [0, 0, 1]);
});

test("projection maps identity orientation into svg space with app scale", () => {
  const orientation = normalizeOrientationAxes(null);
  assert.deepEqual(projectDirection(orientation, [1, 2, 3]), [1, 2, 3]);
  const point = projectedPoint(orientation, [1, 1, 0.25], { scale: 24 });
  assert.deepEqual(point, { x: 74, y: 26, depth: 0.25 });
  const offset = projectedPoint(orientation, [0, 0, 0], { scale: 23.5, cy: 46 });
  assert.deepEqual(offset, { x: 50, y: 46, depth: 0 });
});

test("face/region helpers place coordinates on the right axes", () => {
  const face = CUBE_FACES.find((entry) => entry.id === "x");
  assert.deepEqual(pointForCubeFace(face, -1, 1), [1, -1, 1]);
  assert.deepEqual(directionForCubeRegion(face, 0, -1), [1, 0, -1]);
});

test("insetInterval shrinks regions but never beyond the cap", () => {
  const [start, end] = insetInterval(-1, -0.42);
  assert.ok(start > -1 && end < -0.42 && start < end);
  const [wideStart, wideEnd] = insetInterval(-1, 1);
  assert.equal(wideStart, -1 + 0.035);
  assert.equal(wideEnd, 1 - 0.035);
});

test("polygonPoints emits three-decimal svg pairs", () => {
  assert.equal(
    polygonPoints([{ x: 1, y: 2 }, { x: 3.14159, y: -0.5 }]),
    "1.000,2.000 3.142,-0.500"
  );
});
