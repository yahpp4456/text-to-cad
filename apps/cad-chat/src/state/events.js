// 把 SSE 事件映射成 store actions。

// busy 事件的 what(工具名) → 進行中活動列的友善文字。
const TOOL_LABELS = {
  thinking: "深度思考中",
  cad_build: "撰寫產生器原始碼",
  cad_validate: "幾何驗證中",
  cad_present: "載入 3D 畫布",
  cad_source_part: "選用標準件",
  cad_import: "匯入元件",
  cad_measure: "量測幾何",
  cad_align: "計算對齊",
  cad_export: "匯出中",
};

function liveText(what, chars) {
  const key = String(what || "").replace(/^mcp__cadchat__/, "");
  let t;
  if (TOOL_LABELS[key]) t = TOOL_LABELS[key];
  else if (key.startsWith("emit_")) t = "更新畫面";
  else if (key === "Read" || key === "Glob" || key === "Grep") t = "查閱建模參考";
  else if (key) t = `執行 ${key}`;
  else t = "思考中";
  if (chars) t += ` · 已寫 ${(chars / 1000).toFixed(1)}k 字元`;
  return `${t}…`;
}

export function handleEvent(dispatch, type, data = {}) {
  switch (type) {
    case "session":
      dispatch({ type: "SET_SESSION", sessionId: data.sessionId });
      break;
    case "stage":
      dispatch({ type: "SET_STAGE", index: data.index });
      break;
    case "ai_start":
      dispatch({ type: "AI_STREAM_START" });
      break;
    case "ai_delta":
      dispatch({ type: "AI_STREAM_DELTA", text: data.text || "" });
      break;
    case "busy":
      dispatch({ type: "SET_LIVE", live: { text: liveText(data.what, data.chars) } });
      break;
    case "ai":
      dispatch({ type: "AI_FINALIZE", text: data.text });
      break;
    case "spec":
      dispatch({ type: "ADD_ITEM", item: { type: "spec", chips: data.chips || [] } });
      break;
    case "plan":
      dispatch({
        type: "ADD_ITEM",
        item: { type: "plan", steps: data.steps || [], count: (data.steps || []).length, open: true },
      });
      break;
    case "clarify":
      dispatch({
        type: "ADD_ITEM",
        item: { type: "clarify", q: data.q, opts: data.opts || [], suggested: data.suggested || "" },
      });
      break;
    case "tool":
      dispatch({ type: "UPSERT_TOOL", id: data.id, patch: data });
      break;
    case "validate":
      dispatch({
        type: "ADD_ITEM",
        item: {
          type: "validate",
          ok: data.ok,
          attempt: data.attempt,
          ms: data.ms,
          partCount: data.partCount,
          checks: data.checks || [],
        },
      });
      break;
    case "retry":
      dispatch({
        type: "ADD_ITEM",
        item: { type: "retry", attempt: data.attempt, reason: data.reason, adjustment: data.adjustment },
      });
      break;
    case "artifact":
      dispatch({
        type: "ADD_ITEM",
        item: {
          type: "artifact",
          ver: data.ver,
          name: data.name,
          code: data.code,
          ghost: data.ghost,
          formats: data.formats || [],
          fileType: data.type || "", // part | assembly(伺服端 manifest 推導)
          partCount: data.partCount,
        },
      });
      break;
    case "version":
      dispatch({
        type: "ADD_VERSION",
        version: {
          id: data.id,
          name: data.name,
          glbUrl: data.glbUrl,
          file: data.file,
          formats: data.formats || [],
          type: data.type || "",
          partCount: data.partCount,
          source: data.source || "generated",
        },
      });
      break;
    case "present":
      dispatch({
        type: "PRESENT",
        glbUrl: data.glbUrl,
        name: data.name,
        code: data.code,
        ver: data.ver,
        fileType: data.type || "",
      });
      break;
    case "params":
      dispatch({ type: "SET_PARAMS", defs: data.defs || [] });
      break;
    case "motion":
      dispatch({ type: "SET_MOTION", motion: data });
      break;
    case "error":
      dispatch({ type: "ADD_ITEM", item: { type: "ai", text: `⚠ ${data.message}`, isError: true } });
      break;
    case "done":
    default:
      break;
  }
}
