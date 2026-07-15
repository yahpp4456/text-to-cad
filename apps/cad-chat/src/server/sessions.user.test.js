// user-aware session registry 單元測(node --test):Pattern C——真 DATA_ROOT +
// 唯一 u_test_*/s_test_* 名 + finally 清理(照 sessions.persist.test.js 慣例)。
// pin 三件事:per-user workdir/workdirRel 形狀(Python 不變量)、同 id 跨 user
// 不碰撞(反劫持)、probe 的 live-Map 與磁碟查詢都吃 user 維度。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DATA_ROOT } from "./config.mjs";
import {
  getOrCreateSession,
  getSession,
  persistSession,
  probeSessionOnDisk,
} from "./sessions.mjs";

function uniq(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function userDir(user) {
  return path.join(DATA_ROOT, "users", user);
}

test("per-user session:workdir 落 users/<u>/models/.cadchat/<id>,workdirRel 正斜線", () => {
  const user = uniq("u_test");
  const id = uniq("s_test");
  try {
    const s = getOrCreateSession(id, { user });
    assert.equal(s.user, user);
    assert.equal(s.workdir, path.join(DATA_ROOT, "users", user, "models", ".cadchat", id));
    // Python 不變量:workdirRel 是 DATA_ROOT 相對、正斜線(spawnPython cwd=DATA_ROOT)
    assert.equal(s.workdirRel, `users/${user}/models/.cadchat/${id}`);
    assert.equal(s.modelsRoot, path.join(DATA_ROOT, "users", user, "models"));
    assert.equal(fs.existsSync(s.workdir), true);
  } finally {
    fs.rmSync(userDir(user), { recursive: true, force: true });
  }
});

test("同 id 跨 user 不碰撞:各自 mint、互相 getSession miss(反劫持)", () => {
  const userA = uniq("u_test_a");
  const userB = uniq("u_test_b");
  const id = uniq("s_test");
  try {
    const sa = getOrCreateSession(id, { user: userA });
    // B 在自己空間拿同 id:必須是「全新」session(不同物件、不同 workdir)
    assert.equal(getSession(id, userB), null); // mint 前:B 空間查無此 id
    const sb = getOrCreateSession(id, { user: userB });
    assert.notEqual(sa, sb);
    assert.notEqual(sa.workdir, sb.workdir);
    // 各自空間查各自的
    assert.equal(getSession(id, userA), sa);
    assert.equal(getSession(id, userB), sb);
    // legacy 空間(無 user)查不到任何人的
    assert.equal(getSession(id, null), null);
  } finally {
    fs.rmSync(userDir(userA), { recursive: true, force: true });
    fs.rmSync(userDir(userB), { recursive: true, force: true });
  }
});

test("probeSessionOnDisk 吃 user 維度:本人 hit、他人 miss(live 與 disk-only 皆然)", () => {
  const userA = uniq("u_test_a");
  const userB = uniq("u_test_b");
  const idLive = uniq("s_test_live");
  const idDisk = uniq("s_test_disk");
  try {
    // live 變體:A mint 的活 session,B 探必須 exists:false(Map 查詢也要 user-scope)
    getOrCreateSession(idLive, { user: userA });
    assert.equal(probeSessionOnDisk(idLive, userA).exists, true);
    assert.equal(probeSessionOnDisk(idLive, userB).exists, false);
    assert.equal(probeSessionOnDisk(idLive, null).exists, false);

    // disk-only 變體:手工造 A 的落盤 session(不進 registry),模擬重啟後前端還原
    const wd = path.join(DATA_ROOT, "users", userA, "models", ".cadchat", idDisk);
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(
      path.join(wd, "session.json"),
      JSON.stringify({ mode: "design", version: 1, lastName: null, savedAt: 0 }),
    );
    assert.equal(probeSessionOnDisk(idDisk, userA).exists, true);
    assert.equal(probeSessionOnDisk(idDisk, userB).exists, false);
  } finally {
    fs.rmSync(userDir(userA), { recursive: true, force: true });
    fs.rmSync(userDir(userB), { recursive: true, force: true });
  }
});

test("persist → 重掛(同 user)還原中繼資料;legacy(無 user)行為照舊", () => {
  const user = uniq("u_test");
  const id = uniq("s_test");
  try {
    const s = getOrCreateSession(id, { user });
    s.version = 3;
    s.lastName = "part";
    fs.writeFileSync(path.join(s.workdir, "part.py"), "PARAMS = {}\n"); // 產物守衛要真檔
    persistSession(s);
    // 模擬重啟:繞 registry 直接驗磁碟(registry 是 module-global 清不掉,
    // hydrate 路徑由 sessions.persist.test.js 覆蓋;此處 pin「user 根下能 probe 回」)
    const probe = probeSessionOnDisk(id, user);
    assert.equal(probe.exists, true);
    assert.equal(probe.version, 3);
    assert.equal(probe.lastName, "part");
    assert.equal(probe.hasGenerator, true);
  } finally {
    fs.rmSync(userDir(user), { recursive: true, force: true });
  }
});
