// clarify/spec 文字契約純函式單元測(node --test):三端共用(tools.mjs 正規化、
// events.js 防禦、ClarifyWizard 合成、chatStore RESTORE re-arm)。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeClarifyReply,
  isAssumedChip,
  pendingClarifyFromItems,
  stripAssumedTag,
  unescapeNewlines,
} from "./clarifyText.js";

// ---------------------------------------------------------------------------
// unescapeNewlines — 字面 \n 修復(使用者截圖的實際症狀)
// ---------------------------------------------------------------------------

test("unescapeNewlines:字面 backslash+n / \\r\\n → 真換行;真換行原樣;null 安全", () => {
  assert.equal(unescapeNewlines("a\\n・b"), "a\n・b"); // 模型雙重跳脫的實際樣態
  assert.equal(unescapeNewlines("a\\r\\nb"), "a\nb");
  assert.equal(unescapeNewlines("a\nb"), "a\nb"); // 真換行不動
  assert.equal(unescapeNewlines("純文字"), "純文字");
  assert.equal(unescapeNewlines(null), "");
  assert.equal(unescapeNewlines(undefined), "");
});

// ---------------------------------------------------------------------------
// isAssumedChip / stripAssumedTag — 結構化旗標為主、文字慣例 fallback
// ---------------------------------------------------------------------------

test("isAssumedChip:assumed===true 為主;「(假設)」全半形括號 fallback;都無 → false", () => {
  assert.equal(isAssumedChip({ k: "導軌", v: "HGR15", assumed: true }), true);
  assert.equal(isAssumedChip({ k: "導軌", v: "HGR15(假設)" }), true); // 半形括號
  assert.equal(isAssumedChip({ k: "導軌", v: "HGR15（假設）" }), true); // 全形括號
  assert.equal(isAssumedChip({ k: "導軌", v: "HGR15( 假設 )" }), true); // 帶空白
  assert.equal(isAssumedChip({ k: "行程", v: "100 mm" }), false);
  assert.equal(isAssumedChip({ k: "x", v: "y", assumed: "yes" }), false); // 非布林不算
  assert.equal(isAssumedChip(null), false);
});

test("stripAssumedTag:剝「(假設)」字樣(badge 取代);無標記原樣", () => {
  assert.equal(stripAssumedTag("HGR15(假設)"), "HGR15");
  assert.equal(stripAssumedTag("中載 ~10 kg(假設)"), "中載 ~10 kg");
  assert.equal(stripAssumedTag("100 mm"), "100 mm");
  assert.equal(stripAssumedTag(null), "");
});

// ---------------------------------------------------------------------------
// composeClarifyReply — 四象限(「規格修正:」前綴是 prompt.mjs 契約)
// ---------------------------------------------------------------------------

test("composeClarifyReply:無修改 → 原樣送答案(現狀不變)", () => {
  assert.equal(composeClarifyReply({ edits: {}, answer: "中載標準配置" }), "中載標準配置");
  assert.equal(composeClarifyReply({}), "");
});

test("composeClarifyReply:修改+選項 → 規格修正前綴+其餘採用", () => {
  assert.equal(
    composeClarifyReply({ edits: { 導軌: "HGR20", 行程: "150 mm" }, answer: "中載標準配置" }),
    "規格修正:導軌 改為 HGR20;行程 改為 150 mm。\n其餘採用:中載標準配置",
  );
});

test("composeClarifyReply:只改規格 → 有 suggested 帶建議、無則明示繼續", () => {
  assert.equal(
    composeClarifyReply({ edits: { 導軌: "HGR20" }, answer: null, suggested: "HGR15+SFU1605" }),
    "規格修正:導軌 改為 HGR20。\n其餘採用建議:HGR15+SFU1605",
  );
  assert.equal(
    composeClarifyReply({ edits: { 導軌: "HGR20" }, answer: null, suggested: "" }),
    "規格修正:導軌 改為 HGR20。其餘依你的建議值繼續,不必再確認。",
  );
});

// ---------------------------------------------------------------------------
// pendingClarifyFromItems — RESTORE re-arm
// ---------------------------------------------------------------------------

const SPEC = { type: "spec", chips: [{ k: "導軌", v: "HGR15", assumed: true }] };
const CLARIFY = { type: "clarify", q: "選配置?", opts: [{ label: "A", value: "a" }], suggested: "s" };

test("pendingClarifyFromItems:未答 clarify → re-arm 含同段 specs", () => {
  const p = pendingClarifyFromItems([{ type: "user" }, SPEC, CLARIFY]);
  assert.equal(p.q, "選配置?");
  assert.deepEqual(p.specs, SPEC.chips);
  assert.equal(p.suggested, "s");
});

test("pendingClarifyFromItems:已答(clarify 後有 user)→ null", () => {
  assert.equal(pendingClarifyFromItems([SPEC, CLARIFY, { type: "user" }]), null);
});

test("pendingClarifyFromItems:clarify 前無 spec → specs null(精靈退化單步)", () => {
  const p = pendingClarifyFromItems([{ type: "user" }, CLARIFY]);
  assert.equal(p.specs, null);
});

test("pendingClarifyFromItems:不跨 user 段撈舊 spec", () => {
  // 舊回合的 spec 不屬於這次 clarify(turnSpec 語意:START_RUN 清空)
  const p = pendingClarifyFromItems([SPEC, { type: "user" }, CLARIFY]);
  assert.equal(p.specs, null);
});

test("pendingClarifyFromItems:空/無 clarify → null", () => {
  assert.equal(pendingClarifyFromItems([]), null);
  assert.equal(pendingClarifyFromItems(null), null);
  assert.equal(pendingClarifyFromItems([{ type: "user" }, SPEC]), null);
});
