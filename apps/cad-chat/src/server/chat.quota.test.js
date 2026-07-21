// DEMO 配額 + fail-closed 整合測(L1,startServer({port:0}) 真 HTTP 打)。
// 只驗「回合開跑前」的確定性 JSON 路徑(429 超額 / 503 無 key),不進 runTurn(不燒 LLM);
// 非 demo 不受閘限則以 AbortController 讀到狀態即中止(避免真的 spawn agent)。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DATA_ROOT } from "./config.mjs";
import { startServer } from "./start.mjs";
import { rootsFor } from "./users.mjs";
import { _resetQuotaCache } from "./quota.mjs";

function uniq(p) {
  return `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function seedQuota(user, count) {
  const file = path.join(rootsFor(user).sessionsRoot, "quota.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ count }));
  return path.join(DATA_ROOT, "users", user);
}
async function postChat(url, user, body, { signal } = {}) {
  return fetch(`${url}api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-remote-user": user },
    body: JSON.stringify(body),
    signal,
  });
}

test("DEMO 配額 + fail-closed 閘(在 runTurn 之前)", async () => {
  // 快照並設定 env:agentReady 需全域認證為真(否則 503 agent_not_ready 遮住 429)。
  const snap = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CADCHAT_DEMO_API_KEY: process.env.CADCHAT_DEMO_API_KEY,
    CADCHAT_DEMO_QUOTA: process.env.CADCHAT_DEMO_QUOTA,
    CADCHAT_DEMO_ALLOW_OAUTH: process.env.CADCHAT_DEMO_ALLOW_OAUTH,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  process.env.ANTHROPIC_API_KEY = "sk-fake-global-for-test";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CADCHAT_DEMO_ALLOW_OAUTH; // 確保 Test B 的 fail-closed 不被環境誤開
  process.env.CADCHAT_DEMO_QUOTA = "1";
  _resetQuotaCache();

  const demoOver = uniq("demo-over");
  const demoNoKey = uniq("demo-nokey");
  const seeded = [];
  const { url, close } = await startServer({ dev: false, port: 0 });
  try {
    // A) demo 超額 → 429 demo_quota_exceeded(demo key 已設 → 通過 fail-closed 到配額)
    process.env.CADCHAT_DEMO_API_KEY = "sk-demo-fake";
    seeded.push(seedQuota(demoOver, 1)); // count=1、limit=1 → 已滿
    _resetQuotaCache(); // 讓 server 重新從磁碟 hydrate 我 seed 的檔
    const rA = await postChat(url, demoOver, { message: "hi" });
    const jA = await rA.json();
    assert.equal(rA.status, 429, "demo 超額該 429");
    assert.equal(jA.error, "demo_quota_exceeded");
    assert.equal(jA.limit, 1);

    // B) demo 但 demo key 未設 → 503 demo_unavailable,絕不走訂閱
    delete process.env.CADCHAT_DEMO_API_KEY;
    const rB = await postChat(url, demoNoKey, { message: "hi" });
    const jB = await rB.json();
    assert.equal(rB.status, 503, "demo 無 key 該 503");
    assert.equal(jB.error, "demo_unavailable");

    // C) 非 demo(test)不受 demo 閘限:即使全域 demo 配額狀態存在也不 429/503。
    //    會開 SSE(200)後進 runTurn → 讀到狀態即 abort,避免真的 spawn agent。
    process.env.CADCHAT_DEMO_API_KEY = "sk-demo-fake";
    const ac = new AbortController();
    let statusC = null;
    try {
      const rC = await postChat(url, "test", { message: "hi" }, { signal: ac.signal });
      statusC = rC.status;
      ac.abort(); // 讀到 header 即中止,server 端 sse.onClose → 回合 abort
    } catch (err) {
      if (err?.name !== "AbortError") throw err;
    }
    if (statusC !== null) {
      assert.notEqual(statusC, 429, "非 demo 不該被配額擋");
      assert.notEqual(statusC, 503, "非 demo 不該被 demo_unavailable 擋");
    }
  } finally {
    await close();
    for (const dir of seeded) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(DATA_ROOT, "users", "test"), { recursive: true, force: true });
    _resetQuotaCache();
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
