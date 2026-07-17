// resolveTurnMode 純函式單元測:本 turn 的模式裁定(缺席沿用/相符通過/處女
// session 採納/歷史 session 不符 → mode_mismatch)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveTurnMode } from "./middleware/chat.mjs";

const virgin = () => ({ mode: "design", sdkSessionId: null, lastName: null, version: 0 });
const spoken = () => ({ mode: "design", sdkSessionId: "uuid-x", lastName: null, version: 0 });
const built = () => ({ mode: "design", sdkSessionId: "uuid-x", lastName: "part", version: 3 });

test("body.mode 缺席 → 沿用 session 現值", () => {
  assert.deepEqual(resolveTurnMode({}, virgin()), { ok: true, mode: "design" });
  assert.deepEqual(resolveTurnMode({ mode: null }, { ...virgin(), mode: "sketch" }), {
    ok: true,
    mode: "sketch",
  });
});

test("相符 → 通過;非法值 → bad_mode", () => {
  assert.deepEqual(resolveTurnMode({ mode: "design" }, built()), { ok: true, mode: "design" });
  assert.equal(resolveTurnMode({ mode: "bogus" }, virgin()).ok, false);
  assert.equal(resolveTurnMode({ mode: "bogus" }, virgin()).error, "bad_mode");
});

test("處女 session(無 sdk/產物/版本)不符 → 採納 body.mode(upload 先 mint 情境)", () => {
  const r = resolveTurnMode({ mode: "sketch" }, virgin());
  assert.deepEqual(r, { ok: true, mode: "sketch", adopt: true });
});

test("已開口(sdkSessionId 在)或已 build 的 session 不符 → mode_mismatch 帶真相 mode", () => {
  const r1 = resolveTurnMode({ mode: "sketch" }, spoken());
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "mode_mismatch");
  assert.equal(r1.mode, "design");
  const r2 = resolveTurnMode({ mode: "sketch" }, built());
  assert.equal(r2.error, "mode_mismatch");
  // 反向也一樣:草模 session 收到 design turn
  const r3 = resolveTurnMode({ mode: "design" }, { ...built(), mode: "sketch" });
  assert.equal(r3.error, "mode_mismatch");
  assert.equal(r3.mode, "sketch");
});

test("version>0 但無 sdk/lastName(理論殘態)→ 仍視為有歷史,不採納", () => {
  const r = resolveTurnMode({ mode: "sketch" }, { ...virgin(), version: 2 });
  assert.equal(r.error, "mode_mismatch");
});

test("library:處女 design session 可採納 library", () => {
  const session = { mode: "design", sdkSessionId: null, lastName: null, version: 0 };
  assert.deepEqual(resolveTurnMode({ mode: "library" }, session), {
    ok: true,
    mode: "library",
    adopt: true,
  });
});

test("library:有歷史的 library session 拒絕 design", () => {
  const session = { mode: "library", sdkSessionId: "x" };
  assert.deepEqual(resolveTurnMode({ mode: "design" }, session), {
    ok: false,
    error: "mode_mismatch",
    mode: "library",
  });
});

test("library:library session 收到相符 mode 通過", () => {
  const session = { mode: "library", sdkSessionId: "x" };
  assert.deepEqual(resolveTurnMode({ mode: "library" }, session), {
    ok: true,
    mode: "library",
  });
});

test("library:mode 缺席時沿用 library", () => {
  const session = { mode: "library", sdkSessionId: "x" };
  assert.deepEqual(resolveTurnMode({}, session), { ok: true, mode: "library" });
});
