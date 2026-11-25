// 建置差異摘要的接線(藍圖 B3):pipeline 把 build 收割的 sidecar 轉成一行字。
// 比對本身的細節在 src/lib/buildDelta.test.js;這裡鎖的是「sidecar → 文字」這一段:
// 自由度數從 motion 取、舊 sidecar 沒有摘要時不出字、版本事件帶得到 delta。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildDeltaText, emitPresent, readBuildMeta } from "./cad/pipeline.mjs";

const part = (name, x0, x1, key = "k_" + name) => ({
  name, key, bbox: [[x0, 0, 0], [x1, 10, 10]], volume: (x1 - x0) * 100, faces: 6,
});
const meta = (parts, dofs = 0) => ({
  parts: parts.map((p) => p.name),
  partCount: parts.length,
  motion: dofs ? { dofs: Array.from({ length: dofs }, (_, i) => ({ id: "d" + i })) } : null,
  summary: {
    schemaVersion: 1,
    partCount: parts.length,
    bbox: [[Math.min(...parts.map((p) => p.bbox[0][0])), 0, 0], [Math.max(...parts.map((p) => p.bbox[1][0])), 10, 10]],
    volume: parts.reduce((s, p) => s + p.volume, 0),
    parts,
  },
});

test("沒有上一次 → 首次建置;相同 → 與上一版相同", () => {
  const a = meta([part("base", 0, 100)]);
  assert.equal(buildDeltaText(null, a), "首次建置:1 件,包絡 100×10×10 mm");
  assert.equal(buildDeltaText(a, a), "與上一版相同(1 件,包絡 100×10×10 mm)");
});

test("新增一件並宣告一個自由度 → 件數、名稱、包絡、自由度都說到", () => {
  const before = meta([part("base", 0, 100)]);
  const after = meta([part("base", 0, 100), part("slider", 100, 140)], 1);
  assert.equal(
    buildDeltaText(before, after),
    "與上一版比:零件 1→2;新增 slider;包絡 100×10×10 → 140×10×10 mm;自由度 無→1",
  );
});

test("同一個件平移 → 說是移動,不說是改了", () => {
  const before = meta([part("base", 0, 100), part("slider", 20, 60)]);
  const after = meta([part("base", 0, 100), part("slider", 30, 70)]);
  assert.equal(buildDeltaText(before, after), "與上一版比:移動 slider(Δ +10, 0, 0)");
});

test("本次 sidecar 沒有摘要(舊版 cadpy、收割失敗)→ 空字串,不硬湊", () => {
  const a = meta([part("base", 0, 100)]);
  assert.equal(buildDeltaText(a, { parts: ["base"], partCount: 1, motion: null, summary: null }), "");
  assert.equal(buildDeltaText(a, null), "");
});

test("上一次沒有摘要 → 當成沒有上一次", () => {
  const a = meta([part("base", 0, 100)]);
  assert.equal(buildDeltaText({ parts: ["base"], summary: null }, a), "首次建置:1 件,包絡 100×10×10 mm");
});

// 版本事件:第一版只列件數與包絡;第二版與第一版的快照比。
test("emitPresent 的 version 事件帶 delta:v1 列現況,v2 說出與 v1 的差異", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-delta-"));
  try {
    const session = { id: "s_delta", workdir, workdirRel: "models/.cadchat/s_delta", version: 0 };
    const write = (m) => {
      fs.writeFileSync(path.join(workdir, "rig.py"), ["PARAMS = {}", "def gen_step():", "    return None", ""].join("\n"), "utf8");
      fs.writeFileSync(path.join(workdir, "rig.step"), "ISO-10303-21;", "utf8");
      fs.writeFileSync(path.join(workdir, ".rig.step.glb"), "glb", "utf8");
      fs.writeFileSync(path.join(workdir, ".rig.step.meta.json"), JSON.stringify({ schemaVersion: 1, ...m }), "utf8");
    };
    const versions = [];
    const emit = (event, data) => { if (event === "version") versions.push(data); };

    write(meta([part("base", 0, 100)]));
    assert.ok(readBuildMeta(session, "rig").summary, "sidecar 的 summary 讀得到");
    emitPresent(session, "rig", emit);
    write(meta([part("base", 0, 100), part("slider", 100, 140)]));
    emitPresent(session, "rig", emit);

    assert.equal(versions[0].delta, "1 件,包絡 100×10×10 mm");
    assert.equal(versions[1].delta, "與上一版比:零件 1→2;新增 slider;包絡 100×10×10 → 140×10×10 mm");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
