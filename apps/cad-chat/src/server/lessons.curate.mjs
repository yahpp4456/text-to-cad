// 教訓庫的「人為裁決」層(純函數;零 I/O、零 LLM)。
//
// 為什麼需要(2026-11-10 整理 124 筆案例的結論):
//   1. 錄製層把不是「生成教訓」的紅也記進來——煙測暫存件(tmp_smoke_*)、基礎設施錯誤
//      (turn:*:額度用盡/模型不支援/工具呼叫解析失敗)、滑桿套到非法組合時參數防呆
//      **照設計**丟出的 ValueError。這些案例沒有建模資訊,卻佔了案例數的一半,還曾被蒸餾成
//      一條錯的規則(「MOTION 僅 linear」)。→ isNoiseCase:錄製/合併/整理共用同一判準。
//   2. 「停用」只存在各機的活庫裡:合併是 union(任一份 active 就復活)、沒有理由、沒有時間。
//      人做過的判斷(這條已寫進系統提示、那條已過期)每台機器都要手動再做一次。
//      → 裁決寫進版控檔 data/curation.lessons.json(以 signature 為鍵),applyCuration 在
//      合併時套用;教訓本身多帶 statusReason / statusNote / statusAt 三欄。
//
// 執行期(每回合的錄製、digest 注入)不讀裁決檔——只有 merge-lessons 腳本讀。執行期用到的
// 只有 isNoiseCase(flush 時濾掉雜訊)。

export const STATUS_REASONS = new Set(["manual", "graduated", "retired"]);
// manual    使用者在面板手動停用(沒給理由)
// graduated 規則已寫進系統提示或變成決定性檢查——再注入只是重複
// retired   規則過期或本來就錯(能力已變、病灶已在管線修掉、蒸餾自雜訊)

const ANSI_RE = /\u001b\[[0-9;]*m/;

/**
 * 這筆案例是不是「不該拿來學」的雜訊。
 * 回傳原因字串(供報告)或 null。
 */
export function noiseReason(c) {
  if (!c || typeof c !== "object") return "malformed";
  const sig = String(c.signature || "");
  const source = String(c.source || "");
  const part = String(c.partName || "");
  // 煙測暫存件:smoke_verify_gate 等故意餵壞參數/壞幾何驗回滾與擋匯出
  if (/^tmp_smoke/.test(part)) return "smoke-fixture";
  // 回合層錯誤是基礎設施事件(額度、模型、傳輸、輸出上限),不含任何建模資訊
  if (sig.startsWith("turn:")) return "infrastructure";
  // 滑桿重生撞到參數防呆:_check_params 丟 ValueError 正是設計行為(使用者看到人話訊息),
  // 不是生成失敗。重生撞到「非 ValueError」(幾何核心原始例外)才代表防呆沒蓋到,那種要留。
  if (source.startsWith("regen") && sig === "build:ValueError") return "guard-worked";
  // 彩色 traceback 殘骸(已在 python.mjs 以 PYTHON_COLORS=0 根治,舊資料仍有)
  if (ANSI_RE.test(String(c.note || ""))) return "ansi-garbage";
  return null;
}

export const isNoiseCase = (c) => noiseReason(c) !== null;

function signaturesOf(lesson) {
  const out = [];
  if (lesson?.signature) out.push(lesson.signature);
  if (Array.isArray(lesson?.altSignatures)) for (const s of lesson.altSignatures) if (s) out.push(s);
  return out;
}

/**
 * 驗證裁決檔形狀。回 errors[](空 = 合法)。
 */
export function validateCuration(curation) {
  const errs = [];
  if (!curation || typeof curation !== "object" || typeof curation.lessons !== "object" || !curation.lessons) {
    return ["裁決檔須為 {lessons:{<signature>:{…}}}"];
  }
  for (const [sig, e] of Object.entries(curation.lessons)) {
    if (!e || typeof e !== "object") {
      errs.push(`${sig}: 須為物件`);
      continue;
    }
    if (e.status !== "active" && e.status !== "disabled") errs.push(`${sig}: status 須為 active|disabled`);
    if (e.status === "disabled" && !STATUS_REASONS.has(e.reason)) {
      errs.push(`${sig}: 停用須給 reason(manual|graduated|retired)`);
    }
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) errs.push(`${sig}: at 須為 ISO 時間`);
    if (e.reason === "graduated" && !String(e.note || "").trim()) {
      errs.push(`${sig}: graduated 須在 note 寫明畢業到哪(系統提示哪一段/哪個檢查)`);
    }
    for (const k of ["title", "rootCause", "rule"]) {
      if (e[k] !== undefined && !String(e[k]).trim()) errs.push(`${sig}: ${k} 不可為空字串`);
    }
  }
  return errs;
}

/**
 * 把裁決套到 store(回新物件,不改輸入)。
 *   - 濾掉雜訊案例;
 *   - 逐條教訓找裁決(主 signature 或任一 altSignature 命中):
 *     裁決的 at 晚於教訓自己的 statusAt 才覆寫狀態(面板上更晚的手動切換優先);
 *     有給 title/rootCause/rule 且 at 晚於 distilledAt 才覆寫措辭(之後重新蒸餾的優先);
 *   - 案例重連結、caseCount/resolvedCount 現算。
 * 冪等:同一份 store 套兩次結果相同。
 */
export function applyCuration(store, curation = { lessons: {} }) {
  const entries = curation?.lessons || {};
  const report = { noiseRemoved: {}, statusApplied: [], wordingApplied: [], unmatched: [] };

  const cases = [];
  for (const c of store.cases || []) {
    const why = noiseReason(c);
    if (why) report.noiseRemoved[why] = (report.noiseRemoved[why] || 0) + 1;
    else cases.push({ ...c });
  }

  const matched = new Set();
  const lessons = (store.lessons || []).map((orig) => {
    const l = { ...orig };
    const sig = signaturesOf(l).find((s) => entries[s]);
    if (!sig) return l;
    matched.add(sig);
    const e = entries[sig];
    if (String(e.at) > String(l.statusAt || "")) {
      const before = `${l.status || "active"}/${l.statusReason || ""}`;
      l.status = e.status;
      l.statusAt = e.at;
      if (e.status === "disabled") {
        l.statusReason = e.reason;
        l.statusNote = String(e.note || "");
      } else {
        delete l.statusReason;
        if (e.note) l.statusNote = String(e.note);
        else delete l.statusNote;
      }
      const after = `${l.status}/${l.statusReason || ""}`;
      if (before !== after) report.statusApplied.push({ signature: l.signature, from: before, to: after });
    }
    if ((e.title || e.rootCause || e.rule) && String(e.at) > String(l.distilledAt || "")) {
      if (e.title) l.title = e.title;
      if (e.rootCause) l.rootCause = e.rootCause;
      if (e.rule) l.rule = e.rule;
      l.distilledAt = e.at;
      l.model = "curated";
      report.wordingApplied.push(l.signature);
    }
    return l;
  });
  for (const sig of Object.keys(entries)) if (!matched.has(sig)) report.unmatched.push(sig);

  // 重連結 + 計數現算(signature 是連結權威;lessonId 只是快取)
  const bySig = new Map();
  for (const l of lessons) {
    l.caseCount = 0;
    l.resolvedCount = 0;
    for (const s of signaturesOf(l)) bySig.set(s, l);
  }
  for (const c of cases) {
    const l = bySig.get(c.signature) || null;
    c.lessonId = l ? l.id : null;
    if (l) {
      l.caseCount += 1;
      if (c.resolved) l.resolvedCount += 1;
    }
  }

  // 已無案例且無教訓的 distillAttempts 鍵一併清掉(turn:* 之類)
  const liveSigs = new Set(cases.map((c) => c.signature));
  const distillAttempts = {};
  for (const [k, v] of Object.entries(store.distillAttempts || {})) if (liveSigs.has(k)) distillAttempts[k] = v;

  return { store: { ...store, cases, lessons, distillAttempts }, report };
}
