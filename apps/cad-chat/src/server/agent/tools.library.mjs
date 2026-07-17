// 零件庫模式的 in-process MCP server:共用 UI 訊號 4 工具 + library_preview +
// library_add。server key 沿用 "cadchat"(工具前綴 mcp__cadchat__* 統一)。
// 契約:preview **只發 present 事件**(source:"opened",不發 version/artifact、
// 不動 session.version/lastName)——收庫不是建模迭代,不進時間軸。
import fs from "node:fs";
import path from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { LIBRARY_FAMILIES } from "../../lib/libraryFamilies.js";
import { BASE_PATH } from "../config.mjs";
import { addLibraryPart, librarySlug, resolveLibrarySource } from "../cad/library.mjs";
import { resolveInside } from "../cad/paths.mjs";
import { ensureStepGlb, inspectFactsAbs } from "../cad/stepPreview.mjs";
import { scrubPaths } from "../cad/python.mjs";
import { makeClarifyGate, makeUiTools, result, toolId } from "./tools.shared.mjs";

// runner 白名單用(SKETCH_MCP_TOOLS 對照組)
export const LIBRARY_MCP_TOOLS = [
  "emit_stage",
  "emit_spec",
  "emit_clarify",
  "emit_retry",
  "library_preview",
  "library_add",
].map((t) => `mcp__cadchat__${t}`);

// GLB 的 asset URL(帶 mtime buster,同 files.mjs assetUrl 慣例)
function glbAssetUrl(fileRel, glbAbs) {
  let v = "";
  try {
    v = `&v=${Math.round(fs.statSync(glbAbs).mtimeMs)}`;
  } catch {
    /* stat 失敗降級無 buster */
  }
  return `${BASE_PATH}/api/asset?file=${encodeURIComponent(fileRel)}${v}`;
}

export function buildLibraryServer({ session, emit }) {
  const clarifyGate = makeClarifyGate(session);

  return createSdkMcpServer({
    name: "cadchat",
    version: "1.0.0",
    tools: [
      // 零件庫階段列 3 段:0=選檔 1=訪談 2=收庫
      ...makeUiTools({ session, emit }, { stageMax: 2, stageDesc: "index:0=選檔 1=訪談 2=收庫。" }),
      tool(
        "library_preview",
        "把候選 STEP 轉 GLB 呈現在 3D 畫布並量測 bbox/面數(訪談前先讓使用者看到外形)。" +
          "file 只接受聊天上傳檔(uploads/…)或 models/ 內相對路徑。回 {ok, facts:{sizeMm,faceCount}}。",
        {
          file: z.string(),
          kind: z.enum(["part", "assembly"]).optional(),
        },
        async ({ file, kind }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const src = resolveLibrarySource(session, file);
          if (!src.ok) return result({ ok: false, error: src.error });
          const id = toolId();
          const base = path.basename(src.srcAbs);
          const stem = base.replace(/\.(step|stp)$/i, "");
          emit("tool", {
            id,
            name: `library.preview(${base.slice(0, 40)})`,
            label: "預覽零件",
            status: "running",
          });
          const k = kind || "part";
          const conv = await ensureStepGlb(src.srcAbs, { kind: k });
          if (!conv.ok) {
            emit("tool", { id, status: "error", note: scrubPaths(conv.error) });
            return result({ ok: false, error: scrubPaths(conv.error) });
          }
          // GLB 的 asset 相對路徑:上傳檔在 session workdir 下(workdirRel 前綴)、
          // models 檔直接 models 相對(與 /api/open 同形)。
          const glbName = `.${base}.glb`;
          const relDir = path.dirname(src.rel);
          const glbRel = relDir && relDir !== "." ? `${relDir}/${glbName}` : glbName;
          const fileRel = src.fromUploads ? `${session.workdirRel}/${glbRel}` : glbRel;
          // 只發 present(不發 version/artifact、不動 version/lastName):不進時間軸
          emit("present", {
            name: stem,
            code: stem,
            ver: "",
            glbUrl: glbAssetUrl(fileRel, conv.glbAbs),
            type: k,
            source: "opened",
          });
          const facts = await inspectFactsAbs(src.srcAbs);
          session._libFacts = { srcAbs: src.srcAbs, facts };
          emit("tool", { id, status: "done" });
          return result({
            ok: true,
            file: src.rel,
            facts: facts ? { sizeMm: facts.size, faceCount: facts.faceCount } : null,
          });
        },
      ),
      tool(
        "library_add",
        "把 STEP 收進零件庫 models/parts-library/<slug>/(<slug>.step + meta.json)。" +
          "訪談確認名稱/型號、family、來源、備註後才呼叫。slug 必須英數(建議型號小寫);" +
          "同 slug 已存在回 {ok:false,error:\"exists\"}——先問使用者是否覆蓋,確認才帶 overwrite:true 重呼。",
        {
          file: z.string(),
          label: z.string(),
          slug: z.string().optional(),
          family: z.enum(LIBRARY_FAMILIES),
          notes: z.string().optional(),
          source: z.string().optional(),
          overwrite: z.boolean().optional(),
        },
        async ({ file, label, slug, family, notes, source, overwrite }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const src = resolveLibrarySource(session, file);
          if (!src.ok) return result({ ok: false, error: src.error });
          // CJK slug 全滅防呆:淨化後退到 "part" 而使用者要的名字不是 "part" →
          // 直接退回要英數 slug(否則第二件中文名零件必撞 exists 誤導覆蓋)。
          const want = String(slug || label || "").trim();
          if (want && want.toLowerCase() !== "part" && librarySlug(want) === "part") {
            return result({
              ok: false,
              error: "slug 淨化後為空(中文/符號會被剝除):請補英數 slug,建議型號小寫,如 cdq2b32_45dz。",
            });
          }
          const id = toolId();
          emit("tool", {
            id,
            name: `library.add(${librarySlug(slug || label)})`,
            label: "收入零件庫",
            status: "running",
          });
          const cached = session._libFacts?.srcAbs === src.srcAbs ? session._libFacts.facts : null;
          const bbox = cached || (await inspectFactsAbs(src.srcAbs));
          let r;
          try {
            r = addLibraryPart({
              srcAbs: src.srcAbs,
              modelsRoot: session.modelsRoot,
              slug,
              label,
              family,
              notes,
              source: source || `library mode from ${src.fromUploads ? "聊天上傳" : `models/${src.rel}`}`,
              overwrite: overwrite === true,
              bbox,
            });
          } catch (err) {
            const msg = scrubPaths(String(err?.message || err));
            emit("tool", { id, status: "error", note: msg });
            return result({ ok: false, error: msg });
          }
          if (!r.ok) {
            emit("tool", { id, status: "error", note: r.error === "exists" ? `slug「${r.slug}」已存在,待使用者確認是否覆蓋` : r.error });
            return result(r);
          }
          // 順產庫內 GLB sidecar(LibraryShelf 縮圖用;fire-and-forget,失敗走 lazy 補轉)
          try {
            const libStepAbs = resolveInside(session.modelsRoot, r.rel);
            void ensureStepGlb(libStepAbs, { kind: "part" }).catch(() => {});
          } catch {
            /* 交給 /api/library-glb 按需補轉 */
          }
          emit("tool", { id, status: "done", outputs: [{ path: r.rel, kind: "step" }] });
          return result({ ok: true, slug: r.slug, dir: r.dir, rel: r.rel, meta: r.meta });
        },
      ),
    ],
  });
}
