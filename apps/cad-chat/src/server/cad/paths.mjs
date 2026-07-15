// 路徑沙箱 helper:確保所有檔案存取/寫入都限制在指定根目錄內。
import fs from "node:fs";
import path from "node:path";

import { MODELS_FIXTURES_ROOT, MODELS_ROOT } from "../config.mjs";

// child 是否在 parent 內(含 parent 本身)。跨平台、防 .. 逃逸。
export function pathIsInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// 把外部來的相對路徑(如 "models/.cadchat/<id>/part.step")安全解析到 root 內。
// 越界則丟錯。
export function resolveInside(root, relOrAbs) {
  const resolved = path.isAbsolute(relOrAbs)
    ? path.resolve(relOrAbs)
    : path.resolve(root, relOrAbs);
  if (!pathIsInside(resolved, root)) {
    throw new Error(`path escapes sandbox: ${relOrAbs}`);
  }
  return resolved;
}

// ── 雙根 models「讀取」解析(packaged:可寫層 DATA_ROOT/models 優先、唯讀
// fixtures 層 RUNTIME_ROOT/models fallback)──
// dev 兩層同根 → 直接走單根 resolveInside,行為與舊版完全一致(零回歸)。
// 兩層都沒有該檔 → 回可寫層候選路徑(呼叫端自行 stat 報「不存在」,錯誤語意與
// 單根一致);兩層都越界才丟錯。**寫入**目的地不得用本函式(只准可寫層,直接
// resolveInside(modelsRoot, …))。
// modelsRoot 可注入(per-user 根;預設 legacy 全域根 = 零回歸)。per-user 根
// 恆 ≠ fixtures 根 → 自然得到「user 層優先、共用 fixtures 兜底」。
export function resolveModelRead(relOrAbs, { modelsRoot = MODELS_ROOT } = {}) {
  if (MODELS_FIXTURES_ROOT === modelsRoot) return resolveInside(modelsRoot, relOrAbs);
  let primary = null;
  try {
    primary = resolveInside(modelsRoot, relOrAbs);
  } catch {
    /* 可寫層越界(如 fixtures 層的絕對路徑):還有 fixtures 層可試 */
  }
  if (primary && fs.existsSync(primary)) return primary;
  try {
    const fallback = resolveInside(MODELS_FIXTURES_ROOT, relOrAbs);
    if (fs.existsSync(fallback)) return fallback;
  } catch {
    /* fixtures 層也越界 */
  }
  if (primary) return primary;
  throw new Error(`path escapes sandbox: ${relOrAbs}`);
}
