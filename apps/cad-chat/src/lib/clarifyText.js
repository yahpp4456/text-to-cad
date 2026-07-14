// clarify/spec 文字契約的共用純函式(零依賴):server(tools.mjs emit handler 正規化)
// 與前端(events.js 防禦、ClarifyWizard 合成回覆、chatStore RESTORE re-arm)三端共用。
// node --test 直測(src/lib 無 cadjs 依賴前例:cadMotionMath.js)。

// 模型偶爾在 tool JSON 字串值裡寫「字面 backslash+n」(雙重跳脫)——管線全程透明轉手,
// 不正規化就會原樣印在 UI 上。這裡把字面 \r\n / \n 轉成真換行(真換行不受影響)。
export function unescapeNewlines(s) {
  return String(s ?? "").replace(/\\r\\n|\\n/g, "\n");
}

// 「(假設)」偵測:結構化旗標 assumed:true 為主(emit_spec schema),v 內文字慣例為
// fallback(舊 localStorage 快照、模型不聽話時兜底)。全半形括號都認。
export const ASSUMED_RE = /[(（]\s*假設\s*[)）]/;

export function isAssumedChip(c) {
  return c?.assumed === true || ASSUMED_RE.test(String(c?.v ?? ""));
}

// 顯示用:剝掉 v 裡的「(假設)」字樣(改由 badge 呈現,兩種來源視覺統一)。
export function stripAssumedTag(v) {
  return String(v ?? "")
    .replace(/[(（]\s*假設\s*[)）]/g, "")
    .trim();
}

// 兩步精靈的回覆合成:步驟 1 的 chip 修改(edits)與步驟 2 的選項答案(answer)
// 併成一則人話回覆。「規格修正:」前綴是與 prompt.mjs 的契約——prompt 規定這些
// 個別值優先於選項文字內嵌的假設值,不得為已修正項再提問。
export function composeClarifyReply({ edits, answer, suggested } = {}) {
  const fixes = Object.entries(edits || {})
    .map(([k, v]) => `${k} 改為 ${v}`)
    .join(";");
  if (!fixes) return answer || "";
  if (answer) return `規格修正:${fixes}。\n其餘採用:${answer}`;
  return suggested
    ? `規格修正:${fixes}。\n其餘採用建議:${suggested}`
    : `規格修正:${fixes}。其餘依你的建議值繼續,不必再確認。`;
}

// 視圖「解析規格」面板的資料源:transcript 最新一張「非 stale」spec 卡(跨回合
// 持續有效——它就是目前設計的已解析規格;修正走「規格修正:」契約)。stale=
// CLEAR_WORKSPACE(open-project 換 session=換設計)標記,舊設計的規格不再是
// 作答面。App(面板)與 Conversation(聊天卡指路)共用,避免兩端各自推導漂移。
export function latestSpecItem(items) {
  for (let i = (items?.length || 0) - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "spec" && !it.stale) return it;
  }
  return null;
}

// 視圖教訓「是/否」面板的資料源:最舊一張未答的 lesson_offer(佇列語意,答完
// 自動輪到下一張;聊天卡是被動紀錄,唯一作答面在視圖)。answered:"pending"
// (POST 進行中)也算「輪到中」——面板要留在原卡顯示進度,不能先跳下一張。
export function pendingLessonOffer(items) {
  return (
    (items || []).find(
      (it) => it?.type === "lesson_offer" && (!it.answered || it.answered === "pending"),
    ) || null
  );
}

// RESTORE re-arm:從 transcript 尾端往回掃——先遇 user = 選擇題已答(不 re-arm);
// 先遇 clarify = 未答,連同「同一段落」(不跨 user)最近的 spec chips 一起重建,
// 讓重整後精靈(含步驟 1 規格)與左欄凍結一致重現。
export function pendingClarifyFromItems(items) {
  for (let i = (items?.length || 0) - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "user") return null;
    if (it?.type === "clarify") {
      let specs = null;
      for (let j = i - 1; j >= 0; j--) {
        if (items[j]?.type === "user") break;
        if (items[j]?.type === "spec") {
          specs = items[j].chips || null;
          break;
        }
      }
      return { q: it.q, opts: it.opts || [], suggested: it.suggested || "", specs };
    }
  }
  return null;
}
