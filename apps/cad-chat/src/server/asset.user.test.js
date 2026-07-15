// /api/asset 租戶邊界 + userContext middleware 整合測(L1,照 start.test.js 模式:
// startServer({port:0}) 真 HTTP 打)。dev DATA_ROOT=repo 根 → 測試在 users/u_test_*
// 下造真檔,finally 清理。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DATA_ROOT, MODELS_FIXTURES_ROOT, MODELS_ROOT } from "./config.mjs";
import { startServer } from "./start.mjs";

function uniq(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 找 fixtures 層裡任一真檔(相對 rel;LFS pointer 也算檔)。佈局無關:
// dev 同根(fixtures===MODELS_ROOT)與 packaged/測試沙盒雙根都適用。
function findFixtureFile(dir = MODELS_FIXTURES_ROOT, rel = "", depth = 0) {
  if (depth > 3) return null;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of ents) {
    if (ent.name.startsWith(".") || ent.name === "__pycache__") continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isFile()) return r;
    if (ent.isDirectory()) {
      const hit = findFixtureFile(path.join(dir, ent.name), r, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function getStatus(url, file, user) {
  const headers = user ? { "x-remote-user": user } : {};
  const res = await fetch(`${url}api/asset?file=${encodeURIComponent(file)}`, { headers });
  await res.arrayBuffer(); // 排水
  return res.status;
}

test("asset 租戶邊界:本人 200 / 他人 403 / 無 header 403 / 穿越 403 / fixtures 兜底 200", async () => {
  const userA = uniq("u_test_a");
  const userB = uniq("u_test_b");
  const aDir = path.join(DATA_ROOT, "users", userA, "models");
  const legacyTmp = path.join(MODELS_ROOT, `${uniq("tmp_asset")}.json`);
  const { url, close } = await startServer({ dev: false, port: 0 });
  try {
    fs.mkdirSync(aDir, { recursive: true });
    fs.writeFileSync(path.join(aDir, "hello.json"), "{}");
    fs.mkdirSync(MODELS_ROOT, { recursive: true }); // 測試沙盒 DATA_ROOT 下可能尚無 models/
    fs.writeFileSync(legacyTmp, "{}");

    const aFile = `users/${userA}/models/hello.json`;
    // 本人讀本人(emit URL 的 workdirRel 形)
    assert.equal(await getStatus(url, aFile, userA), 200);
    // 他人讀 → 403(租戶檢查,非 404:不洩漏存在性)
    assert.equal(await getStatus(url, aFile, userB), 403);
    // 無 header(legacy)讀 users/ 形 → 一律 403
    assert.equal(await getStatus(url, aFile, null), 403);
    // 穿越:users/<A>/models/../../<B>/... → resolveInside 擋 403
    assert.equal(
      await getStatus(url, `users/${userA}/models/../../${userB}/models/x.json`, userA),
      403,
    );
    // user 空間沒有 → 雙根兜底到共用 fixtures 層 → 200(挑 fixtures 層現存真檔,
    // dev 同根與沙盒雙根皆成立;fixtures 層空了才略過——不該發生)
    const fixture = findFixtureFile();
    if (fixture) assert.equal(await getStatus(url, fixture, userA), 200);
    // 無 header legacy 讀可寫層檔 → 200(零回歸)
    assert.equal(await getStatus(url, path.basename(legacyTmp), null), 200);

    // userContext:壞使用者名(白名單外)任何端點 403;合法 header 照常 200
    const bad = await fetch(`${url}api/health`, { headers: { "x-remote-user": "../evil" } });
    assert.equal(bad.status, 403);
    const good = await fetch(`${url}api/health`, { headers: { "x-remote-user": userA } });
    assert.equal(good.status, 200);
  } finally {
    await close();
    fs.rmSync(path.join(DATA_ROOT, "users", userA), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_ROOT, "users", userB), { recursive: true, force: true });
    fs.rmSync(legacyTmp, { force: true });
  }
});

test("session-info 跨 user:A 的 live session,B/無 header 探 → exists:false", async () => {
  const userA = uniq("u_test_a");
  const userB = uniq("u_test_b");
  const { url, close } = await startServer({ dev: false, port: 0 });
  try {
    // 用 upload-image 端點最小 mint?不必——直接打 session-info 探不存在 id 即可驗
    // user 維度(mint 流程由 sessions.user.test.js 覆蓋)。這裡驗 HTTP 層 user 穿線:
    // 同一個(不存在的)id,各 user 都 exists:false 且不互相污染。
    const id = uniq("s_test");
    for (const u of [userA, userB, null]) {
      const headers = u ? { "x-remote-user": u } : {};
      const res = await fetch(`${url}api/session-info?id=${id}`, { headers });
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.equal(j.exists, false);
    }
    // 磁碟造 A 的 session → 只有 A 探得到(HTTP 層真正的跨 user 斷言)
    const wd = path.join(DATA_ROOT, "users", userA, "models", ".cadchat", id);
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(
      path.join(wd, "session.json"),
      JSON.stringify({ mode: "design", version: 1, savedAt: 0 }),
    );
    const probeAs = async (u) => {
      const headers = u ? { "x-remote-user": u } : {};
      const res = await fetch(`${url}api/session-info?id=${id}`, { headers });
      return (await res.json()).exists;
    };
    assert.equal(await probeAs(userA), true);
    assert.equal(await probeAs(userB), false);
    assert.equal(await probeAs(null), false);
  } finally {
    await close();
    fs.rmSync(path.join(DATA_ROOT, "users", userA), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_ROOT, "users", userB), { recursive: true, force: true });
  }
});
