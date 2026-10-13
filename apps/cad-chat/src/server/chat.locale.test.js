import assert from "node:assert/strict";
import test, { before } from "node:test";

import { warmHans } from "./agent/hans.mjs";
import { buildUserText, resolveLocale } from "./middleware/chat.mjs";

before(async () => {
  await warmHans();
});

test("resolveLocale:白名單內照收,其餘/缺席一律 zh-Hant(舊前端相容)", () => {
  assert.equal(resolveLocale({ locale: "zh-Hans" }), "zh-Hans");
  assert.equal(resolveLocale({ locale: "zh-Hant" }), "zh-Hant");
  assert.equal(resolveLocale({ locale: "zh-CN" }), "zh-Hant", "瀏覽器 tag 不是 locale 值");
  assert.equal(resolveLocale({}), "zh-Hant");
  assert.equal(resolveLocale(null), "zh-Hant");
});

test("buildUserText:zh-Hans 只把系統括註轉簡體,使用者原文逐字保留", () => {
  const body = { message: "做一個法蘭,外徑 100mm", pickRef: "F12", params: { od: 100 } };
  const session = { mode: "design", lastName: null };
  const hant = buildUserText(body, session, null, null);
  const hans = buildUserText(body, session, null, null, "zh-Hans");
  assert.ok(hant.includes("（已帶入幾何參考 F12）"), hant);
  assert.ok(hant.includes("（使用者把參數調整為"), hant);
  assert.ok(hans.includes("（已带入几何参考 F12）"), hans);
  assert.ok(hans.includes("（用户把参数调整为"), hans);
  assert.ok(hans.includes("做一個法蘭,外徑 100mm"), "使用者原文不得被轉:" + hans);
  assert.ok(!hans.includes("已帶入"), hans);
  // 預設參數 = zh-Hant(舊呼叫相容)
  assert.equal(buildUserText(body, session, null, null, "zh-Hant"), hant);
});

test("buildUserText:zh-Hans 空訊息與 rehydrateNote 也走簡體;附圖/上傳括註一樣", () => {
  assert.equal(buildUserText({ message: "" }, { mode: "design" }, null, null, "zh-Hans"), "（空消息）");
  assert.equal(buildUserText({ message: "" }, { mode: "design" }, null, null), "（空訊息）");
  const withNote = buildUserText({ message: "繼續" }, { mode: "design", _rehydrateNote: "（接續先前的產生器 cube.py）" }, null, null, "zh-Hans");
  assert.ok(withNote.startsWith("（接续先前的产生器 cube.py）"), withNote);
  const img = buildUserText({ message: "看圖" }, { mode: "design" }, { names: ["a.png"], blocks: [] }, null, "zh-Hans");
  assert.ok(img.includes("（附图 1 张:a.png"), img);
  const step = buildUserText({ message: "收" }, { mode: "library" }, null, { names: ["x.step"] }, "zh-Hans");
  assert.ok(step.includes("已上传 STEP 档 1 件:x.step"), step);
  assert.ok(step.includes("library_preview"), "工具名英數不受影響");
});
