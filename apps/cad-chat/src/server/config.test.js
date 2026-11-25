// config 純解析函式單元測(node --test):env 注入,不碰真 process.env。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  agentEnv,
  loadEnvFile,
  resolveEffort,
  resolveThinking,
} from "./config.mjs";

test("resolveEffort:預設 medium;白名單通過;非法/空 → medium", () => {
  assert.equal(resolveEffort({}), "medium"); // 未設 → 預設(2026-10-09 由 xhigh 改)
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "" }), "medium");
  for (const v of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(resolveEffort({ CADCHAT_EFFORT: v }), v);
  }
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "XHIGH" }), "xhigh"); // 大小寫不敏感
  assert.equal(resolveEffort({ CADCHAT_EFFORT: " high " }), "high"); // 去空白
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "ultra" }), "medium"); // 非法 → 預設
  assert.equal(resolveEffort({ CADCHAT_EFFORT: "0" }), "medium");
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

test("loadEnvFile:KEY=value 注入、不覆寫已存在、註解/引號/缺檔容忍", () => {
  const f = path.join(os.tmpdir(), `cadchat-envfile-${process.pid}.txt`);
  fs.writeFileSync(
    f,
    ['# 註解', 'A=1', 'B="quoted"', "C='single'", 'BAD_LINE', 'A=overwrite-me-not', ''].join("\n"),
    "utf8",
  );
  try {
    const env = { A: "pre" };
    loadEnvFile(f, env);
    assert.equal(env.A, "pre"); // 已存在不覆寫(真 env / 先載檔優先)
    assert.equal(env.B, "quoted"); // 雙引號去殼
    assert.equal(env.C, "single"); // 單引號去殼
    assert.ok(!("BAD_LINE" in env)); // 無 = 的行忽略
    loadEnvFile(path.join(os.tmpdir(), "cadchat-not-exist-xyz"), env); // 缺檔 no-op 不拋
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test("agentEnv:依 authMode 刪另一種憑證;dev 不設 CLAUDE_CONFIG_DIR", () => {
  const a = agentEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.equal(a.ANTHROPIC_API_KEY, "k"); // apikey 勝
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in a));
  const b = agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.equal(b.CLAUDE_CODE_OAUTH_TOKEN, "t");
  assert.ok(!("ANTHROPIC_API_KEY" in b));
  // dev(未設 CADCHAT_RUNTIME_ROOT)不注入 CLAUDE_CONFIG_DIR(零回歸;雙根部署的行為
  // 見 config.packaged.test.js)
  assert.ok(!("CLAUDE_CONFIG_DIR" in a));
});
