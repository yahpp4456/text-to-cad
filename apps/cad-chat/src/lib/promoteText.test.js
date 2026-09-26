import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPromoteText, scenePathFromUrl } from "./promoteText.js";

const URL = "/api/asset?file=" + encodeURIComponent("models/.cadchat/s_abc/versions/v1/mech.sketch.json") + "&v=1";

test("scenePathFromUrl:file= 解碼成相對路徑;無 file=/非字串 → 空", () => {
  assert.equal(scenePathFromUrl(URL), "models/.cadchat/s_abc/versions/v1/mech.sketch.json");
  assert.equal(scenePathFromUrl("/api/asset?v=1"), "");
  assert.equal(scenePathFromUrl(null), "");
});

test("buildPromoteText:有 doc → 場景檔路徑 + 機構件 + 驅動", () => {
  const doc = {
    title: "氣缸推平台",
    bodies: [{ id: "f", label: "機架" }, { id: "p", label: "平台" }, { id: "x" }],
    drives: [{ id: "theta", label: "前傾角", min: 0, max: 30, unit: "°" }],
  };
  const t = buildPromoteText({ doc, sceneUrl: URL, fallbackName: "mech" });
  assert.ok(t.startsWith("照機構草模「氣缸推平台」做正式設計:"));
  assert.ok(t.includes("原始場景檔=models/.cadchat/s_abc/versions/v1/mech.sketch.json"));
  assert.ok(t.includes("先 Read 它"));
  assert.ok(t.includes("機構件=機架、平台;"));
  assert.ok(t.includes("驅動=前傾角 0~30°;"));
  assert.ok(t.endsWith("先列規格再動工。"));
});

test("buildPromoteText:fetch 失敗(無 doc)的降級句仍帶路徑", () => {
  const t = buildPromoteText({ doc: null, sceneUrl: URL, fallbackName: "mech" });
  assert.ok(t.startsWith("照草模「mech」做正式設計:原始場景檔=models/.cadchat/s_abc/"));
  assert.ok(!t.includes("機構件="));
});
