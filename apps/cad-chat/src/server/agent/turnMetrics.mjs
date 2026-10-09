// 回合遙測：累積 SDK 工具時間與統計，失敗不阻斷代理回合。
import fs from "node:fs";
import path from "node:path";

export function shortToolName(name) {
  try {
    return typeof name === "string" ? name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "") : "";
  } catch {
    return "";
  }
}

export function beginTurnMetrics(session, { variant = "single", now = Date.now() } = {}) {
  try {
    const tm = {
      v: 1, t0: now, variant, ledger: [], byId: new Map(),
      tInit: null, tFirstStream: null, tResult: null, sdk: null,
    };
    // 唯讀或壞 session 仍可回傳獨立的遙測狀態。
    try { if (session != null) session._turnMetrics = tm; } catch {}
    return tm;
  } catch {
    return null;
  }
}

function num(value) {
  try { return Number.isFinite(value) ? value : null; } catch { return null; }
}

function normUsage(usage) {
  try {
    if (!usage || typeof usage !== "object") return null;
    return {
      input: num(usage.input_tokens) ?? 0,
      output: num(usage.output_tokens) ?? 0,
      cacheRead: num(usage.cache_read_input_tokens) ?? 0,
      cacheCreate: num(usage.cache_creation_input_tokens) ?? 0,
    };
  } catch {
    return null;
  }
}

function normModelUsage(models) {
  try {
    if (!models || typeof models !== "object") return null;
    return Object.fromEntries(Object.entries(models).map(([key, value]) => [key, {
      input: num(value?.inputTokens) ?? 0,
      output: num(value?.outputTokens) ?? 0,
      thinking: num(value?.thinkingTokens),
      cacheRead: num(value?.cacheReadInputTokens) ?? 0,
      cacheCreate: num(value?.cacheCreationInputTokens) ?? 0,
      costUsd: num(value?.costUSD),
    }]));
  } catch {
    return null;
  }
}

function toolRow(tm, id, name, parent) {
  try {
    if (typeof id !== "string" || !id) return null;
    let row = tm.byId.get(id);
    if (!row) {
      row = {
        id, name, parent: parent ?? null,
        tStart: null, tCall: null, tEnd: null, genMs: null, execMs: null, ok: null,
      };
      tm.ledger.push(row);
      tm.byId.set(id, row);
    }
    return row;
  } catch {
    return null;
  }
}

function resultOk(block) {
  try {
    if (block.is_error === true) return false;
    const content = block.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.find(item => item?.type === "text")?.text : undefined;
    try {
      const parsed = JSON.parse(text);
      return !(parsed && typeof parsed === "object" && parsed.ok === false);
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

export function ingestSdkMessage(tm, msg, { now = Date.now(), parent } = {}) {
  try {
    if (!tm || !msg || typeof msg !== "object" || !Array.isArray(tm.ledger)
      || !(tm.byId instanceof Map) || num(tm.t0) === null || num(now) === null) return;
    const at = now - tm.t0;
    if (msg.type === "system" && msg.subtype === "init") {
      tm.tInit ??= at;
    } else if (msg.type === "stream_event") {
      tm.tFirstStream ??= at;
      const block = msg.event?.content_block;
      if (msg.event?.type !== "content_block_start" || block?.type !== "tool_use") return;
      const row = toolRow(tm, block.id, shortToolName(block.name), parent ?? msg.parent_tool_use_id);
      if (row) row.tStart ??= at;
    } else if (msg.type === "assistant" || msg.type === "user") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (msg.type === "assistant" && block?.type === "tool_use") {
          const row = toolRow(tm, block.id, shortToolName(block.name), parent ?? msg.parent_tool_use_id);
          if (!row) continue;
          row.tCall = at;
          row.name = shortToolName(block.name);
          row.parent = parent ?? msg.parent_tool_use_id ?? row.parent ?? null;
          row.genMs = row.tStart != null ? row.tCall - row.tStart : null;
        } else if (msg.type === "user" && block?.type === "tool_result") {
          const row = toolRow(tm, block.tool_use_id, "", parent ?? msg.parent_tool_use_id);
          if (!row) continue;
          row.tEnd = at;
          row.execMs = row.tCall != null ? row.tEnd - row.tCall : null;
          row.ok = resultOk(block);
        }
      }
    } else if (msg.type === "result") {
      tm.tResult = at;
      tm.sdk = {
        subtype: msg.subtype ?? null,
        isError: !!msg.is_error,
        durationMs: num(msg.duration_ms),
        durationApiMs: num(msg.duration_api_ms),
        ttftMs: num(msg.ttft_ms),
        numTurns: num(msg.num_turns),
        costUsd: num(msg.total_cost_usd),
        usage: normUsage(msg.usage),
        modelUsage: normModelUsage(msg.modelUsage),
        errors: Array.isArray(msg.errors) ? msg.errors.slice(0, 10) : undefined,
      };
    }
  } catch {
    // 遙測永遠不將 SDK 訊息或狀態錯誤傳給回合。
  }
}

function emptySummary() {
  try {
    return {
      count: 0, open: 0, byName: {},
      main: { n: 0, execMs: 0 }, sub: { n: 0, execMs: 0, agents: 0 },
      firstToolAtMs: null, firstBuildAtMs: null, firstBuildDoneAtMs: null,
      presentAtMs: null, clarifyAtMs: null,
      counts: {
        builds: 0, buildFails: 0, validates: 0, retries: 0,
        presents: 0, imports: 0, sourceParts: 0, clarify: false,
      },
    };
  } catch {
    return null;
  }
}

export function summarizeLedger(ledger) {
  try {
    const summary = emptySummary();
    if (!Array.isArray(ledger)) return summary;
    summary.count = ledger.length;
    const parents = new Set();
    let firstBuild = null;
    let sawPresent = false;
    let sawClarify = false;
    for (const row of ledger) {
      if (!row || typeof row !== "object") continue;
      const name = typeof row.name === "string" ? row.name : "";
      // 工具名可能與 Object 原型鍵同名；保留一般可 JSON 序列化物件。
      if (!Object.hasOwn(summary.byName, name)) {
        Object.defineProperty(summary.byName, name, {
          value: { n: 0, ok: 0, err: 0, open: 0, genMs: 0, execMs: 0 },
          enumerable: true, configurable: true, writable: true,
        });
      }
      const group = summary.byName[name];
      group.n++;
      if (row.ok === true) group.ok++;
      if (row.ok === false) group.err++;
      if (row.tEnd == null) { group.open++; summary.open++; }
      group.genMs += num(row.genMs) ?? 0;
      group.execMs += num(row.execMs) ?? 0;
      const branch = row.parent == null ? summary.main : summary.sub;
      branch.n++;
      branch.execMs += num(row.execMs) ?? 0;
      if (row.parent != null) parents.add(row.parent);
      const at = num(row.tCall ?? row.tStart);
      if (at != null && (summary.firstToolAtMs == null || at < summary.firstToolAtMs)) {
        summary.firstToolAtMs = at;
      }
      if (name === "cad_build") {
        summary.counts.builds++;
        if (row.ok === false) summary.counts.buildFails++;
        if (at != null && (firstBuild == null || at < summary.firstBuildAtMs)) {
          firstBuild = row;
          summary.firstBuildAtMs = at;
          summary.firstBuildDoneAtMs = num(row.tEnd);
        }
      }
      if (name === "cad_validate") summary.counts.validates++;
      if (name === "emit_retry") summary.counts.retries++;
      if (name === "cad_import") summary.counts.imports++;
      if (name === "cad_source_part") summary.counts.sourceParts++;
      if (name === "cad_present") {
        summary.counts.presents++;
        if (!sawPresent) summary.presentAtMs = num(row.tEnd ?? row.tCall ?? row.tStart);
        sawPresent = true;
      }
      if (name === "emit_clarify") {
        summary.counts.clarify = true;
        if (!sawClarify) summary.clarifyAtMs = at;
        sawClarify = true;
      }
    }
    summary.sub.agents = parents.size;
    return summary;
  } catch {
    return emptySummary();
  }
}

export function finishTurnMetrics(tm, { session, ok, now = Date.now() } = {}) {
  try {
    if (!tm || !Array.isArray(tm.ledger) || num(tm.t0) === null || num(now) === null) return null;
    const { counts, ...tools } = summarizeLedger(tm.ledger);
    return {
      v: 1,
      variant: tm.variant,
      mode: session?.mode ?? null,
      sessionId: session?.sessionId ?? null,
      sdkSessionId: session?.sdkSessionId ?? null,
      ts: now,
      wallMs: now - tm.t0,
      tInitMs: tm.tInit, tFirstStreamMs: tm.tFirstStream, tResultMs: tm.tResult,
      sdk: tm.sdk,
      tools,
      counts,
      outcome: {
        ok: !!ok,
        clarified: !!session?._clarifyPending,
        presented: counts.presents > 0,
        version: session?.version ?? null,
        lastName: session?.lastName ?? null,
        partCount: session?.lastPartCount ?? null,
        validateOk: session?._lastValidate?.ok ?? null,
      },
      ledger: tm.ledger.slice(0, 200).map(row => ({ ...row })),
    };
  } catch {
    return null;
  }
}

export function appendMetricsLine(workdir, rec) {
  try {
    if (typeof workdir !== "string" || !workdir) return false;
    fs.appendFileSync(path.join(workdir, "metrics.jsonl"), JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
