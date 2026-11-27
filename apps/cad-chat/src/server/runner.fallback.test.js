// Codex 回合在產出任何內容前失敗時的行為(免 LLM:用不存在的 Codex 執行檔讓它起不來)。
//   claudeFallback=true  → 不發 error,回 { ok:false, fallback:true },交給 chat.mjs 改用 Claude 重跑。
//   claudeFallback=false → 維持原行為:發 error、回 { ok:false }(本機桌面版)。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn } from "./agent/runner.mjs";

function fakeSession(workdir) {
  return {
    sessionId: "fallback-unit",
    user: null,
    mode: "design",
    workdir,
    workdirAbs: workdir,
    modelsRoot: workdir,
    version: 0,
    lastName: null,
    history: [],
    sdkSessionId: null,
  };
}

async function failingCodexTurn(claudeFallback) {
  const previous = process.env.CADCHAT_CODEX_BIN;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-fallback-"));
  process.env.CADCHAT_CODEX_BIN = path.join(workdir, "no-such-codex");
  const events = [];
  try {
    const result = await runTurn({
      session: fakeSession(workdir),
      emit: (event, data) => events.push({ event, data }),
      message: "畫一個方塊",
      provider: "codex",
      claudeFallback,
    });
    return { result, events };
  } finally {
    if (previous === undefined) delete process.env.CADCHAT_CODEX_BIN;
    else process.env.CADCHAT_CODEX_BIN = previous;
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

test("Codex 起不來且允許後備:不發 error,回 fallback 給呼叫端", async () => {
  const { result, events } = await failingCodexTurn(true);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  assert.ok(result.error instanceof Error);
  assert.equal(events.some((e) => e.event === "error"), false);
  assert.equal(events.some((e) => ["ai", "ai_start", "ai_delta"].includes(e.event)), false);
});

test("Codex 起不來且不允許後備:照舊發 error", async () => {
  const { result, events } = await failingCodexTurn(false);
  assert.equal(result.ok, false);
  assert.equal(result.fallback, undefined);
  assert.equal(events.filter((e) => e.event === "error").length, 1);
});
