// presentSketch / emitSketchPresent 單元測(node --test;零 spawn、零網路)。
// 檔名放 src/server/ 頂層讓既有 L1 glob(src/server/*.test.js)掃得到——
// src/server/sketch/ 子目錄不在 glob 內。tmp session dir 模式仿 sessions.persist.test.js。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DATA_ROOT, SESSIONS_ROOT } from "./config.mjs";
import { presentSketch } from "./sketch/present.mjs";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "lib", "sketch", "fixtures", "cylinder_tilt.json",
    ),
    "utf8",
  ),
);

function makeSession(tag) {
  const id = `s_test_skpr_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  const workdir = path.join(SESSIONS_ROOT, id);
  fs.mkdirSync(workdir, { recursive: true });
  return {
    sessionId: id,
    workdir,
    workdirRel: path.relative(DATA_ROOT, workdir).split(path.sep).join("/"),
    mode: "sketch",
    version: 0,
    lastName: null,
    lastPartCount: 0,
  };
}
const collector = () => {
  const events = [];
  return { events, emit: (ev, data) => events.push({ ev, data }) };
};

test("非法 scene → {ok:false, errors};不寫檔、不 bump、零事件(無半成品)", () => {
  const s = makeSession("bad");
  const { events, emit } = collector();
  try {
    const r = presentSketch(s, { name: "bad", scene: { schemaVersion: 1, bodies: [], drives: [] } }, emit);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors.every((e) => typeof e.message === "string"));
    assert.equal(fs.existsSync(path.join(s.workdir, "bad.sketch.json")), false);
    assert.equal(s.version, 0);
    assert.equal(s.lastName, null);
    assert.deepEqual(events, []);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("合法 scene → 寫檔+快照+三事件(type:sketch、sceneUrl、無 glbUrl/verified/mode)", () => {
  const s = makeSession("ok");
  const { events, emit } = collector();
  try {
    const r = presentSketch(s, { name: "mech", scene: FIXTURE }, emit);
    assert.equal(r.ok, true);
    assert.equal(r.ver, "v1");
    assert.equal(s.version, 1);
    assert.equal(s.lastName, "mech");
    // 磁碟斷言(別信 ok:true):頂層檔 + 快照 + meta
    const top = path.join(s.workdir, "mech.sketch.json");
    assert.ok(fs.statSync(top).size > 0);
    const snap = path.join(s.workdir, "versions", "v1", "mech.sketch.json");
    assert.ok(fs.statSync(snap).size > 0);
    const meta = JSON.parse(fs.readFileSync(path.join(s.workdir, "versions", "v1", "meta.json"), "utf8"));
    assert.equal(meta.type, "sketch");
    assert.equal(meta.name, "mech");
    assert.equal(meta.partCount, 3);
    // 磁碟上是 normalize 後的 canonical doc(有 home/speed 等預設)
    const disk = JSON.parse(fs.readFileSync(top, "utf8"));
    assert.equal(disk.drives[0].home, 0);
    // session.json 已落盤含 mode
    const sj = JSON.parse(fs.readFileSync(path.join(s.workdir, "session.json"), "utf8"));
    assert.equal(sj.mode, "sketch");
    assert.equal(sj.version, 1);
    // 三事件契約
    assert.deepEqual(events.map((e) => e.ev), ["artifact", "version", "present"]);
    const [art, ver, pres] = events.map((e) => e.data);
    assert.equal(art.type, "sketch");
    assert.deepEqual(art.formats, []);
    assert.equal(art.partCount, 3);
    assert.equal(art.joints.revolute, 1);
    assert.equal(ver.id, "v1");
    assert.equal(ver.type, "sketch");
    assert.equal(ver.snapshot, true);
    assert.ok(ver.sceneUrl.startsWith("/api/asset?file="));
    assert.ok(decodeURIComponent(ver.sceneUrl).includes("versions/v1/mech.sketch.json"));
    assert.equal(ver.glbUrl, undefined);
    assert.equal(ver.verified, undefined);
    assert.equal(ver.mode, undefined); // legacy 撞名防線:version 事件禁帶 mode
    assert.equal(ver.dofs.length, 1);
    assert.equal(ver.dofs[0].id, "theta");
    assert.equal(pres.type, "sketch");
    assert.equal(pres.sceneUrl, ver.sceneUrl);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("快照失敗(versions 被檔案佔位)→ snapshot:false + error 事件 + sceneUrl 退頂層", () => {
  const s = makeSession("snapfail");
  const { events, emit } = collector();
  try {
    fs.writeFileSync(path.join(s.workdir, "versions"), "not a dir");
    const r = presentSketch(s, { name: "mech", scene: FIXTURE }, emit);
    assert.equal(r.ok, true); // 呈現仍成功(誠實降級,不是失敗)
    const ver = events.find((e) => e.ev === "version").data;
    assert.equal(ver.snapshot, false);
    assert.ok(!decodeURIComponent(ver.sceneUrl).includes("versions/"));
    assert.ok(events.some((e) => e.ev === "error" && e.data.message.includes("快照")));
    assert.ok(fs.statSync(path.join(s.workdir, "mech.sketch.json")).size > 0);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("pruneSnapshots 上限生效(CADCHAT_MAX_SNAPSHOTS=2 → 只留最新兩版)", () => {
  const s = makeSession("prune");
  const { emit } = collector();
  const prev = process.env.CADCHAT_MAX_SNAPSHOTS;
  process.env.CADCHAT_MAX_SNAPSHOTS = "2";
  try {
    for (let i = 0; i < 3; i++) presentSketch(s, { name: "mech", scene: FIXTURE }, emit);
    assert.equal(s.version, 3);
    const kept = fs.readdirSync(path.join(s.workdir, "versions")).filter((n) => /^v\d+$/.test(n));
    assert.deepEqual(kept.sort(), ["v2", "v3"]);
  } finally {
    if (prev === undefined) delete process.env.CADCHAT_MAX_SNAPSHOTS;
    else process.env.CADCHAT_MAX_SNAPSHOTS = prev;
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});
