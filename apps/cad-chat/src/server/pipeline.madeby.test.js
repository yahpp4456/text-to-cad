// 零件層級 made_by(藍圖 C2):點選參照 → 所屬零件 → 「產生器第幾行建的」進使用者訊息。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { madeByText, partOfRef, readBuildMeta } from "./cad/pipeline.mjs";
import { buildUserText } from "./middleware/chat.mjs";
import { partOfToken } from "../lib/cadTopology.js";

const META = {
  parts: ["base", "arm"],
  madeBy: {
    base: { file: "rig.py", line: 12, func: "gen_step" },
    arm: { file: "rig.py", line: 30 },
    bad_line: { file: "rig.py", line: 0 },
    bad_file: { file: "", line: 3 },
    odd: { file: "../../etc/pa ss.py", line: 7, func: "x); drop" },
  },
};

test("madeByText:檔名、行號、函式;模組層沒有函式名", () => {
  assert.equal(madeByText(META, "base"), "由 rig.py 第 12 行 的 gen_step() 建立");
  assert.equal(madeByText(META, "arm"), "由 rig.py 第 30 行 建立");
});

test("madeByText:沒有紀錄或欄位不合法就不說", () => {
  for (const part of ["nope", "bad_line", "bad_file", "constructor", "__proto__"]) {
    assert.equal(madeByText(META, part), "", part);
  }
  assert.equal(madeByText(null, "base"), "");
  assert.equal(madeByText({ parts: ["base"] }, "base"), "");
});

test("madeByText:sidecar 的值白名單化後才進 prompt", () => {
  assert.equal(madeByText(META, "odd"), "由 ....etcpass.py 第 7 行 建立");
});

test("partOfRef:前端帶的零件名要真的在零件表裡;單件模型自動補;其餘不猜", () => {
  assert.equal(partOfRef(META, { token: "#o1.2.f3", part: "arm" }), "arm");
  assert.equal(partOfRef(META, { token: "#o1.2.f3", part: "ghost" }), null);
  assert.equal(partOfRef(META, { token: "#f3" }), null);
  assert.equal(partOfRef({ parts: ["solo"] }, { token: "#f3" }), "solo");
  assert.equal(partOfRef({ parts: ["solo"] }, { token: "#f3", part: "ghost" }), null);
});

test("partOfToken:occurrence 前綴 → 掛在它上面的零件節點", () => {
  const nodes = [
    { kind: "occurrence", id: "o1", label: "rig", row: {} },
    { kind: "shape", label: "base", row: { occurrenceId: "o1.1" } },
    { kind: "shape", label: "arm", row: { occurrenceId: "o1.12" } },
  ];
  assert.equal(partOfToken(nodes, "#o1.1.f4"), "base");
  assert.equal(partOfToken(nodes, "#o1.12"), "arm");
  assert.equal(partOfToken(nodes, "o1.12.e3"), "arm");
  assert.equal(partOfToken(nodes, "#o1"), null); // 群組不是零件
  assert.equal(partOfToken(nodes, "#f4"), null);
  assert.equal(partOfToken(null, "#o1.1.f4"), null);
});

test("buildUserText:點選參照後面附上所屬零件的建立位置", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-madeby-"));
  try {
    fs.writeFileSync(
      path.join(workdir, ".rig.step.meta.json"),
      JSON.stringify({ schemaVersion: 1, partCount: 2, ...META }),
      "utf8",
    );
    const session = { id: "s_madeby", workdir, lastName: "rig", mode: "sketch" };
    assert.deepEqual(readBuildMeta(session, "rig").madeBy.arm, { file: "rig.py", line: 30 });

    const one = buildUserText(
      { message: "這面加厚", pickRefs: [{ token: "#o1.2.f3", label: "arm 上面", part: "arm" }] },
      session,
    );
    assert.match(one, /已帶入幾何參考 #o1\.2\.f3「arm 上面」\[零件 arm,由 rig\.py 第 30 行 建立\]/);

    const two = buildUserText(
      {
        message: "對齊",
        pickRefs: [
          { token: "#o1.1.f1", label: "底面", part: "base" },
          { token: "#o1.9.f1", label: "不明", part: "ghost" },
        ],
      },
      session,
    );
    assert.match(two, /1\. #o1\.1\.f1「底面」\[零件 base,由 rig\.py 第 12 行 的 gen_step\(\) 建立\]/);
    assert.match(two, /2\. #o1\.9\.f1「不明」\n/); // 對不上的零件不附、不猜

    // 沒有 sidecar(匯入件、舊專案):訊息與以前相同
    const none = buildUserText(
      { message: "x", pickRefs: [{ token: "#f1", label: "面" }] },
      { ...session, lastName: "other" },
    );
    assert.match(none, /（已帶入幾何參考 #f1「面」）/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

// ── 元素層級(藍圖 C1):點到的面或邊是哪一行做的 + 重建後仍可用的穩定參照 ──
test("buildUserText:點到面時附上這個面的建立行與穩定參照", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-names-"));
  try {
    const names = {
      schemaVersion: 1,
      files: ["rig.py"],
      parts: { arm: { f: ["aaaaaaaaaa", "", "cccccccccc"], e: ["eeeeeeeeee"] } },
      lines: { arm: { f: [[0, 41], null, [0, 44]], e: [[0, 41]] } },
    };
    fs.writeFileSync(
      path.join(workdir, ".rig.step.meta.json"),
      JSON.stringify({ schemaVersion: 1, partCount: 2, ...META, names }),
      "utf8",
    );
    const session = { id: "s_names", workdir, lastName: "rig", mode: "sketch" };
    assert.equal(readBuildMeta(session, "rig").names.parts.arm.f[2], "cccccccccc");
    const say = (token) =>
      buildUserText({ message: "x", pickRefs: [{ token, label: "面", part: "arm" }] }, session);

    assert.match(
      say("#o1.2.f3"),
      /\[零件 arm,由 rig\.py 第 30 行 建立;這個面由 rig\.py 第 44 行做出;重建後要再指這個面,用 @arm#~cccccccccc\]/,
    );
    assert.match(say("#o1.2.e1"), /這個邊由 rig\.py 第 41 行做出;重建後要再指這個邊,用 @arm#~eeeeeeeeee/);
    // 名稱不唯一、也沒有行號的面:只剩零件層級那一段,不編一個名稱給它
    assert.match(say("#o1.2.f2"), /\[零件 arm,由 rig\.py 第 30 行 建立\]/);
    // 點的是整個零件(沒有面/邊):同上
    assert.match(say("#o1.2"), /\[零件 arm,由 rig\.py 第 30 行 建立\]\）/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("readBuildMeta:names 的版本或形狀不對就當沒有", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-names-bad-"));
  try {
    for (const names of [null, { schemaVersion: 2, parts: {} }, { schemaVersion: 1 }, "x"]) {
      fs.writeFileSync(
        path.join(workdir, ".rig.step.meta.json"),
        JSON.stringify({ schemaVersion: 1, parts: ["arm"], names }),
        "utf8",
      );
      assert.equal(readBuildMeta({ workdir }, "rig").names, null);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
