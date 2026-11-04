import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDraftView, draftBounds, handleRadius, mirrorPoint } from "./draftView.js";

const DRAFT = {
  schemaVersion: 1,
  symmetry: "XZ",
  curves: [
    { id: "a", kind: "bezier", poles: [[0, 0, 0], [10, 20, 5], [30, 20, -5], [40, 0, 0]] },
    { id: "c", kind: "circle", center: [50, 0, 0], normal: [0, 0, 1], r: 10 },
    { id: "bad", kind: "helix" },
  ],
  surfaces: [],
  ops: [],
};

test("buildDraftView:曲線取樣 + 鏡射複本 + 把手(circle 無把手、壞曲線略過不炸)", () => {
  const v = buildDraftView(DRAFT, "a", { samples: 5 });
  assert.equal(v.curves.length, 4, "a 與 c 各含原件+鏡射");
  const orig = v.curves.find((c) => c.id === "a" && !c.mirror);
  const mir = v.curves.find((c) => c.id === "a" && c.mirror);
  assert.equal(orig.selected, true);
  assert.equal(mir.selected, false);
  assert.deepEqual(orig.pts[0], [0, 0, 0]);
  assert.deepEqual(mir.pts[1], [orig.pts[1][0], -orig.pts[1][1], orig.pts[1][2]], "XZ 鏡射翻 y");
  assert.equal(v.handles.length, 4, "bezier 4 極點;circle 無把手");
  assert.deepEqual(v.handles[1], { curveId: "a", index: 1, p: [10, 20, 5], plane: null, selected: true });
  assert.equal(v.symmetry, "XZ");
});

test("draftBounds/handleRadius:含圓的包圍盒;半徑夾在 [0.3,6];空草稿 null", () => {
  const b = draftBounds(DRAFT);
  assert.deepEqual(b.min, [0, -10, -10]);
  assert.deepEqual(b.max, [60, 20, 10]);
  assert.ok(Math.abs(handleRadius(DRAFT) - 0.72) < 1e-9);
  assert.equal(handleRadius({ curves: [{ id: "l", kind: "line", points: [[0, 0, 0], [1, 0, 0]] }] }), 0.3);
  assert.equal(draftBounds({ curves: [] }), null);
  assert.equal(buildDraftView(null), null);
  assert.deepEqual(mirrorPoint([1, 2, 3], "YZ"), [-1, 2, 3]);
  assert.deepEqual(mirrorPoint([1, 2, 3], null), [1, 2, 3]);
});
