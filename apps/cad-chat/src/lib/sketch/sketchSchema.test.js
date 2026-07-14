// schema 驗證器單元測:三 fixtures 全過 + 逐類違規負案例(訊息可回饋 agent 自修)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { normalizeSketch, validateSketch } from "./sketchSchema.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

// 最小合法 scene(負案例在其上做單點破壞)
const minimal = () => ({
  schemaVersion: 1,
  name: "t",
  bodies: [
    { id: "base", parts: [] },
    {
      id: "arm",
      origin: [0, 0, 10],
      joint: { type: "revolute", axis: [0, 1, 0], drive: "a" },
      parts: [{ type: "box", size: [10, 2, 2], "at": [5, 0, 0] }],
    },
  ],
  drives: [{ id: "a", min: 0, max: 90 }],
});

test("四個 fixtures 全數通過驗證(零 error、零 warning)", () => {
  for (const f of [
    "cylinder_tilt.json",
    "gripper_pickplace.json",
    "steering_rack.json",
    "belt_drive.json",
  ]) {
    const res = validateSketch(load(f));
    assert.deepEqual(res.errors, [], `${f} 應無錯誤`);
    assert.deepEqual(res.warnings, [], `${f} 應無警告`);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.order) && res.order.length > 0, `${f} 應回 topo order`);
  }
});

test("normalize:預設值(joint fixed、home=min、role frame、program pingpong)", () => {
  const doc = normalizeSketch({ bodies: [{ id: "b" }], drives: [{ id: "d", min: 2, max: 8 }] });
  assert.equal(doc.bodies[0].joint.type, "fixed");
  assert.equal(doc.bodies[0].role, "frame");
  assert.deepEqual(doc.bodies[0].origin, [0, 0, 0]);
  assert.equal(doc.drives[0].home, 2);
  assert.ok(doc.drives[0].speed > 0);
  assert.equal(doc.program.mode, "pingpong");
});

test("負:schemaVersion 錯 / bodies 空 / drives 0 或 3 個", () => {
  assert.equal(validateSketch({ ...minimal(), schemaVersion: 2 }).ok, false);
  const noBodies = { ...minimal(), bodies: [] };
  assert.ok(validateSketch(noBodies).errors.some((e) => e.path === "bodies"));
  const noDrives = minimal();
  noDrives.drives = [];
  noDrives.bodies[1].joint = { type: "fixed" };
  assert.ok(validateSketch(noDrives).errors.some((e) => e.path === "drives"));
  const three = minimal();
  three.drives = [
    { id: "a", min: 0, max: 1 },
    { id: "b", min: 0, max: 1 },
    { id: "c", min: 0, max: 1 },
  ];
  assert.ok(
    validateSketch(three).errors.some((e) => e.message.includes("DOF≤2")),
    "3 個 drive 要吃 DOF 上限錯誤",
  );
});

test("負:id 重複(跨 bodies/drives 空間)與幽靈引用", () => {
  const dup = minimal();
  dup.drives[0].id = "arm"; // 撞 body id
  assert.ok(validateSketch(dup).errors.some((e) => e.message.includes("重複")));

  const ghost = minimal();
  ghost.bodies[1].joint.drive = "nope";
  assert.ok(validateSketch(ghost).errors.some((e) => e.path.includes("joint.drive")));

  const ghostParent = minimal();
  ghostParent.bodies[1].parent = "nope";
  assert.ok(validateSketch(ghostParent).errors.some((e) => e.path.includes("parent")));
});

test("負:drive 範圍(min≥max / home 出界 / speed≤0)", () => {
  const r1 = minimal();
  r1.drives[0].min = 90;
  r1.drives[0].max = 0;
  assert.equal(validateSketch(r1).ok, false);
  const r2 = minimal();
  r2.drives[0].home = 999;
  assert.ok(validateSketch(r2).errors.some((e) => e.path.includes("home")));
  const r3 = minimal();
  r3.drives[0].speed = 0;
  assert.ok(validateSketch(r3).errors.some((e) => e.path.includes("speed")));
});

test("負:沒人用的 drive 是錯誤", () => {
  const d = minimal();
  d.drives.push({ id: "unused", min: 0, max: 1 });
  assert.ok(validateSketch(d).errors.some((e) => e.message.includes("沒有任何 joint")));
});

test("負:parent 循環(a→b→a)", () => {
  const d = minimal();
  d.bodies[0].parent = "arm";
  d.bodies[1].parent = "base";
  const res = validateSketch(d);
  assert.ok(res.errors.some((e) => e.message.includes("依賴循環")));
  assert.equal(res.order, null);
});

test("負:timeline until 不遞增 / 最後一段 ≠ 1 / 幽靈 attach 狀態", () => {
  const base = minimal();
  base.derived = [
    {
      type: "attach",
      id: "wp",
      look: { parts: [] },
      states: { a: { body: "world", at: [0, 0, 0] }, b: { body: "arm", at: [1, 0, 0] } },
      initial: "a",
    },
  ];
  const t1 = structuredClone(base);
  t1.program = {
    mode: "timeline",
    cycleS: 5,
    phases: [
      { until: 0.6, drives: { a: { to: 90 } } },
      { until: 0.4 },
      { until: 1 },
    ],
  };
  assert.ok(validateSketch(t1).errors.some((e) => e.message.includes("遞增")));

  const t2 = structuredClone(base);
  t2.program = { mode: "timeline", cycleS: 5, phases: [{ until: 0.9, drives: { a: { to: 90 } } }] };
  assert.ok(validateSketch(t2).errors.some((e) => e.message.includes("1.0")));

  const t3 = structuredClone(base);
  t3.program = {
    mode: "timeline",
    cycleS: 5,
    phases: [{ until: 1, drives: { a: { to: 90 } }, attach: { wp: "ghost" } }],
  };
  assert.ok(validateSketch(t3).errors.some((e) => e.message.includes('狀態 "ghost"')));
});

test("負:attach initial 不在 states / state body 幽靈", () => {
  const d = minimal();
  d.derived = [
    {
      type: "attach",
      id: "wp",
      states: { s: { body: "ghost", at: [0, 0, 0] } },
      initial: "nope",
    },
  ];
  const res = validateSketch(d);
  assert.ok(res.errors.some((e) => e.path.includes("initial")));
  assert.ok(res.errors.some((e) => e.path.includes("states.s.body")));
});

test("負:anchor {point} 只能引用 pin_on_line;未知 derived type 是錯", () => {
  const d = minimal();
  d.derived = [
    { type: "actuator", id: "act", from: { body: "world", at: [0, 0, 0] }, to: { body: "arm", at: [1, 0, 0] } },
    { type: "coupler", id: "cp", from: { point: "act" }, to: { body: "arm", at: [0, 0, 0] } },
  ];
  assert.ok(validateSketch(d).errors.some((e) => e.message.includes("pin_on_line")));

  const u = minimal();
  u.derived = [{ type: "magic", id: "m" }];
  assert.ok(validateSketch(u).errors.some((e) => e.message.includes("未知 derived type")));
});

test("警告不擋:未知 role / 未知 part type(ok 仍為 true)", () => {
  const d = minimal();
  d.bodies[1].role = "neon";
  d.bodies[1].parts.push({ type: "torus", at: [0, 0, 0] });
  const res = validateSketch(d);
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.message.includes("neon")));
  assert.ok(res.warnings.some((w) => w.message.includes("torus")));
});

test("負:NaN/非有限數字被 origin/at 檢查抓住", () => {
  const d = minimal();
  d.bodies[1].origin = [0, null, 10];
  assert.ok(validateSketch(d).errors.some((e) => e.path.includes("origin")));
  const d2 = minimal();
  d2.bodies[1].parts[0].size = [10, -2, 2];
  assert.ok(validateSketch(d2).errors.some((e) => e.path.includes("size")));
});

// ---------------------------------------------------------------------------
// 傳動呈現 macro(motor / pulley / belt;2026-07-14 驅動/傳動先問配套)
// ---------------------------------------------------------------------------

const withPart = (part) => {
  const d = minimal();
  d.bodies[0].parts = [part];
  return d;
};

test("負:pulley r/width 必須 > 0;motor 壞 axis / 給了非正尺寸", () => {
  assert.ok(
    validateSketch(withPart({ type: "pulley", axis: "y", r: 0, width: 12, at: [0, 0, 0] }))
      .errors.some((e) => e.path.includes(".r")),
  );
  assert.ok(
    validateSketch(withPart({ type: "pulley", axis: "y", r: 15, width: -1, at: [0, 0, 0] }))
      .errors.some((e) => e.path.includes(".width")),
  );
  assert.ok(
    validateSketch(withPart({ type: "motor", axis: "w", at: [0, 0, 0] }))
      .errors.some((e) => e.path.includes(".axis")),
  );
  assert.ok(
    validateSketch(withPart({ type: "motor", axis: "y", at: [0, 0, 0], shaftLen: 0 }))
      .errors.some((e) => e.path.includes(".shaftLen")),
  );
  // motor 尺寸全省 = 合法(builder 有預設)
  assert.equal(validateSketch(withPart({ type: "motor", axis: "y", at: [0, 0, 0] })).ok, true);
});

test("負:belt 平面性(a/b 沿 axis 座標不同)與帶體可行性(相碰/內含/同心)", () => {
  const belt = (a, b, rA, rB) => ({ type: "belt", axis: "y", a, b, rA, rB, width: 10, at: [0, 0, 0] });
  assert.ok(
    validateSketch(withPart(belt([0, 0, 60], [90, 5, 60], 15, 45)))
      .errors.some((e) => e.message.includes("平面環")),
    "a/b 沿 axis 座標不同要報平面性錯誤",
  );
  // 平面性檢查不被半徑錯誤閘住(錯誤一次全浮現,省 agent retry 輪)
  const both = validateSketch(withPart(belt([0, 0, 60], [90, 5, 60], -1, 45))).errors;
  assert.ok(
    both.some((e) => e.message.includes("平面環")) && both.some((e) => e.path.includes(".rA")),
    "rA 非法時平面性錯誤仍要同輪浮現",
  );
  assert.ok(
    validateSketch(withPart(belt([0, 0, 60], [20, 0, 60], 15, 45)))
      .errors.some((e) => e.message.includes("外公切線")),
    "輪心距 20 ≤ |rA−rB|=30(內含)要報錯",
  );
  assert.ok(
    validateSketch(withPart(belt([0, 0, 60], [50, 0, 60], 15, 45)))
      .errors.some((e) => e.message.includes("rA+rB")),
    "輪心距 50 ≤ rA+rB=60(輪面相碰)要報錯",
  );
  assert.ok(
    validateSketch(withPart(belt([0, 0, 60], [0, 0, 60], 15, 15)))
      .errors.some((e) => e.message.includes("外公切線")),
    "同心(d=0)要報錯",
  );
  assert.ok(
    validateSketch(withPart({ type: "belt", axis: "y", a: [0, 0, 0], b: 3, rA: 15, rB: 45, width: 10, at: [0, 0, 0] }))
      .errors.some((e) => e.message.includes("兩輪心")),
    "b 非 vec3 要報錯",
  );
  // belt 由 a/b 定位:非零 at 或任何 rot 都要被擋(否則帶體與兩輪靜默錯位)
  assert.ok(
    validateSketch(withPart({ ...belt([0, 0, 60], [90, 0, 60], 15, 45), at: [5, 0, 0] }))
      .errors.some((e) => e.message.includes("不支援 at/rot")),
    "belt 帶非零 at 要報錯",
  );
  assert.ok(
    validateSketch(withPart({ ...belt([0, 0, 60], [90, 0, 60], 15, 45), rot: [0, 0, 15] }))
      .errors.some((e) => e.message.includes("不支援 at/rot")),
    "belt 帶 rot 要報錯",
  );
  assert.equal(validateSketch(withPart(belt([0, 0, 60], [90, 0, 60], 15, 45))).ok, true);
});
