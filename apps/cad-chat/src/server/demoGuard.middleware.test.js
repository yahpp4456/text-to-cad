// demoGuard 單元測(node --test):demo 身分擋「開啟檔案/另存專案/教訓/零件庫
// 互動」端點回 403;非 demo 與 demo 的唯讀端點(health/library-list/asset/chat)
// 一律放行 next()。isDemoUser 的 env 解析(預設 demo、逗號清單、null user)一併釘住。
import assert from "node:assert/strict";
import { test } from "node:test";

import { demoGuardMiddleware } from "./middleware/demoGuard.mjs";
import { isDemoUser } from "./users.mjs";

function fakeReq(url, demo) {
  return { method: "POST", url, headers: {}, cadchat: { user: demo ? "demo" : "test", demo } };
}

function fakeRes() {
  return {
    statusCode: null,
    body: "",
    headersSent: false,
    writeHead(code) {
      this.statusCode = code;
      this.headersSent = true;
    },
    end(b) {
      this.body = String(b || "");
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

const BLOCKED_SAMPLES = [
  "/api/files",
  "/api/open",
  "/api/open-project",
  "/api/save-project",
  "/api/lessons",
  "/api/lessons/record",
  "/api/lessons/delete-case",
  "/api/library-add",
  "/api/library-delete",
  "/api/library-glb",
  "/api/upload-step",
  "/api/import",
];

const ALLOWED_SAMPLES = [
  "/api/health",
  "/api/session-info",
  "/api/library-list", // 切到零件庫「看」貨架要用
  "/api/asset",
  "/api/chat",
  "/api/interrupt",
  "/api/export",
  "/api/validate",
];

test("demo 使用者:互動端點一律 403,不呼叫 next", () => {
  const mw = demoGuardMiddleware();
  for (const url of BLOCKED_SAMPLES) {
    const res = fakeRes();
    let passed = false;
    mw(fakeReq(url, true), res, () => {
      passed = true;
    });
    assert.equal(passed, false, `${url} 不該放行`);
    assert.equal(res.statusCode, 403, `${url} 該回 403`);
    assert.equal(res.json().ok, false);
  }
});

test("demo 使用者:唯讀/對話端點放行", () => {
  const mw = demoGuardMiddleware();
  for (const url of ALLOWED_SAMPLES) {
    const res = fakeRes();
    let passed = false;
    mw(fakeReq(url, true), res, () => {
      passed = true;
    });
    assert.equal(passed, true, `${url} 該放行`);
    assert.equal(res.statusCode, null);
  }
});

test("非 demo 使用者:全部端點放行(零回歸)", () => {
  const mw = demoGuardMiddleware();
  for (const url of [...BLOCKED_SAMPLES, ...ALLOWED_SAMPLES]) {
    const res = fakeRes();
    let passed = false;
    mw(fakeReq(url, false), res, () => {
      passed = true;
    });
    assert.equal(passed, true, `${url} 對非 demo 該放行`);
  }
});

test("擋單是完整字串或子路徑,不誤傷前綴相似端點", () => {
  const mw = demoGuardMiddleware();
  // library-list 與 library-glb 共享 "/api/library-" 前綴;openX 假想端點 ≠ /api/open
  for (const url of ["/api/library-list", "/api/openX", "/api/filesystem"]) {
    let passed = false;
    mw(fakeReq(url, true), fakeRes(), () => {
      passed = true;
    });
    assert.equal(passed, true, `${url} 不該被前綴誤傷`);
  }
});

test("isDemoUser:未設 env 預設 demo;逗號清單;null user 恆 false", () => {
  assert.equal(isDemoUser("demo", {}), true);
  assert.equal(isDemoUser("test", {}), false);
  assert.equal(isDemoUser(null, {}), false);
  const env = { CADCHAT_DEMO_USERS: "guest, demo2" };
  assert.equal(isDemoUser("guest", env), true);
  assert.equal(isDemoUser("demo2", env), true);
  assert.equal(isDemoUser("demo", env), false); // 明確設定就取代預設,不聯集
  assert.equal(isDemoUser("demo", { CADCHAT_DEMO_USERS: "" }), false); // 設空=停用
});
