// 小型 node:http 工具。
export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

// 讀取並解析 JSON request body(上限 1MB)。
// 要求 content-type 為 application/json:跨站 text/plain「簡單請求」不經 CORS preflight,
// 沒這道檢查任意網頁都能 POST 本機 API 觸發 agent。
export function readJsonBody(req, { limit = 1_000_000 } = {}) {
  const ctype = String(req.headers["content-type"] || "");
  if (!ctype.toLowerCase().includes("application/json")) {
    return Promise.reject(new Error("content-type must be application/json"));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// 讀取原始位元組 body(上傳用)。content-type 由呼叫端自驗——image/* 與
// application/octet-stream 都是非「簡單請求」content-type,跨站 POST 一樣要過
// CORS preflight,防護等級同 readJsonBody。
// 超限:立刻 reject(handler 回 413)但**不立刻 destroy**——client(fetch/urllib)
// 是先送完 body 才讀回應,馬上斷線它只會看到 connection reset 而非 413;改成
// 繼續排水丟棄(不進記憶體),到 2×limit 才硬斷線止血。
export function readRawBody(req, { limit = 4_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (over) {
        if (size > limit * 2) req.destroy();
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!over) reject(err);
    });
  });
}

// 解析 URL 的 pathname 與 query(以任意 host base)。
export function parseUrl(req) {
  return new URL(req.url, "http://localhost");
}
