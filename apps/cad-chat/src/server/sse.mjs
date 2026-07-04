// Server-Sent Events helper(over node:http)。
export function openSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // 關閉反向代理 / 壓縮層的緩衝,確保事件即時送達。
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15000);

  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };
  res.on("close", onClose);

  return {
    /** 送一個具名事件。 */
    emit(event, data) {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
    },
    /** 收尾並結束 response。 */
    end(data) {
      if (closed) return;
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
      onClose();
      res.end();
    },
    get closed() {
      return closed;
    },
    onClose(fn) {
      res.on("close", fn);
    },
  };
}
