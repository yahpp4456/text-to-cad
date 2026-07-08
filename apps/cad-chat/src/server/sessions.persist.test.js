// persistSession / hydrate / probeSessionOnDisk 單元測(node --test)。
// hydrate 走真 getOrCreateSession(SESSIONS_ROOT 下開唯一測試 id,結束即刪),
// 模擬「重啟後 Map 空、同 id 重掛」的路徑。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { SESSIONS_ROOT } from "./config.mjs";
import { getOrCreateSession, persistSession, probeSessionOnDisk } from "./sessions.mjs";

function freshId(tag) {
  return `s_test_${tag}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeDir(id) {
  const dir = path.join(SESSIONS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("persist → 同 id 重掛還原全欄位(含 _resumedFromDisk)", () => {
  const id = freshId("full");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "foo.py"), "PARAMS = {}\n");
    fs.mkdirSync(path.join(dir, "imported"), { recursive: true });
    fs.writeFileSync(path.join(dir, "imported", "a.step"), "ISO-10303-21;\n");
    persistSession({
      workdir: dir,
      sdkSessionId: "uuid-abc",
      version: 5,
      lastName: "foo",
      lastPartCount: 3,
      rehydratedFrom: "some_project",
      imports: ["imported/a.step", "imported/gone.step"],
    });
    const s = getOrCreateSession(id); // Map 沒有這 id → 走 hydrate
    assert.equal(s.sessionId, id);
    assert.equal(s.sdkSessionId, "uuid-abc");
    assert.equal(s.version, 5);
    assert.equal(s.lastName, "foo");
    assert.equal(s.lastPartCount, 3);
    assert.equal(s.rehydratedFrom, "some_project");
    assert.deepEqual(s.imports, ["imported/a.step"]); // 消失的 import 被過濾
    assert.equal(s._resumedFromDisk, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("產物該在而不在(GC 殘缺)→ 什麼都不還原,尤其 sdkSessionId", () => {
  const id = freshId("gcd");
  const dir = makeDir(id);
  try {
    persistSession({
      workdir: dir,
      sdkSessionId: "uuid-dead",
      version: 9,
      lastName: "bar", // 但 bar.py 不存在
      lastPartCount: 2,
      rehydratedFrom: null,
      imports: [],
    });
    const s = getOrCreateSession(id);
    assert.equal(s.sdkSessionId, null);
    assert.equal(s.version, 0);
    assert.equal(s.lastName, null);
    assert.notEqual(s._resumedFromDisk, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chat-only(還沒 build 過)→ 還原 sdkSessionId(transcript 不引用檔案,安全)", () => {
  const id = freshId("chatonly");
  const dir = makeDir(id);
  try {
    persistSession({
      workdir: dir,
      sdkSessionId: "uuid-chat",
      version: 0,
      lastName: null,
      lastPartCount: 0,
      rehydratedFrom: null,
      imports: [],
    });
    const s = getOrCreateSession(id);
    assert.equal(s.sdkSessionId, "uuid-chat");
    assert.equal(s.version, 0);
    assert.equal(s._resumedFromDisk, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session.json 缺/壞 → 乾淨新 session 不炸", () => {
  const id = freshId("nometa");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "session.json"), "{oops");
    const s = getOrCreateSession(id);
    assert.equal(s.sdkSessionId, null);
    assert.equal(s.version, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probeSessionOnDisk:不存在 / 存在含產物 / 非法 id;絕不建目錄", () => {
  const ghost = freshId("ghost");
  assert.deepEqual(probeSessionOnDisk(ghost), { exists: false });
  assert.equal(fs.existsSync(path.join(SESSIONS_ROOT, ghost)), false); // 探測不建目錄

  assert.deepEqual(probeSessionOnDisk("../../etc"), { exists: false });

  const id = freshId("probe");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "foo.py"), "PARAMS = {}\n");
    persistSession({
      workdir: dir,
      sdkSessionId: "u",
      version: 2,
      lastName: "foo",
      lastPartCount: 1,
      rehydratedFrom: null,
      imports: [],
    });
    const info = probeSessionOnDisk(id);
    assert.equal(info.exists, true);
    assert.equal(info.lastName, "foo");
    assert.equal(info.version, 2);
    assert.equal(info.hasGenerator, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
