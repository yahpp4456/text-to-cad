// recordManualLesson 單元測(node --test):人工記教訓(是/否卡「是」)直寫 store——
// pending case 欄位齊全、signature slug 邊界、命中既有教訓連結+計數、缺內容/停用 no-op、
// writeStore 失敗會 throw(契約:middleware catch 回 500,不吞成假✓)。
// 走 mkdtemp 暫存根,不碰真 models/.cadchat/。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { manualSignature, readStore, recordManualLesson, writeStore } from "./lessons.mjs";

const tmpFile = (dir) => path.join(dir, "lessons.json");
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-manual-lesson-test-"));

test("manualSignature:slug 正規化(小寫、非字母數字轉 -、去頭尾 -、空/全非 ASCII → misc)", () => {
  assert.equal(manualSignature("mirror-symmetry"), "manual:mirror-symmetry");
  assert.equal(manualSignature("Rib Misplacement!"), "manual:rib-misplacement");
  assert.equal(manualSignature("  --x-- "), "manual:x");
  assert.equal(manualSignature("  "), "manual:misc");
  assert.equal(manualSignature(""), "manual:misc");
  assert.equal(manualSignature("中文標籤"), "manual:misc"); // 全非 ASCII → 空 slug → misc
});

test("recordManualLesson:寫出一筆 source=manual 的 pending case,欄位齊全", () => {
  const dir = mkTmp();
  try {
    const file = tmpFile(dir);
    const r = recordManualLesson(
      {
        sessionId: "s1",
        symptom: "左右肋一內一外,右肋鑽進中央止口孔",
        rootCause: "手繞 Polygon extrude 方向由繞向決定,配單邊 Pos 破壞對稱",
        fix: "extrude(..., both=True) 對稱擠出後再定位",
        tag: "mirror-symmetry",
      },
      { file },
    );
    assert.equal(r.ok, true);
    assert.equal(r.signature, "manual:mirror-symmetry");
    assert.equal(r.linkedLessonId, null);
    const store = readStore(file);
    assert.equal(store.cases.length, 1);
    const c = store.cases[0];
    assert.equal(c.source, "manual");
    assert.equal(c.signature, "manual:mirror-symmetry");
    assert.equal(c.resolved, true);
    assert.equal(c.resolvedBy, "manual");
    assert.equal(c.lessonId, null); // 未命中既有教訓 → pending
    assert.equal(c.sessionId, "s1");
    assert.equal(c.attempt, 0);
    assert.equal(c.stderrTail, null);
    assert.ok(c.note.includes("根因")); // note 併入根因供蒸餾
    assert.equal(c.retry.reason, "左右肋一內一外,右肋鑽進中央止口孔");
    assert.ok(c.retry.adjustment.startsWith("extrude("));
    assert.ok(Array.isArray(c.fixEdits) && c.fixEdits.length === 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordManualLesson:signature 命中既有教訓 → 連結+caseCount++/resolvedCount++,不留 pending", () => {
  const dir = mkTmp();
  try {
    const file = tmpFile(dir);
    const seed = readStore(file);
    seed.lessons.push({
      id: "LS-1",
      signature: "manual:mirror-symmetry",
      status: "active",
      title: "t",
      rootCause: "rc",
      rule: "r",
      caseCount: 2,
      resolvedCount: 1,
    });
    writeStore(seed, file);
    const r = recordManualLesson(
      { symptom: "又見肋錯位", fix: "both=True", tag: "mirror-symmetry" },
      { file },
    );
    assert.equal(r.ok, true);
    assert.equal(r.linkedLessonId, "LS-1");
    const store = readStore(file);
    assert.equal(store.cases[0].lessonId, "LS-1");
    const l = store.lessons.find((x) => x.id === "LS-1");
    assert.equal(l.caseCount, 3);
    assert.equal(l.resolvedCount, 2); // manual case resolved → +1
    assert.equal(store.cases.filter((x) => !x.lessonId).length, 0, "已連結,不落 pending");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordManualLesson:命中教訓的 altSignatures 也連結", () => {
  const dir = mkTmp();
  try {
    const file = tmpFile(dir);
    const seed = readStore(file);
    seed.lessons.push({
      id: "LS-2",
      signature: "build:AssertionError:interference",
      altSignatures: ["manual:rib"],
      status: "active",
      title: "t",
      rootCause: "rc",
      rule: "r",
      caseCount: 1,
      resolvedCount: 0,
    });
    writeStore(seed, file);
    const r = recordManualLesson({ symptom: "s", fix: "f", tag: "rib" }, { file });
    assert.equal(r.linkedLessonId, "LS-2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordManualLesson:症狀與修法皆空 → ok:false empty,完全不動磁碟", () => {
  const dir = mkTmp();
  try {
    const file = tmpFile(dir);
    const r = recordManualLesson({ tag: "x" }, { file });
    assert.equal(r.ok, false);
    assert.equal(r.error, "empty");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordManualLesson:只有 fix(無 symptom)仍可記(至少一項即成立)", () => {
  const dir = mkTmp();
  try {
    const file = tmpFile(dir);
    const r = recordManualLesson({ fix: "both=True", tag: "t" }, { file });
    assert.equal(r.ok, true);
    assert.equal(readStore(file).cases.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordManualLesson:CADCHAT_LESSONS=0 → no-op disabled,不動磁碟", () => {
  const dir = mkTmp();
  try {
    const file = tmpFile(dir);
    const prev = process.env.CADCHAT_LESSONS;
    process.env.CADCHAT_LESSONS = "0";
    try {
      const r = recordManualLesson({ symptom: "x", fix: "y", tag: "z" }, { file });
      assert.equal(r.ok, false);
      assert.equal(r.error, "disabled");
      assert.equal(fs.existsSync(file), false);
    } finally {
      if (prev === undefined) delete process.env.CADCHAT_LESSONS;
      else process.env.CADCHAT_LESSONS = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordManualLesson:writeStore 失敗會 throw(不吞成假✓;middleware 負責 catch 回 500)", () => {
  const dir = mkTmp();
  try {
    const nonexist = path.join(dir, "no", "such", "dir", "lessons.json"); // 父目錄不存在
    assert.throws(() =>
      recordManualLesson({ symptom: "x", fix: "y", tag: "z" }, { file: nonexist }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
