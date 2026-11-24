// worker frame 協定(Node 端):一行 JSON 物件,物件帶 `bytes` 時其後緊接恰好那麼多個
// 位元組。Python 端對應實作在 apps/cad-chat/py/cadchat_ext/worker/frames.py,兩邊格式
// 必須一致。協定設計取自 earthtojake/text-to-cad 的 engine/frames.py(MIT)。

const EMPTY = Buffer.alloc(0);
const NEWLINE = 0x0a;

// 把一個 frame 編成可直接寫進串流的 Buffer。
export function encodeFrame(message, payload) {
  const hasPayload = payload != null && payload.length > 0;
  const body = hasPayload ? { ...message, bytes: payload.length } : message;
  const line = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  return hasPayload ? Buffer.concat([line, payload]) : line;
}

// 串流解碼器:push(chunk) 餵任意切法的位元組,湊齊一個 frame 就呼叫 onFrame(message, payload)。
// frame 之前不以 `{` 開頭的行(子行程印的 banner)直接略過;以 `{` 開頭卻不是 JSON 的行
// 交給 onError(error, 原文) 後略過,不中斷後續 frame。
export function createFrameDecoder(onFrame, onError) {
  let buffer = EMPTY;
  let pending = null; // { message, need }:已讀到標頭行,還在等 payload

  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (pending) {
          if (buffer.length < pending.need) return;
          const payload = Buffer.from(buffer.subarray(0, pending.need));
          buffer = buffer.subarray(pending.need);
          const { message } = pending;
          pending = null;
          onFrame(message, payload);
          continue;
        }
        const end = buffer.indexOf(NEWLINE);
        if (end === -1) return;
        const text = buffer.subarray(0, end).toString("utf8").trim();
        buffer = buffer.subarray(end + 1);
        if (!text.startsWith("{")) continue;
        let message;
        try {
          message = JSON.parse(text);
        } catch (err) {
          onError?.(err, text);
          continue;
        }
        const need = Number(message.bytes) || 0;
        if (need > 0) pending = { message, need };
        else onFrame(message, EMPTY);
      }
    },
    // 尚未湊成 frame 的位元組數(行程結束時用來判斷是否斷在 frame 中途)。
    get buffered() {
      return buffer.length + (pending ? 1 : 0);
    },
  };
}
