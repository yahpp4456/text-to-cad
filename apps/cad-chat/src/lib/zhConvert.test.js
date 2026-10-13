import assert from "node:assert/strict";
import test, { before } from "node:test";

import { ATTRS, EXCLUDE_ATTR_SELECTOR, EXCLUDE_SELECTOR } from "./domConvert.js";
import { convertText, converterReady, hasCjk, loadConverter, setConverter } from "./zhConvert.js";
import { OVERRIDE, PROTECT, termList } from "./zhTerms.js";

before(async () => {
  await loadConverter(); // 真的載 opencc-js/t2cn(node ESM 直接 import)
});

test("載入後 converter 就緒;無 CJK / 空值原樣回傳", () => {
  assert.equal(converterReady(), true);
  assert.equal(convertText("STEP / GLB 20mm"), "STEP / GLB 20mm");
  assert.equal(convertText(""), "");
  assert.equal(convertText(null), null);
  assert.equal(hasCjk("abc"), false);
  assert.equal(hasCjk("設"), true);
});

test("twp→cn:字形 + 台灣詞彙都轉", () => {
  assert.equal(convertText("對話式 CAD 產圖"), "对话式 CAD 产图");
  assert.equal(convertText("開啟檔案"), "打开文件");
  assert.equal(convertText("另存專案"), "另存项目");
  assert.equal(convertText("資料與軟體"), "数据与软件");
  assert.equal(convertText("運動掃掠干涉 motion-sweep"), "运动扫掠干涉 motion-sweep");
});

test("術語例外:PROTECT 原樣、OVERRIDE 指定譯法,佔位字元全數還原", () => {
  assert.equal(convertText("穗鈅 SUIYAO 對話式"), "穗鈅 SUIYAO 对话式");
  assert.equal(convertText("品質"), "品质", "twp 不會給「质量」;若未來版本改了,這條會抓到");
  assert.equal(convertText("公釐"), "毫米");
  assert.equal(convertText("步進馬達 2 顆"), "步进电机 2 颗");
  const out = convertText("穗鈅的步進馬達用公釐標註,穗鈅");
  assert.equal(out, "穗鈅的步进电机用毫米标注,穗鈅");
  assert.ok(!/[-]/.test(out), "不得殘留 PUA 佔位");
  for (const t of PROTECT) assert.equal(convertText(t), t, t);
  for (const [k, v] of Object.entries(OVERRIDE)) assert.equal(convertText(k), v, k);
  const list = termList();
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].length >= list[i].length, "依長度降序");
});

test("簡中輸入冪等;快取不改結果", () => {
  const s = "已带入几何参考,请据此重生新版本。";
  assert.equal(convertText(s), s);
  assert.equal(convertText("設計"), "设计");
  assert.equal(convertText("設計"), "设计");
});

test("setConverter(null) 後原樣回傳;可注入假 converter", () => {
  setConverter(null);
  assert.equal(converterReady(), false);
  assert.equal(convertText("設計"), "設計");
  setConverter((t) => t.replace(/設/g, "X"));
  assert.equal(convertText("設計"), "X計");
  setConverter(null);
});

test("DOM 排除規則:使用者輸入/原話/程式碼/data-no-convert 都在名單;placeholder 路徑不排除表單元素", () => {
  for (const sel of ["textarea", "input", "select", "code", "pre", ".user-bubble", ".user-ref", ".composer", "[data-no-convert]"]) {
    assert.ok(EXCLUDE_SELECTOR.split(",").includes(sel), sel);
  }
  assert.ok(!EXCLUDE_SELECTOR.split(",").includes(".msg-ai"), "AI 氣泡 Phase 1 不排除");
  for (const sel of ["textarea", "input", "select"]) assert.ok(!EXCLUDE_ATTR_SELECTOR.split(",").includes(sel), sel);
  assert.deepEqual(ATTRS, ["title", "placeholder", "aria-label", "alt"]);
});
