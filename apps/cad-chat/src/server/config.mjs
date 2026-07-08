// 集中所有路徑、連接埠與訂閱認證解析。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)); // apps/cad-chat/src/server
export const APP_ROOT = path.resolve(serverDir, "..", ".."); // apps/cad-chat
export const REPO_ROOT = path.resolve(APP_ROOT, "..", ".."); // repo root
export const DIST_ROOT = path.join(APP_ROOT, "dist");

// Windows venv 在 Scripts/(見 CLAUDE.md);非 Windows 退回 bin/python。
export const PYTHON_EXE =
  process.platform === "win32"
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python");

export const MODELS_ROOT = path.join(REPO_ROOT, "models");
// 對話 scratch 集中在 models/.cadchat/<sessionId>/,易於 .gitignore。
export const SESSIONS_ROOT = path.join(MODELS_ROOT, ".cadchat");

export const HOST = "127.0.0.1";

// 讀取 apps/cad-chat/.env.local(若存在),把鍵注入 process.env(不覆寫已存在者)。
export function loadDotEnvLocal() {
  const file = path.join(APP_ROOT, ".env.local");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

export function resolvePort(env = process.env) {
  const raw = Number.parseInt(String(env.CADCHAT_PORT || "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8788;
}

// 啟動時 session GC 的保留天數(models/.cadchat/*)。預設 7;設 0 停用。
export function resolveGcDays(env = process.env) {
  const raw = String(env.CADCHAT_GC_DAYS || "").trim();
  if (!raw) return 7;
  const days = Number.parseFloat(raw);
  return Number.isFinite(days) ? days : 7;
}

// 每 session 版本快照數上限(versions/v*;超過刪最舊)。參數滑桿每次套用都是一版,
// 大組合件一版快照可達數 MB,長 session 不設限會吃掉 GB 級磁碟。預設 30;設 0 → 不設限。
export function resolveMaxSnapshots(env = process.env) {
  const raw = String(env.CADCHAT_MAX_SNAPSHOTS || "").trim();
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 30;
}

// agent 用的模型。未設定 → 回 null,交給 SDK(= 你 Claude Code CLI 的全域預設,
// 會跟著 /model 變,不穩定)。建議在 .env.local 明確設 CADCHAT_MODEL。
export function resolveModel(env = process.env) {
  const m = String(env.CADCHAT_MODEL || "").trim();
  return m || null;
}

// agent 推理 effort(傳給 query({effort}))。預設 xhigh。只有支援 effort 的模型有效
// (Opus 4.6+/Fable 5/Sonnet 4.6+);不支援的模型 SDK 會靜默降級。非法值 → 預設 xhigh。
export function resolveEffort(env = process.env) {
  const raw = String(env.CADCHAT_EFFORT || "").trim().toLowerCase();
  return ["low", "medium", "high", "xhigh", "max"].includes(raw) ? raw : "xhigh";
}

// agent extended thinking(可見的深度思考;傳給 query({thinking}))。**預設關閉**——
// 避免長停頓,深度由 effort 控。off/disabled/0/no/(空/非法) → 停用;adaptive/on/auto →
// 自適應(Claude 自己決定要不要想);正整數 → 固定 budgetTokens。恆回傳一個 config 物件。
export function resolveThinking(env = process.env) {
  const raw = String(env.CADCHAT_THINKING ?? "").trim().toLowerCase();
  if (raw === "adaptive" || raw === "on" || raw === "auto") return { type: "adaptive" };
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return { type: "enabled", budgetTokens: n };
  return { type: "disabled" };
}

// ── 教訓系統(lessons)──
// 總開關:CADCHAT_LESSONS=0 → 錄製/摘要/蒸餾全部 no-op。
export function lessonsEnabled(env = process.env) {
  return String(env.CADCHAT_LESSONS ?? "").trim() !== "0";
}

// 同 signature 未蒸餾案例達此門檻 → turn 結束後自動蒸餾。預設 3。
export function resolveLessonThreshold(env = process.env) {
  const raw = Number.parseInt(String(env.CADCHAT_LESSON_THRESHOLD || "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

// 蒸餾用模型(可指定便宜模型);未設 → 跟 CADCHAT_MODEL。
export function resolveLessonModel(env = process.env) {
  const m = String(env.CADCHAT_LESSONS_MODEL || "").trim();
  return m || resolveModel(env);
}

// 認證解析:雙模式。API key(產品路徑,Commercial Terms 按量計費)優先於
// 訂閱 OAuth(訂閱者本人自用;Anthropic 條款禁止把訂閱憑證轉供第三方使用者)。
export function resolveAuth(env = process.env) {
  const oauth = String(env.CLAUDE_CODE_OAUTH_TOKEN || "").trim();
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  const warnings = [];
  if (apiKey && oauth) {
    warnings.push(
      "同時設定了 ANTHROPIC_API_KEY 與 CLAUDE_CODE_OAUTH_TOKEN:採用 API key(按量計費)。要改走訂閱請移除 ANTHROPIC_API_KEY。",
    );
  }
  if (!apiKey && !oauth) {
    warnings.push(
      "未設定認證。二選一:跑 `claude setup-token` 取得訂閱 OAuth token 設 CLAUDE_CODE_OAUTH_TOKEN(限本人自用),或用 Claude Console 的 ANTHROPIC_API_KEY(產品/多人)。寫入 apps/cad-chat/.env.local 後重啟。",
    );
  }
  const authMode = apiKey ? "apikey" : oauth ? "oauth" : "missing";
  return { authMode, agentReady: authMode !== "missing", warnings };
}

// 傳給 Agent SDK query() 的環境:依 authMode 只留用得到的那一種憑證,
// 另一種刪掉(避免 CLI 自行擇優造成模式漂移)。
export function agentEnv(env = process.env) {
  const { authMode } = resolveAuth(env);
  const cloned = { ...env };
  if (authMode === "apikey") delete cloned.CLAUDE_CODE_OAUTH_TOKEN;
  else delete cloned.ANTHROPIC_API_KEY;
  return cloned;
}

// 傳給 Python 子程序的環境:兩種憑證一律刪(子程序會執行 LLM 寫出的產生器碼,
// 不得讓它讀到任何 Anthropic 憑證;CAD pipeline 也用不到)。
export function sandboxEnv(env = process.env) {
  const cloned = { ...env };
  delete cloned.ANTHROPIC_API_KEY;
  delete cloned.CLAUDE_CODE_OAUTH_TOKEN;
  return cloned;
}
