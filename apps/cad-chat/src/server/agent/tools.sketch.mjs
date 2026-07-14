// 草模模式的 in-process MCP server:共用 UI 訊號 4 工具 + sketch_present。
// server key 沿用 "cadchat"(工具前綴 mcp__cadchat__* 統一,前端 TOOL_LABELS
// strip 邏輯免改)。無任何 cad_*/Python 依賴——草模路徑零 spawn。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { presentSketch } from "../sketch/present.mjs";
import { makeClarifyGate, makeUiTools, result, toolId } from "./tools.shared.mjs";

// runner 白名單用(design 的 MCP_TOOLS 對照組)
export const SKETCH_MCP_TOOLS = [
  "emit_stage",
  "emit_spec",
  "emit_clarify",
  "emit_retry",
  "sketch_present",
].map((t) => `mcp__cadchat__${t}`);

export function buildSketchServer({ session, emit }) {
  const clarifyGate = makeClarifyGate(session);

  return createSdkMcpServer({
    name: "cadchat",
    version: "1.0.0",
    tools: [
      // 草模階段列只有 3 段:0=理解 1=搭建 2=演示
      ...makeUiTools({ session, emit }, { stageMax: 2, stageDesc: "index:0=理解 1=搭建 2=演示。" }),
      tool(
        "sketch_present",
        "驗證並呈現機構草模場景(scene = 完整 schema v1 JSON 物件)。成功即寫檔、記為新版本、" +
          "3D 視圖開始播放。驗證失敗回 {ok:false, errors:[{path,message}]}——依訊息修正 scene " +
          "後重呼(整份重送),上限 3 次。迭代修改也是整份重送 scene。",
        {
          name: z.string().optional(),
          scene: z.record(z.string(), z.any()),
        },
        async ({ name, scene }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const id = toolId();
          emit("tool", {
            id,
            name: `sketch.present(${String(name || scene?.name || "sketch").slice(0, 40)})`,
            label: "搭建機構草模",
            status: "running",
          });
          const r = presentSketch(session, { name, scene }, emit);
          if (!r.ok) {
            emit("tool", {
              id,
              status: "error",
              note: `場景驗證未過(${r.errors.length} 項):${r.errors[0]?.path} ${r.errors[0]?.message}`,
            });
            return result({ ok: false, errors: r.errors, warnings: r.warnings });
          }
          emit("tool", {
            id,
            status: "done",
            outputs: [{ path: `${session.lastName}.sketch.json`, kind: "json" }],
          });
          return result({
            ok: true,
            ver: r.ver,
            sceneUrl: r.sceneUrl,
            bodies: r.partCount,
            dofs: r.dofs?.map((d) => d.id),
            warnings: r.warnings,
          });
        },
      ),
    ],
  });
}
