// Codex(ChatGPT 訂閱)到期狀態:由站外的夜間檢查(deploy/codex-sub-check)寫狀態檔,
// 這裡每次請求以 mtime 快取重讀,不必重啟就能在「到期 → Claude」「續訂 → Codex」之間切換。
//
// 啟用條件:設了 CADCHAT_CODEX_STATE_FILE 才管;未設 = 不管(本機桌面版、開發機照舊)。
// 判斷只看訂閱到期日,不看額度用量。
// 狀態檔:{ status: "ok" | "expired" | "login_invalid", activeUntil, planType, checkedAt }(ISO 時間)。
import fs from "node:fs";

/** 檢查結果多久沒更新就不再信任(夜間檢查壞掉時別讓過期的「ok」一直生效)。 */
export const CODEX_STATE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function codexStateFile(env = process.env) {
  return String(env.CADCHAT_CODEX_STATE_FILE || "").trim();
}

/** 純函式(單元測試直測):狀態物件 + 現在時間 → 能不能用 Codex,以及原因。 */
export function evaluateCodexState(state, now = Date.now()) {
  if (!state || typeof state !== "object")
    return { usable: false, reason: "state_missing" };
  if (state.status !== "ok")
    return { usable: false, reason: String(state.status || "state_invalid") };
  const until = Date.parse(state.activeUntil);
  const checked = Date.parse(state.checkedAt);
  if (!Number.isFinite(until) || !Number.isFinite(checked))
    return { usable: false, reason: "state_invalid" };
  if (now >= until) return { usable: false, reason: "expired" };
  if (now - checked > CODEX_STATE_MAX_AGE_MS)
    return { usable: false, reason: "state_stale" };
  return { usable: true, reason: "ok" };
}

let cache = { file: "", mtimeMs: -1, state: null };
let lastLogged = "";

function readState(file) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache = { file, mtimeMs: -1, state: null };
    return null;
  }
  if (cache.file === file && cache.mtimeMs === mtimeMs) return cache.state;
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* 壞檔視同沒有 */
  }
  cache = { file, mtimeMs, state };
  return state;
}

/** 現在能不能用 Codex。未設狀態檔 → 一律可用(reason "unmanaged")。 */
export function codexUsable(env = process.env, now = Date.now()) {
  const file = codexStateFile(env);
  if (!file) return { usable: true, reason: "unmanaged" };
  const verdict = evaluateCodexState(readState(file), now);
  // 只在結論改變時記一行,方便事後從 journal 看何時切換、為什麼。
  if (verdict.reason !== lastLogged) {
    lastLogged = verdict.reason;
    console.log(
      `[codex-state] ${verdict.usable ? "Codex 可用" : "改走 Claude"}(${verdict.reason})`,
    );
  }
  return verdict;
}
