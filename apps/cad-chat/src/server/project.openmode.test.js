// open-project 的兩支純函式單元測(node --test):
//   resolveOpenMode   — 開專案時 mint 出來的 session 該是哪個 mode
//   validateOpenParams— 規格表單「直接生成」帶進來的 PARAMS 覆寫要不要收
// 這兩支是「cable 段一鍵開專案 → 滑桿 400 mode_mismatch」死路的修法核心
// (mint 時不帶 mode 就永遠 design),行為漂了整條零 LLM 生成鏈都會斷。
import assert from "node:assert/strict";
import { test } from "node:test";

import { paramShapeForSpec, resolveOpenMode, validateOpenParams } from "./middleware/project.mjs";

// ── resolveOpenMode ──
test("resolveOpenMode:設計鏈模式(design/cable)照收", () => {
  assert.equal(resolveOpenMode({ mode: "cable" }), "cable");
  assert.equal(resolveOpenMode({ mode: "design" }), "design");
});

test("resolveOpenMode:非設計鏈/垃圾/缺席 → 不 400,退範本家族再退 design", () => {
  // sketch/library 模式下用 FileBrowser 一鍵開專案是既有動線,擋掉是回歸
  assert.equal(resolveOpenMode({ mode: "sketch" }), "design");
  assert.equal(resolveOpenMode({ mode: "library" }), "design");
  assert.equal(resolveOpenMode({ mode: "bogus" }), "design");
  assert.equal(resolveOpenMode({}), "design");
  assert.equal(resolveOpenMode(null), "design");
  // 範本家族兜底:cable 範本從 sketch/library 模式開,session 仍該是 cable
  assert.equal(resolveOpenMode({ mode: "sketch" }, { family: "cable" }), "cable");
  assert.equal(resolveOpenMode({}, { family: "cable" }), "cable");
  // body.mode 優先於家族(使用者在設計模式開 cable 範本 → 留在設計)
  assert.equal(resolveOpenMode({ mode: "design" }, { family: "cable" }), "design");
  // 家族是垃圾/非設計鏈 → 忽略
  assert.equal(resolveOpenMode({}, { family: "library" }), "design");
  assert.equal(resolveOpenMode({}, { family: "bogus" }), "design");
});

// ── validateOpenParams ──
const CUR = { L1: 805.0, L2: 840.0, width: 118.2 };
const RANGES = { L1: { min: 200, max: 2500, step: 5 }, L2: { min: 200, max: 2500, step: 5 } };

test("validateOpenParams:沒帶參數 → 放行、values null(既有 open-project 行為不變)", () => {
  assert.deepEqual(validateOpenParams(undefined, CUR, RANGES), { ok: true, values: null });
  assert.deepEqual(validateOpenParams(null, CUR, RANGES), { ok: true, values: null });
  assert.deepEqual(validateOpenParams({}, CUR, RANGES), { ok: true, values: null });
});

test("validateOpenParams:合法值 → 收(字串數值也轉數)", () => {
  const r = validateOpenParams({ L1: 810, L2: "845" }, CUR, RANGES);
  assert.deepEqual(r, { ok: true, values: { L1: 810, L2: 845 } });
});

test("validateOpenParams:未宣告範圍的鍵不設限(跨參數耦合交給 _check_params)", () => {
  const r = validateOpenParams({ width: 9999 }, CUR, RANGES);
  assert.equal(r.ok, true);
  assert.equal(r.values.width, 9999);
});

test("validateOpenParams:非數值 / 不存在的鍵 / 超出範圍 → 擋下並說原因", () => {
  const bad1 = validateOpenParams({ L1: "abc" }, CUR, RANGES);
  assert.equal(bad1.ok, false);
  assert.ok(bad1.error.includes("L1"));
  const bad2 = validateOpenParams({ nope: 5 }, CUR, RANGES);
  assert.equal(bad2.ok, false);
  assert.ok(bad2.error.includes("nope") && bad2.error.includes("L1"), bad2.error); // 列出可用鍵
  const bad3 = validateOpenParams({ L1: 3000 }, CUR, RANGES);
  assert.equal(bad3.ok, false);
  assert.ok(bad3.error.includes("2500"), bad3.error);
  const bad4 = validateOpenParams({ L1: 100 }, CUR, RANGES);
  assert.equal(bad4.ok, false);
  assert.ok(bad4.error.includes("200"), bad4.error);
});

test("validateOpenParams:形狀不對 / 產生器無 PARAMS → 擋下(不靜默無效)", () => {
  assert.equal(validateOpenParams([1, 2], CUR, RANGES).ok, false);
  assert.equal(validateOpenParams("L1=1", CUR, RANGES).ok, false);
  const noParams = validateOpenParams({ L1: 810 }, null, {});
  assert.equal(noParams.ok, false);
  assert.ok(noParams.error.includes("PARAMS"));
});

// ── paramShapeForSpec:改層數時的鍵集/範圍(Phase 4)──
test("paramShapeForSpec:L 鍵跟著層數增減,head_h 下限跟著層數走", () => {
  const srcValues = { L1: 805, L2: 840, L3: 870, width: 118.2, head_h: 39.5, mount_h: 190, bottom_leg: 70 };
  const srcRanges = {
    L1: { min: 200, max: 2500, step: 5 },
    L2: { min: 200, max: 2500, step: 5 },
    L3: { min: 200, max: 2500, step: 5 },
    head_h: { min: 34.5, max: 80, step: 0.5 },
    width: { min: 50, max: 250, step: 2 },
  };
  // 擴到 4 層:新 L4 沿用 L 範圍模板,head_h 下限 4×11.5=46
  const up = paramShapeForSpec({ layers: 4 }, srcValues, srcRanges);
  assert.deepEqual(Object.keys(up.keys).filter((k) => /^L/.test(k)), ["L1", "L2", "L3", "L4"]);
  assert.deepEqual(up.ranges.L4, { min: 200, max: 2500, step: 5 });
  assert.equal(up.ranges.head_h.min, 46);
  assert.equal(up.ranges.head_h.max, 80, "只動下限,上限/步進保留");
  // 縮到 2 層:L3 消失(不留幽靈鍵/幽靈範圍),head_h 下限降回 23
  const down = paramShapeForSpec({ layers: 2 }, srcValues, srcRanges);
  assert.deepEqual(Object.keys(down.keys).filter((k) => /^L/.test(k)), ["L1", "L2"]);
  assert.equal("L3" in down.ranges, false);
  assert.equal(down.ranges.head_h.min, 23);
  // 非 L 的鍵原樣保留
  assert.equal(down.keys.bottom_leg, 70);
  assert.deepEqual(down.ranges.width, { min: 50, max: 250, step: 2 });
});
