// SSE client:POST /api/chat,解析事件框架 → dispatch;interrupt 中斷。
// 併發紀律:server 一個 session 同時只服務一個 turn(否則 409 session busy)。
// send 在前一回合還沒收完時再被呼叫 → 入佇列,回合結束後依序自動送出——
// 所以 clarify 選項在 AI 還沒講完就點、或打字搶送,都不會報錯也不會打斷串流中的氣泡。
import { useCallback, useRef } from "react";

import { handleEvent } from "../state/events.js";
import { apiUrl } from "@/lib/apiBase";

// modeRef(可選):App 端的 { current: "design"|"sketch" }——每次 POST 帶上當前
// 模式(per-session 恆定;新 session 據此 mint,既有 session 相符通過/不符 400)。
export function useChatStream(dispatch, modeRef) {
  const ctrlRef = useRef(null);
  const sessionIdRef = useRef(null);
  const busyRef = useRef(false); // 本地 in-flight 旗標(state.running 的同步鏡像,免等 render)
  const queueRef = useRef([]);
  const sendRef = useRef(null); // 佇列 flush 要在 send 內部呼叫自己 → 走 ref 繞過宣告順序
  // 409 busy 延遲重送的計時器集合。必須是 Set 不能單槽:兩則訊息各撞 409 會各排一顆
  // timer,單槽覆寫會遺失把手 → interrupt/新對話只殺得到最後一顆,孤兒 timer 最長
  // 10 秒後照樣開火重送(新對話後 sessionIdRef 已空,還會 mint 全新 session 燒真回合)。
  const retryTimersRef = useRef(new Set());

  const clearPendingSends = useCallback(() => {
    queueRef.current = [];
    for (const t of retryTimersRef.current) clearTimeout(t);
    retryTimersRef.current.clear();
  }, []);

  const send = useCallback(
    async (payload = {}) => {
      // 有 pending 的 busy 重試 timer 也要排隊:延遲窗內 busyRef=false,直接送會
      // 讓晚送的新訊息跑在早排隊的重試前面(訊息重排)。
      if (busyRef.current || retryTimersRef.current.size > 0) {
        queueRef.current.push(payload);
        dispatch({ type: "SET_LIVE", live: { text: "已收到,待本回合結束自動送出…" } });
        return;
      }
      busyRef.current = true;
      const { text = "", pickRefs = [], params = null, imageRefs = null, canvas = null } = payload;
      const sentWith = sessionIdRef.current; // 本次 POST 所用的 session(回聲採納守衛用)
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      dispatch({ type: "START_RUN" });
      try {
        const res = await fetch(apiUrl("/api/chat"), {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: sessionIdRef.current,
            mode: modeRef?.current || undefined,
            pickRefs: pickRefs?.length
              ? pickRefs.map((r) => ({
                  token: String(r.token || "").slice(0, 120),
                  label: String(r.label || "").slice(0, 120),
                }))
              : undefined,
            params: params || undefined,
            // 已上傳圖片的輕量參照(uploads/xxx.png);位元組在 server workdir,
            // 佇列/409 重試原封重送這個 payload 也只是重送 rel 字串(冪等)。
            imageRefs: imageRefs?.length ? imageRefs : undefined,
            // 當前畫布身分(name/file/source/projectDir):server 據此讓 agent 知道
            // 使用者正在看什麼(唯讀檢視否則零語境)。佇列重試原封重送冪等。
            canvas: canvas || undefined,
          }),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          // 防禦性後備:佇列已擋住本頁的並發,真撞上 busy(另一分頁占用、interrupt
          // 收尾、**精算/匯出閘持鎖最長 ~2-3 分鐘**)就排回佇列頭,由 finally 的
          // flush 依 _retries 延遲重送(見下);退避封頂 30s、連撞 8 次(總窗 ~2.5
          // 分鐘,涵蓋閘的 busy 視窗)才視為真的卡住,轉為錯誤顯示。
          if (j.error === "session busy" && (payload._retries || 0) < 8) {
            queueRef.current.unshift({ ...payload, _retries: (payload._retries || 0) + 1 });
            return; // 「稍候自動重送」提示由 finally 排程時 dispatch(END_RUN 會清 live,先發必被蓋掉)
          }
          const msg =
            j.error === "agent_not_ready"
              ? j.warnings?.[0] || "agent 尚未就緒(請設定訂閱 token)。"
              : j.error === "session busy"
                ? "session 忙碌中(可能被另一個分頁占用),請稍候再試。"
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
            parseFrame(buf.slice(0, idx), dispatch, sessionIdRef, sentWith);
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
        busyRef.current = false;
        // 回合真正結束(server 端 busy 已同步釋放)才 flush 佇列,串行送出。
        // busy 重試(_retries)必須延遲:server 端的 busy 可能要幾秒到幾分鐘才放
        // (interrupt 收尾、另一分頁的回合、精算/匯出閘),同步重送只會在毫秒內把
        // 重試瞬間燒完,「稍候自動重送」變成立刻報錯丟訊息。
        const next = queueRef.current.shift();
        if (next) {
          const delay = next._retries ? Math.min(2000 * 2 ** (next._retries - 1), 30_000) : 0;
          if (delay > 0) {
            dispatch({ type: "SET_LIVE", live: { text: "上一回合還在收尾,稍候自動重送…" } });
            const t = setTimeout(() => {
              retryTimersRef.current.delete(t); // 先摘牌再送:send 的排隊條件讀這個 Set
              sendRef.current?.(next);
            }, delay);
            retryTimersRef.current.add(t);
          } else {
            sendRef.current?.(next);
          }
        }
      }
    },
    [dispatch, modeRef],
  );
  sendRef.current = send;

  const interrupt = useCallback(() => {
    clearPendingSends(); // 使用者要停 → 排隊中的訊息與排程中的 busy 重送一併作廢
    ctrlRef.current?.abort();
    fetch(apiUrl("/api/interrupt"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionIdRef.current }),
    }).catch(() => {});
  }, [clearPendingSends]);

  // 由非 SSE 路徑取得 sessionId 時採用(如 /api/import、/api/open-project 回應)。
  // 換到「不同的」session(如開專案)時,針對舊 session 的排隊訊息/重試 timer 一併
  // 作廢——send 是開火時才讀 sessionIdRef,不清會把舊訊息打進新 session。
  const setSessionId = useCallback(
    (id) => {
      if (!id) return;
      if (sessionIdRef.current && id !== sessionIdRef.current) clearPendingSends();
      sessionIdRef.current = id;
    },
    [clearPendingSends],
  );

  // 「新對話」:斷開現有 session,下一則訊息會開全新 session。
  const resetSession = useCallback(() => {
    clearPendingSends();
    ctrlRef.current?.abort();
    sessionIdRef.current = null;
  }, [clearPendingSends]);

  return { send, interrupt, setSessionId, resetSession };
}

function parseFrame(frame, dispatch, sessionIdRef, sentWith) {
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
  // session 回聲只在 ref 仍是本次 POST 所用的 id 時採納:turn 進行中若被
  // open-project 換到新 session(setSessionId),舊 turn 的回聲不得把 ref 蓋回舊 id
  // (否則之後的訊息會打進舊 session,UI 卻顯示新專案)。
  if (event === "session" && data.sessionId && sessionIdRef.current === sentWith) {
    sessionIdRef.current = data.sessionId;
  }
  handleEvent(dispatch, event, data);
}
