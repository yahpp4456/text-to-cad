#!/usr/bin/env node
// 本機單一埠伺服器:node:http middleware 鏈擁有 /api/*,dev 委派 Vite middlewareMode,
// prod serve dist/。仿 viewer/src/server/server.mjs 的 runMiddleware 遞迴。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  APP_ROOT,
  DIST_ROOT,
  HOST,
  loadDotEnvLocal,
  resolveAuth,
  resolveGcDays,
  resolveModel,
  resolvePort,
} from "./config.mjs";
import { sendText } from "./httpUtil.mjs";
import { gcSessions } from "./sessions.mjs";
import { healthMiddleware } from "./middleware/health.mjs";
import { assetMiddleware } from "./middleware/asset.mjs";
import { filesMiddleware } from "./middleware/files.mjs";
import { projectMiddleware } from "./middleware/project.mjs";
import { chatMiddleware } from "./middleware/chat.mjs";
import { interruptMiddleware } from "./middleware/interrupt.mjs";
import { lessonsMiddleware } from "./middleware/lessons.mjs";
import { uploadMiddleware } from "./middleware/upload.mjs";

loadDotEnvLocal();

const isDev = process.argv.includes("--dev");
const port = resolvePort();
const gcDays = resolveGcDays();
const gcRemoved = gcSessions({ maxAgeDays: gcDays });

const middlewares = [
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
if (isDev) {
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
function hostAllowed(req) {
  const host = String(req.headers.host || "");
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
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

const server = http.createServer((req, res) => runMiddleware(0, req, res));
server.listen(port, HOST, () => {
  const auth = resolveAuth();
  const base = `http://${HOST}:${port}/`;
  console.log(`對話式 CAD 伺服器啟動於 ${base}  (${isDev ? "dev" : "serve"})`);
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
});
