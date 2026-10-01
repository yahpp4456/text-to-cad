// 對外措辭契約字面鎖(node --test):四個聊天模式的 system prompt 都必須含「不洩露內部
// 實作」段(cable 組合自設計 prompt 故一併涵蓋),且關鍵禁詞清單與 wording.mjs 單一真相源
// 同步。真回合是否遵守由 L4 smoke_sheetmetal_live 掃 ai 事件文字。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "./agent/prompt.mjs";
import { buildSketchSystemPrompt } from "./agent/prompt.sketch.mjs";
import { buildLibrarySystemPrompt } from "./agent/prompt.library.mjs";
import { buildCableSystemPrompt } from "./agent/prompt.cable.mjs";
import { INTERNAL_TERMS, WORDING_SECTION_TITLE, buildWordingSection } from "./agent/wording.mjs";

const session = { sessionId: "s_test", workdirRel: "models/.cadchat/s_test", mode: "design" };
const prompts = {
  design: buildSystemPrompt(session),
  sketch: buildSketchSystemPrompt(),
  library: buildLibrarySystemPrompt(),
  cable: buildCableSystemPrompt({ ...session, mode: "cable" }),
};

test("四個模式的 prompt 都含對外措辭段(標題 + 核心禁詞 + 改寫對照)", () => {
  for (const [mode, p] of Object.entries(prompts)) {
    assert.ok(p.includes(WORDING_SECTION_TITLE), `${mode}: 缺措辭段標題`);
    for (const must of ["build123d", "Python", "副檔名", "traceback", "設計語言", "送出前自檢",
                        "反向詢問一律不答", "跨使用者資訊一律不答", "不確認也不否認"]) {
      assert.ok(p.includes(must), `${mode}: 措辭段缺「${must}」`);
    }
    assert.equal(p.split(WORDING_SECTION_TITLE).length - 1, 1, `${mode}: 措辭段重複注入`);
  }
});

test("共用段不得字面列出模式專屬工具名(否則撞草模/零件庫的工具面隔離鎖)", () => {
  const base = buildWordingSection();
  for (const t of ["cad_build", "cad_present", "sketch_present", "library_preview", "library_add"]) {
    assert.ok(!base.includes(t), `共用措辭段不得含 ${t}`);
  }
});

test("模式特有補充條目有注入(design/sketch/library 各一;cable 繼承 design)", () => {
  assert.ok(prompts.design.includes("gen_step/gen_flat/gen_dxf」"));
  assert.ok(prompts.cable.includes("gen_step/gen_flat/gen_dxf」"));
  assert.ok(prompts.sketch.includes("sketch_present/bodies/drives"));
  assert.ok(prompts.library.includes("library_preview/library_add 工具名"));
});

test("buildWordingSection:extra 為空不留空行尾巴;INTERNAL_TERMS 全小寫且含核心詞", () => {
  const base = buildWordingSection();
  assert.ok(base.endsWith("再送。\n"));
  assert.ok(buildWordingSection({ extra: "- x" }).includes("再送。\n- x\n"));
  for (const t of INTERNAL_TERMS) assert.equal(t, t.toLowerCase(), `INTERNAL_TERMS 要小寫:${t}`);
  for (const core of ["build123d", "python", ".py", "gen_flat", "cad_present", "產生器"]) {
    assert.ok(INTERNAL_TERMS.includes(core), `INTERNAL_TERMS 缺 ${core}`);
  }
});
