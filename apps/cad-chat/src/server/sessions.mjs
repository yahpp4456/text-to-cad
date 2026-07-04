// 對話 session registry:一個瀏覽器 chat = 一條可續接的 SDK session。
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, SESSIONS_ROOT } from "./config.mjs";

const sessions = new Map();

export function createSessionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `s_${ts}_${rand}`;
}

// sessionId 來自 client 且會進檔案路徑 — 只接受安全字元,否則視為無效重新產生。
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function getOrCreateSession(sessionId) {
  let id = SAFE_ID.test(String(sessionId || "")) ? sessionId : null;
  if (!id || !sessions.has(id)) {
    if (!id) id = createSessionId();
    const workdir = path.join(SESSIONS_ROOT, id);
    fs.mkdirSync(workdir, { recursive: true });
    // 給 Python CLI 用的 cwd 相對(正斜線)路徑。
    const workdirRel = path
      .relative(REPO_ROOT, workdir)
      .split(path.sep)
      .join("/");
    sessions.set(id, {
      sessionId: id,
      sdkSessionId: null, // 由 SDK init 訊息填入,之後 resume
      workdir,
      workdirRel,
      version: 0,
      lastName: null, // 最近成功 build 的產生器基底名(無副檔名)
      lastPartCount: 0, // 最近一次驗證的零件數(規模分級:≥8 視為大型組合件)
      rehydratedFrom: null, // 開啟既有專案時的來源目錄(models 相對;prompt 條件段用)
      imports: [], // 本 session 匯入的元件 rel 清單(imported/x.step;prompt 條件段用)
      currentAbort: null,
      childProcs: new Set(),
      busy: false,
      emit: null, // 當前 turn 的 SSE emit(由 chat handler 注入)
    });
  }
  return sessions.get(id);
}

export function getSession(id) {
  return sessions.get(id) || null;
}

// 啟動時 GC:刪掉超過 maxAgeDays 沒動過的 session 目錄(models/.cadchat/*)。
// 「動過」= 目錄本身或其頂層項目的最新 mtime(頂層就夠:所有寫入不是落在頂層檔案,
// 就是更新 imported/ 這類頂層子目錄的 mtime)。只在啟動時跑(記憶體 registry 尚空,
// 不會撞到活 session);中斷留下的半成品在期限內保留 —— rehydrate/edits 修復靠它們。
// maxAgeDays 0/負數/非數 → 停用。回傳刪除的目錄名清單(供啟動 log)。
export function gcSessions({ root = SESSIONS_ROOT, maxAgeDays, now = Date.now() } = {}) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return [];
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // 尚無 session 根目錄
  }
  const removed = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    try {
      let newest = fs.statSync(dir).mtimeMs;
      for (const child of fs.readdirSync(dir)) {
        try {
          const m = fs.statSync(path.join(dir, child)).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* 檔案消失中,忽略 */
        }
      }
      if (newest < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(ent.name);
      }
    } catch {
      /* 單一目錄失敗不擋其他 */
    }
  }
  return removed;
}
