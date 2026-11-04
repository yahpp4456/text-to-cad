// 產品設計模式「草稿 → 產生器 → build → 快路徑驗證 → 呈現」核心(零 LLM)。
// agent 的 surface_build 工具(SSE 路徑)與 POST /api/surface-build(JSON 路徑)共用:emit 由
// 呼叫端注入(SSE 直發 / 端點收集成陣列),步驟與 chat.mjs deterministicRegen 同構:
//   完整驗證草稿 → 套回磁碟 PARAMS 現值 → 編譯 .py → buildOrRollback(失敗還原舊 .py)
//   → runValidateDesign(零 spawn,surface 剖面)→ emitPresent(版本+present 帶 surfaceUrl)
//   → params(固定鍵 thick/fillet_r/revolve_deg 的滑桿)。
import fs from "node:fs";
import path from "node:path";

import { applyParams, validateDraft } from "../../lib/surface/surfaceSchema.js";
import { recordBuildFailure, recordCheckFailure } from "../lessons.mjs";
import {
  buildOrRollback,
  decorateChecks,
  emitPresent,
  paramDefsFromGenerator,
  paramValuesFromGenerator,
  runStep,
  runValidateDesign,
  sanitizeName,
  writeGenerator,
} from "./pipeline.mjs";
import { condenseTraceback } from "./python.mjs";
import { readDraft, writeDraft } from "./surfaceDraft.mjs";
import { compileSurfaceGenerator } from "./surfaceGen.mjs";

// 產品模式階段列:0 理解 1 規劃 2 草稿 3 生成 4 呈現
export const PRODUCT_STAGE_BUILD = 3;
export const PRODUCT_STAGE_PRESENT = 4;

export async function buildFromDraft(session, name, emit, { signal, toolId = null } = {}) {
  const part = sanitizeName(name || session.lastName || "product");
  const cur = readDraft(session, part);
  if (!cur) return { ok: false, error: "尚無草稿可生成(先整理曲面草稿)" };
  const errors = validateDraft(cur.draft);
  if (errors.length) return { ok: false, errors };

  // 滑桿改過的純量(磁碟 PARAMS)優先於草稿舊值;沒有 .py 就用草稿本身
  const pyPath = path.join(session.workdir, `${part}.py`);
  const prevSrc = fs.existsSync(pyPath) ? fs.readFileSync(pyPath, "utf8") : null;
  const diskParams = prevSrc ? paramValuesFromGenerator(session, part) : null;
  const draft = diskParams ? applyParams(cur.draft, diskParams) : cur.draft;

  let code;
  try {
    code = compileSurfaceGenerator(draft, { name: part });
  } catch (err) {
    const errs = Array.isArray(err?.errors) ? err.errors : [{ path: "", message: String(err?.message || err) }];
    return { ok: false, errors: errs };
  }
  writeGenerator(session, part, code);

  const id = toolId || `tool_${Date.now().toString(36)}`;
  emit("stage", { index: PRODUCT_STAGE_BUILD });
  emit("tool", {
    id,
    name: `surface.build(${part})`,
    label: "曲面成形 → 執行 → 產出",
    status: "running",
    code: `# surface-draft-v1 rev ${cur.revision} → ${part}`,
  });
  const { step, rolledBack } = prevSrc
    ? await buildOrRollback(session, part, prevSrc, { signal })
    : { step: await runStep(session, part, { signal }), rolledBack: false };
  if (!step.ok) {
    if (!signal?.aborted) {
      recordBuildFailure(session, { part, exitCode: step.exitCode, stderr: step.stderr, source: "surface_build" });
    }
    const note = condenseTraceback(step.stderr, { generatorName: part }) || `exit ${step.exitCode}`;
    emit("tool", { id, status: "error", note, ms: step.ms });
    return {
      ok: false,
      error: note,
      rolledBack,
      stderr: (step.stderr || "").slice(-1500),
    };
  }
  session.lastName = part;
  emit("tool", {
    id,
    status: "done",
    ms: step.ms,
    outputs: [
      { path: `${part}.step`, kind: "step" },
      { path: `.${part}.step.glb`, kind: "glb" },
      { path: `.${part}.surface.json`, kind: "json" },
    ],
  });

  const val = await runValidateDesign(session, part, { signal });
  if (signal?.aborted) return { ok: false, error: "已中斷" };
  if (val.partCount > 0) session.lastPartCount = val.partCount;
  for (const c of val.checks) {
    if (!c.skipped && !c.ok) recordCheckFailure(session, { part, check: c, partCount: val.partCount, source: "surface_validate" });
  }
  const dec = decorateChecks(val.checks);
  emit("validate", {
    ok: val.ok,
    attempt: 1,
    ms: val.ms,
    partCount: val.partCount,
    name: part,
    checks: dec.map((c) => ({ label: c.label, icon: c.icon, color: c.color, note: c.noteText, skipped: !!c.skipped })),
  });
  emit("motion", { name: part, schemaVersion: 1, dofs: [] });

  emit("stage", { index: PRODUCT_STAGE_PRESENT });
  const r = emitPresent(session, part, emit);
  const defs = paramDefsFromGenerator(session, part);
  if (defs.length) {
    session._paramsEmitted = true;
    emit("params", { defs });
  }
  // 套過 PARAMS 的草稿寫回(純量與磁碟同步);內容沒變就不動 revision
  if (JSON.stringify(draft) !== JSON.stringify(cur.draft)) {
    writeDraft(session, part, draft, { revision: cur.revision + 1, source: cur.source });
  }
  const sidecar = readSurfaceSidecar(session, part);
  return {
    ok: true,
    name: part,
    ver: r.ver,
    glbUrl: r.glbUrl,
    validateOk: val.ok,
    checks: val.checks,
    summary: sidecar?.summary || null,
    notes: sidecar?.notes || [],
  };
}

// 最新分析 sidecar(頂層 `.{name}.surface.json`;build 時由 pipeline.writeSurfaceSidecar 落)。
export function readSurfaceSidecar(session, name) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(session.workdir, `.${sanitizeName(name)}.surface.json`), "utf8"));
    return raw && typeof raw === "object" && raw.schemaVersion === 1 ? raw : null;
  } catch {
    return null;
  }
}

// 給 agent 的精簡報告(數字為主;不帶折線/籠/梳的大陣列)。
export function surfaceReport(session, name) {
  const s = readSurfaceSidecar(session, name);
  if (!s) return null;
  const edge = (r) => ({ i: r.i, grade: r.grade, g1Deg: r.g1Deg, g2Rel: r.g2Rel, length: r.length, ...(r.flat ? { flat: true } : {}) });
  return {
    result: s.result,
    summary: s.summary,
    edges: (s.edges || []).map(edge),
    finalEdges: (s.finalEdges || []).map(edge),
    freeEdges: (s.freeEdges || []).map((r) => ({ i: r.i, length: r.length })),
    faces: (s.faces || []).map((f) => ({ i: f.i, type: f.type, kabsMax: f.kabsMax, kgaussMin: f.kgaussMin, kgaussMax: f.kgaussMax })),
    notes: s.notes || [],
    error: s.error || null,
  };
}
