import {
  clampSceneModelRadius,
  VIEWER_SCENE_SCALE,
  getSceneScaleSettings
} from "./sceneScale.js";
import { BASE_VIEWER_THEME } from "./stageTheme.js";
import {
  DEFAULT_FLOOR_GRID_SETTINGS,
  MAX_FLOOR_GRID_DENSITY,
  MIN_FLOOR_GRID_DENSITY,
  THEME_FLOOR_MODES
} from "../themeSettings.js";
import { DEFAULT_AUTO_ZOOM_PADDING } from "./autoZoom.js";

export const DEFAULT_GRID_DIVISIONS = 28;
export const GRID_TARGET_VISIBLE_CELLS = 1.25;

// Model-anchored grid fade radii, expressed as multiples of the model radius. The
// grid reads as a FINITE disk centred on the model: lines are solid out to
// INNER * radius and fully faded by OUTER * radius. Because the fade is anchored to
// the model (not the camera distance), dollying the camera out never expands the
// grid into an infinite faint web -- it stays a bounded floor around the model,
// like the reference examples' finite GridHelper.
export const GRID_FADE_INNER_RADII = 2.4;
export const GRID_FADE_OUTER_RADII = 3.4;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeGridDensity(value) {
  const density = Number(value);
  return Number.isFinite(density)
    ? clamp(density, MIN_FLOOR_GRID_DENSITY, MAX_FLOOR_GRID_DENSITY)
    : DEFAULT_FLOOR_GRID_SETTINGS.density;
}

function resolveGridStyle(viewerTheme = {}, floorSettings = {}) {
  const gridSettings = floorSettings?.grid || {};
  return {
    centerColor: gridSettings?.centerColor
      || floorSettings?.gridCenterColor
      || floorSettings?.gridCenter
      || viewerTheme?.gridCenter
      || BASE_VIEWER_THEME.gridCenter,
    cellColor: gridSettings?.cellColor
      || floorSettings?.gridCellColor
      || floorSettings?.gridCell
      || viewerTheme?.gridCell
      || BASE_VIEWER_THEME.gridCell,
    opacity: Number.isFinite(Number(gridSettings?.opacity))
      ? clamp(Number(gridSettings.opacity), 0, 1)
      : Number.isFinite(Number(floorSettings?.gridOpacity))
      ? clamp(Number(floorSettings.gridOpacity), 0, 1)
      : (viewerTheme?.gridOpacity ?? BASE_VIEWER_THEME.gridOpacity)
  };
}

export function niceGridStep(minimumStep) {
  if (!Number.isFinite(minimumStep) || minimumStep <= 0) {
    return getSceneScaleSettings(VIEWER_SCENE_SCALE.CAD).minGridSize / DEFAULT_GRID_DIVISIONS;
  }
  const exponent = Math.floor(Math.log10(minimumStep));
  const base = 10 ** exponent;
  for (const multiplier of [1, 2, 5, 10]) {
    const step = base * multiplier;
    if (step >= minimumStep) {
      return step;
    }
  }
  return base * 10;
}

export function buildGridConfig(radius, sceneScaleMode, floorSettings = {}) {
  const gridDensity = normalizeGridDensity(floorSettings?.grid?.density ?? floorSettings?.gridDensity);
  const safeRadius = clampSceneModelRadius(radius, sceneScaleMode);
  const targetVisibleCells = GRID_TARGET_VISIBLE_CELLS * gridDensity;
  const cellSize = (safeRadius * 2 * DEFAULT_AUTO_ZOOM_PADDING) / targetVisibleCells;
  let divisions = Math.max(2, Math.round(DEFAULT_GRID_DIVISIONS * gridDensity));
  if (divisions % 2 !== 0) {
    divisions += 1;
  }
  return {
    size: cellSize * divisions,
    cellSize,
    divisions
  };
}

// Bounded reference grid. A large plane lies on the floor (z = floorZ); a fragment
// shader draws minor/major grid lines in WORLD coordinates with fwidth anti-aliasing
// (so lines stay crisp at every zoom) and fades them out by distance from the MODEL
// centre -- the model is recentred to the XY origin on load, so the grid is a finite
// disk of radius ~OUTER*modelRadius anchored to the model. Unlike a camera-distance
// fade, dollying the camera out keeps the grid a tidy bounded floor around the model
// instead of expanding it into an infinite faint web, matching the reference
// examples' finite GridHelper look.
export const STAGE_GRID_VERTEX_SHADER = `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const STAGE_GRID_FRAGMENT_SHADER = `
precision highp float;
varying vec3 vWorldPosition;
uniform vec3 uCellColor;
uniform vec3 uCenterColor;
uniform float uOpacity;
uniform float uCellSize;
uniform float uFloorZ;
uniform vec2 uGridCenter;
uniform float uFadeInner;
uniform float uFadeOuter;

// Line coverage in [0,1] (1 on a grid line) for a given cell size, kept ~1px
// wide via screen-space derivatives so lines stay crisp at any zoom.
float gridLine(vec2 coord, float cell) {
  vec2 g = coord / cell;
  vec2 w = fwidth(g);
  vec2 distanceToLine = abs(fract(g - 0.5) - 0.5) / max(w, vec2(1e-6));
  float line = min(distanceToLine.x, distanceToLine.y);
  return 1.0 - clamp(line, 0.0, 1.0);
}

void main() {
  vec2 plane = vWorldPosition.xy;
  float minor = gridLine(plane, uCellSize);
  float major = gridLine(plane, uCellSize * 10.0);

  // Fade by planar distance from the model centre (uGridCenter, the XY origin the
  // model is recentred to). This makes the grid a FINITE disk anchored to the model:
  // solid out to uFadeInner, gone by uFadeOuter. Because it is independent of the
  // camera, dollying out keeps the grid a bounded floor around the model rather than
  // an ever-expanding faint web, and the soft smoothstep edge avoids a hard boundary.
  float radial = length(plane - uGridCenter);
  float fade = 1.0 - smoothstep(uFadeInner, uFadeOuter, radial);
  if (fade <= 0.0) {
    discard;
  }

  float strength = max(minor * 0.55, major);
  if (strength <= 0.0) {
    discard;
  }
  vec3 color = mix(uCellColor, uCenterColor, step(0.5, major));
  float alpha = strength * uOpacity * fade;
  if (alpha < 0.0025) {
    discard;
  }
  gl_FragColor = vec4(color, alpha);
}
`;

function buildGridMaterial(THREE, config, floorZ) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCellColor: { value: new THREE.Color(config.cellColor) },
      uCenterColor: { value: new THREE.Color(config.centerColor) },
      uOpacity: { value: config.opacity },
      uCellSize: { value: config.cellSize },
      uFloorZ: { value: floorZ },
      // Plain [x, y] arrays upload fine as a vec2 (three uses uniform2fv), so the
      // grid material stays free of any THREE.Vector2 dependency.
      uGridCenter: { value: [0, 0] },
      uFadeInner: { value: config.fadeInner },
      uFadeOuter: { value: config.fadeOuter }
    },
    vertexShader: STAGE_GRID_VERTEX_SHADER,
    fragmentShader: STAGE_GRID_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide
  });
  // Needed for fwidth() under WebGL1; ignored (always available) on WebGL2.
  material.extensions = { ...(material.extensions || {}), derivatives: true };
  return material;
}

export function updateGridHelper(
  runtime,
  viewerTheme,
  radius,
  floorZ = 0,
  sceneScaleMode = VIEWER_SCENE_SCALE.CAD,
  floorMode = THEME_FLOOR_MODES.STAGE,
  { disposeSceneObject = () => {}, floorSettings = {} } = {}
) {
  if (!runtime?.THREE || !runtime?.scene) {
    return;
  }
  runtime.gridRadius = radius;
  runtime.gridFloorZ = floorZ;
  const gridEnabled = floorSettings?.grid?.enabled === true || floorMode === THEME_FLOOR_MODES.GRID;
  runtime.floorMode = gridEnabled ? THEME_FLOOR_MODES.GRID : floorMode;
  if (!gridEnabled) {
    disposeSceneObject(runtime.gridHelper);
    runtime.gridHelper = null;
    runtime.gridConfig = null;
    return;
  }
  const base = buildGridConfig(radius, sceneScaleMode, floorSettings);
  const style = resolveGridStyle(viewerTheme, floorSettings);
  // Large carrier plane: far beyond the camera-relative fade so its own edge can
  // never enter view. Scaled to the model so precision stays sane per scene.
  const planeSize = Math.max(base.size * 16, base.cellSize * 512);
  const safeGridRadius = clampSceneModelRadius(radius, sceneScaleMode);
  const nextConfig = {
    cellSize: base.cellSize,
    radius: safeGridRadius,
    fadeInner: safeGridRadius * GRID_FADE_INNER_RADII,
    fadeOuter: safeGridRadius * GRID_FADE_OUTER_RADII,
    planeSize,
    centerColor: style.centerColor,
    cellColor: style.cellColor,
    opacity: style.opacity
  };
  const currentConfig = runtime.gridConfig;
  if (
    currentConfig &&
    runtime.gridHelper &&
    currentConfig.cellSize === nextConfig.cellSize &&
    currentConfig.fadeInner === nextConfig.fadeInner &&
    currentConfig.fadeOuter === nextConfig.fadeOuter &&
    currentConfig.planeSize === nextConfig.planeSize &&
    currentConfig.centerColor === nextConfig.centerColor &&
    currentConfig.cellColor === nextConfig.cellColor &&
    currentConfig.opacity === nextConfig.opacity
  ) {
    runtime.gridHelper.position.set(0, 0, floorZ);
    if (runtime.gridHelper.material?.uniforms?.uFloorZ) {
      runtime.gridHelper.material.uniforms.uFloorZ.value = floorZ;
    }
    return;
  }

  disposeSceneObject(runtime.gridHelper);
  const THREE = runtime.THREE;
  const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
  const material = buildGridMaterial(THREE, nextConfig, floorZ);
  const grid = new THREE.Mesh(geometry, material);
  // PlaneGeometry already lies in the XY plane (normal +Z), matching the z-up CAD
  // floor, so -- unlike GridHelper -- it needs no rotation.
  grid.position.set(0, 0, floorZ);
  grid.renderOrder = -1;
  grid.frustumCulled = false;
  runtime.gridHelper = grid;
  runtime.gridConfig = nextConfig;
  runtime.scene.add(grid);
}
