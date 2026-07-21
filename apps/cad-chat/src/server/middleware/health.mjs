// GET /api/health — 回報訂閱認證狀態,驅動前端設定橫幅。
// GET /api/session-info?id= — 唯讀探測 session 是否還救得回來(前端開機還原用;絕不建目錄)。
import { resolveAuth, resolveModel } from "../config.mjs";
import { probeSessionOnDisk } from "../sessions.mjs";
import { parseUrl, sendJson } from "../httpUtil.mjs";

export function healthMiddleware() {
  return function health(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname === "/api/session-info") {
      sendJson(res, 200, probeSessionOnDisk(url.searchParams.get("id"), req.cadchat?.user));
      return;
    }
    if (url.pathname !== "/api/health") return next();
    const auth = resolveAuth();
    sendJson(res, 200, {
      ok: true,
      agentReady: auth.agentReady,
      authMode: auth.authMode,
      model: resolveModel() || "(CLI 預設)",
      warnings: auth.warnings,
      demo: !!req.cadchat?.demo, // 前端據此藏 開啟檔案/教訓/另存專案 與零件庫互動
    });
  };
}
