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
  paramRangesFromGenerator,
  paramValuesFromGenerator,
  readCableSpec,
  readParamLabels,
  readTemplateMeta,
  rewriteParams,
  rewriteSpec,
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
// PARAM_RANGES:固定滑桿範圍(範本用;不受當前值 ×2.5 啟發式困住)
// ---------------------------------------------------------------------------
const RANGES_SRC = [
  "PARAMS = {",
  '    "length": 394.38,',
  '    "width": 118.2,',
  '    "pockets": 6,',
  "}",
  "PARAM_RANGES = {",
  '    "length": [340, 1500, 5],',
  '    "width": (50, 250, 2),',
  "}",
  "def gen_step():",
  "    return 0",
  "",
].join("\n");

test("paramRangesFromGenerator:解析 [min,max,step] 與 (min,max,step);缺檔/無區塊 → {}", () => {
  const s = tmpSession("pr");
  try {
    assert.deepEqual(paramRangesFromGenerator(s, "foo"), {}); // 缺檔
    writeGen(s, "foo", RANGES_SRC);
    const r = paramRangesFromGenerator(s, "foo");
    assert.deepEqual(r.length, { min: 340, max: 1500, step: 5 });
    assert.deepEqual(r.width, { min: 50, max: 250, step: 2 }); // 圓括號也接受
    assert.equal("pockets" in r, false); // 未宣告的鍵不在範圍表
    writeGen(s, "bar", GEN_SRC); // 無 PARAM_RANGES 區塊
    assert.deepEqual(paramRangesFromGenerator(s, "bar"), {});
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("paramDefsFromGenerator:有 PARAM_RANGES 的鍵用固定範圍,其餘走啟發式", () => {
  const s = tmpSession("prd");
  try {
    writeGen(s, "foo", RANGES_SRC);
    const defs = Object.fromEntries(paramDefsFromGenerator(s, "foo").map((d) => [d.key, d]));
    // length:固定範圍(啟發式會是 394*2.5≈986;固定要是 1500)
    assert.equal(defs.length.max, 1500);
    assert.equal(defs.length.min, 340);
    assert.equal(defs.length.step, 5);
    assert.equal(defs.length.unit, "mm");
    assert.equal(defs.length.int, undefined);
    // width:固定範圍
    assert.equal(defs.width.max, 250);
    // pockets:無宣告 → 啟發式(整數小值當顆數)
    assert.equal(defs.pockets.int, true);
    assert.equal(defs.pockets.step, 1);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

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

// ── 範本中繼(TEMPLATE_META / PARAM_LABELS):單行 JSON 相容 dict ──
// 文法刻意收緊成「單行、JSON.parse 可解」:PARAM_RANGES 那支 regex 只吃數值三元組,
// 中繼含中文字串/括號/逗號,手刻 regex 必誤切。壞法一律回 null(不列清單,不炸)。
test("readTemplateMeta/readParamLabels:單行 JSON 解析;壞法回 null", () => {
  const s = tmpSession("meta");
  try {
    const META = '{"family": "cable", "form": "per_layer", "layers": 3, "label": "三層(X 型)"}';
    writeGen(
      s,
      "good",
      [
        `TEMPLATE_META = ${META}`,
        'PARAM_LABELS = {"L1": "第1層電纜長(內層)", "head_h": "固定頭高"}',
        GEN_SRC,
      ].join("\n"),
    );
    const meta = readTemplateMeta(s, "good");
    assert.equal(meta.family, "cable");
    assert.equal(meta.layers, 3);
    assert.equal(meta.label, "三層(X 型)"); // 中文/括號不被 regex 切壞
    assert.equal(readParamLabels(s, "good").L1, "第1層電纜長(內層)");
    // 沒宣告 → null(不是 {},呼叫端據此判「這不是範本」)
    writeGen(s, "plain");
    assert.equal(readTemplateMeta(s, "plain"), null);
    assert.equal(readParamLabels(s, "plain"), null);
    // 壞法:Python 單引號 / True / 尾逗號 / 多行 → 一律 null(不 throw)
    for (const bad of [
      "TEMPLATE_META = {'family': 'cable'}",
      'TEMPLATE_META = {"family": "cable", "t": True}',
      'TEMPLATE_META = {"family": "cable",}',
      'TEMPLATE_META = {\n  "family": "cable"\n  }', // 收尾 } 沒頂到第 0 欄
    ]) {
      writeGen(s, "bad", [bad, GEN_SRC].join("\n"));
      assert.equal(readTemplateMeta(s, "bad"), null, bad);
    }
    // 陣列不算(必須是物件)
    writeGen(s, "arr", ['TEMPLATE_META = ["cable"]', GEN_SRC].join("\n"));
    assert.equal(readTemplateMeta(s, "arr"), null);
    // 檔案不存在 → null
    assert.equal(readTemplateMeta(s, "missing"), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

// ── rewriteSpec:層數/帶型的結構重生(Phase 4)──
const SPEC_SRC = [
  "TEMPLATE_META = {\"family\": \"cable\", \"form\": \"per_layer\"}",
  "CABLE_SPEC = {",
  '  "layers": 2,',
  '  "riser_module": 0,',
  '  "bands": [',
  '    {"key": "outer", "level": 0, "n": 7, "bore": 11.4, "web": 2.8, "edge": 4.2, "x": 0.0},',
  '    {"key": "inner", "level": 1, "n": 6, "bore": 14.0, "web": 2.5, "edge": 4.25, "x": 0.0}',
  "  ]",
  "}",
  'PARAMS = {"L1": 790.0, "L2": 830.0, "width": 118.2}',
  'PARAM_RANGES = {"L1": [200, 2500, 5], "L2": [200, 2500, 5], "width": [50, 250, 2]}',
  "",
  "def gen_step():",
  "    return None",
  "",
].join("\n");

test("rewriteSpec:整塊替換 PARAMS(縮層不留幽靈鍵)+ 重寫 CABLE_SPEC/PARAM_RANGES", () => {
  const s = tmpSession("spec");
  try {
    writeGen(s, "cab", SPEC_SRC);
    const rw = rewriteSpec(s, "cab", {
      spec: {
        layers: 3,
        riser_module: 1,
        bands: [
          { key: "outer", level: 0, n: 7, bore: 11.4, web: 2.8, edge: 4.2, x: 0.0 },
          { key: "mid", level: 1, n: 7, bore: 11.4, web: 2.8, edge: 4.2, x: 0.0 },
          { key: "inner", level: 2, n: 6, bore: 14.0, web: 2.5, edge: 4.25, x: 0.0 },
        ],
      },
      params: { L1: 780, L2: 820, L3: 860, width: 118.2 },
      ranges: {
        L1: { min: 200, max: 2500, step: 5 },
        L2: { min: 200, max: 2500, step: 5 },
        L3: { min: 200, max: 2500, step: 5 },
        width: { min: 50, max: 250, step: 2 },
      },
    });
    assert.equal(rw.ok, true, rw.error);
    const src = readGen(s, "cab");
    // 三個區塊都被改寫,且仍解析得回來
    assert.equal(readCableSpec(s, "cab").layers, 3);
    assert.equal(readCableSpec(s, "cab").riser_module, 1);
    assert.equal(readCableSpec(s, "cab").bands.length, 3);
    assert.deepEqual(paramValuesFromGenerator(s, "cab"), { L1: 780, L2: 820, L3: 860, width: 118.2 });
    assert.equal(paramRangesFromGenerator(s, "cab").L3.max, 2500);
    // float-ness 保留(整數值也要 780.0,否則下次被整數啟發式誤判成顆數)
    assert.ok(src.includes('"L1": 780.0'), src.slice(src.indexOf("PARAMS"), src.indexOf("PARAMS") + 90));

    // 縮層:PARAMS 整塊替換 → 舊 L3 不得殘留(否則出幽靈滑桿)
    const rw2 = rewriteSpec(s, "cab", {
      spec: {
        layers: 2,
        riser_module: 0,
        bands: [
          { key: "outer", level: 0, n: 7, bore: 11.4, web: 2.8, edge: 4.2, x: 0.0 },
          { key: "inner", level: 1, n: 6, bore: 14.0, web: 2.5, edge: 4.25, x: 0.0 },
        ],
      },
      params: { L1: 780, L2: 820, width: 118.2 },
      ranges: { L1: { min: 200, max: 2500, step: 5 }, L2: { min: 200, max: 2500, step: 5 } },
    });
    assert.equal(rw2.ok, true, rw2.error);
    const vals = paramValuesFromGenerator(s, "cab");
    assert.deepEqual(Object.keys(vals).sort(), ["L1", "L2", "width"]);
    assert.equal("L3" in vals, false, "縮層留下幽靈 L3");
    assert.equal(paramDefsFromGenerator(s, "cab").some((d) => d.key === "L3"), false);
    assert.equal("L3" in paramRangesFromGenerator(s, "cab"), false);
    // prevSrc 可整檔回滾
    assert.ok(rw2.prevSrc.includes('"layers": 3'));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("rewriteSpec:壞 spec 一律擋下(不寫檔)", () => {
  const s = tmpSession("specbad");
  try {
    writeGen(s, "cab", SPEC_SRC);
    const before = readGen(s, "cab");
    const cases = [
      [{ spec: null, params: {} }, "物件"],
      [{ spec: { layers: 0, bands: [{ level: 0 }] }, params: {} }, "layers"],
      [{ spec: { layers: 2, bands: [] }, params: {} }, "bands"],
      // 少了 level 1 的帶 → 該層沒東西可掃,建到一半才炸
      [{ spec: { layers: 2, bands: [{ key: "a", level: 0 }] }, params: {} }, "level 1"],
      [{ spec: { layers: 1, bands: [{ key: "a", level: 0 }] }, params: { L1: "x" } }, "數值"],
    ];
    for (const [arg, needle] of cases) {
      const r = rewriteSpec(s, "cab", arg);
      assert.equal(r.ok, false, JSON.stringify(arg));
      assert.ok(r.error.includes(needle), `${r.error} 不含 ${needle}`);
    }
    assert.equal(readGen(s, "cab"), before, "壞 spec 不得動到檔案");
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});
