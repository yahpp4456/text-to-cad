// 合併多台電腦的教訓庫(lessons store)。
//
// 為什麼需要:case id `c_N` / lesson id `LS-N` 都是各機**本機遞增計數器**(見
// src/server/lessons.mjs 的 store.seq++ / lessonSeq++),兩台必撞號但語意不同,
// 無法靠 id 或 git 三方合併對齊。真正的連結權威是 **signature**——runtime 的
// flushTurnRecorder / distillSignature 都是靠 `l.signature === c.signature ||
// l.altSignatures.includes(...)` 連結,`case.lessonId` 只是快取。
//
// 本工具因此以 signature 為 lesson 去重主鍵、以自然鍵(session/turn/at/sig)為
// case 去重鍵,重新分配所有 id、按 signature 權威重連結,產出一份 union。整個
// mergeStores 是輸入的純函數 → 完全 idempotent(重複執行結果穩定)。
//
// 用法(在 apps/cad-chat/ 下):
//   node scripts/merge-lessons.mjs                # 預設:glob data/lessons*.json + 活檔 → 寫活檔 + data/lessons.<machine>.json
//   node scripts/merge-lessons.mjs --dry-run      # 只印報告,不寫檔
//   node scripts/merge-lessons.mjs --machine sam-pc
//   node scripts/merge-lessons.mjs --inputs a.json,b.json --snapshot out.json --no-live
//   node scripts/merge-lessons.mjs --no-curation  # 只合併,不套 data/curation.lessons.json
//
// 合併後一律套「人為裁決」(src/server/lessons.curate.mjs):濾掉雜訊案例(煙測暫存件/
// 回合層基礎設施錯誤/參數防呆照設計丟的 ValueError),並依 data/curation.lessons.json
// (版控、以 signature 為鍵)套狀態與措辭。停用因此跟著 git 走,不必每台機器手動再停一次。
//
// 已知限制:case/lesson 的合併仍是 **union**,跨機的刪除不會傳播(在 A 機刪掉的 lesson,若
// B 機快照仍留著它的 cases,下次合併會把那些 case 當 pending 帶回)。報告會標示
// 「來自快照、本機活檔沒有」的 lesson signature 供人工判斷。status:帶 statusAt 的
// (面板切換或裁決檔蓋章)取最新決定,停用會傳播;全無 statusAt 的舊資料沿用 union 取
// active。來源不一致時列入報告(statusConflicts)。措辭權威 = 最新 distilledAt(非 caseCount)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { APP_ROOT } from "../src/server/config.mjs";
import { lessonsFile, readStore, writeStore } from "../src/server/lessons.mjs";
import { applyCuration, validateCuration } from "../src/server/lessons.curate.mjs";

// ── 純函數:合併 N 個 store ──────────────────────────────────────────────

// 併集用的 union-find(以 signature 字串為節點)。
class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // 路徑壓縮
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const SEP = "";

// case 自然鍵:auto case 靠 session+turn+at+signature 已唯一;manual(turnId=null)
// 靠 at+signature+note+userText 區分。id 一律不進鍵(跨機撞號、無意義)。
function caseKey(c) {
  return [
    c.source || "",
    c.sessionId || "",
    c.turnId || "",
    c.at || "",
    c.signature || "",
    c.note || "",
    c.userText || "",
  ].join(SEP);
}

// 撞鍵時保留較完整者(resolved 優先,再比欄位豐富度)。
function caseScore(c) {
  let s = 0;
  if (c.resolved) s += 100;
  if (c.lessonId) s += 10;
  for (const k of ["retry", "fixEdits", "stderrTail", "note", "userText"]) if (c[k]) s += 1;
  return s;
}

function lessonSignatures(l) {
  const set = new Set();
  if (l.signature) set.add(l.signature);
  if (Array.isArray(l.altSignatures)) for (const a of l.altSignatures) if (a) set.add(a);
  return set;
}

// 狀態裁決:有 statusAt(面板切換或裁決檔蓋的章)→ 取最新那筆的決定,停用因此能跨機傳播;
// 全都沒有 statusAt(舊資料)→ 沿用舊的 union 規則(任一 active 即 active)。
function resolveStatus(lessons) {
  const stamped = lessons.filter((l) => l.statusAt).sort((a, b) => String(b.statusAt).localeCompare(String(a.statusAt)));
  if (!stamped.length) {
    return { status: lessons.every((l) => l.status === "disabled") ? "disabled" : "active" };
  }
  const w = stamped[0];
  const out = { status: w.status === "disabled" ? "disabled" : "active", statusAt: w.statusAt };
  if (out.status === "disabled") {
    out.statusReason = w.statusReason || "manual";
    out.statusNote = w.statusNote || "";
  } else if (w.statusNote) {
    out.statusNote = w.statusNote;
  }
  return out;
}

const minStr = (arr) => arr.filter(Boolean).sort()[0] || null;
const maxStr = (arr) => arr.filter(Boolean).sort().slice(-1)[0] || null;

// stores:已 normalize 的 store 陣列;labels[i] 對應來源標籤(供報告 provenance)。
export function mergeStores(stores, { labels = [] } = {}) {
  const labelOf = (i) => labels[i] ?? `input${i}`;

  // 1. cases 去重(淺複製,避免改到輸入)。
  const caseMap = new Map();
  let totalInputCases = 0;
  for (const st of stores) {
    for (const c of st.cases || []) {
      totalInputCases += 1;
      const k = caseKey(c);
      const prev = caseMap.get(k);
      if (!prev || caseScore(c) > caseScore(prev)) caseMap.set(k, { ...c });
    }
  }
  const cases = [...caseMap.values()];

  // 2. lessons 依 signature 重疊分群(union-find),記錄每群的來源標籤。
  const tagged = [];
  stores.forEach((st, i) => {
    for (const l of st.lessons || []) tagged.push({ lesson: l, label: labelOf(i) });
  });
  const uf = new UnionFind();
  for (const { lesson } of tagged) {
    const sigs = [...lessonSignatures(lesson)];
    for (const s of sigs) uf.find(s);
    for (let j = 1; j < sigs.length; j++) uf.union(sigs[0], sigs[j]);
  }
  const groups = new Map(); // root signature → [{lesson,label}]
  for (const entry of tagged) {
    const anySig = entry.lesson.signature || [...lessonSignatures(entry.lesson)][0];
    if (!anySig) continue; // 無 signature 的 lesson 不該存在;略過
    const root = uf.find(anySig);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }

  // 每群 → 一條合併 lesson;措辭取「最新蒸餾的贏家」(distilledAt 新者為權威,
  // 平手才比 caseCount)。不能拿 caseCount 當第一鍵:輸出的 caseCount 是現算的
  // (通常低於舊快照裡的膨脹值),若以計數為權威,本機重蒸餾的新措辭會被舊快照
  // 的高計數永遠壓回去(review 2026-07-16)。
  const conflicts = [];
  const statusConflicts = [];
  const mergedLessons = [];
  const provenance = new Map(); // merged lesson 物件 → Set(來源標籤)
  for (const group of groups.values()) {
    const lessons = group.map((g) => g.lesson);
    const winner = [...lessons].sort((a, b) => {
      const d = String(b.distilledAt || "").localeCompare(String(a.distilledAt || ""));
      if (d) return d;
      const c = Number(b.caseCount || 0) - Number(a.caseCount || 0);
      if (c) return c;
      return String(a.signature || "").localeCompare(String(b.signature || ""));
    })[0];
    const allSigs = new Set();
    for (const l of lessons) for (const s of lessonSignatures(l)) allSigs.add(s);
    const primary = winner.signature;
    const alt = [...allSigs].filter((s) => s !== primary).sort();
    // status 是 union 規則(有任一 active → active):disable 沒有時間戳可比新舊,
    // 兩個方向都可能翻錯,取「不漏教訓」的一邊。但本機刻意 disable 被舊快照翻回
    // active 不得無聲發生 → 來源不一致時進報告,由人重新 disable。
    const statuses = new Set(lessons.map((l) => l.status || "active"));
    if (statuses.size > 1) {
      statusConflicts.push({
        signature: primary,
        resolved: resolveStatus(lessons).status,
        by: lessons.some((l) => l.statusAt) ? "statusAt" : "union",
        sources: group.map((g) => ({ label: g.label, status: g.lesson.status || "active" })),
      });
    }
    const merged = {
      id: null, // 排序後指派
      signature: primary,
      ...(alt.length ? { altSignatures: alt } : {}),
      ...resolveStatus(lessons),
      title: winner.title,
      rootCause: winner.rootCause,
      rule: winner.rule,
      caseCount: 0, // 稍後由連結 cases 現算
      resolvedCount: 0,
      graduationCandidate: lessons.some((l) => l.graduationCandidate === true),
      createdAt: minStr(lessons.map((l) => l.createdAt)),
      lastHitAt: maxStr(lessons.map((l) => l.lastHitAt)),
      distilledAt: maxStr(lessons.map((l) => l.distilledAt)),
      model: winner.model || null,
    };
    mergedLessons.push(merged);
    provenance.set(merged, new Set(group.map((g) => g.label)));
    for (const l of lessons) {
      if (l !== winner) {
        conflicts.push({
          signature: primary,
          kept: { title: winner.title, rule: winner.rule, caseCount: Number(winner.caseCount || 0) },
          dropped: { title: l.title, rule: l.rule, caseCount: Number(l.caseCount || 0) },
        });
      }
    }
  }

  // 3. lesson 重編 id(依 createdAt 升冪,平手用 signature),建 signature→lesson 映射。
  mergedLessons.sort((a, b) => {
    const d = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    return d || String(a.signature).localeCompare(String(b.signature));
  });
  const sigToLesson = new Map();
  mergedLessons.forEach((l, i) => {
    l.id = `LS-${i + 1}`;
    sigToLesson.set(l.signature, l);
    if (l.altSignatures) for (const s of l.altSignatures) sigToLesson.set(s, l);
  });

  // 4+5. 依 signature 權威重連結 cases,並現算 caseCount / resolvedCount。
  for (const l of mergedLessons) {
    l.caseCount = 0;
    l.resolvedCount = 0;
  }
  for (const c of cases) {
    const l = sigToLesson.get(c.signature) || null;
    c.lessonId = l ? l.id : null;
    if (l) {
      l.caseCount += 1;
      if (c.resolved) l.resolvedCount += 1;
      if (!l.lastHitAt || (c.at && c.at > l.lastHitAt)) l.lastHitAt = c.at;
    }
  }

  // 6. case 重編 id(依 at 升冪,平手用自然鍵)。
  cases.sort((a, b) => {
    const d = String(a.at || "").localeCompare(String(b.at || ""));
    return d || caseKey(a).localeCompare(caseKey(b));
  });
  cases.forEach((c, i) => {
    c.id = `c_${i + 1}`;
  });

  // 7. distillAttempts 取各簽名跨檔 max;seq/lessonSeq 接續。
  const distillAttempts = {};
  for (const st of stores) {
    for (const [k, v] of Object.entries(st.distillAttempts || {})) {
      const n = Number(v) || 0;
      if (n > (distillAttempts[k] || 0)) distillAttempts[k] = n;
    }
  }

  const store = {
    schemaVersion: 1,
    updatedAt: null, // writeStore 落盤時蓋章
    seq: cases.length,
    lessonSeq: mergedLessons.length,
    cases,
    lessons: mergedLessons,
    distillAttempts,
  };

  const report = {
    inputs: stores.map((st, i) => ({
      label: labelOf(i),
      cases: (st.cases || []).length,
      lessons: (st.lessons || []).length,
    })),
    output: {
      cases: cases.length,
      lessons: mergedLessons.length,
      pending: cases.filter((c) => !c.lessonId).length,
    },
    duplicateCasesRemoved: totalInputCases - cases.length,
    conflicts,
    statusConflicts,
    lessons: mergedLessons.map((l) => ({
      id: l.id,
      signature: l.signature,
      caseCount: l.caseCount,
      status: l.status,
      sources: [...(provenance.get(l) || [])].sort(),
    })),
  };
  return { store, report };
}

// ── 報告列印 ──────────────────────────────────────────────────────────────

function printReport(report, { liveLabel } = {}) {
  const log = (...a) => console.log(...a);
  log("── 輸入檔 ──");
  for (const inp of report.inputs) {
    log(`  ${inp.label}: ${inp.cases} cases / ${inp.lessons} lessons`);
  }
  log("── 合併結果 ──");
  log(
    `  ${report.output.cases} cases（去重移除 ${report.duplicateCasesRemoved}） / ` +
      `${report.output.lessons} lessons（pending cases ${report.output.pending}）`,
  );
  log("── 教訓（signature → 保留規則）──");
  for (const l of report.lessons) {
    const flag = liveLabel && !l.sources.includes(liveLabel) ? "  ⟵ 來自快照，本機活檔無" : "";
    log(`  ${l.id} [${l.signature}] ${l.caseCount} cases (${l.status}) 來源:${l.sources.join(",")}${flag}`);
  }
  if (report.statusConflicts.length) {
    log("── ⚠ status 不一致(有 statusAt 者取最新決定;全無 statusAt 的舊資料沿用 union 取 active)──");
    for (const s of report.statusConflicts) {
      const srcs = s.sources.map((x) => `${x.label}=${x.status}`).join(", ");
      log(`  [${s.signature}] → ${s.resolved}（${srcs}）`);
    }
  }
  if (report.conflicts.length) {
    log("── 同 signature 措辭衝突（自動挑最新蒸餾的，被淘汰者列此供檢視）──");
    for (const c of report.conflicts) {
      log(`  [${c.signature}]`);
      log(`    保留 (caseCount ${c.kept.caseCount}): ${c.kept.title} — ${c.kept.rule}`);
      log(`    淘汰 (caseCount ${c.dropped.caseCount}): ${c.dropped.title} — ${c.dropped.rule}`);
    }
  } else {
    log("── 無 signature 措辭衝突 ──");
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { dryRun: false, machine: null, inputs: null, live: null, snapshot: null, noLive: false, noSnapshot: false, curation: null, noCuration: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-live") opts.noLive = true;
    else if (a === "--no-snapshot") opts.noSnapshot = true;
    else if (a === "--machine") opts.machine = argv[++i];
    else if (a === "--inputs") opts.inputs = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--live") opts.live = argv[++i];
    else if (a === "--snapshot") opts.snapshot = argv[++i];
    else if (a === "--curation") opts.curation = argv[++i];
    else if (a === "--no-curation") opts.noCuration = true;
    else throw new Error(`未知參數:${a}`);
  }
  return opts;
}

function safeMachineId(raw) {
  const id = String(raw || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "local";
}

const dataDir = () => path.join(APP_ROOT, "data");

// 預設輸入:data/lessons*.json（含 legacy lessons.json 與各機 lessons.<id>.json）+ 活檔。
function defaultInputPaths(liveFile) {
  const dir = dataDir();
  const found = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^lessons.*\.json$/.test(name)) continue;
      if (/\.(tmp|corrupt)/.test(name)) continue;
      found.push(path.join(dir, name));
    }
  } catch {
    /* data/ 不存在 → 只用活檔 */
  }
  found.push(liveFile);
  // 去重(同一絕對路徑只讀一次)
  const seen = new Set();
  return found.filter((p) => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return false;
    seen.add(abs);
    return true;
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const liveFile = opts.live ? path.resolve(opts.live) : lessonsFile();
  const machine = safeMachineId(opts.machine || process.env.CADCHAT_MACHINE_ID || os.hostname());
  const snapshotFile = opts.snapshot
    ? path.resolve(opts.snapshot)
    : path.join(dataDir(), `lessons.${machine}.json`);

  const inputPaths = (opts.inputs ? opts.inputs.map((p) => path.resolve(p)) : defaultInputPaths(liveFile)).filter(
    (p) => {
      if (fs.existsSync(p)) return true;
      console.log(`  (略過不存在的輸入:${p})`);
      return false;
    },
  );
  if (!inputPaths.length) {
    console.error("沒有可讀的輸入檔。");
    process.exit(1);
  }

  const liveAbs = path.resolve(liveFile);
  const stores = inputPaths.map((p) => readStore(p));
  const labels = inputPaths.map((p) => (path.resolve(p) === liveAbs ? `${path.basename(p)}(活檔)` : path.basename(p)));
  const liveLabel = labels[inputPaths.findIndex((p) => path.resolve(p) === liveAbs)] || null;

  const merged = mergeStores(stores, { labels });
  printReport(merged.report, { liveLabel });

  // 人為裁決(版控檔,以 signature 為鍵):濾雜訊案例 + 套狀態/措辭。裁決檔缺席 = 只濾雜訊。
  const curationFile = opts.curation ? path.resolve(opts.curation) : path.join(dataDir(), "curation.lessons.json");
  let curation = { lessons: {} };
  if (!opts.noCuration && fs.existsSync(curationFile)) {
    curation = JSON.parse(fs.readFileSync(curationFile, "utf8"));
    const errs = validateCuration(curation);
    if (errs.length) throw new Error(`裁決檔不合法(${curationFile}):\n  ${errs.join("\n  ")}`);
  }
  const curated = opts.noCuration ? { store: merged.store, report: null } : applyCuration(merged.store, curation);
  const store = curated.store;
  if (curated.report) {
    const r = curated.report;
    const noise = Object.entries(r.noiseRemoved).map(([k, v]) => `${k}=${v}`).join("、") || "無";
    console.log(`── 裁決(${path.basename(curationFile)})──`);
    console.log(`  濾掉雜訊案例:${noise}`);
    for (const x of r.statusApplied) console.log(`  狀態 [${x.signature}] ${x.from} → ${x.to}`);
    if (r.wordingApplied.length) console.log(`  措辭改寫:${r.wordingApplied.join("、")}`);
    if (r.unmatched.length) console.log(`  (裁決檔有、庫裡沒有的 signature:${r.unmatched.join("、")})`);
    console.log(`  結果:${store.lessons.filter((l) => l.status === "active").length} 條生效 / ${store.lessons.length} 條、${store.cases.length} 筆案例`);
  }

  if (opts.dryRun) {
    console.log("\n[dry-run] 未寫入任何檔案。");
    return;
  }

  const written = [];
  if (!opts.noLive) {
    writeStore(store, liveFile);
    written.push(liveFile);
  }
  if (!opts.noSnapshot) {
    writeStore(store, snapshotFile); // writeStore 會重新 prune + 蓋 updatedAt(idempotent)
    written.push(snapshotFile);
  }
  console.log(`\n已寫入:\n${written.map((p) => `  ${p}`).join("\n")}`);
  console.log("提醒:重啟 dev server 後 App 才會吃到合併結果;commit 由你自行決定(no-auto-commit)。");
}

// 只有直接執行才跑 CLI(被 import 當模組時不觸發)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
