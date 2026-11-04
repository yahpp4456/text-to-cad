// 產品設計模式端點(免 LLM,回 JSON;只對 mode=product 的 session 開放):
//   GET  /api/surface-draft?sessionId&name        — 讀工作中草稿 {draft, revision, source, summary}
//   POST /api/surface-draft {sessionId, name?, draft|patch, baseRevision?, discard?}
//        — 保存/局部合併(base revision 不符 409 {revision, draft});discard:true 刪草稿
//   POST /api/surface-build {sessionId, name?}    — 完整驗證草稿 → 編譯 → build → 快路徑驗證 →
//        呈現(版本/present/params 以 JSON 帶回,同 open-project 的收集模式);busy 409
// 工作窗的「確認生成」走這裡;agent 的 surface_build 走同一份 surfaceBuild.mjs。
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { acquireBusy, getOrCreateSession, persistSession, probeSessionOnDisk, releaseBusy } from "../sessions.mjs";
import { sanitizeName, paramDefsFromGenerator } from "../cad/pipeline.mjs";
import { discardDraft, draftSummary, readDraft, saveDraft } from "../cad/surfaceDraft.mjs";
import { buildFromDraft } from "../cad/surfaceBuild.mjs";

function requireProductSession(sessionId, res, ctx = {}) {
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: "缺 sessionId" });
    return null;
  }
  if (!probeSessionOnDisk(sessionId, ctx.user).exists) {
    sendJson(res, 404, { ok: false, error: "session 不存在" });
    return null;
  }
  const session = getOrCreateSession(sessionId, { user: ctx.user });
  if (session.mode !== "product") {
    sendJson(res, 400, { ok: false, error: "mode_mismatch", mode: session.mode });
    return null;
  }
  return session;
}

async function handleGetDraft(url, res, ctx) {
  const session = requireProductSession(url.searchParams.get("sessionId"), res, ctx);
  if (!session) return;
  const name = sanitizeName(url.searchParams.get("name") || session.lastName || "product");
  const cur = readDraft(session, name);
  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    name,
    draft: cur?.draft ?? null,
    revision: cur?.revision ?? null,
    source: cur?.source ?? null,
    summary: cur ? draftSummary(cur.draft) : null,
  });
}

async function handleSaveDraft(body, res, ctx) {
  // 無 sessionId = 工作窗/煙測在沒有對話的情況下開始草稿:直接 mint 一個 product session
  //(同 open-project 的 mint 語意;之後 /api/chat 帶這個 sessionId 續用)。
  const session = body?.sessionId
    ? requireProductSession(body.sessionId, res, ctx)
    : getOrCreateSession(null, { user: ctx.user, mode: "product" });
  if (!session) return;
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session busy" });
    return;
  }
  const name = sanitizeName(body?.name || session.lastName || "product");
  if (body?.discard === true) {
    discardDraft(session, name);
    sendJson(res, 200, { ok: true, sessionId: session.sessionId, name, draft: null, revision: null });
    return;
  }
  const r = saveDraft(session, name, {
    draft: body?.draft,
    patch: body?.patch,
    baseRevision: body?.baseRevision ?? null,
    source: "user",
  });
  if (!r.ok && r.conflict) {
    sendJson(res, 409, { ok: false, error: "revision_conflict", revision: r.revision, draft: r.draft });
    return;
  }
  if (!r.ok) {
    sendJson(res, 400, { ok: false, error: "invalid_draft", errors: r.errors });
    return;
  }
  session.lastName = name;
  persistSession(session);
  sendJson(res, 200, { ok: true, sessionId: session.sessionId, name, draft: r.draft, revision: r.revision, summary: draftSummary(r.draft) });
}

async function handleBuild(body, res, ctx) {
  const session = requireProductSession(body?.sessionId, res, ctx);
  if (!session) return;
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session busy" });
    return;
  }
  const name = sanitizeName(body?.name || session.lastName || "product");
  const busyToken = acquireBusy(session);
  const abort = new AbortController();
  session.currentAbort = abort;
  const events = [];
  const emit = (ev, data) => events.push([ev, data]);
  try {
    const r = await buildFromDraft(session, name, emit, { signal: abort.signal });
    if (!r.ok) {
      sendJson(res, r.errors ? 400 : 200, {
        ok: false,
        sessionId: session.sessionId,
        name,
        error: r.error || "草稿不完整",
        errors: r.errors || null,
        rolledBack: !!r.rolledBack,
        validate: events.find(([e]) => e === "validate")?.[1] || null,
      });
      return;
    }
    const version = events.find(([e]) => e === "version")?.[1] || null;
    const present = events.find(([e]) => e === "present")?.[1] || null;
    const validate = events.find(([e]) => e === "validate")?.[1] || null;
    const warnings = events.filter(([e]) => e === "error").map(([, d]) => d?.message).filter(Boolean);
    sendJson(res, 200, {
      ok: true,
      sessionId: session.sessionId,
      name,
      version,
      present,
      validate,
      params: paramDefsFromGenerator(session, name),
      summary: r.summary,
      notes: r.notes,
      warnings,
    });
  } finally {
    if (session.currentAbort === abort) session.currentAbort = null;
    releaseBusy(session, busyToken);
    persistSession(session);
  }
}

export function surfaceMiddleware() {
  return async function surface(req, res, next) {
    const url = parseUrl(req);
    const p = url.pathname;
    if (p !== "/api/surface-draft" && p !== "/api/surface-build") return next();
    const ctx = { user: req.cadchat?.user };
    if (p === "/api/surface-draft" && req.method === "GET") {
      await handleGetDraft(url, res, ctx);
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "bad body" });
      return;
    }
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { ok: false, error: "bad body" });
      return;
    }
    if (p === "/api/surface-draft") await handleSaveDraft(body, res, ctx);
    else await handleBuild(body, res, ctx);
  };
}
