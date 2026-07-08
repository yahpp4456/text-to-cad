// /api/lessons* — 教訓系統 API:列表/摘要/手動蒸餾/單條精修/停用/刪除(教訓)/刪除單筆未蒸餾案例。
// POST 一律 readJsonBody(強制 application/json,擋跨站簡單請求);store 讀寫皆同步。
// store 寫入(writeStore)依契約會 throw(檔案被鎖/磁碟滿)——此處必 catch 回 500,
// 否則 async middleware 的 rejection 會殺掉整個伺服器(server.mjs 另有結構性接網)。
// opts.file:store 路徑注入(測試用;預設真路徑)。
import { lessonsEnabled, resolveAuth, resolveLessonThreshold } from "../config.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { scrubPaths } from "../cad/python.mjs";
import {
  buildDigest,
  deleteCase,
  deleteLesson,
  lessonsFile,
  pendingGroups,
  readStore,
  updateLessonStatus,
} from "../lessons.mjs";
import { maybeDistill, redistillLesson } from "../lessons.distill.mjs";

const lessonView = (l) => ({
  id: l.id,
  signature: l.signature,
  altSignatures: Array.isArray(l.altSignatures) ? l.altSignatures : [],
  status: l.status,
  title: l.title,
  rootCause: l.rootCause,
  rule: l.rule,
  caseCount: l.caseCount || 0,
  resolvedCount: l.resolvedCount || 0,
  graduationCandidate: !!l.graduationCandidate,
  createdAt: l.createdAt || null,
  lastHitAt: l.lastHitAt || null,
  distilledAt: l.distilledAt || null,
});

// 蒸餾結果 → HTTP 狀態(手動端點用;fire-and-forget 路徑不經此)。
function distillStatus(r) {
  if (r.ok) return 200;
  if (r.reason === "in_flight") return 409;
  if (r.reason === "agent_not_ready") return 503;
  if (r.reason === "not_found") return 404;
  return 200; // bad_output / no_cases / disabled 等:誠實回 ok:false,不是協定錯誤
}

export function lessonsMiddleware({ file = lessonsFile() } = {}) {
  return async function lessons(req, res, next) {
    const url = parseUrl(req);
    if (!url.pathname.startsWith("/api/lessons")) return next();

    // ── GET ──
    if (req.method === "GET" && url.pathname === "/api/lessons") {
      const store = readStore(file);
      sendJson(res, 200, {
        ok: true,
        enabled: lessonsEnabled(),
        agentReady: resolveAuth().agentReady,
        threshold: resolveLessonThreshold(),
        lessons: store.lessons.map(lessonView),
        pending: pendingGroups(store),
        stats: { totalCases: store.cases.length },
      });
      return;
    }
    // 與注入 prompt 完全相同的字串(L2/L4 廉價斷言點)。
    if (req.method === "GET" && url.pathname === "/api/lessons/digest") {
      sendJson(res, 200, { ok: true, digest: lessonsEnabled() ? buildDigest(readStore(file)) : "" });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // ── POST ──
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "bad body" });
      return;
    }
    // JSON.parse("null") / 純量也是合法 JSON:非物件 body 一律 400,
    // 別讓 body.id 的 TypeError 逃到 server.mjs 的結構性接網變 500。
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "bad body" });
      return;
    }

    if (url.pathname === "/api/lessons/distill") {
      const r = await maybeDistill({ force: true, file });
      sendJson(res, distillStatus(r), r);
      return;
    }
    if (url.pathname === "/api/lessons/redistill") {
      const id = String(body.id || "");
      const r = await redistillLesson(id, { file });
      sendJson(res, distillStatus(r), r);
      return;
    }
    if (url.pathname === "/api/lessons/update") {
      let r;
      try {
        r = updateLessonStatus(String(body.id || ""), String(body.status || ""), { file });
      } catch (err) {
        // fs 錯誤帶 lessons.json.tmp 絕對路徑 → 同其他回應錯誤一樣過 scrub
        sendJson(res, 500, { ok: false, error: "store_write_failed", detail: scrubPaths(String(err?.message || err)) });
        return;
      }
      if (!r.ok) {
        sendJson(res, r.error === "not_found" ? 404 : 400, r);
        return;
      }
      sendJson(res, 200, r);
      return;
    }
    if (url.pathname === "/api/lessons/delete") {
      let r;
      try {
        r = deleteLesson(String(body.id || ""), { file });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: "store_write_failed", detail: scrubPaths(String(err?.message || err)) });
        return;
      }
      sendJson(res, r.ok ? 200 : 404, r);
      return;
    }
    if (url.pathname === "/api/lessons/delete-case") {
      let r;
      try {
        r = deleteCase(String(body.id || ""), { file });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: "store_write_failed", detail: scrubPaths(String(err?.message || err)) });
        return;
      }
      sendJson(res, r.ok ? 200 : 404, r);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  };
}
