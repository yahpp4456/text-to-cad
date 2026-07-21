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
const DEMO_SECRET_FILE = process.env.CADCHAT_DEMO_SECRET_FILE || "/etc/cadchat/demo-secret";
const DEMO_TTL = Number.parseInt(process.env.CADCHAT_DEMO_TTL_SECONDS || "7200", 10);
const TRUST_XFF = String(process.env.PROXY_TRUST_XFF ?? "1") !== "0";
const LOGIN_MAX = Number.parseInt(process.env.PROXY_LOGIN_MAX || "10", 10);
const LOGIN_WINDOW_MS = Number.parseInt(process.env.PROXY_LOGIN_WINDOW_MS || "600000", 10);
const COOKIE = "cadchat_demo";
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

function checkDemoPassword(input) {
  const stored = readDemoPasswordHash();
  if (!stored) return false;
  const got = crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
  return safeEqual(got, stored);
}
function mintCookie() {
  const vid = crypto.randomBytes(8).toString("hex"); // 16 hex → demo-<16hex> = 21 字元,過 USER_RE
  const exp = Math.floor(Date.now() / 1000) + DEMO_TTL;
  const body = `v1.${vid}.${exp}`;
  const sig = crypto.createHmac("sha256", readDemoSecret()).update(body).digest("base64url");
  return { value: `${body}.${sig}`, identity: `demo-${vid}` };
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
// 每 IP 登入嘗試 token bucket(記憶體;程序重啟即清)。
const loginHits = new Map(); // ip -> { count, resetAt }
function loginRateLimited(ip, now = Date.now()) {
  const rec = loginHits.get(ip);
  if (!rec || now >= rec.resetAt) {
    loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX;
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
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUIYAO 對話式 CAD — 展示登入</title>
<style>body{font-family:system-ui,"Noto Sans TC",sans-serif;background:#f4f1ea;color:#2a2a2a;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;padding:2rem 2.25rem;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:min(92vw,360px)}
h1{font-size:1.15rem;margin:0 0 1rem}.sub{color:#777;font-size:.85rem;margin:0 0 1.25rem}
input{width:100%;box-sizing:border-box;padding:.65rem .75rem;border:1px solid #d8d2c4;border-radius:8px;font-size:1rem}
button{width:100%;margin-top:.9rem;padding:.7rem;border:0;border-radius:8px;background:#c96f4a;color:#fff;font-size:1rem;cursor:pointer}
.err{color:#c0392b;font-size:.85rem;margin:.5rem 0 0}.foot{margin-top:1rem;font-size:.8rem}.foot a{color:#c96f4a}</style>
</head><body><form class="card" method="POST" action="${BASE}/__demo/login">
<h1>展示登入</h1><p class="sub">輸入展示密碼即可試用(展示模式,額度有限)。</p>
<input type="password" name="password" placeholder="展示密碼" autofocus autocomplete="current-password">
<button type="submit">進入展示</button>${err}
<p class="foot"><a href="${BASE}/__demo/basic">團隊帳號登入 →</a></p></form></body></html>`;
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
        if (form && checkDemoPassword(form.password)) {
          const { value } = mintCookie();
          setCookie(res, value, DEMO_TTL);
          res.writeHead(302, { location: `${BASE}/` });
          res.end();
        } else {
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
  // 團隊帳號:純觸發 Basic 提示(給 test* 用;避免預設落到 demo 登入頁)。
  if (pathOnly === `${BASE}/__demo/basic`) {
    const u = checkBasic(req.headers.authorization);
    if (u) {
      res.writeHead(302, { location: `${BASE}/` });
      res.end();
    } else {
      basicChallenge(res);
    }
    return;
  }

  // ── 認證決策樹 ──
  // 1) 有 Authorization → 視為 Basic 嘗試:驗過放行,驗不過 401(不落到 demo)。
  if (req.headers.authorization) {
    const user = checkBasic(req.headers.authorization);
    if (user) {
      proxyToBackend(req, res, user);
      return;
    }
    basicChallenge(res);
    return;
  }
  // 2) 無 Authorization,有有效 cookie → demo 身分。
  const cookieVal = parseCookies(req.headers.cookie)[COOKIE];
  const demoId = verifyCookie(cookieVal);
  if (demoId) {
    proxyToBackend(req, res, demoId);
    return;
  }
  // 3) 皆無:未認證。
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
};

// 直接執行 → 起伺服器(import 當模組則不起)。
if (import.meta.url === `file://${process.argv[1]}`) {
  startProxy().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
