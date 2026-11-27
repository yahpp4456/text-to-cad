import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAuth, resolveEffort, resolveModelFor } from "./config.mjs";
import { codexUsable } from "./codexState.mjs";

export const CODEX_MODEL = "gpt-6.2-astra";
export const CODEX_EFFORT = "high";

// DEMO 訪客要不要走 Codex:CADCHAT_DEMO_PROVIDER=codex 才開(預設 Claude)。
// 刻意不重用 CADCHAT_PROVIDER——那個旗標同時會開啟本機桌面模式(health / session-snapshot)。
export function demoProvider(env = process.env) {
  return String(env.CADCHAT_DEMO_PROVIDER || "").trim().toLowerCase() === "codex"
    ? "codex"
    : "claude";
}

// 團隊帳號要不要走 Codex:CADCHAT_TEAM_PROVIDER=codex 才開(預設 Claude)。與 DEMO 各自獨立。
export function teamProvider(env = process.env) {
  return String(env.CADCHAT_TEAM_PROVIDER || "").trim().toLowerCase() === "codex"
    ? "codex"
    : "claude";
}

// 這個請求該用哪個代理(同步、不碰外部程序;登入狀態另由 pickProvider 把關)。
//   無身分(本機桌面版) → 照 CADCHAT_PROVIDER,行為不變。
//   DEMO 訪客           → CADCHAT_DEMO_PROVIDER=codex 且訂閱未到期(codexState)才是 Codex。
//   團隊帳號            → CADCHAT_TEAM_PROVIDER=codex 且訂閱未到期才是 Codex;未設 = Claude。
export function providerFor({ user = false, demo = false } = {}) {
  if (!user && !demo)
    return process.env.CADCHAT_PROVIDER === "codex" ? "codex" : "claude";
  const wanted = demo ? demoProvider() : teamProvider();
  return wanted === "codex" && codexUsable().usable ? "codex" : "claude";
}

// ── 同時進行的 Codex 回合上限(只管網站訪客;桌面版單人不設限)──
// 每個 Codex 回合多一個 app-server 程序,VM 記憶體有限;滿了的請求改走 Claude。
export function resolveCodexMaxTurns(env = process.env) {
  const n = Number(String(env.CADCHAT_CODEX_MAX_TURNS || "").trim());
  return Number.isInteger(n) && n > 0 ? n : 2;
}
let codexTurnsActive = 0;
/** 領一個 Codex 回合名額;滿了回 null。回傳的函式釋放名額(可重複呼叫)。 */
export function acquireCodexSlot(env = process.env) {
  if (codexTurnsActive >= resolveCodexMaxTurns(env)) return null;
  codexTurnsActive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    codexTurnsActive -= 1;
  };
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
// `codex login status` 每次要 spawn 一個程序;結果快取 60 秒(回合失敗時由 forgetCodexLogin 作廢)。
const LOGIN_TTL_MS = 60_000;
let loginCache = { at: 0, ready: false };
export function forgetCodexLogin() {
  loginCache = { at: 0, ready: false };
}
async function codexLoggedIn() {
  if (Date.now() - loginCache.at < LOGIN_TTL_MS) return loginCache.ready;
  let ready = false;
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
    ready = /logged in using chatgpt/i.test(stdout + stderr);
  } catch {
    /* health should remain available without the CLI */
  }
  loginCache = { at: Date.now(), ready };
  return ready;
}

function claudeHealth(demo) {
  return {
    ...resolveAuth(),
    provider: "claude",
    model: resolveModelFor({ demo }) || "(CLI 預設)",
    effort: resolveEffort(),
  };
}

// 這個請求實際會用的代理 + 就緒狀態(chat 與 /api/health 共用,兩邊結論一致)。
// 網站訪客選到 Codex 但 Codex CLI 沒登入 → 直接改回 Claude,不讓訪客看到維運訊息;
// 本機桌面版維持原樣(回報未就緒,提示使用者 codex login)。
export async function providerHealth({ user = false, demo = false } = {}) {
  if (providerFor({ user, demo }) === "claude") return claudeHealth(demo);
  const agentReady = await codexLoggedIn();
  if (!agentReady && (user || demo)) return claudeHealth(demo);
  return {
    agentReady,
    provider: "codex",
    model: CODEX_MODEL,
    effort: CODEX_EFFORT,
    authMode: agentReady ? "chatgpt" : "missing",
    warnings: agentReady
      ? []
      : ["請以啟動 cad-chat 的帳號登入 Codex CLI（codex login）。"],
  };
}
