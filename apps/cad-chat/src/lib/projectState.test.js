// 專案綁定/未儲存判定(node --test):純函數,Header chip 與 App 守衛都靠它。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHIP_TEXT,
  isProjectBound,
  isProjectDirty,
  latestGenVersionNum,
  normalizeProjectBinding,
  projectChipLabel,
  versionNum,
} from "./projectState.js";

const gen = (id) => ({ id, source: "generated" });
const opened = (id) => ({ id, source: "opened" });

test("versionNum:只認 v<數字>", () => {
  assert.equal(versionNum("v12"), 12);
  assert.equal(versionNum("o1"), null);
  assert.equal(versionNum("p3"), null);
  assert.equal(versionNum(""), null);
  assert.equal(versionNum(undefined), null);
});

test("latestGenVersionNum:忽略 opened/o*/p*,取最大而非最後,空 → 0", () => {
  assert.equal(latestGenVersionNum([]), 0);
  assert.equal(latestGenVersionNum(undefined), 0);
  assert.equal(latestGenVersionNum([opened("o1"), opened("o2")]), 0);
  assert.equal(latestGenVersionNum([gen("v1"), gen("v3"), gen("v2")]), 3);
  assert.equal(latestGenVersionNum([gen("v2"), opened("v9")]), 2); // opened 的 v9 不算
  assert.equal(latestGenVersionNum([gen("v2"), { id: "p1" }]), 2);
});

test("normalizeProjectBinding:收伺服端 {dir,ver} 與前端 {dir,savedVer};垃圾 → null", () => {
  assert.deepEqual(normalizeProjectBinding({ dir: "foo", ver: 3, origin: "opened" }, "s1"), {
    dir: "foo",
    savedVer: 3,
    origin: "opened",
    sessionId: "s1",
  });
  assert.deepEqual(normalizeProjectBinding({ dir: "cases/x", savedVer: 1, sessionId: "s2" }), {
    dir: "cases/x",
    savedVer: 1,
    origin: "saved",
    sessionId: "s2",
  });
  // 顯式 sessionId 蓋過物件內的
  assert.equal(normalizeProjectBinding({ dir: "foo", ver: 1, sessionId: "old" }, "new").sessionId, "new");
  assert.equal(normalizeProjectBinding(null), null);
  assert.equal(normalizeProjectBinding("foo"), null);
  assert.equal(normalizeProjectBinding({ dir: "", ver: 1 }), null);
  assert.equal(normalizeProjectBinding({ dir: "foo", ver: "x" }), null);
  assert.equal(normalizeProjectBinding({ dir: "foo", ver: -1 }), null);
  assert.equal(normalizeProjectBinding({ dir: "foo", ver: 2.7 }).savedVer, 2);
});

test("isProjectBound / isProjectDirty:跨 session 殘留視為未綁定;相等不 dirty;更大才 dirty", () => {
  const p = { dir: "foo", savedVer: 2, origin: "saved", sessionId: "s1" };
  assert.equal(isProjectBound(p, "s1"), true);
  assert.equal(isProjectBound(p, "s2"), false);
  assert.equal(isProjectBound(null, "s1"), false);
  assert.equal(isProjectBound(p, null), false);
  assert.equal(isProjectDirty(null, [gen("v9")], "s1"), false);
  assert.equal(isProjectDirty(p, [gen("v1"), gen("v2")], "s1"), false);
  assert.equal(isProjectDirty(p, [gen("v1"), gen("v2"), gen("v3")], "s1"), true); // 回退也 +1 版
  assert.equal(isProjectDirty(p, [gen("v3")], "s2"), false); // 別的 session
  assert.equal(isProjectDirty(p, [opened("o1")], "s1"), false); // 檢視版不算
});

test("projectChipLabel:未綁定 null;兩態字串單一真相", () => {
  assert.equal(projectChipLabel(null, [], "s1"), null);
  const p = { dir: "cases/x", savedVer: 1, origin: "opened", sessionId: "s1" };
  assert.deepEqual(projectChipLabel(p, [gen("v1")], "s1"), {
    dir: "models/cases/x",
    state: "saved",
    stateText: CHIP_TEXT.saved,
  });
  assert.deepEqual(projectChipLabel(p, [gen("v1"), gen("v2")], "s1"), {
    dir: "models/cases/x",
    state: "dirty",
    stateText: CHIP_TEXT.dirty,
  });
  assert.equal(CHIP_TEXT.dirty, "● 未儲存");
  assert.equal(CHIP_TEXT.saved, "✓ 已儲存");
});
