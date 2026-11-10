// 運動矩陣數學單元測(node --test,真 three;cadMotion.js 的 apply 共用這份數學)。
// 涵蓋:linear 平移、revolute 繞 pivot 軸旋轉(pivot 不動 + 離軸點轉到位)、
// premultiply 疊加序(後宣告在外層 R_flip·T_jaw)、triangleU 三角波、退化軸防呆。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";

import { frameMatrix, profileFraction, triangleU } from "./cadMotionMath.js";

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

// profile(非線性從動位移表):golden 與 tests/python/packages/cadpy/test_motion_decl.py
// 的 motion_fraction 對拍——播放(這支)與掃掠(python)必須是同一條曲線。
test("profileFraction:u 等分節點分段線性內插;無 profile = u;端外夾值", () => {
  const dof = { profile: [0, 0.1, 0.5, 1] };
  for (const [u, want] of [[0, 0], [0.25, 0.075], [1 / 3, 0.1], [0.5, 0.3], [2 / 3, 0.5], [1, 1], [-1, 0], [2, 1]]) {
    assert.ok(near(profileFraction(dof, u), want, 1e-12), `u=${u} → ${profileFraction(dof, u)},期望 ${want}`);
  }
  assert.equal(profileFraction({}, 0.37), 0.37);
  assert.equal(profileFraction({ profile: [] }, 0.37), 0.37);
});

test("frameMatrix 帶 profile:位移 = profileFraction·travel / angle_deg(linear 與 revolute 都吃)", () => {
  const prof = [0, 0.1, 0.5, 1];
  const lin = frameMatrix(THREE, { type: "linear", axis: [1, 0, 0], travel: 10, profile: prof }, 0.5);
  assert.ok(near(at(lin, 0, 0, 0).x, 3)); // 0.3 × 10(線性會是 5)
  const rev = frameMatrix(
    THREE,
    { type: "revolute", axis: [0, 1, 0], pivot: [0, 0, 0], angle_deg: 90, profile: prof },
    0.5,
  );
  assert.ok(near(rev.elements[0], Math.cos((0.3 * 90 * Math.PI) / 180)), `m00=${rev.elements[0]}`);
  // 端點與線性一致(首 0 尾 1)
  assert.ok(near(at(frameMatrix(THREE, { type: "linear", axis: [1, 0, 0], travel: 10, profile: prof }, 1), 0, 0, 0).x, 10));
});

test("閉鏈連桿(缸推擺臂)用 profile:連桿末端孔心全程與擺臂銷同心(線性 couple 中段偏 >1mm)", () => {
  // 擺臂銷 home (0,0,-R),繞 −Y 過原點轉 θ;連桿另一端跟滑塊沿 +X、自身繞滑塊銷擺 φ
  const R = 35, L = 120, TH = 30, N = 32;
  const chain = (deg) => {
    const t = (deg * Math.PI) / 180;
    const dz = R * (1 - Math.cos(t));
    return [R * Math.sin(t) + L - Math.sqrt(L * L - dz * dz), (Math.asin(dz / L) * 180) / Math.PI];
  };
  const [sEnd, phiEnd] = chain(TH);
  const knots = Array.from({ length: N + 1 }, (_, i) => chain((TH * i) / N));
  const theta = { type: "revolute", axis: [0, -1, 0], pivot: [0, 0, 0], angle_deg: TH };
  const mk = (withProfile) => [
    { type: "revolute", axis: [0, -1, 0], pivot: [-L, 0, -R], angle_deg: phiEnd,
      ...(withProfile ? { profile: knots.map((k) => k[1] / phiEnd) } : {}) },
    { type: "linear", axis: [1, 0, 0], travel: sEnd,
      ...(withProfile ? { profile: knots.map((k) => k[0] / sEnd) } : {}) },
  ];
  const gap = (dofs, u) => {
    const pin = at(frameMatrix(THREE, theta, u), 0, 0, -R);
    const m = new THREE.Matrix4();
    for (const d of dofs) m.premultiply(frameMatrix(THREE, d, u)); // 宣告序:先擺後移
    return pin.distanceTo(at(m, 0, 0, -R)); // 連桿末端孔心 home 與銷同點
  };
  let worstProfile = 0, worstLinear = 0;
  for (let i = 0; i <= 64; i += 1) {
    worstProfile = Math.max(worstProfile, gap(mk(true), i / 64));
    worstLinear = Math.max(worstLinear, gap(mk(false), i / 64));
  }
  assert.ok(worstProfile < 0.01, `profile 殘差 ${worstProfile} mm`);
  assert.ok(worstLinear > 1, `線性 couple 中段殘差應 >1mm,得 ${worstLinear}`);
  assert.ok(near(gap(mk(false), 1), 0, 1e-9)); // 線性在端點仍閉合(所以只看端點會漏)
});
