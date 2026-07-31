// cad-proxy — /cad 前門認證代理(Phase 3;取代舊 my-rest-api app.js 內的
// checkCadAuth + createProxyMiddleware)。零外部相依(只用 node 內建),單檔可部署。
//
// 佈署:複製到 /opt/cadchat/proxy/server.mjs,非 root 專用帳號 + systemd 硬化 + enable,
// 聽 127.0.0.1:8790;Caddy `handle /cad* { reverse_proxy 127.0.0.1:8790 }`。
//
// 兩種認證模式(決策樹):
//   1) 帶 Authorization: Basic → 比對 /etc/cadchat/webauth(test* 不變)→ 身分=帳號名。
//   2) 無 Authorization、有效未過期 cookie cadchat_demo → 身分=demo-<visitorId>。
//   3) 皆無:GET+Accept html → 302 登入頁;/api 或非 html → 401 demo_session_expired。
//      未認證請求永不進後端。
//
// 🔴 紅線:兩模式共用同一段 injectIdentity()——先刪 client 自帶的所有 x-remote-user,
//    再注入已驗證身分。漏了=任何人自帶 header 冒充任一住戶。
//
// 環境變數(皆有預設,供本機煙測覆寫):
//   PROXY_PORT(8790) PROXY_HOST(127.0.0.1) CADCHAT_BACKEND(127.0.0.1:8788)
//   CADCHAT_BASE_PATH(/cad) CADCHAT_WEBAUTH(/etc/cadchat/webauth)
//   CADCHAT_DEMO_PASSWORD_FILE(/etc/cadchat/demo-password:內含密碼的 sha256 hex)
//   CADCHAT_DEMO_PASSWORD2_FILE(/etc/cadchat/demo-password2:選配第二組永久密碼的
//     sha256 hex;不被輪換腳本覆寫,兩組其一命中即可登入)
//   CADCHAT_DEMO_SECRET_FILE(/etc/cadchat/demo-secret:HMAC 金鑰,原始位元組)
//   CADCHAT_DEMO_TTL_SECONDS(7200) CADCHAT_DEMO_LOGIN(1;0=停用 demo 登入只留 Basic)
//   PROXY_TRUST_XFF(1;信任 Caddy 附加的 XFF 尾段當 client IP)
//   PROXY_LOGIN_MAX(10) PROXY_LOGIN_WINDOW_MS(600000)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number.parseInt(process.env.PROXY_PORT || "8790", 10);
const HOST = process.env.PROXY_HOST || "127.0.0.1";
const [BACKEND_HOST, BACKEND_PORT] = (process.env.CADCHAT_BACKEND || "127.0.0.1:8788").split(":");
const BASE = normalizeBase(process.env.CADCHAT_BASE_PATH || "/cad");
const WEBAUTH = process.env.CADCHAT_WEBAUTH || "/etc/cadchat/webauth";
const DEMO_PW_FILE = process.env.CADCHAT_DEMO_PASSWORD_FILE || "/etc/cadchat/demo-password";
const DEMO_PW2_FILE = process.env.CADCHAT_DEMO_PASSWORD2_FILE || "/etc/cadchat/demo-password2";
const DEMO_SECRET_FILE = process.env.CADCHAT_DEMO_SECRET_FILE || "/etc/cadchat/demo-secret";
const DEMO_TTL = Number.parseInt(process.env.CADCHAT_DEMO_TTL_SECONDS || "7200", 10);
// demo 同時在線人數上限(CADCHAT_DEMO_MAX_USERS,預設 50,0=不限)。閒置超過
// CADCHAT_DEMO_IDLE_SECONDS(預設 900=15 分)視為離線、釋出名額。
function demoMaxUsers() {
  const n = Number.parseInt(String(process.env.CADCHAT_DEMO_MAX_USERS ?? "50"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}
const DEMO_IDLE_SECONDS = Number.parseInt(process.env.CADCHAT_DEMO_IDLE_SECONDS || "900", 10);

// 只支援電腦、禁行動裝置(CADCHAT_DESKTOP_ONLY,預設開;設 0 放行手機/平板)。
// User-Agent 啟發式偵測——非 100%(iPadOS 13+ 偽裝成 Macintosh 者無法由 UA 分辨,
// 但其螢幕本就大,屬可接受邊角),足以擋掉一般手機/平板。
const MOBILE_RE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini|Silk|Kindle|PlayBook|webOS/i;
function isMobile(ua) {
  return MOBILE_RE.test(String(ua || ""));
}
function desktopOnly() {
  return String(process.env.CADCHAT_DESKTOP_ONLY ?? "1") !== "0";
}
const TRUST_XFF = String(process.env.PROXY_TRUST_XFF ?? "1") !== "0";
const LOGIN_MAX = Number.parseInt(process.env.PROXY_LOGIN_MAX || "10", 10);
const LOGIN_WINDOW_MS = Number.parseInt(process.env.PROXY_LOGIN_WINDOW_MS || "600000", 10);
const COOKIE = "cadchat_demo";
// 團隊 Basic 登入後的短命提示 cookie:讓 /cad/ 對其出 401 challenge 以擴展憑證範圍。
const TEAM_COOKIE = "cadchat_team";
const PROXY_TIMEOUT_MS = 3600000; // AI 回合可達數分鐘

function normalizeBase(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "/") return "";
  return "/" + s.replace(/^\/+|\/+$/g, "");
}

// ── webauth(Basic 帳密表)──────────────────────────────────────────────
// 每行 user:password;# 註解。改檔即時生效(每請求讀,量小)。
function loadWebauth() {
  try {
    return fs.readFileSync(WEBAUTH, "utf8")
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
      .reduce((m, l) => {
        const i = l.indexOf(":");
        if (i > 0) m[l.slice(0, i)] = l.slice(i + 1);
        return m;
      }, {});
  } catch {
    return {};
  }
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function checkBasic(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  let cred;
  try {
    cred = Buffer.from(header.slice(6), "base64").toString("utf-8");
  } catch {
    return null;
  }
  const i = cred.indexOf(":");
  const user = i >= 0 ? cred.slice(0, i) : cred;
  const pass = i >= 0 ? cred.slice(i + 1) : "";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(user)) return null;
  const users = loadWebauth();
  if (Object.prototype.hasOwnProperty.call(users, user) && safeEqual(users[user], pass)) return user;
  return null;
}

// ── demo 密碼 / secret / cookie(stateless HMAC)────────────────────────
function readDemoPasswordHash() {
  try {
    return fs.readFileSync(DEMO_PW_FILE, "utf8").trim().toLowerCase(); // sha256 hex
  } catch {
    return null;
  }
}
function readDemoSecret() {
  try {
    const b = fs.readFileSync(DEMO_SECRET_FILE);
    return b.length ? b : null;
  } catch {
    return null;
  }
}
const DEMO_LOGIN_ENABLED =
  String(process.env.CADCHAT_DEMO_LOGIN ?? "1") !== "0" && !!readDemoPasswordHash() && !!readDemoSecret();

// 團隊帳號入口開關:預設「關」——/cad/__demo/basic 不出 Basic 登入畫面,改顯示彩蛋頁
// (大字「你是希茲克利夫?」)。正常要開放團隊入口時設 CADCHAT_TEAM_LOGIN=1 切回 Basic。
// 註:此旗標只管「按鈕/入口畫面」;直接帶 Authorization header 的 Basic 驗證路徑不受影響。
const TEAM_LOGIN_ENABLED = String(process.env.CADCHAT_TEAM_LOGIN ?? "0") === "1";

// 第二組永久密碼(選配):檔案不存在即略過。輪換腳本只覆寫主密碼檔,此檔長期有效。
function readDemoPasswordHash2() {
  try {
    return fs.readFileSync(DEMO_PW2_FILE, "utf8").trim().toLowerCase();
  } catch {
    return null;
  }
}
function checkDemoPassword(input) {
  const stored = readDemoPasswordHash();
  if (!stored) return false;
  const got = crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
  if (safeEqual(got, stored)) return true;
  const stored2 = readDemoPasswordHash2();
  return !!stored2 && safeEqual(got, stored2);
}
function mintCookie() {
  const vid = crypto.randomBytes(8).toString("hex"); // 16 hex → demo-<16hex> = 21 字元,過 USER_RE
  const exp = Math.floor(Date.now() / 1000) + DEMO_TTL;
  const body = `v1.${vid}.${exp}`;
  const sig = crypto.createHmac("sha256", readDemoSecret()).update(body).digest("base64url");
  return { value: `${body}.${sig}`, identity: `demo-${vid}`, vid, exp };
}

// ── demo 在線人數登記(限制同時在線人數;stateless auth 不受影響)──────────
// visitorId -> 最後活動時間(epoch秒)。登入預留名額、每次授權請求刷新;閒置超過
// DEMO_IDLE_SECONDS 於下次計數時釋出。程序重啟即清(cookie 仍有效,屬軟上限)。
const demoSeen = new Map();
function demoOnlineCount(now = Math.floor(Date.now() / 1000)) {
  for (const [vid, ts] of demoSeen) if (now - ts > DEMO_IDLE_SECONDS) demoSeen.delete(vid);
  return demoSeen.size;
}
function touchDemo(vid, now = Math.floor(Date.now() / 1000)) {
  if (vid) demoSeen.set(vid, now);
}
function demoAtCapacity() {
  const max = demoMaxUsers();
  return max > 0 && demoOnlineCount() >= max;
}
function resetDemoSessions() {
  demoSeen.clear();
}

// 回傳已驗證身分字串或 null。過期/竄改/格式錯一律 null。
function verifyCookie(raw) {
  if (!raw) return null;
  const parts = String(raw).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, vid, expStr, sig] = parts;
  if (!/^[a-f0-9]{16}$/.test(vid)) return null;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const secret = readDemoSecret();
  if (!secret) return null;
  const expect = crypto.createHmac("sha256", secret).update(`v1.${vid}.${exp}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return `demo-${vid}`;
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ── client IP(登入 rate-limit 用):只信 Caddy 附加的 XFF 尾段,忽略 client 自帶 ──
function clientIp(req) {
  if (TRUST_XFF) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1]; // Caddy 附加在最後
    }
  }
  return req.socket.remoteAddress || "unknown";
}
// 每 IP 嘗試 token bucket(記憶體;程序重啟即清)。demo 密碼登入與團隊 Basic 猜密碼
// 各自一桶,互不干擾。
const loginHits = new Map(); // demo 登入 POST 失敗:ip -> { count, resetAt }
const basicHits = new Map(); // 團隊 Basic 驗證失敗:ip -> { count, resetAt }
function bump(map, ip, now = Date.now()) {
  const rec = map.get(ip);
  if (!rec || now >= rec.resetAt) {
    map.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX;
}
function loginRateLimited(ip, now = Date.now()) {
  return bump(loginHits, ip, now);
}
function basicFailLimited(ip, now = Date.now()) {
  return bump(basicHits, ip, now);
}
// Basic 驗證失敗的統一處理:帶了 Authorization 才算「猜密碼」→ 計入 rate-limit,超過回
// 429;沒帶 Authorization(初次挑戰)不計,只回 401 提示。防團隊帳號被無限暴力破解。
function handleBasicFail(req, res) {
  if (req.headers.authorization && basicFailLimited(clientIp(req))) {
    sendJson(res, 429, { error: "too_many_attempts" });
    return;
  }
  basicChallenge(res);
}

// ── 🔴 紅線:刪 client 自帶 x-remote-user,注入已驗證身分(唯一注入點)──────
function injectIdentity(headers, identity) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "x-remote-user") delete headers[k];
  }
  headers["x-remote-user"] = identity;
}

// ── 回應小工具 ───────────────────────────────────────────────────────
function sendText(res, code, body, extra = {}) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
}
function sendJson(res, code, obj, extra = {}) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(obj));
}
function basicChallenge(res) {
  sendText(res, 401, "Authentication required", {
    "www-authenticate": 'Basic realm="cad-chat", charset="UTF-8"',
  });
}
function wantsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}
function loginPage(error = "") {
  const err = error ? `<p class="err">${error}</p>` : "";
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SUIYAO 對話式 CAD ・ 展示登入</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  :root{
    --indigo:#2e3192; --indigo-2:#252873; --blue:#3461b5; --cyan:#18a0c4; --green:#34ab86; --warn:#d64848;
    --ink:#1c2150; --body:#5b6577; --muted:#8a93a3;
    --surface:#fff; --surface-2:#fafbfd; --surface-3:#f4f6fa;
    --bg:#eef1f6; --bg2:#f3f5f9;
    --line:#e4e8f0; --line-soft:#eef1f6; --line-strong:#dde2ec;
    --err-bg:#fdecea;
    --rule:linear-gradient(90deg,#2e3192,#3461b5 45%,#18a0c4);
    --font-display:'Anton','Noto Sans TC',sans-serif;
    --font-label:'Oswald',system-ui,sans-serif;
    --font-body:'Noto Sans TC',system-ui,-apple-system,"Microsoft JhengHei",sans-serif;
    --clip-card:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px));
    --clip-chip:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);
    --clip-btn:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px);
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    font-family:var(--font-body);color:var(--ink);background:var(--bg);
    background-image:
      radial-gradient(1100px 520px at 88% -12%, rgba(24,160,196,0.10), transparent 60%),
      radial-gradient(900px 480px at -10% 112%, rgba(46,49,146,0.09), transparent 55%),
      repeating-linear-gradient(0deg, rgba(46,49,146,0.035) 0 1px, transparent 1px 24px),
      repeating-linear-gradient(90deg, rgba(46,49,146,0.035) 0 1px, transparent 1px 24px),
      linear-gradient(180deg,var(--bg2),var(--bg));
    background-attachment:fixed;
    min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:32px 18px;line-height:1.6;-webkit-font-smoothing:antialiased;
  }
  .wrap{width:100%;max-width:462px;}
  .brandline{display:flex;align-items:center;gap:11px;margin-bottom:16px;padding-left:1px;}
  .mark{
    width:34px;height:34px;flex:0 0 auto;clip-path:var(--clip-chip);background:var(--indigo);color:#fff;
    display:flex;align-items:center;justify-content:center;font-family:var(--font-body);font-weight:900;font-size:17px;
  }
  .brandline .kanji{font-family:var(--font-label);font-size:12px;font-weight:600;letter-spacing:0.24em;color:var(--indigo);text-transform:uppercase;}
  .card{
    position:relative;overflow:hidden;background:var(--surface);border:1px solid var(--line);clip-path:var(--clip-card);
    padding:38px 34px 32px;box-shadow:0 1px 3px rgba(20,30,60,0.05),0 24px 48px -30px rgba(28,33,80,0.35);
  }
  .card .wm{
    position:absolute;right:-8px;bottom:-30px;z-index:0;pointer-events:none;user-select:none;
    font-family:var(--font-display);font-size:150px;line-height:0.8;letter-spacing:2px;color:rgba(46,49,146,0.05);text-transform:uppercase;
  }
  .card .inner{position:relative;z-index:1;}
  .eyebrow{display:flex;align-items:center;gap:9px;font-family:var(--font-label);font-size:11px;letter-spacing:0.34em;text-transform:uppercase;color:var(--cyan);font-weight:600;margin:2px 0 14px;}
  .eyebrow::before{content:"";width:16px;height:2px;background:var(--rule);}
  h1{font-family:var(--font-body);font-weight:900;font-size:30px;line-height:1.15;letter-spacing:0.01em;margin:0 0 8px;color:var(--ink);}
  .sub{font-size:13.5px;color:var(--body);margin:0 0 22px;letter-spacing:0.02em;}
  .sub .code{font-family:var(--font-label);font-size:11px;letter-spacing:0.14em;color:var(--muted);text-transform:uppercase;}
  .rule{height:2px;background:var(--rule);border:0;margin:0 0 24px;}
  form{margin:0;}
  label.field-label{display:block;font-family:var(--font-label);font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:0 0 8px;}
  input[type=password]{
    width:100%;font-family:var(--font-body);font-size:16px;color:var(--ink);background:var(--surface-2);
    border:1px solid var(--line-strong);clip-path:var(--clip-chip);padding:14px 15px;letter-spacing:0.08em;
    transition:border-color .15s,box-shadow .15s,background .15s;outline:none;
  }
  input[type=password]::placeholder{color:#a9b2c1;letter-spacing:0.12em;}
  input[type=password]:focus{border-color:var(--cyan);background:#fff;box-shadow:0 0 0 2px rgba(24,160,196,0.20);}
  .err{margin:12px 0 0;padding:10px 13px;background:var(--err-bg);border:1px solid rgba(214,72,72,0.28);border-left:3px solid var(--warn);clip-path:var(--clip-chip);color:var(--warn);font-size:13px;letter-spacing:0.01em;}
  button.submit{
    width:100%;margin-top:20px;font-family:var(--font-label);font-size:13px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;
    color:#fff;background:var(--indigo);border:0;clip-path:var(--clip-btn);padding:15px 16px;cursor:pointer;
    box-shadow:0 8px 18px -8px rgba(46,49,146,0.75);transition:background .15s,box-shadow .15s,transform .1s;
  }
  button.submit:hover{background:var(--indigo-2);box-shadow:0 12px 22px -8px rgba(46,49,146,0.85);}
  button.submit:active{transform:translateY(1px);}
  .terms{margin-top:26px;padding:16px 18px 8px;background:var(--surface-3);border:1px solid var(--line-soft);clip-path:var(--clip-chip);}
  .terms-head{font-size:12px;letter-spacing:0.02em;color:var(--body);margin:0 0 10px;}
  .terms-head b{color:var(--indigo);font-weight:700;}
  ul.terms-list{list-style:none;margin:0;padding:0;}
  ul.terms-list li{position:relative;padding:7px 0 7px 18px;font-size:12px;line-height:1.65;color:var(--body);letter-spacing:0.01em;border-top:1px solid var(--line);}
  ul.terms-list li:first-child{border-top:0;}
  ul.terms-list li::before{content:"";position:absolute;left:0;top:14px;width:6px;height:6px;background:var(--cyan);clip-path:polygon(2px 0,100% 0,100% calc(100% - 2px),calc(100% - 2px) 100%,0 100%,0 2px);}
  ul.terms-list li.disclaimer{color:var(--muted);}
  ul.terms-list li.disclaimer::before{background:var(--warn);}
  ul.terms-list li b{color:var(--ink);font-weight:700;}
  .foot{margin-top:20px;text-align:center;}
  .foot a{font-family:var(--font-label);font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:var(--indigo);text-decoration:none;border-bottom:1px solid rgba(46,49,146,0.28);padding-bottom:2px;transition:color .15s,border-color .15s;}
  .foot a:hover{color:var(--cyan);border-color:var(--cyan);}
  .copyline{margin-top:22px;text-align:center;font-family:var(--font-label);font-size:10px;letter-spacing:0.28em;color:var(--muted);text-transform:uppercase;}
  @media (max-width:420px){.card{padding:32px 22px 26px;}h1{font-size:26px;}.card .wm{font-size:120px;}}
</style>
</head>
<body>
  <main class="wrap">
    <div class="brandline">
      <span class="mark">穗</span>
      <span class="kanji">穗鈅科技 ・ SUIYAO Technology</span>
    </div>
    <section class="card">
      <span class="wm">CAD</span>
      <div class="inner">
        <p class="eyebrow">Demo Access</p>
        <h1>SUIYAO 對話式 CAD</h1>
        <p class="sub">AI 對話式 CAD 展示登入 <span class="code">· Conversational CAD</span></p>
        <hr class="rule">
        <form method="POST" action="${BASE}/__demo/login">
          <label class="field-label" for="password">展示密碼 · Demo Password</label>
          <input id="password" type="password" name="password" autocomplete="current-password" autofocus placeholder="請輸入 DEMO 密碼" aria-label="展示密碼">
          ${err}
          <button class="submit" type="submit">進入展示 · Enter</button>
        </form>
        <div class="terms">
          <p class="terms-head">目前為 <b>DEMO 測試階段</b>,登入即視為同意以下條款:</p>
          <ul class="terms-list">
            <li>本站不會主動儲存測試人員的個人資料與對話內容</li>
            <li>測試期間上傳或產生的所有檔案皆不會被保存</li>
            <li>測試時效為 <b>5 小時</b>,DEMO 密碼將於 5 小時後失效</li>
            <li>測試時間可能隨時<b>縮短、延長</b>,服務亦可能<b>隨時重啟</b>,恕不另行通知</li>
            <li>本工具生成的 CAD 模型僅供展示與參考,不保證正確性、精度或可製造性,請勿用於實際生產、製造或工程用途</li>
            <li>請勿輸入任何機密、個人隱私或營業秘密資料</li>
            <li class="disclaimer">免責聲明:對於使用本工具或其任何進階應用所造成之損失,本站與開發者恕不負責</li>
          </ul>
        </div>
        <div class="foot">
          <a href="${BASE}/__demo/basic">團隊帳號登入 →</a>
        </div>
      </div>
    </section>
    <p class="copyline">SUIYAO ・ Engineering Blueprint</p>
  </main>
</body>
</html>`;
}

// 團隊入口關閉時的彩蛋頁:大字「你是希茲克利夫?」(官網冷色調 + 品牌漸層)。
function heathcliffPage() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>系統登入</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    font-family:'Noto Sans TC',system-ui,-apple-system,"Microsoft JhengHei",sans-serif;
    color:#1c2150;background:#eef1f6;
    background-image:
      radial-gradient(1100px 520px at 88% -12%, rgba(24,160,196,0.12), transparent 60%),
      radial-gradient(900px 480px at -10% 112%, rgba(46,49,146,0.10), transparent 55%),
      repeating-linear-gradient(0deg, rgba(46,49,146,0.04) 0 1px, transparent 1px 24px),
      repeating-linear-gradient(90deg, rgba(46,49,146,0.04) 0 1px, transparent 1px 24px),
      linear-gradient(180deg,#f3f5f9,#eef1f6);
    background-attachment:fixed;
    min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:32px 20px;text-align:center;-webkit-font-smoothing:antialiased;position:relative;overflow:hidden;
  }
  .wm{
    position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:0;pointer-events:none;user-select:none;
    font-family:'Anton',sans-serif;font-size:clamp(180px,42vw,460px);line-height:0.8;letter-spacing:8px;
    color:rgba(46,49,146,0.045);text-transform:uppercase;
  }
  .box{max-width:760px;position:relative;z-index:1;}
  .eyebrow{display:inline-flex;align-items:center;gap:11px;font-family:'Oswald',sans-serif;font-size:13px;letter-spacing:0.42em;text-transform:uppercase;color:#18a0c4;font-weight:600;margin:0 0 26px;}
  .eyebrow::before,.eyebrow::after{content:"";width:22px;height:2px;background:linear-gradient(90deg,#2e3192,#3461b5 45%,#18a0c4);}
  .big{
    font-family:'Noto Sans TC',sans-serif;font-weight:900;line-height:1.06;letter-spacing:0.01em;margin:0;
    font-size:clamp(40px,9.5vw,90px);
    background:linear-gradient(90deg,#2e3192,#3461b5 45%,#18a0c4);
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }
  .sub{margin:22px 0 0;font-family:'Oswald',sans-serif;font-size:12px;letter-spacing:0.34em;text-transform:uppercase;color:#8a93a3;font-weight:500;}
  .foot{margin-top:46px;}
  .foot a{font-family:'Oswald',sans-serif;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#8a93a3;text-decoration:none;border-bottom:1px solid rgba(138,147,163,0.4);padding-bottom:2px;transition:color .15s ease,border-color .15s ease;}
  .foot a:hover{color:#2e3192;border-color:#2e3192;}
</style>
</head>
<body>
  <span class="wm">401</span>
  <main class="box">
    <p class="eyebrow">系統登入 ・ System Login</p>
    <h1 class="big">你是希茲克利夫?</h1>
    <p class="sub">Access Restricted ・ 未授權入口</p>
    <p class="foot"><a href="${BASE}/__demo/login">← 返回展示登入</a></p>
  </main>
</body>
</html>`;
}

// 行動裝置擋頁:大字「請用電腦開啟」(官網冷色調 + Anton「PC」浮水印)。
function mobileBlockPage() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>請用電腦開啟</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    font-family:'Noto Sans TC',system-ui,-apple-system,"Microsoft JhengHei",sans-serif;
    color:#1c2150;background:#eef1f6;
    background-image:
      radial-gradient(900px 480px at 88% -12%, rgba(24,160,196,0.12), transparent 60%),
      radial-gradient(800px 460px at -10% 112%, rgba(46,49,146,0.10), transparent 55%),
      repeating-linear-gradient(0deg, rgba(46,49,146,0.04) 0 1px, transparent 1px 24px),
      repeating-linear-gradient(90deg, rgba(46,49,146,0.04) 0 1px, transparent 1px 24px),
      linear-gradient(180deg,#f3f5f9,#eef1f6);
    min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:36px 24px;text-align:center;position:relative;overflow:hidden;-webkit-font-smoothing:antialiased;
  }
  .wm{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:0;pointer-events:none;user-select:none;
    font-family:'Anton',sans-serif;font-size:clamp(160px,54vw,360px);line-height:.8;letter-spacing:6px;color:rgba(46,49,146,0.05);}
  .box{max-width:420px;position:relative;z-index:1;}
  .eyebrow{display:inline-flex;align-items:center;gap:10px;font-family:'Oswald',sans-serif;font-size:12px;letter-spacing:0.4em;text-transform:uppercase;color:#18a0c4;font-weight:600;margin:0 0 20px;}
  .eyebrow::before,.eyebrow::after{content:"";width:20px;height:2px;background:linear-gradient(90deg,#2e3192,#3461b5 45%,#18a0c4);}
  h1{font-family:'Noto Sans TC',sans-serif;font-weight:900;font-size:clamp(30px,8vw,42px);line-height:1.15;margin:0 0 14px;
    background:linear-gradient(90deg,#2e3192,#3461b5 45%,#18a0c4);-webkit-background-clip:text;background-clip:text;color:transparent;}
  p.sub{font-size:14px;line-height:1.75;color:#5b6577;margin:0;letter-spacing:0.01em;}
  p.hint{margin:22px 0 0;font-family:'Oswald',sans-serif;font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#8a93a3;}
</style>
</head>
<body>
  <span class="wm">PC</span>
  <main class="box">
    <p class="eyebrow">Desktop Only</p>
    <h1>請用電腦開啟</h1>
    <p class="sub">SUIYAO 對話式 CAD 需要較大的螢幕與滑鼠操作,目前僅支援桌面電腦瀏覽器。<br>請改用電腦(Windows / Mac)開啟本頁。</p>
    <p class="hint">SUIYAO ・ Conversational CAD</p>
  </main>
</body>
</html>`;
}

// ── 反向代理(串流;SSE 不緩衝、長 timeout;strip BASE 前綴、改寫 Host)────
function proxyToBackend(req, res, identity) {
  const strippedPath = req.url.slice(BASE.length) || "/";
  const headers = { ...req.headers };
  delete headers["connection"];
  delete headers["keep-alive"];
  delete headers["proxy-authorization"];
  headers.host = `${BACKEND_HOST}:${BACKEND_PORT}`; // changeOrigin(過 cad-chat 的 Host 防護)
  // X-Forwarded-*(xfwd)
  const prevXff = req.headers["x-forwarded-for"];
  headers["x-forwarded-for"] = prevXff ? `${prevXff}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
  headers["x-forwarded-proto"] = "https";
  injectIdentity(headers, identity); // 🔴 紅線

  const up = http.request(
    { host: BACKEND_HOST, port: BACKEND_PORT, method: req.method, path: strippedPath, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.setTimeout(PROXY_TIMEOUT_MS, () => up.destroy(new Error("backend timeout")));
  up.on("error", () => {
    if (!res.headersSent) sendText(res, 502, "bad gateway");
    else res.destroy();
  });
  req.pipe(up);
}

// ── 讀 POST 表單 body(登入用;上限小)──
function readForm(req, cb) {
  let buf = "";
  let over = false;
  req.on("data", (c) => {
    buf += c;
    if (buf.length > 4096) {
      over = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (over) return cb(null);
    const params = new URLSearchParams(buf);
    cb(Object.fromEntries(params));
  });
  req.on("error", () => cb(null));
}

function setCookie(res, value, maxAge) {
  const attrs = [`${COOKIE}=${value}`, "HttpOnly", "Secure", "SameSite=Lax", `Path=${BASE || "/"}`, `Max-Age=${maxAge}`];
  res.setHeader("set-cookie", attrs.join("; "));
}

// ── 主處理 ───────────────────────────────────────────────────────────
function handle(req, res) {
  const url = req.url || "/";
  // 只服務 BASE 底下(Caddy 已用 handle /cad* 過濾;防禦性再擋一次)。
  if (BASE && !(url === BASE || url.startsWith(BASE + "/") || url.startsWith(BASE + "?"))) {
    sendText(res, 404, "not found");
    return;
  }
  const pathOnly = url.split("?")[0];

  // 在線人數查詢:僅限本機直連(無 X-Forwarded-For)。經 Caddy 的公開請求帶 XFF →
  // 當作不存在(404),不對外洩露。VM 上用:curl -s 127.0.0.1:8790/cad/__demo/status
  if (pathOnly === `${BASE}/__demo/status`) {
    if (req.headers["x-forwarded-for"]) {
      sendText(res, 404, "not found");
      return;
    }
    sendJson(res, 200, {
      online: demoOnlineCount(),
      max: demoMaxUsers(),
      idleSeconds: DEMO_IDLE_SECONDS,
      ttlSeconds: DEMO_TTL,
    });
    return;
  }

  // 只支援電腦:行動裝置一律擋(在認證之前;html 出「請用電腦」頁,其餘回 403)。
  if (desktopOnly() && isMobile(req.headers["user-agent"])) {
    if (req.method === "GET" && wantsHtml(req)) {
      sendText(res, 200, mobileBlockPage(), { "content-type": "text/html; charset=utf-8" });
    } else {
      sendJson(res, 403, { error: "desktop_only" });
    }
    return;
  }

  // demo 登入 / 登出路由(proxy 自理,不進後端)
  if (DEMO_LOGIN_ENABLED && pathOnly === `${BASE}/__demo/login`) {
    if (req.method === "GET") {
      sendText(res, 200, loginPage(), { "content-type": "text/html; charset=utf-8" });
      return;
    }
    if (req.method === "POST") {
      const ip = clientIp(req);
      if (loginRateLimited(ip)) {
        res.writeHead(429, { "content-type": "text/html; charset=utf-8" });
        res.end(loginPage("嘗試次數過多,請稍後再試。"));
        return;
      }
      readForm(req, (form) => {
        const ua = String(req.headers["user-agent"] || "").slice(0, 120);
        if (form && checkDemoPassword(form.password)) {
          if (demoAtCapacity()) {
            console.log(`demo 登入擋下(已滿 ${demoMaxUsers()})· IP ${ip}`);
            res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
            res.end(loginPage(`展示同時在線人數已滿(上限 ${demoMaxUsers()} 人),請稍後再試。`));
            return;
          }
          const { value, vid } = mintCookie();
          touchDemo(vid); // 預留在線名額
          setCookie(res, value, DEMO_TTL);
          res.writeHead(302, { location: `${BASE}/` });
          res.end();
          console.log(`demo 登入 OK · IP ${ip} · 在線 ${demoOnlineCount()}/${demoMaxUsers() || "∞"} · UA ${ua}`);
        } else {
          console.log(`demo 登入失敗(密碼錯)· IP ${ip}`);
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(loginPage("密碼錯誤。"));
        }
      });
      return;
    }
    sendText(res, 405, "method not allowed");
    return;
  }
  if (pathOnly === `${BASE}/__demo/logout`) {
    setCookie(res, "", 0);
    res.writeHead(302, { location: `${BASE}/__demo/login` });
    res.end();
    return;
  }
  // 團隊帳號入口:TEAM_LOGIN_ENABLED=false(預設)→ 出彩蛋頁,不出 Basic 登入畫面。
  // 開放時(=1)才觸發 Basic 提示(給 test* 用)。
  if (pathOnly === `${BASE}/__demo/basic`) {
    if (!TEAM_LOGIN_ENABLED) {
      sendText(res, 200, heathcliffPage(), { "content-type": "text/html; charset=utf-8" });
      return;
    }
    const u = checkBasic(req.headers.authorization);
    if (u) {
      // 瀏覽器 Basic 憑證的作用範圍只到本 URL 的目錄(/cad/__demo/),302 回 /cad/
      // 後不會自動帶 Authorization → 會被誤導回 demo 登入頁。設短命 team-hint
      // cookie,讓 /cad/ 的下一個未認證請求改收 401 challenge(同 realm,瀏覽器
      // 自動重送已存憑證、不再彈框),憑證範圍就此擴及整個 /cad/。
      res.writeHead(302, {
        location: `${BASE}/`,
        "set-cookie": `${TEAM_COOKIE}=1; HttpOnly; Secure; SameSite=Lax; Path=${BASE || "/"}; Max-Age=60`,
      });
      res.end();
    } else {
      handleBasicFail(req, res); // 猜密碼計入 rate-limit
    }
    return;
  }

  // ── 認證決策樹 ──
  // 1) 有 Authorization → 視為 Basic 嘗試:驗過放行,驗不過 401/429(不落到 demo)。
  if (req.headers.authorization) {
    const user = checkBasic(req.headers.authorization);
    if (user) {
      proxyToBackend(req, res, user);
      return;
    }
    handleBasicFail(req, res); // 團隊帳號防暴力破解
    return;
  }
  // 2) 無 Authorization,有有效 cookie → demo 身分。
  const cookieVal = parseCookies(req.headers.cookie)[COOKIE];
  const demoId = verifyCookie(cookieVal);
  if (demoId) {
    touchDemo(demoId.slice(5)); // demo-<vid> → vid;刷新在線活動時間
    proxyToBackend(req, res, demoId);
    return;
  }
  // 3) 皆無:未認證。剛過 /__demo/basic 的團隊使用者(帶 team-hint cookie)→
  //    出 Basic challenge 而非導 demo 登入頁,瀏覽器自動重送已存憑證完成登入。
  if (parseCookies(req.headers.cookie)[TEAM_COOKIE]) {
    basicChallenge(res);
    return;
  }
  if (DEMO_LOGIN_ENABLED && req.method === "GET" && wantsHtml(req)) {
    res.writeHead(302, { location: `${BASE}/__demo/login` });
    res.end();
    return;
  }
  if (DEMO_LOGIN_ENABLED) {
    sendJson(res, 401, { error: "demo_session_expired" });
    return;
  }
  // demo 登入停用 → 純 Basic 世界:提示 Basic。
  basicChallenge(res);
}

// ── 啟動 ─────────────────────────────────────────────────────────────
export function startProxy() {
  // 啟動自檢:webauth 不得含 demo- 開頭帳號(否則正式帳號會被當 demo 限額 / 撞名)。
  const bad = Object.keys(loadWebauth()).filter((u) => u.startsWith("demo-"));
  if (bad.length) {
    throw new Error(`cad-proxy 拒絕啟動:webauth 含保留前綴帳號 ${bad.join(", ")}(demo- 為鑄造前綴)`);
  }
  const server = http.createServer(handle);
  server.headersTimeout = 0; // 長 AI 回合:不因 header 慢而砍
  server.requestTimeout = 0;
  return new Promise((resolve) => {
    server.listen(PORT, HOST, () => {
      const mode = DEMO_LOGIN_ENABLED ? "Basic + demo cookie" : "Basic only(demo 登入停用)";
      console.log(`cad-proxy 啟動於 ${HOST}:${PORT} → 後端 ${BACKEND_HOST}:${BACKEND_PORT}(${mode})`);
      console.log(
        `  demo 在線上限:${demoMaxUsers() || "不限"} 人(閒置 ${DEMO_IDLE_SECONDS}s 釋出);僅支援電腦:${desktopOnly() ? "是(擋行動裝置)" : "否"};查詢:curl -s ${HOST}:${PORT}${BASE}/__demo/status`,
      );
      resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// 供煙測 import 內部函式(不啟動伺服器)。
export const _internal = {
  injectIdentity,
  verifyCookie,
  mintCookie,
  checkDemoPassword,
  clientIp,
  loginRateLimited,
  normalizeBase,
  demoOnlineCount,
  resetDemoSessions,
};

// 直接執行 → 起伺服器(import 當模組則不起)。
if (import.meta.url === `file://${process.argv[1]}`) {
  startProxy().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
