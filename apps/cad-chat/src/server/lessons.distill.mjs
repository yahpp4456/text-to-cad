// 教訓蒸餾:同 signature 的 pending 案例叢集 → 一次 LLM call → 一條教訓(根因+預防規則)。
// 觸發:turn 結束後 fire-and-forget(門檻見 config resolveLessonThreshold)或 API 手動。
// 紀律:single-flight、await 前 snapshot 案例 id、await 後重讀 store 只標記 snapshot
// (與新 turn 的 append 併發安全);輸出不合法 → 什麼都不寫,pending 保留下次再試。
import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  REPO_ROOT,
  agentEnv,
  lessonsEnabled,
  resolveAuth,
  resolveClaudeCliExe,
  resolveLessonModel,
  resolveLessonThreshold,
} from "./config.mjs";
import { DISALLOWED } from "./agent/runner.mjs";
import { scrubPaths } from "./cad/python.mjs";
import { lessonsFile, pendingGroups, readStore, writeStore } from "./lessons.mjs";

const nowIso = () => new Date().toISOString();
const clamp = (v, n) => {
  const s = String(v ?? "").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// 系統提示已靜態涵蓋的規則摘要(prompt.mjs 鐵則 + skills/cad/references/lessons.md L-1..L-5)。
// 蒸餾出的教訓必須是這些「之外」的新增細節;prompt.mjs 大改時同步這份摘要。
export const STATIC_RULES_SUMMARY = `- PARAMS 單層 dict 契約、gen_step() 無參數、check_geometry 寫檔前 gate
- INTENDED_CONTACT 白名單語意;結構件不得互穿(接合須銷媒介/面貼合,L-5)
- MOTION v1 宣告(linear、moving/pairs label 唯一、travel 引用 PARAMS);獨立末端缸各自成 DOF
- 修復一律 cad_build(edits) 最小段精修,不重送整份 code;retry 上限 3 次後誠實回報
- 大型組合件(≥8 件):每子系統一個 builder、定位常數集中頂部一張表、IC 按介面分組
- 靜態教訓 L-1..L-5:無效實體必擋 / 全對干涉列舉 / 允收白名單 / 運動掃掠含 baseline / 禁黏方塊`;

// ── 蒸餾提示(繁中)──
export function buildDistillPrompt(signature, cases, { existingLesson = null, existingLessons = [] } = {}) {
  const caseLines = cases
    .map((c, i) => {
      const parts = [
        `${i + 1}. 需求:「${c.userText || "(無)"}」`,
        `   錯誤:${c.note || "(無)"}`,
      ];
      if (c.retry?.reason) parts.push(`   代理自診:${c.retry.reason} → 調整:${c.retry.adjustment || "(無)"}`);
      if (c.fixEdits?.length) parts.push(`   實際修復 edits:${c.fixEdits.join(" / ")}`);
      parts.push(`   結果:${c.resolved ? `已修復(${c.resolvedBy || "?"})` : "未修復"}`);
      return parts.join("\n");
    })
    .join("\n");
  const others = existingLessons
    .map((l) => `- ${l.id}「${l.title}」:${l.rule}`)
    .join("\n");
  return `你是本機「對話式 CAD 產圖」系統的失敗案例蒸餾器。以下是同一簽名「${signature}」的失敗案例叢集,請蒸餾成一條可注入系統提示的教訓,讓代理下次生成時避免重犯。

## 案例(共 ${cases.length} 筆;「已修復」者附代理實際修法,參考價值最高)
${caseLines}

## 系統提示已有的靜態規則(教訓必須是這些之外的新增細節,禁止重複)
${STATIC_RULES_SUMMARY}

## 既有動態教訓(若本叢集實質同一根因,回 duplicateOf 填其 id)
${others || "(無)"}
${
  existingLesson
    ? `\n## 待修訂的既有教訓(依新案例修訂條文,保持同一根因方向)\n${existingLesson.id}「${existingLesson.title}」根因:${existingLesson.rootCause} 規則:${existingLesson.rule}\n`
    : ""
}
## 輸出要求
只輸出一個 JSON 物件(不加 markdown 圍欄、不加任何其他文字):
{"title":"不超過20字的短標題","rootCause":"一句話根因,不超過60字,講原因不講症狀","rule":"一條祈使句預防規則,不超過120字,寫給下一次生成時的代理直接遵守","graduationCandidate":布林(夠通用且穩定,值得人工升級為決定性檢查或靜態教訓帳本),"duplicateOfStatic":布林(上列靜態規則已完全涵蓋此教訓),"duplicateOf":"LS-n 或 null(與上列某條既有動態教訓實質相同時填其 id)"}`;
}

// ── 輸出解析(shape gate:不合法一律回 null,呼叫端什麼都不寫)──
export function parseDistillOutput(text) {
  try {
    let t = String(text || "").replace(/```(?:json)?/gi, "");
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    const obj = JSON.parse(t.slice(a, b + 1));
    const title = clamp(obj.title, 40);
    const rootCause = clamp(obj.rootCause, 120);
    const rule = clamp(obj.rule, 160);
    if (!title || !rootCause || !rule) return null;
    return {
      title,
      rootCause,
      rule,
      graduationCandidate: obj.graduationCandidate === true,
      duplicateOfStatic: obj.duplicateOfStatic === true,
      duplicateOf:
        typeof obj.duplicateOf === "string" && /^LS-\d+$/.test(obj.duplicateOf.trim())
          ? obj.duplicateOf.trim()
          : null,
    };
  } catch {
    return null;
  }
}

// ── 一次性 LLM call(重用 Agent SDK 通道;無工具、單回合、120s 深水閘)──
async function defaultCallLlm(promptText) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  timer.unref?.();
  try {
    const model = resolveLessonModel();
    // packaged 釘 CLI 路徑(第二顆 claude.exe——蒸餾也 spawn CLI,與 runner 同規)
    const claudeCli = resolveClaudeCliExe();
    const q = query({
      prompt: promptText,
      options: {
        ...(model ? { model } : {}),
        ...(claudeCli ? { pathToClaudeCodeExecutable: claudeCli } : {}),
        cwd: REPO_ROOT,
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        disallowedTools: DISALLOWED, // 與 runner 同紀律:非同步家族整個移除
        permissionMode: "default",
        abortController: abort,
        env: agentEnv(),
      },
    });
    let text = "";
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const b of msg.message?.content || []) {
          if (b.type === "text") text += b.text;
        }
      } else if (msg.type === "result") {
        if (!text && typeof msg.result === "string") text = msg.result;
        break;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
    abort.abort(); // 殺殭屍 CLI(正常結束為 no-op)
  }
}

// ── single-flight(單使用者本機,module boolean 即夠)──
let inFlight = false;
export function distillInFlight() {
  return inFlight;
}

// 蒸餾失敗(bad_output)退避:同 signature 連敗 ≥2 次後,自動蒸餾不再嘗試
// (否則每個 turn 的 fire-and-forget 會對「穩定蒸不出合法輸出」的叢集無限重燒 LLM);
// 手動(force)不受限,成功即清計數。
const MAX_AUTO_ATTEMPTS = 2;

function bumpAttempts(signature, file, { clear = false } = {}) {
  try {
    const store = readStore(file);
    if (clear) delete store.distillAttempts[signature];
    else store.distillAttempts[signature] = (Number(store.distillAttempts[signature]) || 0) + 1;
    writeStore(store, file);
  } catch {
    /* 退避計數是輔助資訊,寫失敗不擋 */
  }
}

// 蒸餾一個 signature 叢集。呼叫端持有 inFlight。
async function distillSignature(signature, { file, callLlm, env }) {
  const store = readStore(file);
  const pending = store.cases.filter((c) => c.signature === signature && !c.lessonId);
  if (!pending.length) return { ok: false, reason: "no_pending" };
  const snapshotIds = new Set(pending.map((c) => c.id));
  const prompt = buildDistillPrompt(signature, pending.slice(-10), {
    existingLessons: store.lessons.map((l) => ({ id: l.id, title: l.title, rule: l.rule })),
  });
  const text = await callLlm(prompt);
  const parsed = parseDistillOutput(text);
  if (!parsed) {
    bumpAttempts(signature, file);
    return { ok: false, reason: "bad_output" };
  }

  // await 期間可能有新 turn append → 重讀,只標記 snapshot 內的案例。
  const fresh = readStore(file);
  const snapCases = fresh.cases.filter((c) => snapshotIds.has(c.id) && !c.lessonId);
  let lesson = parsed.duplicateOf ? fresh.lessons.find((l) => l.id === parsed.duplicateOf) : null;
  // 去重防線(不只靠 LLM 自覺回 duplicateOf):同 signature 已有教訓 → 連結過去,
  // 絕不建第二條(await 期間 flush 進來的同簽名案例會走到這裡)。
  if (!lesson) {
    lesson =
      fresh.lessons.find(
        (l) =>
          l.signature === signature ||
          (Array.isArray(l.altSignatures) && l.altSignatures.includes(signature)),
      ) || null;
  }
  const now = nowIso();
  if (lesson) {
    // 併簽名:讓之後同 signature 的紅在 flush 直接連結,不再重複蒸餾。
    if (lesson.signature !== signature) {
      lesson.altSignatures = Array.isArray(lesson.altSignatures) ? lesson.altSignatures : [];
      if (!lesson.altSignatures.includes(signature)) lesson.altSignatures.push(signature);
    }
  } else {
    fresh.lessonSeq += 1;
    lesson = {
      id: `LS-${fresh.lessonSeq}`,
      signature,
      // 靜態規則已涵蓋 → 仍建檔(案例消化、面板可見)但 disabled,digest 不注入。
      status: parsed.duplicateOfStatic ? "disabled" : "active",
      title: parsed.title,
      rootCause: parsed.rootCause,
      rule: parsed.duplicateOfStatic ? `(靜態規則已涵蓋)${parsed.rule}` : parsed.rule,
      caseCount: 0,
      resolvedCount: 0,
      graduationCandidate: parsed.graduationCandidate,
      createdAt: now,
      lastHitAt: null,
      distilledAt: now,
      model: resolveLessonModel(env) || null,
    };
    fresh.lessons.push(lesson);
  }
  for (const c of snapCases) {
    c.lessonId = lesson.id;
    lesson.caseCount = (lesson.caseCount || 0) + 1;
    if (c.resolved) lesson.resolvedCount = (lesson.resolvedCount || 0) + 1;
    if (!lesson.lastHitAt || c.at > lesson.lastHitAt) lesson.lastHitAt = c.at;
  }
  lesson.distilledAt = now;
  delete fresh.distillAttempts[signature]; // 成功 → 清退避計數
  writeStore(fresh, file);
  return { ok: true, lessonId: lesson.id };
}

// 主入口:pending 達門檻的 signatures 依 count 降冪逐一蒸餾(自動 ≤3 個/run,手動 ≤5)。
// 永不 reject;所有失敗以 { ok:false, reason } 回報。
export async function maybeDistill({
  force = false,
  file = lessonsFile(),
  callLlm = defaultCallLlm,
  env = process.env,
} = {}) {
  try {
    if (!lessonsEnabled(env)) return { ok: false, reason: "disabled", distilled: [], skipped: [] };
    if (!resolveAuth(env).agentReady) {
      return { ok: false, reason: "agent_not_ready", distilled: [], skipped: [] };
    }
    if (inFlight) return { ok: false, reason: "in_flight", distilled: [], skipped: [] };
    inFlight = true;
    try {
      const threshold = force ? 1 : resolveLessonThreshold(env);
      const groups = pendingGroups(readStore(file)).filter(
        (g) =>
          g.count >= threshold &&
          // 自動蒸餾:排除人工記的 manual: 教訓(定案「留 pending 手動蒸餾」——只由使用者
          // 面板「立即蒸餾」升級),且對連敗 ≥MAX_AUTO_ATTEMPTS 的叢集放棄(退避);
          // 手動 force 兩者皆不受限。
          (force || (!g.signature.startsWith("manual:") && (g.attempts || 0) < MAX_AUTO_ATTEMPTS)),
      );
      const limit = force ? 5 : 3;
      const distilled = [];
      const skipped = [];
      for (const g of groups.slice(0, limit)) {
        const r = await distillSignature(g.signature, { file, callLlm, env });
        if (r.ok) distilled.push(r.lessonId);
        else skipped.push({ signature: g.signature, reason: r.reason });
      }
      return { ok: true, distilled, skipped };
    } finally {
      inFlight = false;
    }
  } catch (err) {
    inFlight = false;
    // reason 會經 /api/lessons/distill 原樣回給 client → 路徑要先消毒
    return { ok: false, reason: scrubPaths(String(err?.message || err)), distilled: [], skipped: [] };
  }
}

// 人工精修單條教訓(面板「重新蒸餾」):用該教訓的連結案例(最新 ≤10)+ 既有條文重蒸,
// 更新 title/rootCause/rule。只有人工觸發會改寫既有教訓 —— 自動蒸餾永遠只建新條。
export async function redistillLesson(
  id,
  { file = lessonsFile(), callLlm = defaultCallLlm, env = process.env } = {},
) {
  try {
    if (!lessonsEnabled(env)) return { ok: false, reason: "disabled" };
    if (!resolveAuth(env).agentReady) return { ok: false, reason: "agent_not_ready" };
    if (inFlight) return { ok: false, reason: "in_flight" };
    inFlight = true;
    try {
      const store = readStore(file);
      const lesson = store.lessons.find((l) => l.id === id);
      if (!lesson) return { ok: false, reason: "not_found" };
      const cases = store.cases.filter((c) => c.lessonId === id).slice(-10);
      if (!cases.length) return { ok: false, reason: "no_cases" };
      const prompt = buildDistillPrompt(lesson.signature, cases, {
        existingLesson: lesson,
        existingLessons: store.lessons
          .filter((l) => l.id !== id)
          .map((l) => ({ id: l.id, title: l.title, rule: l.rule })),
      });
      const text = await callLlm(prompt);
      const parsed = parseDistillOutput(text);
      if (!parsed) return { ok: false, reason: "bad_output" };
      const fresh = readStore(file);
      const target = fresh.lessons.find((l) => l.id === id);
      if (!target) return { ok: false, reason: "not_found" };
      target.title = parsed.title;
      target.rootCause = parsed.rootCause;
      target.rule = parsed.rule;
      target.graduationCandidate = parsed.graduationCandidate;
      if (parsed.duplicateOfStatic) target.status = "disabled";
      target.distilledAt = nowIso();
      target.model = resolveLessonModel(env) || null;
      writeStore(fresh, file);
      return { ok: true, lessonId: id };
    } finally {
      inFlight = false;
    }
  } catch (err) {
    inFlight = false;
    return { ok: false, reason: scrubPaths(String(err?.message || err)) };
  }
}
