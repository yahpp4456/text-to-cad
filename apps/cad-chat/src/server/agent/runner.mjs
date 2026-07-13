// 用 Agent SDK query() 驅動一個對話回合,把訊息串流映射成 SSE 事件。
import { query } from "@anthropic-ai/claude-agent-sdk";

import { REPO_ROOT, agentEnv, resolveEffort, resolveModel, resolveThinking } from "../config.mjs";
import { scrubPaths } from "../cad/python.mjs";
import { getLessonsDigest, recordTurnError } from "../lessons.mjs";
import { persistSession } from "../sessions.mjs";
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
  "emit_lesson_offer",
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
// (export 供 lessons.distill.mjs 的一次性蒸餾 query 共用同一份禁用清單)
export const DISALLOWED = [
  "WebSearch", "WebFetch", "AskUserQuestion",
  "Task", "Agent", "ScheduleWakeup", "SendMessage", "Monitor", "Workflow", "Skill",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "CronCreate", "CronDelete", "CronList", "PushNotification", "RemoteTrigger",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
];

// 認證 / 網路 / 環境類錯誤的啟發式黑名單:這類錯誤與 transcript 好壞無關,不計入
// resume 降級門檻。寧可收窄漏判(漏判只是多給一次重試機會);不收 "token" 這種寬字
// ——損毀 transcript 的 JSON parse 錯誤常帶 "Unexpected token";也不收裸狀態碼數字
// ——"position 500"、"line 403" 這類座標會把真壞檔永久誤判成 transient 永不降級。
const TRANSIENT_RE =
  /oauth|api.?key|unauthorized|authentication|credential|expired|billing|credit|rate.?limit|usage.?limit|overloaded|enoent|econnrefused|enotfound|etimedout|eai_again|fetch failed|network error|socket hang ?up/i;

export async function runTurn({ session, emit, message, imageBlocks = [] }) {
  const abort = new AbortController();
  session.currentAbort = abort;
  session._valAttempt = 0;
  session._paramsEmitted = false;
  session._clarifyPending = false; // 使用者的新訊息 = 已回答上回合的提問

  const mcp = buildCadchatServer({ session, emit, signal: abort.signal });
  // 累積教訓摘要:每 turn 重算一次(讀一個小 JSON;失敗回 "" 絕不擋 turn),
  // buildSystemPrompt 讀 session._lessonsDigest 注入「# 累積教訓」段。
  session._lessonsDigest = getLessonsDigest();

  // prompt 恆走 streaming input(單一程式路徑):SDK 的字串 prompt 會被傳輸層硬編成
  // 純 text block,永遠帶不了 image content block;這裡自組同形狀的 user message
  // (鏡射 SDK 內部包裝:session_id 空字串、parent_tool_use_id null),yield 一則即
  // return → 輸入串流關閉,行為與單發字串等價。resume/canUseTool 與 prompt 形狀正交。
  const content = [...imageBlocks, { type: "text", text: message }];
  async function* promptStream() {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
  }

  const model = resolveModel();
  const q = query({
    prompt: promptStream(),
    options: {
      ...(model ? { model } : {}),
      effort: resolveEffort(), // 預設 xhigh(CADCHAT_EFFORT 可調)
      thinking: resolveThinking(), // 預設 disabled(CADCHAT_THINKING 可調)
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
        session._resumedFromDisk = false; // init 到手 = resume(或新開)已成立,降級標記解除
        session._resumeFailedOnce = false; // 失敗計數跟著歸零
        session._rehydrateNote = null; // 接續提示已隨 prompt 送達,消耗掉(pre-init 失敗時保留重用)
        persistSession(session); // sdkSessionId 落盤 → 重整/重啟後可續接
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
          recordTurnError(session, msg.result || msg.subtype || "agent error", "agent_error");
          // CLI 端錯誤文字可能含本機絕對路徑 → 與 Python 輸出同規格過 scrub
          emit("error", { message: scrubPaths(String(msg.result || msg.subtype || "agent error")) });
        }
        // result = 回合結束。CLI 若因背景任務/排程喚醒續命,後續自主輸出一律不收。
        break;
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      ok = false;
      recordTurnError(session, err, "exception");
      // 降級接續:resume 靠的是磁碟還原的 sdkSessionId,而 query 在 init 前就炸。
      // 但炸的原因未必是 transcript 損毀——token 過期、CLI spawn 失敗、API 瞬斷都會
      // 走到這裡,這類錯誤重試即癒,不該永久丟棄對話紀錄。三道保險:
      // ① 認證/網路類錯誤(TRANSIENT_RE)永不計入降級門檻——修好根因前重送幾次都
      //   與 transcript 好壞無關;② 首次失敗只記標記+回報真實錯誤;③ 第二振須距
      //   首振 >5s(前端佇列會在失敗後毫秒級自動補送下一則,不設間隔一次瞬斷就把
      //   兩振自動燒完)。兩振湊齊才視為 transcript 壞掉,丟棄舊 transcript 改走
      //   open-project 式的 _rehydrateNote 接續:下一則訊息以全新對話起跑,靠 Read
      //   產生器檔重建語境(失去逐字對話記憶,保留產物/參數/版本)。
      const raw = scrubPaths(String(err?.message || err));
      if (session._resumedFromDisk && session.sdkSessionId && !TRANSIENT_RE.test(raw)) {
        const firstAt = Number(session._resumeFailedAt) || 0;
        if (session._resumeFailedOnce && Date.now() - firstAt > 5000) {
          session.sdkSessionId = null;
          session._resumedFromDisk = false;
          session._resumeFailedOnce = false;
          if (session.lastName) {
            session._rehydrateNote =
              `（先前的對話紀錄無法續接,本訊息以新對話接續既有產物 ${session.lastName}。` +
              `產生器已在 ${session.workdirRel}/${session.lastName}.py,修改前先 Read 它,` +
              `沿用其 PARAMS/INTENDED_CONTACT/MOTION 結構,用 cad_build(edits) 精修。）`;
          }
          persistSession(session);
          emit("error", {
            message: "無法接續上次的對話紀錄(已切換為接續產物模式),請把剛才的訊息再送一次。",
          });
        } else {
          if (!session._resumeFailedOnce) {
            session._resumeFailedOnce = true;
            session._resumeFailedAt = Date.now();
          }
          emit("error", { message: `${raw}(再送一次會重試接續上次的對話)` });
        }
      } else {
        emit("error", { message: raw });
      }
    }
  } finally {
    // 回合結束即終止 CLI 子程序:不留殭屍在背景自主續跑(正常結束時為 no-op)。
    // 共享把手只清自己掛的:interrupt 提早放行 busy 後新 turn 可能已把
    // currentAbort/_query 換成自己的,舊 turn 的 finally 不得清掉新 turn 的把手
    // (否則新 turn 的 interrupt/斷線中止會失效)。
    abort.abort();
    if (session.currentAbort === abort) session.currentAbort = null;
    if (session._query === q) session._query = null;
  }
  return { ok };
}
