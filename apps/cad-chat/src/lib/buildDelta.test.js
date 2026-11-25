import assert from "node:assert/strict";
import { test } from "node:test";

import { diffBuildSummaries, formatBuildDelta } from "./buildDelta.js";

const bbox = [[0, 0, 0], [120, 80, 40]];
const part = (name, overrides = {}) => ({ name, key: name, bbox, volume: 100, ...overrides });
const build = (parts = [], overrides = {}) => ({ parts, partCount: parts.length, bbox, ...overrides });
const line = (prev, cur) => formatBuildDelta(diffBuildSummaries(prev, cur));

test("首次建置列出件數及包絡", () => {
  const delta = diffBuildSummaries(null, build([part("base")]));
  assert.deepEqual(delta, {
    first: true, partCount: { from: null, to: 1 }, size: { from: null, to: [120, 80, 40] },
    sizeChanged: false, added: [], removed: [], changed: [], moved: [], unmeasured: [],
    dofs: { from: null, to: null }, dofsChanged: false, same: false,
  });
  assert.equal(formatBuildDelta(delta), "首次建置:1 件,包絡 120×80×40 mm");
});

test("相同的摘要顯示與上一版相同", () => {
  const delta = diffBuildSummaries(build([part("base")]), build([part("base")]));
  assert.equal(delta.same, true);
  assert.equal(formatBuildDelta(delta), "與上一版相同(1 件,包絡 120×80×40 mm)");
});

test("新增依這一版的零件順序列出", () => {
  assert.equal(line(build(), build([part("z"), part("a")])), "與上一版比:零件 0→2;新增 z、a");
});

test("移除依上一版的零件順序列出", () => {
  assert.equal(line(build([part("old_plate"), part("clamp")]), build()),
    "與上一版比:零件 2→0;移除 old_plate、clamp");
});

test("同名零件的幾何識別碼改變時列出體積", () => {
  const delta = diffBuildSummaries(build([part("lid")]), build([part("lid", { key: "new" })]));
  assert.deepEqual(delta.changed, [{ name: "lid", volume: { from: 100, to: 100 } }]);
  assert.equal(formatBuildDelta(delta), "與上一版比:改了 lid(體積 100→100 mm³)");
});

test("同一幾何的中心位移帶正負號並去除尾零", () => {
  const moved = part("arm", { bbox: [[-1.25, 0, 5], [118.75, 80, 45]] });
  const delta = diffBuildSummaries(build([part("arm")]), build([moved]));
  assert.deepEqual(delta.moved, [{ name: "arm", by: [-1.25, 0, 5] }]);
  assert.equal(formatBuildDelta(delta), "與上一版比:移動 arm(Δ -1.25, 0, +5)");
});

test("多項差異依指定順序接成一行，移除與新增可以同時出現", () => {
  const arm = part("arm");
  const base = part("base", { volume: 12000 });
  const rest = ["a", "b", "c"].map((name) => part(name));
  const prev = build([arm, base, ...rest], { dofCount: 1 });
  const cur = build([
    part("bracket"), part("base", { key: "v2", volume: 11500 }),
    part("arm", { bbox: [[0, 0, 5], [120, 80, 45]] }), ...rest,
  ], { bbox: [[0, 0, 0], [120, 80, 45]], dofCount: 2 });
  const expected = "與上一版比:零件 5→6;新增 bracket;改了 base(體積 12,000→11,500 mm³);移動 arm(Δ 0, 0, +5);包絡 120×80×40 → 120×80×45 mm;自由度 1→2";
  assert.equal(line(prev, cur), expected);
  const withOld = build([...prev.parts, part("old_plate")], { dofCount: 1 });
  assert.equal(line(withOld, cur), expected.replace("零件 5→6;新增 bracket", "新增 bracket;移除 old_plate"));
});

test("比較原始尺寸與中心位移，等於門檻或更小都略過", () => {
  for (const [shift, growth] of [[0.005, 0.04], [0.01, 0.05]]) {
    const prev = build([part("p")], { bbox: [[0, 0, 0], [120.04, 80, 40]] });
    const cur = build([part("p", { bbox: [[shift, 0, 0], [120 + shift, 80, 40]] })],
      { bbox: [[0, 0, 0], [120.04 + growth, 80, 40]] });
    const delta = diffBuildSummaries(prev, cur);
    assert.equal(delta.sizeChanged, false);
    assert.deepEqual(delta.moved, []);
    assert.equal(delta.same, true);
  }
});

test("自由度的新增、改變、移除與缺值", () => {
  for (const [from, to, expected] of [[1, 2, "1→2"], [null, 1, "無→1"], [0, null, "0→無"]]) {
    assert.equal(line(build([], { dofCount: from }), build([], { dofCount: to })), `與上一版比:自由度 ${expected}`);
  }
  const delta = diffBuildSummaries({ dofCount: Infinity }, { dofCount: "1" });
  assert.deepEqual(delta.dofs, { from: null, to: null });
  assert.equal(delta.dofsChanged, false);
});

test("量測失敗及恢復都不算增減或改動，失敗名稱仍會顯示", () => {
  const good = build([part("arm")]);
  const bad = build([{ name: "arm", error: "bad" }]);
  for (const [prev, cur] of [[good, bad], [bad, good]]) {
    const delta = diffBuildSummaries(prev, cur);
    for (const field of ["added", "removed", "changed", "moved"]) assert.deepEqual(delta[field], []);
    assert.equal(delta.same, true);
    assert.deepEqual(delta.unmeasured, cur === bad ? ["arm"] : []);
  }
  assert.match(line(good, bad), /;未量到 arm$/);
  assert.match(line(null, bad), /;未量到 arm$/);
});

test("名稱超過上限時保留清單總件數", () => {
  const cur = build(["z", "b", "c", "a", "t"].map((name) => part(name)));
  const delta = diffBuildSummaries(build(), cur);
  assert.equal(formatBuildDelta(delta), "與上一版比:零件 0→5;新增 z、b、c、a 等 5 件");
  assert.equal(formatBuildDelta(delta, { maxNames: 2 }), "與上一版比:零件 0→5;新增 z、b 等 5 件");
});

test("缺欄位、缺包絡與無效輸入都能處理", () => {
  assert.equal(diffBuildSummaries(null, null), null);
  assert.equal(formatBuildDelta(null), "");
  assert.equal(line(undefined, {}), "首次建置:0 件,包絡未知");
  assert.equal(line({}, {}), "與上一版相同(0 件,包絡未知)");
  const delta = diffBuildSummaries({ parts: 3 }, build([part("missing", { bbox: null })]));
  assert.deepEqual(delta.added, []);
  assert.equal(typeof delta, "object");
  assert.equal(formatBuildDelta({ ...diffBuildSummaries({}, {}), same: false }), "與上一版比:無可辨識的差異");
});

test("包絡各軸最多一位小數，整數省略小數點", () => {
  assert.equal(line(null, build([], { bbox: [[0, 0, 0], [120.04, 120.25, 40]] })),
    "首次建置:0 件,包絡 120×120.3×40 mm");
});
