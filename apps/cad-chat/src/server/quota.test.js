// quota.mjs 單元測(node --test):耗盡、磁碟往返、壞檔容錯、limit=0 不限。
// tmp dataRoot 注入(不碰真 DATA_ROOT);每測前 _resetQuotaCache 清記憶體。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { consumeTurn, quotaStatus, _resetQuotaCache } from "./quota.mjs";
import { rootsFor } from "./users.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-quota-test-"));
}
function quotaFileFor(dataRoot, user) {
  return path.join(rootsFor(user, { dataRoot }).sessionsRoot, "quota.json");
}

test("配額耗盡:limit N 內放行、第 N+1 擋、remaining 遞減", () => {
  _resetQuotaCache();
  const dataRoot = makeRoot();
  const user = "demo-aaaa1111";
  const results = [];
  for (let i = 0; i < 3; i++) results.push(consumeTurn(user, { limit: 3, dataRoot }));
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0]);
  const over = consumeTurn(user, { limit: 3, dataRoot });
  assert.equal(over.ok, false);
  assert.equal(over.used, 3);
  assert.equal(over.remaining, 0);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("磁碟往返:清記憶體後從 quota.json 續數,不歸零", () => {
  _resetQuotaCache();
  const dataRoot = makeRoot();
  const user = "demo-bbbb2222";
  consumeTurn(user, { limit: 10, dataRoot });
  consumeTurn(user, { limit: 10, dataRoot });
  // 檔案已落盤
  assert.equal(fs.existsSync(quotaFileFor(dataRoot, user)), true);
  _resetQuotaCache(); // 模擬重啟:記憶體 Map 清空
  const r = consumeTurn(user, { limit: 10, dataRoot });
  assert.equal(r.used, 3); // 從磁碟的 2 續到 3,而非從 1 重數
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("壞檔容錯:quota.json 壞 → 當全新,不 throw", () => {
  _resetQuotaCache();
  const dataRoot = makeRoot();
  const user = "demo-cccc3333";
  const file = quotaFileFor(dataRoot, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ 這不是 JSON");
  const r = consumeTurn(user, { limit: 5, dataRoot });
  assert.equal(r.ok, true);
  assert.equal(r.used, 1); // 壞檔視為 count=0 → 這回合是第 1
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("limit=0 → 不限;quotaStatus 唯讀不遞增", () => {
  _resetQuotaCache();
  const dataRoot = makeRoot();
  const user = "demo-dddd4444";
  for (let i = 0; i < 50; i++) assert.equal(consumeTurn(user, { limit: 0, dataRoot }).ok, true);
  // limit=0 不落盤計數 → quotaStatus used 恆 0
  assert.equal(quotaStatus(user, { limit: 0, dataRoot }).used, 0);
  // 有限額時 quotaStatus 讀計數但不改它
  _resetQuotaCache();
  consumeTurn(user, { limit: 5, dataRoot });
  const s1 = quotaStatus(user, { limit: 5, dataRoot });
  const s2 = quotaStatus(user, { limit: 5, dataRoot });
  assert.equal(s1.used, 1);
  assert.equal(s2.used, 1); // 沒被 status 查詢推高
  assert.equal(s1.remaining, 4);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("不同身分各自獨立配額(檔路徑為鍵)", () => {
  _resetQuotaCache();
  const dataRoot = makeRoot();
  consumeTurn("demo-a", { limit: 2, dataRoot });
  consumeTurn("demo-a", { limit: 2, dataRoot });
  // demo-a 已滿,demo-b 全新
  assert.equal(consumeTurn("demo-a", { limit: 2, dataRoot }).ok, false);
  assert.equal(consumeTurn("demo-b", { limit: 2, dataRoot }).ok, true);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
