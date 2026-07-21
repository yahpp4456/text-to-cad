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

// DEMO 帳號(展示身分):CADCHAT_DEMO_USERS 逗號分隔清單,未設時預設 "demo"。
// per-request 讀 env(對齊本檔「非 module-load 常數」的定位,單測可注入)。
// dev/直連的 user=null 恆非 demo——demo 是「有身分但受限」,不是匿名。
export function isDemoUser(user, env = process.env) {
  if (!user) return false;
  return String(env.CADCHAT_DEMO_USERS ?? "demo")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(user);
}
