// 產品設計模式(Alias 式曲面)的 in-process MCP server:共用 UI 訊號 4 工具 + emit_plan +
// surface_get_draft / surface_present_draft / surface_build / surface_report。
// **沒有 cad_build / cad_edit / cad_source_part**:agent 只產草稿 JSON,幾何由
// surfaceGen.mjs 編譯 + cadpy.surface.SurfaceBuilder 解讀(建構保證在 Python)。
// server key 沿用 "cadchat"(工具前綴 mcp__cadchat__* 統一)。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { draftSummary, readDraft, saveDraft } from "../cad/surfaceDraft.mjs";
import { buildFromDraft, surfaceReport } from "../cad/surfaceBuild.mjs";
import { sanitizeName } from "../cad/pipeline.mjs";
import { makeClarifyGate, makeUiTools, result, toolId } from "./tools.shared.mjs";

// runner 白名單用
export const PRODUCT_MCP_TOOLS = [
  "emit_stage",
  "emit_spec",
  "emit_clarify",
  "emit_retry",
  "emit_plan",
  "surface_get_draft",
  "surface_present_draft",
  "surface_build",
  "surface_report",
].map((t) => `mcp__cadchat__${t}`);

export function buildProductServer({ session, emit, signal }) {
  const clarifyGate = makeClarifyGate(session);
  const n = () => sanitizeName(session.lastName || "product");

  return createSdkMcpServer({
    name: "cadchat",
    version: "1.0.0",
    tools: [
      ...makeUiTools({ session, emit }, { stageMax: 4, stageDesc: "index:0=理解 1=規劃 2=草稿 3=生成 4=呈現。" }),
      tool(
        "emit_plan",
        "宣告執行步驟清單(面佈局表:主面/次面/三級面各一條)。",
        { steps: z.array(z.object({ n: z.number().int(), t: z.string() })) },
        async ({ steps }) => {
          emit("plan", { steps });
          return result({ ok: true });
        },
      ),
      tool(
        "surface_get_draft",
        "讀目前的曲面草稿(surface-draft-v1 JSON)與最新分析摘要。沒有草稿回 {ok:true, draft:null}。",
        { name: z.string().optional() },
        async ({ name }) => {
          const part = sanitizeName(name || n());
          const cur = readDraft(session, part);
          return result({
            ok: true,
            name: part,
            draft: cur?.draft ?? null,
            revision: cur?.revision ?? null,
            source: cur?.source ?? null,
            summary: cur ? draftSummary(cur.draft) : null,
            report: surfaceReport(session, part),
          });
        },
      ),
      tool(
        "surface_present_draft",
        "建立或局部更新曲面草稿並呈現到工作窗(**不建模**)。draft=整份 surface-draft-v1;patch=局部合併" +
          "({curves?:[...], surfaces?:[...], ops?:[...], remove?:{curves?,surfaces?,ops?}, result?, symmetry?, fuse?, analysis?}," +
          "同 id 整個取代、新 id 追加)。半完成(只有曲線)也可存。驗證失敗回 {ok:false, errors:[{path,message}]}," +
          "依訊息修正後重呼(上限 3 次)。回傳 buildable 表示是否已可生成。",
        {
          name: z.string().optional(),
          draft: z.record(z.string(), z.any()).optional(),
          patch: z.record(z.string(), z.any()).optional(),
          note: z.string().optional(),
        },
        async ({ name, draft, patch, note }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          emit("tool", { id, name: `surface.draft(${part})`, label: "整理曲面草稿", status: "running" });
          const r = saveDraft(session, part, { draft, patch, source: "ai" });
          if (!r.ok) {
            const first = r.errors?.[0];
            emit("tool", {
              id,
              status: "error",
              note: r.errors ? `草稿驗證未過(${r.errors.length} 項):${first?.path} ${first?.message}` : "草稿保存失敗",
            });
            return result({ ok: false, errors: r.errors || [{ path: "", message: "保存失敗" }] });
          }
          session.lastName = part;
          const summary = draftSummary(r.draft);
          emit("surface_draft", { name: part, revision: r.revision, draft: r.draft, source: "ai", note: note || "" });
          emit("tool", {
            id,
            status: "done",
            note: `${summary.curves} 條曲線 / ${summary.surfaces} 個曲面${summary.buildable ? "" : "(尚未可生成)"}`,
            outputs: [{ path: `${part}.surface.draft.json`, kind: "json" }],
          });
          return result({ ok: true, name: part, revision: r.revision, summary, buildable: summary.buildable });
        },
      ),
      tool(
        "surface_build",
        "把目前草稿成形:編譯 → 建模 → 驗證 → 呈現到 3D 視圖(計為新版本)。草稿不完整回 {ok:false, errors};" +
          "幾何失敗回 {ok:false, error}(例如厚度超過曲率半徑、對稱接縫摺線、截面方向相反)——依訊息改草稿後" +
          "surface_present_draft 再 surface_build,上限 3 次。成功回 summary(連續性統計)與 notes。",
        { name: z.string().optional() },
        async ({ name }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const r = await buildFromDraft(session, part, emit, { signal, toolId: toolId() });
          if (r.ok) session._valAttempt = 0;
          return result(r);
        },
      ),
      tool(
        "surface_report",
        "讀最新建模的分析報告:每條內邊的連續性等級(G0/G1/G2、法向夾角、曲率偏差)、開放邊、各面曲率範圍。用數字回答「哪條邊不相切」。",
        { name: z.string().optional() },
        async ({ name }) => {
          const part = sanitizeName(name || n());
          const rep = surfaceReport(session, part);
          return result(rep ? { ok: true, name: part, ...rep } : { ok: false, error: "尚無分析結果(先生成)" });
        },
      ),
    ],
  });
}
