// 用 Agent SDK query() 驅動一個對話回合,把訊息串流映射成 SSE 事件。
import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  REPO_ROOT,
  agentEnvFor,
  resolveClaudeCliExe,
  resolveEffort,
  resolveModelFor,
  resolveThinking,
} from "../config.mjs";
import { isDemoUser } from "../users.mjs";
import { scrubPaths } from "../cad/python.mjs";
import { getLessonsDigest, recordTurnError } from "../lessons.mjs";
import { persistSession } from "../sessions.mjs";
import { isDesignLike } from "../../lib/chatModes.js";
import { buildSystemPrompt } from "./prompt.mjs";
import { buildCableSystemPrompt } from "./prompt.cable.mjs";
import { buildLibrarySystemPrompt } from "./prompt.library.mjs";
import { buildSketchSystemPrompt } from "./prompt.sketch.mjs";
import { PART_BUILDER_AGENT } from "./prompt.orch.mjs";
import {
  appendMetricsLine,
  beginTurnMetrics,
  finishTurnMetrics,
  ingestSdkMessage,
} from "./turnMetrics.mjs";
import { READ_HOOK_MATCHER, makeReadScopeHook, makeToolGuard } from "./guards.mjs";
import { STAGE_UNDERSTAND, autoStageMode, nextStage } from "./stages.mjs";
import { buildCadchatServer } from "./tools.mjs";
import { LIBRARY_MCP_TOOLS, buildLibraryServer } from "./tools.library.mjs";
import { SKETCH_MCP_TOOLS, buildSketchServer } from "./tools.sketch.mjs";

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

// 草模模式:純 MCP 白名單(不含 Read/Glob/Grep——schema 契約整份內嵌 prompt,
// 沒有值得讀的參考檔,保留只會誘導漂回 CAD 思維)。
const SKETCH_ALLOWED = [...SKETCH_MCP_TOOLS];

// 零件庫模式:MCP 6 工具 + Read/Glob/Grep(查庫要列/讀 parts-library/*/meta.json)。
const LIBRARY_ALLOWED = ["Read", "Glob", "Grep", ...LIBRARY_MCP_TOOLS];

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

// SDK spawn 的 claude CLI 額外 env(2026-10-09 減模型往返,回合遙測實測):
// - ENABLE_TOOL_SEARCH=false:CLI 預設把 MCP 工具 schema 延遲載入,agent 每回合第一件事都是
//   呼叫 ToolSearch 把 cadchat 工具載進來(一次往返 3–5s + 一句「載入工具。」);關掉後
//   schema 隨系統提示一次到位(走 prompt cache,之後回合零成本)。
// - CLAUDE_CODE_DISABLE_AUTO_MEMORY=1:CLI 會把開發者本機 ~/.claude/projects/<repo>/memory/
//   的個人記憶索引灌進系統提示,agent 每回合都先 Read 其中的 cadpy-parts 筆記來查簽章——
//   對別台機器/packaged 不存在的隱性依賴;簽章已內嵌 prompt(標準件幾何段),記憶一律不載。
export const SDK_ENV_EXTRAS = Object.freeze({
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});

// 認證 / 網路 / 環境類錯誤的啟發式黑名單:這類錯誤與 transcript 好壞無關,不計入
// resume 降級門檻。寧可收窄漏判(漏判只是多給一次重試機會);不收 "token" 這種寬字
// ——損毀 transcript 的 JSON parse 錯誤常帶 "Unexpected token";也不收裸狀態碼數字
// ——"position 500"、"line 403" 這類座標會把真壞檔永久誤判成 transient 永不降級。
const TRANSIENT_RE =
  /oauth|api.?key|unauthorized|authentication|credential|expired|billing|credit|rate.?limit|usage.?limit|overloaded|enoent|econnrefused|enotfound|etimedout|eai_again|fetch failed|network error|socket hang ?up/i;

// CADCHAT_ORCH_DEBUG=1:逐則 SDK 訊息印一行事實(type/parent/工具名;init 另印工具與子代理
// 清單),供派工 spike 判讀 Agent 工具是否放行、子代理 MCP 呼叫是否到達、result 是否在
// 子代理完成後才到。stream_event 只印 content_block_start(delta 量太大)。
function debugMsg(msg) {
  try {
    if (msg.type === "stream_event" && msg.event?.type !== "content_block_start") return;
    const line = { type: msg.type, subtype: msg.subtype, parent: msg.parent_tool_use_id ?? null };
    const tools = (msg.message?.content || []).filter((b) => b?.type === "tool_use").map((b) => b.name);
    if (tools.length) line.tools = tools;
    if (msg.type === "user") {
      line.results = (msg.message?.content || [])
        .filter((b) => b?.type === "tool_result")
        .map((b) => `${b.tool_use_id}:${b.is_error ? "ERR" : "ok"}`);
    }
    if (msg.type === "system" && msg.subtype === "init") {
      line.initTools = msg.tools;
      line.agents = msg.agents;
    }
    if (msg.type === "stream_event") {
      const b = msg.event.content_block;
      line.block = `${b?.type || "?"}:${b?.name || ""}:${b?.id || ""}`;
    }
    console.error("[orch-debug]", JSON.stringify(line));
  } catch {
    /* debug only */
  }
}

export async function runTurn({ session, emit, message, imageBlocks = [], orch = false }) {
  const abort = new AbortController();
  session.currentAbort = abort;
  session._valAttempt = 0;
  session._paramsEmitted = false;
  session._clarifyPending = false; // 使用者的新訊息 = 已回答上回合的提問
  // 派工實驗(orch):per-request 旗標(chat.mjs resolveOrch)。prompt 分支讀 session._orch;
  // _subToolUseIds 收子代理訊息(assistant tool_use 區塊)的 tool_use id(工具卡 sub 標記用,純裝飾)。
  session._orch = !!orch;
  session._subToolUseIds = new Set();
  // 回合遙測:SDK 訊息逐則餵入(no-throw),finally 發 metrics 事件 + 落 metrics.jsonl。
  const tm = beginTurnMetrics(session, { variant: orch ? "orch" : "single" });
  const orchDebug = process.env.CADCHAT_ORCH_DEBUG === "1";

  // per-user 分流 context:demo 身分走自備 API key + 便宜模型(絕不用訂閱 OAuth);
  // 非 demo → resolveModelFor/agentEnvFor 完全等同 resolveModel()/agentEnv()(零回歸)。
  const demoCtx = { user: session.user, demo: isDemoUser(session.user) };

  // 模式選路:prompt / 工具集 / 白名單三路一起換(session.mode 是 mint 時的恆定屬性)。
  const mode = session.mode; // mint/hydrate 已 normalizeMode,恆為白名單值
  const isSketch = mode === "sketch";
  const mcp = isSketch
    ? buildSketchServer({ session, emit, signal: abort.signal })
    : mode === "library"
      ? buildLibraryServer({ session, emit, signal: abort.signal })
      : buildCadchatServer({ session, emit, signal: abort.signal });
  const allowed = isSketch ? SKETCH_ALLOWED : mode === "library" ? LIBRARY_ALLOWED : ALLOWED;
  // 階段列自動推進(stages.mjs):設計/電纜模式回合開始即「理解」,之後在主代理的 tool_use
  // 區塊開始時依工具名推階段(prompt 已不再要求 emit_stage;遙測顯示每回合省 5 次呼叫)。
  const autoStage = autoStageMode(mode);
  session._stageCur = -1;
  if (autoStage) {
    session._stageCur = STAGE_UNDERSTAND;
    emit("stage", { index: STAGE_UNDERSTAND });
  }
  // 累積教訓摘要:每 turn 重算一次(讀一個小 JSON;失敗回 "" 絕不擋 turn),
  // buildSystemPrompt 讀 session._lessonsDigest 注入「# 累積教訓」段。
  // 只有設計鏈模式(design/cable)注入:現有教訓全是 build123d/幾何驗證語彙,
  // 對草模/零件庫是純 token 浪費+契約污染。
  session._lessonsDigest = isDesignLike(mode) ? getLessonsDigest() : "";

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

  const model = resolveModelFor(demoCtx);
  // packaged:釘死 SDK spawn 的 claude CLI(asar → .unpacked 改寫);dev 回 null
  // → 不傳,SDK 內建解析(行為與舊版完全一致)。
  const claudeCli = resolveClaudeCliExe();
  const guard = makeToolGuard(orch ? [...allowed, "Agent", "Task"] : allowed, { mode, session });
  const q = query({
    prompt: promptStream(),
    options: {
      ...(model ? { model } : {}),
      ...(claudeCli ? { pathToClaudeCodeExecutable: claudeCli } : {}),
      effort: resolveEffort(), // 預設 xhigh(CADCHAT_EFFORT 可調)
      thinking: resolveThinking(), // 預設 disabled(CADCHAT_THINKING 可調)
      cwd: REPO_ROOT,
      resume: session.sdkSessionId || undefined,
      // 2026-10-09 改空:["project"] 在 dev 會把 repo 根 CLAUDE.md + AGENTS.md(Codex 委派、
      // release 流程…與產圖無關)灌進系統提示(實測首回合 cache_creation 42k tokens),packaged
      // 沒有 .claude/ 又是另一套行為。cad-chat 的全部契約都在 systemPrompt.append,不依賴
      // 任何 settings 檔;空陣列讓 dev/packaged 同一份系統提示。
      settingSources: [],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: isSketch
          ? buildSketchSystemPrompt(session)
          : mode === "library"
            ? buildLibrarySystemPrompt(session)
            : mode === "cable"
              ? buildCableSystemPrompt(session)
              : buildSystemPrompt(session),
        // SDK ≥0.3.267 預設 snapshot:true = 系統提示只在對話首回合錄製一次,之後 resume
        // 一律送錄製版——append 變了也要等 compaction 才生效。cad-chat 的 append 每回合
        // 都會變(累積教訓摘要、已匯入元件註記、rehydrate 接續註記),必須每回合現算。
        snapshot: false,
      },
      mcpServers: { cadchat: mcp },
      // 不傳 allowedTools:裸名單會在 canUseTool 之前直接放行(SDK ≥0.3.198 每次 query
      // 對此發 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning)。白名單語意全收進 makeToolGuard
      // (allow 集合同一份 `allowed`),每個工具呼叫都經守衛;harness 層繞過守衛的
      // 非同步/編排工具仍靠 disallowedTools 整個移除。
      // 派工實驗(orch):只把 Agent 從禁用清單放出(Task*/排程/背景家族照禁),並讓守衛認得它
      // (harness 層本就不經 canUseTool,加進 allow 集是為了語意一致)。「Task」是 Agent 工具的
      // 舊名別名——spike 實測只放 Agent 時 init.tools 仍無 Agent,兩個名字要一起放。
      disallowedTools: orch ? DISALLOWED.filter((t) => t !== "Agent" && t !== "Task") : DISALLOWED,
      permissionMode: "default",
      canUseTool: guard,
      // 讀取硬閘(2026-10-09 修):default 模式下主代理的 Read/Glob/Grep 免 permission、不經
      // canUseTool,PreToolUse hook 才是每次呼叫都會過的位置;同一個 guard 兩處掛。
      hooks: { PreToolUse: [{ matcher: READ_HOOK_MATCHER, hooks: [makeReadScopeHook(guard)] }] },
      abortController: abort,
      // 串流 partial messages:沒有它,從送出到第一段完整文字之間(推理+寫產生器
      // 原始碼可達數十秒)前端完全沒有回饋。
      includePartialMessages: true,
      // 派工實驗:SDK 程式化子代理 part_builder(prompt.orch.mjs)。forwardSubagentText 維持
      // 預設 false(只轉子代理的 tool_use/tool_result,遙測夠用);不開 agentProgressSummaries
      // (每 30s fork 子代理,擾亂計時)。
      ...(orch ? { agents: { part_builder: PART_BUILDER_AGENT }, forwardSubagentText: false } : {}),
      // 派工時強制子代理前景:CLI 的 Agent 工具預設 run_in_background,背景子代理會讓 CLI 在
      // 子代理完成前就發 result、in-process MCP 通道隨之關閉(2026-07 事故根因);此 env 讓
      // run_in_background 參數不提供。
      env: {
        ...agentEnvFor(demoCtx),
        ...SDK_ENV_EXTRAS,
        ...(orch ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : {}),
      },
    },
  });
  session._query = q;

  let ok = true;
  // 串流狀態:目前正在打字的 tool_use 區塊(累計字元數,節流回報)。
  let typing = null;
  try {
    for await (const msg of q) {
      ingestSdkMessage(tm, msg); // 遙測:任何 type 都先餵(no-throw),再做 UI 映射
      if (orchDebug) debugMsg(msg);
      if (msg.parent_tool_use_id != null) {
        // 子代理的工具呼叫:記 tool_use id 供 cad_build/cad_validate 卡標 sub(不進主 UI 串流)。
        // 子代理的 stream_event 不會轉發(spike 實測 tStart 恆 null),只有 assistant 的
        // tool_use 區塊會到——它先於 MCP 呼叫抵達,handler 讀 _meta toolUseId 時已在集合裡。
        const blocks =
          msg.type === "assistant"
            ? msg.message?.content || []
            : msg.type === "stream_event" && msg.event?.type === "content_block_start"
              ? [msg.event.content_block]
              : [];
        for (const b of blocks) if (b?.type === "tool_use" && b.id) session._subToolUseIds.add(b.id);
      }
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
            if (autoStage) {
              // 工具開始被寫出的瞬間推階段(先於執行:「生成」在開始寫產生器原始碼時就亮)
              const st = nextStage(session._stageCur, b.name);
              if (st != null) {
                session._stageCur = st;
                emit("stage", { index: st });
              }
            }
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
          mode: session.mode,
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
          // library session 的 lastName 恆 null(preview 不動產物欄位)→ 天然跳過
          if (session.lastName) {
            session._rehydrateNote = isSketch
              ? `（先前的對話紀錄無法續接,本訊息以新對話接續既有草模 ${session.lastName}。` +
                `使用者畫布上已有上一版草模;依其需求重新設計場景,用 sketch_present 整份重送。）`
              : `（先前的對話紀錄無法續接,本訊息以新對話接續既有產物 ${session.lastName}。` +
                `產生器已在 ${session.workdirAbs}/${session.lastName}.py,修改前先 Read 它,` +
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
    // 回合遙測:metrics 事件必在 done 之前(done 由 chat.mjs sse.end 寫);遙測永不擋回合。
    try {
      const summary = finishTurnMetrics(tm, { session, ok });
      if (summary) {
        emit("metrics", summary);
        appendMetricsLine(session.workdir, summary);
      }
    } catch {
      /* telemetry never blocks a turn */
    }
    if (session._turnMetrics === tm) session._turnMetrics = null;
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
