// 無塵電纜規格表單純函數單元測(node --test)。
// canSkipAi 決定「直接生成」主鈕能不能按 —— 它是零 LLM 主線的閘,行為漂了要嘛
// 該經過 AI 的案子被直接生成、要嘛每案都被逼走 AI。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CABLE_SPEC_PREFIX,
  canSkipAi,
  composeCableSpecText,
  derivedNote,
  defsWithLayers,
  describeBands,
  layerEditable,
  outOfRange,
  paramsWithLayers,
  screwFromTop,
  screwLabel,
  specWithBand,
  specWithLayers,
  specWithScrew,
} from "./cableSpec.js";

const DEFS = [
  { key: "L1", label: "L1", min: 200, max: 2500, step: 5, value: 805, unit: "mm" },
  { key: "head_h", label: "head_h", min: 34.5, max: 80, step: 0.5, value: 39.5, unit: "mm" },
  { key: "mount_h", label: "mount_h", min: 50, max: 500, step: 1, value: 190, unit: "mm" },
];
const BANDS = [
  { key: "sleeve_inner", level: 2, n: 6, bore: 14.0 },
  { key: "sleeve_middle", level: 1, n: 7, bore: 11.4 },
  { key: "strip_a", level: 0, n: 1, bore: 32.0 },
  { key: "strip_b", level: 0, n: 1, bore: 11.6 },
];
const form = (over = {}) => ({
  dir: "cable_x_per_layer",
  name: "cable_x_per_layer",
  label: "三層 · 逐層定長",
  form: "per_layer",
  layers: 3,
  riserModule: 0,
  unit: "mm",
  bands: BANDS,
  labels: { L1: "第1層(內層)電纜長", head_h: "固定頭高", mount_h: "固定頭安裝高度" },
  notes: { L1: "端到端,含兩端夾持段 32.4" },
  defs: DEFS,
  values: { L1: 805, head_h: 39.5, mount_h: 190 },
  source: "template",
  unsure: false,
  note: "",
  error: null,
  ...over,
});

test("outOfRange:上下界各自報,合法值不報", () => {
  assert.deepEqual(outOfRange(DEFS, { L1: 805, head_h: 39.5, mount_h: 190 }), []);
  assert.equal(outOfRange(DEFS, { L1: 100, head_h: 39.5, mount_h: 190 })[0].key, "L1");
  assert.ok(outOfRange(DEFS, { L1: 9999, head_h: 39.5, mount_h: 190 })[0].reason.includes("上限"));
  assert.ok(outOfRange(DEFS, { L1: "x", head_h: 39.5, mount_h: 190 })[0].reason.includes("數值"));
});

test("canSkipAi:值都在範圍、沒勾不確定、沒寫給 AI 的說明 → 可直接生成", () => {
  assert.deepEqual(canSkipAi(form()), { ok: true, reason: "" });
});

test("canSkipAi:四種降級各自給人話理由", () => {
  assert.equal(canSkipAi(null).ok, false);
  assert.ok(canSkipAi(null).reason.includes("範本"));
  const badVal = canSkipAi(form({ values: { L1: 3000, head_h: 39.5, mount_h: 190 } }));
  assert.equal(badVal.ok, false);
  assert.ok(badVal.reason.includes("L1"), badVal.reason);
  const unsure = canSkipAi(form({ unsure: true }));
  assert.equal(unsure.ok, false);
  assert.ok(unsure.reason.includes("量法"), unsure.reason);
  const noted = canSkipAi(form({ note: "中層換 6 袋 14mm" }));
  assert.equal(noted.ok, false);
  assert.ok(noted.reason.includes("AI"), noted.reason);
  // 只有空白的備註不算(不該被空白鍵逼走 AI)
  assert.equal(canSkipAi(form({ note: "   " })).ok, true);
});

test("describeBands:依 level 由內往外、客戶編號 L1=最內層、同層多條併一列", () => {
  const rows = describeBands(BANDS);
  assert.deepEqual(rows.map((r) => r.label), ["L1", "L2", "L3"]);
  assert.equal(rows[0].text, "6×14"); // level 2 = 最內 = L1
  assert.equal(rows[2].count, 2); // level 0 兩條並排窄條
  assert.equal(rows[2].text, "1×32 + 1×11.6");
  assert.deepEqual(describeBands(null), []);
});

test("derivedNote:總高與固定頭拆解(表單當場算得出、不需幾何核心的那些)", () => {
  assert.deepEqual(derivedNote(form()), ["總高 229.5", "固定頭 = 11.5 × 3 + 加高 5"]);
  // 剛好沒有加高 → 不顯示加高項
  assert.deepEqual(
    derivedNote(form({ values: { head_h: 34.5, mount_h: 190 }, layers: 3 })),
    ["總高 224.5", "固定頭 = 11.5 × 3"],
  );
  assert.deepEqual(derivedNote({ values: {} }), []);
});

test("composeCableSpecText:契約前綴 + 範本路徑 + 逐鍵值 + 固定結構", () => {
  const t = composeCableSpecText(form());
  assert.ok(t.startsWith(CABLE_SPEC_PREFIX), t.slice(0, 30));
  assert.ok(t.includes("models/cable_x_per_layer/cable_x_per_layer.py"));
  assert.ok(t.includes("- L1 = 805"));
  assert.ok(t.includes("第1層(內層)電纜長"));
  assert.ok(t.includes("含兩端夾持段 32.4"));
  assert.ok(t.includes("L1(level 2):6×14"));
  assert.ok(t.includes("加高模組:固定架由下數第 1 格"));
  // 沒勾不確定 → 不出「不確定:」段(否則 agent 會平白問一輪)
  assert.ok(!t.includes("不確定:"));
  assert.equal(composeCableSpecText(null), "");
});

test("composeCableSpecText:勾了不確定 / 有修改說明 → 各自附段落", () => {
  const t = composeCableSpecText(form({ unsure: true, note: "中層換 6 袋 ×14mm" }));
  assert.ok(t.includes("不確定:"));
  assert.ok(t.includes("32.4") && t.includes("mount_h"));
  assert.ok(t.includes("要改的地方:中層換 6 袋 ×14mm"));
});

test("canSkipAi:閉式檢核(/api/cable/check)有違規 → 主鈕降級並轉述訊息", () => {
  const live = [{ key: "L1", message: "L1(865)與 L2(840)巢套餘隙不足:…", max: 811.1 }];
  const r = canSkipAi(form(), live);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("巢套餘隙不足"), r.reason);
  // 單欄範圍先判(即時、免等端點),閉式違規其次
  const both = canSkipAi(form({ values: { L1: 3000, head_h: 39.5, mount_h: 190 } }), live);
  assert.ok(both.reason.includes("L1") && both.reason.includes("上限"), both.reason);
  // 沒有 liveIssues → 照常可按(端點還沒回來時不擋)
  assert.equal(canSkipAi(form(), []).ok, true);
  assert.equal(canSkipAi(form()).ok, true);
});

// ── 結構編輯(Phase 4)──
const SPEC = {
  layers: 3,
  riser_module: 0,
  bands: [
    { key: "inner", level: 2, n: 6, bore: 14.0, web: 2.5, edge: 4.25, x: 0 },
    { key: "mid", level: 1, n: 7, bore: 11.4, web: 2.8, edge: 4.2, x: 0 },
    { key: "strip_a", level: 0, n: 1, bore: 32.0, web: 0, edge: 1.5, x: -32.6 },
    { key: "strip_b", level: 0, n: 1, bore: 11.6, web: 0, edge: 1.375, x: 27.95 },
  ],
};

test("specWithLayers:加層加在最外側 → 既有層的客戶編號(L 鍵)完全不動", () => {
  const up = specWithLayers(SPEC, 4);
  assert.equal(up.layers, 4);
  // 舊的最內層仍是最內層(level 3 = L1)
  assert.equal(up.bands.find((b) => b.key === "inner").level, 3);
  assert.equal(up.bands.find((b) => b.key === "mid").level, 2);
  // 新的最外層是舊外層那一組的複本(兩條並排一起複製),level 0
  const outer = up.bands.filter((b) => b.level === 0);
  assert.equal(outer.length, 2);
  assert.ok(outer.every((b) => b.key.startsWith("sleeve_l4")));
  assert.deepEqual(outer.map((b) => b.bore), [32, 11.6]);
  // 鍵不得重複(assembly 子件名)
  assert.equal(new Set(up.bands.map((b) => b.key)).size, up.bands.length);
});

test("specWithLayers:減層砍最外側;riser_module 夾在範圍內;非法 n 原樣回", () => {
  const down = specWithLayers({ ...SPEC, riser_module: 2 }, 2);
  assert.equal(down.layers, 2);
  assert.equal(down.bands.length, 2);
  assert.deepEqual(down.bands.map((b) => b.level).sort(), [0, 1]);
  assert.equal(down.bands.find((b) => b.key === "inner").level, 1);
  assert.equal(down.riser_module, 1, "riser 夾到 n-1");
  assert.equal(specWithLayers(SPEC, 3), SPEC);
  assert.equal(specWithLayers(SPEC, 0), SPEC);
  assert.equal(specWithLayers(SPEC, 2.5), SPEC);
});

test("paramsWithLayers:新層拿最長 + 步進;砍掉的鍵消失;head_h 保住加高量", () => {
  const v = { L1: 805, L2: 840, L3: 870, head_h: 39.5, mount_h: 190 };
  const up = paramsWithLayers(v, 3, 4);
  assert.equal(up.L4, 905, "新最外層 = 目前最長 + 35");
  assert.equal(up.head_h, 51, "加高 5 保住:4×11.5 + 5");
  assert.equal(up.L1, 805);
  const down = paramsWithLayers(v, 3, 2);
  assert.equal("L3" in down, false);
  assert.equal(down.head_h, 28, "2×11.5 + 5");
});

// 固定座螺向:客戶抓過 X 的 OEM STEP 螺絲建反(六角袋/埋頭面顛倒)→ 升格表單
// 欄位。預設語意是安全網:measured 缺席/缺鍵一律當實裝標準(=1),只有明寫 0
// 才是反向——這樣沒宣告螺向的舊範本/舊案件開起來不會突然翻面。
test("screwFromTop/specWithScrew:預設實裝標準,翻轉寫進 measured 且不動其他鍵", () => {
  assert.equal(screwFromTop(null), 1);
  assert.equal(screwFromTop({}), 1);
  assert.equal(screwFromTop({ measured: {} }), 1);
  assert.equal(screwFromTop({ measured: { screw_from_top: 0 } }), 0);
  assert.equal(screwFromTop({ measured: { screw_from_top: 1 } }), 1);
  const spec = { layers: 2, measured: { ref_width: 118.2, screw_from_top: 1 }, bands: [] };
  const flipped = specWithScrew(spec, 0);
  assert.equal(flipped.measured.screw_from_top, 0);
  assert.equal(flipped.measured.ref_width, 118.2, "measured 其他鍵不動");
  assert.equal(spec.measured.screw_from_top, 1, "原 spec 不被就地改");
  assert.equal(specWithScrew(null, 0), null, "無 spec 原樣回(範本沒 CABLE_SPEC)");
  assert.ok(screwLabel(1).includes("六角袋朝下"));
  assert.ok(screwLabel(0).includes("六角袋朝上"));
});

test("composeCableSpecText:帶 spec 時列固定座螺向並標明不要再問", () => {
  const spec = { layers: 3, riser_module: 0, measured: { screw_from_top: 1 }, bands: BANDS };
  const text = composeCableSpecText(form({ spec }));
  assert.ok(text.includes("固定座螺向:六角袋朝下"), text);
  assert.ok(text.includes("表單已確認,不要再問"), text);
  const flipped = composeCableSpecText(form({ spec: specWithScrew(spec, 0), specDirty: true }));
  assert.ok(flipped.includes("固定座螺向:六角袋朝上"), flipped);
  // 沒有 spec 的範本:不出這行(表單也不給改,對話改)
  assert.ok(!composeCableSpecText(form()).includes("固定座螺向"));
});

test("specWithBand / layerEditable:單條層可改口袋數與內腔寬;並排列不給改", () => {
  const edited = specWithBand(SPEC, 2, { n: 8, bore: 16 });
  const inner = edited.bands.find((b) => b.key === "inner");
  assert.equal(inner.n, 8);
  assert.equal(inner.bore, 16);
  assert.equal(edited.bands.find((b) => b.key === "mid").n, 7, "沒動到別層");
  assert.equal(layerEditable(SPEC, 2), true);
  assert.equal(layerEditable(SPEC, 0), false, "level 0 有兩條並排 → 不可編");
  // 只改一項也行,另一項保留
  assert.equal(specWithBand(SPEC, 1, { n: 9 }).bands.find((b) => b.key === "mid").bore, 11.4);
});

test("composeCableSpecText:結構改過 → 標明「表單已改」並列新層數", () => {
  const f = form({
    spec: { layers: 4, riser_module: 1, bands: [{ key: "a", level: 0, n: 7, bore: 11.4 }, { key: "b", level: 1, n: 6, bore: 14 }, { key: "c", level: 2, n: 6, bore: 14 }, { key: "d", level: 3, n: 6, bore: 14 }] },
    specDirty: true,
  });
  const t = composeCableSpecText(f);
  assert.ok(t.includes("表單已改"), t.slice(t.indexOf("結構")));
  assert.ok(t.includes("- 層數:4"));
  assert.ok(t.includes("加高模組:固定架由下數第 2 格"));
});

test("defsWithLayers:新層長出欄位、砍掉的消失、head_h 下限跟著層數", () => {
  const defs = [
    { key: "L1", label: "L1", min: 200, max: 2500, step: 5, value: 805, unit: "mm" },
    { key: "L2", label: "L2", min: 200, max: 2500, step: 5, value: 840, unit: "mm" },
    { key: "L3", label: "L3", min: 200, max: 2500, step: 5, value: 870, unit: "mm" },
    { key: "head_h", label: "head_h", min: 34.5, max: 80, step: 0.5, value: 39.5, unit: "mm" },
    { key: "width", label: "width", min: 50, max: 250, step: 2, value: 118.2, unit: "mm" },
  ];
  const up = defsWithLayers(defs, 3, 4, { L1: 805, L2: 840, L3: 870, L4: 905, head_h: 51 });
  assert.deepEqual(up.map((d) => d.key), ["L1", "L2", "L3", "L4", "head_h", "width"]);
  assert.equal(up.find((d) => d.key === "L4").value, 905);
  assert.equal(up.find((d) => d.key === "L4").max, 2500, "新 L 沿用既有 L 的範圍模板");
  assert.equal(up.find((d) => d.key === "head_h").min, 46);
  assert.equal(up.find((d) => d.key === "head_h").value, 51);
  const down = defsWithLayers(defs, 3, 2, { L1: 805, L2: 840, head_h: 28 });
  assert.deepEqual(down.map((d) => d.key), ["L1", "L2", "head_h", "width"]);
  assert.equal(down.find((d) => d.key === "head_h").min, 23);
  // 層數大到讓下限超過原上限時,上限一起放寬(否則一加層就永遠越界)
  const big = defsWithLayers(defs, 3, 8, { head_h: 97 });
  const hh = big.find((d) => d.key === "head_h");
  assert.equal(hh.min, 92);
  assert.ok(hh.max >= 122, String(hh.max));
});
