// 零件庫(models/parts-library/<slug>/{<slug>.step, meta.json}):忠實外形 STEP
// 的耐久收藏。「收庫」= 免 LLM endpoint(files.mjs POST /api/library-add)→ 此
// 模組純邏輯(modelsRoot 注入,L1 直測);「用庫」零新機制——agent 白名單本就有
// Glob/Read,prompt 教它列 meta.json 核對後走既有 cad_import(generator 只引用
// session 內 imported/ 複本,**絕不直引 models/ 路徑**——否則 save-project/版本
// 快照/搬機的 session 自包含不變式全破)。
import fs from "node:fs";
import path from "node:path";

import { resolveInside, resolveModelRead } from "./paths.mjs";

export const LIBRARY_DIR = "parts-library";
export const LIBRARY_META_SCHEMA_VERSION = 1;

// library 模式收庫來源解析(agent 工具 library_preview/library_add 共用):
// 只接受兩種形——聊天上傳檔("uploads/…",session workdir 沙箱)與 models/ 相對
// 路徑(雙根讀取沙箱)。碟符/開頭斜線/../非 .step|.stp 一律拒;絕不接受任意
// 磁碟絕對路徑(那等於把檔案系統漫遊權交給模型)。
export function resolveLibrarySource(session, file) {
  const clean = String(file || "")
    .replace(/\\/g, "/")
    .replace(/^models\//, "")
    .trim();
  if (!clean) return { ok: false, error: "缺 file 參數" };
  if (/^[a-zA-Z]:|^\/|\.\./.test(clean)) {
    return { ok: false, error: "只接受聊天上傳檔(uploads/…)或 models/ 內相對路徑" };
  }
  if (!/\.ste?p$/i.test(clean)) return { ok: false, error: "只能收 .step/.stp 檔" };
  let srcAbs;
  try {
    srcAbs = clean.startsWith("uploads/")
      ? resolveInside(session.workdir, clean)
      : resolveModelRead(clean, { modelsRoot: session.modelsRoot });
  } catch {
    return { ok: false, error: "路徑超出允許範圍" };
  }
  if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
    return { ok: false, error: "檔案不存在" };
  }
  return { ok: true, srcAbs, rel: clean, fromUploads: clean.startsWith("uploads/") };
}

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

// 列庫(LibraryShelf 用):讀 parts-library/*/meta.json,附 GLB sidecar 存在性
// (縮圖鏈按需補轉的訊號)。壞 meta 跳過不擋整列;無庫目錄回空陣列。
export function listLibraryParts(modelsRoot) {
  const dirAbs = resolveInside(modelsRoot, LIBRARY_DIR);
  let slugs;
  try {
    slugs = fs.readdirSync(dirAbs, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const e of slugs) {
    const slug = e.name;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(dirAbs, slug, "meta.json"), "utf8"),
      );
      const stepRel = `${LIBRARY_DIR}/${slug}/${slug}.step`;
      const glbAbs = path.join(dirAbs, slug, `.${slug}.step.glb`);
      let glbMtime = 0;
      try {
        glbMtime = Math.round(fs.statSync(glbAbs).mtimeMs);
      } catch {
        /* 無 GLB → hasGlb:false,前端按需補轉 */
      }
      out.push({
        slug,
        label: String(meta.label || slug),
        family: String(meta.family || "other"),
        notes: String(meta.notes || ""),
        bboxMm: Array.isArray(meta.bboxMm) ? meta.bboxMm : null,
        faceCount: meta.faceCount ?? null,
        addedAt: meta.addedAt || null,
        rel: stepRel,
        glbRel: glbMtime ? `${LIBRARY_DIR}/${slug}/.${slug}.step.glb` : null,
        glbMtime,
      });
    } catch {
      /* 壞 meta/殘目錄跳過 */
    }
  }
  // 新收的在前(addedAt 降冪;無值排最後)
  out.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  return out;
}

// 刪一件庫件:整目錄移除(呼叫端負責二次確認)。slug 過 librarySlug 淨化 +
// resolveInside 沙箱,不存在回 {ok:false}。
export function deleteLibraryPart(modelsRoot, slug) {
  const clean = librarySlug(slug);
  const dirAbs = resolveInside(modelsRoot, `${LIBRARY_DIR}/${clean}`);
  if (!fs.existsSync(path.join(dirAbs, "meta.json"))) {
    return { ok: false, error: "庫件不存在" };
  }
  fs.rmSync(dirAbs, { recursive: true, force: true });
  return { ok: true, slug: clean };
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
