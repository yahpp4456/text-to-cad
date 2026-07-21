// cad-proxy 煙測(node --test):紅線(冒充 X-Remote-User 被刷掉,兩模式都測)、
// demo cookie 登入/驗證/竄改/過期、未認證路由(302 vs 401)、路徑 strip、
// 登入 rate-limit 只認 Caddy 附加 IP、啟動自檢拒 demo- 帳號。
// 零外部相依;起一個 stub 後端(回聲收到的 x-remote-user)+ 真 proxy,用 fetch 打。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";

// ── 準備臨時祕密檔 + env(必須在 import server.mjs 之前,因 server 於 module load 讀 env)──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadproxy-test-"));
const webauthFile = path.join(tmp, "webauth");
const pwFile = path.join(tmp, "demo-password");
const secretFile = path.join(tmp, "demo-secret");
const DEMO_PW = "demo-pass-123";
fs.writeFileSync(webauthFile, "# comment\ntest:secretpw\ntest2:pw2\n");
fs.writeFileSync(pwFile, crypto.createHash("sha256").update(DEMO_PW).digest("hex"));
fs.writeFileSync(secretFile, crypto.randomBytes(32));

// stub 後端:回聲 path + 收到的 x-remote-user + xff
const stub = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    path: req.url,
    remoteUser: req.headers["x-remote-user"] ?? null,
    xff: req.headers["x-forwarded-for"] ?? null,
  }));
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const backendPort = stub.address().port;

process.env.CADCHAT_BACKEND = `127.0.0.1:${backendPort}`;
process.env.CADCHAT_WEBAUTH = webauthFile;
process.env.CADCHAT_DEMO_PASSWORD_FILE = pwFile;
process.env.CADCHAT_DEMO_SECRET_FILE = secretFile;
process.env.CADCHAT_BASE_PATH = "/cad";
process.env.PROXY_PORT = "0";
process.env.PROXY_LOGIN_MAX = "2";

const { startProxy, _internal } = await import("./server.mjs");
const { port, close } = await startProxy();
const B = `http://127.0.0.1:${port}`;
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

after(async () => {
  await close();
  await new Promise((r) => stub.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Basic 有效 → 後端見驗證身分 + 路徑 strip /cad", async () => {
  const res = await fetch(`${B}/cad/api/ping`, { headers: { authorization: basic("test", "secretpw") } });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.remoteUser, "test");
  assert.equal(j.path, "/api/ping"); // /cad 已 strip
});

test("🔴 紅線(Basic 模式):client 自帶 X-Remote-User 被刷掉", async () => {
  const res = await fetch(`${B}/cad/api/ping`, {
    headers: { authorization: basic("test", "secretpw"), "x-remote-user": "test2" },
  });
  const j = await res.json();
  assert.equal(j.remoteUser, "test"); // 不是 test2
});

test("Basic 無效 → 401 + WWW-Authenticate,不進後端", async () => {
  const res = await fetch(`${B}/cad/api/ping`, { headers: { authorization: basic("test", "WRONG") } });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /Basic/);
});

let demoCookie = null;
test("demo 登入:對密碼 → 302 + Set-Cookie", async () => {
  const res = await fetch(`${B}/cad/__demo/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(DEMO_PW)}`,
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/cad/");
  const setc = res.headers.getSetCookie?.() || [];
  const line = setc.find((c) => c.startsWith("cadchat_demo="));
  assert.ok(line, "應有 cadchat_demo cookie");
  assert.match(line, /HttpOnly/);
  assert.match(line, /SameSite=Lax/);
  demoCookie = line.split(";")[0]; // cadchat_demo=<value>
});

test("🔴 紅線(cookie 模式):demo 身分注入 + client 自帶 X-Remote-User 被刷掉", async () => {
  const res = await fetch(`${B}/cad/api/ping`, {
    headers: { cookie: demoCookie, "x-remote-user": "test2" },
  });
  const j = await res.json();
  assert.match(j.remoteUser, /^demo-[a-f0-9]{16}$/); // 鑄造身分
  assert.notEqual(j.remoteUser, "test2"); // 冒充被刷掉
});

test("demo 登入:錯密碼 → 401", async () => {
  const res = await fetch(`${B}/cad/__demo/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=WRONG",
    redirect: "manual",
  });
  assert.equal(res.status, 401);
});

test("未認證:GET+Accept html → 302 登入頁", async () => {
  const res = await fetch(`${B}/cad/`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/cad/__demo/login");
});

test("未認證:/api 非 html → 401 demo_session_expired", async () => {
  const res = await fetch(`${B}/cad/api/chat`, { method: "POST" });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.error, "demo_session_expired");
});

test("竄改 cookie → 視為未認證(401)", async () => {
  const tampered = demoCookie.slice(0, -1) + (demoCookie.endsWith("A") ? "B" : "A");
  const res = await fetch(`${B}/cad/api/chat`, { method: "POST", headers: { cookie: tampered } });
  assert.equal(res.status, 401);
});

// ── 純函式單元(_internal)──
test("injectIdentity:刪所有大小寫 x-remote-user 變體、注入已驗證身分", () => {
  const h = { "X-Remote-User": "evil", "x-remote-user": "evil2", foo: "bar" };
  _internal.injectIdentity(h, "good");
  const keys = Object.keys(h).filter((k) => k.toLowerCase() === "x-remote-user");
  assert.deepEqual(keys, ["x-remote-user"]);
  assert.equal(h["x-remote-user"], "good");
  assert.equal(h.foo, "bar");
});

test("verifyCookie:合法過、竄改拒、過期拒", () => {
  const { value, identity } = _internal.mintCookie();
  assert.equal(_internal.verifyCookie(value), identity);
  assert.equal(_internal.verifyCookie(value.slice(0, -1) + "x"), null); // 竄改簽章
  assert.equal(_internal.verifyCookie("garbage"), null);
  // 過期:自簽一個過去時間的 cookie
  const secret = fs.readFileSync(secretFile);
  const vid = "0123456789abcdef";
  const exp = Math.floor(Date.now() / 1000) - 10;
  const sig = crypto.createHmac("sha256", secret).update(`v1.${vid}.${exp}`).digest("base64url");
  assert.equal(_internal.verifyCookie(`v1.${vid}.${exp}.${sig}`), null);
});

test("clientIp:只認 Caddy 附加的 XFF 尾段(前面偽造被忽略)", () => {
  const ip = (xff) => _internal.clientIp({ headers: { "x-forwarded-for": xff }, socket: {} });
  assert.equal(ip("9.9.9.9, 1.1.1.1"), "1.1.1.1"); // 攻擊者偽造 9.9.9.9 在前,Caddy 真 IP 在後
  assert.equal(ip("8.8.8.8, 1.1.1.1"), "1.1.1.1"); // 換偽造前段仍同 bucket → 限額守得住
});

test("登入 rate-limit:同 Caddy-IP 超過上限 → 429(偽造 XFF 前段無效)", async () => {
  const post = (fakeFront) =>
    fetch(`${B}/cad/__demo/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `${fakeFront}, 1.2.3.4` },
      body: "password=WRONG",
      redirect: "manual",
    });
  const s1 = (await post("9.9.9.9")).status; // 1
  const s2 = (await post("8.8.8.8")).status; // 2(換偽造前段)
  const s3 = (await post("7.7.7.7")).status; // 3 → 超過 max=2
  assert.ok(s1 === 401, `第1次應 401,實際 ${s1}`);
  assert.ok(s2 === 401, `第2次應 401,實際 ${s2}`);
  assert.equal(s3, 429, "第3次(同 Caddy IP)應被限額");
});

test("啟動自檢:webauth 含 demo- 帳號 → 拒絕啟動", () => {
  fs.writeFileSync(webauthFile, "test:secretpw\ndemo-evil:pw\n");
  assert.throws(() => startProxy(), /保留前綴|demo-/);
  fs.writeFileSync(webauthFile, "test:secretpw\ntest2:pw2\n"); // 還原
});
