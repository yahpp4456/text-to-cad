// config.mjs DEMO per-user 分流單元測(node --test):憑證/模型分流、fail-closed、
// 非 demo 純等式(零回歸)、配額旋鈕、model id 驗證。全用注入 env(不碰 process.env)。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentEnv,
  agentEnvFor,
  demoAllowOauth,
  demoReady,
  isKnownModelId,
  resolveDemoModel,
  resolveDemoQuota,
  resolveModel,
  resolveModelFor,
} from "./config.mjs";

test("resolveDemoQuota:預設 10、解析、0=不限、非法回預設", () => {
  assert.equal(resolveDemoQuota({}), 10);
  assert.equal(resolveDemoQuota({ CADCHAT_DEMO_QUOTA: "5" }), 5);
  assert.equal(resolveDemoQuota({ CADCHAT_DEMO_QUOTA: "0" }), 0);
  assert.equal(resolveDemoQuota({ CADCHAT_DEMO_QUOTA: "abc" }), 10);
  assert.equal(resolveDemoQuota({ CADCHAT_DEMO_QUOTA: "-3" }), 10);
});

test("demoReady:有無 CADCHAT_DEMO_API_KEY 決定 demo 是否可用", () => {
  assert.equal(demoReady({}), false);
  assert.equal(demoReady({ CADCHAT_DEMO_API_KEY: "  " }), false);
  assert.equal(demoReady({ CADCHAT_DEMO_API_KEY: "sk-demo" }), true);
  // 全域 ANTHROPIC_API_KEY 不算 demo key(避免誤把訂閱/自用 key 當 demo)
  assert.equal(demoReady({ ANTHROPIC_API_KEY: "sk-global" }), false);
});

test("resolveDemoModel / isKnownModelId", () => {
  assert.equal(resolveDemoModel({}), null);
  assert.equal(resolveDemoModel({ CADCHAT_DEMO_MODEL: "claude-sonnet-5" }), "claude-sonnet-5");
  for (const ok of ["claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5", "claude-opus-4-8"]) {
    assert.equal(isKnownModelId(ok), true, ok);
  }
  for (const bad of ["", "sonnet", "gpt-4", "claude", "claude-", null, undefined]) {
    assert.equal(isKnownModelId(bad), false, JSON.stringify(bad));
  }
});

test("resolveModelFor:非 demo 純等式 resolveModel;demo → demo 模型", () => {
  const env = { CADCHAT_MODEL: "claude-fable-5", CADCHAT_DEMO_MODEL: "claude-sonnet-5" };
  assert.equal(resolveModelFor({ demo: false }, env), resolveModel(env)); // 零回歸
  assert.equal(resolveModelFor({ demo: false }, env), "claude-fable-5");
  assert.equal(resolveModelFor({ demo: true }, env), "claude-sonnet-5");
  assert.equal(resolveModelFor(undefined, env), resolveModel(env)); // ctx 缺 → 非 demo
});

test("agentEnvFor:非 demo 純等式 agentEnv(零回歸)", () => {
  // OAuth 情境:兩者都應刪 ANTHROPIC_API_KEY、保留 OAuth
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: "oauth123", FOO: "bar" };
  assert.deepEqual(agentEnvFor({ demo: false }, oauthEnv), agentEnv(oauthEnv));
  // apikey 情境
  const keyEnv = { ANTHROPIC_API_KEY: "sk-self", CLAUDE_CODE_OAUTH_TOKEN: "o", FOO: "bar" };
  assert.deepEqual(agentEnvFor({ demo: false }, keyEnv), agentEnv(keyEnv));
});

test("agentEnvFor:demo → 注入 demo key、刪 OAuth(絕不走訂閱)", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "oauth123", CADCHAT_DEMO_API_KEY: "sk-demo", FOO: "bar" };
  const out = agentEnvFor({ demo: true }, env);
  assert.equal(out.ANTHROPIC_API_KEY, "sk-demo");
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined); // 訂閱憑證必刪
  assert.equal(out.FOO, "bar"); // 其餘 env 保留
});

test("agentEnvFor:demo 但 key 未設 → ANTHROPIC_API_KEY 空且無 OAuth(fail,不 fallback 訂閱)", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "oauth123" }; // 有訂閱、無 demo key
  const out = agentEnvFor({ demo: true }, env);
  assert.equal(out.ANTHROPIC_API_KEY, ""); // 空 key(chat 已 fail-closed 擋在前;此為縱深防禦)
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined); // 仍不得洩訂閱給 demo
});

// ── 開發逃生門 CADCHAT_DEMO_ALLOW_OAUTH(預設關;僅本人可達階段用)──

test("demoAllowOauth:多種真值/假值解析,預設關", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
    assert.equal(demoAllowOauth({ CADCHAT_DEMO_ALLOW_OAUTH: v }), true, v);
  }
  for (const v of ["", "0", "false", "no", "off", undefined]) {
    assert.equal(demoAllowOauth(v === undefined ? {} : { CADCHAT_DEMO_ALLOW_OAUTH: v }), false, String(v));
  }
});

test("demoReady:逃生門開時無 key 也視為可用", () => {
  assert.equal(demoReady({ CADCHAT_DEMO_ALLOW_OAUTH: "1" }), true);
  assert.equal(demoReady({}), false);
  // key 與逃生門任一即可用
  assert.equal(demoReady({ CADCHAT_DEMO_API_KEY: "sk-demo" }), true);
});

test("agentEnvFor:逃生門開 + 無 key → demo 走全域憑證(開發用 OAuth)", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "oauth123", CADCHAT_DEMO_ALLOW_OAUTH: "1", FOO: "bar" };
  const out = agentEnvFor({ demo: true }, env);
  // = agentEnv(env):OAuth 模式保留 OAuth、刪 ANTHROPIC_API_KEY
  assert.deepEqual(out, agentEnv(env));
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, "oauth123");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
});

test("agentEnvFor:key 存在時逃生門被忽略(key 勝出,仍刪 OAuth)", () => {
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth123",
    CADCHAT_DEMO_API_KEY: "sk-demo",
    CADCHAT_DEMO_ALLOW_OAUTH: "1",
  };
  const out = agentEnvFor({ demo: true }, env);
  assert.equal(out.ANTHROPIC_API_KEY, "sk-demo");
  assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});
