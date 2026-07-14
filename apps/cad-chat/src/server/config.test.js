// config 純解析函式單元測(node --test):env 注入,不碰真 process.env。
// (loadBakedEnv 段例外:要驗真檔案載入,對 APP_ROOT/.env.baked 用三段式備份紀律。)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  APP_ROOT,
  agentEnv,
  loadBakedEnv,
  loadEnvFile,
  resolveEffort,
  resolveThinking,
} from "./config.mjs";

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

// loadBakedEnv 讀真檔 APP_ROOT/.env.baked:三段式備份(①殘留備份先還原 ②備份 ③還原)
test("loadBakedEnv:fallback-only——已有任一認證整檔不載(含模型);無認證才載", () => {
  const baked = path.join(APP_ROOT, ".env.baked");
  const bak = `${baked}.test-bak`;
  if (fs.existsSync(bak)) {
    // 前次硬中止殘留:磁碟=測試假資料、備份=真資料 → 先還原
    fs.copyFileSync(bak, baked);
    fs.rmSync(bak, { force: true });
  }
  const hadReal = fs.existsSync(baked);
  if (hadReal) fs.copyFileSync(baked, bak);
  try {
    fs.writeFileSync(baked, "ANTHROPIC_API_KEY=sk-ant-baked\nCADCHAT_MODEL=baked-model\n", "utf8");
    // 已有 OAuth(dev 情境):baked 的 apikey+model 都不得生效——否則 resolveAuth 的
    // 「apikey 勝 oauth」tie-break 會靜默改用 baked key 計費
    const withOauth = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" };
    loadBakedEnv(withOauth);
    assert.ok(!("ANTHROPIC_API_KEY" in withOauth));
    assert.ok(!("CADCHAT_MODEL" in withOauth));
    // 已有 apikey:同樣整檔略過
    const withKey = { ANTHROPIC_API_KEY: "sk-ant-mine" };
    loadBakedEnv(withKey);
    assert.equal(withKey.ANTHROPIC_API_KEY, "sk-ant-mine");
    assert.ok(!("CADCHAT_MODEL" in withKey));
    // 無認證(packaged 乾淨機情境):載入 key + 預設
    const clean = {};
    loadBakedEnv(clean);
    assert.equal(clean.ANTHROPIC_API_KEY, "sk-ant-baked");
    assert.equal(clean.CADCHAT_MODEL, "baked-model");
  } finally {
    if (hadReal) {
      fs.copyFileSync(bak, baked);
      fs.rmSync(bak, { force: true });
    } else {
      fs.rmSync(baked, { force: true });
    }
  }
});

test("agentEnv:依 authMode 刪另一種憑證;恆刪 ELECTRON_RUN_AS_NODE;dev 不設 CLAUDE_CONFIG_DIR", () => {
  const a = agentEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(a.ANTHROPIC_API_KEY, "k"); // apikey 勝
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in a));
  assert.ok(!("ELECTRON_RUN_AS_NODE" in a));
  const b = agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.equal(b.CLAUDE_CODE_OAUTH_TOKEN, "t");
  assert.ok(!("ANTHROPIC_API_KEY" in b));
  // dev(未設 CADCHAT_RUNTIME_ROOT)不注入 CLAUDE_CONFIG_DIR(零回歸;packaged 行為
  // 見 config.packaged.test.js)
  assert.ok(!("CLAUDE_CONFIG_DIR" in a));
});
