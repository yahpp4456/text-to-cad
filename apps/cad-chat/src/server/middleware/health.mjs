// GET /api/health — 回報訂閱認證狀態,驅動前端設定橫幅。
import { resolveAuth, resolveModel } from "../config.mjs";
import { parseUrl, sendJson } from "../httpUtil.mjs";

export function healthMiddleware() {
  return function health(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname !== "/api/health") return next();
    const auth = resolveAuth();
    sendJson(res, 200, {
      ok: true,
      agentReady: auth.agentReady,
      authMode: auth.authMode,
      model: resolveModel() || "(CLI 預設)",
      warnings: auth.warnings,
    });
  };
}
