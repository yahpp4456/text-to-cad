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
    const session = getSession(body.sessionId);
    if (session) {
      try {
        await session._query?.interrupt?.();
      } catch {
        /* ignore */
      }
      session.currentAbort?.abort();
      for (const child of session.childProcs) killTree(child);
      session.busy = false;
    }
    res.writeHead(204);
    res.end();
  };
}
