// 檢查列的具體發現(藍圖 B2):validate.py 每列帶 findings,這裡鎖「伺服器怎麼把它送到前端」
// 與「快路徑(不 spawn)產生的列和 validate.py 同形」。
import assert from "node:assert/strict";
import { test } from "node:test";

import { advisoryLabel, checkView, decorateChecks, designChecksFromMeta, fullValidationOk, motionEvent } from "./cad/pipeline.mjs";
import { verdictFor } from "../lib/validateVerdict.js";
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

// 鈑金可製造性建議(藍圖 F1):做得出來,但加工廠會提的事。只回報、不擋。
const ADVISORY = { rule: "sheet.hole_spacing", status: "warning", message: "面板「base」的兩個孔邊到邊只隔 2.00 mm", value: 2, limit: 4, unit: "mm", refs: ["base"] };

test("快路徑:sidecar 有建議就多一列「鈑金可製造性(建議)」,狀態是 advisory;沒有就不多列", () => {
  const meta = { parts: ["a"], partCount: 1, motion: null, motionErrs: [] };
  assert.ok(!designChecksFromMeta({ ...meta, advisories: [] }).some((r) => r.id === "sheet_dfm"));
  assert.ok(!designChecksFromMeta(meta).some((r) => r.id === "sheet_dfm")); // 舊 sidecar 沒有這欄
  const rows = designChecksFromMeta({ ...meta, advisories: [ADVISORY] });
  const row = rows[rows.length - 1];
  assert.deepEqual([row.id, row.status, row.ok, row.skipped, row.note], ["sheet_dfm", "advisory", true, false, "1 項建議"]);
  const view = checkView(decorateChecks([row])[0]);
  assert.deepEqual([view.icon, view.status, view.findingCount], ["!", "advisory", 1]);
  assert.equal(view.findings[0].status, "warning");
});

test("建議列不擋匯出,也不能單獨讓驗證算通過", () => {
  const advisory = { id: "sheet_dfm", ok: true, status: "advisory", findings: [ADVISORY] };
  const pass = { id: "valid_solid", ok: true, status: "ok" };
  assert.equal(fullValidationOk([pass, advisory]), true);
  assert.equal(fullValidationOk([{ id: "interference", ok: false, status: "failed" }, advisory]), false);
  assert.equal(fullValidationOk([{ id: "motion_sweep", ok: true, skipped: true, status: "not_checked" }, advisory]), false);
  assert.equal(fullValidationOk([advisory]), false); // 只有建議、沒有任何檢查:不算通過
  assert.equal(fullValidationOk([]), false);
});

test("驗證卡標題:建議不算通過、不算未驗證,只在尾端提一句", () => {
  const advisory = { status: "advisory", findings: [ADVISORY, ADVISORY], findingCount: 2 };
  assert.deepEqual(verdictFor({ ok: true, checks: [{ status: "ok" }, { status: "ok" }, advisory] }), { text: "全部通過 · 2 項建議", tone: "ok" });
  assert.deepEqual(verdictFor({ ok: true, checks: [{ skipped: true, status: "not_checked" }, advisory] }), { text: "未執行檢查 · 2 項建議", tone: "muted" });
  assert.deepEqual(verdictFor({ ok: true, checks: [{ status: "ok" }] }), { text: "全部通過", tone: "ok" });
  assert.deepEqual(verdictFor({ ok: false, checks: [{ ok: false, status: "failed" }, advisory] }), { text: "偵測到問題", tone: "danger" });
});

// 切削可製造性建議(藍圖 F3)與鈑金建議共用同一列;標題依規則種類決定(與 validate.py 逐字同步)。
test("建議列的標題:鈑金、切削、兩者都有", () => {
  const sheet = { rule: "sheet.hole_spacing", status: "warning", message: "x" };
  const cnc = { rule: "cnc.sharp_internal_corner", status: "warning", message: "y", refs: ["plate"] };
  assert.equal(advisoryLabel([sheet]), "鈑金可製造性(建議)");
  assert.equal(advisoryLabel([cnc, cnc]), "切削可製造性(建議)");
  assert.equal(advisoryLabel([sheet, cnc]), "可製造性(建議)");
  assert.equal(advisoryLabel([]), "可製造性(建議)");

  const meta = { name: "p", parts: ["plate"], partCount: 1, motion: null, motionErrs: [] };
  const row = designChecksFromMeta({ ...meta, advisories: [cnc] }).find((r) => r.id === "sheet_dfm");
  assert.deepEqual([row.label, row.status, row.ok, row.note], ["切削可製造性(建議)", "advisory", true, "1 項建議"]);
});
