// canUseTool 沙箱:只允許白名單工具(設計=Read/Glob/Grep + cadchat MCP;草模=純 MCP),
// 其餘(Write/Edit/Bash/...)一律 deny —— agent 寫檔只能透過 cad_build / sketch_present。
export function makeToolGuard(allowedTools, { sketch = false } = {}) {
  const allowed = new Set(allowedTools);
  const denyMsg = sketch
    ? (t) => `「${t}」未啟用。草模模式請改用 emit_* / sketch_present 工具(schema 契約已在系統提示內,無需讀檔)。`
    : (t) => `「${t}」未啟用。請改用 cad_* / emit_* 工具產圖,或用 Read 讀 skills/cad 參考檔。`;
  return async function canUseTool(toolName, input) {
    if (allowed.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: denyMsg(toolName) };
  };
}
