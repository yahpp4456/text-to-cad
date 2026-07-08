// config 純解析函式單元測(node --test):env 注入,不碰真 process.env。
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEffort, resolveThinking } from "./config.mjs";

test("resolveEffort:預設 xhigh;白名單通過;非法/空 → xhigh", () => {
  assert.equal(resolveEffort({}), "xhigh"); // 未設 → 預設
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "" }), "xhigh");
  for (const v of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(resolveEffort({ CADCHAT_EFFORT: v }), v);
  }
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "XHIGH" }), "xhigh"); // 大小寫不敏感
  assert.equal(resolveEffort({ CADCHAT_EFFORT: " high " }), "high"); // 去空白
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "ultra" }), "xhigh"); // 非法 → 預設
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "0" }), "xhigh");
});

test("resolveThinking:預設 disabled;adaptive/on;正整數 → budgetTokens;0/off/非法 → disabled", () => {
  assert.deepEqual(resolveThinking({}), { type: "disabled" }); // 未設 → 關
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "" }), { type: "disabled" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "off" }), { type: "disabled" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "disabled" }), { type: "disabled" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "0" }), { type: "disabled" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "no" }), { type: "disabled" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "nonsense" }), { type: "disabled" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "adaptive" }), { type: "adaptive" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "ON" }), { type: "adaptive" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "auto" }), { type: "adaptive" });
  assert.deepEqual(resolveThinking({ CADCHAT_THINKING: "8000" }), {
    type: "enabled",
    budgetTokens: 8000,
  });
});
