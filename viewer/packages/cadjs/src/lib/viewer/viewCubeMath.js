// Shared ViewCube projection geometry (SVG-space cube faces, hit regions and
// orientation projection). Scale / centering / colors are app-side choices —
// pass { scale, cx, cy } to projectedPoint.

import { IDENTITY_ORIENTATION_AXES } from "./viewOrientations.js";

export const CUBE_FACES = Object.freeze([
  Object.freeze({ id: "xNeg", axis: "x", sign: -1, uAxis: "y", vAxis: "z" }),
  Object.freeze({ id: "x", axis: "x", sign: 1, uAxis: "y", vAxis: "z" }),
  Object.freeze({ id: "yNeg", axis: "y", sign: -1, uAxis: "x", vAxis: "z" }),
  Object.freeze({ id: "y", axis: "y", sign: 1, uAxis: "x", vAxis: "z" }),
  Object.freeze({ id: "zNeg", axis: "z", sign: -1, uAxis: "x", vAxis: "y" }),
  Object.freeze({ id: "z", axis: "z", sign: 1, uAxis: "x", vAxis: "y" })
]);
export const CUBE_REGION_BREAKS = Object.freeze([-1, -0.42, 0.42, 1]);
export const CUBE_REGION_DIRECTIONS = Object.freeze([-1, 0, 1]);

function normalizeAxis(axis, fallback) {
  if ((!Array.isArray(axis) && !ArrayBuffer.isView(axis)) || axis.length < 3) {
    return [...fallback];
  }
  const next = [Number(axis[0]), Number(axis[1]), Number(axis[2])];
  const length = Math.hypot(...next);
  return next.every(Number.isFinite) && length > 1e-6
    ? next.map((value) => value / length)
    : [...fallback];
}

export function normalizeOrientationAxes(orientation) {
  return {
    x: normalizeAxis(orientation?.x, IDENTITY_ORIENTATION_AXES.x),
    y: normalizeAxis(orientation?.y, IDENTITY_ORIENTATION_AXES.y),
    z: normalizeAxis(orientation?.z, IDENTITY_ORIENTATION_AXES.z)
  };
}

export function projectDirection(orientation, direction) {
  const [dx = 0, dy = 0, dz = 0] = direction || [];
  return [
    orientation.x[0] * dx + orientation.y[0] * dy + orientation.z[0] * dz,
    orientation.x[1] * dx + orientation.y[1] * dy + orientation.z[1] * dz,
    orientation.x[2] * dx + orientation.y[2] * dy + orientation.z[2] * dz
  ];
}

export function projectedPoint(orientation, point, { scale, cx = 50, cy = 50 } = {}) {
  const projected = projectDirection(orientation, point);
  return {
    x: cx + projected[0] * scale,
    y: cy - projected[1] * scale,
    depth: projected[2]
  };
}

export function pointForCubeFace(face, u, v) {
  const point = { x: 0, y: 0, z: 0 };
  point[face.axis] = face.sign;
  point[face.uAxis] = u;
  point[face.vAxis] = v;
  return [point.x, point.y, point.z];
}

export function directionForCubeRegion(face, uDirection, vDirection) {
  const direction = { x: 0, y: 0, z: 0 };
  direction[face.axis] = face.sign;
  direction[face.uAxis] = uDirection;
  direction[face.vAxis] = vDirection;
  return [direction.x, direction.y, direction.z];
}

export function insetInterval(start, end, amount = 0.025) {
  const inset = Math.min(Math.abs(end - start) * amount, 0.035);
  return [start + inset, end - inset];
}

export function polygonPoints(points) {
  return points.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(" ");
}
