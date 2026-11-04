import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_HISTORY, canRedo, canUndo, createHistory, isDirty, pushState, reconcile, redo, undo } from "./revision.js";

test("push/undo/redo:深拷貝、future 在新 push 時清空、上限裁切", () => {
  const a = { v: 1, arr: [1] };
  let h = createHistory(a);
  a.v = 99; // 原件改動不影響 history
  assert.equal(h.present.v, 1);
  h = pushState(h, { v: 2 });
  h = pushState(h, { v: 3 });
  assert.equal(canUndo(h), true);
  assert.equal(canRedo(h), false);
  h = undo(h);
  assert.equal(h.present.v, 2);
  assert.equal(canRedo(h), true);
  h = redo(h);
  assert.equal(h.present.v, 3);
  h = undo(h);
  h = pushState(h, { v: 4 });
  assert.equal(canRedo(h), false, "新 push 清空 future");
  assert.deepEqual(undo(createHistory({ v: 0 })).present, { v: 0 });
  for (let i = 0; i < MAX_HISTORY + 10; i += 1) h = pushState(h, { v: 100 + i });
  assert.equal(h.past.length, MAX_HISTORY);
});

test("reconcile:ok 換 present 保留 past;conflict 重建;isDirty", () => {
  let h = pushState(createHistory({ v: 1 }), { v: 2 });
  const ok = reconcile(h, { draft: { v: 2, revision: 5 } });
  assert.equal(ok.present.revision, 5);
  assert.equal(ok.past.length, 1);
  const cf = reconcile(h, { conflict: true, draft: { v: 9 } });
  assert.deepEqual(cf, { past: [], present: { v: 9 }, future: [] });
  assert.equal(reconcile(h, null), h);
  assert.equal(isDirty(h, { v: 2 }), false);
  assert.equal(isDirty(h, { v: 1 }), true);
});
