// 產品設計模式的草稿儲存(surface-draft-v1):`<name>.surface.draft.json` 是工作中草稿的真相
// 源(agent 的 surface_present_draft 與工作窗的保存都寫這裡),revision 單調遞增、base
// revision 不符 → 衝突(409 語意由端點轉譯)。版本快照把它跟 .py 一起凍結,回退時複回;
// 沒有草稿檔但有嵌 SURFACE_SPEC 的產生器(開舊專案)→ resetDraftFromGenerator 重建。
// 半完成草稿(只有曲線)允許存(partial 驗證),建模前才做完整驗證(surfaceBuild.mjs)。
import fs from "node:fs";
import path from "node:path";

import {
  applyPatch,
  emptyDraft,
  normalizeDraft,
  validateDraft,
} from "../../lib/surface/surfaceSchema.js";
import { sanitizeName } from "./pipeline.mjs";
import { readEmbeddedSpec } from "./surfaceGen.mjs";

export const DRAFT_SCHEMA_VERSION = 1;

export function draftFileName(name) {
  return `${sanitizeName(name)}.surface.draft.json`;
}

export function draftPath(session, name) {
  return path.join(session.workdir, draftFileName(name));
}

// 讀草稿檔 → {draft, revision, source, updatedAt} | null(缺檔/壞檔/schema 不符都是 null)。
export function readDraft(session, name) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(draftPath(session, name), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== DRAFT_SCHEMA_VERSION) return null;
  const draft = raw.draft;
  if (!draft || typeof draft !== "object") return null;
  if (validateDraft(draft, { partial: true }).length) return null;
  const revision = Math.trunc(Number(raw.revision));
  return {
    draft,
    revision: Number.isFinite(revision) && revision >= 0 ? revision : Number(draft.revision) || 0,
    source: raw.source === "user" ? "user" : "ai",
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

// 原子寫(tmp + rename);draft.revision 與外層 revision 同值。
export function writeDraft(session, name, draft, { revision, source = "ai" } = {}) {
  const rev = Math.max(0, Math.trunc(Number(revision ?? draft.revision ?? 0)));
  const body = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    revision: rev,
    source,
    updatedAt: Date.now(),
    draft: { ...draft, revision: rev },
  };
  const p = draftPath(session, name);
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(body, null, 1), "utf8");
  fs.renameSync(tmp, p);
  return { draft: body.draft, revision: rev, source };
}

// 保存(整份 draft 或 patch 局部合併)。回:
//   {ok:true, draft, revision}
//   {ok:false, conflict:true, revision, draft}   base revision 與磁碟不符
//   {ok:false, errors:[{path,message}]}          結構不合法(partial 驗證)
export function saveDraft(session, name, { draft, patch, baseRevision = null, source = "ai" } = {}) {
  const cur = readDraft(session, name);
  if (baseRevision !== null && baseRevision !== undefined && cur && Number(baseRevision) !== cur.revision) {
    return { ok: false, conflict: true, revision: cur.revision, draft: cur.draft };
  }
  let next;
  if (patch && typeof patch === "object") {
    try {
      next = applyPatch(cur?.draft ?? emptyDraft(), patch);
    } catch (err) {
      const errors = Array.isArray(err?.errors) ? err.errors : [{ path: "patch", message: String(err?.message || err) }];
      return { ok: false, errors };
    }
  } else if (draft && typeof draft === "object") {
    next = draft;
  } else {
    return { ok: false, errors: [{ path: "", message: "需要 draft 或 patch" }] };
  }
  const errors = validateDraft(next, { partial: true });
  if (errors.length) return { ok: false, errors };
  const normalized = normalizeDraft(next, { partial: true });
  const revision = (cur?.revision ?? 0) + 1;
  const w = writeDraft(session, name, normalized, { revision, source });
  return { ok: true, draft: w.draft, revision };
}

export function discardDraft(session, name) {
  try {
    fs.rmSync(draftPath(session, name), { force: true });
    return true;
  } catch {
    return false;
  }
}

// 從產生器嵌的 SURFACE_SPEC 重建草稿(開舊專案 / 回退);無產生器或無嵌入 → null。
// revision:沿用既有草稿 +1(讓工作窗的 base revision 失效、重載),沒有既有草稿則 0。
export function resetDraftFromGenerator(session, name, { source = "ai" } = {}) {
  let src;
  try {
    src = fs.readFileSync(path.join(session.workdir, `${sanitizeName(name)}.py`), "utf8");
  } catch {
    return null;
  }
  const spec = readEmbeddedSpec(src);
  if (!spec) return null;
  if (validateDraft(spec, { partial: true }).length) return null;
  const cur = readDraft(session, name);
  const revision = cur ? cur.revision + 1 : 0;
  return writeDraft(session, name, normalizeDraft(spec, { partial: true }), { revision, source });
}

// 草稿摘要(工具回傳 / 事件附帶用;不含幾何)。
export function draftSummary(draft) {
  if (!draft || typeof draft !== "object") return null;
  return {
    curves: Array.isArray(draft.curves) ? draft.curves.length : 0,
    surfaces: Array.isArray(draft.surfaces) ? draft.surfaces.length : 0,
    ops: Array.isArray(draft.ops) ? draft.ops.map((o) => o.op) : [],
    result: draft.result ?? "solid",
    symmetry: draft.symmetry ?? null,
    buildable: validateDraft(draft).length === 0,
  };
}
