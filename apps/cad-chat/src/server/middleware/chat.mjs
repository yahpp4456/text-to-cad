// POST /api/chat — 起/續一個 agent turn,以 SSE 串流回前端。
// body: { message?, sessionId?, pickRef?, params? }
import { resolveAuth } from "../config.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { getOrCreateSession } from "../sessions.mjs";
import { openSse } from "../sse.mjs";
import { runTurn } from "../agent/runner.mjs";
import {
  decorateChecks,
  emitPresent,
  rewriteParams,
  runStep,
  runValidate,
} from "../cad/pipeline.mjs";

export function chatMiddleware() {
  return async function chat(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname !== "/api/chat") return next();
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const auth = resolveAuth();
    if (!auth.agentReady) {
      sendJson(res, 503, { error: "agent_not_ready", warnings: auth.warnings });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "bad body" });
      return;
    }

    const session = getOrCreateSession(body.sessionId);
    if (session.busy) {
      sendJson(res, 409, { error: "session busy" });
      return;
    }
    session.busy = true;

    const sse = openSse(res);
    const emit = (event, data) => sse.emit(event, data);
    session.emit = emit;
    emit("session", { sessionId: session.sessionId, sdkSessionId: session.sdkSessionId });
    sse.onClose(() => session.currentAbort?.abort());

    try {
      const paramsOnly =
        body.params &&
        Object.keys(body.params).length > 0 &&
        (!body.message || !String(body.message).trim());

      if (paramsOnly && session.lastName) {
        // 掛 abort controller:瀏覽器斷線 / interrupt 時要能殺掉重生的 Python 子程序。
        const abort = new AbortController();
        session.currentAbort = abort;
        try {
          await deterministicRegen(session, body.params, emit, abort.signal);
        } finally {
          session.currentAbort = null;
        }
        sse.end({ ok: true, version: session.version });
      } else {
        const { ok } = await runTurn({ session, emit, message: buildUserText(body, session) });
        sse.end({ ok, version: session.version });
      }
    } catch (err) {
      emit("error", { message: String(err?.message || err) });
      sse.end({ ok: false });
    } finally {
      session.busy = false;
      session.emit = null;
    }
  };
}

export function buildUserText(body, session) {
  let t = String(body.message || "").trim();
  // 多選幾何參考(pickRefs[]);舊單選字串 pickRef 保留相容
  const refs = Array.isArray(body.pickRefs)
    ? body.pickRefs
        .slice(0, 6)
        .map((r) => ({
          token: String(r?.token || "").slice(0, 120),
          label: String(r?.label || "").slice(0, 120),
        }))
        .filter((r) => r.token)
    : [];
  const fmt = (r) => `${r.token}${r.label && r.label !== r.token ? `「${r.label}」` : ""}`;
  if (refs.length > 1) {
    const list = refs.map((r, i) => `  ${i + 1}. ${fmt(r)}`).join("\n");
    const src = session?.lastName ? `,來自 ${session.lastName}.step` : "";
    t = `（已帶入 ${refs.length} 個幾何參考${src}:\n${list}\n可用 cad_measure / cad_align 對這些參考取決定性距離與對齊平移。）\n${t}`;
  } else if (refs.length === 1) {
    t = `（已帶入幾何參考 ${fmt(refs[0])}）\n${t}`;
  } else if (body.pickRef) {
    t = `（已帶入幾何參考 ${body.pickRef}）\n${t}`;
  }
  if (body.params && Object.keys(body.params).length) {
    t += `\n（使用者把參數調整為 ${JSON.stringify(body.params)},請據此重生新版本。）`;
  }
  // rehydrate 後首個 turn 的一次性接續提示(open-project 設定;取用即清)
  if (session?._rehydrateNote) {
    t = `${session._rehydrateNote}\n${t}`;
    session._rehydrateNote = null;
  }
  return t || "（空訊息）";
}

// 參數即時重生:改 PARAMS → step → validate → present,免 LLM round-trip。
async function deterministicRegen(session, params, emit, signal) {
  const name = session.lastName;
  const id = `tool_${Date.now().toString(36)}`;
  session._valAttempt = 0;

  const rw = rewriteParams(session, name, params);
  if (!rw.ok) {
    emit("error", { message: rw.error });
    return;
  }

  emit("stage", { index: 2 });
  emit("tool", {
    id,
    name: `cad.build(${name}.py)`,
    label: "參數重生 → 執行",
    status: "running",
    code: `# PARAMS → ${JSON.stringify(params)}`,
  });
  const step = await runStep(session, name, { signal });
  if (!step.ok) {
    emit("tool", { id, status: "error", note: (step.stderr || "").slice(-300) });
    emit("error", { message: "參數重生失敗" });
    return;
  }
  emit("tool", {
    id,
    status: "done",
    ms: step.ms,
    outputs: [
      { path: `${name}.step`, kind: "step" },
      { path: `.${name}.step.glb`, kind: "glb" },
    ],
  });

  emit("stage", { index: 3 });
  const val = await runValidate(session, name, { signal });
  if (val.partCount > 0) session.lastPartCount = val.partCount;
  const dec = decorateChecks(val.checks);
  emit("validate", {
    ok: val.ok,
    attempt: 1,
    ms: val.ms,
    partCount: val.partCount,
    checks: dec.map((c) => ({
      label: c.label,
      icon: c.icon,
      color: c.color,
      note: c.noteText,
      skipped: !!c.skipped,
    })),
  });
  // MOTION 的 travel 引用 PARAMS,重生後重新 import 的新值在這裡帶回(播放自動跟上)
  emit("motion", { name, schemaVersion: 1, dofs: val.motion?.dofs || [] });

  emit("stage", { index: 4 });
  emitPresent(session, name, emit);
}
