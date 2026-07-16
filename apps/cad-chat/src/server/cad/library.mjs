// 零件庫(models/parts-library/<slug>/{<slug>.step, meta.json}):忠實外形 STEP
// 的耐久收藏。「收庫」= 免 LLM endpoint(files.mjs POST /api/library-add)→ 此
// 模組純邏輯(modelsRoot 注入,L1 直測);「用庫」零新機制——agent 白名單本就有
// Glob/Read,prompt 教它列 meta.json 核對後走既有 cad_import(generator 只引用
// session 內 imported/ 複本,**絕不直引 models/ 路徑**——否則 save-project/版本
// 快照/搬機的 session 自包含不變式全破)。
import fs from "node:fs";
import path from "node:path";

import { resolveInside } from "./paths.mjs";

export const LIBRARY_DIR = "parts-library";
export const LIBRARY_META_SCHEMA_VERSION = 1;

// slug 淨化:ASCII 小寫 + [a-z0-9_-];CJK/空白全滅後空字串 → "part"。
export function librarySlug(label) {
  const s = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\.(step|stp)$/i, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return s || "part";
}

// 收一件進庫:複製 STEP 為 <slug>.step + 寫 meta.json。寫入端一律走 resolveInside
// (只准可寫層 modelsRoot,鏡射 save-project 語意);同 slug 已存在且未 overwrite
// → {ok:false, error:"exists"}(前端二次確認)。
export function addLibraryPart({
  srcAbs,
  modelsRoot,
  slug,
  label,
  family,
  notes,
  source,
  overwrite = false,
  bbox = null,
}) {
  if (!srcAbs || !modelsRoot) throw new Error("addLibraryPart 需要 srcAbs 與 modelsRoot");
  const clean = librarySlug(slug || label || path.basename(srcAbs));
  const dirAbs = resolveInside(modelsRoot, `${LIBRARY_DIR}/${clean}`);
  const stepAbs = path.join(dirAbs, `${clean}.step`);
  if (fs.existsSync(stepAbs) && !overwrite) {
    return { ok: false, error: "exists", slug: clean };
  }
  fs.mkdirSync(dirAbs, { recursive: true });
  fs.copyFileSync(srcAbs, stepAbs);
  const meta = {
    schemaVersion: LIBRARY_META_SCHEMA_VERSION,
    label: String(label || clean),
    family: String(family || "other"),
    source: String(source || ""),
    notes: String(notes || ""),
    bboxMm: Array.isArray(bbox?.size) ? bbox.size : null,
    faceCount: bbox?.faceCount ?? null,
    addedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dirAbs, "meta.json"), JSON.stringify(meta, null, 1), "utf8");
  return {
    ok: true,
    slug: clean,
    dir: `${LIBRARY_DIR}/${clean}`,
    rel: `${LIBRARY_DIR}/${clean}/${clean}.step`,
    meta,
  };
}
