// 求值核心單元測:三案例對 ref 閉式運動學的已知值、timeline scrub 決定性、
// 致動器自動配尺寸。ref 對照:ref/3d_sim_examples/sim_example_cylinder_tilt_linkage.html
// 的常數 O=(110,12)、R=42、HCYL=54、L=35(映射到 Z-up:ref y→z、深度→y=25)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { anchorWorld, compileSketch, evalPose, evalProgram } from "./sketchEval.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

const close = (a, b, eps = 1e-6) => {
  assert.ok(Math.abs(a - b) < eps, `期望 ${b}±${eps},得到 ${a}`);
};
const closeV = (v, w, eps = 1e-6) => v.forEach((x, i) => close(x, w[i], eps));
const matPos = (m) => [m[12], m[13], m[14]];

// ref 的 2D 閉式(獨立重推,別 import 被測程式):回傳 Z-up 世界座標
const REF = { O: { x: 110, z: 12 }, R: 42, HCYL: 54, L: 35, Y: 25 };
function refP(thetaDeg) {
  const t = (thetaDeg * Math.PI) / 180;
  return { x: REF.O.x + REF.R * Math.sin(t), z: REF.O.z + REF.R * Math.cos(t) };
}
function refC(thetaDeg) {
  const p = refP(thetaDeg);
  const dz = p.z - REF.HCYL;
  return { x: p.x - Math.sqrt(Math.max(0, REF.L * REF.L - dz * dz)), z: REF.HCYL };
}
function refMu(thetaDeg) {
  const p = refP(thetaDeg);
  const c = refC(thetaDeg);
  const ax = REF.O.x - p.x, az = REF.O.z - p.z;
  const bx = c.x - p.x, bz = c.z - p.z;
  let cs = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz));
  cs = Math.max(-1, Math.min(1, cs));
  let d = (Math.acos(cs) * 180) / Math.PI;
  return d > 90 ? 180 - d : d;
}

// ---------------------------------------------------------------------------
// A. cylinder_tilt:pin_on_line / actuator / coupler / 讀數 對 ref 閉式
// ---------------------------------------------------------------------------

test("cylinder_tilt:θ=0 → pinC=(75,25,54)、rodLen=25、μ=90.0、stroke=0", () => {
  const c = compileSketch(load("cylinder_tilt.json"));
  const f = evalPose(c, c.homeDrives, c.attachInitials);
  closeV(f.points.pinC, [75, 25, 54]);
  close(f.derivedPose.cyl1.len, 70);
  close(f.derivedPose.cyl1.rodLen, 25);
  const byLabel = Object.fromEntries(f.readouts.map((r) => [r.label, r]));
  close(byLabel["缸桿行程"].value, 0);
  close(byLabel["傳動角 μ"].value, 90);
  assert.equal(byLabel["傳動角 μ"].status, "ok");
  assert.equal(byLabel["傳動角 μ"].text, "90.0");
});

test("cylinder_tilt:θ=30 對 ref 閉式(pinC/行程/傳動角)逐值吻合", () => {
  const c = compileSketch(load("cylinder_tilt.json"));
  const f = evalPose(c, { theta: 30 }, c.attachInitials);
  const C = refC(30);
  closeV(f.points.pinC, [C.x, 25, 54], 1e-9);
  close(f.derivedPose.cyl1.len, C.x - 5, 1e-9); // 錨點在 x=5
  const byLabel = Object.fromEntries(f.readouts.map((r) => [r.label, r]));
  close(byLabel["缸桿行程"].value, C.x - 5 - 70, 1e-9);
  close(byLabel["傳動角 μ"].value, refMu(30), 1e-9);
  // coupler 姿態:中點與長度
  close(f.derivedPose.link1.len, 35, 1e-9);
  const P = refP(30);
  closeV(matPos(f.derivedPose.link1.mat), [C.x, 25, 54]); // aim 原點在 from=pinC
  // 平台銷世界位置 = anchorWorld
  closeV(anchorWorld(f, { body: "platform", at: [0, 0, 42] }), [P.x, 25, P.z], 1e-9);
});

test("cylinder_tilt:trace 預取樣 41 點,首尾正確;pingpong 週期 5s", () => {
  const c = compileSketch(load("cylinder_tilt.json"));
  assert.equal(c.traces.length, 1);
  assert.equal(c.traces[0].points.length, 41);
  closeV(c.traces[0].points[0], [110, 25, 62], 1e-9); // θ=0:pivot+(0,0,50)
  const t30 = (30 * Math.PI) / 180;
  closeV(
    c.traces[0].points[40],
    [110 + 50 * Math.sin(t30), 25, 12 + 50 * Math.cos(t30)],
    1e-9,
  );
  // pingpong:period = 2·30/12 = 5s
  close(evalProgram(c, 0).driveValues.theta, 0);
  close(evalProgram(c, 2.5).driveValues.theta, 30);
  close(evalProgram(c, 5).driveValues.theta, 0);
  assert.equal(evalProgram(c, 1).phaseName, null);
});

test("cylinder_tilt:省略 barrelLen → 自動配尺寸(涵蓋行程、桿伸出恆正)", () => {
  const doc = load("cylinder_tilt.json");
  delete doc.derived[1].look.barrelLen;
  const c = compileSketch(doc);
  const dims = c.actuatorDims.cyl1;
  const lenMin = 70;
  const lenMax = refC(30).x - 5;
  assert.ok(dims.barrelLen <= lenMin - 4, "桿伸出恆正(≤ lenMin−4)");
  assert.ok(dims.barrelLen >= lenMax - lenMin + 12, "缸長涵蓋行程");
  close(dims.homeLen, 70, 1e-9);
  close(dims.odR, (1.18 * 25) / 2);
  close(dims.rodR, 5);
});

test("compileSketch:非法 scene 直接 throw(附 errors)", () => {
  assert.throws(
    () => compileSketch({ schemaVersion: 1, bodies: [], drives: [] }),
    (e) => Array.isArray(e.errors) && e.errors.length > 0,
  );
});

// ---------------------------------------------------------------------------
// B. gripper_pickplace:timeline 段值 fold、attach 掃描決定性、交接連續性
// ---------------------------------------------------------------------------

const atT = (c, masterT) => evalProgram(c, masterT * 12); // cycleS = 12

test("gripper:t=0 待機(seated、θ=0、gap=home 12);wrap 回 seated", () => {
  const c = compileSketch(load("gripper_pickplace.json"));
  const p0 = atT(c, 0);
  assert.equal(p0.phaseName, "待機");
  assert.deepEqual(p0.attachStates, { workpiece: "seated" });
  close(p0.driveValues.theta, 0);
  close(p0.driveValues.gap, 12);
  const f0 = evalPose(c, p0.driveValues, p0.attachStates);
  closeV(matPos(f0.derivedPose.workpiece.mat), [60, 25, 56]);
  // 週期 wrap:t=12.1s → masterT≈0.0083 → 回 seated(scrub 決定性,無殘留狀態)
  const pw = evalProgram(c, 12.1);
  assert.equal(pw.attachStates.workpiece, "seated");
});

test("gripper:夾緊段 attach=held 且位置與 seated 連續(零跳動)", () => {
  const c = compileSketch(load("gripper_pickplace.json"));
  const p = atT(c, 0.22);
  assert.equal(p.phaseName, "夾緊");
  assert.equal(p.attachStates.workpiece, "held");
  close(p.driveValues.gap, 6); // 夾取段 fold 後的段首值
  const f = evalPose(c, p.driveValues, p.attachStates);
  closeV(matPos(f.derivedPose.workpiece.mat), [60, 25, 56], 1e-9); // held@θ=0 == seated
});

test("gripper:翻轉搬運段 θ 單調遞增;0.55 交接 placed 位置連續", () => {
  const c = compileSketch(load("gripper_pickplace.json"));
  let prev = -1;
  for (let m = 0.25; m <= 0.54; m += 0.01) {
    const v = atT(c, m).driveValues.theta;
    assert.ok(v >= prev - 1e-9, `θ 應單調(masterT=${m.toFixed(2)})`);
    prev = v;
  }
  const before = atT(c, 0.5499);
  assert.equal(before.attachStates.workpiece, "held");
  const fb = evalPose(c, before.driveValues, before.attachStates);
  const after = atT(c, 0.55);
  assert.equal(after.attachStates.workpiece, "placed");
  close(after.driveValues.theta, 90); // 釋放段首值 = 翻轉終值
  const fa = evalPose(c, after.driveValues, after.attachStates);
  const pb = matPos(fb.derivedPose.workpiece.mat);
  const pa = matPos(fa.derivedPose.workpiece.mat);
  closeV(pa, [-14, 25, 10], 1e-9);
  closeV(pb, pa, 0.05); // 交接零跳動(挑 states 數字時的設計不變量)
});

test("gripper:鏡像夾爪對 — 同一 drive、scale ±1,世界位置對稱", () => {
  const c = compileSketch(load("gripper_pickplace.json"));
  const f = evalPose(c, { theta: 0, gap: 6 }, c.attachInitials);
  closeV(matPos(f.bodyWorld.jaw1), [60, 31, 64]);
  closeV(matPos(f.bodyWorld.jaw2), [60, 19, 64]);
  const byLabel = Object.fromEntries(f.readouts.map((r) => [r.label, r]));
  close(byLabel["指距開口"].value, 12); // factor 2
});

// ---------------------------------------------------------------------------
// C. steering_rack:joint scale/offset 線性映射 = 純滾動 y = −R·θ(rad)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D. belt_drive:皮帶耦合 = 同 drive、scale 同號(從動 = θ×rA/rB,同向減速)
// ---------------------------------------------------------------------------

test("belt_drive:從動輪轉角 = θ×(rA/rB)=θ/3 同號;輪心不動", () => {
  const c = compileSketch(load("belt_drive.json"));
  for (const deg of [0, 90, 270, 360]) {
    const f = evalPose(c, { theta: deg }, c.attachInitials);
    // = +deg/3(非 −deg/3)本身就鎖住「同號=同向」;scale 寫死 7 位小數的截斷容差
    close(f.jointValues.pulley_out, deg / 3, 1e-3);
    closeV(matPos(f.bodyWorld.pulley_out), [90, 0, 60], 1e-9);
  }
  const byLabel = Object.fromEntries(
    evalPose(c, { theta: 270 }, c.attachInitials).readouts.map((r) => [r.label, r]),
  );
  close(byLabel["從動輪轉角"].value, 90, 1e-3);
});

test("steering:rack 位移 = −17.5·θ(rad)(scale 閉式);pinion 轉動", () => {
  const c = compileSketch(load("steering_rack.json"));
  for (const deg of [-45, -10, 0, 22.5, 45]) {
    const f = evalPose(c, { theta: deg }, c.attachInitials);
    const expected = -17.5 * ((deg * Math.PI) / 180);
    close(f.jointValues.rack, expected, 1e-3); // scale 寫死 7 位小數的截斷容差
    closeV(matPos(f.bodyWorld.rack), [17.5, expected, 30], 1e-3);
  }
  const byLabel = Object.fromEntries(
    evalPose(c, { theta: 45 }, c.attachInitials).readouts.map((r) => [r.label, r]),
  );
  close(byLabel["齒條位移"].value, -17.5 * (Math.PI / 4), 1e-3);
});
