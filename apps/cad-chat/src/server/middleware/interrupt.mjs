// POST /api/interrupt — 中斷某 session 進行中的 turn 並殺其 Python 子程序。
import { killTree } from "../cad/python.mjs";
import { parseUrl, readJsonBody } from "../httpUtil.mjs";
import { getSession } from "../sessions.mjs";

export function interruptMiddleware() {
  return async function interrupt(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname !== "/api/interrupt") return next();
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      /* ignore */
    }
    if (!body || typeof body !== "object") body = {}; // JSON "null"/純量 → 當空 body
    const session = getSession(body.sessionId, req.cadchat?.user);
    if (session) {
      try {
        await session._query?.interrupt?.();
      } catch {
        /* ignore */
      }
      session.currentAbort?.abort();
      for (const child of session.childProcs) killTree(child);
      // 提早放行 busy 讓使用者能立刻送下一則;token 一併清空 = 宣告舊 turn 失去
      // 鎖的持有權,它的 finally(releaseBusy)會因 token 不符而不動新 turn 的鎖。
      // emit 也在此清:失權的舊 turn 不會清(見 chat.mjs finally),不清就永久
      // 滯留已死 SSE 的 closure。
      session.busy = false;
      session._busyToken = null;
      session.emit = null;
    }
    res.writeHead(204);
    res.end();
  };
}
