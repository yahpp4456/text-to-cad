// 參數重生路徑單元測(node --test):rewriteParams / paramValuesFromGenerator /
// buildOrRollback。tmp workdir 注入、build 用 fake(不 spawn Python)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildOrRollback,
  paramValuesFromGenerator,
  rewriteParams,
} from "./pipeline.mjs";

function tmpSession(tag) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-params-${tag}-`));
  return {
    workdir,
    workdirRel: `models/.cadchat/${path.basename(workdir)}`,
    lastPartCount: 0,
  };
}

const GEN_SRC = [
  '"""fixture generator"""',
  "PARAMS = {",
  '    "w": 20.0,   # width',
  '    "h": 10.0,',
  "}",
  "",
  "def gen_step():",
  '    return PARAMS["w"] - PARAMS["h"]',
  "",
].join("\n");

function writeGen(s, name, src = GEN_SRC) {
  fs.writeFileSync(path.join(s.workdir, `${name}.py`), src, "utf8");
}
function readGen(s, name) {
  return fs.readFileSync(path.join(s.workdir, `${name}.py`), "utf8");
}

// ---------------------------------------------------------------------------
// rewriteParams
// ---------------------------------------------------------------------------

test("rewriteParams:整塊改寫 PARAMS、其餘內容逐字不變、回傳改寫前整檔 prevSrc", () => {
  const s = tmpSession("rw");
  try {
    writeGen(s, "foo");
    const rw = rewriteParams(s, "foo", { w: 5, h: 10 });
    assert.equal(rw.ok, true);
    assert.equal(rw.prevSrc, GEN_SRC); // 回滾原料 = 改寫前整檔
    const now = readGen(s, "foo");
    assert.ok(now.includes('PARAMS = {"w": 5, "h": 10}'));
    // PARAMS 區塊以外逐字保留(docstring 與 gen_step 本體)
    assert.ok(now.startsWith('"""fixture generator"""'));
    assert.ok(now.includes('return PARAMS["w"] - PARAMS["h"]'));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("rewriteParams:無 PARAMS 區塊 / 缺檔 → ok:false 且不動檔案", () => {
  const s = tmpSession("rwbad");
  try {
    writeGen(s, "nop", "def gen_step():\n    return 1\n");
    const r1 = rewriteParams(s, "nop", { w: 1 });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /PARAMS 區塊/);
    assert.equal(readGen(s, "nop"), "def gen_step():\n    return 1\n");

    const r2 = rewriteParams(s, "missing", { w: 1 });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /找不到產生器/);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("rewriteParams:非數值(字串/NaN/Infinity)拒絕、列出鍵名、檔案未動", () => {
  const s = tmpSession("rwnum");
  try {
    writeGen(s, "foo");
    for (const bad of [{ w: "abc" }, { w: NaN }, { w: Infinity }]) {
      const r = rewriteParams(s, "foo", { ...bad, h: 1 });
      assert.equal(r.ok, false);
      assert.match(r.error, /參數必須是數值:w/);
    }
    assert.equal(readGen(s, "foo"), GEN_SRC);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// paramValuesFromGenerator — 全鍵讀回(含 0/負值;對照 paramDefsFromGenerator 會濾)
// ---------------------------------------------------------------------------

test("paramValuesFromGenerator:全部鍵含 0/負值;缺檔/無 PARAMS → null", () => {
  const s = tmpSession("pv");
  try {
    writeGen(s, "foo", 'PARAMS = {"a": 20.0, "b": 0, "c": -3.5}\n');
    assert.deepEqual(paramValuesFromGenerator(s, "foo"), { a: 20, b: 0, c: -3.5 });
    assert.equal(paramValuesFromGenerator(s, "missing"), null);
    writeGen(s, "nop", "x = 1\n");
    assert.equal(paramValuesFromGenerator(s, "nop"), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildOrRollback — fake build 模擬 runStep 的副作用(_lastValidate 清空、
// _geomDirty 置 true、失敗清 lastBuildMeta)
// ---------------------------------------------------------------------------

function seedTransients(s) {
  s._geomDirty = false;
  s._lastValidate = { name: "foo", full: true, ok: true };
  s.lastBuildMeta = { name: "foo", partCount: 2 };
}
function fakeBuild(result) {
  return async (session) => {
    // 鏡射 runStep 開跑副作用
    session._lastValidate = null;
    session._geomDirty = true;
    if (!result.ok) session.lastBuildMeta = null;
    return result;
  };
}

test("buildOrRollback:build 成功 → 不回滾、保留新 PARAMS、transient 維持 build 後狀態", async () => {
  const s = tmpSession("ok");
  try {
    writeGen(s, "foo");
    seedTransients(s);
    const rw = rewriteParams(s, "foo", { w: 30, h: 10 });
    const { step, rolledBack } = await buildOrRollback(s, "foo", rw.prevSrc, {
      build: fakeBuild({ ok: true }),
    });
    assert.equal(step.ok, true);
    assert.equal(rolledBack, false);
    assert.ok(readGen(s, "foo").includes('"w": 30'));
    assert.equal(s._geomDirty, true); // build 後狀態,不還原
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("buildOrRollback:build 失敗 → 檔案 byte-identical 還原 + transient 還原", async () => {
  const s = tmpSession("fail");
  try {
    writeGen(s, "foo");
    seedTransients(s);
    const rw = rewriteParams(s, "foo", { w: 5, h: 10 });
    const { step, rolledBack } = await buildOrRollback(s, "foo", rw.prevSrc, {
      build: fakeBuild({ ok: false, exitCode: 1, stderr: "boom" }),
    });
    assert.equal(step.ok, false);
    assert.equal(rolledBack, true);
    assert.equal(readGen(s, "foo"), GEN_SRC); // 磁碟回到改寫前
    assert.equal(s._geomDirty, false); // 回滾後 .py 與 .step 又是同一版
    assert.deepEqual(s._lastValidate, { name: "foo", full: true, ok: true });
    assert.deepEqual(s.lastBuildMeta, { name: "foo", partCount: 2 });
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("buildOrRollback:失敗 + aborted → 絕不寫檔/動狀態(中斷語意回歸鎖)", async () => {
  const s = tmpSession("abort");
  try {
    writeGen(s, "foo");
    seedTransients(s);
    const rw = rewriteParams(s, "foo", { w: 5, h: 10 });
    const { step, rolledBack } = await buildOrRollback(s, "foo", rw.prevSrc, {
      signal: { aborted: true },
      build: fakeBuild({ ok: false, exitCode: null, stderr: "" }),
    });
    assert.equal(step.ok, false);
    assert.equal(rolledBack, false);
    // 新 turn 可能已接手改寫 .py:aborted 後檔案保持 build 前的新值,不可倒寫
    assert.ok(readGen(s, "foo").includes('"w": 5'));
    assert.equal(s._geomDirty, true); // 狀態也不還原
    assert.equal(s.lastBuildMeta, null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});
