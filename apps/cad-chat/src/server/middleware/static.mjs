// 正式模式:serve dist/(SPA,未命中檔案則回 index.html)。
import fs from "node:fs";
import path from "node:path";

import { parseUrl, sendText } from "../httpUtil.mjs";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
};

export function staticDistMiddleware(distRoot) {
  const indexHtml = path.join(distRoot, "index.html");
  return function serveDist(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const url = parseUrl(req);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = rel ? path.join(distRoot, rel) : indexHtml;
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(path.resolve(distRoot))) {
      sendText(res, 403, "forbidden");
      return;
    }
    fs.stat(resolved, (err, stat) => {
      const target = err || !stat.isFile() ? indexHtml : resolved;
      fs.readFile(target, (readErr, buf) => {
        if (readErr) {
          sendText(res, 404, "not found");
          return;
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
        });
        res.end(buf);
      });
    });
  };
}
