// 用 Agent SDK query() 驅動一個對話回合,把訊息串流映射成 SSE 事件。
import { query } from "@anthropic-ai/claude-agent-sdk";

import { REPO_ROOT, agentEnv, resolveModel } from "../config.mjs";
import { buildSystemPrompt } from "./prompt.mjs";
import { makeToolGuard } from "./guards.mjs";
import { buildCadchatServer } from "./tools.mjs";

const MCP_TOOLS = [
  "emit_stage",
  "emit_spec",
  "emit_plan",
  "emit_clarify",
  "emit_retry",
  "emit_params",
  "cad_import",
  "cad_source_part",
  "cad_build",
  "cad_validate",
  "cad_present",
  "cad_measure",
  "cad_align",
  "cad_export",
].map((t) => `mcp__cadchat__${t}`);

const ALLOWED = ["Read", "Glob", "Grep", ...MCP_TOOLS];

// CLI harness 層的非同步/編排工具不經過 canUseTool(實測 Agent 子代理與 ScheduleWakeup
// 直接放行),必須用 disallowedTools 從工具清單整個移除。cad-chat 的契約是
// 「一次 query = 一個同步回合」:子代理+排程喚醒會讓 CLI 自行切斷回合再自主續跑,
// 之後 in-process MCP 通道對 CLI 端已死,emit_*/cad_* 全部 Stream closed。
const DISALLOWED = [
  "WebSearch", "WebFetch", "AskUserQuestion",
  "Task", "Agent", "ScheduleWakeup", "SendMessage", "Monitor", "Workflow", "Skill",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "CronCreate", "CronDelete", "CronList", "PushNotification", "RemoteTrigger",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
];

export async function runTurn({ session, emit, message }) {
  const abort = new AbortController();
  session.currentAbort = abort;
  session._valAttempt = 0;
  session._paramsEmitted = false;
  session._clarifyPending = false; // 使用者的新訊息 = 已回答上回合的提問

  const mcp = buildCadchatServer({ session, emit, signal: abort.signal });

  const model = resolveModel();
  const q = query({
    prompt: message,
    options: {
      ...(model ? { model } : {}),
      cwd: REPO_ROOT,
      resume: session.sdkSessionId || undefined,
      settingSources: ["project"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildSystemPrompt(session),
      },
      mcpServers: { cadchat: mcp },
      allowedTools: ALLOWED,
      disallowedTools: DISALLOWED,
      permissionMode: "default",
      canUseTool: makeToolGuard(ALLOWED),
      abortController: abort,
      // 串流 partial messages:沒有它,從送出到第一段完整文字之間(推理+寫產生器
      // 原始碼可達數十秒)前端完全沒有回饋。
      includePartialMessages: true,
      env: agentEnv(),
    },
  });
  session._query = q;

  let ok = true;
  // 串流狀態:目前正在打字的 tool_use 區塊(累計字元數,節流回報)。
  let typing = null;
  try {
    for await (const msg of q) {
      if (msg.type === "stream_event" && msg.parent_tool_use_id == null) {
        const ev = msg.event;
        if (ev?.type === "content_block_start") {
          const b = ev.content_block;
          if (b?.type === "text") {
            typing = null;
            emit("ai_start", {});
          } else if (b?.type === "tool_use") {
            typing = { name: b.name || "", chars: 0, last: 0 };
            emit("busy", { what: typing.name });
          } else if (b?.type === "thinking") {
            typing = null;
            emit("busy", { what: "thinking" });
          }
        } else if (ev?.type === "content_block_delta") {
          const d = ev.delta;
          if (d?.type === "text_delta" && d.text) {
            emit("ai_delta", { text: d.text });
          } else if (d?.type === "input_json_delta" && typing) {
            typing.chars += (d.partial_json || "").length;
            const now = Date.now();
            if (now - typing.last > 400) {
              typing.last = now;
              emit("busy", { what: typing.name, chars: typing.chars });
            }
          }
        }
      } else if (msg.type === "system" && msg.subtype === "init") {
        session.sdkSessionId = msg.session_id;
        emit("session", {
          sessionId: session.sessionId,
          sdkSessionId: msg.session_id,
          authSource: msg.apiKeySource,
        });
      } else if (msg.type === "assistant" && msg.parent_tool_use_id == null) {
        for (const block of msg.message?.content || []) {
          if (block.type === "text" && block.text?.trim()) {
            emit("ai", { text: block.text });
          }
        }
      } else if (msg.type === "result") {
        ok = !msg.is_error;
        if (msg.is_error) {
          emit("error", { message: msg.result || msg.subtype || "agent error" });
        }
        // result = 回合結束。CLI 若因背景任務/排程喚醒續命,後續自主輸出一律不收。
        break;
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      ok = false;
      emit("error", { message: String(err?.message || err) });
    }
  } finally {
    // 回合結束即終止 CLI 子程序:不留殭屍在背景自主續跑(正常結束時為 no-op)。
    abort.abort();
    session.currentAbort = null;
    session._query = null;
  }
  return { ok };
}
