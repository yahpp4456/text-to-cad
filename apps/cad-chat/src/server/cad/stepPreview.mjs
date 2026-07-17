// 裸 STEP 的「轉檔看圖」與「量測 facts」共用管線(choke point,防複製漂移):
// files.mjs 的 /api/open、/api/library-add 與 library 模式的 agent 工具
// (library_preview / library_add)都走這兩支。行為與抽出前逐位等價。
import fs from "node:fs";
import path from "node:path";

import { DATA_ROOT } from "../config.mjs";
import { pathIsInside } from "./paths.mjs";
import { spawnPython } from "./python.mjs";

const STEP_DIR = "skills/cad/scripts/step";
const INSPECT_DIR = "skills/cad/scripts/inspect";
const CONVERT_TIMEOUT_MS = 120_000; // 裸 STEP 轉 GLB 上限(大檔 tessellation 可能要一陣子)
const INSPECT_TIMEOUT_MS = 30_000; // bbox 量測上限(best-effort,逾時=null)

// 目標在可寫資料根內 → cwd(DATA_ROOT)相對;唯讀 fixtures 層(packaged 跨根)
// → 絕對路徑輸入(cadpy CLI 只拒絕對「輸出」option,輸入目標可絕對)。dev 同根
// 恆走相對(= 舊 repoRel 行為)。
function spawnTarget(srcAbs) {
  return pathIsInside(srcAbs, DATA_ROOT)
    ? path.relative(DATA_ROOT, srcAbs).split(path.sep).join("/")
    : srcAbs;
}

// bbox/faceCount best-effort:逾時/失敗回 null(不擋呼叫端流程)。
export async function inspectFactsAbs(srcAbs, { timeoutMs = INSPECT_TIMEOUT_MS } = {}) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const r = await spawnPython(
      INSPECT_DIR,
      ["refs", spawnTarget(srcAbs), "--facts", "--format", "json"],
      { signal: ac.signal },
    );
    clearTimeout(timer);
    const json = JSON.parse(r.stdout);
    const tok = json.tokens?.[0] || {};
    return {
      size: Array.isArray(tok.entryFacts?.size)
        ? tok.entryFacts.size.map((v) => Math.round(v * 100) / 100)
        : null,
      faceCount: tok.summary?.faceCount ?? null,
    };
  } catch {
    return null;
  }
}

// 隱藏 topology GLB(.<檔名>.glb)按需產出/重轉。
// 重轉條件:GLB 缺席,或 STEP 比 GLB 新「超過偏斜窗」(外部改寫 STEP 而舊 GLB
// 還在——只看缺席會拿舊 GLB 的 mtime buster,靜默呈現舊幾何)。偏斜窗必要:
// git/LFS checkout 同批寫檔時 dotfile GLB 排序在前先落地,STEP 毫秒級較新,
// 嚴格比較會把每個剛 hydrate 的 fixture 誤判 stale(重跑 tessellation,無
// manifest 的還退到 kind_required)。真正的外部改寫與再開啟至少分鐘級。
const REGEN_SKEW_MS = 10_000;

// kind:需要重轉而 kind 非 part|assembly → { ok:false, error:"kind_required" }
// (呼叫端決定怎麼問);GLB 已新鮮則 kind 無關緊要。
export async function ensureStepGlb(srcAbs, { kind } = {}) {
  const dir = path.dirname(srcAbs);
  const base = path.basename(srcAbs);
  const glbAbs = path.join(dir, `.${base}.glb`);
  let needRegen = !fs.existsSync(glbAbs);
  if (!needRegen) {
    try {
      needRegen = fs.statSync(glbAbs).mtimeMs + REGEN_SKEW_MS < fs.statSync(srcAbs).mtimeMs;
    } catch {
      needRegen = true;
    }
  }
  if (needRegen) {
    if (kind !== "part" && kind !== "assembly") return { ok: false, error: "kind_required", glbAbs };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CONVERT_TIMEOUT_MS);
    const { code, stderr } = await spawnPython(
      STEP_DIR,
      [spawnTarget(srcAbs), "--kind", kind, "--force"],
      { signal: ac.signal },
    );
    clearTimeout(timer);
    if (code !== 0 || !fs.existsSync(glbAbs)) {
      return {
        ok: false,
        error: `轉檔失敗:${(stderr || "").trim().slice(-300) || `exit ${code}`}`,
        glbAbs,
      };
    }
  }
  return { ok: true, glbAbs };
}
