// users.mjs 單元測(node --test):USER_RE 白名單、rootsFor 推導與 legacy 零回歸 pin。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { MODELS_ROOT, SESSIONS_ROOT } from "./config.mjs";
import { DEMO_MINT_PREFIX, USER_RE, isDemoUser, rootsFor } from "./users.mjs";

test("USER_RE:合法帳號放行", () => {
  for (const ok of ["test", "test2", "A-b_9", "x", "a".repeat(32)]) {
    assert.equal(USER_RE.test(ok), true, ok);
  }
});

test("USER_RE:危險/怪名拒絕", () => {
  for (const bad of ["", "..", "a/b", "a\\b", "a b", "漢", "a".repeat(33), "a\nb", ".", "a.b"]) {
    assert.equal(USER_RE.test(bad), false, JSON.stringify(bad));
  }
});

test("rootsFor(null) === legacy 全域根(零回歸 pin)", () => {
  const r = rootsFor(null);
  assert.equal(r.modelsRoot, MODELS_ROOT);
  assert.equal(r.sessionsRoot, SESSIONS_ROOT);
  // undefined / 空字串同樣走 legacy
  assert.equal(rootsFor(undefined).modelsRoot, MODELS_ROOT);
  assert.equal(rootsFor("").sessionsRoot, SESSIONS_ROOT);
});

test("rootsFor(user):users/<u>/models(/.cadchat),dataRoot 可注入", () => {
  const tmp = path.join("/tmp", "cadchat-users-root");
  const r = rootsFor("test", { dataRoot: tmp });
  assert.equal(r.modelsRoot, path.join(tmp, "users", "test", "models"));
  assert.equal(r.sessionsRoot, path.join(tmp, "users", "test", "models", ".cadchat"));
});

test("isDemoUser:預設 demo,demo-*;鑄造前綴恆 demo(env 無法關掉)", () => {
  // 預設(未設 env)= "demo,demo-*":exact demo + 任何 demo-<id>
  assert.equal(isDemoUser("demo", {}), true);
  assert.equal(isDemoUser("demo-abc123", {}), true);
  assert.equal(isDemoUser("demo-", {}), false); // 光前綴不算(長度需大於前綴)
  assert.equal(isDemoUser("demox", {}), false); // 前綴須是 demo-,不是 demo
  assert.equal(isDemoUser("test", {}), false);
  assert.equal(isDemoUser(null, {}), false);

  // 硬性不變量(re-review R5):env 誤設成不含 demo-* 也不能把鑄造身分關掉。
  assert.equal(isDemoUser("demo-deadbeef", { CADCHAT_DEMO_USERS: "test" }), true);
  assert.equal(isDemoUser("demo-deadbeef", { CADCHAT_DEMO_USERS: "" }), true);
  assert.equal(isDemoUser(`${DEMO_MINT_PREFIX}0123456789abcdef`, { CADCHAT_DEMO_USERS: "demo" }), true);

  // 但非鑄造前綴的名字仍完全由 env 決定(顯式取代預設、不聯集)。
  assert.equal(isDemoUser("demo", { CADCHAT_DEMO_USERS: "guest" }), false);
  assert.equal(isDemoUser("demo", { CADCHAT_DEMO_USERS: "" }), false);
});

test("isDemoUser:通用萬用前綴(非 demo- 也可設)", () => {
  const env = { CADCHAT_DEMO_USERS: "guest-*" };
  assert.equal(isDemoUser("guest-1", env), true);
  assert.equal(isDemoUser("guest-", env), false); // 光前綴不算
  assert.equal(isDemoUser("guest", env), false); // exact 不在清單
  assert.equal(isDemoUser("other-1", env), false);
});
