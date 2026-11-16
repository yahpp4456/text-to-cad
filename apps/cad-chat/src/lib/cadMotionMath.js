// 純運動矩陣數學:不依賴 cadjs / render side-effect,供 node --test 直測。
// 播放器(cadMotion.js)與測試共用同一份公式,避免數學漂移。

// 三角波相位 u∈[0,1](0→1→0)。相位錯開(i*0.17)讓多軸疊加時各軸可辨。
export function triangleU(tSec, periodS, i = 0) {
  const T = Math.max(1, Math.min(20, Number(periodS) || 4));
  const phase = (tSec / T + i * 0.17) % 1;
  return 1 - Math.abs(2 * phase - 1);
}

// dof 在群參數 u∈[0,1] 的位移比(乘上 travel / angle_deg 即實際位移)。
// 無 profile = u(線性,舊語意不變);帶 profile(u 等分節點上的位移比,首 0 尾 1)=
// 節點間分段線性內插——閉鏈連桿(滑塊-曲柄、缸推擺臂)的非線性從動用。
// 與 cadpy.motion_decl.motion_fraction 逐式鏡射(掃掠用那支):兩邊不一致=畫面閉合、
// 驗證脫開(或反過來)。cadMotionMath.test.js 有對拍 golden。
export function profileFraction(dof, u) {
  const prof = dof?.profile;
  if (!Array.isArray(prof) || prof.length < 2) return u;
  const n = prof.length - 1;
  const x = Math.min(1, Math.max(0, Number(u) || 0)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return prof[i] + (prof[i + 1] - prof[i]) * (x - i);
}

// 某 dof 在參數 u 的 frame-matrix Mi(THREE.Matrix4);f = profileFraction(dof, u)。
//   linear   → 沿 axis 平移 axis·f·travel。
//   revolute → 繞「過 pivot、方向 axis」的軸旋轉 f·angle_deg:T(+pivot)·R(axis,θ)·T(−pivot)。
export function frameMatrix(THREE, dof, uRaw) {
  const u = profileFraction(dof, uRaw);
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
