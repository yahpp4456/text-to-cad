// 零件庫 prompt 防漂移鎖(node --test):工具白名單、family 單一真相源與提示契約。
import assert from "node:assert/strict";
import { test } from "node:test";

import { LIBRARY_FAMILIES } from "../lib/libraryFamilies.js";
import { FAMILY_DESC, buildLibrarySystemPrompt } from "./agent/prompt.library.mjs";
import { LIBRARY_MCP_TOOLS } from "./agent/tools.library.mjs";

test("LIBRARY_MCP_TOOLS 白名單:共用 4 + library_preview/library_add", () => {
  assert.deepEqual(
    LIBRARY_MCP_TOOLS,
    [
      "emit_stage",
      "emit_spec",
      "emit_clarify",
      "emit_retry",
      "library_preview",
      "library_add",
    ].map((t) => `mcp__cadchat__${t}`),
  );
});

test("FAMILY_DESC 鍵集合與 LIBRARY_FAMILIES 單一真相源同步", () => {
  assert.deepEqual(Object.keys(FAMILY_DESC).sort(), [...LIBRARY_FAMILIES].sort());
});

test("prompt 契約字面鎖:流程/路徑/slug/family 齊全且工具面隔離", () => {
  const p = buildLibrarySystemPrompt();
  for (const literal of [
    "library_preview",
    "library_add",
    "parts-library",
    "0=選檔 1=訪談 2=收庫",
    "英數小寫",
    "絕對路徑",
    "models/",
  ]) {
    assert.ok(p.includes(literal), `prompt 要含 ${literal}`);
  }
  for (const family of LIBRARY_FAMILIES) {
    assert.ok(p.includes(family), `prompt 要含 family ${family}`);
  }
  assert.ok(!p.includes("cad_build"));
  assert.ok(!p.includes("sketch_present"));
});
