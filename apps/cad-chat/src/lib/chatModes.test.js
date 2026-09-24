import assert from "node:assert/strict";
import { test } from "node:test";
import { isDesignLike, isMode, MODES, normalizeMode } from "./chatModes.js";

test("MODES:鎖定聊天模式與順序", () => {
  assert.deepEqual(MODES, ["design", "sketch", "library", "cable"]);
});

test("isMode:只接受大小寫相符的白名單值", () => {
  for (const mode of ["design", "sketch", "library", "cable"]) {
    assert.equal(isMode(mode), true);
  }
  for (const value of ["bogus", "", undefined, null, "DESIGN", "CABLE", 3]) {
    assert.equal(isMode(value), false);
  }
});

test("normalizeMode:合法值恆等", () => {
  for (const mode of ["design", "sketch", "library", "cable"]) {
    assert.equal(normalizeMode(mode), mode);
  }
});

test("normalizeMode:垃圾值收斂至 design", () => {
  for (const value of ["bogus", undefined, null, ""]) {
    assert.equal(normalizeMode(value), "design");
  }
});

test("isDesignLike:cable 是設計特化,草模/零件庫/垃圾值都不是", () => {
  assert.equal(isDesignLike("design"), true);
  assert.equal(isDesignLike("cable"), true);
  for (const value of ["sketch", "library", "bogus", undefined, null]) {
    assert.equal(isDesignLike(value), false);
  }
});
