// 使用者情境:讀反代注入的 X-Remote-User → req.cadchat = { user, modelsRoot, sessionsRoot }。
// 信任前提:prod 後端只綁 127.0.0.1,header 由反代在 BasicAuth 成功後注入
// (並先刪除 client 自帶值再覆寫,見 my-rest-api app.js 的 onProxyReq)。
// header 缺席 = dev/直連 → user=null → legacy 全域根(零回歸)。
// 有值但不合白名單 → 403(絕不靜默併入 legacy 空間)。
import { sendJson } from "../httpUtil.mjs";
import { USER_RE, rootsFor } from "../users.mjs";

export function userContextMiddleware() {
  return function userContext(req, res, next) {
    const raw = String(req.headers["x-remote-user"] || "").trim();
    if (raw && !USER_RE.test(raw)) {
      sendJson(res, 403, { ok: false, error: "bad user" });
      return;
    }
    const user = raw || null;
    req.cadchat = { user, ...rootsFor(user) };
    next();
  };
}
