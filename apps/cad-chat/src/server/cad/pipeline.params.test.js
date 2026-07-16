// 參數重生路徑單元測(node --test):rewriteParams / paramValuesFromGenerator /
// buildOrRollback。tmp workdir 注入、build 用 fake(不 spawn Python)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildOrRollback,
  generatorHasDxf,
  generatorHasFlat,
  paramDefsFromGenerator,
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
    // 源碼 w/h 字面帶小數點 → 重寫保留 float 形(整數啟發式不得誤掛 int)
    assert.ok(now.includes('PARAMS = {"w": 5.0, "h": 10.0}'), now.match(/PARAMS = \{[^}]*\}/)?.[0]);
    // PARAMS 區塊以外逐字保留(docstring 與 gen_step 本體)
    assert.ok(now.startsWith('"""fixture generator"""'));
    assert.ok(now.includes('return PARAMS["w"] - PARAMS["h"]'));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("rewriteParams:子集以磁碟現值墊底 merge——其餘鍵不蒸發(agent 部分 emit 的 KeyError 回歸鎖)", () => {
  const s = tmpSession("rwsubset");
  try {
    writeGen(s, "foo");
    const rw = rewriteParams(s, "foo", { w: 5 }); // 只送 w,漏 h
    assert.equal(rw.ok, true);
    const now = readGen(s, "foo");
    assert.ok(now.includes('"w": 5'), "指定鍵已更新");
    assert.ok(now.includes('"h": 10'), "未指定鍵以磁碟現值保留(整塊替換不得蒸發)");
    // 新鍵(磁碟沒有)照樣可加
    rewriteParams(s, "foo", { d: 3 });
    const now2 = readGen(s, "foo");
    assert.ok(now2.includes('"w": 5') && now2.includes('"h": 10') && now2.includes('"d": 3'));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("float-ness 保留 + int 旗標:重生不掉小數點,整數分支才掛 int:true(連鎖雷回歸鎖)", () => {
  const s = tmpSession("rwfloat");
  try {
    // pocket_w 源碼 16.0(float)、pockets 源碼 6(int)
    writeGen(s, "foo", 'PARAMS = {"pockets": 6, "pocket_w": 16.0}\n');
    const d0 = Object.fromEntries(paramDefsFromGenerator(s, "foo").map((d) => [d.key, d]));
    assert.equal(d0.pockets.int, true); // 整數分支掛 int
    assert.equal(d0.pocket_w.int, undefined); // mm 分支不掛
    // 重生成整數值:float 鍵必須寫成 20.0 形,否則下一輪被整數啟發式誤鎖
    rewriteParams(s, "foo", { pocket_w: 20 });
    assert.ok(readGen(s, "foo").includes('"pocket_w": 20.0'), readGen(s, "foo"));
    const d1 = Object.fromEntries(paramDefsFromGenerator(s, "foo").map((d) => [d.key, d]));
    assert.equal(d1.pocket_w.int, undefined, "重生後 pocket_w 不得被誤掛 int:true");
    assert.equal(d1.pockets.int, true);
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
// generatorHasDxf / generatorHasFlat(鈑金件偵測;folded 已非 PARAMS 參數,攤平
// 改由 gen_flat + 3D 視圖切換,paramDefsFromGenerator 無 folded 特例)
// ---------------------------------------------------------------------------

test("folded 不再是滑桿:PARAMS 有 folded 也不產滑桿(value 0 被濾、無特例)", () => {
  const s = tmpSession("nofolded");
  try {
    writeGen(s, "foo", `PARAMS = {"w": 20.0, "folded": 0}\n`);
    const defs = paramDefsFromGenerator(s, "foo");
    assert.equal(defs.find((d) => d.key === "folded"), undefined);
    assert.ok(defs.find((d) => d.key === "w")); // 正常參數不受影響
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("generatorHasDxf / generatorHasFlat:頂層 def 才算(縮排內層不算、缺檔 false)", () => {
  const s = tmpSession("hasflag");
  try {
    writeGen(s, "both", "PARAMS = {}\ndef gen_dxf():\n    return None\ndef gen_flat():\n    return None\n");
    assert.equal(generatorHasDxf(s, "both"), true);
    assert.equal(generatorHasFlat(s, "both"), true);
    // 組合件:有 gen_dxf 但無 gen_flat(攤平組合件無意義)
    writeGen(s, "asm", "PARAMS = {}\ndef gen_dxf():\n    return None\n");
    assert.equal(generatorHasDxf(s, "asm"), true);
    assert.equal(generatorHasFlat(s, "asm"), false);
    // 縮排內層 def 不算
    writeGen(s, "nested", "PARAMS = {}\ndef gen_step():\n    def gen_flat():\n        pass\n");
    assert.equal(generatorHasFlat(s, "nested"), false);
    assert.equal(generatorHasFlat(s, "missing"), false);
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
