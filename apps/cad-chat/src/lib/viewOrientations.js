// cadjs 共用視圖方位數學的薄轉接層:本檔只注入繁中命名與 cad-chat 的 pickData
// 介面;幾何規則(preset 佈局、projectedUp 守衛、active 閾值、正視於側向)
// 單一真相源在 packages/cadjs/src/lib/viewer/viewOrientations.js。
// 注意:這裡用相對路徑而非 Vite alias "cadjs/..." —— node --test 不解析 alias
// (cad-chat 沒把 cadjs 裝進 node_modules),相對路徑兩邊都指同一份源。
import {
  buildNormalToViewFromFace,
  centerFromBounds,
  closestOrientationId,
  createPresetDirectionLookup,
  createViewOrientationPresets,
  DEFAULT_VIEW_DIRECTION,
  directionSignsKey,
  IDENTITY_ORIENTATION_AXES,
  normalizedPresetEntries,
  normalizeVector,
  numericVector3,
  orientationAxesChanged,
  orientationAxesFromQuaternion,
  VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD,
  VIEW_ORIENTATION_WORLD_UP,
} from "../../../../packages/cadjs/src/lib/viewer/viewOrientations.js";

export {
  DEFAULT_VIEW_DIRECTION,
  directionSignsKey,
  IDENTITY_ORIENTATION_AXES,
  orientationAxesChanged,
  orientationAxesFromQuaternion,
  VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD,
  VIEW_ORIENTATION_WORLD_UP,
};

export const DEFAULT_VIEW_ORIENTATION_PRESET = Object.freeze({
  id: "isometric",
  title: "回到等角視圖",
  direction: DEFAULT_VIEW_DIRECTION,
  up: VIEW_ORIENTATION_WORLD_UP,
});

const FACE_PRESETS = Object.freeze([
  { id: "z", label: "Z", name: "上視", title: "上視圖", direction: [0, 0, 1] },
  { id: "zNeg", label: "-Z", name: "下視", title: "下視圖", direction: [0, 0, -1] },
  { id: "yNeg", label: "-Y", name: "前視", title: "前視圖", direction: [0, -1, 0] },
  { id: "y", label: "Y", name: "後視", title: "後視圖", direction: [0, 1, 0] },
  { id: "x", label: "X", name: "右視", title: "右視圖", direction: [1, 0, 0] },
  { id: "xNeg", label: "-X", name: "左視", title: "左視圖", direction: [-1, 0, 0] },
]);

const DIRECTION_NAME_BY_AXIS_SIGN = Object.freeze({
  "x:1": "右",
  "x:-1": "左",
  "y:1": "後",
  "y:-1": "前",
  "z:1": "上",
  "z:-1": "下",
});

function directionName(direction) {
  const names = [];
  for (const [axis, index] of [["z", 2], ["y", 1], ["x", 0]]) {
    const value = direction[index];
    if (value) names.push(DIRECTION_NAME_BY_AXIS_SIGN[`${axis}:${value}`]);
  }
  return names.join("");
}

export const VIEW_ORIENTATION_PRESETS = createViewOrientationPresets({
  facePresets: FACE_PRESETS,
  decoratePreset: (direction, { category }) => {
    const name = directionName(direction);
    const categoryLabel = category === "edge" ? "稜角" : "角點";
    return { label: name, name, title: `${name}${categoryLabel}視圖` };
  },
});

export const VIEW_ORIENTATION_PRESET_BY_ID = Object.freeze(Object.fromEntries(
  VIEW_ORIENTATION_PRESETS.map((preset) => [preset.id, preset]),
));

const presetDirectionLookup = createPresetDirectionLookup(VIEW_ORIENTATION_PRESETS);

export function viewOrientationPresetForDirection(direction) {
  return presetDirectionLookup(direction);
}

const NORMALIZED_PRESET_ENTRIES = normalizedPresetEntries(VIEW_ORIENTATION_PRESETS);

export function closestViewOrientationId(
  direction,
  presets = VIEW_ORIENTATION_PRESETS,
  dotThreshold = VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD,
) {
  const entries = presets === VIEW_ORIENTATION_PRESETS
    ? NORMALIZED_PRESET_ENTRIES
    : normalizedPresetEntries(presets);
  return closestOrientationId(direction, entries, dotThreshold);
}

function normalizedSurfaceType(pickData) {
  return String(pickData?.surfaceType || pickData?.surface?.type || "").trim().toLowerCase();
}

function isPlanarSurfaceType(surfaceType) {
  return surfaceType === "plane" || surfaceType.includes("planar") || surfaceType.includes("plane");
}

function faceCenter(pickData) {
  return numericVector3(pickData?.center) || centerFromBounds(pickData?.bbox);
}

export function normalToFaceAvailability(pickData) {
  const surfaceType = normalizedSurfaceType(pickData);
  if (!isPlanarSurfaceType(surfaceType)) {
    return {
      available: false,
      reason: surfaceType ? "僅平面可使用正視於" : "缺少面的曲面類型資料",
    };
  }
  const normal = normalizeVector(pickData?.normal || pickData?.surface?.normal);
  if (!normal || !faceCenter(pickData)) {
    return { available: false, reason: "缺少面的方向或中心資料" };
  }
  return { available: true, reason: "" };
}

export function buildNormalToFaceView(pickData, {
  cameraDirection = [0, 0, 1],
  cameraUp = VIEW_ORIENTATION_WORLD_UP,
} = {}) {
  if (!normalToFaceAvailability(pickData).available) return null;
  return buildNormalToViewFromFace({
    center: faceCenter(pickData),
    normal: pickData?.normal || pickData?.surface?.normal,
    bounds: pickData?.bbox || null,
    cameraDirection,
    cameraUp,
  });
}
