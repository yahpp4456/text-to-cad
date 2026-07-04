// canUseTool 沙箱:只允許白名單工具(Read/Glob/Grep + cadchat MCP 工具),
// 其餘(Write/Edit/Bash/...)一律 deny —— agent 寫檔只能透過 cad_build。
export function makeToolGuard(allowedTools) {
  const allowed = new Set(allowedTools);
  return async function canUseTool(toolName, input) {
    if (allowed.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    return {
      behavior: "deny",
      message: `「${toolName}」未啟用。請改用 cad_* / emit_* 工具產圖,或用 Read 讀 skills/cad 參考檔。`,
    };
  };
}
