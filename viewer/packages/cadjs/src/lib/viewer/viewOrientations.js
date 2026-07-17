// Shared view-orientation math for ViewCube / view presets / "normal to face".
// Single source of truth consumed by the CAD Viewer app and cad-chat; only the
// geometry lives here — labels, titles and preset naming are injected by each
// app through createViewOrientationPresets.

export const VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD = 0.985;
export const VIEW_ORIENTATION_WORLD_UP = Object.freeze([0, 0, 1]);
// Default/ISO direction must stay clear of every preset zone (the closest
// corner [1, -1, 1] has dot ≈ 0.968 < 0.985), otherwise the default view is
// mislabeled as an active corner.
export const DEFAULT_VIEW_DIRECTION = Object.freeze([2.1, -1.65, 1.08]);
// Candidates nearly parallel to the view direction leave a floating-point
// residue after projection; normalizing that residue yields an arbitrary roll.
// Skip such candidates — the orthogonal axis candidates can never all be
// near-parallel, so the projection loop always has an exit.
export const UP_NEAR_PARALLEL_DOT = 0.9;

export const IDENTITY_ORIENTATION_AXES = Object.freeze({
  x: Object.freeze([1, 0, 0]),
  y: Object.freeze([0, 1, 0]),
  z: Object.freeze([0, 0, 1])
});

const EPSILON = 1e-9;

export function numericVector3(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    return null;
  }
  const vector = [Number(value[0]), Number(value[1]), Number(value[2])];
  return vector.every(Number.isFinite) ? vector : null;
}

export function normalizeVector(value) {
  const vector = numericVector3(value);
  if (!vector) {
    return null;
  }
  const length = Math.hypot(...vector);
  return length > EPSILON ? vector.map((component) => component / length) : null;
}

export function dotVector3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function easeInOutCubic(value) {
  const t = Math.min(Math.max(value, 0), 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function projectedUpForDirection(direction, preferredUp = VIEW_ORIENTATION_WORLD_UP) {
  const normalizedDirection = normalizeVector(direction);
  if (!normalizedDirection) {
    return [...VIEW_ORIENTATION_WORLD_UP];
  }
  for (const candidate of [
    preferredUp,
    VIEW_ORIENTATION_WORLD_UP,
    [0, 1, 0],
    [1, 0, 0]
  ]) {
    const normalizedCandidate = normalizeVector(candidate);
    if (!normalizedCandidate) {
      continue;
    }
    const candidateDot = dotVector3(normalizedCandidate, normalizedDirection);
    if (Math.abs(candidateDot) > UP_NEAR_PARALLEL_DOT) {
      continue;
    }
    const projection = normalizedCandidate.map(
      (value, index) => value - normalizedDirection[index] * candidateDot
    );
    const normalizedProjection = normalizeVector(projection);
    if (normalizedProjection) {
      return normalizedProjection;
    }
  }
  return [0, 1, 0];
}

export function centerFromBounds(bounds) {
  const min = numericVector3(bounds?.min);
  const max = numericVector3(bounds?.max);
  return min && max
    ? min.map((value, index) => (value + max[index]) / 2)
    : null;
}

// Core of "normal to face": keep the camera on its current side of the plane
// (the caller must pass a cameraDirection measured from the FACE CENTER, not
// from the orbit target — the target may sit on the other side of the plane)
// and derive a stable, non-rolling up vector.
export function buildNormalToViewFromFace({
  center,
  normal,
  bounds = null,
  cameraDirection = [0, 0, 1],
  cameraUp = VIEW_ORIENTATION_WORLD_UP
} = {}) {
  const numericCenter = numericVector3(center) || centerFromBounds(bounds);
  const faceNormal = normalizeVector(normal);
  if (!numericCenter || !faceNormal) {
    return null;
  }
  const currentDirection = normalizeVector(cameraDirection);
  const direction = currentDirection && dotVector3(faceNormal, currentDirection) < 0
    ? faceNormal.map((value) => (value === 0 ? 0 : -value))
    : faceNormal;
  return {
    center: numericCenter,
    direction,
    up: projectedUpForDirection(direction, cameraUp),
    bounds
  };
}

function applyQuaternionToVector(vector, { x, y, z, w }) {
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx)
  ];
}

// World axes expressed in camera space (equivalent to rotating each axis by
// the inverse camera quaternion). Pure math so it works on THREE.Quaternion
// instances and plain {x, y, z, w} objects alike.
export function orientationAxesFromQuaternion(quaternion) {
  const { x, y, z, w } = quaternion || {};
  if (![x, y, z, w].every(Number.isFinite)) {
    return IDENTITY_ORIENTATION_AXES;
  }
  const inverse = { x: -x, y: -y, z: -z, w };
  return {
    x: applyQuaternionToVector([1, 0, 0], inverse),
    y: applyQuaternionToVector([0, 1, 0], inverse),
    z: applyQuaternionToVector([0, 0, 1], inverse)
  };
}

export function orientationAxesChanged(left, right, epsilon = 0.002) {
  for (const axis of ["x", "y", "z"]) {
    for (let index = 0; index < 3; index += 1) {
      if (Math.abs(Number(left?.[axis]?.[index]) - Number(right?.[axis]?.[index])) > epsilon) {
        return true;
      }
    }
  }
  return false;
}

export function directionSignsKey(direction) {
  return [0, 1, 2]
    .map((index) => {
      const value = Number(direction?.[index]);
      return Number.isFinite(value) ? Math.sign(value) : 0;
    })
    .join(",");
}

function categoryForDirection(direction) {
  const nonZeroAxisCount = direction.filter(Boolean).length;
  return nonZeroAxisCount === 1 ? "face" : nonZeroAxisCount === 2 ? "edge" : "corner";
}

// Build the 26 face/edge/corner presets. `facePresets` supplies the six axis
// presets with app-specific naming; `decoratePreset(direction, { id, category })`
// returns { label, name, title } for the 20 edge/corner presets.
export function createViewOrientationPresets({ facePresets, decoratePreset }) {
  const faceIdByKey = new Map(
    facePresets.map((preset) => [preset.direction.join(","), preset.id])
  );
  const directionId = (direction) => {
    const faceId = faceIdByKey.get(direction.join(","));
    if (faceId) {
      return faceId;
    }
    const tokens = [];
    for (const [axis, value] of [["x", direction[0]], ["y", direction[1]], ["z", direction[2]]]) {
      if (value > 0) {
        tokens.push(axis);
      } else if (value < 0) {
        tokens.push(`${axis}Neg`);
      }
    }
    return tokens.join("-");
  };

  const presets = facePresets.map((preset) => Object.freeze({
    ...preset,
    category: "face",
    direction: Object.freeze([...preset.direction]),
    up: Object.freeze(projectedUpForDirection(preset.direction))
  }));
  for (const nonZeroAxisCount of [2, 3]) {
    for (const x of [-1, 0, 1]) {
      for (const y of [-1, 0, 1]) {
        for (const z of [-1, 0, 1]) {
          const direction = [x, y, z];
          if (direction.filter(Boolean).length !== nonZeroAxisCount) {
            continue;
          }
          const id = directionId(direction);
          const category = categoryForDirection(direction);
          const naming = decoratePreset(direction, { id, category });
          presets.push(Object.freeze({
            id,
            category,
            ...naming,
            direction: Object.freeze([...direction]),
            up: Object.freeze(projectedUpForDirection(direction))
          }));
        }
      }
    }
  }
  return Object.freeze(presets);
}

export function createPresetDirectionLookup(presets) {
  const bySignsKey = new Map(
    presets.map((preset) => [preset.direction.join(","), preset])
  );
  return (direction) => bySignsKey.get(directionSignsKey(direction)) || null;
}

// Preset directions are constants — normalize them once at module init so the
// closest-orientation check stays allocation-free on onFrame / controls-change
// hot paths.
export function normalizedPresetEntries(presets) {
  return (Array.isArray(presets) ? presets : []).map((preset) => ({
    id: preset?.id,
    direction: normalizeVector(preset?.direction)
  }));
}

export function closestOrientationId(direction, entries, dotThreshold) {
  const normalizedDirection = normalizeVector(direction);
  if (!normalizedDirection) {
    return "";
  }
  let bestId = "";
  let bestScore = -Infinity;
  for (const entry of entries) {
    if (!entry.direction) {
      continue;
    }
    const score = dotVector3(normalizedDirection, entry.direction);
    if (score > bestScore) {
      bestScore = score;
      bestId = String(entry.id || "");
    }
  }
  return bestScore >= dotThreshold ? bestId : "";
}
