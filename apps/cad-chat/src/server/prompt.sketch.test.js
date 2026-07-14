// 草模 prompt 防漂移鎖(node --test;放 src/server/ 頂層讓 L1 glob 掃得到):
// ① 提示內嵌的完整範例必須永遠通過真 validator + 編譯器(schema 改了範例沒跟上
//    → 這裡先紅,不會等到 L4 燒真回合才發現);
// ② 提示契約字面鎖:含草模工具、不含 CAD 工具(選路接錯會漏)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { SKETCH_SCENE_EXAMPLE, buildSketchSystemPrompt } from "./agent/prompt.sketch.mjs";
import { SKETCH_MCP_TOOLS } from "./agent/tools.sketch.mjs";
import { compileSketch } from "../lib/sketch/sketchEval.js";
import { validateSketch } from "../lib/sketch/sketchSchema.js";

test("SKETCH_SCENE_EXAMPLE 通過 validateSketch(零 error、零 warning)且可編譯", () => {
  const res = validateSketch(SKETCH_SCENE_EXAMPLE);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.ok, true);
  const compiled = compileSketch(SKETCH_SCENE_EXAMPLE);
  assert.equal(compiled.dofs.length, 1);
});

test("範例幾何閉合:θ=0 → pinC=(76,25,52)、μ=90°", async () => {
  const { evalPose } = await import("../lib/sketch/sketchEval.js");
  const c = compileSketch(SKETCH_SCENE_EXAMPLE);
  const f = evalPose(c, c.homeDrives, c.attachInitials);
  const [x, y, z] = f.points.pinC;
  assert.ok(Math.abs(x - 76) < 1e-9 && Math.abs(y - 25) < 1e-9 && Math.abs(z - 52) < 1e-9);
  const mu = f.readouts.find((r) => r.label === "傳動角 μ");
  assert.ok(Math.abs(mu.value - 90) < 1e-9);
  assert.equal(mu.status, "ok");
});

test("prompt 契約字面鎖:含 sketch_present/emit_stage(3 段)/DOF,不含 cad_build/Read 指引", () => {
  const p = buildSketchSystemPrompt({ mode: "sketch" });
  assert.ok(p.includes("sketch_present"));
  assert.ok(p.includes("0=理解 1=搭建 2=演示"));
  assert.ok(p.includes("DOF ≤ 2"));
  assert.ok(p.includes(JSON.stringify(SKETCH_SCENE_EXAMPLE, null, 1).slice(0, 60))); // 範例真的內嵌
  assert.ok(!p.includes("cad_build"));
  assert.ok(!p.includes("skills/cad")); // 不誘導讀 CAD 參考檔
});

test("驅動/傳動先問(2026-07-14)措辭鎖:必問規則 + 三傳動積木 + 皮帶/齒輪對耦合符號", () => {
  const p = buildSketchSystemPrompt({ mode: "sketch" });
  assert.ok(p.includes("未指明「驅動方式"), "必問規則(未指明驅動)要在 emit_clarify 教學裡");
  assert.ok(p.includes("整機配置組合"), "options 要教整機配置組合");
  for (const kw of ['type:"motor"', 'type:"pulley"', 'type:"belt"']) {
    assert.ok(p.includes(kw), `parts 教學要含 ${kw}`);
  }
  assert.ok(p.includes("scale = rA/rB"), "皮帶同號耦合規則");
  assert.ok(p.includes("scale = −z1/z2"), "外嚙合齒輪對異號耦合規則");
  assert.ok(p.includes("驅動(軸名)"), "emit_spec 要教逐軸驅動/傳動 chips");
});

test("SKETCH_MCP_TOOLS 白名單:共用 4 + sketch_present,前綴 mcp__cadchat__", () => {
  assert.deepEqual(SKETCH_MCP_TOOLS, [
    "mcp__cadchat__emit_stage",
    "mcp__cadchat__emit_spec",
    "mcp__cadchat__emit_clarify",
    "mcp__cadchat__emit_retry",
    "mcp__cadchat__sketch_present",
  ]);
});
