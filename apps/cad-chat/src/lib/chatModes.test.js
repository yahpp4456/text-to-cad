import assert from "node:assert/strict";
import { test } from "node:test";
import { isMode, MODES, normalizeMode } from "./chatModes.js";

test("MODES:鎖定聊天模式與順序", () => {
  assert.deepEqual(MODES, ["design", "sketch", "library"]);
});

test("isMode:只接受大小寫相符的白名單值", () => {
  for (const mode of ["design", "sketch", "library"]) {
    assert.equal(isMode(mode), true);
  }
  for (const value of ["bogus", "", undefined, null, "DESIGN", 3]) {
    assert.equal(isMode(value), false);
  }
});

test("normalizeMode:合法值恆等", () => {
  for (const mode of ["design", "sketch", "library"]) {
    assert.equal(normalizeMode(mode), mode);
  }
});

test("normalizeMode:垃圾值收斂至 design", () => {
  for (const value of ["bogus", undefined, null, ""]) {
    assert.equal(normalizeMode(value), "design");
  }
});
