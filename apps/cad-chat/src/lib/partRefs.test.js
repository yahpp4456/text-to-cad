import assert from "node:assert/strict";
import { test } from "node:test";

import { elementOfToken, elementProvenance, isPartRef, parsePartRef, resolvePartRef, resolveSelector } from "./partRefs.js";

// rig ─ base
//     ├ gantry ─ arm, bolt, bolt
//     ├ head ─ arm
//     └ rail.2(名稱本身帶 .2)
const OCC = [
  { id: "o1", name: "rig", parentId: null },
  { id: "o1.1", name: "base", parentId: "o1" },
  { id: "o1.2", name: "gantry", parentId: "o1" },
  { id: "o1.2.1", name: "arm", parentId: "o1.2" },
  { id: "o1.2.2", name: "bolt", parentId: "o1.2" },
  { id: "o1.2.3", name: "bolt", parentId: "o1.2" },
  { id: "o1.3", name: "head", parentId: "o1" },
  { id: "o1.3.1", name: "arm", parentId: "o1.3" },
  { id: "o1.4", name: "rail.2", parentId: "o1" },
];

test("parsePartRef:路徑與元素", () => {
  assert.deepEqual(parsePartRef("@arm"), { path: ["arm"], element: null });
  assert.deepEqual(parsePartRef(" @gantry/arm.2#f3 "), { path: ["gantry", "arm.2"], element: "f3" });
  for (const bad of ["arm", "@", "@a//b", "@arm#", "@arm#face3", "@arm#f", "@/arm"]) {
    assert.ok(parsePartRef(bad).error, bad);
  }
});

test("唯一的名稱直接解析;元素接在 token 後面", () => {
  assert.deepEqual(resolvePartRef("@base", OCC), { ok: true, token: "#o1.1", name: "base" });
  assert.equal(resolvePartRef("@base#f3", OCC).token, "#o1.1.f3");
  assert.equal(resolvePartRef("@base#e12", OCC).token, "#o1.1.e12");
  assert.equal(resolvePartRef("@gantry", OCC).token, "#o1.2"); // 群組也可以
});

test("同名不只一個:不代選,列出每個候選的寫法與位置", () => {
  const r = resolvePartRef("@arm", OCC);
  assert.equal(r.ok, false);
  assert.match(r.error, /有 2 個同名零件/);
  assert.deepEqual(r.candidates, ["@arm.1 (#o1.2.1,在 gantry/arm)", "@arm.2 (#o1.3.1,在 head/arm)"]);
});

test("路徑或 .N 消歧", () => {
  assert.equal(resolvePartRef("@head/arm", OCC).token, "#o1.3.1");
  assert.equal(resolvePartRef("@rig/gantry/arm", OCC).token, "#o1.2.1");
  assert.equal(resolvePartRef("@arm.2", OCC).token, "#o1.3.1");
  assert.equal(resolvePartRef("@gantry/bolt.2#f1", OCC).token, "#o1.2.3.f1");
  assert.equal(resolvePartRef("@gantry/bolt", OCC).ok, false);
});

test("名稱本身帶 .2 時先照原樣比對", () => {
  assert.equal(resolvePartRef("@rail.2", OCC).token, "#o1.4");
});

test(".N 超出範圍:說有幾個並列出來", () => {
  const r = resolvePartRef("@bolt.3", OCC);
  assert.equal(r.ok, false);
  assert.match(r.error, /同名的只有 2 個/);
  assert.equal(r.candidates.length, 2);
  assert.equal(resolvePartRef("@bolt.0", OCC).ok, false);
});

test("找不到:列出相近的名稱,相近的排前面", () => {
  const r = resolvePartRef("@arms", OCC);
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到零件「@arms」/);
  assert.equal(r.candidates[0], "@arm");
  assert.ok(r.candidates.length <= 8);
  assert.equal(resolvePartRef("@head/bolt", OCC).ok, false); // 路徑不成立也算找不到
});

test("沒有零件表或文法錯", () => {
  assert.equal(resolvePartRef("@base", []).ok, false);
  assert.equal(resolvePartRef("@base#x1", OCC).ok, false);
});

test("resolveSelector:位置 token 原樣通過", () => {
  assert.equal(isPartRef("#o1.2"), false);
  assert.deepEqual(resolveSelector("#o1.2.f3", OCC), { ok: true, token: "#o1.2.f3" });
  assert.equal(resolveSelector("@base", OCC).token, "#o1.1");
});

// ── 穩定名稱(藍圖 C1)──
const NAMES = {
  schemaVersion: 1,
  files: ["rig.py", "gear.py"],
  parts: { base: { f: ["aaaaaaaaaa", "", "cccccccccc"], e: ["eeeeeeeeee"] } },
  lines: { base: { f: [[0, 12], null, [1, 40]], e: [[0, 12]] } },
};

test("@零件#~名稱:解析成目前這次建置的序號", () => {
  assert.equal(resolvePartRef("@base#~cccccccccc", OCC, NAMES).token, "#o1.1.f3");
  assert.equal(resolvePartRef("@base#~eeeeeeeeee", OCC, NAMES).token, "#o1.1.e1");
  assert.equal(resolveSelector("@base#~aaaaaaaaaa", OCC, NAMES).token, "#o1.1.f1");
});

test("穩定名稱找不到:明講它不在了,不找替代品", () => {
  const gone = resolvePartRef("@base#~0123456789", OCC, NAMES);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /沒有名稱為 ~0123456789 的面或邊/);
  assert.deepEqual(gone.candidates, []);
  const none = resolvePartRef("@gantry#~aaaaaaaaaa", OCC, NAMES);
  assert.match(none.error, /沒有穩定名稱可查/);
  assert.match(resolvePartRef("@base#~aaaaaaaaaa", OCC, null).error, /沒有穩定名稱可查/);
  assert.ok(parsePartRef("@base#~XYZ").error);
});

test("elementOfToken / elementProvenance", () => {
  assert.deepEqual(elementOfToken("#o1.1.f3"), { code: "f", index: 3 });
  assert.deepEqual(elementOfToken("#f12"), { code: "f", index: 12 });
  assert.deepEqual(elementOfToken("#o1.2.e7"), { code: "e", index: 7 });
  assert.equal(elementOfToken("#o1.2"), null);
  assert.equal(elementOfToken("#o1.2.v3"), null);
  assert.deepEqual(elementProvenance(NAMES, "base", "#o1.1.f3"), { stable: "cccccccccc", file: "gear.py", line: 40, kind: "f" });
  assert.deepEqual(elementProvenance(NAMES, "base", "#o1.1.f2"), null); // 名稱不唯一、也沒有行號
  assert.equal(elementProvenance(NAMES, "ghost", "#o1.1.f1"), null);
  assert.equal(elementProvenance(NAMES, "base", "#o1.1.f99"), null);
  assert.equal(elementProvenance(null, "base", "#o1.1.f1"), null);
  assert.equal(elementProvenance(NAMES, "__proto__", "#f1"), null);
});
