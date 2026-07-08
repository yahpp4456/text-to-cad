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
    const session = {
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
      _busyToken: null, // busy 鎖持有權 token(acquireBusy/releaseBusy;transient 不落盤)
      emit: null, // 當前 turn 的 SSE emit(由 chat handler 注入)
    };
    hydrateSession(session); // 同 id 重掛(重整/重啟):從 session.json 還原中繼資料
    sessions.set(id, session);
  }
  return sessions.get(id);
}

export function getSession(id) {
  return sessions.get(id) || null;
}

// ── busy 鎖持有權 ──
// interrupt 會提早把 busy 放行(讓使用者立刻能送下一則),此時舊 turn 還在收尾;
// 若新 turn 已經 begin,舊 turn 的 finally 無條件 busy=false 會把新 turn 的鎖清掉,
// 讓第三個請求通過 busy 檢查造成同 session 並發 turn(同 workdir 互踩、版本相撞)。
// 解法:上鎖時領 token,解鎖只在 token 仍是自己時執行。
export function acquireBusy(session) {
  session.busy = true;
  const token = Symbol("busy");
  session._busyToken = token;
  return token;
}

// 回傳是否真的由自己解鎖(false = 鎖已被 interrupt 放行或被新 turn 接手,勿再動共享狀態)。
export function releaseBusy(session, token) {
  if (session._busyToken !== token) return false;
  session.busy = false;
  session._busyToken = null;
  return true;
}

// ── session 中繼資料落盤(workdir/session.json)──
// 記憶體 registry 重啟即空;落盤讓「同 id 重掛」能還原 SDK resume(sdkSessionId)與
// version 計數器(從 0 重數會 v-id 相撞、cache-buster 重複,畫布卡死)等關鍵欄位。
const SESSION_META = "session.json";

export function persistSession(session) {
  if (!session?.workdir) return;
  try {
    fs.writeFileSync(
      path.join(session.workdir, SESSION_META),
      JSON.stringify(
        {
          sdkSessionId: session.sdkSessionId || null,
          version: session.version || 0,
          lastName: session.lastName || null,
          lastPartCount: session.lastPartCount || 0,
          rehydratedFrom: session.rehydratedFrom || null,
          imports: session.imports || [],
          savedAt: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* 落盤失敗不擋 turn(下次寫入點再試) */
  }
}

function hydrateSession(session) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(session.workdir, SESSION_META), "utf8"));
  } catch {
    return; // 沒有 / 壞掉 → 維持乾淨新 session
  }
  const lastName = typeof meta.lastName === "string" && meta.lastName ? meta.lastName : null;
  // 產物該在而不在(GC 後重建的空目錄、殘缺樹):什麼都不還原——
  // 尤其 sdkSessionId,resume 會 replay 引用不存在檔案的對話,LLM 必踩空。
  if (lastName && !fs.existsSync(path.join(session.workdir, `${lastName}.py`))) return;
  const version = Math.trunc(Number(meta.version));
  session.version = Number.isFinite(version) && version > 0 ? version : 0;
  session.lastName = lastName;
  session.lastPartCount = Number(meta.lastPartCount) > 0 ? Number(meta.lastPartCount) : 0;
  session.rehydratedFrom =
    typeof meta.rehydratedFrom === "string" && meta.rehydratedFrom ? meta.rehydratedFrom : null;
  session.imports = (Array.isArray(meta.imports) ? meta.imports : []).filter(
    (rel) => typeof rel === "string" && fs.existsSync(path.join(session.workdir, rel)),
  );
  session.sdkSessionId =
    typeof meta.sdkSessionId === "string" && meta.sdkSessionId ? meta.sdkSessionId : null;
  // 標記「resume 靠的是磁碟還原」:首個 turn 若 resume 失敗,runner 走降級接續。
  session._resumedFromDisk = !!session.sdkSessionId;
}

// 唯讀探測(絕不建目錄):/api/session-info 用,前端開機還原前驗證 session 還救得回來。
export function probeSessionOnDisk(id) {
  if (!SAFE_ID.test(String(id || ""))) return { exists: false };
  const live = sessions.get(id);
  const workdir = path.join(SESSIONS_ROOT, id);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(workdir, SESSION_META), "utf8"));
  } catch {
    /* 沒有 meta 也可能是活 session 尚未 persist */
  }
  let dirExists = false;
  try {
    dirExists = fs.statSync(workdir).isDirectory();
  } catch {
    dirExists = false;
  }
  if (!live && !dirExists) return { exists: false };
  const lastName =
    live?.lastName || (typeof meta?.lastName === "string" ? meta.lastName : null) || null;
  const version = live ? live.version : Number(meta?.version) || 0;
  const hasGenerator = !!lastName && fs.existsSync(path.join(workdir, `${lastName}.py`));
  return { exists: true, lastName, version, hasGenerator };
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
