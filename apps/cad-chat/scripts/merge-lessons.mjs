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
//
// 已知限制:合併為 **union-only**,跨機的刪除不會傳播(在 A 機刪掉的 lesson,若
// B 機快照仍留著它的 cases,下次合併會把那些 case 當 pending 帶回)。報告會標示
// 「來自快照、本機活檔沒有」的 lesson signature 供人工判斷。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { APP_ROOT } from "../src/server/config.mjs";
import { lessonsFile, readStore, writeStore } from "../src/server/lessons.mjs";

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

  // 每群 → 一條合併 lesson;措辭取「證據多的贏家」。
  const conflicts = [];
  const mergedLessons = [];
  const provenance = new Map(); // merged lesson 物件 → Set(來源標籤)
  for (const group of groups.values()) {
    const lessons = group.map((g) => g.lesson);
    const winner = [...lessons].sort((a, b) => {
      const d = Number(b.caseCount || 0) - Number(a.caseCount || 0);
      if (d) return d;
      return String(b.distilledAt || "").localeCompare(String(a.distilledAt || ""));
    })[0];
    const allSigs = new Set();
    for (const l of lessons) for (const s of lessonSignatures(l)) allSigs.add(s);
    const primary = winner.signature;
    const alt = [...allSigs].filter((s) => s !== primary).sort();
    const merged = {
      id: null, // 排序後指派
      signature: primary,
      ...(alt.length ? { altSignatures: alt } : {}),
      status: lessons.every((l) => l.status === "disabled") ? "disabled" : "active",
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
  if (report.conflicts.length) {
    log("── 同 signature 措辭衝突（自動挑證據多的，被淘汰者列此供檢視）──");
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
  const opts = { dryRun: false, machine: null, inputs: null, live: null, snapshot: null, noLive: false, noSnapshot: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-live") opts.noLive = true;
    else if (a === "--no-snapshot") opts.noSnapshot = true;
    else if (a === "--machine") opts.machine = argv[++i];
    else if (a === "--inputs") opts.inputs = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--live") opts.live = argv[++i];
    else if (a === "--snapshot") opts.snapshot = argv[++i];
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

  const { store, report } = mergeStores(stores, { labels });
  printReport(report, { liveLabel });

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
