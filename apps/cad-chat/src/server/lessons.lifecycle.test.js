// 教訓生命週期(2026-11-10 重構):錄製層濾雜訊、狀態決定蓋章、跨機合併取最新決定。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeStores } from "../../scripts/merge-lessons.mjs";
import {
  beginTurnRecorder,
  flushTurnRecorder,
  readStore,
  recordBuildFailure,
  recordTurnError,
  updateLessonStatus,
  writeStore,
} from "./lessons.mjs";

const tmpFile = (tag) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-lessons-${tag}-`)), "lessons.json");
const DOMAIN_ERR = "Traceback (most recent call last):\n  File \"x.py\", line 3\nOCP.OCP.Standard.Standard_DomainError: ";
const VALUE_ERR = "Traceback (most recent call last):\n  File \"x.py\", line 3\nValueError: rail_len(500) 不可大於 base_len(80)";

test("flush:雜訊不落盤(煙測暫存件 / 回合層錯誤 / 滑桿撞防呆),真失敗照記", () => {
  const file = tmpFile("flush");
  const session = { sessionId: "s_test_noise" };
  beginTurnRecorder(session, { userText: "x" });
  recordBuildFailure(session, { part: "tmp_smoke_rollback", exitCode: 1, stderr: DOMAIN_ERR, source: "regen_build" });
  recordBuildFailure(session, { part: "rail_plate", exitCode: 1, stderr: VALUE_ERR, source: "regen_build" });
  recordTurnError(session, "You've hit your session limit", "agent_error");
  recordBuildFailure(session, { part: "linear_stage", exitCode: 1, stderr: DOMAIN_ERR, source: "regen_build" });
  recordBuildFailure(session, { part: "bracket", exitCode: 1, stderr: VALUE_ERR, source: "build" });
  flushTurnRecorder(session, { file });
  const got = readStore(file).cases.map((c) => `${c.partName}|${c.source}|${c.signature}`);
  assert.deepEqual(got, [
    "linear_stage|regen_build|build:Standard_DomainError", // 防呆沒蓋到 = 真訊號
    "bracket|build|build:ValueError", // 代理自己 build 的失敗
  ]);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("updateLessonStatus:蓋 statusAt;停用帶理由、啟用清理由;壞理由拒收", () => {
  const file = tmpFile("status");
  writeStore({ schemaVersion: 1, cases: [], lessons: [{ id: "LS-1", signature: "build:X", status: "active", title: "t", rootCause: "c", rule: "r" }], distillAttempts: {} }, file);
  assert.deepEqual(updateLessonStatus("LS-1", "disabled", { file, now: "2026-11-10T01:00:00.000Z" }), { ok: true });
  let l = readStore(file).lessons[0];
  assert.deepEqual([l.status, l.statusReason, l.statusAt], ["disabled", "manual", "2026-11-10T01:00:00.000Z"]);
  updateLessonStatus("LS-1", "disabled", { file, reason: "graduated", note: "系統提示某段", now: "2026-11-10T02:00:00.000Z" });
  l = readStore(file).lessons[0];
  assert.deepEqual([l.statusReason, l.statusNote], ["graduated", "系統提示某段"]);
  updateLessonStatus("LS-1", "active", { file, now: "2026-11-10T03:00:00.000Z" });
  l = readStore(file).lessons[0];
  assert.equal(l.status, "active");
  assert.equal(l.statusAt, "2026-11-10T03:00:00.000Z");
  assert.ok(!("statusReason" in l) && !("statusNote" in l));
  assert.deepEqual(updateLessonStatus("LS-1", "disabled", { file, reason: "whatever" }), { ok: false, error: "bad_reason" });
  assert.deepEqual(updateLessonStatus("LS-9", "disabled", { file }), { ok: false, error: "not_found" });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

const lessonOf = (extra) => ({ id: "LS-1", signature: "build:X", title: "t", rootCause: "c", rule: "r", createdAt: "2026-07-01T00:00:00.000Z", distilledAt: "2026-07-01T00:00:00.000Z", ...extra });
const storeOf = (lesson) => ({ schemaVersion: 1, cases: [], lessons: [lesson], distillAttempts: {} });

test("mergeStores:帶 statusAt 的決定取最新——A 機停用不再被 B 機的舊 active 復活", () => {
  const a = storeOf(lessonOf({ status: "disabled", statusAt: "2026-11-10T00:00:00.000Z", statusReason: "graduated", statusNote: "已進提示" }));
  const b = storeOf(lessonOf({ status: "active" })); // 沒蓋章的舊資料
  for (const order of [[a, b], [b, a]]) {
    const { store, report } = mergeStores(order, { labels: ["x", "y"] });
    const l = store.lessons[0];
    assert.deepEqual([l.status, l.statusReason, l.statusNote, l.statusAt], ["disabled", "graduated", "已進提示", "2026-11-10T00:00:00.000Z"]);
    assert.equal(report.statusConflicts[0].by, "statusAt");
  }
  // 兩邊都蓋章:較晚的重新啟用勝出
  const c = storeOf(lessonOf({ status: "active", statusAt: "2026-12-01T00:00:00.000Z" }));
  const l2 = mergeStores([a, c], { labels: ["x", "y"] }).store.lessons[0];
  assert.equal(l2.status, "active");
  assert.ok(!("statusReason" in l2));
});

test("mergeStores:全無 statusAt 的舊資料沿用 union(任一 active 即 active)", () => {
  const a = storeOf(lessonOf({ status: "disabled" }));
  const b = storeOf(lessonOf({ status: "active" }));
  const { store, report } = mergeStores([a, b], { labels: ["x", "y"] });
  assert.equal(store.lessons[0].status, "active");
  assert.equal(report.statusConflicts[0].by, "union");
  assert.ok(!("statusAt" in store.lessons[0]));
});
