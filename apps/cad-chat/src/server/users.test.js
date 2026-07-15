// users.mjs 單元測(node --test):USER_RE 白名單、rootsFor 推導與 legacy 零回歸 pin。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { MODELS_ROOT, SESSIONS_ROOT } from "./config.mjs";
import { USER_RE, rootsFor } from "./users.mjs";

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
