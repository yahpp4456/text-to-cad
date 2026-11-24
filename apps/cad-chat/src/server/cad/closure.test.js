// 建置憑證:輸入沒變才算命中;任何對不上的情況都必須回未命中(寧可多重建)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  MAX_INPUT_FILES,
  STAMP_SCHEMA,
  checkStamp,
  collectInputs,
  envComplete,
  externalFiles,
  hashFile,
  hashTree,
  isBuildOutput,
  makeStamp,
  readStamp,
  stampKey,
  writeStamp,
} from "./closure.mjs";

const ENV = { python: "3.13.14", build123d: "0.13.0", ocp: "8.0.1.1", cadpy: "aaaa", scripts: "bbbb" };

// 佈局:<root>/models/.cadchat/s1/{bracket.py, helper.py, imported/motor.step, 產物…}
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-closure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const genDir = path.join(root, "models", ".cadchat", "s1");
  const write = (rel, text) => {
    const abs = path.join(genDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  };
  write("bracket.py", "PARAMS = {'w': 10}\n");
  write("helper.py", "X = 1\n");
  write("imported/motor.step", "ISO-10303-21;\n");
  write("bracket.step", "ISO-10303-21; generated\n");
  write(".bracket.step.glb", "glb");
  write(".bracket.step.meta.json", "{}");
  const rel = (name) => path.relative(root, path.join(genDir, name)).split(path.sep).join("/");
  const reads = [rel("bracket.py"), rel("helper.py"), rel("bracket.step"), rel(".bracket.step.meta.json")];
  const ctx = { name: "bracket", env: ENV, genDir, dataRoot: root };
  return { root, genDir, write, rel, reads, ctx };
}

test("isBuildOutput:產物與 sidecar 不是輸入;產生器、同目錄模組、匯入件是", () => {
  for (const rel of [
    "bracket.step",
    "bracket.dxf",
    "bracket.pdf",
    "bracket.asm.json",
    ".bracket.step.glb",
    ".bracket.step.meta.json",
    ".bracket.build.json",
    "session.json",
    "metrics.jsonl",
    "versions/v1/bracket.py",
    ".exports/v1/bracket.step",
    "__pycache__/x.pyc",
    "imported/.motor.step.glb",
  ]) {
    assert.equal(isBuildOutput(rel, "bracket"), true, rel);
  }
  for (const rel of ["bracket.py", "helper.py", "imported/motor.step", "uploads/sketch.png", "other.step", "spec.json"]) {
    assert.equal(isBuildOutput(rel, "bracket"), false, rel);
  }
});

test("collectInputs:濾掉產物、補上 imported/ 全部檔案、路徑相對產生器目錄", (t) => {
  const { reads, ctx } = project(t);
  const inputs = collectInputs({ reads, ...ctx });
  assert.deepEqual(
    inputs.map((i) => `${i.base}:${i.path}`),
    ["gen:bracket.py", "gen:helper.py", "gen:imported/motor.step"],
  );
  assert.ok(inputs.every((i) => /^[0-9a-f]{32}$/.test(i.sha)));
});

test("collectInputs:產生器目錄之外、資料根之內的讀取記成 root;資料根之外的不追蹤", (t) => {
  const { root, reads, ctx } = project(t);
  fs.mkdirSync(path.join(root, "models", "parts-library", "rail"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "parts-library", "rail", "meta.json"), "{}");
  const inputs = collectInputs({
    reads: [...reads, "models/parts-library/rail/meta.json", "../outside/secret.txt"],
    ...ctx,
  });
  assert.ok(inputs.some((i) => i.base === "root" && i.path === "models/parts-library/rail/meta.json"));
  assert.ok(!inputs.some((i) => i.path.includes("secret")));
});

test("collectInputs:沒有 reads(直接 spawn 的結果)或超過上限 → null", (t) => {
  const { ctx, rel } = project(t);
  assert.equal(collectInputs({ reads: undefined, ...ctx }), null);
  const many = Array.from({ length: MAX_INPUT_FILES + 5 }, (_, i) => {
    fs.writeFileSync(path.join(ctx.genDir, `m${i}.py`), "x=1\n");
    return rel(`m${i}.py`);
  });
  assert.equal(collectInputs({ reads: many, ...ctx }), null);
});

test("makeStamp:讀檔紀錄裡沒有產生器本身 → 不產生憑證", (t) => {
  const { ctx, rel } = project(t);
  assert.equal(makeStamp({ reads: [rel("helper.py")], ...ctx }), null);
});

test("makeStamp:環境不完整 → 不產生憑證", (t) => {
  const { reads, ctx } = project(t);
  assert.equal(makeStamp({ reads, ...ctx, env: { ...ENV, cadpy: null } }), null);
  assert.equal(makeStamp({ reads, ...ctx, env: null }), null);
  assert.equal(envComplete(ENV), true);
});

test("命中:什麼都沒變;寫檔再讀回仍命中", (t) => {
  const { reads, ctx, genDir } = project(t);
  const stamp = makeStamp({ reads, ...ctx });
  assert.equal(stamp.schema, STAMP_SCHEMA);
  assert.equal(stamp.key, stampKey(stamp));
  assert.deepEqual(checkStamp(stamp, ctx), { hit: true, reason: "" });
  const file = path.join(genDir, ".bracket.build.json");
  writeStamp(file, stamp);
  assert.deepEqual(checkStamp(readStamp(file), ctx), { hit: true, reason: "" });
});

test("命中:整個專案複製到別的目錄(開專案 / 回退的情境)仍命中", (t) => {
  const { reads, ctx, genDir, root } = project(t);
  const stamp = makeStamp({ reads, ...ctx });
  const copy = path.join(root, "models", ".cadchat", "s2");
  fs.cpSync(genDir, copy, { recursive: true });
  assert.equal(checkStamp(stamp, { ...ctx, genDir: copy }).hit, true);
});

test("未命中:每一種輸入變動", async (t) => {
  const cases = {
    "產生器內容變了": ({ write }) => write("bracket.py", "PARAMS = {'w': 11}\n"),
    "同目錄模組變了": ({ write }) => write("helper.py", "X = 2\n"),
    "匯入的 STEP 變了": ({ write }) => write("imported/motor.step", "ISO-10303-21; v2\n"),
    "輸入檔不見了": ({ genDir }) => fs.rmSync(path.join(genDir, "helper.py")),
    "imported/ 多了檔案": ({ write }) => write("imported/rail.step", "ISO-10303-21;\n"),
    "imported/ 少了檔案": ({ genDir }) => fs.rmSync(path.join(genDir, "imported", "motor.step")),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    await t.test(label, (tt) => {
      const p = project(tt);
      const stamp = makeStamp({ reads: p.reads, ...p.ctx });
      mutate(p);
      const result = checkStamp(stamp, p.ctx);
      assert.equal(result.hit, false);
      assert.ok(result.reason.length > 0);
    });
  }
});

test("外部 CAD 檔:讀檔紀錄看不到的 C++ 層讀取(import_step 同目錄零件)也算輸入", async (t) => {
  await t.test("同目錄另一個零件的 STEP 是輸入;自己的產物、圖片、隱藏檔不是", (tt) => {
    const { reads, ctx, write } = project(tt);
    write("part_a.step", "ISO-10303-21; part a\n"); // 組合件 import_step("part_a.step")
    write("uploads/ref.STP", "ISO-10303-21; uploaded\n");
    write("uploads/photo.png", "png");
    write("imported/.motor.step.glb", "preview glb");
    assert.deepEqual(externalFiles(ctx.genDir, "bracket"), ["imported/motor.step", "part_a.step", "uploads/ref.STP"]);
    const stamp = makeStamp({ reads, ...ctx });
    assert.ok(stamp.inputs.some((i) => i.path === "part_a.step"));
    assert.equal(checkStamp(stamp, ctx).hit, true);
  });
  await t.test("那個零件重建了(內容變)→ 未命中", (tt) => {
    const { reads, ctx, write } = project(tt);
    write("part_a.step", "ISO-10303-21; part a\n");
    const stamp = makeStamp({ reads, ...ctx });
    write("part_a.step", "ISO-10303-21; part a rebuilt\n");
    assert.deepEqual(checkStamp(stamp, ctx), { hit: false, reason: "輸入變了:part_a.step" });
  });
  await t.test("多了一個 CAD 檔 → 未命中;多了一張圖不影響", (tt) => {
    const { reads, ctx, write } = project(tt);
    const stamp = makeStamp({ reads, ...ctx });
    write("uploads/sketch.png", "png");
    assert.equal(checkStamp(stamp, ctx).hit, true);
    write("part_b.stp", "ISO-10303-21;\n");
    assert.deepEqual(checkStamp(stamp, ctx), { hit: false, reason: "外部 CAD 檔有增減" });
  });
  await t.test("沒有外部檔清單的憑證(舊格式)→ 未命中", (tt) => {
    const { reads, ctx } = project(tt);
    const { external, ...legacy } = makeStamp({ reads, ...ctx });
    assert.ok(Array.isArray(external));
    assert.equal(checkStamp(legacy, ctx).hit, false);
  });
});

test("未命中:輸入同長度改寫也抓得到(比的是內容,不是大小或時間)", (t) => {
  const { reads, ctx, write } = project(t);
  const stamp = makeStamp({ reads, ...ctx });
  write("bracket.py", "PARAMS = {'w': 99}\n"); // 與原本同長度
  assert.equal(checkStamp(stamp, ctx).hit, false);
});

test("產物:記了雜湊的產物必須原封不動才命中", async (t) => {
  const OUTPUTS = ["bracket.step", ".bracket.step.glb", ".bracket.step.meta.json"];
  await t.test("沒動 → 命中", (tt) => {
    const { reads, ctx } = project(tt);
    const stamp = makeStamp({ reads, ...ctx, outputs: OUTPUTS });
    assert.deepEqual(
      stamp.outputs.map((o) => o.path),
      [...OUTPUTS].sort(),
    );
    assert.equal(checkStamp(stamp, ctx).hit, true);
  });
  await t.test("產物被別次建置覆寫 → 未命中", (tt) => {
    const { reads, ctx, write } = project(tt);
    const stamp = makeStamp({ reads, ...ctx, outputs: OUTPUTS });
    write(".bracket.step.glb", "glb from another build");
    assert.deepEqual(checkStamp(stamp, ctx), {
      hit: false,
      reason: "產物不是這次建置留下的:.bracket.step.glb",
    });
  });
  await t.test("產物不見了 → 未命中", (tt) => {
    const { reads, ctx, genDir } = project(tt);
    const stamp = makeStamp({ reads, ...ctx, outputs: OUTPUTS });
    fs.rmSync(path.join(genDir, "bracket.step"));
    assert.deepEqual(checkStamp(stamp, ctx), { hit: false, reason: "產物不見了:bracket.step" });
  });
  await t.test("build 時產物就不存在 → 不產生憑證", (tt) => {
    const { reads, ctx } = project(tt);
    assert.equal(makeStamp({ reads, ...ctx, outputs: [...OUTPUTS, ".bracket.flat.step.glb"] }), null);
  });
  await t.test("沒記產物的憑證:產物變動不影響(產物不是輸入)", (tt) => {
    const { reads, ctx, write } = project(tt);
    const stamp = makeStamp({ reads, ...ctx });
    write("bracket.step", "ISO-10303-21; regenerated differently\n");
    assert.equal(checkStamp(stamp, ctx).hit, true);
  });
  await t.test("憑證裡的產物路徑越界 → 未命中", (tt) => {
    const { reads, ctx } = project(tt);
    const stamp = makeStamp({ reads, ...ctx, outputs: OUTPUTS });
    const forged = { ...stamp, outputs: [{ path: "../../x", sha: "0" }] };
    assert.equal(checkStamp(forged, ctx).reason, "憑證產物路徑越界");
  });
});

test("未命中:環境每一欄不同都算", (t) => {
  const { reads, ctx } = project(t);
  const stamp = makeStamp({ reads, ...ctx });
  for (const key of Object.keys(ENV)) {
    const result = checkStamp(stamp, { ...ctx, env: { ...ENV, [key]: "different" } });
    assert.deepEqual(result, { hit: false, reason: `環境不同:${key}` });
  }
  assert.equal(checkStamp(stamp, { ...ctx, env: null }).hit, false, "環境未知(worker 未就緒)不可命中");
});

test("未命中:沒有憑證、格式版本不同、名稱不同、內容被改過", (t) => {
  const { reads, ctx } = project(t);
  const stamp = makeStamp({ reads, ...ctx });
  assert.equal(checkStamp(null, ctx).hit, false);
  assert.equal(checkStamp({ ...stamp, schema: STAMP_SCHEMA + 1 }, ctx).hit, false);
  assert.equal(checkStamp(stamp, { ...ctx, name: "other" }).hit, false);
  // 手改憑證讓它「看起來」符合現況:key 對不上
  const forged = { ...stamp, inputs: stamp.inputs.slice(0, 1) };
  assert.deepEqual(checkStamp(forged, ctx), { hit: false, reason: "憑證內容與其 key 不符" });
  assert.equal(checkStamp({ ...stamp, inputs: [] }, ctx).hit, false);
});

test("未命中:憑證裡的路徑越界(憑證是使用者資料,不可信)", (t) => {
  const { reads, ctx, root } = project(t);
  fs.writeFileSync(path.join(root, "secret.txt"), "top secret");
  const stamp = makeStamp({ reads, ...ctx });
  const inputs = [...stamp.inputs, { base: "gen", path: "../../../secret.txt", sha: hashFile(path.join(root, "secret.txt")) }];
  const forged = { ...stamp, inputs };
  forged.key = stampKey(forged);
  assert.deepEqual(checkStamp(forged, ctx), { hit: false, reason: "憑證輸入路徑越界" });
  const rootEscape = { ...stamp, inputs: [...stamp.inputs, { base: "root", path: "../x", sha: "0" }] };
  rootEscape.key = stampKey(rootEscape);
  assert.equal(checkStamp(rootEscape, ctx).reason, "憑證輸入路徑越界");
});

test("readStamp:檔案不存在或壞掉回 null", (t) => {
  const { genDir } = project(t);
  assert.equal(readStamp(path.join(genDir, "nope.json")), null);
  const bad = path.join(genDir, ".bad.build.json");
  fs.writeFileSync(bad, "{not json");
  assert.equal(readStamp(bad), null);
  fs.writeFileSync(bad, "null");
  assert.equal(readStamp(bad), null);
});

test("hashTree:內容或檔名變了摘要就變;__pycache__ 與隱藏檔不算;目錄不存在視為空", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "pkg", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pkg", "a.py"), "x = 1\n");
  const first = hashTree([dir]);
  fs.writeFileSync(path.join(dir, "pkg", "__pycache__", "a.pyc"), "junk");
  fs.writeFileSync(path.join(dir, "pkg", ".hidden.py"), "junk");
  fs.writeFileSync(path.join(dir, "pkg", "notes.md"), "junk");
  assert.equal(hashTree([dir]), first);
  fs.writeFileSync(path.join(dir, "pkg", "a.py"), "x = 2\n");
  const changed = hashTree([dir]);
  assert.notEqual(changed, first);
  fs.renameSync(path.join(dir, "pkg", "a.py"), path.join(dir, "pkg", "b.py"));
  assert.notEqual(hashTree([dir]), changed);
  assert.equal(hashTree([path.join(dir, "missing")]), hashTree([path.join(dir, "missing")]));
});
