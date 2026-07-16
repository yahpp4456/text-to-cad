// 掃出路徑預覽鏈的伺服端單元測(node --test,零 spawn):readBuildMeta 的
// sweepPaths 映射、writeSweepSidecar 寫/刪、emitPresent 的快照凍結 + 條件
// sweepPathsUrl(檔案真的存在才給,鏡射 flatLinesUrl 語意)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { emitPresent, readBuildMeta, writeSweepSidecar } from "./pipeline.mjs";

function tmpSession(tag) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-sweep-${tag}-`));
  return {
    workdir,
    workdirRel: `models/.cadchat/${path.basename(workdir)}`,
    lastPartCount: 0,
  };
}

const PATHS = [
  { label: "sleeve_path", points: [[0, 0, 0], [0, 0, 150], [0, 80, 150]] },
];

test("readBuildMeta:sweepPaths 有→透傳、無→空陣列(舊 sidecar 相容)", () => {
  const s = tmpSession("read");
  try {
    fs.writeFileSync(
      path.join(s.workdir, ".foo.step.meta.json"),
      JSON.stringify({ schemaVersion: 1, parts: ["a"], partCount: 1, sweepPaths: PATHS }),
      "utf8",
    );
    assert.deepEqual(readBuildMeta(s, "foo").sweepPaths, PATHS);
    fs.writeFileSync(
      path.join(s.workdir, ".bar.step.meta.json"),
      JSON.stringify({ schemaVersion: 1, parts: ["a"], partCount: 1 }),
      "utf8",
    );
    assert.deepEqual(readBuildMeta(s, "bar").sweepPaths, []);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("writeSweepSidecar:sweepView 併入 view 欄位(additive,schemaVersion 恆 1);無 view 無鍵", () => {
  const s = tmpSession("view");
  try {
    const view = {
      pathKind: "drag_chain",
      pathParams: ["straight_a", "bend_r", "straight_b"],
      profileParams: [{ key: "pockets", value: 6 }],
      profileLoops: [[[0, 0], [10, 0], [10, 5]]],
    };
    const p = writeSweepSidecar(s, "foo", PATHS, view);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(j.schemaVersion, 1); // 恆 1:smoke_sweep_overlay 釘死,view 是 additive
    assert.deepEqual(j.view, view);
    // 無 view → 不寫鍵(舊件/收割失敗 → 前端 chip 不亮)
    const p2 = writeSweepSidecar(s, "bar", PATHS, null);
    assert.ok(!("view" in JSON.parse(fs.readFileSync(p2, "utf8"))));
    // meta 映射:sweepView 有/無
    fs.writeFileSync(
      path.join(s.workdir, ".foo.step.meta.json"),
      JSON.stringify({ schemaVersion: 1, parts: ["a"], partCount: 1, sweepPaths: PATHS, sweepView: view }),
      "utf8",
    );
    assert.deepEqual(readBuildMeta(s, "foo").sweepView, view);
    fs.writeFileSync(
      path.join(s.workdir, ".bar.step.meta.json"),
      JSON.stringify({ schemaVersion: 1, parts: ["a"], partCount: 1 }),
      "utf8",
    );
    assert.equal(readBuildMeta(s, "bar").sweepView, null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("writeSweepSidecar:有料寫檔、空/缺刪殘留(滑桿改掉路徑不留殘影)", () => {
  const s = tmpSession("write");
  try {
    const p = writeSweepSidecar(s, "foo", PATHS);
    assert.ok(fs.existsSync(p));
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(j.schemaVersion, 1);
    assert.deepEqual(j.paths, PATHS);
    // 空 → 刪殘留並回 null
    assert.equal(writeSweepSidecar(s, "foo", []), null);
    assert.ok(!fs.existsSync(p));
    // 再刪一次(檔已不存在)不炸
    assert.equal(writeSweepSidecar(s, "foo", undefined), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("emitPresent:sidecar 凍進快照且 version/present 事件帶 sweepPathsUrl(指向 versions/vN)", () => {
  const s = tmpSession("present");
  try {
    s.sessionId = "s_test_sweep_present";
    s.version = 0;
    writeSweepSidecar(s, "foo", PATHS);
    const events = [];
    emitPresent(s, "foo", (type, data) => events.push([type, data]));
    // 快照凍結
    const snap = path.join(s.workdir, "versions", "v1", ".foo.sweep.json");
    assert.ok(fs.existsSync(snap), "快照必須含 .sweep.json(切舊版 overlay 要對舊幾何)");
    const ver = events.find(([t]) => t === "version")[1];
    const pres = events.find(([t]) => t === "present")[1];
    assert.ok(ver.sweepPathsUrl?.includes(encodeURIComponent("versions/v1/.foo.sweep.json")), `version 事件 URL 應指快照:${ver.sweepPathsUrl}`);
    assert.equal(pres.sweepPathsUrl, ver.sweepPathsUrl);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("emitPresent:無 sidecar → sweepPathsUrl null(非掃出件不誤亮 chip)", () => {
  const s = tmpSession("none");
  try {
    s.sessionId = "s_test_sweep_none";
    s.version = 0;
    const events = [];
    emitPresent(s, "foo", (type, data) => events.push([type, data]));
    assert.equal(events.find(([t]) => t === "version")[1].sweepPathsUrl, null);
    assert.equal(events.find(([t]) => t === "present")[1].sweepPathsUrl, null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});
