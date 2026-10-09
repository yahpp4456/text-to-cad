// DEMO 進場介紹影片(設計模式 30 秒):GET /api/demo-intro.mp4。
// 檔案在 docs/demo/cad-chat-design-mode.mp4,是 git LFS 物件——部署機若沒 `git lfs pull`
// 只會有 133 bytes 的 pointer 文字檔,所以 introVideoStatus 用大小門檻判「真的在」,
// /api/health 據此回 introVideo 旗,前端沒旗就不問要不要看(不會出現壞掉的播放器)。
// 支援 Range(206):<video> 拖進度條/Safari 首次請求都靠它;整檔讀進記憶體的 static.mjs
// 不適合 11MB 影片,這裡走 stream。對 demo 與團隊身分都開放(demoGuard 不擋 /api/demo-intro)。
import fs from "node:fs";
import path from "node:path";

import { APP_ROOT } from "./config.mjs";
import { parseUrl, sendText } from "./httpUtil.mjs";

export const INTRO_VIDEO_PATH = "/api/demo-intro.mp4";
export const INTRO_VIDEO_FILE = path.join(APP_ROOT, "docs", "demo", "cad-chat-design-mode.mp4");
// LFS pointer 約 130 bytes;任何真影片都遠大於 4KB。
const MIN_REAL_BYTES = 4096;

export function introVideoStatus(file = INTRO_VIDEO_FILE) {
  try {
    const st = fs.statSync(file);
    const available = st.isFile() && st.size >= MIN_REAL_BYTES;
    return { available, size: st.size };
  } catch {
    return { available: false, size: 0 };
  }
}

// 解析 Range 標頭(只處理單一區段;多區段視為整檔)。
// 回 null = 無/不處理 Range → 200 整檔;回 "invalid" → 416;否則 {start,end}(含)。
export function parseRange(header, size) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return "invalid";
  let start;
  let end;
  if (s === "") {
    const suffix = Number(e);
    if (!suffix) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

export function introVideoMiddleware({ file = INTRO_VIDEO_FILE } = {}) {
  return function introVideo(req, res, next) {
    if (parseUrl(req).pathname !== INTRO_VIDEO_PATH) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "method not allowed");
      return;
    }
    const st = introVideoStatus(file);
    if (!st.available) {
      sendText(res, 404, "intro video not available");
      return;
    }
    const range = parseRange(req.headers.range, st.size);
    const base = {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=3600",
    };
    if (range === "invalid") {
      res.writeHead(416, { ...base, "content-range": `bytes */${st.size}` });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : st.size - 1;
    const head = {
      ...base,
      "content-length": String(end - start + 1),
      ...(range ? { "content-range": `bytes ${start}-${end}/${st.size}` } : {}),
    };
    res.writeHead(range ? 206 : 200, head);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => {
      if (!res.headersSent) sendText(res, 500, "read error");
      else res.destroy();
    });
    req.on("close", () => stream.destroy());
    stream.pipe(res);
  };
}
