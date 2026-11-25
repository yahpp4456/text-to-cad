// 從 GLB 內嵌拓撲讀模型樹 + 工具參數的零件名稱參照解析(藍圖 C3)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { occurrencesFromIndex, readOccurrences } from "./occurrences.mjs";
import { resolveSelectors } from "../agent/tools.mjs";

// 最小 GLB:JSON chunk 指到 BIN chunk 裡一段索引 JSON(前面墊幾個位元組驗 byteOffset)。
function writeGlb(file, index, { pad = 8 } = {}) {
  const indexBuf = Buffer.from(JSON.stringify(index), "utf8");
  let json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      bufferViews: [{ buffer: 0, byteOffset: pad, byteLength: indexBuf.length }],
      extensions: { STEP_topology: { indexView: 0 } },
    }),
    "utf8",
  );
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat([Buffer.alloc(pad, 0xff), indexBuf]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length + 8 + bin.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, json, binHead, bin]));
}

const INDEX = {
  tables: { occurrenceColumns: ["id", "path", "name", "sourceName", "parentId"] },
  occurrences: [
    ["o1", "1", "rig", "rig", null],
    ["o1.1", "1.1", "base", "base", "o1"],
    ["o1.2", "1.2", "bolt", "bolt", "o1"],
    ["o1.3", "1.3", "", "bolt", "o1"], // name 空 → 用 sourceName
    ["bogus", "x", "bad", "bad", "o1"], // id 不合法 → 丟掉
  ],
};

test("occurrencesFromIndex:依欄位表取 id / name / parentId", () => {
  assert.deepEqual(occurrencesFromIndex(INDEX), [
    { id: "o1", name: "rig", parentId: null },
    { id: "o1.1", name: "base", parentId: "o1" },
    { id: "o1.2", name: "bolt", parentId: "o1" },
    { id: "o1.3", name: "bolt", parentId: "o1" },
  ]);
  assert.deepEqual(occurrencesFromIndex({}), []);
  assert.deepEqual(occurrencesFromIndex({ tables: { occurrenceColumns: ["name"] }, occurrences: [["a"]] }), []);
});

test("readOccurrences / resolveSelectors:從 GLB 讀表並解析工具參數", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-occ-"));
  try {
    writeGlb(path.join(workdir, ".rig.step.glb"), INDEX);
    assert.equal(readOccurrences(path.join(workdir, ".rig.step.glb")).length, 4);
    const session = { workdir };

    assert.deepEqual(resolveSelectors(session, "rig", { from: "@base#f2", to: "#o1.2.f1" }), {
      ok: true,
      tokens: { from: "#o1.1.f2", to: "#o1.2.f1" },
    });
    const amb = resolveSelectors(session, "rig", { from: "@base", to: "@bolt" });
    assert.equal(amb.ok, false);
    assert.match(amb.error, /^to: 「@bolt」有 2 個同名零件/);
    assert.equal(amb.candidates.length, 2);

    // 沒有 @ 參照:不讀檔、原樣通過(連 GLB 不存在也一樣)
    const plain = { from: "#f1", to: "#f2" };
    assert.deepEqual(resolveSelectors({ workdir }, "nope", plain), { ok: true, tokens: plain });
    // 有 @ 參照但讀不到零件表:明講,不猜
    const none = resolveSelectors({ workdir }, "nope", { from: "@base", to: "#f2" });
    assert.equal(none.ok, false);
    assert.match(none.error, /沒有可用的零件表/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("readOccurrences:壞檔一律回空陣列", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-occ-bad-"));
  try {
    const f = path.join(dir, "x.glb");
    assert.deepEqual(readOccurrences(f), []);
    fs.writeFileSync(f, "not a glb at all, just text long enough");
    assert.deepEqual(readOccurrences(f), []);
    fs.writeFileSync(f, Buffer.alloc(4));
    assert.deepEqual(readOccurrences(f), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readOccurrences:真的範例模型讀得到零件名稱", { skip: !fs.existsSync(path.resolve("../../models/linear_stage/.linear_stage.step.glb")) }, () => {
  const occ = readOccurrences(path.resolve("../../models/linear_stage/.linear_stage.step.glb"));
  assert.ok(occ.length >= 10);
  assert.equal(occ[0].id, "o1");
  assert.ok(occ.some((o) => o.name === "base" && o.parentId === "o1"));
});

test("resolveSelectors:@零件#~穩定名稱 對這次建置的名稱表解析;找不到不代選", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-occ-names-"));
  try {
    writeGlb(path.join(workdir, ".rig.step.glb"), INDEX);
    fs.writeFileSync(
      path.join(workdir, ".rig.step.meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        parts: ["base", "bolt"],
        names: { schemaVersion: 1, files: [], parts: { base: { f: ["aaaaaaaaaa", "bbbbbbbbbb"], e: [] } }, lines: {} },
      }),
      "utf8",
    );
    const session = { workdir };
    assert.deepEqual(resolveSelectors(session, "rig", { from: "@base#~bbbbbbbbbb", to: "#o1.2" }), {
      ok: true,
      tokens: { from: "#o1.1.f2", to: "#o1.2" },
    });
    const gone = resolveSelectors(session, "rig", { from: "@base#~0000000000", to: "#o1.2" });
    assert.equal(gone.ok, false);
    assert.match(gone.error, /^from: 零件 base 在目前的版本沒有名稱為 ~0000000000 的面或邊/);
    assert.deepEqual(gone.candidates, []);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
