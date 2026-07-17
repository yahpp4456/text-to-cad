// Thin adapter over the shared cadjs view-orientation math: this file only
// injects the Viewer's English naming; every geometric rule (preset layout,
// projected up, active thresholds) lives in cadjs/lib/viewer/viewOrientations.
import {
  closestOrientationId,
  createPresetDirectionLookup,
  createViewOrientationPresets,
  DEFAULT_VIEW_DIRECTION,
  normalizedPresetEntries,
  orientationAxesFromQuaternion,
  VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD,
  VIEW_ORIENTATION_WORLD_UP
} from "cadjs/lib/viewer/viewOrientations.js";

export {
  DEFAULT_VIEW_DIRECTION,
  orientationAxesFromQuaternion,
  VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD,
  VIEW_ORIENTATION_WORLD_UP
};

export const DEFAULT_VIEW_ORIENTATION_PRESET = Object.freeze({
  id: "isometric",
  title: "Reset to default isometric view",
  direction: DEFAULT_VIEW_DIRECTION,
  up: VIEW_ORIENTATION_WORLD_UP
});

const FACE_PRESETS = Object.freeze([
  {
    id: "z",
    label: "Z",
    name: "Top",
    title: "Jump to top view",
    direction: [0, 0, 1]
  },
  {
    id: "zNeg",
    label: "-Z",
    name: "Bottom",
    title: "Jump to bottom view",
    direction: [0, 0, -1]
  },
  {
    id: "yNeg",
    label: "-Y",
    name: "Front",
    title: "Jump to front view",
    direction: [0, -1, 0]
  },
  {
    id: "y",
    label: "Y",
    name: "Back",
    title: "Jump to back view",
    direction: [0, 1, 0]
  },
  {
    id: "x",
    label: "X",
    name: "Right",
    title: "Jump to right view",
    direction: [1, 0, 0]
  },
  {
    id: "xNeg",
    label: "-X",
    name: "Left",
    title: "Jump to left view",
    direction: [-1, 0, 0]
  }
]);

const DIRECTION_NAME_BY_AXIS_SIGN = Object.freeze({
  "x:1": "right",
  "x:-1": "left",
  "y:1": "back",
  "y:-1": "front",
  "z:1": "top",
  "z:-1": "bottom"
});

function directionName(direction) {
  const names = [];
  for (const [axis, index] of [["z", 2], ["y", 1], ["x", 0]]) {
    const value = direction[index];
    if (value) {
      names.push(DIRECTION_NAME_BY_AXIS_SIGN[`${axis}:${value}`]);
    }
  }
  return names.join("-");
}

export const VIEW_ORIENTATION_PRESETS = createViewOrientationPresets({
  facePresets: FACE_PRESETS,
  decoratePreset: (direction, { category }) => {
    const name = directionName(direction);
    return {
      label: name,
      name: name.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" "),
      title: `Jump to ${name} ${category} view`
    };
  }
});

export const VIEW_ORIENTATION_PRESET_BY_ID = Object.freeze(Object.fromEntries(
  VIEW_ORIENTATION_PRESETS.map((preset) => [preset.id, preset])
));

const presetDirectionLookup = createPresetDirectionLookup(VIEW_ORIENTATION_PRESETS);

export function viewOrientationPresetForDirection(direction) {
  return presetDirectionLookup(direction);
}

const NORMALIZED_PRESET_ENTRIES = normalizedPresetEntries(VIEW_ORIENTATION_PRESETS);

export function closestViewOrientationId(
  direction,
  presets = VIEW_ORIENTATION_PRESETS,
  dotThreshold = VIEW_ORIENTATION_ACTIVE_DOT_THRESHOLD
) {
  const entries = presets === VIEW_ORIENTATION_PRESETS
    ? NORMALIZED_PRESET_ENTRIES
    : normalizedPresetEntries(presets);
  return closestOrientationId(direction, entries, dotThreshold);
}
