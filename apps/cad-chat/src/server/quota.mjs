// 每 DEMO 訪客的 LLM 回合配額計數器。鏡射 sessions.mjs 的落盤姿態:
// 同步 read/write JSON、try/catch 全容錯(壞檔/缺檔當全新,絕不擋 turn)。
//
// 檔案落在 rootsFor(user).sessionsRoot/quota.json(= DATA_ROOT/users/<user>/models/
// .cadchat/quota.json)——刻意是 .cadchat/ 底下的「平檔」:gcSessions 只刪目錄,故它
// 存活於 session GC;隨 gcDemoUsers 回收整個 users/demo-<id>/ 樹時一起消失(= 正確
// 壽命:配額壽命 = 身分壽命)。
//
// 記憶體 Map 為真相(以絕對檔路徑為鍵,不同 dataRoot 天然隔離,單測不互擾),
// 磁碟為重啟復原。consumeTurn 是「單一同步 檢查+遞增」:Node 單執行緒、函式內無
// await → 雙分頁並發也不會 over-grant(見 chat.mjs 的呼叫點)。
import fs from "node:fs";
import path from "node:path";

import { rootsFor } from "./users.mjs";

const QUOTA_FILE = "quota.json";

// filePath -> { count, windowStart, savedAt }
const cache = new Map();

function quotaFile(user, dataRoot) {
  return path.join(rootsFor(user, dataRoot ? { dataRoot } : undefined).sessionsRoot, QUOTA_FILE);
}

function hydrate(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    const count = Number(meta?.count);
    return {
      count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0,
      windowStart: Number(meta?.windowStart) || 0,
      savedAt: Number(meta?.savedAt) || 0,
    };
  } catch {
    return null; // 缺檔/壞檔 → 當全新
  }
}

function persist(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
  } catch {
    /* 落盤失敗不擋 turn(記憶體 Map 仍為真相) */
  }
}

// 消耗一個回合。回傳 { ok, used, limit, remaining }。
// limit<=0 → 不限(0 = 停用配額);user 空 → 防呆放行(非 demo 不該呼叫此函式)。
export function consumeTurn(user, { limit, dataRoot, now = Date.now() } = {}) {
  const lim = Number.isFinite(limit) ? Math.trunc(limit) : 0;
  if (!user || lim <= 0) return { ok: true, used: 0, limit: lim, remaining: Infinity };
  const file = quotaFile(user, dataRoot);
  const rec = cache.get(file) || hydrate(file) || { count: 0, windowStart: now, savedAt: 0 };
  if (rec.count >= lim) {
    cache.set(file, rec);
    return { ok: false, used: rec.count, limit: lim, remaining: 0 };
  }
  rec.count += 1;
  rec.savedAt = now;
  if (!rec.windowStart) rec.windowStart = now;
  cache.set(file, rec);
  persist(file, rec);
  return { ok: true, used: rec.count, limit: lim, remaining: lim - rec.count };
}

// 唯讀查詢(health 徽章用),絕不遞增。
export function quotaStatus(user, { limit, dataRoot } = {}) {
  const lim = Number.isFinite(limit) ? Math.trunc(limit) : 0;
  if (!user) return { limit: lim, used: 0, remaining: lim > 0 ? lim : Infinity };
  const file = quotaFile(user, dataRoot);
  const rec = cache.get(file) || hydrate(file) || { count: 0 };
  const used = rec.count || 0;
  return { limit: lim, used, remaining: lim > 0 ? Math.max(0, lim - used) : Infinity };
}

// 單測用:清記憶體快取(不同測試共用同 process 時避免互擾)。
export function _resetQuotaCache() {
  cache.clear();
}
