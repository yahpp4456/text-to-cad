import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LOCALE, LOCALES, LOCALE_KEY, detectLocale, isLocale, normalizeLocale } from "./locale.js";

test("白名單與正規化:垃圾值收斂為 zh-Hant", () => {
  assert.deepEqual(LOCALES, ["zh-Hant", "zh-Hans"]);
  assert.equal(DEFAULT_LOCALE, "zh-Hant");
  assert.equal(LOCALE_KEY, "cadchat.locale");
  assert.equal(isLocale("zh-Hans"), true);
  assert.equal(isLocale("zh-CN"), false, "瀏覽器 tag 不是 locale 值,要先 detect");
  for (const v of ["bogus", "", null, undefined, 1, "ZH-HANS"]) assert.equal(normalizeLocale(v), "zh-Hant", String(v));
});

test("detectLocale:第一個 zh tag 決定;Hans/CN/SG/MY → 簡體,其餘 → 繁體;無 zh → 繁體", () => {
  assert.equal(detectLocale(["zh-CN"]), "zh-Hans");
  assert.equal(detectLocale(["zh-Hans-CN"]), "zh-Hans");
  assert.equal(detectLocale(["zh-SG"]), "zh-Hans");
  assert.equal(detectLocale(["zh_cn"]), "zh-Hans", "底線與小寫也認");
  assert.equal(detectLocale(["en-US", "zh-TW"]), "zh-Hant");
  assert.equal(detectLocale(["zh-Hant-HK"]), "zh-Hant");
  assert.equal(detectLocale(["zh"]), "zh-Hant", "裸 zh 走產品預設");
  assert.equal(detectLocale(["en-US", "zh-CN", "zh-TW"]), "zh-Hans", "取第一個 zh");
  assert.equal(detectLocale(["ja", "en"]), "zh-Hant");
  assert.equal(detectLocale([]), "zh-Hant");
  assert.equal(detectLocale("zh-CN"), "zh-Hans", "單一字串也可");
  assert.equal(detectLocale(["zhx-CN"]), "zh-Hant", "zh 必須是完整主標");
});
