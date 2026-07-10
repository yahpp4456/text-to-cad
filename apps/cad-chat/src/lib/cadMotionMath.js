// 純運動矩陣數學:不依賴 cadjs / render side-effect,供 node --test 直測。
// 播放器(cadMotion.js)與測試共用同一份公式,避免數學漂移。

// 三角波相位 u∈[0,1](0→1→0)。相位錯開(i*0.17)讓多軸疊加時各軸可辨。
export function triangleU(tSec, periodS, i = 0) {
  const T = Math.max(1, Math.min(20, Number(periodS) || 4));
  const phase = (tSec / T + i * 0.17) % 1;
  return 1 - Math.abs(2 * phase - 1);
}

// 某 dof 在參數 u 的 frame-matrix Mi(THREE.Matrix4)。
//   linear   → 沿 axis 平移 axis·u·travel。
//   revolute → 繞「過 pivot、方向 axis」的軸旋轉 u·angle_deg:T(+pivot)·R(axis,θ)·T(−pivot)。
export function frameMatrix(THREE, dof, u) {
  const axis = Array.isArray(dof.axis) ? dof.axis : [0, 0, 0];
  const Mi = new THREE.Matrix4();
  if (dof.type === "revolute") {
    const pivot = Array.isArray(dof.pivot) ? dof.pivot : [0, 0, 0];
    const theta = (u * (Number(dof.angle_deg) || 0) * Math.PI) / 180;
    const ax = new THREE.Vector3(axis[0] || 0, axis[1] || 0, axis[2] || 0);
    if (ax.lengthSq() < 1e-12) ax.set(0, 0, 1); // 退化軸防呆
    ax.normalize();
    const R = new THREE.Matrix4().makeRotationAxis(ax, theta);
    const Tp = new THREE.Matrix4().makeTranslation(pivot[0] || 0, pivot[1] || 0, pivot[2] || 0);
    const Tn = new THREE.Matrix4().makeTranslation(
      -(pivot[0] || 0),
      -(pivot[1] || 0),
      -(pivot[2] || 0),
    );
    Mi.multiplyMatrices(Tp, R).multiply(Tn); // T(+pivot)·R·T(−pivot)
  } else {
    const travel = Number(dof.travel) || 0;
    Mi.makeTranslation(
      (axis[0] || 0) * u * travel,
      (axis[1] || 0) * u * travel,
      (axis[2] || 0) * u * travel,
    );
  }
  return Mi;
}
