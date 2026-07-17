import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNormalToView,
  NORMAL_TO_PLANAR_FACE_REASON,
  normalToReferenceAvailability,
  normalToReferenceCenter
} from "./normalToView.js";

function planarFace(overrides = {}) {
  return {
    selectorType: "face",
    pickData: {
      surfaceType: "plane",
      center: [4, 5, 6],
      normal: [0, 0, 2],
      bbox: {
        min: [2, 3, 6],
        max: [6, 7, 6]
      },
      ...(overrides.pickData || {})
    },
    ...overrides
  };
}

test("normal-to availability is hidden for non-faces and disabled for curved faces", () => {
  assert.deepEqual(normalToReferenceAvailability({ selectorType: "edge" }), {
    visible: false,
    available: false,
    reason: ""
  });
  assert.deepEqual(normalToReferenceAvailability(planarFace({
    pickData: {
      surfaceType: "cylinder",
      center: [0, 0, 0],
      normal: [1, 0, 0]
    }
  })), {
    visible: true,
    available: false,
    reason: NORMAL_TO_PLANAR_FACE_REASON
  });
});

test("normal-to keeps the camera on its current side of a planar face", () => {
  assert.deepEqual(
    buildNormalToView(planarFace(), {
      cameraDirection: [0, 0, -4],
      cameraUp: [0, 1, 0]
    }),
    {
      center: [4, 5, 6],
      direction: [0, 0, -1],
      up: [0, 1, 0],
      bounds: {
        min: [2, 3, 6],
        max: [6, 7, 6]
      }
    }
  );
});

test("normal-to projects camera up and falls back safely at a pole", () => {
  const view = buildNormalToView(planarFace({
    pickData: {
      surfaceType: "PLANE",
      center: [0, 0, 0],
      normal: [0, 0, 1]
    }
  }), {
    cameraDirection: [0, 0, 1],
    cameraUp: [0, 0, 1]
  });
  assert.deepEqual(view.direction, [0, 0, 1]);
  assert.deepEqual(view.up, [0, 1, 0]);
});

test("normal-to up skips near-parallel candidates instead of normalizing noise", () => {
  // A camera.up left ≈ +Z by a previous transition projects to a ~1e-7 residue;
  // the old code normalized it into [1, 0, 0], rolling the view 90° at random.
  const view = buildNormalToView(planarFace({
    pickData: {
      surfaceType: "PLANE",
      center: [0, 0, 0],
      normal: [0, 0, 1]
    }
  }), {
    cameraDirection: [0, 0, 1],
    cameraUp: [1e-3, 0, 1]
  });
  assert.deepEqual(view.up, [0, 1, 0]);
});

test("normal-to exposes the face center used for the side-of-plane test", () => {
  assert.deepEqual(normalToReferenceCenter(planarFace()), [4, 5, 6]);
  assert.deepEqual(normalToReferenceCenter(planarFace({
    pickData: {
      surfaceType: "plane",
      center: null,
      normal: [1, 0, 0],
      bbox: {
        min: [0, 0, 0],
        max: [2, 2, 2]
      }
    }
  })), [1, 1, 1]);
  assert.equal(normalToReferenceCenter({}), null);
});

test("normal-to derives a center from bounds and rejects incomplete plane data", () => {
  const reference = planarFace({
    pickData: {
      surfaceType: "plane",
      center: null,
      normal: [1, 0, 0],
      bbox: {
        min: [2, 4, 6],
        max: [8, 10, 12]
      }
    }
  });
  assert.deepEqual(buildNormalToView(reference)?.center, [5, 7, 9]);
  assert.equal(buildNormalToView(planarFace({
    pickData: {
      surfaceType: "plane",
      center: [0, 0, 0],
      normal: null
    }
  })), null);
});
