// Read/Glob/Grep 讀取範圍硬閘(跨使用者/跨對話資料隔離的最後一道;prompt 只是軟規則)。
// 允許:本對話工作目錄、本使用者 modelsRoot(專案/零件庫)、共用 fixtures 層
// (RUNTIME_ROOT/models 的範本)、skills/(build123d 參考檔)。
// 拒絕:任何 .cadchat/<其他 session>、其他使用者的 users/<u>/、repo 其他目錄
// (apps/ src、.env、data/ 教訓快照…)、以及「沒指定目錄」的全域 Glob/Grep
// (cwd=RUNTIME_ROOT,**/x 會掃到所有人的資料)。
import path from "node:path";

import { MODELS_FIXTURES_ROOT, RUNTIME_ROOT } from "../config.mjs";
import { pathIsInside } from "../cad/paths.mjs";

export const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

const GLOB_META = /[*?[\]{}]/;

// glob pattern 的靜態前綴目錄(第一個含萬用字元的段之前);"" = 無前綴(cwd 全域)。
export function globStaticPrefix(pattern) {
  const segs = String(pattern || "").replace(/\\/g, "/").split("/");
  const out = [];
  for (const seg of segs) {
    if (GLOB_META.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

// 工具輸入 → 要檢查的目標路徑(字串;null = 非讀取工具或無法判定)
export function readTargetOf(toolName, input) {
  const i = input || {};
  if (toolName === "Read") return typeof i.file_path === "string" ? i.file_path : null;
  if (toolName === "Glob" || toolName === "Grep") {
    if (typeof i.path === "string" && i.path.trim()) return i.path;
    if (toolName === "Glob" && typeof i.pattern === "string") return globStaticPrefix(i.pattern);
    return ""; // Grep 無 path = cwd 全域
  }
  return null;
}

/**
 * 由 session 推出讀取範圍(純資料;可注入根目錄供單測)。
 * sessionsDirs:所有 .cadchat 容器——其中只有 workdir 本身放行。
 */
export function readScopeFor(
  session,
  { runtimeRoot = RUNTIME_ROOT, fixturesRoot = MODELS_FIXTURES_ROOT } = {},
) {
  const rt = path.resolve(runtimeRoot);
  const fx = path.resolve(fixturesRoot);
  const workdir = path.resolve(
    session.workdirAbs || session.workdir || path.join(rt, session.workdirRel || ""),
  );
  const modelsRoot = session.modelsRoot ? path.resolve(session.modelsRoot) : null;
  const allow = [modelsRoot, fx, path.join(rt, "skills")].filter(Boolean);
  const sessionsDirs = [modelsRoot && path.join(modelsRoot, ".cadchat"), path.join(fx, ".cadchat")].filter(
    Boolean,
  );
  return { cwd: rt, workdir, allow, sessionsDirs };
}

export function isReadAllowed(target, scope) {
  if (typeof target !== "string") return false;
  const t = target.trim();
  if (!t) return false; // 無目錄的全域 Glob/Grep
  const abs = path.isAbsolute(t) ? path.resolve(t) : path.resolve(scope.cwd, t);
  if (pathIsInside(abs, scope.workdir)) return true;
  for (const sd of scope.sessionsDirs) {
    if (pathIsInside(abs, sd)) return false; // 其他對話的資料夾(含容器本身的列舉)
  }
  for (const a of scope.allow) {
    if (pathIsInside(abs, a)) return true;
  }
  return false;
}

export const READ_DENY_MSG =
  "越界讀取被拒絕:只能讀本對話工作目錄、models 下的範本與零件庫、以及 skills/ 參考檔;" +
  "其他對話/其他使用者的資料與系統檔案一律不可讀,也不要再嘗試。Glob/Grep 請指定目錄。";
