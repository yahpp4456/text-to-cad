// DEMO 帳號唯讀閘:展示身分只能看畫面與設計/草模對話,擋掉「開啟檔案、另存
// 專案、教訓、零件庫互動」的端點。UI 已藏對應入口(App 依 /api/health 的 demo
// 旗),這裡是防直呼 API 的伺服器端底線——擋的語意以「入口」為單位:
//   開啟檔案   → /api/files(列目錄)、/api/open(唯讀開檔)、/api/open-project
//   另存專案   → /api/save-project
//   教訓       → /api/lessons 全家(含 record:demo 不累積也不改教訓庫)
//   零件庫互動 → library-add/delete/glb(收庫/刪件/補轉檔=寫入)、upload-step
//               (訪談入口)、import(⇪ 設計/檔案匯入)
// 刻意不擋:library-list、/api/asset(切到零件庫「看」貨架要用;唯讀)、
// chat/interrupt/export/validate(設計對話展示是 demo 的存在目的)。
import { parseUrl, sendJson } from "../httpUtil.mjs";

const BLOCKED = [
  "/api/files",
  "/api/open",
  "/api/open-project",
  "/api/save-project",
  "/api/lessons",
  "/api/library-add",
  "/api/library-delete",
  "/api/library-glb",
  "/api/upload-step",
  "/api/import",
];

export function demoGuardMiddleware() {
  return function demoGuard(req, res, next) {
    if (!req.cadchat?.demo) return next();
    const p = parseUrl(req).pathname;
    if (BLOCKED.some((b) => p === b || p.startsWith(`${b}/`))) {
      sendJson(res, 403, { ok: false, error: "DEMO 帳號僅供展示,這個功能未開放" });
      return;
    }
    next();
  };
}
