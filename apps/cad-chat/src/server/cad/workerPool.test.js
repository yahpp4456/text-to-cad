// worker 池的行為測試。用假 worker(fakeWorker.fixture.mjs,真的子行程、同一套 frame
// 協定,但不載入 Python)驗 supervisor 邏輯:派送、排隊、親和、中止、崩潰、退休、
// 啟動失敗退避、程式碼過期換新、關閉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createWorkerPool, defaultRssCapMb, pySourceFingerprint } from "./workerPool.mjs";

const FAKE = fileURLToPath(new URL("./fakeWorker.fixture.mjs", import.meta.url));

function makePool(t, opts = {}, env = {}) {
  const logs = [];
  const pool = createWorkerPool({
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, ...env },
    idleMs: 0, // 測試預設不做閒置回收
    rssCapMb: 0, // 測試預設不做記憶體退休
    spare: false,
    log: (line) => logs.push(line),
    ...opts,
  });
  t.after(() => pool.dispose());
  return { pool, logs };
}

const pidOf = (result) => Number(String(result.stdout).split(" ")[0]);
const live = (pool) => pool.stats().workers.filter((w) => w.state !== "retiring");

async function until(predicate, { timeoutMs = 8000, what = "條件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等不到:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("run:回傳與 spawn 同形的 {code, stdout, stderr},argv 與 cwd 原樣送達", async (t) => {
  const { pool } = makePool(t);
  const result = await pool.run({ script: "echo", argv: ["a", 2, "繁中"], cwd: "C:/data" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\d+ a 2 繁中$/);
  assert.equal(result.stderr, "err C:/data");
});

test("run:腳本的非零 exit code 原樣回傳,worker 繼續可用", async (t) => {
  const { pool } = makePool(t);
  const first = await pool.run({ script: "exit:2" });
  assert.equal(first.code, 2);
  const second = await pool.run({ script: "echo" });
  assert.equal(second.code, 0);
  assert.equal(pidOf(second), pidOf(first), "同一個 worker 接著服務");
});

test("run:onAcquire / onRelease 各呼叫一次,拿到同一個 child", async (t) => {
  const { pool } = makePool(t);
  const seen = [];
  const result = await pool.run({
    script: "echo",
    onAcquire: (child) => seen.push(["acquire", child.pid]),
    onRelease: (child) => seen.push(["release", child.pid]),
  });
  assert.deepEqual(seen, [
    ["acquire", pidOf(result)],
    ["release", pidOf(result)],
  ]);
});

test("排隊:maxWorkers=1 時請求依序完成,全程只有一個 worker", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 1 });
  const order = [];
  const results = await Promise.all(
    ["sleep:60", "sleep:5", "echo"].map((script, i) =>
      pool.run({ script, argv: [i] }).then((r) => {
        order.push(i);
        return r;
      }),
    ),
  );
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(new Set(results.map(pidOf)).size, 1);
  assert.equal(live(pool).length, 1);
});

test("並行:一個 worker 忙碌時,另一個閒置的立刻接下一個請求", async (t) => {
  // 不靠計時:先確定「一忙一閒」的狀態成立,再送第二個請求。(原本的寫法是同時送兩個
  // sleep:80,賭第二個 worker 會在 80ms 內暖好;機器忙的時候第一個先做完、同一個 worker
  // 接走第二個,測試就紅。)
  const { pool } = makePool(t, { maxWorkers: 2, spare: true });
  const controller = new AbortController();
  const busy = pool.run({ script: "hang", signal: controller.signal });
  await until(() => live(pool).some((w) => w.state === "busy") && live(pool).some((w) => w.state === "idle"), {
    what: "一個忙碌、一個閒置",
  });
  const busyPid = pool.stats().workers.find((w) => w.state === "busy").pid;
  const other = await pool.run({ script: "echo" });
  assert.equal(other.code, 0);
  assert.notEqual(pidOf(other), busyPid, "沒有排在忙碌的 worker 後面等");
  controller.abort();
  await busy;
});

test("並行:同時進來的兩個請求不會超過 maxWorkers,且都完成", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 2 });
  const results = await Promise.all([pool.run({ script: "sleep:80" }), pool.run({ script: "sleep:80" })]);
  assert.deepEqual(
    results.map((r) => r.code),
    [0, 0],
  );
  assert.ok(live(pool).length <= 2);
});

test("備用:spare 開啟時,請求進行中會另外暖一個;關閉時不會", async (t) => {
  const withSpare = makePool(t, { spare: true, maxWorkers: 3 }).pool;
  const running = withSpare.run({ script: "sleep:300" });
  await until(() => live(withSpare).length === 2, { what: "備用 worker 啟動" });
  await running;
  assert.equal(live(withSpare).length, 2, "不會超過「忙碌 + 1」");

  const noSpare = makePool(t, { spare: false, maxWorkers: 3 }).pool;
  await noSpare.run({ script: "sleep:100" });
  assert.equal(live(noSpare).length, 1);
});

test("prewarm:沒有請求也先暖一個,重複呼叫不會多起", async (t) => {
  const { pool } = makePool(t);
  pool.prewarm();
  pool.prewarm();
  await until(() => live(pool).some((w) => w.state === "idle"), { what: "預熱完成" });
  pool.prewarm();
  assert.equal(live(pool).length, 1);
});

test("親和:同一個 key 回到上次的 worker;沒用過的 key 優先拿沒被認領的", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 2 });
  const [a1, b1] = await Promise.all([
    pool.run({ script: "sleep:50", key: "A" }),
    pool.run({ script: "sleep:50", key: "B" }),
  ]);
  assert.notEqual(pidOf(a1), pidOf(b1));
  // 反過來的順序送,仍各自回到原本的 worker
  const b2 = await pool.run({ script: "echo", key: "B" });
  const a2 = await pool.run({ script: "echo", key: "A" });
  assert.equal(pidOf(a2), pidOf(a1));
  assert.equal(pidOf(b2), pidOf(b1));
});

test("中止(進行中):回 code 1,worker 被砍,下一個請求由新 worker 服務", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 1 });
  const warm = await pool.run({ script: "echo" });
  const controller = new AbortController();
  const released = [];
  const running = pool.run({ script: "hang", signal: controller.signal, onRelease: (c) => released.push(c.pid) });
  setTimeout(() => controller.abort(), 40);
  const aborted = await running;
  assert.equal(aborted.code, 1);
  assert.deepEqual(released, [pidOf(warm)], "中止也會釋放 child");
  const next = await pool.run({ script: "echo" });
  assert.equal(next.code, 0);
  assert.notEqual(pidOf(next), pidOf(warm));
});

test("中止(排隊中):立刻回 code 1,不影響正在跑的請求", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 1 });
  const first = pool.run({ script: "sleep:150" });
  const controller = new AbortController();
  const queued = pool.run({ script: "echo", signal: controller.signal });
  controller.abort();
  assert.deepEqual(await queued, { code: 1, stdout: "", stderr: "" });
  assert.equal((await first).code, 0);
});

test("中止:送出前就已中止的 signal 直接回 code 1,不啟動 worker", async (t) => {
  const { pool } = makePool(t);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await pool.run({ script: "echo", signal: controller.signal }), { code: 1, stdout: "", stderr: "" });
  assert.equal(live(pool).length, 0);
});

test("中止:砍行程較慢、done 先到時,結果照收但該 worker 不再接請求", async (t) => {
  // 模擬 Windows taskkill 的非同步:killFn 延後 250ms 才真的砍。
  const { pool } = makePool(t, {
    maxWorkers: 2,
    killFn: (child) => setTimeout(() => child.kill("SIGKILL"), 250),
  });
  const controller = new AbortController();
  const running = pool.run({ script: "sleep:80", signal: controller.signal });
  await until(() => live(pool).some((w) => w.state === "busy"), { what: "請求開始執行" });
  controller.abort();
  const result = await running;
  assert.equal(result.code, 0, "done 比行程結束早到:照實回傳");
  const next = await pool.run({ script: "echo" });
  assert.equal(next.code, 0);
  assert.notEqual(pidOf(next), pidOf(result), "被判死刑的 worker 沒有被派到下一個請求");
});

test("外部砍行程(interrupt 的做法):標了 cadKilled 的 child 做完手上這件後不再接請求", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 2 });
  let child;
  const running = pool.run({ script: "sleep:80", onAcquire: (c) => (child = c) });
  await until(() => child != null, { what: "取得 child" });
  child.cadKilled = true; // killTree 會標這個;這裡不真的砍,模擬「砍得比 done 慢」
  const result = await running;
  const next = await pool.run({ script: "echo" });
  assert.notEqual(pidOf(next), pidOf(result));
});

test("崩潰:請求進行中行程結束 → 回它的 exit code 與死前寫出的輸出,池自動恢復", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 1 });
  const crashed = await pool.run({ script: "crash:7" });
  assert.equal(crashed.code, 7);
  assert.equal(crashed.stdout, "partial out");
  assert.match(crashed.stderr, /^Fatal Python error: fake\n/);
  assert.match(crashed.stderr, /\[cad-worker\] 行程在請求進行中結束\(exit code 7\)$/);
  const next = await pool.run({ script: "echo" });
  assert.equal(next.code, 0);
});

test("failed frame:回 code -1 與訊息,worker 繼續可用", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 1 });
  const failed = await pool.run({ script: "fail" });
  assert.deepEqual(failed, { code: -1, stdout: "", stderr: "[cad-worker] boom" });
  assert.equal((await pool.run({ script: "echo" })).code, 0);
});

test("記憶體退休:回報的 rssMb 超過上限 → 該請求照常完成,之後換新 worker", async (t) => {
  const { pool, logs } = makePool(t, { maxWorkers: 1, rssCapMb: 100 });
  const big = await pool.run({ script: "rss:500" });
  assert.equal(big.code, 0);
  const next = await pool.run({ script: "echo" });
  assert.notEqual(pidOf(next), pidOf(big));
  assert.ok(logs.some((line) => line.includes("超過上限")));
  const small = await pool.run({ script: "rss:50" });
  const after = await pool.run({ script: "echo" });
  assert.equal(pidOf(after), pidOf(small), "沒超過上限就不換");
});

test("閒置回收:閒置超過 idleMs 的 worker 被回收,之後的請求照常(重新起一個)", async (t) => {
  const { pool } = makePool(t, { idleMs: 60 });
  const first = await pool.run({ script: "echo" });
  await until(() => live(pool).length === 0, { what: "閒置回收" });
  const second = await pool.run({ script: "echo" });
  assert.equal(second.code, 0);
  assert.notEqual(pidOf(second), pidOf(first));
});

test("程式碼過期:fingerprint 變了,閒置的舊 worker 被換掉", async (t) => {
  let version = 1;
  const { pool } = makePool(t, { maxWorkers: 1, fingerprint: () => version, fingerprintEveryMs: 0 });
  const before = await pool.run({ script: "echo" });
  const same = await pool.run({ script: "echo" });
  assert.equal(pidOf(same), pidOf(before), "指紋沒變:沿用");
  version = 2;
  const after = await pool.run({ script: "echo" });
  assert.notEqual(pidOf(after), pidOf(before));
});

test("程式碼過期:忙碌中的 worker 做完手上這件才換", async (t) => {
  let version = 1;
  const { pool } = makePool(t, { maxWorkers: 1, fingerprint: () => version, fingerprintEveryMs: 0 });
  const running = pool.run({ script: "sleep:100" });
  await until(() => live(pool).some((w) => w.state === "busy"), { what: "請求開始執行" });
  version = 2;
  const queued = pool.run({ script: "echo" }); // 觸發一次檢查
  const first = await running;
  assert.equal(first.code, 0, "進行中的請求不受影響");
  assert.notEqual(pidOf(await queued), pidOf(first));
});

test("啟動失敗:連續兩次起不來 → run 回 null(呼叫端改走 spawn),退避期間直接回 null", async (t) => {
  const { pool, logs } = makePool(t, {}, { FAKE_BOOT: "exit" });
  assert.equal(await pool.run({ script: "echo" }), null);
  assert.ok(pool.stats().disabledForMs > 0);
  assert.equal(await pool.run({ script: "echo" }), null);
  assert.ok(logs.some((line) => line.includes("連續啟動失敗")));
});

test("啟動失敗:worker 回 ready:false 同樣算失敗", async (t) => {
  const { pool, logs } = makePool(t, {}, { FAKE_BOOT: "refuse" });
  assert.equal(await pool.run({ script: "echo" }), null);
  assert.ok(logs.some((line) => line.includes("refused by FAKE_BOOT")));
});

test("啟動失敗:遲遲不 ready 的 worker 逾時被砍", async (t) => {
  const { pool, logs } = makePool(t, { startTimeoutMs: 80 }, { FAKE_BOOT: "never" });
  assert.equal(await pool.run({ script: "echo" }), null);
  assert.ok(logs.some((line) => line.includes("啟動逾時")));
});

test("啟動失敗:指令不存在(spawn error)也回 null", async (t) => {
  const { pool } = makePool(t, { command: "definitely-not-a-real-executable-cadchat" });
  assert.equal(await pool.run({ script: "echo" }), null);
});

test("啟動失敗後退避結束即恢復", async (t) => {
  let clock = 1_000_000;
  const env = { ...process.env, FAKE_BOOT: "exit" };
  const pool = createWorkerPool({
    command: process.execPath,
    args: [FAKE],
    env,
    idleMs: 0,
    rssCapMb: 0,
    spare: false,
    now: () => clock,
  });
  t.after(() => pool.dispose());
  assert.equal(await pool.run({ script: "echo" }), null);
  delete env.FAKE_BOOT; // 之後起的 worker 是好的
  assert.equal(await pool.run({ script: "echo" }), null, "退避期間不嘗試");
  clock += 61_000;
  assert.equal((await pool.run({ script: "echo" })).code, 0);
});

test("dispose:worker 全部結束,排隊與之後的請求回 null", async (t) => {
  const { pool } = makePool(t, { maxWorkers: 1 });
  await pool.run({ script: "echo" });
  const running = pool.run({ script: "hang" });
  const queued = pool.run({ script: "echo" });
  await until(() => pool.stats().pending === 1, { what: "第二個請求排隊" });
  await pool.dispose();
  assert.equal(await queued, null);
  assert.notEqual((await running).code, 0, "進行中的請求以失敗收尾");
  assert.equal(await pool.run({ script: "echo" }), null);
  assert.equal(pool.stats().workers.length, 0);
});

test("defaultRssCapMb:實體記憶體的四分之一,至少 2048", () => {
  assert.equal(defaultRssCapMb(64 * 2 ** 30), 16384);
  assert.equal(defaultRssCapMb(4 * 2 ** 30), 2048);
});

test("pySourceFingerprint:目錄不存在視為空;同一目錄兩次相同", () => {
  assert.equal(pySourceFingerprint(["Z:/no/such/dir/cadchat"]), "0:0");
  const dir = fileURLToPath(new URL("../../../py", import.meta.url));
  const first = pySourceFingerprint([dir]);
  assert.match(first, /^[1-9]\d*:\d/);
  assert.equal(pySourceFingerprint([dir]), first);
});
