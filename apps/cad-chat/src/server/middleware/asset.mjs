// GET /api/asset?file=<models 內相對路徑> — 串流 models/ 下的產物給 cadjs。
// 後端產圖後知道確切 GLB 路徑(由 present 事件送給前端),故不需 viewer 的 catalog 探索。
import fs from "node:fs";
import path from "node:path";

import { MODELS_ROOT } from "../config.mjs";
import { parseUrl, sendText } from "../httpUtil.mjs";
import { pathIsInside } from "../cad/paths.mjs";

const CONTENT_TYPES = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".step": "application/step",
  ".stp": "application/step",
  ".stl": "model/stl",
  ".3mf": "model/3mf",
  ".dxf": "image/vnd.dxf",
  ".png": "image/png",
  ".gif": "image/gif",
  ".json": "application/json",
  ".js": "text/javascript",
};

export function assetMiddleware() {
  return function asset(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname !== "/api/asset") return next();

    const fileParam = url.searchParams.get("file") || "";
    if (!fileParam) {
      sendText(res, 400, "missing file");
      return;
    }
    // file 是相對 REPO_ROOT 的 models 路徑(如 models/.cadchat/<id>/.part.step.glb),
    // 或相對 models/ 的路徑。兩者都解析到 MODELS_ROOT 內。
    const normalized = fileParam.replace(/^models[\\/]/, "");
    const resolved = path.resolve(MODELS_ROOT, normalized);
    if (!pathIsInside(resolved, MODELS_ROOT)) {
      sendText(res, 403, "forbidden");
      return;
    }
    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        sendText(res, 404, "not found");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
        "content-length": stat.size,
        "cache-control": "no-store",
      });
      const stream = fs.createReadStream(resolved);
      stream.on("error", () => {
        if (!res.headersSent) sendText(res, 500, "read error");
        else res.destroy();
      });
      stream.pipe(res);
    });
  };
}
