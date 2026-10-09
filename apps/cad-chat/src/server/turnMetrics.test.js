// 回合遙測單元測試：合成 SDK 訊息、固定時間，免網路與子程序。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  shortToolName, beginTurnMetrics, ingestSdkMessage,
  summarizeLedger, finishTurnMetrics, appendMetricsLine,
} from "./agent/turnMetrics.mjs";

const call = (id, name = "cad_build", parent = null) => ({
  type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});
const result = (id, content, is_error = false, parent = null) => ({
  type: "user", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
});
const stream = (id, name = "cad_build", parent = null) => ({
  type: "stream_event", parent_tool_use_id: parent,
  event: { type: "content_block_start", content_block: { type: "tool_use", id, name } },
});
const row = (id, name, fields = {}) => ({
  id, name, parent: null, tStart: null, tCall: null, tEnd: null,
  genMs: null, execMs: null, ok: null, ...fields,
});

test("完整序列計時", () => {
  const tm = beginTurnMetrics(null, { now: 0 });
  ingestSdkMessage(tm, { type: "system", subtype: "init" }, { now: 100 });
  ingestSdkMessage(tm, stream("a", "mcp__cadchat__cad_build"), { now: 1000 });
  ingestSdkMessage(tm, call("a", "mcp__cadchat__cad_build"), { now: 5000 });
  ingestSdkMessage(tm, result("a", [{ type: "text", text: '{"ok":true}' }]), { now: 9000 });
  ingestSdkMessage(tm, {
    type: "result", subtype: "success", is_error: false,
    duration_ms: 9400, duration_api_ms: 7000, num_turns: 3, total_cost_usd: 0.12,
    usage: { input_tokens: 5, output_tokens: 900, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 },
    modelUsage: { "claude-x": {
      inputTokens: 5, outputTokens: 900, cacheReadInputTokens: 1000, cacheCreationInputTokens: 20, costUSD: 0.12,
    } },
  }, { now: 9500 });
  assert.equal(tm.tInit, 100);
  assert.equal(tm.tFirstStream, 1000);
  assert.equal(tm.tResult, 9500);
  assert.deepEqual(tm.ledger, [row("a", "cad_build", {
    tStart: 1000, tCall: 5000, tEnd: 9000, genMs: 4000, execMs: 4000, ok: true,
  })]);
  assert.equal(tm.byId.get("a"), tm.ledger[0]);
  const summary = summarizeLedger(tm.ledger);
  assert.deepEqual(summary.byName.cad_build, { n: 1, ok: 1, err: 0, open: 0, genMs: 4000, execMs: 4000 });
  assert.equal(summary.firstToolAtMs, 5000);
  assert.equal(summary.firstBuildAtMs, 5000);
  assert.equal(summary.firstBuildDoneAtMs, 9000);
  assert.equal(summary.counts.builds, 1);
  assert.deepEqual(summary.main, { n: 1, execMs: 4000 });
  assert.deepEqual(summary.sub, { n: 0, execMs: 0, agents: 0 });
  assert.deepEqual(tm.sdk, {
    subtype: "success", isError: false, durationMs: 9400, durationApiMs: 7000,
    ttftMs: null, numTurns: 3, costUsd: 0.12,
    usage: { input: 5, output: 900, cacheRead: 1000, cacheCreate: 20 },
    modelUsage: { "claude-x": {
      input: 5, output: 900, thinking: null, cacheRead: 1000, cacheCreate: 20, costUsd: 0.12,
    } },
    errors: undefined,
  });
});

test("子代理分流", () => {
  const tm = beginTurnMetrics(null, { now: 100 });
  ingestSdkMessage(tm, call("s1", "cad_build", "p1"), { now: 200 });
  ingestSdkMessage(tm, call("m1"), { now: 300 });
  ingestSdkMessage(tm, result("s1", "done", false, "p1"), { now: 400 });
  ingestSdkMessage(tm, result("m1", "done"), { now: 600 });
  const summary = summarizeLedger(tm.ledger);
  assert.deepEqual(summary.sub, { n: 1, execMs: 200, agents: 1 });
  assert.deepEqual(summary.main, { n: 1, execMs: 300 });
  ingestSdkMessage(tm, call("forced-call", "Read", "p1"), { now: 700, parent: "forced" });
  ingestSdkMessage(tm, stream("forced-stream", "Read", "p1"), { now: 800, parent: "forced" });
  assert.equal(tm.byId.get("forced-call").parent, "forced");
  assert.equal(tm.byId.get("forced-stream").parent, "forced");
  ingestSdkMessage(tm, call("forced-stream", "Read"), { now: 900 });
  assert.equal(tm.byId.get("forced-stream").parent, "forced");
  assert.equal(summarizeLedger(tm.ledger).sub.agents, 2);
});

test("失敗判定", () => {
  const tm = beginTurnMetrics(null, { now: 0 });
  const cases = [
    ["a", "cad_build", [{ type: "text", text: '{"ok":false,"error":"x"}' }], false, false],
    ["b", "Read", '{"ok":true}', true, false],
    ["c", "Read", "done", false, true],
    ["d", "Read", undefined, false, true],
    ["e", "Read", [{ type: "image" }, { type: "text", text: '{"ok":false}' }], false, false],
    ["f", "Read", [{ type: "text", text: "done" }, { type: "text", text: '{"ok":false}' }], false, true],
    ["g", "Read", [{ type: "image" }], false, true],
    ["h", "Read", "null", false, true],
    ["i", "Read", '{"ok":0}', false, true],
  ];
  for (const [id, name, content, error, expected] of cases) {
    ingestSdkMessage(tm, call(id, name), { now: 10 });
    ingestSdkMessage(tm, result(id, content, error), { now: 20 });
    assert.equal(tm.byId.get(id).ok, expected, id);
  }
  assert.equal(summarizeLedger(tm.ledger).counts.buildFails, 1);
});

test("缺 tStart 不丟", () => {
  const tm = beginTurnMetrics(null, { now: 100 });
  ingestSdkMessage(tm, call("a"), { now: 200 });
  ingestSdkMessage(tm, result("a", "done"), { now: 450 });
  assert.equal(tm.ledger[0].tStart, null);
  assert.equal(tm.ledger[0].genMs, null);
  assert.equal(tm.ledger[0].execMs, 250);
  for (const msg of [{ type: "tool_progress" }, { type: "system", subtype: "other" }, null, undefined, 42]) {
    assert.doesNotThrow(() => ingestSdkMessage(tm, msg, { now: 500 }));
  }
  assert.equal(tm.tInit, null);
  assert.equal(tm.tFirstStream, null);
  assert.equal(tm.ledger.length, 1);
  assert.deepEqual(summarizeLedger(null), {
    count: 0, open: 0, byName: {}, main: { n: 0, execMs: 0 }, sub: { n: 0, execMs: 0, agents: 0 },
    firstToolAtMs: null, firstBuildAtMs: null, firstBuildDoneAtMs: null,
    presentAtMs: null, clarifyAtMs: null,
    counts: { builds: 0, buildFails: 0, validates: 0, retries: 0, presents: 0, imports: 0, sourceParts: 0, clarify: false },
  });
});

test("result 錯誤型", () => {
  const tm = beginTurnMetrics(null, { now: 0 });
  ingestSdkMessage(tm, call("a"), { now: 10 });
  ingestSdkMessage(tm, {
    type: "result", subtype: "error_max_turns", is_error: true, duration_ms: 1, errors: ["boom"],
  }, { now: 30 });
  assert.equal(tm.sdk.isError, true);
  assert.equal(tm.sdk.subtype, "error_max_turns");
  assert.equal(tm.sdk.durationMs, 1);
  assert.deepEqual(tm.sdk.errors, ["boom"]);
  assert.equal(tm.sdk.usage, null);
  assert.equal(tm.sdk.modelUsage, null);
  const summary = summarizeLedger(tm.ledger);
  assert.equal(summary.open, 1);
  assert.deepEqual(summary.byName.cad_build, { n: 1, ok: 0, err: 0, open: 1, genMs: 0, execMs: 0 });
});

test("finishTurnMetrics", () => {
  const session = {
    mode: "design", sessionId: "s1", sdkSessionId: "u1", version: 2,
    lastName: "foo", lastPartCount: 5, _clarifyPending: false, _lastValidate: { ok: true },
  };
  const tm = beginTurnMetrics(session, { now: 100, variant: "parallel" });
  ingestSdkMessage(tm, call("a", "cad_present"), { now: 150 });
  ingestSdkMessage(tm, result("a", "done"), { now: 200 });
  const payload = finishTurnMetrics(tm, { session, ok: true, now: 300 });
  assert.equal(payload.v, 1);
  assert.equal(payload.variant, "parallel");
  assert.equal(payload.mode, "design");
  assert.equal(payload.sessionId, "s1");
  assert.equal(payload.sdkSessionId, "u1");
  assert.equal(payload.ts, 300);
  assert.equal(payload.wallMs, 200);
  assert.equal(payload.tInitMs, null);
  assert.equal(payload.tFirstStreamMs, null);
  assert.equal(payload.tResultMs, null);
  assert.equal(payload.sdk, null);
  assert.deepEqual(payload.outcome, {
    ok: true, clarified: false, presented: true, version: 2,
    lastName: "foo", partCount: 5, validateOk: true,
  });
  const { counts, ...tools } = summarizeLedger(tm.ledger);
  assert.deepEqual(payload.tools, tools);
  assert.deepEqual(payload.counts, counts);
  assert.ok(!Object.hasOwn(payload.tools, "counts"));
  assert.deepEqual(payload.ledger, tm.ledger);
  assert.notEqual(payload.ledger, tm.ledger);
  assert.notEqual(payload.ledger[0], tm.ledger[0]);
  payload.ledger[0].name = "changed";
  assert.equal(tm.ledger[0].name, "cad_present");
  assert.equal(finishTurnMetrics(null, { now: 300 }), null);
  const absent = finishTurnMetrics(beginTurnMetrics(null, { now: 0 }), { now: 50 });
  assert.equal(absent.mode, null);
  assert.equal(absent.sessionId, null);
  assert.equal(absent.sdkSessionId, null);
  assert.deepEqual(absent.outcome, {
    ok: false, clarified: false, presented: false, version: null,
    lastName: null, partCount: null, validateOk: null,
  });
  session._clarifyPending = true;
  session._lastValidate.ok = false;
  assert.equal(finishTurnMetrics(tm, { session, now: 300 }).outcome.clarified, true);
  assert.equal(finishTurnMetrics(tm, { session, now: 300 }).outcome.validateOk, false);
  const many = beginTurnMetrics(null, { now: 0 });
  for (let i = 0; i < 201; i++) ingestSdkMessage(many, call(String(i)), { now: i });
  const limited = finishTurnMetrics(many, { now: 300 });
  assert.equal(limited.ledger.length, 200);
  assert.equal(limited.ledger[199].id, "199");
  assert.equal(limited.tools.count, 201);
  assert.equal(limited.counts.builds, 201);
  assert.equal(many.ledger.length, 201);
});

test("appendMetricsLine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-metrics-"));
  try {
    const records = [{ v: 1, ts: 10, name: "遙測" }, { v: 1, ts: 20 }];
    for (const rec of records) assert.equal(appendMetricsLine(dir, rec), true);
    const text = fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8");
    assert.ok(text.endsWith("\n"));
    const lines = text.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => JSON.parse(line)), records);
    assert.equal(appendMetricsLine("", {}), false);
    assert.equal(appendMetricsLine(path.join(dir, "no", "such", "dir"), {}), false);
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(appendMetricsLine(dir, cyclic), false);
    assert.equal(appendMetricsLine(dir, { n: 1n }), false);
    assert.equal(fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8"), text);
  } finally {
    // 只清理由 mkdtemp 建立、驗過範圍的本測試目錄。
    const target = path.resolve(dir);
    const relative = path.relative(path.resolve(os.tmpdir()), target);
    assert.ok(relative.startsWith("cadchat-metrics-") && !relative.includes(path.sep));
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("工具短名與回合初始化", () => {
  for (const [name, expected] of [
    ["mcp__cadchat__cad_build", "cad_build"], ["mcp__other__x", "x"],
    ["mcp__other_server__x", "x"], ["Read", "Read"], ["", ""], [null, ""], [42, ""], [undefined, ""],
  ]) assert.equal(shortToolName(name), expected);
  const session = {};
  const tm = beginTurnMetrics(session, { now: 123 });
  assert.equal(session._turnMetrics, tm);
  assert.deepEqual(tm, {
    v: 1, t0: 123, variant: "single", ledger: [], byId: new Map(),
    tInit: null, tFirstStream: null, tResult: null, sdk: null,
  });
  assert.equal(beginTurnMetrics(Object.freeze({}), { now: 0 }).t0, 0);
});

test("摘要時間排序、平手與全部計數", () => {
  const ledger = [
    row("late", "cad_build", { tStart: 1, tCall: 40, tEnd: 90, genMs: 39, execMs: 50, ok: false }),
    row("early", "cad_build", { tCall: 20, tEnd: 55, execMs: 35, ok: true, parent: "p" }),
    row("tie", "cad_build", { tCall: 20, tEnd: 45, execMs: 25, ok: true, parent: "p" }),
    row("unknown", "cad_build"),
    row("v", "cad_validate", { tStart: 10 }),
    row("r", "emit_retry", { tCall: 60, parent: "q" }),
    row("p1", "cad_present", { tStart: 50, tCall: 70, tEnd: 80 }),
    row("p2", "cad_present", { tCall: 5, tEnd: 6 }),
    row("i", "cad_import"), row("s", "cad_source_part"),
    row("c1", "emit_clarify", { tStart: 12 }), row("c2", "emit_clarify", { tCall: 2 }),
    row("proto", "__proto__", { tCall: 0 }), row("constructor", "constructor"),
  ];
  const before = structuredClone(ledger);
  const summary = summarizeLedger(ledger);
  assert.deepEqual(ledger, before);
  assert.equal(summary.count, 14);
  assert.equal(summary.open, 9);
  assert.equal(summary.firstToolAtMs, 0);
  assert.equal(summary.firstBuildAtMs, 20);
  assert.equal(summary.firstBuildDoneAtMs, 55);
  assert.equal(summary.presentAtMs, 80);
  assert.equal(summary.clarifyAtMs, 12);
  assert.deepEqual(summary.counts, {
    builds: 4, buildFails: 1, validates: 1, retries: 1, presents: 2, imports: 1, sourceParts: 1, clarify: true,
  });
  assert.deepEqual(summary.byName.cad_build, { n: 4, ok: 2, err: 1, open: 1, genMs: 39, execMs: 110 });
  assert.deepEqual(summary.main, { n: 11, execMs: 50 });
  assert.deepEqual(summary.sub, { n: 3, execMs: 60, agents: 2 });
  assert.equal(summary.byName.__proto__.n, 1);
  assert.equal(summary.byName.constructor.n, 1);
  assert.equal(Object.getPrototypeOf(summary.byName), Object.prototype);
  assert.equal(summarizeLedger([row("p", "cad_present", { tCall: 3 })]).presentAtMs, 3);
  assert.equal(summarizeLedger([row("p", "cad_present", { tStart: 4 })]).presentAtMs, 4);
});

test("重複訊息保留首次時間與 ledger 順序", () => {
  const tm = beginTurnMetrics(null, { now: 100 });
  ingestSdkMessage(tm, { type: "system", subtype: "init" }, { now: 100 });
  ingestSdkMessage(tm, { type: "system", subtype: "init" }, { now: 200 });
  ingestSdkMessage(tm, stream("a", "Read", "p1"), { now: 100 });
  ingestSdkMessage(tm, stream("a", "Other", "p2"), { now: 250 });
  ingestSdkMessage(tm, call("b", "cad_import"), { now: 300 });
  ingestSdkMessage(tm, call("a", "mcp__cadchat__cad_build", "p3"), { now: 400 });
  assert.equal(tm.tInit, 0);
  assert.equal(tm.tFirstStream, 0);
  assert.equal(tm.byId.get("a").tStart, 0);
  assert.equal(tm.byId.get("a").name, "cad_build");
  assert.equal(tm.byId.get("a").parent, "p3");
  assert.equal(tm.byId.get("a").genMs, 300);
  assert.deepEqual(tm.ledger.map(item => item.id), ["a", "b"]);
  ingestSdkMessage(tm, stream("b"), { now: 310 });
  assert.equal(tm.byId.get("b").tStart, 210);
  ingestSdkMessage(tm, stream("b"), { now: 320 });
  assert.equal(tm.byId.get("b").tStart, 210);
  ingestSdkMessage(tm, result("orphan", "done", false, "p4"), { now: 500 });
  assert.deepEqual(tm.byId.get("orphan"), row("orphan", "", { parent: "p4", tEnd: 400, ok: true }));
  assert.equal(tm.byId.size, 3);
});

test("SDK 統計正規化與錯誤清單上限", () => {
  const tm = beginTurnMetrics(null, { now: 0 });
  const errors = Array.from({ length: 12 }, (_, i) => `error-${i}`);
  ingestSdkMessage(tm, {
    type: "result", duration_ms: Infinity, duration_api_ms: "7", ttft_ms: 0,
    num_turns: NaN, total_cost_usd: -Infinity,
    usage: { input_tokens: "5", output_tokens: NaN, cache_read_input_tokens: 0, cache_creation_input_tokens: 8 },
    modelUsage: {
      x: { inputTokens: Infinity, outputTokens: 4, thinkingTokens: 6, cacheReadInputTokens: "2", costUSD: 0 },
      missing: null,
    },
    errors,
  }, { now: 10 });
  assert.equal(tm.sdk.subtype, null);
  assert.equal(tm.sdk.isError, false);
  assert.equal(tm.sdk.durationMs, null);
  assert.equal(tm.sdk.durationApiMs, null);
  assert.equal(tm.sdk.ttftMs, 0);
  assert.equal(tm.sdk.numTurns, null);
  assert.equal(tm.sdk.costUsd, null);
  assert.deepEqual(tm.sdk.usage, { input: 0, output: 0, cacheRead: 0, cacheCreate: 8 });
  assert.deepEqual(tm.sdk.modelUsage, {
    x: { input: 0, output: 4, thinking: 6, cacheRead: 0, cacheCreate: 0, costUsd: 0 },
    missing: { input: 0, output: 0, thinking: null, cacheRead: 0, cacheCreate: 0, costUsd: null },
  });
  assert.deepEqual(tm.sdk.errors, errors.slice(0, 10));
  assert.notEqual(tm.sdk.errors, errors);
  ingestSdkMessage(tm, { type: "result", usage: "bad", modelUsage: 42, errors: "bad" }, { now: 20 });
  assert.equal(tm.sdk.usage, null);
  assert.equal(tm.sdk.modelUsage, null);
  assert.equal(tm.sdk.errors, undefined);
  assert.equal(tm.tResult, 20);
  assert.equal(finishTurnMetrics(tm, { now: 30 }).tResultMs, 20);
});

test("壞訊息與不可寫狀態靜默容忍", () => {
  const tm = beginTurnMetrics(null, { now: 0 });
  const broken = new Proxy({}, { get() { throw new Error("bad getter"); } });
  const malformed = [
    {}, [], "bad", { type: "assistant", message: { content: "bad" } },
    { type: "user", message: { content: {} } },
    { type: "assistant", message: { content: [null, {}, { type: "tool_use", id: 42 }] } },
    { type: "user", message: { content: [null, { type: "tool_result" }] } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use" } } }, broken,
  ];
  for (const msg of malformed) assert.doesNotThrow(() => ingestSdkMessage(tm, msg, { now: 10 }));
  assert.equal(tm.ledger.length, 0);
  for (const state of [null, undefined, 42, {}, broken, Object.freeze(beginTurnMetrics(null, { now: 0 }))]) {
    assert.doesNotThrow(() => ingestSdkMessage(state, { type: "system", subtype: "init" }, { now: 10 }));
    assert.doesNotThrow(() => finishTurnMetrics(state, { now: 10 }));
  }
  assert.equal(beginTurnMetrics(broken, { now: 0 }).t0, 0);
  assert.equal(finishTurnMetrics(tm, { session: broken, now: 10 }), null);
  assert.deepEqual(summarizeLedger([broken]), summarizeLedger([]));
  assert.doesNotThrow(() => summarizeLedger([null, undefined, 42]));
  assert.equal(appendMetricsLine(null, {}), false);
});
