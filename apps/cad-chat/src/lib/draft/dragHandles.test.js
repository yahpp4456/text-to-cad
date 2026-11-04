import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANE_NORMALS, dragPoint, handlePlaneFor, intersectRayPlane, moveInPlane, snapToGrid } from "./dragHandles.js";

test("handlePlaneFor:草稿 plane 優先;否則依視線挑最正對的主平面;無視線 → XY", () => {
  assert.equal(handlePlaneFor({ plane: "XZ" }, [0, 0, -1]), "XZ");
  assert.equal(handlePlaneFor({}, [0, 0, -1]), "XY");
  assert.equal(handlePlaneFor({}, [0, -1, 0.2]), "XZ");
  assert.equal(handlePlaneFor({}, [0.9, 0.1, 0.1]), "YZ");
  assert.equal(handlePlaneFor({ plane: "bogus" }, null), "XY");
});

test("intersectRayPlane:正向求交、平行 null、背向 null", () => {
  assert.deepEqual(intersectRayPlane([0, 0, 10], [0, 0, -1], [0, 0, 0], PLANE_NORMALS.XY), [0, 0, 0]);
  assert.deepEqual(intersectRayPlane([5, 5, 10], [0, 0, -1], [0, 0, 2], [0, 0, 1]), [5, 5, 2]);
  assert.equal(intersectRayPlane([0, 0, 10], [1, 0, 0], [0, 0, 0], PLANE_NORMALS.XY), null);
  assert.equal(intersectRayPlane([0, 0, 10], [0, 0, 1], [0, 0, 0], PLANE_NORMALS.XY), null);
});

test("moveInPlane 保留第三軸;snapToGrid;dragPoint 一條龍(含 0.001 捨入)", () => {
  assert.deepEqual(moveInPlane([1, 2, 3], [7, 8, 9], "XY"), [7, 8, 3]);
  assert.deepEqual(moveInPlane([1, 2, 3], [7, 8, 9], "XZ"), [7, 2, 9]);
  assert.deepEqual(moveInPlane([1, 2, 3], [7, 8, 9], "YZ"), [1, 8, 9]);
  assert.deepEqual(moveInPlane([1, 2, 3], null, "YZ"), [1, 2, 3]);
  assert.deepEqual(snapToGrid([1.26, -0.74, 3], 0.5), [1.5, -0.5, 3]);
  assert.deepEqual(snapToGrid([1.26, -0.74, 3], 0), [1.26, -0.74, 3]);
  const p = dragPoint({ original: [10, 20, 5], rayOrigin: [12.3, 21.7, 100], rayDir: [0, 0, -1], plane: "XY", snap: 0 });
  assert.deepEqual(p, [12.3, 21.7, 5]);
  const q = dragPoint({ original: [10, 20, 5], rayOrigin: [12.3, 21.7, 100], rayDir: [0, 0, -1], plane: "XY", snap: 1 });
  assert.deepEqual(q, [12, 22, 5]);
  assert.equal(dragPoint({ original: [0, 0, 0], rayOrigin: [0, 0, 10], rayDir: [1, 0, 0], plane: "XY" }), null);
});
