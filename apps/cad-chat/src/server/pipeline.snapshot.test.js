// 看圖(藍圖 E1)的伺服器端:把工具參數轉成渲染腳本的命令列。真的畫圖在
// apps/cad-chat/tests/test_render_view.py(需要 OpenGL);這裡鎖參數的清洗——它們來自模型。
import assert from "node:assert/strict";
import { test } from "node:test";

import { SNAPSHOT_VIEWS, snapshotArgs } from "./cad/pipeline.mjs";

const session = { workdir: "x", workdirRel: "models/.cadchat/s1" };

test("預設:一張 iso、著色", () => {
  assert.deepEqual(snapshotArgs(session, "rig", "rig_1"), [
    "models/.cadchat/s1/rig.py", "models/.cadchat/s1/.snapshots",
    "--views", "iso", "--stem", "rig_1", "--mode", "shaded",
  ]);
});

test("視角最多 4 個;空字串與空白被濾掉", () => {
  const args = snapshotArgs(session, "rig", "s", { views: ["iso", " ", "front", "", "top", "left", "back"] });
  assert.equal(args[args.indexOf("--views") + 1], "iso,front,top,left");
  assert.equal(snapshotArgs(session, "rig", "s", { views: [] })[3], "iso");
  assert.equal(snapshotArgs(session, "rig", "s", { views: "iso" })[3], "iso"); // 不是陣列 → 當作沒給
});

test("ghost / hide / clip / pose / mode 各自對到一個旗標;沒給就不出現", () => {
  const args = snapshotArgs(session, "rig", "s", {
    views: ["iso"], ghost: ["housing"], hide: ["lid", "cover"], clip: { axis: "Y", at: 2.5 }, pose: " open ", mode: "wire",
  });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--ghost"), "housing");
  assert.equal(flag("--hide"), "lid,cover");
  assert.equal(flag("--clip"), "y:2.5");
  assert.equal(flag("--pose"), "open");
  assert.equal(flag("--mode"), "wire");
  const plain = snapshotArgs(session, "rig", "s", {});
  for (const name of ["--ghost", "--hide", "--clip", "--pose"]) assert.ok(!plain.includes(name), name);
});

test("壞的 clip 不送出(軸不是 x/y/z、座標不是數字);mode 不認得就用 shaded", () => {
  for (const clip of [{ axis: "w", at: 1 }, { axis: "x", at: "abc" }, { axis: "x" }, "x:1", null]) {
    assert.ok(!snapshotArgs(session, "rig", "s", { clip }).includes("--clip"), JSON.stringify(clip));
  }
  const args = snapshotArgs(session, "rig", "s", { mode: "xray" });
  assert.equal(args[args.indexOf("--mode") + 1], "shaded");
});

test("產生器名稱先清洗(它會進檔案路徑)", () => {
  assert.equal(snapshotArgs(session, "../../etc/passwd", "s")[0], "models/.cadchat/s1/etcpasswd.py");
});

test("視角預設清單與渲染模組的一致(工具說明直接列出這份清單)", () => {
  assert.deepEqual(SNAPSHOT_VIEWS, ["iso", "iso_back", "front", "back", "right", "left", "top", "bottom"]);
});
