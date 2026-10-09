// 頂部階段列自動推進(2026-10-09 減模型往返):設計/電纜模式不再要求 agent 每階段呼叫
// emit_stage——回合遙測顯示每個建模回合 5 次 emit_stage 各花一次工具往返或 0.3s 生成,
// 而階段其實可由「接下來呼叫哪個工具」決定性推出。runner 在 stream_event
// content_block_start(tool_use)當下推階段:這個事件先於工具執行,所以「生成」在 agent
// 開始寫產生器原始碼的瞬間就亮,與舊 emit_stage(2) 的時機一致。
// 單調遞增(驗證失敗回頭 cad_build 不倒退,與舊行為一致——agent 本來也不會重發 emit_stage)。
// emit_stage 工具本身保留:草模(3 段)/零件庫 prompt 仍用它,設計模式 agent 若仍呼叫也無害。
export const STAGE_BY_TOOL = Object.freeze({
  mcp__cadchat__emit_plan: 1, // 規劃
  mcp__cadchat__cad_build: 2, // 生成
  mcp__cadchat__cad_validate: 3, // 驗證
  mcp__cadchat__cad_present: 4, // 呈現
});

export const STAGE_UNDERSTAND = 0; // 回合開始即「理解」

// 哪些模式由 runner 自動推階段(設計 + 電纜;草模/零件庫有自己的階段語意與 prompt)。
export function autoStageMode(mode) {
  return mode !== "sketch" && mode !== "library";
}

export function stageForTool(name) {
  return Object.hasOwn(STAGE_BY_TOOL, name) ? STAGE_BY_TOOL[name] : null;
}

// 回傳該發出的 stage index(嚴格大於目前才發),否則 null。cur 為 null/undefined 視為 -1。
export function nextStage(cur, toolName) {
  const s = stageForTool(toolName);
  const c = typeof cur === "number" ? cur : -1;
  return s != null && s > c ? s : null;
}
