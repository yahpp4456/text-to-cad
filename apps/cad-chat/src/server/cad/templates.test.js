// 工作台清單掃描器單元測(node --test):tmp models 根注入。
// 注意:listWorkbench 會把 MODELS_FIXTURES_ROOT(dev = repo/models)當補集一起掃,
// 所以測試一律用**專屬 family**過濾,真 models/ 的 cable 範本不會混進斷言。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildCaseMeta, listWorkbench, readCaseMeta } from "./templates.mjs";

const FAM = "tplsmoke"; // 專屬家族:與真 models/ 的 cable 隔離

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-tpl-${tag}-`));
}

function writeProject(root, dir, { meta, spec, params, ranges, labels, notes, caseJson, glb } = {}) {
  const abs = path.join(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  const lines = [];
  if (meta) lines.push(`TEMPLATE_META = ${JSON.stringify(meta)}`);
  if (labels) lines.push(`PARAM_LABELS = ${JSON.stringify(labels)}`);
  if (notes) lines.push(`PARAM_NOTES = ${JSON.stringify(notes)}`);
  if (spec) lines.push(`CABLE_SPEC = ${JSON.stringify(spec)}`);
  if (params) lines.push(`PARAMS = ${JSON.stringify(params)}`);
  if (ranges) lines.push(`PARAM_RANGES = ${JSON.stringify(ranges)}`);
  lines.push("def gen_step():", "    return None", "");
  fs.writeFileSync(path.join(abs, `${dir}.py`), lines.join("\n"), "utf8");
  if (caseJson) fs.writeFileSync(path.join(abs, "case.json"), JSON.stringify(caseJson), "utf8");
  if (glb) fs.writeFileSync(path.join(abs, `.${dir}.step.glb`), "glb", "utf8");
  return abs;
}

test("listWorkbench:有 TEMPLATE_META 的目錄才是範本;帶 spec/欄位/縮圖", () => {
  const root = tmpRoot("basic");
  try {
    writeProject(root, "tpl_a", {
      meta: { family: FAM, form: "per_layer", label: "三層", summary: "s", unit: "mm", self_contained: 1 },
      spec: { layers: 3, riser_module: 0, bands: [{ key: "b1", level: 0, n: 6, bore: 14.0, web: 2.5, edge: 4.25, x: 0.0 }] },
      params: { L1: 805.0, width: 118.2 },
      ranges: { L1: [200, 2500, 5], width: [50, 250, 2] },
      labels: { L1: "第1層電纜長" },
      notes: { L1: "含夾持段 32.4" },
      glb: true,
    });
    // 一般專案(有 gen_step 但沒中繼)→ 不進工作台
    writeProject(root, "plain_proj", { params: { w: 10.0 } });
    // 沒有產生器的目錄 → 不進
    fs.mkdirSync(path.join(root, "just_files"), { recursive: true });
    fs.writeFileSync(path.join(root, "just_files", "a.step"), "x", "utf8");

    const { templates, cases } = listWorkbench(root, { family: FAM });
    assert.equal(cases.length, 0);
    assert.equal(templates.length, 1);
    const t = templates[0];
    assert.equal(t.dir, "tpl_a");
    assert.equal(t.name, "tpl_a");
    assert.equal(t.kind, "template");
    assert.equal(t.form, "per_layer");
    assert.equal(t.layers, 3);
    assert.equal(t.riserModule, 0);
    assert.equal(t.bands.length, 1);
    assert.equal(t.selfContained, true);
    assert.equal(t.values.L1, 805);
    assert.equal(t.labels.L1, "第1層電纜長");
    assert.equal(t.notes.L1, "含夾持段 32.4");
    assert.equal(t.glbRel, "tpl_a/.tpl_a.step.glb");
    // 欄位定義沿用 PARAM_RANGES 的固定範圍(表單/滑桿共用同一份)
    const l1 = t.params.find((d) => d.key === "L1");
    assert.deepEqual([l1.min, l1.max, l1.step, l1.value], [200, 2500, 5, 805]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkbench:case.json 的目錄歸「案件」,中繼帶客戶/日期/來源範本", () => {
  const root = tmpRoot("case");
  try {
    writeProject(root, "case_a", {
      meta: { family: FAM, form: "per_layer", label: "範本名", self_contained: 1 },
      caseJson: {
        family: FAM,
        customer: "客戶甲",
        created: "2026-08-25",
        source_template: "tpl_a",
        note: "第一版",
        label: "甲-0825",
      },
      params: { L1: 810.0 },
    });
    writeProject(root, "case_b", {
      meta: { family: FAM, label: "範本名" },
      caseJson: { family: FAM, customer: "客戶乙", created: "2026-08-20" },
      params: { L1: 900.0 },
    });
    const { templates, cases } = listWorkbench(root, { family: FAM });
    assert.equal(templates.length, 0, "有 case.json 就不算範本");
    assert.equal(cases.length, 2);
    assert.equal(cases[0].dir, "case_a", "新的在前(created 降冪)");
    assert.equal(cases[0].label, "甲-0825", "case.json 的 label 蓋過 TEMPLATE_META");
    assert.equal(cases[0].case.customer, "客戶甲");
    assert.equal(cases[0].case.sourceTemplate, "tpl_a");
    assert.equal(cases[0].kind, "case");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkbench:family 過濾;壞宣告/壞 case.json 不擋整張清單", () => {
  const root = tmpRoot("bad");
  try {
    writeProject(root, "ok_one", { meta: { family: FAM, label: "好的" }, params: { a: 1.0 } });
    writeProject(root, "other_fam", { meta: { family: `${FAM}_other`, label: "別家" }, params: { a: 1.0 } });
    // 壞 TEMPLATE_META(Python 單引號)→ 不是範本,但不能讓整張清單炸
    const abs = path.join(root, "broken_meta");
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(
      path.join(abs, "broken_meta.py"),
      "TEMPLATE_META = {'family': 'tplsmoke'}\ndef gen_step():\n    return None\n",
      "utf8",
    );
    // 壞 case.json → readCaseMeta 回 null(該目錄若也沒中繼就不列)
    const abs2 = path.join(root, "broken_case");
    fs.mkdirSync(abs2, { recursive: true });
    fs.writeFileSync(path.join(abs2, "broken_case.py"), "def gen_step():\n    return None\n", "utf8");
    fs.writeFileSync(path.join(abs2, "case.json"), "{not json", "utf8");
    assert.equal(readCaseMeta(abs2), null);

    const { templates, cases } = listWorkbench(root, { family: FAM });
    assert.deepEqual(templates.map((t) => t.dir), ["ok_one"]);
    assert.equal(cases.length, 0);
    // 不給 family → 兩個家族都在(且仍不含壞的)
    const all = listWorkbench(root, {});
    const dirs = all.templates.map((t) => t.dir);
    assert.ok(dirs.includes("ok_one") && dirs.includes("other_fam"), dirs.join(","));
    assert.ok(!dirs.includes("broken_meta") && !dirs.includes("broken_case"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkbench:根不存在 → 空清單(不 throw)", () => {
  const { templates, cases } = listWorkbench(path.join(os.tmpdir(), "cadchat-no-such-root-x"), {
    family: FAM,
  });
  assert.deepEqual(templates, []);
  assert.deepEqual(cases, []);
});

// ── buildCaseMeta(save-project 兩路共用的案件中繼合併)──
test("buildCaseMeta:prev=null(另存新目錄)→ 全由 body 決定,created=today,多 updated", () => {
  const m = buildCaseMeta(
    null,
    { label: "案 A", customer: "甲", note: "n", sourceTemplate: "cable_x_per_layer" },
    { name: "case_a", today: "2026-09-15" },
  );
  assert.deepEqual(m, {
    kind: "case",
    family: "cable",
    label: "案 A",
    customer: "甲",
    note: "n",
    source_template: "cable_x_per_layer",
    created: "2026-09-15",
    updated: "2026-09-15",
  });
  // 缺欄位:label 退 name、source_template 退 fallback、其餘空字串
  const m2 = buildCaseMeta(null, {}, { name: "case_b", fallbackSourceTemplate: "tpl", today: "2026-09-15" });
  assert.equal(m2.label, "case_b");
  assert.equal(m2.customer, "");
  assert.equal(m2.source_template, "tpl");
});

test("buildCaseMeta:prev 有值(就地儲存)→ body 空不清掉客戶名/備註,created 保住,updated=today", () => {
  const prev = {
    kind: "case",
    family: "cable",
    label: "舊標",
    customer: "甲",
    note: "舊備註",
    source_template: "tpl_x",
    created: "2026-08-25",
  };
  const m = buildCaseMeta(prev, {}, { name: "case_a", today: "2026-09-15" });
  assert.equal(m.label, "舊標");
  assert.equal(m.customer, "甲");
  assert.equal(m.note, "舊備註");
  assert.equal(m.source_template, "tpl_x");
  assert.equal(m.created, "2026-08-25");
  assert.equal(m.updated, "2026-09-15");
  // body 非空才覆蓋;空白字串視為沒給
  const m2 = buildCaseMeta(prev, { customer: "乙", note: "   " }, { name: "case_a", today: "2026-09-15" });
  assert.equal(m2.customer, "乙");
  assert.equal(m2.note, "舊備註");
  // slice 上限
  const m3 = buildCaseMeta(prev, { note: "x".repeat(500) }, { name: "case_a", today: "2026-09-15" });
  assert.equal(m3.note.length, 400);
});
