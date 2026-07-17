// Thin adapter over the shared cadjs normal-to math: this file owns the
// Viewer's reference shape (selectorType/pickData) and English reasons; the
// side-of-plane and stable-up geometry lives in cadjs/lib/viewer/viewOrientations.
import {
  buildNormalToViewFromFace,
  centerFromBounds,
  normalizeVector,
  numericVector3
} from "cadjs/lib/viewer/viewOrientations.js";

export const NORMAL_TO_PLANAR_FACE_REASON = "Only planar faces can be viewed normal to";

function normalizedSurfaceType(reference) {
  return String(
    reference?.pickData?.surfaceType ||
    reference?.pickData?.surface?.type ||
    ""
  ).trim().toLowerCase();
}

// Face center used as the side-of-plane origin when deciding whether the
// camera looks at the face's front or back (the orbit target may sit on the
// other side of the plane and must not be used for that test).
export function normalToReferenceCenter(reference) {
  const pickData = reference?.pickData || {};
  const bounds = pickData.bbox || reference?.bbox || null;
  return numericVector3(pickData.center || reference?.center) || centerFromBounds(bounds);
}

export function normalToReferenceAvailability(reference) {
  if (String(reference?.selectorType || "").trim().toLowerCase() !== "face") {
    return {
      visible: false,
      available: false,
      reason: ""
    };
  }
  if (normalizedSurfaceType(reference) !== "plane") {
    return {
      visible: true,
      available: false,
      reason: NORMAL_TO_PLANAR_FACE_REASON
    };
  }
  const normal = normalizeVector(reference?.pickData?.normal || reference?.pickData?.surface?.normal);
  const center = normalToReferenceCenter(reference);
  if (!normal || !center) {
    return {
      visible: true,
      available: false,
      reason: "Face orientation data is unavailable"
    };
  }
  return {
    visible: true,
    available: true,
    reason: ""
  };
}

export function buildNormalToView(reference, {
  cameraDirection = [0, 0, 1],
  cameraUp = [0, 0, 1]
} = {}) {
  if (!normalToReferenceAvailability(reference).available) {
    return null;
  }
  const pickData = reference?.pickData || {};
  return buildNormalToViewFromFace({
    center: normalToReferenceCenter(reference),
    normal: pickData.normal || pickData.surface?.normal,
    bounds: pickData.bbox || reference?.bbox || null,
    cameraDirection,
    cameraUp
  });
}
