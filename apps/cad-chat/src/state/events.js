// 把 SSE 事件映射成 store actions。
import { unescapeNewlines } from "../lib/clarifyText.js";

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
  sketch_present: "搭建機構草模",
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
      // 伺服端 session 的 mode 是權威真相(per-session 恆定)→ 校正前端切換器
      // (mode_mismatch 400 之外的溫和同步路;無欄位=舊 server,不動)。
      if (data.mode === "sketch" || data.mode === "design") {
        dispatch({ type: "SET_MODE", mode: data.mode });
      }
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
    case "spec": {
      // 防禦性正規化(server choke point 已做一次;這裡兜 server 未重啟/舊事件)。
      // assumed 只在嚴格 === true 時透傳(結構化旗標,模型亂給型別不擴散)。
      const chips = (data.chips || []).map((c) => ({
        k: unescapeNewlines(c?.k),
        v: unescapeNewlines(c?.v),
        ...(c?.assumed === true ? { assumed: true } : {}),
      }));
      dispatch({ type: "ADD_ITEM", item: { type: "spec", chips } });
      // 記進 turnSpec:clarify 到達時精靈的步驟 1 資料來源
      dispatch({ type: "SET_TURN_SPEC", chips });
      break;
    }
    case "plan":
      dispatch({
        type: "ADD_ITEM",
        item: { type: "plan", steps: data.steps || [], count: (data.steps || []).length, open: true },
      });
      break;
    case "clarify": {
      // 防禦性正規化字面 \n(q 進 pre-line 渲染;opts/suggested 會被原樣送回)
      const q = unescapeNewlines(data.q);
      const opts = (data.opts || []).map((o) => ({
        label: unescapeNewlines(o?.label),
        value: unescapeNewlines(o?.value),
      }));
      const suggested = unescapeNewlines(data.suggested || "");
      dispatch({ type: "ADD_ITEM", item: { type: "clarify", q, opts, suggested } });
      // 同步掛上視圖區的兩步精靈(任何使用者送出即視為已回答,由 ADD_USER 清掉;
      // specs 由 reducer 從 turnSpec 併入)
      dispatch({ type: "SET_CLARIFY", clarify: { q, opts, suggested } });
      break;
    }
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
          fileType: data.type || "", // part | assembly | sketch(伺服端推導)
          partCount: data.partCount,
          // 草模卡(SketchCard)摘要欄位:CAD 事件無這些欄位 → undefined 不影響
          title: data.title,
          dofs: Array.isArray(data.dofs) ? data.dofs : undefined,
          joints: data.joints,
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
          snapshot: data.snapshot, // false = 無凍結快照(JSON 路徑經 App.jsx 直傳,兩邊欄位要一致)
          hasDxf: data.hasDxf === true, // 鈑金件(產生器有 gen_dxf)→ DXF 展開圖鈕
          flatGlbUrl: data.flatGlbUrl ?? null, // 鈑金件(有 gen_flat)→ 摺疊/攤平即時切換
          flatLinesUrl: data.flatLinesUrl ?? null, // 折彎線 sidecar → 攤平態虛線 overlay
          projectDir: data.projectDir ?? null, // 唯讀檢視版的升級目錄(一般產出=null)
          sceneUrl: data.sceneUrl ?? null, // 草模場景 JSON(type:"sketch";CAD 版=null)
          dofs: Array.isArray(data.dofs) ? data.dofs : undefined, // 草模 DOF 摘要
          title: data.title, // 草模標題(繁中)
          // 產圖模式戳記(server versionStamp 權威發;舊事件無欄位 → undefined 三態)
          // 注意:草模的身分走 type:"sketch",伺服端草模事件「禁帶 mode 欄位」(legacy 撞名)
          mode: data.mode === "actual" ? "actual" : data.mode === "design" ? "design" : undefined,
          verified: typeof data.verified === "boolean" ? data.verified : undefined,
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
        projectDir: data.projectDir ?? null,
        flatGlbUrl: data.flatGlbUrl ?? null,
        flatLinesUrl: data.flatLinesUrl ?? null,
        sceneUrl: data.sceneUrl ?? null, // 草模場景(type:"sketch" 的 present 帶)
      });
      break;
    case "params":
      dispatch({ type: "SET_PARAMS", defs: data.defs || [] });
      break;
    case "params_values":
      // regen 失敗回滾:server 把滑桿值拉回磁碟真相(defs 不動,不降級 emit_params 品質)
      dispatch({ type: "SET_PARAM_VALUES", values: data.values || {} });
      break;
    case "motion":
      dispatch({ type: "SET_MOTION", motion: data });
      break;
    case "lesson_offer":
      // 「驗證全綠卻看圖才發現」缺陷修正後,agent 問是否記教訓(對話流是/否卡)。
      // payload 帶整理好的內容(server choke point 已正規化;這裡兜舊事件再防禦一次)。
      // **不放 id 鍵**:chatStore ADD_ITEM 是 { id, ...action.item },帶 id 會蓋掉 mint 的。
      dispatch({
        type: "ADD_ITEM",
        item: {
          type: "lesson_offer",
          symptom: unescapeNewlines(data.symptom),
          rootCause: unescapeNewlines(data.rootCause),
          fix: unescapeNewlines(data.fix),
          tag: String(data.tag || "").trim(),
        },
      });
      break;
    case "error":
      dispatch({ type: "ADD_ITEM", item: { type: "ai", text: `⚠ ${data.message}`, isError: true } });
      break;
    case "done":
    default:
      break;
  }
}
