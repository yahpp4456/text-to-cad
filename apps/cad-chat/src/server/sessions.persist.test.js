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

test("舊快照帶 outputMode(雙模式時代遺留)→ hydrate 靜默忽略不炸", () => {
  const id = freshId("legacyMode");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "foo.py"), "PARAMS = {}\n");
    // 直接補寫舊版欄位進 session.json(persistSession 已不再寫 outputMode)
    persistSession({ workdir: dir, lastName: "foo", version: 1 });
    const metaPath = path.join(dir, "session.json");
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    raw.outputMode = "actual";
    fs.writeFileSync(metaPath, JSON.stringify(raw));

    const s = getOrCreateSession(id);
    assert.equal(s.lastName, "foo"); // 其餘欄位照常還原
    assert.equal(s.outputMode, undefined); // 遺留欄位不進 session
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

// ── mode(草模/設計)persist/hydrate ──

test("mint 帶 opts.mode=sketch → 新 session 是草模;既有 session 忽略 opts", () => {
  const idA = freshId("modeMint");
  const idB = freshId("modeKeep");
  try {
    const a = getOrCreateSession(idA, { mode: "sketch" });
    assert.equal(a.mode, "sketch");
    const b = getOrCreateSession(idB); // 預設 design
    assert.equal(b.mode, "design");
    const b2 = getOrCreateSession(idB, { mode: "sketch" }); // 既有 session:opts 無效
    assert.equal(b2.mode, "design");
    const c = getOrCreateSession(freshId("modeBogus"), { mode: "bogus" });
    assert.equal(c.mode, "design"); // 非法值收斂 design
    fs.rmSync(c.workdir, { recursive: true, force: true });
  } finally {
    fs.rmSync(path.join(SESSIONS_ROOT, idA), { recursive: true, force: true });
    fs.rmSync(path.join(SESSIONS_ROOT, idB), { recursive: true, force: true });
  }
});

test("草模 session persist→hydrate:產物守衛認 .sketch.json,全欄位還原", () => {
  const id = freshId("modeSketch");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "mech.sketch.json"), '{"schemaVersion":1}');
    persistSession({
      workdir: dir,
      mode: "sketch",
      sdkSessionId: "uuid-sk",
      version: 3,
      lastName: "mech",
      lastPartCount: 0,
      rehydratedFrom: null,
      imports: [],
    });
    const s = getOrCreateSession(id);
    assert.equal(s.mode, "sketch");
    assert.equal(s.version, 3);
    assert.equal(s.lastName, "mech");
    assert.equal(s.sdkSessionId, "uuid-sk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("草模 session GC 殘缺(.sketch.json 不在)→ 不還原產物欄位,但 mode 仍是 sketch", () => {
  const id = freshId("modeGcd");
  const dir = makeDir(id);
  try {
    persistSession({
      workdir: dir,
      mode: "sketch",
      sdkSessionId: "uuid-dead",
      version: 7,
      lastName: "mech", // 但 mech.sketch.json 不存在
    });
    const s = getOrCreateSession(id);
    assert.equal(s.mode, "sketch"); // mode 是身分,在產物守衛之前還原
    assert.equal(s.sdkSessionId, null);
    assert.equal(s.version, 0);
    assert.equal(s.lastName, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("舊 session.json 無 mode 欄位(legacy)→ hydrate 收斂 design", () => {
  const id = freshId("modeLegacy");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "foo.py"), "PARAMS = {}\n");
    persistSession({ workdir: dir, lastName: "foo", version: 1 });
    const metaPath = path.join(dir, "session.json");
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    delete raw.mode; // 模擬本功能落地前寫下的 session.json
    fs.writeFileSync(metaPath, JSON.stringify(raw));
    const s = getOrCreateSession(id);
    assert.equal(s.mode, "design");
    assert.equal(s.lastName, "foo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probeSessionOnDisk:回 mode 與 hasSketch(草模 session 的開機還原放行訊號)", () => {
  const id = freshId("modeProbe");
  const dir = makeDir(id);
  try {
    fs.writeFileSync(path.join(dir, "mech.sketch.json"), '{"schemaVersion":1}');
    persistSession({ workdir: dir, mode: "sketch", lastName: "mech", version: 2 });
    const info = probeSessionOnDisk(id);
    assert.equal(info.exists, true);
    assert.equal(info.mode, "sketch");
    assert.equal(info.hasSketch, true);
    assert.equal(info.hasGenerator, false);
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

test("library session mint→persist→重掛仍保留 library mode", async () => {
  const id = freshId("modeLibrary");
  const dir = path.join(SESSIONS_ROOT, id);
  try {
    const session = getOrCreateSession(id, { mode: "library" });
    assert.equal(session.mode, "library");

    persistSession(session);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
    assert.equal(meta.mode, "library");

    // cache-busted module 模擬重啟後 registry 清空。
    const freshSessions = await import(`./sessions.mjs?library-hydrate=${id}`);
    const hydrated = freshSessions.getOrCreateSession(id);
    assert.equal(hydrated.mode, "library");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
