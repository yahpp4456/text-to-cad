// 無塵電纜模式 prompt 的字面鎖:cable = 設計 prompt(組合)+ 電纜領域段。
// 斷言錨在「漂了會壞行為」的關鍵詞上——工具契約、範本路徑、三鍵 PARAMS 慣例、
// 變寬口袋 API;以及不得混入其他模式的工具詞。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCableSystemPrompt } from "./agent/prompt.cable.mjs";
import { buildSystemPrompt } from "./agent/prompt.mjs";

const session = { workdirRel: "models/.cadchat/s_test", mode: "cable" };

test("cable prompt:完整包含設計 prompt(組合而非複製)", () => {
  const p = buildCableSystemPrompt(session);
  assert.ok(p.startsWith(buildSystemPrompt(session)));
});

test("cable prompt:領域段關鍵契約在場", () => {
  const p = buildCableSystemPrompt(session);
  for (const kw of [
    "無塵電纜模式",
    'PARAMS = {"length"',
    "models/cable_x_v4/cable_x_v4.py",
    "models/cable_x_per_layer/cable_x_per_layer.py",
    "models/cable_y_per_layer/cable_y_per_layer.py",
    'PARAMS = {"L1"',
    "L1 一律對應最內層",
    "cleanroom_sleeve",
    "sleeve_outer_profile",
    "pocket_w 可收 list",
    "web=",
    "edge=",
    "幾層就幾組",
    "cad_import",
    "select_sleeve",
    "_check_params",
    // 規格表單契約(零 LLM 主線的另一半:表單送來的規格 agent 要怎麼接)
    "「電纜規格:」契約",
    "已經給的欄位一律不得再 emit_clarify",
    "不標 assumed",
    "cad_build(params",
  ]) {
    assert.ok(p.includes(kw), `missing: ${kw}`);
  }
});

test("cable prompt:不得混入其他模式的工具詞", () => {
  const p = buildCableSystemPrompt(session);
  assert.ok(!p.includes("library_add"));
  assert.ok(!p.includes("library_preview"));
  assert.ok(!p.includes("sketch_present"));
});
