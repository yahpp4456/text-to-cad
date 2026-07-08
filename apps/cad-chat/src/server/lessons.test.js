// lessons.mjs 單元測(node --test):signature 決定性分類、store 原子寫/損毀/prune、
// per-turn capture 失敗→修法鏈、digest。全部走 mkdtemp 暫存根,不碰真 models/.cadchat/。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./config.mjs";
import {
  beginTurnRecorder,
  buildDigest,
  deleteCase,
  deleteLesson,
  flushTurnRecorder,
  getLessonsDigest,
  noteBuildSuccess,
  noteFixAttempt,
  noteRetry,
  noteValidateSuccess,
  pendingGroups,
  readStore,
  recordApplyFailure,
  recordBuildFailure,
  recordCheckFailure,
  recordTurnError,
  signatureForBuild,
  signatureForCheck,
  updateLessonStatus,
  writeStore,
} from "./lessons.mjs";

const tmpFile = (dir, name = "lessons.json") => path.join(dir, name);
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-lessons-test-"));
const fakeSession = (extra = {}) => ({ sessionId: "s_test", lastPartCount: 0, ...extra });

// ── signature:build ──

test("signatureForBuild:AssertionError 訊息分型(interference / invalid-solid / motion-clear / other)", () => {
  const tb = (msg) =>
    `Traceback (most recent call last):\n  File "x.py", line 1, in <module>\nAssertionError: ${msg}`;
  assert.equal(
    signatureForBuild({ exitCode: 1, stderr: tb("interference: 2 undeclared pair(s): a~b(gap=0.000mm)") }).signature,
    "build:AssertionError:interference",
  );
  assert.equal(
    signatureForBuild({ exitCode: 1, stderr: tb("part: BRepCheck_Analyzer reports an invalid solid") }).signature,
    "build:AssertionError:invalid-solid",
  );
  assert.equal(
    signatureForBuild({ exitCode: 1, stderr: tb("invalid part(s): rod, cap") }).signature,
    "build:AssertionError:invalid-solid",
  );
  assert.equal(
    signatureForBuild({ exitCode: 1, stderr: tb("motion: 3 pair-frame penetration(s) beyond baseline") }).signature,
    "build:AssertionError:motion-clear",
  );
  assert.equal(
    signatureForBuild({ exitCode: 1, stderr: tb("expected 4 holes") }).signature,
    "build:AssertionError:other",
  );
});

test("signatureForBuild:例外類/模組名/fallback,且決定性", () => {
  const syn = signatureForBuild({ exitCode: 1, stderr: "  File \"p.py\", line 3\nSyntaxError: invalid syntax" });
  assert.equal(syn.signature, "build:SyntaxError");
  const mod = signatureForBuild({
    exitCode: 1,
    stderr: "ModuleNotFoundError: No module named 'cadpy.assembly'",
  });
  assert.equal(mod.signature, "build:ModuleNotFoundError:cadpy.assembly");
  // 多行 traceback 取「最後」例外行(chained exception 場景)
  const chained = signatureForBuild({
    exitCode: 1,
    stderr: "KeyError: 'od'\n\nDuring handling...\n\nTypeError: unsupported operand",
  });
  assert.equal(chained.signature, "build:TypeError");
  // 無例外行 fallback
  assert.equal(signatureForBuild({ exitCode: 3, stderr: "boom" }).signature, "build:exit3");
  assert.equal(signatureForBuild({ exitCode: 0, stderr: "" }).signature, "build:no-artifacts");
  // 被 kill 的子程序(POSIX close code null)→ 獨立分型,不混入 no-artifacts
  assert.equal(signatureForBuild({ exitCode: null, stderr: "" }).signature, "build:killed");
  // 無訊息例外(裸 assert):traceback 末行只有裸例外名、無冒號,不得退化成 exit 大雜燴
  assert.equal(
    signatureForBuild({
      exitCode: 1,
      stderr: 'Traceback (most recent call last):\n  File "p.py", line 9, in gen_step\n    assert ok\nAssertionError',
    }).signature,
    "build:AssertionError:other",
  );
  // 決定性:同輸入同輸出
  const a = signatureForBuild({ exitCode: 1, stderr: "ValueError: bad" });
  const b = signatureForBuild({ exitCode: 1, stderr: "ValueError: bad" });
  assert.deepEqual(a, b);
});

// ── signature:validate check ──

test("signatureForCheck:check id + note 前綴分型", () => {
  assert.equal(signatureForCheck({ id: "interference", note: "2 處未宣告干涉" }).signature, "validate:interference");
  assert.equal(signatureForCheck({ id: "valid_solid", note: "無效: rod" }).signature, "validate:valid_solid");
  assert.equal(
    signatureForCheck({ id: "motion_sweep", note: "MOTION 宣告無效: travel 缺" }).signature,
    "validate:motion_sweep:declaration",
  );
  assert.equal(
    signatureForCheck({ id: "motion_sweep", note: "掃掠失敗: RuntimeError: x" }).signature,
    "validate:motion_sweep:sweep-error",
  );
  assert.equal(
    signatureForCheck({ id: "motion_sweep", note: "x: rod~rail +3.20mm³ @ x=12" }).signature,
    "validate:motion_sweep:penetration",
  );
  assert.equal(
    signatureForCheck({ id: "generator", note: "TypeError: gen_step() takes 0 args" }).signature,
    "validate:generator:TypeError",
  );
  assert.equal(signatureForCheck({ id: "facts", note: "inspect 失敗" }).signature, "validate:facts");
});

// ── store ──

test("readStore:不存在→空白;損毀→改名 .corrupt 留證+空白;schemaVersion 不符同損毀", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    assert.deepEqual(readStore(f).cases, []); // 不存在 → 空白,且不建檔
    assert.ok(!fs.existsSync(f));

    fs.writeFileSync(f, "{oops", "utf8");
    const s = readStore(f);
    assert.deepEqual(s.lessons, []);
    assert.ok(!fs.existsSync(f), "損毀檔應被改名");
    assert.ok(
      fs.readdirSync(dir).some((n) => n.startsWith("lessons.json.corrupt-")),
      "應留 .corrupt 證據檔",
    );

    fs.writeFileSync(f, JSON.stringify({ schemaVersion: 99 }), "utf8");
    assert.deepEqual(readStore(f).cases, []);
    assert.ok(!fs.existsSync(f));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStore:tmp+rename 原子寫,寫後可 parse;prune 保 pending 丟最舊已連結", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    const store = readStore(f);
    // 220 筆已連結 + 5 筆 pending → prune 到 ≤200,pending 全保留
    for (let i = 0; i < 220; i++) {
      store.cases.push({ id: `c_${i}`, at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, signature: "build:X", lessonId: "LS-1" });
    }
    for (let i = 0; i < 5; i++) {
      store.cases.push({ id: `p_${i}`, at: "2026-02-01T00:00:00Z", signature: "validate:interference", lessonId: null });
    }
    writeStore(store, f);
    assert.ok(!fs.existsSync(`${f}.tmp`), "tmp 檔應已 rename 掉");
    const back = readStore(f);
    assert.ok(back.cases.length <= 200);
    assert.equal(back.cases.filter((c) => !c.lessonId).length, 5, "pending 應全數保留");
    assert.ok(back.updatedAt, "應戳 updatedAt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prune:pending 每 signature 上限 30(丟最舊)", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    const store = readStore(f);
    for (let i = 0; i < 40; i++) {
      store.cases.push({ id: `c_${i}`, at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, signature: "build:Y", lessonId: null });
    }
    writeStore(store, f);
    const back = readStore(f);
    assert.equal(back.cases.length, 30);
    assert.ok(!back.cases.some((c) => c.id === "c_0"), "最舊的應被丟");
    assert.ok(back.cases.some((c) => c.id === "c_39"), "最新的應保留");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── capture 鏈 ──

test("capture 全鏈:fail → retry → fix(edits) → build 成功 → validate 全綠;turn error 不 resolve", () => {
  const s = fakeSession();
  beginTurnRecorder(s, { userText: "做一個法蘭" });
  assert.ok(s._lessonRec);

  recordBuildFailure(s, { part: "flange", exitCode: 1, stderr: "AssertionError: interference: 1 undeclared pair(s): a~b" });
  recordCheckFailure(s, { part: "flange", check: { id: "interference", ok: false, note: "1 處未宣告干涉" }, partCount: 3 });
  recordTurnError(s, "agent boom", "exception");

  noteRetry(s, { attempt: 1, reason: "a 與 b 干涉", adjustment: "b 的 Y +5" });
  noteFixAttempt(s, { kind: "edits", edits: [{ find: "B_Y = 40", replace: "B_Y = 45" }] });
  noteBuildSuccess(s); // 只閉環 build 類
  const rec = s._lessonRec;
  assert.equal(rec.cases[0].resolved, true);
  assert.equal(rec.cases[0].resolvedBy, "edits");
  assert.deepEqual(rec.cases[0].fixEdits, ["B_Y = 40"]);
  assert.deepEqual(rec.cases[0].retry, { reason: "a 與 b 干涉", adjustment: "b 的 Y +5" });
  assert.equal(rec.cases[1].resolved, false, "validate 案例等 validate 全綠才閉環");

  noteValidateSuccess(s);
  assert.equal(rec.cases[1].resolved, true);
  assert.equal(rec.cases[2].resolved, false, "turn error 永不 resolved");
  assert.equal(rec.cases[2].signature, "turn:exception");
});

test("capture:未 begin(無 _lessonRec)時所有 record*/note* 安全 no-op", () => {
  const s = fakeSession();
  recordBuildFailure(s, { part: "x", exitCode: 1, stderr: "ValueError: v" });
  recordApplyFailure(s, { part: "x", kind: "edits", error: "找不到片段" });
  noteRetry(s, { reason: "r" });
  noteBuildSuccess(s);
  noteValidateSuccess(s);
  assert.ok(!s._lessonRec);
});

test("capture:userText / stderr 過 scrubPaths(不落絕對路徑)+ 長度 cap", () => {
  const s = fakeSession();
  const winRepo = REPO_ROOT.replace(/\//g, "\\");
  beginTurnRecorder(s, { userText: `修 ${winRepo}\\models\\x.py 的干涉` });
  recordBuildFailure(s, {
    part: "x",
    exitCode: 1,
    stderr: `File "${winRepo}\\skills\\cad\\g.py", line 4\nAssertionError: interference: 1 undeclared pair(s): x`,
  });
  const rec = s._lessonRec;
  assert.ok(!rec.userText.includes(winRepo));
  assert.ok(!rec.cases[0].stderrTail.includes(winRepo));
  assert.ok(rec.cases[0].stderrTail.includes("skills"), "相對路徑應保留");

  beginTurnRecorder(s, { userText: "長".repeat(500) });
  assert.ok(s._lessonRec.userText.length <= 200);
});

// ── flush ──

test("flush:落盤配號、達門檻回 eligible、既有教訓直接連結+計數", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    // turn 1:3 筆同 signature → eligible
    const s1 = fakeSession();
    beginTurnRecorder(s1, { userText: "t1" });
    for (let i = 0; i < 3; i++) {
      recordCheckFailure(s1, { check: { id: "interference", ok: false, note: `${i} 處` } });
    }
    const r1 = flushTurnRecorder(s1, { file: f });
    assert.deepEqual(r1.eligible, ["validate:interference"]);
    assert.equal(s1._lessonRec, null, "flush 後 buffer 應清空");
    let store = readStore(f);
    assert.equal(store.cases.length, 3);
    assert.deepEqual(store.cases.map((c) => c.id), ["c_1", "c_2", "c_3"]);

    // 建一條教訓 → turn 2 同 signature 直接連結不再 pending
    store.lessons.push({
      id: "LS-1", signature: "validate:interference", status: "active",
      title: "t", rootCause: "rc", rule: "r", caseCount: 3, resolvedCount: 0,
    });
    store.cases.forEach((c) => (c.lessonId = "LS-1"));
    writeStore(store, f);

    const s2 = fakeSession();
    beginTurnRecorder(s2, { userText: "t2" });
    recordCheckFailure(s2, { check: { id: "interference", ok: false, note: "又干涉" } });
    noteValidateSuccess(s2);
    const r2 = flushTurnRecorder(s2, { file: f });
    assert.deepEqual(r2.eligible, [], "已有教訓不再 pending");
    store = readStore(f);
    const lesson = store.lessons[0];
    assert.equal(lesson.caseCount, 4);
    assert.equal(lesson.resolvedCount, 1);
    assert.ok(lesson.lastHitAt);
    assert.equal(store.cases[3].lessonId, "LS-1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flush 競態:interrupt 後舊 turn 的 finally 不得刷掉/清掉新 turn 的 buffer(rec 身份比對)", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    const s = fakeSession();
    // turn A 開始並捕到一筆紅
    const recA = beginTurnRecorder(s, { userText: "turn A" });
    recordBuildFailure(s, { part: "a", exitCode: 1, stderr: "ValueError: A 的紅" });
    // interrupt 提早放行 busy → turn B 先 begin(覆寫 session._lessonRec)並捕到自己的紅
    const recB = beginTurnRecorder(s, { userText: "turn B" });
    recordBuildFailure(s, { part: "b", exitCode: 1, stderr: "TypeError: B 的紅" });
    // turn A 的 finally 這時才跑:只 flush A 自己的案例,不得動 B 的 buffer
    flushTurnRecorder(s, { file: f, rec: recA });
    assert.equal(s._lessonRec, recB, "A 的 flush 不得清掉 B 的 buffer");
    let store = readStore(f);
    assert.equal(store.cases.length, 1);
    assert.equal(store.cases[0].signature, "build:ValueError");
    assert.equal(store.cases[0].userText, "turn A");
    // turn B 的 finally:正常 flush 自己的
    flushTurnRecorder(s, { file: f, rec: recB });
    assert.equal(s._lessonRec, null);
    store = readStore(f);
    assert.equal(store.cases.length, 2);
    assert.equal(store.cases[1].signature, "build:TypeError");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flush:store 路徑不可寫(指向目錄)→ 不外拋、回空 eligible", () => {
  const dir = mkTmp();
  try {
    const asDir = path.join(dir, "lessons.json");
    fs.mkdirSync(asDir); // 讓 rename 目標是目錄 → writeStore 必炸
    const s = fakeSession();
    beginTurnRecorder(s, { userText: "x" });
    recordBuildFailure(s, { part: "x", exitCode: 1, stderr: "ValueError: v" });
    const r = flushTurnRecorder(s, { file: asDir });
    assert.deepEqual(r, { eligible: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kill switch:CADCHAT_LESSONS=0 → begin/flush/digest 全 no-op", () => {
  process.env.CADCHAT_LESSONS = "0";
  try {
    const s = fakeSession();
    beginTurnRecorder(s, { userText: "x" });
    assert.ok(!s._lessonRec, "停用時不建 buffer");
    assert.equal(getLessonsDigest({ file: path.join(os.tmpdir(), "nope.json") }), "");
  } finally {
    delete process.env.CADCHAT_LESSONS;
  }
});

// ── pending / CRUD ──

test("pendingGroups 依 count 降冪;updateLessonStatus / deleteLesson(刪除解除連結)", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    const store = readStore(f);
    store.cases.push(
      { id: "c_1", at: "2026-01-01T00:00:00Z", signature: "a", lessonId: null },
      { id: "c_2", at: "2026-01-02T00:00:00Z", signature: "b", lessonId: null },
      { id: "c_3", at: "2026-01-03T00:00:00Z", signature: "b", lessonId: null },
      { id: "c_4", at: "2026-01-04T00:00:00Z", signature: "c", lessonId: "LS-1" },
    );
    store.lessons.push({ id: "LS-1", signature: "c", status: "active", title: "t", rootCause: "rc", rule: "r", caseCount: 1 });
    writeStore(store, f);

    const groups = pendingGroups(readStore(f));
    assert.deepEqual(groups.map((g) => [g.signature, g.count]), [["b", 2], ["a", 1]]);

    assert.deepEqual(updateLessonStatus("LS-9", "disabled", { file: f }), { ok: false, error: "not_found" });
    assert.deepEqual(updateLessonStatus("LS-1", "paused", { file: f }), { ok: false, error: "bad_status" });
    assert.deepEqual(updateLessonStatus("LS-1", "disabled", { file: f }), { ok: true });
    assert.equal(readStore(f).lessons[0].status, "disabled");

    assert.deepEqual(deleteLesson("LS-1", { file: f }), { ok: true });
    const after = readStore(f);
    assert.equal(after.lessons.length, 0);
    // 連結案例一併移除:清回 pending 會在下一 turn 被自動重蒸(=刪除被撤銷+白燒 LLM)
    assert.ok(!after.cases.some((c) => c.id === "c_4"), "刪除應一併移除連結案例");
    assert.equal(after.cases.length, 3, "非連結案例不受影響");
    assert.deepEqual(deleteLesson("LS-1", { file: f }), { ok: false, error: "not_found" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pendingGroups 帶逐筆 cases;deleteCase 只刪 pending、不動已連結", () => {
  const dir = mkTmp();
  try {
    const f = tmpFile(dir);
    const store = readStore(f);
    store.cases.push(
      { id: "c_1", at: "2026-01-01T00:00:00Z", signature: "a", note: "n1", source: "validate", partName: "x", lessonId: null },
      { id: "c_2", at: "2026-01-02T00:00:00Z", signature: "a", note: "n2", source: "build", partName: null, lessonId: null },
      { id: "c_3", at: "2026-01-03T00:00:00Z", signature: "c", lessonId: "LS-1" },
    );
    store.lessons.push({ id: "LS-1", signature: "c", status: "active", title: "t", rootCause: "rc", rule: "r", caseCount: 1 });
    writeStore(store, f);

    // pendingGroups 逐筆帶 cases(只含 pending,不含已連結的 c_3)
    const g = pendingGroups(readStore(f)).find((x) => x.signature === "a");
    assert.equal(g.count, 2);
    assert.deepEqual(g.cases.map((c) => c.id), ["c_1", "c_2"]);
    assert.equal(g.cases[0].note, "n1");
    assert.equal(g.cases[0].partName, "x");

    // 壞 id → not_found;已連結案例不得由 deleteCase 刪(避免 caseCount 失真)→ not_found
    assert.deepEqual(deleteCase("c_999", { file: f }), { ok: false, error: "not_found" });
    assert.deepEqual(deleteCase("c_3", { file: f }), { ok: false, error: "not_found" });
    assert.ok(readStore(f).cases.some((c) => c.id === "c_3"), "已連結案例應保留");

    // 正常:刪單筆 pending
    assert.deepEqual(deleteCase("c_1", { file: f }), { ok: true });
    const after = readStore(f);
    assert.ok(!after.cases.some((c) => c.id === "c_1"), "pending 案例應被移除");
    assert.equal(after.cases.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── digest ──

test("buildDigest:空→'';disabled 排除;依 id 排序;>10 條取 caseCount top-10;預算截斷", () => {
  assert.equal(buildDigest({ lessons: [] }), "");
  assert.equal(
    buildDigest({ lessons: [{ id: "LS-1", status: "disabled", rule: "r", rootCause: "rc", caseCount: 9 }] }),
    "",
    "全 disabled → 空",
  );

  const mk = (n, count) => ({
    id: `LS-${n}`, status: "active", rule: `規則${n}`, rootCause: `根因${n}`, caseCount: count,
  });
  const d = buildDigest({ lessons: [mk(2, 1), mk(1, 5)] });
  assert.ok(d.startsWith("# 累積教訓"));
  assert.ok(d.includes("以上方規則為準"), "從屬聲明必在");
  const i1 = d.indexOf("[LS-1]");
  const i2 = d.indexOf("[LS-2]");
  assert.ok(i1 !== -1 && i2 !== -1 && i1 < i2, "依 id 排序,與 caseCount 無關");

  // 12 條 active → 只留 caseCount 前 10
  const many = Array.from({ length: 12 }, (_, i) => mk(i + 1, i + 1));
  const dm = buildDigest({ lessons: many });
  assert.ok(!dm.includes("[LS-1]") && !dm.includes("[LS-2]"), "caseCount 最低兩條應被擠掉");
  assert.ok(dm.includes("[LS-3]") && dm.includes("[LS-12]"));

  // 預算截斷:超長規則只塞得下前幾條
  const long = Array.from({ length: 10 }, (_, i) => mk(i + 1, 1));
  long.forEach((l) => (l.rule = "很長的規則".repeat(30)));
  const dl = buildDigest({ lessons: long }, { budget: 400 });
  assert.ok(dl.length <= 400 + 200, "總量受預算約束");
  assert.ok(dl.split("\n").length < 11);
});
