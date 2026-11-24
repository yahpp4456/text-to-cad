import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAuth, resolveEffort, resolveModelFor } from "./config.mjs";

export const CODEX_MODEL = "gpt-6.2-astra";
export const CODEX_EFFORT = "high";
export function providerFor(remoteUser = false) {
  return !remoteUser && process.env.CADCHAT_PROVIDER === "codex" ? "codex" : "claude";
}
export function codexBinary() {
  const installed = path.join(
    os.homedir(),
    "AppData/Local/Programs/OpenAI/Codex/bin/codex.exe",
  );
  return (
    process.env.CADCHAT_CODEX_BIN ||
    (process.platform === "win32" && fs.existsSync(installed)
      ? installed
      : "codex")
  );
}
export function codexEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(ANTHROPIC_|OPENAI_|CLAUDE_|CADCHAT_|CODEX_API_KEY$)/i.test(key),
    ),
  );
}
export async function providerHealth(demo = false, remoteUser = demo) {
  const provider = providerFor(remoteUser);
  if (provider === "claude") {
    return {
      ...resolveAuth(),
      provider,
      model: resolveModelFor({ demo }) || "(CLI 預設)",
      effort: resolveEffort(),
    };
  }
  let agentReady = false;
  try {
    const { stdout, stderr } = await promisify(execFile)(
      codexBinary(),
      ["login", "status"],
      {
        env: codexEnv(),
        windowsHide: true,
        timeout: 8000,
      },
    );
    agentReady = /logged in using chatgpt/i.test(stdout + stderr);
  } catch {
    /* health should remain available without the CLI */
  }
  return {
    agentReady,
    provider,
    model: CODEX_MODEL,
    effort: CODEX_EFFORT,
    authMode: agentReady ? "chatgpt" : "missing",
    warnings: agentReady
      ? []
      : ["請以啟動 cad-chat 的帳號登入 Codex CLI（codex login）。"],
  };
}
