// 檢查列的具體發現(藍圖 B2):validate.py 每列帶 findings,這裡鎖「伺服器怎麼把它送到前端」
// 與「快路徑(不 spawn)產生的列和 validate.py 同形」。
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkView, decorateChecks, designChecksFromMeta, motionEvent } from "./cad/pipeline.mjs";
import { signatureForCheck } from "./lessons.mjs";

const overlap = (a, b, value) => ({
  rule: "interference.overlap", status: "failed", message: `${a} 與 ${b} 重疊 ${value.toFixed(1)} mm³`,
  value, limit: 0.001, unit: "mm^3", refs: [a, b],
});

test("checkView:有 findings 就帶到前端,並附總數;沒有就不帶這兩個欄位", () => {
  const [row] = decorateChecks([
    { id: "interference", label: "零件干涉", ok: false, note: "2 處未宣告干涉: a~b(12.0mm³), c~d(3.0mm³)", findings: [overlap("a", "b", 12), overlap("c", "d", 3)] },
  ]);
  const view = checkView(row);
  assert.equal(view.status, "failed");
  assert.equal(view.findingCount, 2);
  assert.deepEqual(view.findings.map((f) => f.refs), [["a", "b"], ["c", "d"]]);
  assert.equal(view.findings[0].message, "a 與 b 重疊 12.0 mm³");

  const [plain] = decorateChecks([{ id: "valid_solid", label: "有效實體", ok: true, note: "BRepCheck valid" }]);
  const plainView = checkView(plain);
  assert.ok(!("findings" in plainView) && !("findingCount" in plainView));
  assert.deepEqual(Object.keys(plainView), ["label", "icon", "color", "note", "skipped", "status"]);
});

test("checkView:一列最多送 8 筆,總數照實", () => {
  const many = Array.from({ length: 20 }, (_, i) => overlap("p" + i, "q" + i, 20 - i));
  const [row] = decorateChecks([{ id: "interference", label: "零件干涉", ok: false, note: "20 處", findings: many }]);
  const view = checkView(row);
  assert.equal(view.findings.length, 8);
  assert.equal(view.findingCount, 20);
  assert.deepEqual(view.findings[0].refs, ["p0", "q0"]); // 順序不動(validate.py 已排好:嚴重的在前)
});

test("checkView:findings 不是陣列(舊快取、壞資料)→ 當作沒有", () => {
  const [row] = decorateChecks([{ id: "interference", label: "零件干涉", ok: true, note: "0 undeclared overlaps", findings: "x" }]);
  assert.ok(!("findings" in checkView(row)));
});

test("快路徑的 MOTION 宣告錯誤列:每條錯誤一筆 finding,規則代號與 validate.py 相同", () => {
  const rows = designChecksFromMeta({
    parts: ["a", "b"], partCount: 2, motion: null,
    motionErrs: ["dofs[0].travel 必須是非零數值", "dofs[1].moving 含未知零件 x"],
  });
  const motion = rows.find((r) => r.id === "motion_sweep");
  assert.equal(motion.status, "failed");
  assert.deepEqual(motion.findings.map((f) => f.rule), ["motion.declaration", "motion.declaration"]);
  assert.equal(motion.findings[1].message, "dofs[1].moving 含未知零件 x");
  // 教訓庫照樣歸到宣告錯誤那一組
  assert.equal(signatureForCheck(motion).signature, "validate:motion_sweep:declaration");
  // 其餘列(略過的)沒有 findings
  for (const r of rows.filter((x) => x.id !== "motion_sweep")) assert.ok(!("findings" in r), r.id);
});

test("motionEvent:具名姿態與動作序列有宣告才帶;沒有 motion 時是空 dofs(清除舊宣告)", () => {
  assert.deepEqual(motionEvent("rig", null), { name: "rig", schemaVersion: 1, dofs: [] });
  const dofs = [{ id: "lift" }];
  assert.deepEqual(motionEvent("rig", { dofs }), { name: "rig", schemaVersion: 1, dofs });
  assert.deepEqual(motionEvent("rig", { dofs, states: {}, sequences: {} }), { name: "rig", schemaVersion: 1, dofs });
  const full = motionEvent("rig", { dofs, states: { up: { lift: 1 } }, sequences: { go: ["home", "up"] } });
  assert.deepEqual(full.states, { up: { lift: 1 } });
  assert.deepEqual(full.sequences, { go: ["home", "up"] });
});
