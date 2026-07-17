// POST /api/upload-image?sessionId=<id?>&name=<原始檔名?> — 圖片位元組直傳(非 JSON、
// 非 multipart),落 session workdir 的 uploads/,回 /api/asset 可取的 URL。
// POST /api/upload-step — 同款契約收 STEP(零件庫模式的收庫來源;25MB、
// magic 檔頭 ISO-10303-21)。
// 選檔即上傳:/api/chat 之後只帶輕量 imageRefs/stepRefs(rel),佇列/409 重試不重傳位元組。
// 無 sessionId 就順手建 session 回給前端採用(同 /api/import 模式)。
import fs from "node:fs";
import path from "node:path";

import { BASE_PATH } from "../config.mjs";
import { parseUrl, readRawBody, sendJson } from "../httpUtil.mjs";
import { getOrCreateSession } from "../sessions.mjs";
import { MAX_IMAGE_BYTES, sniffImageType } from "../images.mjs";
import { MAX_STEP_BYTES, sniffStepFile } from "../stepFiles.mjs";

// 檔名:ts36 前綴防重名;原名 stem 清洗後保留可讀性(路徑分隔/.. 全被字元白名單擋掉)
function cleanStem(name, fallback) {
  return (
    String(name || fallback)
      .replace(/\.[^.]*$/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/\.+/g, ".")
      .slice(0, 48) || fallback
  );
}

function saveUpload(session, url, buf, { fallbackStem, ext }) {
  const dir = path.join(session.workdir, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const stem = cleanStem(url.searchParams.get("name"), fallbackStem);
  const fname = `${Date.now().toString(36)}_${stem}.${ext}`;
  fs.writeFileSync(path.join(dir, fname), buf);
  const rel = `uploads/${fname}`;
  return {
    rel,
    url: `${BASE_PATH}/api/asset?file=${encodeURIComponent(`${session.workdirRel}/${rel}`)}`,
  };
}

export function uploadMiddleware() {
  return async function upload(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname === "/api/upload-step") {
      await handleUploadStep(req, res, url);
      return;
    }
    if (url.pathname !== "/api/upload-image") return next();
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    // image/* 與 octet-stream 都是非簡單請求 content-type → 跨站必過 CORS preflight,
    // 防護等級同 readJsonBody 的 application/json 檢查。
    const ctype = String(req.headers["content-type"] || "").toLowerCase();
    if (!ctype.startsWith("image/") && !ctype.startsWith("application/octet-stream")) {
      sendJson(res, 415, { ok: false, error: "content-type 須為 image/*" });
      return;
    }
    let buf;
    try {
      buf = await readRawBody(req, { limit: MAX_IMAGE_BYTES });
    } catch (err) {
      const large = String(err?.message || "").includes("too large");
      sendJson(res, large ? 413 : 400, {
        ok: false,
        error: large ? "圖片過大(上限 3.5MB;建議先裁切到需要的區域)" : "讀取失敗",
      });
      return;
    }
    // magic bytes 是 media_type / 副檔名的唯一真相(不信 client content-type 與原檔名)
    const sniffed = sniffImageType(buf);
    if (!sniffed) {
      sendJson(res, 415, { ok: false, error: "不支援的圖片格式(png / jpeg / webp / gif)" });
      return;
    }
    const session = getOrCreateSession(url.searchParams.get("sessionId"), { user: req.cadchat?.user });
    const saved = saveUpload(session, url, buf, { fallbackStem: "image", ext: sniffed.ext });
    sendJson(res, 200, {
      ok: true,
      sessionId: session.sessionId,
      rel: saved.rel,
      url: saved.url,
      bytes: buf.length,
      mediaType: sniffed.mediaType,
    });
  };
}

// STEP 位元組直傳(零件庫模式):契約鏡射 upload-image——content-type 限
// octet-stream(非簡單請求,跨站必過 CORS preflight)、readRawBody 排水語意
// (超限 reject 後仍吞到 2×limit 才斷,client 才拿得到 413 而非 connection reset)、
// magic 檔頭是唯一真相(不信 client content-type 與原檔名)。
async function handleUploadStep(req, res, url) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  const ctype = String(req.headers["content-type"] || "").toLowerCase();
  if (!ctype.startsWith("application/octet-stream")) {
    sendJson(res, 415, { ok: false, error: "content-type 須為 application/octet-stream" });
    return;
  }
  let buf;
  try {
    buf = await readRawBody(req, { limit: MAX_STEP_BYTES });
  } catch (err) {
    const large = String(err?.message || "").includes("too large");
    sendJson(res, large ? 413 : 400, {
      ok: false,
      error: large ? "STEP 檔過大(上限 25MB)" : "讀取失敗",
    });
    return;
  }
  const sniffed = sniffStepFile(buf);
  if (!sniffed) {
    sendJson(res, 415, { ok: false, error: "不支援的檔案格式(STEP,檔頭須為 ISO-10303-21)" });
    return;
  }
  const session = getOrCreateSession(url.searchParams.get("sessionId"), { user: req.cadchat?.user });
  const saved = saveUpload(session, url, buf, { fallbackStem: "part", ext: sniffed.ext });
  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    rel: saved.rel,
    url: saved.url,
    bytes: buf.length,
  });
}
