// 對話 session registry:一個瀏覽器 chat = 一條可續接的 SDK session。
import fs from "node:fs";
import path from "node:path";

import { DATA_ROOT, SESSIONS_ROOT } from "./config.mjs";
import { USER_RE, rootsFor } from "./users.mjs";

// registry key 含使用者維度:同 id 不同 user = 不同 session(B 送 A 的 id 只會在
// B 的空間 mint 全新 session,拿不到 A 的物件或目錄)。\n 不可能出現在兩段中。
const sessions = new Map();

function mapKey(user, id) {
  return `${user || ""}\n${id}`;
}

export function createSessionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `s_${ts}_${rand}`;
}

// sessionId 來自 client 且會進檔案路徑 — 只接受安全字元,否則視為無效重新產生。
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function getOrCreateSession(sessionId, opts = {}) {
  const user = opts.user || null; // 由 userContext middleware 提供;null = legacy 全域根
  let id = SAFE_ID.test(String(sessionId || "")) ? sessionId : null;
  if (!id || !sessions.has(mapKey(user, id))) {
    if (!id) id = createSessionId();
    const { sessionsRoot, modelsRoot } = rootsFor(user);
    const workdir = path.join(sessionsRoot, id);
    fs.mkdirSync(workdir, { recursive: true });
    // 給 Python CLI 用的 cwd 相對(正斜線)路徑(spawnPython cwd=DATA_ROOT;
    // per-user 根仍在 DATA_ROOT 之下 → users/<u>/models/.cadchat/<id>,不變量保持)。
    const workdirRel = path
      .relative(DATA_ROOT, workdir)
      .split(path.sep)
      .join("/");
    const session = {
      sessionId: id,
      user, // 擁有者(null = legacy);asset/專案解析以 modelsRoot 為準
      modelsRoot,
      sdkSessionId: null, // 由 SDK init 訊息填入,之後 resume
      workdir,
      workdirRel,
      // 模式是 session 出生時的恆定屬性(草模/設計不混一條 transcript);
      // 只在 mint 時採納 opts.mode,既有 session 忽略之(呼叫端向後相容)。
      mode: opts.mode === "sketch" ? "sketch" : "design",
      version: 0,
      lastName: null, // 最近成功 build 的產生器基底名(無副檔名)
      lastPartCount: 0, // 最近一次驗證的零件數(規模分級:≥8 視為大型組合件)
      rehydratedFrom: null, // 開啟既有專案時的來源目錄(models 相對;prompt 條件段用)
      imports: [], // 本 session 匯入的元件 rel 清單(imported/x.step;prompt 條件段用)
      lastBuildMeta: null, // build sidecar 收割 {name,parts,partCount,motion,motionErrs}(transient 不落盤;rehydrate 後首次設計驗證走 --motion-only fallback)
      _lastValidate: null, // 最近一次驗證判定 {full,ok}(versionStamp 用;transient,runStep 開跑即清)
      _geomDirty: false, // 頂層基準是否已漂移(runStep 開跑=true、emitPresent=false;精算回 stale 用)
      currentAbort: null,
      childProcs: new Set(),
      busy: false,
      _busyToken: null, // busy 鎖持有權 token(acquireBusy/releaseBusy;transient 不落盤)
      emit: null, // 當前 turn 的 SSE emit(由 chat handler 注入)
    };
    hydrateSession(session); // 同 id 重掛(重整/重啟):從 session.json 還原中繼資料
    sessions.set(mapKey(user, id), session);
  }
  return sessions.get(mapKey(user, id));
}

export function getSession(id, user = null) {
  return sessions.get(mapKey(user, id)) || null;
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
          mode: session.mode === "sketch" ? "sketch" : "design",
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
  // mode 是身分不是產物,在產物守衛「之前」還原:GC 殘缺的草模 session 也不得
  // 誤翻回 design(否則重掛後 runner 會拿錯 prompt/工具集)。舊 session.json 無
  // mode 欄位 → design(向後相容)。
  session.mode = meta.mode === "sketch" ? "sketch" : "design";
  const lastName = typeof meta.lastName === "string" && meta.lastName ? meta.lastName : null;
  // 產物該在而不在(GC 後重建的空目錄、殘缺樹):什麼都不還原——
  // 尤其 sdkSessionId,resume 會 replay 引用不存在檔案的對話,LLM 必踩空。
  // 產物守衛 mode-aware:草模 session 的真相源是 <name>.sketch.json,不是 .py
  // (不分流則草模重掛必 bail → version 歸零 → v-id 相撞)。
  const artifact = session.mode === "sketch" ? `${lastName}.sketch.json` : `${lastName}.py`;
  if (lastName && !fs.existsSync(path.join(session.workdir, artifact))) return;
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
// user 維度:live-Map 與磁碟路徑都要 user-scope,否則 B 探 A 的 live id 會回 exists:true。
export function probeSessionOnDisk(id, user = null) {
  if (!SAFE_ID.test(String(id || ""))) return { exists: false };
  const live = sessions.get(mapKey(user, id));
  const workdir = path.join(rootsFor(user).sessionsRoot, id);
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
  const mode = (live ? live.mode : meta?.mode) === "sketch" ? "sketch" : "design";
  const hasGenerator = !!lastName && fs.existsSync(path.join(workdir, `${lastName}.py`));
  // 草模 session 的「還救得回來」訊號(前端開機還原用 hasGenerator||hasSketch 放行)
  const hasSketch = !!lastName && fs.existsSync(path.join(workdir, `${lastName}.sketch.json`));
  return { exists: true, lastName, version, mode, hasGenerator, hasSketch };
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

// 全空間 GC:legacy 全域根 + 每個 users/<u>/models/.cadchat。
// lessons.json 等平面檔天然存活(gcSessions 只刪目錄)。USER_RE 過濾:
// users/ 下雜檔或怪名目錄不掃、不炸啟動。回傳名單以 <user>/<id> 前綴區分。
export function gcAllSessions({
  maxAgeDays,
  now = Date.now(),
  dataRoot = DATA_ROOT,
  legacyRoot = SESSIONS_ROOT,
} = {}) {
  const removed = gcSessions({ root: legacyRoot, maxAgeDays, now });
  let ents = [];
  try {
    ents = fs.readdirSync(path.join(dataRoot, "users"), { withFileTypes: true });
  } catch {
    /* 尚無 users/ 目錄 */
  }
  for (const ent of ents) {
    if (!ent.isDirectory() || !USER_RE.test(ent.name)) continue;
    const root = path.join(dataRoot, "users", ent.name, "models", ".cadchat");
    removed.push(...gcSessions({ root, maxAgeDays, now }).map((n) => `${ent.name}/${n}`));
  }
  return removed;
}
