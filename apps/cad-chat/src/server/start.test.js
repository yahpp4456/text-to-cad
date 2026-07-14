// startServer 工廠煙測(L1):port=0 臨時埠起 prod 模式(serve dist/),health 200,
// close 釋放埠。dev 模式(Vite)不在這測——由 npm run dev + L3 煙測覆蓋。
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { startServer } from "./start.mjs";

// undici 的 fetch 禁改 Host header(靜默忽略)——壞 Host 要用 node:http 原生打。
function rawGet(port, hostHeader, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathName, headers: { host: hostHeader } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("startServer:port=0 → 回實際埠;/api/health 200;壞 Host 403;close 後拒連", async () => {
  const { port, url, close } = await startServer({ dev: false, port: 0 });
  try {
    assert.ok(Number.isInteger(port) && port > 0);
    assert.equal(url, `http://127.0.0.1:${port}/`);
    const res = await fetch(`${url}api/health`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.ok(["oauth", "apikey", "missing"].includes(j.authMode));
    // Host 白名單:非本機 Host 403(DNS-rebinding 防線在工廠重構後仍在)
    assert.equal(await rawGet(port, "evil.tld", "/api/health"), 403);
  } finally {
    await close();
  }
  await assert.rejects(fetch(`${url}api/health`)); // 埠已釋放
});
