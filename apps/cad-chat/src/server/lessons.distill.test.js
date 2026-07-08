// lessons.distill.mjs 單元測(node --test,fake callLlm 零真 LLM):
// 提示組裝、輸出 shape gate、create/duplicateOf/duplicateOfStatic 三路寫回、
// 門檻與 force、single-flight、await 期間 append 的併發安全、redistill。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readStore, writeStore } from "./lessons.mjs";
import {
  STATIC_RULES_SUMMARY,
  buildDistillPrompt,
  maybeDistill,
  parseDistillOutput,
  redistillLesson,
} from "./lessons.distill.mjs";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-distill-test-"));
const ENV = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" }; // agentReady=true 且不帶其他變數

const VALID_OUT = JSON.stringify({
  title: "疊層定位魔數",
  rootCause: "多層 Z 定位用目測常數而非逐層累加",
  rule: "疊層定位常數必須以下層頂面高度逐層推導,寫進頂部定位表。",
  graduationCandidate: true,
  duplicateOfStatic: false,
  duplicateOf: null,
});

function seedPending(file, signature, n, { resolved = false } = {}) {
  const store = readStore(file);
  for (let i = 0; i < n; i++) {
    store.seq += 1;
    store.cases.push({
      id: `c_${store.seq}`,
      at: `2026-07-0${(i % 7) + 1}T00:00:00Z`,
      sessionId: "s_t",
      turnId: "t_t",
      source: "validate",
      signature,
      userText: `需求 ${i}`,
      note: `錯誤 ${i}`,
      stderrTail: null,
      partName: "x",
      partCount: 3,
      attempt: 1,
      retry: i === 0 ? { reason: "干涉", adjustment: "Y+5" } : null,
      resolved,
      resolvedBy: resolved ? "edits" : null,
      fixEdits: resolved ? ["Y = 40"] : null,
      lessonId: null,
    });
  }
  writeStore(store, file);
}

// ── 提示與解析(純函式)──

test("buildDistillPrompt:含 signature/案例欄位/靜態規則/既有教訓/輸出要求", () => {
  const p = buildDistillPrompt(
    "validate:interference",
    [
      {
        userText: "做龍門",
        note: "2 處未宣告干涉",
        retry: { reason: "滑座撞導軌", adjustment: "上移 12" },
        fixEdits: ["RAIL_Z = 20"],
        resolved: true,
        resolvedBy: "edits",
      },
    ],
    { existingLessons: [{ id: "LS-1", title: "舊教訓", rule: "舊規則" }] },
  );
  for (const frag of [
    "validate:interference",
    "做龍門",
    "2 處未宣告干涉",
    "滑座撞導軌",
    "RAIL_Z = 20",
    "已修復(edits)",
    STATIC_RULES_SUMMARY.split("\n")[0],
    "LS-1「舊教訓」",
    "只輸出一個 JSON 物件",
  ]) {
    assert.ok(p.includes(frag), `提示應含:${frag}`);
  }
});

test("parseDistillOutput:合法/圍欄/前後綴雜訊 → 取物件;缺欄/壞型/非 JSON → null", () => {
  const ok = parseDistillOutput(VALID_OUT);
  assert.equal(ok.title, "疊層定位魔數");
  assert.equal(ok.graduationCandidate, true);
  assert.equal(ok.duplicateOf, null);

  assert.ok(parseDistillOutput("```json\n" + VALID_OUT + "\n```"), "圍欄應被剝掉");
  assert.ok(parseDistillOutput("好的,以下是結果:\n" + VALID_OUT + "\n以上。"), "前後綴雜訊容忍");

  assert.equal(parseDistillOutput('{"title":"x","rootCause":"y"}'), null, "缺 rule → null");
  assert.equal(parseDistillOutput('{"title":"","rootCause":"y","rule":"z"}'), null, "空欄 → null");
  assert.equal(parseDistillOutput("完全不是 JSON"), null);
  assert.equal(parseDistillOutput(null), null);

  // 超長 clamp + duplicateOf 格式驗證
  const long = parseDistillOutput(
    JSON.stringify({ title: "很".repeat(99), rootCause: "y", rule: "z", duplicateOf: "bogus" }),
  );
  assert.ok(long.title.length <= 40);
  assert.equal(long.duplicateOf, null, "格式不符的 duplicateOf 視為 null");
});

// ── maybeDistill 三路寫回 ──

test("maybeDistill:3 筆 pending → 建 LS-1(active)、案例連結、計數/lastHitAt 正確", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:interference", 3, { resolved: true });
    const prompts = [];
    const r = await maybeDistill({
      file: f,
      env: ENV,
      callLlm: async (p) => {
        prompts.push(p);
        return VALID_OUT;
      },
    });
    assert.deepEqual(r, { ok: true, distilled: ["LS-1"], skipped: [] });
    assert.equal(prompts.length, 1, "一叢集一 LLM call");
    const store = readStore(f);
    assert.equal(store.lessons.length, 1);
    const l = store.lessons[0];
    assert.equal(l.status, "active");
    assert.equal(l.caseCount, 3);
    assert.equal(l.resolvedCount, 3);
    assert.ok(l.lastHitAt);
    assert.ok(store.cases.every((c) => c.lessonId === "LS-1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeDistill:duplicateOfStatic → 建檔但 disabled + rule 前綴標注", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "build:AssertionError:interference", 3);
    const out = JSON.stringify({
      title: "t",
      rootCause: "rc",
      rule: "r",
      graduationCandidate: false,
      duplicateOfStatic: true,
      duplicateOf: null,
    });
    const r = await maybeDistill({ file: f, env: ENV, callLlm: async () => out });
    assert.equal(r.ok, true);
    const l = readStore(f).lessons[0];
    assert.equal(l.status, "disabled");
    assert.ok(l.rule.startsWith("(靜態規則已涵蓋)"));
    assert.equal(readStore(f).cases.filter((c) => !c.lessonId).length, 0, "案例仍應消化");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeDistill:duplicateOf 指向既有教訓 → 不建新條、連結過去、併 altSignatures", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    const store = readStore(f);
    store.lessonSeq = 1;
    store.lessons.push({
      id: "LS-1",
      signature: "validate:interference",
      status: "active",
      title: "既有",
      rootCause: "rc",
      rule: "r",
      caseCount: 3,
      resolvedCount: 0,
    });
    writeStore(store, f);
    seedPending(f, "build:AssertionError:interference", 3); // 不同 signature、同根因
    const out = JSON.stringify({
      title: "t",
      rootCause: "rc",
      rule: "r",
      graduationCandidate: false,
      duplicateOfStatic: false,
      duplicateOf: "LS-1",
    });
    const r = await maybeDistill({ file: f, env: ENV, callLlm: async () => out });
    assert.deepEqual(r.distilled, ["LS-1"]);
    const after = readStore(f);
    assert.equal(after.lessons.length, 1, "不建新條");
    assert.equal(after.lessons[0].caseCount, 6);
    assert.deepEqual(after.lessons[0].altSignatures, ["build:AssertionError:interference"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeDistill:輸出不合法 → 什麼都不寫、pending 保留、skipped 回報", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:interference", 3);
    const r = await maybeDistill({ file: f, env: ENV, callLlm: async () => "亂講不給 JSON" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.distilled, []);
    assert.deepEqual(r.skipped, [{ signature: "validate:interference", reason: "bad_output" }]);
    const store = readStore(f);
    assert.equal(store.lessons.length, 0);
    assert.equal(store.cases.filter((c) => !c.lessonId).length, 3, "pending 應原封不動");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeDistill:門檻(預設 3)未達 → 不呼叫 LLM;force → 門檻 1", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:facts", 2);
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return VALID_OUT;
    };
    const r1 = await maybeDistill({ file: f, env: ENV, callLlm: fake });
    assert.deepEqual([r1.distilled, calls], [[], 0], "2 筆未達門檻 → 零 LLM call");
    const r2 = await maybeDistill({ file: f, env: ENV, callLlm: fake, force: true });
    assert.deepEqual(r2.distilled, ["LS-1"]);
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeDistill:認證未備 / 停用 / single-flight 三種擋路", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:facts", 3);

    const noAuth = await maybeDistill({ file: f, env: {}, callLlm: async () => VALID_OUT });
    assert.equal(noAuth.reason, "agent_not_ready");

    const disabled = await maybeDistill({
      file: f,
      env: { ...ENV, CADCHAT_LESSONS: "0" },
      callLlm: async () => VALID_OUT,
    });
    assert.equal(disabled.reason, "disabled");

    // single-flight:慢 LLM 佔住 → 第二個立即回 in_flight
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = maybeDistill({
      file: f,
      env: ENV,
      callLlm: async () => {
        await gate;
        return VALID_OUT;
      },
    });
    await new Promise((r) => setImmediate(r)); // 讓 slow 進到 await callLlm
    const blocked = await maybeDistill({ file: f, env: ENV, callLlm: async () => VALID_OUT });
    assert.equal(blocked.reason, "in_flight");
    release();
    const done = await slow;
    assert.deepEqual(done.distilled, ["LS-1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("併發安全:await 期間新 turn append 的案例不被誤標(只標 snapshot)", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:interference", 3);
    const r = await maybeDistill({
      file: f,
      env: ENV,
      callLlm: async () => {
        seedPending(f, "validate:interference", 1); // 模擬 await 期間 flush 進來的新紅
        return VALID_OUT;
      },
    });
    assert.deepEqual(r.distilled, ["LS-1"]);
    const store = readStore(f);
    const linked = store.cases.filter((c) => c.lessonId === "LS-1");
    const pending = store.cases.filter((c) => !c.lessonId);
    assert.equal(linked.length, 3, "只標 snapshot 內 3 筆");
    assert.equal(pending.length, 1, "await 期間的新案例保持 pending");
    assert.equal(store.lessons[0].caseCount, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("去重防線:同 signature 已有教訓(LLM 沒回 duplicateOf)→ 連結過去,不建第二條", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    // 模擬:上一輪蒸餾已建 LS-1,await 期間 flush 進來的同簽名案例留在 pending
    const store = readStore(f);
    store.lessonSeq = 1;
    store.lessons.push({
      id: "LS-1", signature: "validate:interference", status: "active",
      title: "既有", rootCause: "rc", rule: "r", caseCount: 3, resolvedCount: 0,
    });
    writeStore(store, f);
    seedPending(f, "validate:interference", 3);
    // LLM 回全新教訓、duplicateOf=null(自覺失敗)——防線仍須擋住重複
    const r = await maybeDistill({ file: f, env: ENV, callLlm: async () => VALID_OUT });
    assert.deepEqual(r.distilled, ["LS-1"]);
    const after = readStore(f);
    assert.equal(after.lessons.length, 1, "不得出現同 signature 的第二條教訓");
    assert.equal(after.lessons[0].caseCount, 6);
    assert.equal(after.cases.filter((c) => !c.lessonId).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bad_output 退避:連敗 2 次後自動蒸餾放棄該叢集(零 LLM call),force 不受限", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:interference", 3);
    let calls = 0;
    const badLlm = async () => {
      calls += 1;
      return "永遠不是 JSON";
    };
    await maybeDistill({ file: f, env: ENV, callLlm: badLlm });
    assert.equal(readStore(f).distillAttempts["validate:interference"], 1);
    await maybeDistill({ file: f, env: ENV, callLlm: badLlm });
    assert.equal(readStore(f).distillAttempts["validate:interference"], 2);
    assert.equal(calls, 2);
    // 第三次自動:被退避過濾,不再燒 LLM
    const r3 = await maybeDistill({ file: f, env: ENV, callLlm: badLlm });
    assert.equal(calls, 2, "退避後自動蒸餾零 LLM call");
    assert.deepEqual(r3.distilled, []);
    // 手動 force 不受限;成功即清計數
    const r4 = await maybeDistill({ file: f, env: ENV, callLlm: async () => VALID_OUT, force: true });
    assert.deepEqual(r4.distilled, ["LS-1"]);
    assert.equal(readStore(f).distillAttempts["validate:interference"], undefined, "成功清退避計數");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── redistill(人工精修)──

test("redistillLesson:更新條文保留 id/caseCount;not_found / no_cases 誠實回報", async () => {
  const dir = mkTmp();
  try {
    const f = path.join(dir, "lessons.json");
    seedPending(f, "validate:interference", 3);
    await maybeDistill({ file: f, env: ENV, callLlm: async () => VALID_OUT });

    const revised = JSON.stringify({
      title: "修訂版",
      rootCause: "更準的根因",
      rule: "更準的規則",
      graduationCandidate: false,
      duplicateOfStatic: false,
      duplicateOf: null,
    });
    let sawExisting = false;
    const r = await redistillLesson("LS-1", {
      file: f,
      env: ENV,
      callLlm: async (p) => {
        sawExisting = p.includes("待修訂的既有教訓");
        return revised;
      },
    });
    assert.deepEqual(r, { ok: true, lessonId: "LS-1" });
    assert.ok(sawExisting, "提示應帶既有條文供修訂");
    const l = readStore(f).lessons[0];
    assert.equal(l.title, "修訂版");
    assert.equal(l.caseCount, 3, "計數不受精修影響");
    assert.equal(l.graduationCandidate, false);

    assert.equal((await redistillLesson("LS-9", { file: f, env: ENV, callLlm: async () => revised })).reason, "not_found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
