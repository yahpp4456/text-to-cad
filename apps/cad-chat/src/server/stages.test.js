// 階段列自動推進的純函數(node --test):工具名 → 階段、單調遞增、模式開關。
import assert from "node:assert/strict";
import { test } from "node:test";

import { STAGE_BY_TOOL, STAGE_UNDERSTAND, autoStageMode, nextStage, stageForTool } from "./agent/stages.mjs";

test("工具名 → 階段:plan=1 build=2 validate=3 present=4,其他 null", () => {
  assert.equal(stageForTool("mcp__cadchat__emit_plan"), 1);
  assert.equal(stageForTool("mcp__cadchat__cad_build"), 2);
  assert.equal(stageForTool("mcp__cadchat__cad_validate"), 3);
  assert.equal(stageForTool("mcp__cadchat__cad_present"), 4);
  for (const t of ["Read", "Grep", "mcp__cadchat__emit_spec", "mcp__cadchat__emit_params", "mcp__cadchat__cad_source_part", "", undefined]) {
    assert.equal(stageForTool(t), null, `${t} 不該推階段`);
  }
  assert.equal(STAGE_UNDERSTAND, 0);
  assert.equal(Object.keys(STAGE_BY_TOOL).length, 4);
});

test("單調遞增:只在嚴格大於目前階段時發;重試回頭 cad_build 不倒退", () => {
  assert.equal(nextStage(0, "mcp__cadchat__emit_plan"), 1);
  assert.equal(nextStage(1, "mcp__cadchat__cad_build"), 2);
  assert.equal(nextStage(2, "mcp__cadchat__cad_validate"), 3);
  assert.equal(nextStage(3, "mcp__cadchat__cad_build"), null, "驗證失敗後重 build 不倒退到 2");
  assert.equal(nextStage(3, "mcp__cadchat__cad_validate"), null, "同階段不重發");
  assert.equal(nextStage(3, "mcp__cadchat__cad_present"), 4);
  // 迭代回合沒有 emit_plan:直接從 build 起跳
  assert.equal(nextStage(0, "mcp__cadchat__cad_build"), 2);
  // cur 缺席視為 -1
  assert.equal(nextStage(undefined, "mcp__cadchat__emit_plan"), 1);
  assert.equal(nextStage(null, "Read"), null);
});

test("模式開關:design/cable 自動推進,sketch/library 不", () => {
  assert.equal(autoStageMode("design"), true);
  assert.equal(autoStageMode("cable"), true);
  assert.equal(autoStageMode("sketch"), false);
  assert.equal(autoStageMode("library"), false);
});
