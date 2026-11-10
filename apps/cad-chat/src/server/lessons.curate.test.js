// 教訓裁決層單元測(純函數;零 I/O)。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { applyCuration, isNoiseCase, noiseReason, validateCuration } from "./lessons.curate.mjs";
import { buildDigest } from "./lessons.mjs";
import { STATIC_RULES_SUMMARY } from "./lessons.distill.mjs";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));

test("noiseReason:煙測暫存件 / 回合層基礎設施錯誤 / 滑桿撞防呆 / ANSI 殘骸 → 雜訊;真失敗保留", () => {
  assert.equal(noiseReason({ signature: "build:Standard_DomainError", source: "regen_build", partName: "tmp_smoke_rollback" }), "smoke-fixture");
  assert.equal(noiseReason({ signature: "turn:agent_error", source: "turn", note: "You've hit your session limit" }), "infrastructure");
  assert.equal(noiseReason({ signature: "turn:exception", source: "turn" }), "infrastructure");
  assert.equal(noiseReason({ signature: "build:ValueError", source: "regen_build", partName: "rail_plate" }), "guard-worked");
  assert.equal(noiseReason({ signature: "build:exit1", source: "build", note: "\u001b[1;35mOCP.Standard_DomainError\u001b[0m" }), "ansi-garbage");
  // 保留:代理自己 build 時的 ValueError(初版幾何不自洽)、滑桿撞到幾何核心原始例外(防呆沒蓋到)
  assert.equal(isNoiseCase({ signature: "build:ValueError", source: "build", partName: "pivot_flip" }), false);
  assert.equal(isNoiseCase({ signature: "build:Standard_DomainError", source: "regen_build", partName: "linear_stage" }), false);
  assert.equal(isNoiseCase({ signature: "manual:mirror-symmetry", source: "manual" }), false);
  assert.equal(noiseReason(null), "malformed");
});

const store = () => ({
  schemaVersion: 1,
  cases: [
    { id: "c_1", signature: "build:X", source: "build", resolved: true, partName: "a" },
    { id: "c_2", signature: "build:X", source: "build", partName: "a" },
    { id: "c_3", signature: "turn:agent_error", source: "turn" },
    { id: "c_4", signature: "build:Y", source: "regen_build", partName: "tmp_smoke_gate" },
  ],
  lessons: [
    { id: "LS-1", signature: "build:X", status: "active", title: "t", rootCause: "c", rule: "old rule", distilledAt: "2026-07-01T00:00:00.000Z", caseCount: 99, resolvedCount: 9 },
    { id: "LS-2", signature: "turn:agent_error", status: "active", title: "t2", rootCause: "c2", rule: "wrong", caseCount: 23 },
    { id: "LS-3", signature: "build:Z", altSignatures: ["build:Y"], status: "disabled", statusAt: "2026-12-01T00:00:00.000Z", statusReason: "manual", title: "t3", rootCause: "c3", rule: "r3" },
  ],
  distillAttempts: { "turn:agent_error": 2, "build:X": 1 },
});
const curation = () => ({
  lessons: {
    "build:X": { status: "active", at: "2026-11-10T00:00:00.000Z", rule: "new rule" },
    "turn:agent_error": { status: "disabled", reason: "retired", note: "infra", at: "2026-11-10T00:00:00.000Z" },
    "build:Y": { status: "active", at: "2026-11-10T00:00:00.000Z" }, // 命中 LS-3 的 altSignature,但面板決定較新
    "build:absent": { status: "disabled", reason: "retired", note: "x", at: "2026-11-10T00:00:00.000Z" },
  },
});

test("applyCuration:濾雜訊、套狀態與措辭、計數現算、不改輸入、冪等", () => {
  const input = store();
  const frozen = JSON.stringify(input);
  const { store: out, report } = applyCuration(input, curation());
  assert.equal(JSON.stringify(input), frozen); // 純函數
  assert.deepEqual(out.cases.map((c) => c.id), ["c_1", "c_2"]);
  assert.deepEqual(report.noiseRemoved, { infrastructure: 1, "smoke-fixture": 1 });
  const [x, turn, z] = out.lessons;
  assert.equal(x.rule, "new rule");
  assert.equal(x.model, "curated");
  assert.equal(x.distilledAt, "2026-11-10T00:00:00.000Z");
  assert.equal(x.caseCount, 2); // 現算,不沿用膨脹值
  assert.equal(x.resolvedCount, 1);
  assert.equal(x.title, "t"); // 沒給的欄位不動
  assert.equal(turn.status, "disabled");
  assert.equal(turn.statusReason, "retired");
  assert.equal(turn.statusNote, "infra");
  assert.equal(turn.caseCount, 0);
  // 面板上較晚的手動決定(statusAt 12 月)優先於較早的裁決(11 月)
  assert.equal(z.status, "disabled");
  assert.equal(z.statusReason, "manual");
  assert.deepEqual(report.unmatched, ["build:absent"]);
  assert.deepEqual(out.distillAttempts, { "build:X": 1 }); // 無案例的鍵清掉
  const again = applyCuration(out, curation());
  assert.deepEqual(again.store, out);
  assert.deepEqual(again.report.statusApplied, []);
  assert.deepEqual(again.report.wordingApplied, []);
});

test("applyCuration:之後重新蒸餾的措辭(distilledAt 較新)不被舊裁決蓋回", () => {
  const s = store();
  s.lessons[0].distilledAt = "2026-12-24T00:00:00.000Z";
  const { store: out } = applyCuration(s, curation());
  assert.equal(out.lessons[0].rule, "old rule");
});

test("validateCuration:停用必給理由、graduated 必寫去處、at 必為時間", () => {
  assert.deepEqual(validateCuration(curation()), []);
  const bad = {
    lessons: {
      a: { status: "disabled", at: "2026-11-10T00:00:00.000Z" },
      b: { status: "disabled", reason: "graduated", at: "2026-11-10T00:00:00.000Z" },
      c: { status: "on", at: "nope" },
      d: { status: "active", at: "2026-11-10T00:00:00.000Z", rule: "  " },
    },
  };
  const errs = validateCuration(bad).join("\n");
  assert.match(errs, /a: 停用須給 reason/);
  assert.match(errs, /b: graduated 須在 note 寫明/);
  assert.match(errs, /c: status 須為/);
  assert.match(errs, /c: at 須為 ISO 時間/);
  assert.match(errs, /d: rule 不可為空字串/);
  assert.equal(validateCuration(null).length, 1);
});

// ── repo 內的真資料:裁決檔合法、快照已套用、digest 不超預算也沒有半句話 ──
test("data/curation.lessons.json 合法;兩份快照已是套用後的狀態(再套一次無變化)", () => {
  const cur = readJson("curation.lessons.json");
  assert.deepEqual(validateCuration(cur), []);
  for (const name of ["lessons.sam.json", "lessons.vm.json"]) {
    const snap = readJson(name);
    const { store: out, report } = applyCuration(snap, cur);
    assert.deepEqual(report.noiseRemoved, {}, name);
    assert.deepEqual(report.statusApplied, [], name);
    assert.deepEqual(report.wordingApplied, [], name);
    assert.deepEqual(out.lessons, snap.lessons, name);
    assert.ok(snap.cases.every((c) => !isNoiseCase(c)), name);
    for (const l of snap.lessons) {
      if (l.status !== "active") assert.ok(["graduated", "retired", "manual"].includes(l.statusReason), `${name} ${l.id}`);
    }
  }
});

test("快照 digest:全部生效教訓都進得去(不被預算截掉)、沒有以「…」結尾的半句規則", () => {
  const snap = readJson("lessons.sam.json");
  const active = snap.lessons.filter((l) => l.status === "active");
  const digest = buildDigest(snap);
  for (const l of active) assert.ok(digest.includes(`[${l.id}]`), `${l.id} 被 digest 預算截掉`);
  for (const l of active) {
    assert.ok(!/…/.test(l.rule), `${l.id} 規則被截斷`);
    assert.ok(!/…/.test(l.rootCause), `${l.id} 根因被截斷`);
  }
  assert.ok(digest.length <= 2000, `digest ${digest.length} 字`);
});

test("STATIC_RULES_SUMMARY 跟得上 MOTION 契約的能力(蒸餾模型拿它當「提示已涵蓋什麼」)", () => {
  for (const word of ["revolute", "couple", "profile", "children"]) {
    assert.ok(STATIC_RULES_SUMMARY.includes(word), `摘要缺 ${word}`);
  }
  assert.ok(!/MOTION v1 宣告\(linear、/.test(STATIC_RULES_SUMMARY));
});
