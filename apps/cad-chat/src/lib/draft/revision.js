// 草稿編輯的復原/重做堆疊 + 伺服端 revision 合併語意(純函數,零依賴)。
// history = {past:[], present, future:[]};每次 push 深拷貝(structuredClone),上限 MAX_HISTORY。
// 伺服端 revision:本地編輯帶 baseRevision 送出;409 時以伺服端草稿為準重建 history
//(reconcile),不嘗試三方合併——草稿來源只有「agent 回合」與「同一個工作窗」兩個,互斥。
export const MAX_HISTORY = 50;

export function createHistory(present) {
  return { past: [], present: structuredClone(present), future: [] };
}

export function pushState(h, next) {
  const past = [...h.past, h.present].slice(-MAX_HISTORY);
  return { past, present: structuredClone(next), future: [] };
}

export function undo(h) {
  if (!h.past.length) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo(h) {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;

// 伺服端回覆後的對齊:ok → present 換成伺服端正規化草稿(保留 past 讓復原仍可用);
// conflict → 整個 history 重建自伺服端草稿(本地未送出的改動丟棄,呼叫端負責提示)。
export function reconcile(h, server) {
  if (!server) return h;
  if (server.conflict) return createHistory(server.draft);
  return { ...h, present: structuredClone(server.draft) };
}

// 本地草稿是否與基準(最近一次伺服端確認)不同——決定要不要自動保存
export function isDirty(h, baseline) {
  return JSON.stringify(h.present) !== JSON.stringify(baseline);
}
