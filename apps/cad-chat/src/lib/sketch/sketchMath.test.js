// 草模純數學單元測(node --test):矩陣/向量/對準/波形的已知值驗證。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aimMatrixY,
  mApplyPoint,
  mEulerXYZ,
  mMul,
  mRotationAxis,
  mTranslation,
  smooth01,
  triangle01,
  vCross,
  vDot,
  vNorm,
} from "./sketchMath.js";

const close = (a, b, eps = 1e-9) => {
  assert.ok(Math.abs(a - b) < eps, `期望 ${b}±${eps},得到 ${a}`);
};
const closeV = (v, w, eps = 1e-9) => v.forEach((x, i) => close(x, w[i], eps));

test("vNorm:零向量回 fallback;一般向量單位化", () => {
  closeV(vNorm([0, 0, 0]), [0, 0, 1]);
  closeV(vNorm([0, 0, 0], [1, 0, 0]), [1, 0, 0]);
  closeV(vNorm([3, 0, 4]), [0.6, 0, 0.8]);
});

test("mRotationAxis:繞 Z 轉 90° 把 X 轉成 Y;繞任意軸保長度", () => {
  const R = mRotationAxis([0, 0, 1], Math.PI / 2);
  closeV(mApplyPoint(R, [1, 0, 0]), [0, 1, 0]);
  const R2 = mRotationAxis(vNorm([1, 1, 1]), 1.234);
  const p = mApplyPoint(R2, [2, -3, 5]);
  close(Math.hypot(...p), Math.hypot(2, -3, 5));
});

test("mMul/mTranslation:T(1,2,3)·R(Z,90°) 先轉再移", () => {
  const M = mMul(mTranslation(1, 2, 3), mRotationAxis([0, 0, 1], Math.PI / 2));
  closeV(mApplyPoint(M, [1, 0, 0]), [1, 3, 3]);
});

test("mEulerXYZ:[0,90,0] 把 X 轉成 −Z(Rx·Ry·Rz 順序)", () => {
  const M = mEulerXYZ([0, 90, 0]);
  closeV(mApplyPoint(M, [1, 0, 0]), [0, 0, -1]);
  closeV(mApplyPoint(mEulerXYZ([0, 0, 0]), [4, 5, 6]), [4, 5, 6]);
});

test("aimMatrixY:局部 +Y 指向 from→to,基底正交、len=距離", () => {
  const { mat, len } = aimMatrixY([1, 2, 3], [1, 2, 13]); // dir = +Z
  close(len, 10);
  closeV(mApplyPoint(mat, [0, 1, 0]), [1, 2, 4]); // 局部 Y 單位向量落在 from+dir
  // 基底正交性
  const x = [mat[0], mat[1], mat[2]];
  const y = [mat[4], mat[5], mat[6]];
  const z = [mat[8], mat[9], mat[10]];
  close(vDot(x, y), 0);
  close(vDot(y, z), 0);
  closeV(vCross(x, y), z);
  // dir 幾乎平行 Z 時改用 X 當參考軸,仍須有解
  const g = aimMatrixY([0, 0, 0], [0, 0, 5]);
  close(g.len, 5);
  closeV(mApplyPoint(g.mat, [0, 5, 0]), [0, 0, 5]);
});

test("triangle01/smooth01:波形已知值", () => {
  close(triangle01(0), 0);
  close(triangle01(0.25), 0.5);
  close(triangle01(0.5), 1);
  close(triangle01(0.75), 0.5);
  close(triangle01(1.25), 0.5); // 週期外 wrap
  close(triangle01(-0.25), 0.5); // 負相位安全
  close(smooth01(0), 0);
  close(smooth01(0.5), 0.5);
  close(smooth01(1), 1);
  close(smooth01(2), 1); // 夾住
});
