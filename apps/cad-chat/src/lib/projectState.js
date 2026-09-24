// 專案綁定與「未儲存」判定(純函數,零 import;Header chip、App 守衛、煙測共用同一份字串)。
//
// state.project = { dir, savedVer, origin, sessionId } | null
//   dir       models 相對路徑(伺服端 session.project.dir)
//   savedVer  上次儲存/開啟時的版本號(伺服端 project.ver)
//   origin    "opened"(從 models/<dir> 開啟)| "saved"(另存而來)
//   sessionId 綁定所屬的 session——跨 session 殘留一律視為未綁定
// dirty = 最新「生成」版本號 > savedVer(o*/p* 檢視版不算;回退也 +1 版,所以回退 = dirty)。

export function versionNum(id) {
  const m = /^v(\d+)$/.exec(String(id || ""));
  return m ? Number(m[1]) : null;
}

// 最新生成版本號(取最大而非最後:ADD_VERSION 撞 id 會取代,順序不可靠時仍正確)。
export function latestGenVersionNum(versions) {
  let max = 0;
  for (const v of Array.isArray(versions) ? versions : []) {
    if (!v || v.source === "opened") continue;
    const n = versionNum(v.id);
    if (n !== null && n > max) max = n;
  }
  return max;
}

// 收伺服端形({dir, ver, origin})或前端形({dir, savedVer, origin, sessionId});垃圾 → null。
export function normalizeProjectBinding(p, sessionId = undefined) {
  if (!p || typeof p !== "object") return null;
  const dir = typeof p.dir === "string" ? p.dir : "";
  if (!dir) return null;
  const raw = p.savedVer !== undefined ? p.savedVer : p.ver;
  const savedVer = Math.trunc(Number(raw));
  if (!Number.isFinite(savedVer) || savedVer < 0) return null;
  const origin = p.origin === "opened" ? "opened" : "saved";
  const sid = sessionId !== undefined ? sessionId : p.sessionId;
  return { dir, savedVer, origin, sessionId: typeof sid === "string" && sid ? sid : null };
}

export function isProjectBound(project, sessionId) {
  return !!(project && project.dir && sessionId && project.sessionId === sessionId);
}

export function isProjectDirty(project, versions, sessionId) {
  if (!isProjectBound(project, sessionId)) return false;
  return latestGenVersionNum(versions) > project.savedVer;
}

export const CHIP_TEXT = { dirty: "● 未儲存", saved: "✓ 已儲存" };

export function projectChipLabel(project, versions, sessionId) {
  if (!isProjectBound(project, sessionId)) return null;
  const state = isProjectDirty(project, versions, sessionId) ? "dirty" : "saved";
  return { dir: `models/${project.dir}`, state, stateText: CHIP_TEXT[state] };
}
