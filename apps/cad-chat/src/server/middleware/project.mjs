// 專案生命周期(免 LLM 直接操作,回 JSON):
//   POST /api/import        {sessionId?, file}     — 複製 models/ 下 STEP 進 session imported/
//   POST /api/open-project  {dir, generator?}      — 開既有專案:複製樹到新 session + 重建
// 與 agent 的 cad_import 工具收斂到同一份 pipeline.importStepIntoSession。
import fs from "node:fs";
import path from "node:path";

import { MODELS_ROOT } from "../config.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { resolveInside } from "../cad/paths.mjs";
import { getOrCreateSession } from "../sessions.mjs";
import {
  emitPresent,
  importStepIntoSession,
  inspectFacts,
  paramDefsFromGenerator,
  runStep,
  runValidate,
  sanitizeName,
} from "../cad/pipeline.mjs";

const REBUILD_TIMEOUT_MS = 300_000; // 開專案同步重建上限(大組合件 tessellation 較久)
const FACTS_TIMEOUT_MS = 30_000;

async function handleImport(body, res) {
  const session = getOrCreateSession(body?.sessionId); // 無 sessionId 就開新的(回給前端採用)
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const imp = importStepIntoSession(session, body?.file);
  if (!imp.ok) {
    sendJson(res, 200, { ok: false, error: imp.error });
    return;
  }
  if (!session.imports.includes(imp.rel)) session.imports.push(imp.rel);
  // bbox 摘要(給 prefill 訊息;逾時就省略,不擋匯入)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FACTS_TIMEOUT_MS);
  const facts = await inspectFacts(session, imp.rel, { signal: ac.signal });
  clearTimeout(timer);
  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    rel: imp.rel,
    label: imp.label,
    reused: !!imp.reused,
    sizeMm: facts?.size || null,
  });
}

// 遞迴複製專案樹(跳過快取/隱藏目錄雜物;隱藏 topology GLB 要帶——重建失敗時至少能看圖)。
function copyProjectTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (ent.name === "__pycache__" || ent.name.endsWith(".pyc")) continue;
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyProjectTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

// 選主產生器:指定 > 唯一 .py > 有同名 .asm.json > 檔案最大。回 stem|null。
function pickGenerator(dir, requested) {
  const pys = fs.readdirSync(dir).filter((f) => f.endsWith(".py"));
  if (!pys.length) return null;
  if (requested) {
    const want = `${sanitizeName(requested)}.py`;
    if (pys.includes(want)) return want.slice(0, -3);
  }
  if (pys.length === 1) return pys[0].slice(0, -3);
  const withManifest = pys.find((f) => fs.existsSync(path.join(dir, `${f.slice(0, -3)}.asm.json`)));
  if (withManifest) return withManifest.slice(0, -3);
  const largest = pys
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  return largest.f.slice(0, -3);
}

async function handleOpenProject(body, res) {
  const clean = String(body?.dir || "")
    .replace(/\\/g, "/")
    .replace(/^models\//, "");
  let srcAbs;
  try {
    srcAbs = resolveInside(MODELS_ROOT, clean);
  } catch {
    sendJson(res, 403, { ok: false, error: "路徑超出 models/" });
    return;
  }
  if (!clean || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) {
    sendJson(res, 404, { ok: false, error: "目錄不存在" });
    return;
  }

  // 開新 session(不原地續用:舊 workdir 是歷史快照,兩個 session 同目錄會互踩)
  const session = getOrCreateSession(null);
  copyProjectTree(srcAbs, session.workdir);

  const name = pickGenerator(session.workdir, body?.generator);
  if (!name) {
    sendJson(res, 200, {
      ok: false,
      sessionId: session.sessionId,
      error: "目錄裡沒有產生器 .py(純檔案請用「開啟」看圖)",
    });
    return;
  }
  session.lastName = name;
  session.rehydratedFrom = clean;
  // rehydrate 後首個 agent turn 的一次性接續提示(chat.mjs 取用後清空)
  session._rehydrateNote =
    `（本對話接續既有專案 ${name}(來源 models/${clean})。產生器已在 ${session.workdirRel}/${name}.py,` +
    `修改前先 Read 它,沿用其 PARAMS/INTENDED_CONTACT/MOTION 結構,用 cad_build(edits) 精修。）`;

  // 同步重建:防 cadpy 版本漂移的舊 GLB,並重寫 manifest / 取回 motion
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REBUILD_TIMEOUT_MS);
  let step;
  let val = null;
  try {
    step = await runStep(session, name, { signal: ac.signal });
    if (step.ok) {
      val = await runValidate(session, name, { signal: ac.signal });
      if (val.partCount > 0) session.lastPartCount = val.partCount;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!step.ok) {
    sendJson(res, 200, {
      ok: false,
      sessionId: session.sessionId,
      name,
      error: `重建失敗:${(step.stderr || "").trim().slice(-400) || `exit ${step.exitCode}`}(session 已保留,可用對話修復)`,
    });
    return;
  }

  // 收集 emitPresent 的三事件讓前端 dispatch(無 SSE 通道,JSON 帶回)
  const events = [];
  emitPresent(session, name, (ev, data) => events.push([ev, data]));
  const version = events.find(([e]) => e === "version")?.[1] || null;
  const present = events.find(([e]) => e === "present")?.[1] || null;

  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    name,
    type: version?.type || "part",
    version,
    present,
    params: paramDefsFromGenerator(session, name),
    motion: val?.motion || null,
    validateOk: val ? val.ok : null,
  });
}

export function projectMiddleware() {
  return function project(req, res, next) {
    const url = parseUrl(req);
    if (req.method !== "POST" || (url.pathname !== "/api/import" && url.pathname !== "/api/open-project")) {
      next();
      return;
    }
    readJsonBody(req)
      .then((body) =>
        url.pathname === "/api/import" ? handleImport(body, res) : handleOpenProject(body, res),
      )
      .catch((err) => sendJson(res, 400, { ok: false, error: String(err?.message || err) }));
  };
}
