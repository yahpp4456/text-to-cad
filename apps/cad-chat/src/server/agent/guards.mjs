// canUseTool 沙箱:只允許白名單工具(設計=Read/Glob/Grep + cadchat MCP;草模=純 MCP),
// 其餘(Write/Edit/Bash/...)一律 deny —— agent 寫檔只能透過 cad_build / sketch_present。
import { READ_DENY_MSG, READ_TOOLS, isReadAllowed, readScopeFor, readTargetOf } from "./readScope.mjs";

// session 給了才啟用讀取範圍硬閘(Read/Glob/Grep 只准本對話/本使用者/共用範本/skills;
// 跨對話、跨使用者、系統檔一律 deny——prompt 的「跨使用者資訊一律不答」是軟規則,這裡是硬閘)。
export function makeToolGuard(allowedTools, { mode = "design", session = null, scope = null } = {}) {
  const allowed = new Set(allowedTools);
  const readScope = scope || (session ? readScopeFor(session) : null);
  const denyMsg =
    mode === "sketch"
      ? (t) => `「${t}」未啟用。草模模式請改用 emit_* / sketch_present 工具(schema 契約已在系統提示內,無需讀檔)。`
      : mode === "library"
        ? (t) => `「${t}」未啟用。零件庫模式請改用 library_preview / library_add / emit_* 工具;查庫用 Glob/Read models/parts-library/。`
        : (t) => `「${t}」未啟用。請改用 cad_* / emit_* 工具產圖,或用 Read 讀 skills/cad 參考檔。`;
  return async function canUseTool(toolName, input) {
    // 派工 spike 用:證明子代理的工具呼叫是否也經過本守衛(CADCHAT_ORCH_DEBUG=1 才印)
    if (process.env.CADCHAT_ORCH_DEBUG === "1") console.error("[orch-debug] canUseTool", toolName);
    if (allowed.has(toolName)) {
      if (readScope && READ_TOOLS.has(toolName)) {
        const target = readTargetOf(toolName, input);
        if (!isReadAllowed(target, readScope)) {
          return { behavior: "deny", message: READ_DENY_MSG };
        }
      }
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: denyMsg(toolName) };
  };
}

// 讀取硬閘真正生效的位置(2026-10-09 修):SDK `permissionMode:"default"` 下主代理的 Read/Glob/
// Grep 在 cwd 內屬「免 permission」,**根本不經 canUseTool**——實測主代理成功讀了 packages/cadpy
// 與開發者 ~/.claude 記憶檔(兩者 isReadAllowed 皆 false),server log 零筆 canUseTool Read;只有
// 子代理會走 canUseTool。PreToolUse hook 對每一次工具呼叫都跑(含免 permission 的、含子代理),
// 所以把同一個 guard 再掛成 hook:guard deny → hook deny(訊息回給模型),guard allow → 不表態
// (回 {} 讓正常權限流程繼續;需要 permission 的路徑仍會再經 canUseTool,決策一致)。
// guard 本身丟錯視同 deny(硬閘 fail-closed)。
export const READ_HOOK_MATCHER = [...READ_TOOLS].join("|");

export function makeReadScopeHook(guard) {
  return async function readScopeHook(input) {
    const name = input?.tool_name;
    if (typeof name !== "string" || !READ_TOOLS.has(name)) return {};
    if (process.env.CADCHAT_ORCH_DEBUG === "1") console.error("[orch-debug] hook PreToolUse", name);
    let d;
    try {
      d = await guard(name, input.tool_input || {});
    } catch {
      d = { behavior: "deny", message: READ_DENY_MSG };
    }
    if (d?.behavior === "allow") return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: d?.message || READ_DENY_MSG,
      },
    };
  };
}
