// 派工實驗旗標裁定(node --test):resolveOrch 純函式——body.orch 明示優先、缺席看
// CADCHAT_ORCH、只有 design 且非 demo 才允許;orchDefault 讀 env。
import assert from "node:assert/strict";
import { test } from "node:test";

import { orchDefault } from "./config.mjs";
import { resolveOrch } from "./middleware/chat.mjs";

const design = { mode: "design" };

test("orchDefault:只有 CADCHAT_ORCH=1 為真", () => {
  assert.equal(orchDefault({}), false);
  assert.equal(orchDefault({ CADCHAT_ORCH: "" }), false);
  assert.equal(orchDefault({ CADCHAT_ORCH: "0" }), false);
  assert.equal(orchDefault({ CADCHAT_ORCH: "1" }), true);
  assert.equal(orchDefault({ CADCHAT_ORCH: " 1 " }), true);
});

test("body.orch 明示優先於 env;缺席才看 env;預設 false", () => {
  assert.equal(resolveOrch({ orch: true }, design, { env: {} }), true);
  assert.equal(resolveOrch({ orch: false }, design, { env: { CADCHAT_ORCH: "1" } }), false);
  assert.equal(resolveOrch({}, design, { env: { CADCHAT_ORCH: "1" } }), true);
  assert.equal(resolveOrch({}, design, { env: {} }), false);
  assert.equal(resolveOrch({ orch: "yes" }, design, { env: {} }), false, "非布林不算明示");
  assert.equal(resolveOrch(undefined, design, { env: {} }), false);
});

test("非 design 模式或 demo 一律 false(即使 body/env 要求)", () => {
  for (const mode of ["sketch", "library", "cable"]) {
    assert.equal(resolveOrch({ orch: true }, { mode }, { env: { CADCHAT_ORCH: "1" } }), false, mode);
  }
  assert.equal(resolveOrch({ orch: true }, design, { demo: true, env: { CADCHAT_ORCH: "1" } }), false);
  assert.equal(resolveOrch({ orch: true }, null, { env: {} }), false);
});
