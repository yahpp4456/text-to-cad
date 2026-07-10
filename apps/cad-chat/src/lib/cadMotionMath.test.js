// 運動矩陣數學單元測(node --test,真 three;cadMotion.js 的 apply 共用這份數學)。
// 涵蓋:linear 平移、revolute 繞 pivot 軸旋轉(pivot 不動 + 離軸點轉到位)、
// premultiply 疊加序(後宣告在外層 R_flip·T_jaw)、triangleU 三角波、退化軸防呆。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";

import { frameMatrix, triangleU } from "./cadMotionMath.js";

const at = (m, x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("linear:沿軸平移 axis·u·travel;旋轉塊為 identity;u 線性", () => {
  const Mi = frameMatrix(THREE, { type: "linear", axis: [1, 0, 0], travel: 10 }, 1);
  const p = at(Mi, 0, 0, 0);
  assert.ok(near(p.x, 10) && near(p.y, 0) && near(p.z, 0), `平移錯:${p.x},${p.y},${p.z}`);
  const e = Mi.elements;
  assert.ok(near(e[0], 1) && near(e[5], 1) && near(e[10], 1)); // 上左 3x3 = I
  const half = frameMatrix(THREE, { type: "linear", axis: [1, 0, 0], travel: 10 }, 0.5);
  assert.ok(near(at(half, 0, 0, 0).x, 5)); // u=0.5 → 半程
});

test("revolute:繞過 pivot 的 +Y 軸轉 90°,pivot 不動、離軸點轉到位", () => {
  const pivot = [0, 0, -31];
  const Mi = frameMatrix(THREE, { type: "revolute", axis: [0, 1, 0], pivot, angle_deg: 90 }, 1);
  const pv = at(Mi, pivot[0], pivot[1], pivot[2]);
  assert.ok(near(pv.x, 0) && near(pv.y, 0) && near(pv.z, -31), `pivot 動了:${pv.x},${pv.y},${pv.z}`);
  // (0,0,-51) 距軸 20mm,繞 +Y 90°(THREE 右手系 x'=x·cosθ+z·sinθ)→ (-20,0,-31)
  const q = at(Mi, 0, 0, -51);
  assert.ok(near(q.x, -20) && near(q.y, 0) && near(q.z, -31), `旋轉點錯:${q.x},${q.y},${q.z}`);
  const e = Mi.elements; // 90° 繞 Y → m00≈0、m22≈0、m11=1
  assert.ok(near(e[0], 0) && near(e[10], 0) && near(e[5], 1), `非 90° Y 轉:m00=${e[0]} m22=${e[10]}`);
});

test("revolute:角度隨 u 線性(u=0.5 → 45°)", () => {
  const Mi = frameMatrix(THREE, { type: "revolute", axis: [0, 1, 0], pivot: [0, 0, 0], angle_deg: 90 }, 0.5);
  assert.ok(near(Mi.elements[0], Math.cos(Math.PI / 4)), `m00=${Mi.elements[0]}`);
});

test("premultiply 疊加序:後宣告在外層(R_flip · T_jaw)——finger 同時被爪合+翻轉承載", () => {
  const Tj = frameMatrix(THREE, { type: "linear", axis: [1, 0, 0], travel: 8 }, 1);
  const Rf = frameMatrix(THREE, { type: "revolute", axis: [0, 1, 0], pivot: [0, 0, 0], angle_deg: 90 }, 1);
  const m = new THREE.Matrix4(); // 播放器:identity 起手,依宣告序 premultiply
  m.premultiply(Tj); // jl 先宣告
  m.premultiply(Rf); // flip 後宣告 → 外層
  const expected = new THREE.Matrix4().multiplyMatrices(Rf, Tj); // R_flip · T_jaw
  for (let k = 0; k < 16; k += 1) {
    assert.ok(near(m.elements[k], expected.elements[k]), `elem ${k} 不符`);
  }
});

test("triangleU:0→1→0 三角波(端點/中點)", () => {
  assert.ok(near(triangleU(0, 4, 0), 0)); // phase 0 → u 0
  assert.ok(near(triangleU(2, 4, 0), 1)); // phase .5 → u 1
  const u = triangleU(1, 4, 0);
  assert.ok(u > 0 && u < 1);
});

test("revolute 退化軸(0,0,0)防呆:不產生 NaN", () => {
  const Mi = frameMatrix(THREE, { type: "revolute", axis: [0, 0, 0], pivot: [0, 0, 0], angle_deg: 90 }, 1);
  assert.ok(Mi.elements.every((v) => Number.isFinite(v)));
});
