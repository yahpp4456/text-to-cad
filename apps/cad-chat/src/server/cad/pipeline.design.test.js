// 設計模式零 spawn 路徑單元測(node --test):readBuildMeta / designChecksFromMeta /
// runValidateDesign / versionStamp。sidecar 用 tmp workdir 注入(不 spawn Python)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  designChecksFromMeta,
  emitPresent,
  readBuildMeta,
  runValidateDesign,
  versionStamp,
} from "./pipeline.mjs";

function tmpSession(tag) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-design-${tag}-`));
  return {
    workdir,
    workdirRel: `models/.cadchat/${path.basename(workdir)}`,
    lastPartCount: 0,
  };
}

function writeSidecar(session, name, meta) {
  fs.writeFileSync(
    path.join(session.workdir, `.${name}.step.meta.json`),
    JSON.stringify(meta),
    "utf8",
  );
}

const META = {
  schemaVersion: 1,
  parts: ["body", "arm", "hub"],
  partCount: 3,
  motion: { schemaVersion: 1, dofs: [{ id: "flip", type: "revolute", axis: [0, 1, 0], moving: ["arm"], period_s: 4, pivot: [0, 0, -31], angle_deg: 90 }] },
  motionErrs: [],
};

// ---------------------------------------------------------------------------
// readBuildMeta
// ---------------------------------------------------------------------------

test("readBuildMeta:正常 sidecar → 正規化欄位", () => {
  const s = tmpSession("read");
  try {
    writeSidecar(s, "foo", META);
    const meta = readBuildMeta(s, "foo");
    assert.deepEqual(meta.parts, ["body", "arm", "hub"]);
    assert.equal(meta.partCount, 3);
    assert.equal(meta.motion.dofs[0].id, "flip");
    assert.deepEqual(meta.motionErrs, []);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("readBuildMeta:缺檔 / 壞 JSON / schema 不符 → null(fallback 訊號)", () => {
  const s = tmpSession("bad");
  try {
    assert.equal(readBuildMeta(s, "missing"), null);
    fs.writeFileSync(path.join(s.workdir, ".broken.step.meta.json"), "{not json", "utf8");
    assert.equal(readBuildMeta(s, "broken"), null);
    writeSidecar(s, "v9", { ...META, schemaVersion: 9 });
    assert.equal(readBuildMeta(s, "v9"), null);
    writeSidecar(s, "noparts", { schemaVersion: 1, partCount: 2 });
    assert.equal(readBuildMeta(s, "noparts"), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// designChecksFromMeta — 文案逐字釘死(來源:validate.py --motion-only 各分支;
// 改 validate.py 文案必同步 pipeline.mjs 與此測試)
// ---------------------------------------------------------------------------

test("designChecksFromMeta:六列全 skipped、文案對齊 validate.py", () => {
  const checks = designChecksFromMeta({ ...META });
  assert.equal(checks.length, 6);
  for (const c of checks) {
    assert.equal(c.ok, true);
    assert.equal(c.skipped, true);
  }
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by.valid_solid.label, "封閉性 / 有效實體 (watertight)");
  assert.equal(by.valid_solid.note, "設計模式:略過驗證(未驗證)");
  assert.equal(by.self_intersection.note, "未支援獨立檢查");
  assert.equal(by.interference.note, "設計模式:略過驗證(未驗證)"); // partCount 3
  assert.equal(by.motion_sweep.label, "運動掃掠干涉 motion-sweep");
  assert.equal(by.motion_sweep.note, "設計模式:略過掃掠(未驗證)");
  assert.equal(by.wall_thickness.note, "pipeline 未支援");
  assert.equal(by.facts.label, "拓撲 / 尺寸 topology");
  assert.equal(by.facts.note, "設計模式:略過檢查(未驗證)");
});

test("designChecksFromMeta:單件 / 無 MOTION / MOTION 錯誤三分支", () => {
  const single = designChecksFromMeta({ ...META, parts: ["p"], partCount: 1, motion: null });
  const by1 = Object.fromEntries(single.map((c) => [c.id, c]));
  assert.equal(by1.interference.note, "單一零件,無需檢查");
  assert.equal(by1.motion_sweep.note, "未提供運動學");

  // motionErrs 取前 2 條(agent 自修 MOTION 的回饋通道)
  const errs = designChecksFromMeta({
    ...META, motion: null, motionErrs: ["e1", "e2", "e3"],
  });
  const by2 = Object.fromEntries(errs.map((c) => [c.id, c]));
  assert.equal(
    by2.motion_sweep.note,
    "設計模式:略過掃掠;MOTION 宣告無效,運動示意不可用: e1; e2",
  );
});

// ---------------------------------------------------------------------------
// runValidateDesign — 零 spawn 路徑(有 meta 且 name 相符;不相符會走 spawn
// fallback,單元測不碰)
// ---------------------------------------------------------------------------

test("runValidateDesign:零 spawn 組結果 + 寫 asm manifest + _lastValidate 非 full", async () => {
  const s = tmpSession("rvd");
  try {
    // runValidateDesign 的 manifest 掃描要讀產生器原始碼
    fs.writeFileSync(path.join(s.workdir, "foo.py"), "PARAMS = {}\n", "utf8");
    s.lastBuildMeta = { name: "foo", ...META };
    const val = await runValidateDesign(s, "foo", {});
    assert.equal(val.ok, true);
    assert.equal(val.design, true);
    assert.equal(val.partCount, 3);
    assert.deepEqual(val.parts, ["body", "arm", "hub"]);
    assert.equal(val.motion.dofs[0].id, "flip");
    assert.equal(val.checks.length, 6);
    assert.ok(val.checks.every((c) => c.skipped));
    // 拆件匯出依賴的 manifest 有寫(partCount>=2)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(s.workdir, "foo.asm.json"), "utf8"),
    );
    assert.equal(manifest.type, "assembly");
    assert.equal(manifest.partCount, 3);
    // 空洞綠 ≠ verified:stamp 必須是 false;_lastValidate 綁 name(memo 中毒防護)
    assert.deepEqual(s._lastValidate, { name: "foo", full: false, ok: true });
    assert.equal(versionStamp(s, "foo").verified, false);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// versionStamp — verified 語意:full 驗證已跑且全過
// ---------------------------------------------------------------------------

test("emitPresent:收斂 _geomDirty(頂層基準凍成快照)且 version 事件蓋 versionStamp", () => {
  const s = tmpSession("present");
  try {
    s.sessionId = "s_test_present";
    s.version = 0;
    s._geomDirty = true; // runStep 開跑時設;present = 基準已凍結
    s._lastValidate = { name: "foo", full: false, ok: true }; // 快路徑驗證 → verified 必為 false
    const events = [];
    emitPresent(s, "foo", (type, data) => events.push([type, data]));
    assert.equal(s._geomDirty, false);
    const ver = events.find(([t]) => t === "version")[1];
    assert.equal(ver.verified, false);
    assert.equal(ver.id, "v1");
    // 未驗證版不得進匯出閘 memo(否則出檔免驗=閘破功)
    assert.ok(!s._verifiedVers?.has("v1"));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("versionStamp:full+ok 且 name 相符才 verified", () => {
  const lvOk = { name: "foo", full: true, ok: true };
  assert.deepEqual(versionStamp({ _lastValidate: lvOk }, "foo"), { verified: true });
  // 快路徑 / motionOnly fallback → 非 full
  assert.equal(versionStamp({ _lastValidate: { name: "foo", full: false, ok: true } }, "foo").verified, false);
  // full 但驗證有紅 → 不算 verified
  assert.equal(versionStamp({ _lastValidate: { name: "foo", full: true, ok: false } }, "foo").verified, false);
  // build 後未驗(runStep 已清)
  assert.deepEqual(versionStamp({ _lastValidate: null }, "foo"), { verified: false });
  // **memo 中毒回歸鎖**:對 partA 的 full-ok 不得讓 partB 換名呈現繼承 verified
  // (cad_present 無 build 直呈別件時,舊 stamp 名字不符 → 誠實 false)
  assert.equal(versionStamp({ _lastValidate: lvOk }, "partB").verified, false);
});

test("emitPresent:full 驗證出生的版本進匯出閘 memo(出檔免重驗)", () => {
  const s = tmpSession("presentVerified");
  try {
    s.sessionId = "s_test_present_v";
    s.version = 0;
    s._lastValidate = { name: "foo", full: true, ok: true }; // open-project / revert 的 full 驗證
    emitPresent(s, "foo", () => {});
    assert.ok(s._verifiedVers.has("v1"));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});
