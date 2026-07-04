// SSE client:POST /api/chat,解析事件框架 → dispatch;interrupt 中斷。
import { useCallback, useRef } from "react";

import { handleEvent } from "../state/events.js";

export function useChatStream(dispatch) {
  const ctrlRef = useRef(null);
  const sessionIdRef = useRef(null);

  const send = useCallback(
    async ({ text = "", pickRefs = [], params = null } = {}) => {
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      dispatch({ type: "START_RUN" });
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: sessionIdRef.current,
            pickRefs: pickRefs?.length
              ? pickRefs.map((r) => ({
                  token: String(r.token || "").slice(0, 120),
                  label: String(r.label || "").slice(0, 120),
                }))
              : undefined,
            params: params || undefined,
          }),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          const msg =
            j.error === "agent_not_ready"
              ? j.warnings?.[0] || "agent 尚未就緒(請設定訂閱 token)。"
              : `伺服器錯誤 HTTP ${res.status}`;
          handleEvent(dispatch, "error", { message: msg });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            parseFrame(buf.slice(0, idx), dispatch, sessionIdRef);
            buf = buf.slice(idx + 2);
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          handleEvent(dispatch, "error", { message: String(err?.message || err) });
        }
      } finally {
        dispatch({ type: "END_RUN" });
        ctrlRef.current = null;
      }
    },
    [dispatch],
  );

  const interrupt = useCallback(() => {
    ctrlRef.current?.abort();
    fetch("/api/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionIdRef.current }),
    }).catch(() => {});
  }, []);

  // 由非 SSE 路徑取得 sessionId 時採用(如 /api/import、/api/open-project 回應)。
  const setSessionId = useCallback((id) => {
    if (id) sessionIdRef.current = id;
  }, []);

  return { send, interrupt, setSessionId };
}

function parseFrame(frame, dispatch, sessionIdRef) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return;
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  if (event === "session" && data.sessionId) sessionIdRef.current = data.sessionId;
  handleEvent(dispatch, event, data);
}
