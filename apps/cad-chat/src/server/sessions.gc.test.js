// gcSessions 單元測(node --test):過期刪、未過期留、頂層子項 mtime 算「動過」、
// 停用態、root 不存在。用 tmp root + utimesSync 控時間,不碰真 SESSIONS_ROOT。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { gcSessions } from "./sessions.mjs";

const DAY = 24 * 60 * 60 * 1000;

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-gc-test-"));
}

function makeSession(root, name, ageMs, now, { freshChild = false } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "part.py"), "PARAMS = {}\n");
  const old = new Date(now - ageMs);
  fs.utimesSync(path.join(dir, "part.py"), old, old);
  if (freshChild) {
    fs.writeFileSync(path.join(dir, "fresh.step"), "ISO-10303-21;\n");
    // fresh.step 保持現在的 mtime → 目錄視為「有動過」
  }
  fs.utimesSync(dir, old, old);
  return dir;
}

test("過期 session 刪、未過期留", () => {
  const root = makeRoot();
  const now = Date.now();
  makeSession(root, "s_old", 10 * DAY, now);
  makeSession(root, "s_new", 2 * DAY, now);
  const removed = gcSessions({ root, maxAgeDays: 7, now });
  assert.deepEqual(removed, ["s_old"]);
  assert.equal(fs.existsSync(path.join(root, "s_old")), false);
  assert.equal(fs.existsSync(path.join(root, "s_new")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("目錄 mtime 舊但頂層子項新 → 視為有動過,保留", () => {
  const root = makeRoot();
  const now = Date.now();
  makeSession(root, "s_active", 30 * DAY, now, { freshChild: true });
  const removed = gcSessions({ root, maxAgeDays: 7, now });
  assert.deepEqual(removed, []);
  assert.equal(fs.existsSync(path.join(root, "s_active")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("停用(0/負/NaN)與 root 不存在都安全回空", () => {
  const root = makeRoot();
  const now = Date.now();
  makeSession(root, "s_old", 30 * DAY, now);
  assert.deepEqual(gcSessions({ root, maxAgeDays: 0, now }), []);
  assert.deepEqual(gcSessions({ root, maxAgeDays: -1, now }), []);
  assert.deepEqual(gcSessions({ root, maxAgeDays: Number.NaN, now }), []);
  assert.equal(fs.existsSync(path.join(root, "s_old")), true);
  assert.deepEqual(gcSessions({ root: path.join(root, "nope"), maxAgeDays: 7, now }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("非目錄項目略過", () => {
  const root = makeRoot();
  const now = Date.now();
  const stray = path.join(root, "stray.json");
  fs.writeFileSync(stray, "{}");
  const old = new Date(now - 30 * DAY);
  fs.utimesSync(stray, old, old);
  const removed = gcSessions({ root, maxAgeDays: 7, now });
  assert.deepEqual(removed, []);
  assert.equal(fs.existsSync(stray), true);
  fs.rmSync(root, { recursive: true, force: true });
});
