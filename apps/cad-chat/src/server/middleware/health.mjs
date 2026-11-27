// GET /api/health — 回報訂閱認證狀態,驅動前端設定橫幅。
// GET /api/session-info?id= — 唯讀探測 session 是否還救得回來(前端開機還原用;絕不建目錄)。
import { resolveDemoQuota } from "../config.mjs";
import { providerHealth } from "../provider.mjs";
import { getOrCreateSession, persistSession, probeSessionOnDisk } from "../sessions.mjs";
import { importHistory } from "../handoff.mjs";
import { lastLocalSession, recoverySnapshot } from "../localRecovery.mjs";
import { quotaStatus } from "../quota.mjs";
import { introVideoStatus } from "../introVideo.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";

export function healthMiddleware() {
  return async function health(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname === "/api/session-snapshot" && !req.cadchat?.demo) {
      if (req.cadchat?.user || !process.env.CADCHAT_PROVIDER) return sendJson(res,404,{});
      const user = req.cadchat?.user;
      const requested = url.searchParams.get("id");
      const id = !requested && !user && process.env.CADCHAT_PROVIDER
        ? lastLocalSession(req.cadchat.sessionsRoot) : requested;
      if (!probeSessionOnDisk(id,user).exists) return sendJson(res,404,{});
      const session = getOrCreateSession(id,{user});
      if (req.method === "GET") return sendJson(res,200,{snapshot:recoverySnapshot(session)});
      if (req.method !== "POST") return sendJson(res,405,{});
      let snap;
      try { snap = await readJsonBody(req,{limit:2_000_000}); }
      catch { return sendJson(res,400,{}); }
      if (snap?.sessionId !== id || !Array.isArray(snap.items) || !Number.isFinite(snap.savedAt)) return sendJson(res,400,{});
      const current = !session.version || snap.versions?.some(v => v.id === "v"+session.version);
      if (current && (!session.uiSnapshot || snap.savedAt >= session.uiSnapshot.savedAt)) {
        importHistory(session,snap.items);
        session.uiSnapshot = snap;
        persistSession(session);
      }
      return sendJson(res,200,{ok:true});
    }
    if (url.pathname === "/api/session-info") {
      const info = probeSessionOnDisk(url.searchParams.get("id"), req.cadchat?.user);
      if (!req.cadchat?.user && process.env.CADCHAT_PROVIDER) info.desktop = process.env.CADCHAT_PROVIDER;
      sendJson(res, 200, info);
      return;
    }
    if (url.pathname !== "/api/health") return next();
    const demo = !!req.cadchat?.demo;
    const auth = await providerHealth({ user: !!req.cadchat?.user, demo });
    sendJson(res, 200, {
      ok: true,
      agentReady: auth.agentReady,
      authMode: auth.authMode,
      model: auth.model,
      effort: auth.effort,
      provider: auth.provider,
      desktop: !req.cadchat?.user && !!process.env.CADCHAT_PROVIDER,
      warnings: auth.warnings,
      demo, // 前端據此藏 開啟檔案/教訓/另存專案 與零件庫互動
      // 介紹影片真的在(不是 LFS pointer)才回 true;demo 首次進場據此問「要不要看」。
      introVideo: introVideoStatus().available,
      // demo 時附剩餘配額(不回傳 user 字串);前端可顯「剩餘 X 回合」徽章。
      ...(demo ? { demoQuota: quotaStatus(req.cadchat.user, { limit: resolveDemoQuota() }) } : {}),
    });
  };
}
