// 教訓迴圈(lessons loop)核心:紅色驗證 → 案例 → 決定性分類 → 蒸餾成教訓 → 注入 prompt。
// 本檔負責 store(單一 JSON、原子寫、prune)、signature 函式、per-turn capture、digest;
// 蒸餾(LLM call)在 lessons.distill.mjs。
//
// 鐵則:capture / digest 的每個 export 都 best-effort、**絕不 throw 進 turn**
// (與 persistSession 同契約);store 損毀 → 改名留證 + 重建,永不擋事。
import fs from "node:fs";
import path from "node:path";

import { SESSIONS_ROOT, lessonsEnabled, resolveLessonThreshold } from "./config.mjs";
import { scrubPaths } from "./cad/python.mjs";

// ── 檔案位置 ──
// models/.cadchat/ 頂層平面檔:gcSessions 只刪目錄(sessions.mjs),平面檔天然存活 GC;
// models/.cadchat/ 已被 .gitignore 涵蓋(本機自用,不進版控)。
export function lessonsFile(root = SESSIONS_ROOT) {
  return path.join(root, "lessons.json");
}

// ── 小工具 ──
const cap = (v, n) => {
  const s = String(v ?? "").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const scrub = (v) => scrubPaths(String(v ?? ""));
const nowIso = () => new Date().toISOString();
const lessonNum = (id) => Number.parseInt(String(id || "").replace(/^LS-/, ""), 10) || 0;

// ── store(schemaVersion 1)──
function freshStore() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    seq: 0,
    lessonSeq: 0,
    cases: [],
    lessons: [],
    distillAttempts: {},
  };
}

function normalizeStore(obj) {
  return {
    schemaVersion: 1,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : null,
    seq: Number.isFinite(Number(obj.seq)) ? Number(obj.seq) : 0,
    lessonSeq: Number.isFinite(Number(obj.lessonSeq)) ? Number(obj.lessonSeq) : 0,
    cases: Array.isArray(obj.cases) ? obj.cases : [],
    lessons: Array.isArray(obj.lessons) ? obj.lessons : [],
    // 蒸餾失敗(bad_output)退避計數:{ [signature]: attempts }。成功即清除。
    distillAttempts:
      obj.distillAttempts && typeof obj.distillAttempts === "object" ? obj.distillAttempts : {},
  };
}

// 讀 store:不存在 → 空白;存在但 parse 失敗/版本不符 → 改名 .corrupt-<ts> 留證 + 空白。
export function readStore(file = lessonsFile()) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return freshStore(); // 不存在(或不可讀)→ 乾淨起步,不動磁碟
  }
  try {
    const obj = JSON.parse(text);
    if (obj?.schemaVersion !== 1) throw new Error("schemaVersion mismatch");
    return normalizeStore(obj);
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now().toString(36)}`);
    } catch {
      /* 留證失敗也不擋 */
    }
    return freshStore();
  }
}

// 寫 store:prune → tmp → renameSync(同 volume 原子替換;防程序中斷留半檔)。
// 失敗會 throw —— 呼叫端(flush/API/distill)各自 catch。
export function writeStore(store, file = lessonsFile()) {
  pruneCases(store);
  store.updatedAt = nowIso();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

// prune:檔案永遠有界。pending(未連結教訓)每 signature 上限 30(丟最舊);
// 總案例 >200 → 先丟最舊的已連結案例(證據已保留在 lesson.caseCount),再丟最舊 pending。
const MAX_CASES = 200;
const MAX_PENDING_PER_SIG = 30;
function pruneCases(store) {
  const bySig = new Map();
  for (const c of store.cases) {
    if (c.lessonId) continue;
    if (!bySig.has(c.signature)) bySig.set(c.signature, []);
    bySig.get(c.signature).push(c);
  }
  const drop = new Set();
  for (const list of bySig.values()) {
    for (let i = 0; i < list.length - MAX_PENDING_PER_SIG; i++) drop.add(list[i]);
  }
  if (drop.size) store.cases = store.cases.filter((c) => !drop.has(c));
  if (store.cases.length > MAX_CASES) {
    let excess = store.cases.length - MAX_CASES;
    const keep = [];
    // 第一輪:由舊到新丟已連結;第二輪(仍超)丟最舊 pending。
    for (const c of store.cases) {
      if (excess > 0 && c.lessonId) excess--;
      else keep.push(c);
    }
    while (keep.length > MAX_CASES) keep.shift();
    store.cases = keep;
  }
}

// ── 決定性 signature ──
// 粒度原則:例外類 + 穩定訊息前綴進 signature;自由文字(件名/數值)只進 note。
// 訊息模式押在 cadpy geometry_checks / validate.py 的實際字串上(見各行註解)。
const EXC_LINE_RE = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))\s*:\s*(.*)$/;
// 無訊息例外(裸 assert、raise ValueError()):traceback 末行只有裸例外名、無冒號。
const EXC_BARE_RE = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))$/;

export function signatureForBuild({ exitCode, stderr } = {}) {
  const lines = String(stderr || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const m = line.match(EXC_LINE_RE) || line.match(EXC_BARE_RE);
    if (!m) continue;
    const exc = m[1].split(".").pop(); // 完整限定名(cadpy.x.FooError)取類名
    const msg = m[2] || "";
    let subtype = null;
    if (exc === "AssertionError") {
      // geometry_checks.py 的 gate 全以 AssertionError 現身,必須分型才不會蒸成一鍋糊。
      if (/^interference:/.test(msg)) subtype = "interference"; // assert_no_interference
      else if (/invalid solid|^invalid /.test(msg)) subtype = "invalid-solid"; // assert_valid_solid / assert_all_valid
      else if (/pair-frame penetration/.test(msg)) subtype = "motion-clear"; // assert_motion_clear
      else subtype = "other";
    } else if (exc === "ImportError" || exc === "ModuleNotFoundError") {
      const mm = msg.match(/'([\w.]+)'/);
      if (mm) subtype = mm[1].toLowerCase();
    }
    return {
      signature: `build:${exc}${subtype ? `:${subtype}` : ""}`,
      note: cap(`${exc}: ${msg}`, 300),
    };
  }
  // 被 kill 的子程序(POSIX SIGKILL → close code null):不是生成失敗,獨立分型
  // 免得跟真 exit-0 產物缺檔混成一類。(中斷路徑另有 signal.aborted 守衛不記案例,
  // 這是漏網之魚的第二道防線。)
  if (exitCode == null) {
    return { signature: "build:killed", note: "子程序被中止" };
  }
  if (Number(exitCode) === 0) {
    return { signature: "build:no-artifacts", note: "exit 0 但 STEP/GLB 產物缺檔" };
  }
  const tail = lines.filter((l) => l.trim()).pop() || `exit ${exitCode}`;
  return { signature: `build:exit${Number(exitCode)}`, note: cap(tail, 300) };
}

export function signatureForCheck(check = {}) {
  const id = String(check.id || "unknown");
  const note = String(check.note || "");
  let sub = null;
  if (id === "motion_sweep") {
    if (/^MOTION 宣告無效/.test(note)) sub = "declaration"; // validate.py 宣告驗證
    else if (/掃掠失敗/.test(note)) sub = "sweep-error"; // 掃掠本身炸掉
    else sub = "penetration"; // 行程中真穿透
  } else if (id === "generator") {
    const m = note.match(/^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))\b/); // "{Type}: {msg}" 格式
    if (m) sub = m[1].split(".").pop();
  }
  return { signature: `validate:${id}${sub ? `:${sub}` : ""}` };
}

export function signatureForTurnError(kind) {
  return { signature: `turn:${kind === "agent_error" ? "agent_error" : "exception"}` };
}

// ── per-turn capture(記憶體 buffer;chat.mjs finally 一次 flush)──
// session._lessonRec 為 transient(_ 前綴慣例,不進 persistSession)。
// 回傳 rec 物件:呼叫端(chat.mjs)持有引用,flush 時做身份比對——interrupt 提早放行
// busy 後,舊 turn 的 finally 可能晚於新 turn 的 begin 執行,不可誤刷/誤清新 turn 的 buffer。
export function beginTurnRecorder(session, { userText } = {}) {
  try {
    if (!session || !lessonsEnabled()) return null;
    session._lessonRec = {
      turnId: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      userText: cap(scrub(userText), 200),
      cases: [],
      lastFix: null,
    };
    return session._lessonRec;
  } catch {
    return null; /* no-throw 契約 */
  }
}

function pushCase(session, entry) {
  const rec = session?._lessonRec;
  if (!rec) return;
  rec.cases.push({
    at: nowIso(),
    resolved: false,
    resolvedBy: null,
    fixEdits: null,
    retry: null,
    partCount: session.lastPartCount || 0,
    attempt: session._valAttempt || 0,
    ...entry,
  });
}

export function recordBuildFailure(session, { part, exitCode, stderr, source = "build" } = {}) {
  try {
    const sig = signatureForBuild({ exitCode, stderr });
    pushCase(session, {
      source,
      signature: sig.signature,
      note: scrub(sig.note),
      stderrTail: cap(scrub(stderr), 400) || null,
      partName: part || null,
    });
  } catch {
    /* no-throw */
  }
}

// edits/params 套用失敗(還沒跑 Python 就被擋,如 find 不唯一)。
export function recordApplyFailure(session, { part, kind, error } = {}) {
  try {
    pushCase(session, {
      source: "build",
      signature: `build:${kind === "params" ? "params" : "edits"}-failed`,
      note: cap(scrub(error), 300),
      stderrTail: null,
      partName: part || null,
    });
  } catch {
    /* no-throw */
  }
}

export function recordCheckFailure(session, { part, check, partCount, source = "validate" } = {}) {
  try {
    const sig = signatureForCheck(check);
    pushCase(session, {
      source,
      signature: sig.signature,
      note: cap(scrub(check?.note || check?.label || check?.id), 300),
      stderrTail: null,
      partName: part || null,
      ...(Number(partCount) > 0 ? { partCount: Number(partCount) } : {}),
    });
  } catch {
    /* no-throw */
  }
}

export function recordTurnError(session, message, kind) {
  try {
    const sig = signatureForTurnError(kind);
    pushCase(session, {
      source: "turn",
      signature: sig.signature,
      note: cap(scrub(message?.message || message), 300),
      stderrTail: null,
      partName: session?.lastName || null,
    });
  } catch {
    /* no-throw */
  }
}

// agent 的 emit_retry 自診(reason+adjustment)= 蒸餾的最高價值原料。
// 附到 buffer 中所有尚無 retry 資訊的未 resolved 案例(retry 描述的是它前面的失敗)。
export function noteRetry(session, { reason, adjustment } = {}) {
  try {
    const rec = session?._lessonRec;
    if (!rec) return;
    const r = { reason: cap(scrub(reason), 200), adjustment: cap(scrub(adjustment), 200) };
    for (const c of rec.cases) {
      if (!c.resolved && !c.retry) c.retry = r;
    }
  } catch {
    /* no-throw */
  }
}

// cad_build 進場時記錄本次修法(kind + edits find 首行摘要),成功時回填給被閉環的案例。
export function noteFixAttempt(session, { kind, edits } = {}) {
  try {
    const rec = session?._lessonRec;
    if (!rec) return;
    rec.lastFix = {
      kind: kind || "code",
      summary: Array.isArray(edits)
        ? edits.slice(0, 3).map((e) => cap(scrub(String(e?.find || "").split("\n")[0]), 80))
        : null,
    };
  } catch {
    /* no-throw */
  }
}

function resolveCases(session, filter) {
  const rec = session?._lessonRec;
  if (!rec) return;
  const fix = rec.lastFix || { kind: "code", summary: null };
  for (const c of rec.cases) {
    if (c.resolved || c.source === "turn") continue; // turn error 永不 resolved
    if (!filter(c)) continue;
    c.resolved = true;
    c.resolvedBy = fix.kind;
    c.fixEdits = fix.summary;
  }
}

// build 成功 → 閉環 build 類失敗;validate 全綠 → 閉環全部(同 turn 後續成功 = 前面失敗被修復)。
export function noteBuildSuccess(session) {
  try {
    resolveCases(session, (c) => c.source === "build" || c.source === "regen_build");
  } catch {
    /* no-throw */
  }
}

export function noteValidateSuccess(session) {
  try {
    resolveCases(session, () => true);
  } catch {
    /* no-throw */
  }
}

// turn 結束一次落盤:既有教訓的 signature → 直接連結+計數(免費的「教訓有沒有用」訊號:
// 蒸餾後計數仍漲=沒用=停用它);否則進 pending。回傳達門檻的 signatures(給蒸餾排程)。
// rec:begin 時拿到的 buffer 引用。只在 session 上掛的仍是同一個 buffer 時才清掉——
// 舊 turn 的 finally 若晚於新 turn 的 begin,只 flush 自己的案例,不動新 turn 的 buffer。
export function flushTurnRecorder(session, { file = lessonsFile(), rec } = {}) {
  try {
    const target = rec !== undefined ? rec : session?._lessonRec;
    if (session && session._lessonRec === target) session._lessonRec = null;
    if (!target || !target.cases.length || !lessonsEnabled()) return { eligible: [] };
    const store = readStore(file);
    const threshold = resolveLessonThreshold();
    const eligible = new Set();
    for (const c of target.cases) {
      store.seq += 1;
      const kase = {
        id: `c_${store.seq}`,
        at: c.at,
        sessionId: session?.sessionId || null,
        turnId: target.turnId,
        source: c.source,
        signature: c.signature,
        userText: target.userText || "",
        note: c.note,
        stderrTail: c.stderrTail,
        partName: c.partName,
        partCount: c.partCount,
        attempt: c.attempt,
        retry: c.retry,
        resolved: c.resolved,
        resolvedBy: c.resolvedBy,
        fixEdits: c.fixEdits,
        lessonId: null,
      };
      const lesson = store.lessons.find(
        (l) =>
          l.signature === kase.signature ||
          (Array.isArray(l.altSignatures) && l.altSignatures.includes(kase.signature)),
      );
      if (lesson) {
        kase.lessonId = lesson.id;
        lesson.caseCount = (lesson.caseCount || 0) + 1;
        if (kase.resolved) lesson.resolvedCount = (lesson.resolvedCount || 0) + 1;
        lesson.lastHitAt = kase.at;
      } else {
        const pending =
          store.cases.filter((x) => x.signature === kase.signature && !x.lessonId).length + 1;
        if (pending >= threshold) eligible.add(kase.signature);
      }
      store.cases.push(kase);
    }
    writeStore(store, file);
    return { eligible: [...eligible] };
  } catch {
    return { eligible: [] }; // 學習系統 best-effort:落盤失敗丟本 turn 案例,不擋事
  }
}

// ── 人工記教訓(對話流「是/否卡」按「是」→ POST /api/lessons/record → 這裡)──
// 補教訓迴圈唯一缺口:一整類缺陷是「驗證全綠、只有看渲染才發現」(如鏡射對稱破壞的
// 肋錯位),使用者口頭回饋 → agent 一次 cad_build(edits) 修好,前面零失敗案例、零
// emit_retry → flushTurnRecorder 一個 case 都沒產生 → 迴圈對它是瞎的。此函式讓 agent
// 整理好的(症狀/根因/修法)不經 RED 直接落成一筆未蒸餾 pending case。
//
// **不走 per-turn buffer**:提交是按鈕點擊的獨立 HTTP 請求,可能落在非同回合(甚至無
// 進行中 turn)——直寫 store。**throw 契約與 CRUD 端點一致**(不同於本檔 capture/digest
// 的 no-throw 鐵則):writeStore 失敗讓它 throw,由 middleware catch 回 500,絕不吞成
// 假✓(前端卡會顯示「已加入」但磁碟什麼都沒有)。
export function manualSignature(tag) {
  const slug = String(tag ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `manual:${slug || "misc"}`;
}

export function recordManualLesson(
  { sessionId, symptom, rootCause, fix, tag, partName } = {},
  { file = lessonsFile() } = {},
) {
  if (!lessonsEnabled()) return { ok: false, error: "disabled" };
  const sym = cap(scrub(symptom), 200);
  const rc = cap(scrub(rootCause), 200);
  const fx = cap(scrub(fix), 200);
  if (!sym && !fx) return { ok: false, error: "empty" }; // 至少要有症狀或修法才成一筆教訓
  const signature = manualSignature(tag);
  const store = readStore(file);
  store.seq += 1;
  const at = nowIso();
  const kase = {
    id: `c_${store.seq}`,
    at,
    sessionId: sessionId || null,
    turnId: null,
    source: "manual",
    signature,
    userText: sym, // 蒸餾 prompt 讀 userText 當「需求」欄 → 放症狀語境
    note: cap(`${sym}${rc ? ` — 根因:${rc}` : ""}`, 300),
    stderrTail: null,
    partName: partName || null,
    partCount: 0,
    attempt: 0,
    // retry.reason/adjustment 是蒸餾最高價值原料(同 emit_retry 自診慣例):症狀 → 修法。
    retry: { reason: sym, adjustment: fx },
    resolved: true,
    resolvedBy: "manual",
    fixEdits: fx ? [cap(fx, 80)] : null,
    lessonId: null,
  };
  // 命中既有教訓的 signature/altSignatures → 直接連結+計數(同 flushTurnRecorder 語意);
  // 否則留 pending(未蒸餾),由使用者面板「立即蒸餾」升級(自動蒸餾不碰 manual:,見 distill)。
  const lesson = store.lessons.find(
    (l) =>
      l.signature === signature ||
      (Array.isArray(l.altSignatures) && l.altSignatures.includes(signature)),
  );
  if (lesson) {
    kase.lessonId = lesson.id;
    lesson.caseCount = (lesson.caseCount || 0) + 1;
    if (kase.resolved) lesson.resolvedCount = (lesson.resolvedCount || 0) + 1;
    lesson.lastHitAt = at;
  }
  store.cases.push(kase);
  writeStore(store, file); // 失敗會 throw → middleware catch 回 500(見檔頭契約說明)
  return { ok: true, caseId: kase.id, signature, linkedLessonId: lesson ? lesson.id : null };
}

// ── pending 統計(API 面板 + 蒸餾排程共用)──
export function pendingGroups(store) {
  const map = new Map();
  for (const c of store.cases) {
    if (c.lessonId) continue;
    const g =
      map.get(c.signature) || {
        signature: c.signature,
        count: 0,
        lastAt: null,
        attempts: Number(store.distillAttempts?.[c.signature]) || 0, // 蒸餾失敗退避計數
        cases: [], // 逐筆(供面板單筆刪除);蒸餾排程只讀 count/attempts,多這欄無妨
      };
    g.count += 1;
    if (!g.lastAt || c.at > g.lastAt) g.lastAt = c.at;
    g.cases.push({ id: c.id, at: c.at, source: c.source, note: c.note, partName: c.partName });
    map.set(c.signature, g);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ── 教訓 CRUD(API 用)──
export function updateLessonStatus(id, status, { file = lessonsFile() } = {}) {
  if (status !== "active" && status !== "disabled") return { ok: false, error: "bad_status" };
  const store = readStore(file);
  const lesson = store.lessons.find((l) => l.id === id);
  if (!lesson) return { ok: false, error: "not_found" };
  lesson.status = status;
  writeStore(store, file);
  return { ok: true };
}

// 刪除教訓 = 「我不要這條規則」:連結案例一併移除(已消化的證據跟著作廢)。
// 若清回 pending,下一個 turn 的自動蒸餾會從同一批舊案例把幾乎同文的教訓原樣重蒸
// 出來(=刪除被系統撤銷,還白燒一次 LLM);移除後要再累積「新」紅才會重新蒸餾。
export function deleteLesson(id, { file = lessonsFile() } = {}) {
  const store = readStore(file);
  const idx = store.lessons.findIndex((l) => l.id === id);
  if (idx === -1) return { ok: false, error: "not_found" };
  store.lessons.splice(idx, 1);
  store.cases = store.cases.filter((c) => c.lessonId !== id);
  writeStore(store, file);
  return { ok: true };
}

// 刪除單筆未蒸餾案例(pending,lessonId=null):使用者手動剔除雜訊/誤記的紅,免得
// 湊到門檻被蒸餾成沒價值的教訓。只准刪 pending——已連結教訓的案例是該教訓 caseCount
// 的證據,單獨刪會讓計數與實際案例數不一致(要清已消化的證據請刪整條教訓,
// deleteLesson 會連帶移除)。不存在或已連結 → not_found(端點回 404)。
export function deleteCase(id, { file = lessonsFile() } = {}) {
  const store = readStore(file);
  const idx = store.cases.findIndex((c) => c.id === id && !c.lessonId);
  if (idx === -1) return { ok: false, error: "not_found" };
  store.cases.splice(idx, 1);
  writeStore(store, file);
  return { ok: true };
}

// ── prompt digest ──
// active 教訓;>max 條取 caseCount top-N 後依 id 排序(決定性、prompt-cache 友善);
// 總量 hard cap;0 條 → ""(冷啟動完全不出現段落)。
// 段首從屬聲明:防壞教訓凌駕手寫契約。
export function buildDigest(store, { max = 10, budget = 1000 } = {}) {
  const active = (store?.lessons || []).filter((l) => l.status === "active");
  if (!active.length) return "";
  const top =
    active.length > max
      ? [...active].sort((a, b) => (b.caseCount || 0) - (a.caseCount || 0)).slice(0, max)
      : [...active];
  top.sort((a, b) => lessonNum(a.id) - lessonNum(b.id));
  const header = "# 累積教訓(由歷史失敗自動蒸餾;若與上方規則衝突,以上方規則為準)";
  const lines = [header];
  let size = header.length;
  for (const l of top) {
    // 行內不放活計數(caseCount 每次命中都 +1,放進去會讓 digest 每個失敗 turn 都變,
    // 系統提示前綴 cache 全失效);計數只在面板顯示。
    const line = `- [${l.id}] ${l.rule}(根因:${l.rootCause})`;
    if (size + line.length + 1 > budget) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// 每 turn 開始呼叫一次(runner.mjs):讀檔+組摘要,任何失敗回 ""(絕不擋 turn)。
export function getLessonsDigest({ file = lessonsFile() } = {}) {
  try {
    if (!lessonsEnabled()) return "";
    return buildDigest(readStore(file));
  } catch {
    return "";
  }
}
