// lessons middleware 單元測(node --test):store 寫入失敗時必回 500 而非 rejected
// promise——async middleware 的 rejection 沒人接會變 unhandledRejection 殺掉整個伺服器。
// 用假 req(Readable + method/url/headers)/res,file 注入 tmp 路徑。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { lessonsMiddleware } from "./middleware/lessons.mjs";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-lessons-mw-test-"));

function fakeReq(method, url, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = body ? { "content-type": "application/json" } : {};
  return req;
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

function seedStore(file, lessons = [], cases = []) {
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, seq: cases.length, lessonSeq: lessons.length, cases, lessons, distillAttempts: {} }),
    "utf8",
  );
}

const LS1 = {
  id: "LS-1", signature: "validate:interference", status: "active",
  title: "t", rootCause: "rc", rule: "r", caseCount: 1, resolvedCount: 0,
};

test("update:store 寫入失敗(rename 目標被佔)→ 回 500 store_write_failed,promise 不 reject", async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, "lessons.json");
    seedStore(file, [LS1]);
    fs.mkdirSync(`${file}.tmp`); // 佔住 tmp 路徑 → writeStore 的 writeFileSync 必炸
    const mw = lessonsMiddleware({ file });
    const res = fakeRes();
    // 若 middleware 讓例外外洩,這裡的 await 會 reject、測試直接失敗
    await mw(fakeReq("POST", "/api/lessons/update", { id: "LS-1", status: "disabled" }), res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "store_write_failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete:store 寫入失敗同樣回 500;正常路徑 200 且案例一併移除", async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, "lessons.json");
    seedStore(file, [LS1], [
      { id: "c_1", at: "2026-07-07T00:00:00Z", signature: "validate:interference", lessonId: "LS-1" },
    ]);
    const mw = lessonsMiddleware({ file });

    // 寫入失敗路徑
    fs.mkdirSync(`${file}.tmp`);
    let res = fakeRes();
    await mw(fakeReq("POST", "/api/lessons/delete", { id: "LS-1" }), res, () => {});
    assert.equal(res.statusCode, 500);
    fs.rmdirSync(`${file}.tmp`);

    // 正常路徑
    res = fakeRes();
    await mw(fakeReq("POST", "/api/lessons/delete", { id: "LS-1" }), res, () => {});
    assert.equal(res.statusCode, 200);
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(store.lessons.length, 0);
    assert.equal(store.cases.length, 0, "刪除應一併移除連結案例");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete-case:刪單筆 pending → 200;壞 id/已連結 → 404;寫入失敗 → 500", async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, "lessons.json");
    seedStore(file, [LS1], [
      { id: "c_1", at: "2026-07-07T00:00:00Z", signature: "build:SyntaxError", lessonId: null },
      { id: "c_2", at: "2026-07-07T00:00:00Z", signature: "validate:interference", lessonId: "LS-1" },
    ]);
    const mw = lessonsMiddleware({ file });

    // 已連結案例不得由 delete-case 刪 → 404(不動 store)
    let res = fakeRes();
    await mw(fakeReq("POST", "/api/lessons/delete-case", { id: "c_2" }), res, () => {});
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "not_found");

    // 壞 id → 404
    res = fakeRes();
    await mw(fakeReq("POST", "/api/lessons/delete-case", { id: "c_999" }), res, () => {});
    assert.equal(res.statusCode, 404);

    // 寫入失敗路徑 → 500 store_write_failed(promise 不 reject)
    fs.mkdirSync(`${file}.tmp`);
    res = fakeRes();
    await mw(fakeReq("POST", "/api/lessons/delete-case", { id: "c_1" }), res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "store_write_failed");
    fs.rmdirSync(`${file}.tmp`);

    // 正常:刪 pending c_1 → 200,連結案例 c_2 保留
    res = fakeRes();
    await mw(fakeReq("POST", "/api/lessons/delete-case", { id: "c_1" }), res, () => {});
    assert.equal(res.statusCode, 200);
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(!store.cases.some((c) => c.id === "c_1"), "pending 案例應被移除");
    assert.ok(store.cases.some((c) => c.id === "c_2"), "已連結案例應保留");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/lessons 回 threshold(供 UI 顯示,勿硬編碼)與 pending attempts", async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, "lessons.json");
    seedStore(file, [], [
      { id: "c_1", at: "2026-07-07T00:00:00Z", signature: "build:SyntaxError", lessonId: null },
    ]);
    const mw = lessonsMiddleware({ file });
    const res = fakeRes();
    await mw(fakeReq("GET", "/api/lessons"), res, () => {});
    assert.equal(res.statusCode, 200);
    const j = res.json();
    assert.equal(j.threshold, 3);
    assert.equal(j.pending[0].attempts, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
