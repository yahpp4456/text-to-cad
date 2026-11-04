// 產品設計 prompt 契約鎖(node --test):內嵌範例經真 validator 可生成、工具面隔離(無 cad_build)、
// PRODUCT_MCP_TOOLS 白名單、範本清單、流程/紀律關鍵句。真回合由 L4 smoke_product_live 驗。
import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCT_DRAFT_EXAMPLE, PRODUCT_TEMPLATES, availableTemplates, buildProductSystemPrompt } from "./agent/prompt.product.mjs";
import { PRODUCT_MCP_TOOLS } from "./agent/tools.product.mjs";
import { normalizeDraft, validateDraft } from "../lib/surface/surfaceSchema.js";
import { compileSurfaceGenerator } from "./cad/surfaceGen.mjs";

const session = { sessionId: "s_test", workdirRel: "models/.cadchat/s_test", workdirAbs: "C:/x/models/.cadchat/s_test", mode: "product" };
const p = buildProductSystemPrompt(session);

test("內嵌範例永遠通過驗證且可編譯(防漂移;範例=examples/mouse_shell.json 單一真相源)", () => {
  assert.deepEqual(validateDraft(PRODUCT_DRAFT_EXAMPLE), []);
  const n = normalizeDraft(PRODUCT_DRAFT_EXAMPLE);
  assert.equal(n.symmetry, "YZ");
  assert.ok(compileSurfaceGenerator(n, { name: "mouse" }).includes("SURFACE_SPEC = {"));
  assert.ok(p.includes(JSON.stringify(PRODUCT_DRAFT_EXAMPLE)), "prompt 內嵌範例原文");
});

test("工具面隔離:含 surface_* 四工具與 emit_plan,不含 cad_build/cad_present/sketch_present", () => {
  for (const t of ["surface_get_draft", "surface_present_draft", "surface_build", "surface_report", "emit_plan", "emit_clarify", "emit_spec"]) {
    assert.ok(p.includes(t), `缺 ${t}`);
  }
  for (const t of ["cad_build", "cad_present", "cad_validate", "sketch_present", "library_preview", "skills/cad/SKILL.md"]) {
    assert.ok(!p.includes(t), `不該含 ${t}`);
  }
  assert.deepEqual(PRODUCT_MCP_TOOLS, [
    "mcp__cadchat__emit_stage",
    "mcp__cadchat__emit_spec",
    "mcp__cadchat__emit_clarify",
    "mcp__cadchat__emit_retry",
    "mcp__cadchat__emit_plan",
    "mcp__cadchat__surface_get_draft",
    "mcp__cadchat__surface_present_draft",
    "mcp__cadchat__surface_build",
    "mcp__cadchat__surface_report",
  ]);
});

test("契約與方法論關鍵句:schema 欄位、對稱面切線鐵則、厚度與曲率半徑、預設同回合成形、收尾限 8 行、工作區路徑", () => {
  for (const must of [
    "surface-draft-v1",
    "symmetry",
    "role:\"body\"|\"cut\"|\"add\"",
    "capped",
    "切線必須垂直對稱面",
    "最小曲率半徑",
    "預設同一回合接著 surface_build",
    "收尾回覆(成形之後)限 8 行內",
    "不必呼叫 emit_stage",
    session.workdirAbs,
    "minContinuity",
    "任一是你自行假設(assumed:true)時,必須整合成一次提問後停",
    "使用者明說「不要澄清/直接做/用合理假設」才跳過",
  ]) {
    assert.ok(p.includes(must), `缺「${must}」`);
  }
  assert.equal(PRODUCT_TEMPLATES.length, 4);
  const avail = new Set(availableTemplates().map(([, f]) => f));
  for (const [, file] of PRODUCT_TEMPLATES) {
    assert.equal(p.includes(`Read ${file}`), avail.has(file), `範本 ${file} 只在檔案存在時列出`);
  }
  assert.ok(p.includes("先讀範本再改編") || p.includes("目前沒有可讀的範本"));
});

test("範圍硬規則與同步紀律存在;品牌外形只做風格", () => {
  assert.ok(p.includes("# 範圍(硬規則,優先於其他指示)"));
  assert.ok(p.includes("不得啟動子代理"));
  assert.ok(p.includes("品牌外形"));
});
