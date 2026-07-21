// per-user 資料根推導(反代 BasicAuth 身分 → 磁碟命名空間)。
// 刻意獨立於 config.mjs:config 是 module-load 常數,這裡是 per-request 推導。
import path from "node:path";

import { DATA_ROOT, MODELS_ROOT, SESSIONS_ROOT } from "./config.mjs";

// 使用者名會進檔案路徑:白名單制,拒絕其他(大小寫保留,不 normalize)。
// 同步約束:/etc/cadchat/webauth 的帳號必須符合此格式。
export const USER_RE = /^[a-z0-9_-]{1,32}$/i;

// user=null → legacy 全域根(dev / 無 header 直連 = 零回歸)。
// dataRoot 可注入(單測用;預設 module 常數)。
export function rootsFor(user, { dataRoot = DATA_ROOT } = {}) {
  if (!user) return { modelsRoot: MODELS_ROOT, sessionsRoot: SESSIONS_ROOT };
  const modelsRoot = path.join(dataRoot, "users", user, "models");
  return { modelsRoot, sessionsRoot: path.join(modelsRoot, ".cadchat") };
}

// /cad 代理為每個 DEMO 訪客鑄造的身分前綴:demo-<visitorId>(visitorId 小寫 hex)。
// 這是安全不變量的錨點——鑄造前綴一律視為 demo,不受 env 影響(見 isDemoUser)。
export const DEMO_MINT_PREFIX = "demo-";

// DEMO 帳號(展示身分):CADCHAT_DEMO_USERS 逗號分隔清單,支援 `*` 結尾萬用前綴
// (如 "demo-*"),未設時預設 "demo,demo-*"。per-request 讀 env(對齊本檔「非
// module-load 常數」的定位,單測可注入)。dev/直連的 user=null 恆非 demo——demo
// 是「有身分但受限」,不是匿名。
//
// **安全不變量(不可被 env 誤設關掉)**:proxy 鑄造前綴 `demo-<...>` **恆為 true**,
// 與磁碟 GC 的 `^demo-` 不變量對齊。否則若 Sam 把 CADCHAT_DEMO_USERS 設成純 "demo"
// (漏萬用),每個訪客 demo-<id> 會被判成一般使用者 → demoGuard 關 + 無配額 +
// 走訂閱 OAuth = 條款違規。env 只能「增列」額外 demo 名,拿不掉鑄造前綴。
export function isDemoUser(user, env = process.env) {
  if (!user) return false;
  // 硬性不變量:鑄造前綴恆 demo(env 無法覆寫)。
  if (user.startsWith(DEMO_MINT_PREFIX) && user.length > DEMO_MINT_PREFIX.length) return true;
  for (const entry of String(env.CADCHAT_DEMO_USERS ?? "demo,demo-*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (prefix && user.startsWith(prefix) && user.length > prefix.length) return true;
    } else if (entry === user) {
      return true;
    }
  }
  return false;
}
