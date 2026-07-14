// 設計/草模兩個 MCP 工具集共用的 UI 訊號工具(單一真相源,choke point 不複製漂移):
// emit_stage / emit_spec / emit_clarify / emit_retry。
// 行為與抽出前逐字等價;stage 段數依模式參數化(設計 5 段、草模 3 段)。
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { unescapeNewlines } from "../../lib/clarifyText.js";
import { noteRetry } from "../lessons.mjs";

export const result = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
export const toolId = () => `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// emit_clarify 之後,本回合任何做事工具一律拒絕(等使用者回答;prompt 紀律的程式閘門)。
export function makeClarifyGate(session) {
  return () =>
    session._clarifyPending
      ? result({
          ok: false,
          error: "已向使用者提問(emit_clarify),請結束本回合等待回答,不得先繼續建模。",
        })
      : null;
}

export function makeUiTools(
  { session, emit },
  { stageMax = 4, stageDesc = "index:0=理解 1=規劃 2=生成 3=驗證 4=呈現。" } = {},
) {
  return [
    tool(
      "emit_stage",
      `推進頂部階段列。${stageDesc}`,
      { index: z.number().int().min(0).max(stageMax) },
      async ({ index }) => {
        emit("stage", { index });
        return result({ ok: true });
      },
    ),
    tool(
      "emit_spec",
      "把解析到的規格丟成可點擊修正的 chips;你自行假設(使用者未給)的值標 assumed:true,v 不要再寫「(假設)」字樣。",
      { chips: z.array(z.object({ k: z.string(), v: z.string(), assumed: z.boolean().optional() })) },
      async ({ chips }) => {
        // choke point 正規化:模型可能在 tool JSON 寫字面 \n(雙重跳脫),原樣轉手會直接印在 UI。
        emit("spec", {
          chips: chips.map((c) => ({
            k: unescapeNewlines(c.k),
            v: unescapeNewlines(c.v),
            ...(c.assumed === true ? { assumed: true } : {}),
          })),
        });
        return result({ ok: true });
      },
    ),
    tool(
      "emit_clarify",
      "向使用者提問(規格不足時)。呼叫後請結束本回合等待回答。",
      {
        question: z.string(),
        options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
        suggested: z.string().optional(),
      },
      async ({ question, options, suggested }) => {
        // 硬閘門:提問後本回合禁止再做事(見各做事工具的 clarifyGate 檢查)。
        session._clarifyPending = true;
        // choke point 正規化字面 \n;opts 的 label/value 與 suggested 會被原樣
        // 送回當使用者回覆,一併處理。
        emit("clarify", {
          q: unescapeNewlines(question),
          opts: (options || []).map((o) => ({
            label: unescapeNewlines(o.label),
            value: unescapeNewlines(o.value),
          })),
          suggested: unescapeNewlines(suggested || ""),
        });
        return result({ ok: true, awaiting: true, note: "已提問,請結束本回合等待使用者回答。" });
      },
    ),
    tool(
      "emit_retry",
      "驗證失敗自我修正時的說明橫幅。",
      {
        attempt: z.number().int(),
        reason: z.string(),
        adjustment: z.string().optional(),
      },
      async ({ attempt, reason, adjustment }) => {
        noteRetry(session, { attempt, reason, adjustment }); // 教訓案例:agent 自診
        emit("retry", { attempt, reason, adjustment: adjustment || "" });
        return result({ ok: true });
      },
    ),
  ];
}
