// server 工廠:把原 server.mjs 的頂層副作用(env 載入/session GC/middleware 鏈/
// Vite middlewareMode/listen)收進 startServer(),讓 CLI(server.mjs)與 Electron
// (entry.child.mjs 被 utilityProcess.fork)共用同一份組裝。
// port=0 → OS 配置臨時埠(Electron 殼免「先挑埠再綁」的競態);回傳實際埠。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  APP_ROOT,
  DIST_ROOT,
  HOST,
  loadBakedEnv,
  loadDotEnvLocal,
  resolveAuth,
  resolveGcDays,
  resolveModel,
  resolvePort,
} from "./config.mjs";
import { sendText } from "./httpUtil.mjs";
import { gcAllSessions } from "./sessions.mjs";
import { userContextMiddleware } from "./middleware/userContext.mjs";
import { demoGuardMiddleware } from "./middleware/demoGuard.mjs";
import { healthMiddleware } from "./middleware/health.mjs";
import { assetMiddleware } from "./middleware/asset.mjs";
import { filesMiddleware } from "./middleware/files.mjs";
import { projectMiddleware } from "./middleware/project.mjs";
import { chatMiddleware } from "./middleware/chat.mjs";
import { interruptMiddleware } from "./middleware/interrupt.mjs";
import { lessonsMiddleware } from "./middleware/lessons.mjs";
import { uploadMiddleware } from "./middleware/upload.mjs";

// dev:Vite middleware 之後,把 index.html 經 transformIndexHtml 回給所有 GET。
function devHtmlMiddleware(viteServer) {
  const indexPath = path.join(APP_ROOT, "index.html");
  return async function devHtml(req, res, next) {
    if (req.method !== "GET") return next();
    try {
      const raw = fs.readFileSync(indexPath, "utf8");
      const html = await viteServer.transformIndexHtml(req.url, raw);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      viteServer.ssrFixStacktrace?.(err);
      next();
    }
  };
}

export async function startServer({ dev = false, port } = {}) {
  loadDotEnvLocal();
  loadBakedEnv(); // 打包注入的預設(fallback-only:上行已載入任何認證則整檔不生效)

  const wantPort = Number.isFinite(port) ? port : resolvePort();
  const gcDays = resolveGcDays();
  const gcRemoved = gcAllSessions({ maxAgeDays: gcDays });

  const middlewares = [
    userContextMiddleware(), // 首位:所有 API 依賴 req.cadchat(user 資料根)
    demoGuardMiddleware(), // 緊接身分之後:demo 帳號的端點底線(health 不在擋單)
    healthMiddleware(),
    assetMiddleware(),
    filesMiddleware(),
    projectMiddleware(),
    uploadMiddleware(),
    chatMiddleware(),
    interruptMiddleware(),
    lessonsMiddleware(),
  ];

  let vite = null;
  if (dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: APP_ROOT,
      server: { middlewareMode: true },
      appType: "custom",
    });
    middlewares.push((req, res, next) => vite.middlewares(req, res, next));
    middlewares.push(devHtmlMiddleware(vite));
  } else {
    const { staticDistMiddleware } = await import("./middleware/static.mjs");
    middlewares.push(staticDistMiddleware(DIST_ROOT));
  }

  // 只服務本機 Host(防 DNS-rebinding:惡意網域解析到 127.0.0.1 繞過同源限制)。
  // 用 actualPort(listen 後回填):port=0 時真埠由 OS 決定。
  let actualPort = wantPort;
  function hostAllowed(req) {
    const host = String(req.headers.host || "");
    return host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`;
  }

  function runMiddleware(index, req, res) {
    if (index === 0 && !hostAllowed(req)) {
      sendText(res, 403, "forbidden host");
      return;
    }
    const mw = middlewares[index];
    if (!mw) {
      sendText(res, 404, "not found");
      return;
    }
    const fail = (err) => {
      process.stderr.write(`middleware error: ${err?.stack || err}\n`);
      if (!res.headersSent) sendText(res, 500, "internal error");
      else res.destroy();
    };
    try {
      // async middleware 的例外是 rejected promise,同步 try/catch 接不到——
      // 不接住會變 unhandledRejection 直接殺掉整個伺服器(Node 預設 throw 模式)。
      const out = mw(req, res, () => runMiddleware(index + 1, req, res));
      if (out && typeof out.catch === "function") out.catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  const server = http.createServer((req, res) => runMiddleware(0, req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(wantPort, HOST, resolve);
  });
  actualPort = server.address().port;
  const url = `http://${HOST}:${actualPort}/`;

  const auth = resolveAuth();
  console.log(`對話式 CAD 伺服器啟動於 ${url}  (${dev ? "dev" : "serve"})`);
  console.log(
    `認證:${
      auth.authMode === "apikey"
        ? "API key ✓(Commercial Terms 按量計費)"
        : auth.authMode === "oauth"
          ? "訂閱 OAuth ✓(限本人自用)"
          : "未設定 ✗(/api/health 有指引)"
    }`,
  );
  console.log(
    `模型:${resolveModel() || "(未設定 CADCHAT_MODEL — 用你 Claude Code CLI 的預設,會跟著 /model 變)"}`,
  );
  console.log(
    gcDays > 0
      ? `session GC:清掉 ${gcRemoved.length} 個超過 ${gcDays} 天的 session${
          gcRemoved.length ? `(${gcRemoved.slice(0, 4).join(", ")}${gcRemoved.length > 4 ? "…" : ""})` : ""
        }`
      : "session GC:已停用(CADCHAT_GC_DAYS=0)",
  );
  for (const w of auth.warnings) console.log(`  ⚠ ${w}`);

  return {
    port: actualPort,
    url,
    close: async () => {
      server.closeAllConnections?.(); // keep-alive 連線不斷,close 會等到天荒地老
      await new Promise((resolve) => server.close(resolve));
      if (vite) await vite.close();
    },
  };
}
