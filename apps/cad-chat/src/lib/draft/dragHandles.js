// 3D 拖曳把手的純數學(零 three → node --test 可直測):工作平面選擇、射線與平面求交、
// 平面內移動(第三軸保持原值)、格點吸附。SurfaceWindow / useCadViewport 的拖曳都靠這裡;
// 設計成 SWEEP_WORKBENCH_PLAN 日後可重用。
export const PLANE_NORMALS = Object.freeze({ XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] });
export const PLANE_AXES = Object.freeze({ XY: ["x", "y"], XZ: ["x", "z"], YZ: ["y", "z"] });

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 曲線的工作平面:草稿明給 plane 就用它;否則依相機視線挑最正對的主平面(拖曳在螢幕
// 面上最直覺;viewDir = 相機朝向的單位向量)。
export function handlePlaneFor(curve, viewDir = null) {
  if (curve?.plane && PLANE_NORMALS[curve.plane]) return curve.plane;
  if (!Array.isArray(viewDir) || viewDir.length !== 3) return "XY";
  const ax = Math.abs(viewDir[0]);
  const ay = Math.abs(viewDir[1]);
  const az = Math.abs(viewDir[2]);
  if (az >= ax && az >= ay) return "XY";
  if (ay >= ax) return "XZ";
  return "YZ";
}

// 射線(origin, dir)與過 planePoint、法向 planeNormal 的平面求交;平行或背向 → null
export function intersectRayPlane(origin, dir, planePoint, planeNormal) {
  const denom = dot(dir, planeNormal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot([planePoint[0] - origin[0], planePoint[1] - origin[1], planePoint[2] - origin[2]], planeNormal) / denom;
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

// 在指定主平面內把 original 移到 hit(第三軸保留 original 的值;hit 為 null 回 original)
export function moveInPlane(original, hit, plane) {
  if (!hit) return [...original];
  const n = PLANE_NORMALS[plane] || PLANE_NORMALS.XY;
  return [0, 1, 2].map((i) => (n[i] ? original[i] : hit[i]));
}

export function snapToGrid(p, step) {
  if (!(step > 0)) return [...p];
  return p.map((x) => Math.round(x / step) * step);
}

// 一次算完:射線 → 工作平面(過把手原位)求交 → 平面內移動 → 吸附。回新點或 null(沒交)
export function dragPoint({ original, rayOrigin, rayDir, plane, snap = 0 }) {
  const hit = intersectRayPlane(rayOrigin, rayDir, original, PLANE_NORMALS[plane] || PLANE_NORMALS.XY);
  if (!hit) return null;
  return snapToGrid(moveInPlane(original, hit, plane), snap).map((x) => Math.round(x * 1000) / 1000);
}
