// merge-lessons.mjs 單元測(node --test):兩台電腦教訓庫合併的純函數 mergeStores。
// 核心不變式:id 一律重編(跨機撞號無意義)、以 signature 為 lesson 去重主鍵並權威
// 重連結 cases、caseCount 現算(非跨機相加,保證 idempotent)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeStores } from "../../scripts/merge-lessons.mjs";

// ── 合成 store 小工具 ──
function mkCase(over = {}) {
  return {
    id: over.id || "c_1",
    at: "2026-07-15T00:00:00.000Z",
    sessionId: "s_a",
    turnId: "t_a",
    source: "build",
    signature: "build:X",
    userText: "u",
    note: "n",
    stderrTail: null,
    partName: null,
    partCount: 0,
    attempt: 0,
    retry: null,
    resolved: false,
    resolvedBy: null,
    fixEdits: null,
    lessonId: null,
    ...over,
  };
}
function mkLesson(over = {}) {
  return {
    id: over.id || "LS-1",
    signature: "build:X",
    status: "active",
    title: "t",
    rootCause: "rc",
    rule: "r",
    caseCount: 1,
    resolvedCount: 0,
    graduationCandidate: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    lastHitAt: null,
    distilledAt: "2026-07-15T00:00:00.000Z",
    model: "claude-opus-4-8",
    ...over,
  };
}
function mkStore(over = {}) {
  return {
    schemaVersion: 1,
    updatedAt: null,
    seq: 0,
    lessonSeq: 0,
    cases: [],
    lessons: [],
    distillAttempts: {},
    ...over,
  };
}

test("撞 id 合併:id 全重編、無碰撞、seq/lessonSeq 接續", () => {
  const a = mkStore({
    seq: 1,
    lessonSeq: 1,
    cases: [mkCase({ id: "c_1", signature: "build:X", sessionId: "s_a", turnId: "t_a" })],
    lessons: [mkLesson({ id: "LS-1", signature: "build:X" })],
  });
  const b = mkStore({
    seq: 1,
    lessonSeq: 1,
    cases: [mkCase({ id: "c_1", signature: "turn:agent_error", sessionId: "s_b", turnId: "t_b", source: "turn" })],
    lessons: [mkLesson({ id: "LS-1", signature: "turn:agent_error" })],
  });
  const { store } = mergeStores([a, b]);
  assert.equal(store.cases.length, 2);
  assert.equal(store.lessons.length, 2);
  const caseIds = store.cases.map((c) => c.id);
  const lessonIds = store.lessons.map((l) => l.id);
  assert.deepEqual([...new Set(caseIds)].length, caseIds.length, "case id 不得重複");
  assert.deepEqual([...new Set(lessonIds)].length, lessonIds.length, "lesson id 不得重複");
  assert.deepEqual(lessonIds.sort(), ["LS-1", "LS-2"]);
  assert.equal(store.seq, 2);
  assert.equal(store.lessonSeq, 2);
});

test("同 signature 措辭衝突:distilledAt 平手時挑 caseCount 高的贏,計數現算(非相加),落敗進 report", () => {
  const a = mkStore({
    cases: [
      mkCase({ signature: "build:X", sessionId: "s_a", turnId: "t_a1", at: "2026-07-15T01:00:00.000Z", resolved: true }),
      mkCase({ signature: "build:X", sessionId: "s_a", turnId: "t_a2", at: "2026-07-15T02:00:00.000Z", lessonId: "LS-1" }),
    ],
    lessons: [mkLesson({ id: "LS-1", signature: "build:X", title: "贏家", caseCount: 17, resolvedCount: 7 })],
  });
  const b = mkStore({
    cases: [mkCase({ signature: "build:X", sessionId: "s_b", turnId: "t_b1", at: "2026-07-15T03:00:00.000Z" })],
    lessons: [mkLesson({ id: "LS-1", signature: "build:X", title: "落敗", caseCount: 3 })],
  });
  const { store, report } = mergeStores([a, b], { labels: ["A", "B"] });
  assert.equal(store.lessons.length, 1);
  const lesson = store.lessons[0];
  assert.equal(lesson.title, "贏家");
  // 3 筆 case 全連到這條 lesson;caseCount 現算 = 3(不是 17+3=20)
  assert.equal(lesson.caseCount, 3);
  assert.equal(lesson.resolvedCount, 1);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].kept.title, "贏家");
  assert.equal(report.conflicts[0].dropped.title, "落敗");
});

test("relink 權威:B 機 pending case 命中 A 機 lesson 的 signature → 合併後被連結(跨機蒸餾)", () => {
  const a = mkStore({
    lessons: [mkLesson({ id: "LS-1", signature: "build:interference" })],
    cases: [mkCase({ signature: "build:interference", sessionId: "s_a", turnId: "t_a", lessonId: "LS-1", resolved: true })],
  });
  const b = mkStore({
    // 純 pending,B 機沒這條 lesson
    cases: [mkCase({ signature: "build:interference", sessionId: "s_b", turnId: "t_b", lessonId: null })],
  });
  const { store } = mergeStores([a, b]);
  assert.equal(store.lessons.length, 1);
  const linked = store.cases.filter((c) => c.lessonId === "LS-1");
  assert.equal(linked.length, 2, "B 的 pending case 應被連結到 A 的 lesson");
  assert.equal(store.cases.filter((c) => !c.lessonId).length, 0, "無殘留 pending");
  assert.equal(store.lessons[0].caseCount, 2);
});

test("altSignatures 分群:A 主 sig=X alt=[Y]、B 主 sig=Y → 併成同一群一條 lesson", () => {
  const a = mkStore({
    lessons: [mkLesson({ id: "LS-1", signature: "build:X", altSignatures: ["build:Y"], caseCount: 5 })],
  });
  const b = mkStore({
    lessons: [mkLesson({ id: "LS-1", signature: "build:Y", caseCount: 2 })],
  });
  const { store } = mergeStores([a, b]);
  assert.equal(store.lessons.length, 1, "重疊 signature 必須併成一條");
  const l = store.lessons[0];
  assert.equal(l.signature, "build:X", "贏家(caseCount 高)的主 signature");
  assert.deepEqual(l.altSignatures, ["build:Y"]);
});

test("case 自然鍵去重:兩檔同一筆 case(同 session/turn/at/sig)→ 只留一筆", () => {
  const same = { signature: "build:X", sessionId: "s_a", turnId: "t_a", at: "2026-07-15T00:00:00.000Z", note: "同" };
  const a = mkStore({ cases: [mkCase({ ...same, lessonId: null })] });
  const b = mkStore({ cases: [mkCase({ ...same, resolved: true, lessonId: "LS-9" })] });
  const { store, report } = mergeStores([a, b]);
  assert.equal(store.cases.length, 1);
  assert.equal(report.duplicateCasesRemoved, 1);
  assert.equal(store.cases[0].resolved, true, "撞鍵保留較完整者(resolved 優先)");
});

test("措辭權威=最新蒸餾:本機重蒸餾的新措辭(distilledAt 新)勝過舊快照的高 caseCount", () => {
  // 情境:第一次合併後活檔 caseCount 被現算壓低(3),對方機舊快照還記著膨脹的 17;
  // 本機隨後重蒸餾出新措辭。若以 caseCount 為權威,新措辭會被舊快照永遠壓回去。
  const live = mkStore({
    lessons: [mkLesson({ signature: "build:X", title: "新措辭", rule: "新規則", caseCount: 3, distilledAt: "2026-07-16T00:00:00.000Z" })],
  });
  const staleSnapshot = mkStore({
    lessons: [mkLesson({ signature: "build:X", title: "舊措辭", rule: "舊規則", caseCount: 17, distilledAt: "2026-07-15T00:00:00.000Z" })],
  });
  const { store, report } = mergeStores([staleSnapshot, live], { labels: ["快照", "活檔"] });
  assert.equal(store.lessons.length, 1);
  assert.equal(store.lessons[0].title, "新措辭");
  assert.equal(report.conflicts[0].dropped.title, "舊措辭");
});

test("status 不一致:union 取 active(不漏教訓),但列入 report.statusConflicts 供人工重 disable", () => {
  const a = mkStore({ lessons: [mkLesson({ signature: "build:X", status: "disabled" })] });
  const b = mkStore({ lessons: [mkLesson({ signature: "build:X", status: "active" })] });
  const { store, report } = mergeStores([a, b], { labels: ["A", "B"] });
  assert.equal(store.lessons[0].status, "active");
  assert.equal(report.statusConflicts.length, 1);
  assert.equal(report.statusConflicts[0].signature, "build:X");
  assert.deepEqual(
    report.statusConflicts[0].sources.map((s) => `${s.label}=${s.status}`).sort(),
    ["A=disabled", "B=active"],
  );
  // 全 disabled → disabled,且不算衝突
  const c = mergeStores([a, mkStore({ lessons: [mkLesson({ signature: "build:X", status: "disabled" })] })]);
  assert.equal(c.store.lessons[0].status, "disabled");
  assert.equal(c.report.statusConflicts.length, 0);
});

test("idempotency:把合併結果連同原始輸入再合併,計數與結構穩定", () => {
  const a = mkStore({
    lessons: [mkLesson({ id: "LS-1", signature: "build:X", caseCount: 17 })],
    cases: [
      mkCase({ signature: "build:X", sessionId: "s_a", turnId: "t_1", at: "2026-07-15T01:00:00.000Z", lessonId: "LS-1" }),
      mkCase({ signature: "build:X", sessionId: "s_a", turnId: "t_2", at: "2026-07-15T02:00:00.000Z", lessonId: null }),
    ],
  });
  const b = mkStore({
    lessons: [mkLesson({ id: "LS-1", signature: "turn:E", title: "另一條", createdAt: "2026-07-16T00:00:00.000Z" })],
    cases: [mkCase({ signature: "turn:E", sessionId: "s_b", turnId: "t_3", at: "2026-07-16T01:00:00.000Z", source: "turn" })],
  });
  const m1 = mergeStores([a, b]).store;
  const m2 = mergeStores([m1, a, b]).store; // 重讀同樣快照 + 已合併活檔
  const proj = (s) => ({
    seq: s.seq,
    lessonSeq: s.lessonSeq,
    cases: s.cases.length,
    lessons: s.lessons
      .map((l) => `${l.signature}|${l.caseCount}|${l.resolvedCount}|${l.status}`)
      .sort(),
  });
  assert.deepEqual(proj(m2), proj(m1), "第二次合併結果須與第一次一致");
});
