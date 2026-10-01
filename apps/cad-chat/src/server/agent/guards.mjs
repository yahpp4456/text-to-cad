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
