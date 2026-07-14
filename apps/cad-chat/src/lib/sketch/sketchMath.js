// 草模純數學:vec3 + mat4(column-major,與 three.js Matrix4.fromArray 相容)。
// 禁 import three:server 端(sketch_present 驗證鏈)也會 import 本目錄,而打包版
// asar 排除 node_modules/three;純數學自帶實作纔能前後端共用 + node --test 直測。

export const DEG = Math.PI / 180;

export function deg2rad(d) {
  return (Number(d) || 0) * DEG;
}

// ---------------------------------------------------------------------------
// vec3(plain [x,y,z])
// ---------------------------------------------------------------------------

export function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function vScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function vCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function vLen(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
// 零向量正規化回傳 fallback(預設 +Z),供退化軸防呆。
export function vNorm(a, fallback = [0, 0, 1]) {
  const l = vLen(a);
  if (l < 1e-12) return [...fallback];
  return [a[0] / l, a[1] / l, a[2] / l];
}

// ---------------------------------------------------------------------------
// mat4(長度 16 的 column-major 陣列;m[c*4+r])
// ---------------------------------------------------------------------------

export function mIdentity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mTranslation(x, y, z) {
  const m = mIdentity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

// a·b(先套 b 再套 a)
export function mMul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

// 連乘便利:mChain(A,B,C) = A·B·C
export function mChain(...ms) {
  return ms.reduce((acc, m) => mMul(acc, m));
}

// 繞單位軸 axis 轉 rad(Rodrigues)。呼叫端負責 normalize。
export function mRotationAxis(axis, rad) {
  const [x, y, z] = axis;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  // column-major:每一「行」是基底向量的像
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

// XYZ 順序 Euler(度):R = Rx·Ry·Rz(與 three.js Euler 預設 'XYZ' 同構)。
export function mEulerXYZ(rotDeg) {
  const [rx, ry, rz] = [deg2rad(rotDeg?.[0]), deg2rad(rotDeg?.[1]), deg2rad(rotDeg?.[2])];
  if (!rx && !ry && !rz) return mIdentity();
  const Rx = mRotationAxis([1, 0, 0], rx);
  const Ry = mRotationAxis([0, 1, 0], ry);
  const Rz = mRotationAxis([0, 0, 1], rz);
  return mMul(mMul(Rx, Ry), Rz);
}

// 由正交基底(行向量)+ 平移組矩陣
export function mFromBasis(x, y, z, p) {
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    p[0], p[1], p[2], 1,
  ];
}

// 點變換(w=1)
export function mApplyPoint(m, v) {
  const [x, y, z] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// 取平移分量
export function mPosition(m) {
  return [m[12], m[13], m[14]];
}

// 局部 +Y 對準 from→to 的剛體姿態(圓柱/桿件原生沿 Y 建模的共同慣例)。
// 參考向量取與 dir 最不平行的世界軸(|dot|<0.99 用 Z,否則 X),保正交。
export function aimMatrixY(from, to) {
  const d = vSub(to, from);
  const len = vLen(d);
  const y = vNorm(d, [0, 1, 0]);
  const ref = Math.abs(vDot(y, [0, 0, 1])) < 0.99 ? [0, 0, 1] : [1, 0, 0];
  const x = vNorm(vCross(ref, y));
  const z = vCross(x, y); // 已正交且單位長
  return { mat: mFromBasis(x, y, z, from), len };
}

// 三角波 u∈[0,1](0→1→0);phase 直接以「週期數」計。
export function triangle01(phase) {
  const p = ((phase % 1) + 1) % 1;
  return 1 - Math.abs(2 * p - 1);
}

// smoothstep 緩動
export function smooth01(s) {
  const t = Math.max(0, Math.min(1, s));
  return t * t * (3 - 2 * t);
}
