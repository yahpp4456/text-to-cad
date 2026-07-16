import assert from "node:assert/strict";
import { test } from "node:test";
import { commitValue, fmtValue, isIntDef, stepValue } from "./numberField.js";

test("isIntDef:只接受明確的 int true", () => {
  assert.equal(isIntDef({ int: true }), true);
  assert.equal(isIntDef({}), false);
  assert.equal(isIntDef({ step: 1 }), false);
  assert.equal(isIntDef({ int: "yes" }), false);
});

test("fmtValue:整數取整、浮點保留兩位並去尾零", () => {
  assert.equal(fmtValue(3.6, { int: true }), "4");
  assert.equal(fmtValue(16.666, {}), "16.67");
  assert.equal(fmtValue(16.5, {}), "16.5");
  assert.equal(fmtValue(NaN, {}), "");
});

test("commitValue:拒絕空白與非有限輸入", () => {
  assert.deepEqual(commitValue("abc", {}), { ok: false });
  assert.deepEqual(commitValue("", {}), { ok: false });
  assert.deepEqual(commitValue("  ", {}), { ok: false });
  assert.deepEqual(commitValue(Infinity, {}), { ok: false });
});

test("commitValue:依參數型別取整", () => {
  assert.deepEqual(commitValue("3.456", {}), { ok: true, value: 3.46 });
  assert.deepEqual(commitValue("3.5", { int: true }), { ok: true, value: 4 });
});

test("commitValue:只套用存在且有限的上下界", () => {
  const bounded = { min: 1, max: 7 };
  assert.deepEqual(commitValue("99", bounded), { ok: true, value: 7 });
  assert.deepEqual(commitValue("0", bounded), { ok: true, value: 1 });
  assert.deepEqual(commitValue("99", {}), { ok: true, value: 99 });
  assert.deepEqual(commitValue("-2", {}), { ok: true, value: -2 });
});

test("stepValue:使用步距、邊界與無效 current 的起點", () => {
  assert.equal(stepValue(2, { step: 0.5 }, 1), 2.5);
  assert.equal(stepValue(7, { max: 7, step: 0.5 }, 1), 7);
  assert.equal(stepValue(NaN, { min: 1, step: 0.5 }, 1), 1.5);
  assert.equal(stepValue(2, {}, -1), 1);
});
