// 工作台清單(「無塵電纜工作台」的範本卡與案件卡;免 LLM、零 spawn)。
//
// **沒有第二份型錄檔**:真相就是產生器 .py 頂部那幾份 JSON 相容宣告——
//   TEMPLATE_META  範本卡中繼(family/form/label/summary/unit/self_contained)
//   CABLE_SPEC     電纜結構規格(layers/riser_module/bands)
//   PARAM_LABELS   欄位中文標籤   PARAM_NOTES 量法/計算說明
//   PARAMS/PARAM_RANGES 由既有 paramDefs/paramValues 解析(表單欄位與現值)
// 案件(使用者另存出去的客戶案)另在目錄放 case.json —— 可變的案件紀錄
// (客戶/日期/來源範本/備註)不寫進 .py:.py 的寫入者只有 rewriteParams 一個。
//
// 掃描一層 models/*/(save-project 就是存成 models/<name>/),雙根合併
// (per-user 可寫層優先、fixtures 唯讀層補集,同名以可寫層為準)。
import fs from "node:fs";
import path from "node:path";

import { MODELS_FIXTURES_ROOT, MODELS_ROOT } from "../config.mjs";
import { resolveInside } from "./paths.mjs";
import {
  paramDefsFromGenerator,
  paramValuesFromGenerator,
  pickGenerator,
  readCableSpec,
  readFlatJsonDecl,
  readTemplateMeta,
} from "./pipeline.mjs";

export const CASE_FILE = "case.json";

// 案件紀錄(save-project 寫、工作台讀)。壞檔/不存在 → null(當成非案件,不炸)。
export function readCaseMeta(absDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(absDir, CASE_FILE), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

// 案件中繼的合併(save-project 兩路共用):
//   prev=null(另存成新目錄)→ 全由 body 決定(與 2026-08-25 的寫法逐位相同,只多 updated);
//   prev 有值(就地儲存 / 覆蓋既有案件)→ body 非空才覆蓋,否則沿用既有——
//   就地儲存沒帶 customer/note 不會把客戶名清掉、created 不會被重設。
export function buildCaseMeta(prev, body, { name, fallbackSourceTemplate = "", today } = {}) {
  const p = prev && typeof prev === "object" ? prev : null;
  const pick = (v, fallback, max) => {
    const s = typeof v === "string" ? v.trim() : "";
    return String(s || fallback || "").slice(0, max);
  };
  const day = today || new Date().toISOString().slice(0, 10);
  return {
    kind: "case",
    family: "cable",
    label: pick(body?.label, p?.label || name, 80),
    customer: pick(body?.customer, p?.customer, 80),
    note: pick(body?.note, p?.note, 400),
    source_template: pick(body?.sourceTemplate, p?.source_template || fallbackSourceTemplate, 120),
    created: pick(p?.created, day, 10),
    updated: day,
  };
}

// 單一目錄 → 工作台條目(不是範本/案件回 null)。absDir 必須已在沙箱內解析過。
function entryFor(absDir, dirRel) {
  const name = pickGenerator(absDir);
  if (!name) return null;
  const ref = { workdir: absDir };
  const meta = readTemplateMeta(ref, name);
  const caseMeta = readCaseMeta(absDir);
  if (!meta && !caseMeta) return null; // 一般專案目錄:不進工作台(仍可從「開啟檔案」開)
  const family = str(caseMeta?.family) || str(meta?.family) || "other";
  const spec = readCableSpec(ref, name);
  const glbName = `.${name}.step.glb`;
  const hasGlb = fs.existsSync(path.join(absDir, glbName));
  return {
    dir: dirRel,
    name,
    kind: caseMeta ? "case" : "template",
    family,
    form: str(meta?.form),
    label: str(caseMeta?.label) || str(meta?.label) || dirRel,
    summary: str(caseMeta?.note) || str(meta?.summary),
    unit: str(meta?.unit, "mm"),
    // self_contained:整個件只靠這支 .py(無 imported/ 相依)→「複製成新案」只需複製 .py
    selfContained: meta?.self_contained === 1,
    layers: Number.isFinite(spec?.layers) ? spec.layers : null,
    riserModule: Number.isFinite(spec?.riser_module) ? spec.riser_module : null,
    bands: Array.isArray(spec?.bands) ? spec.bands : null,
    spec: spec || null, // 完整 CABLE_SPEC:表單改層數/帶型時的工作副本來源
    params: paramDefsFromGenerator(ref, name), // 表單欄位(含 PARAM_RANGES 固定範圍)
    values: paramValuesFromGenerator(ref, name) || {},
    labels: readFlatJsonDecl(ref, name, "PARAM_LABELS") || {},
    notes: readFlatJsonDecl(ref, name, "PARAM_NOTES") || {},
    glbRel: hasGlb ? `${dirRel}/${glbName}` : null, // 卡片縮圖(前端組 /api/asset)
    case: caseMeta
      ? {
          customer: str(caseMeta.customer),
          created: str(caseMeta.created),
          sourceTemplate: str(caseMeta.source_template),
          note: str(caseMeta.note),
        }
      : null,
  };
}

// 列工作台清單。family 給定就只回該家族(cable);回 {templates, cases}。
export function listWorkbench(modelsRoot = MODELS_ROOT, { family } = {}) {
  const roots = [modelsRoot];
  if (MODELS_FIXTURES_ROOT !== modelsRoot) roots.push(MODELS_FIXTURES_ROOT);
  const seen = new Set();
  const templates = [];
  const cases = [];
  for (const root of roots) {
    let ents;
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const dirRel = ent.name;
      if (dirRel.startsWith(".") || dirRel === "__pycache__" || dirRel === "node_modules") continue;
      if (seen.has(dirRel)) continue; // 可寫層優先(同名不再看 fixtures 層)
      let absDir;
      try {
        absDir = resolveInside(root, dirRel);
      } catch {
        continue;
      }
      let entry = null;
      try {
        entry = entryFor(absDir, dirRel);
      } catch {
        entry = null; // 壞目錄不擋整張清單
      }
      if (!entry) continue;
      seen.add(dirRel);
      if (family && entry.family !== family) continue;
      (entry.kind === "case" ? cases : templates).push(entry);
    }
  }
  // 範本依 layers 再依 label;案件新的在前(created 降冪,無值最後)
  templates.sort((a, b) => (a.layers ?? 99) - (b.layers ?? 99) || a.label.localeCompare(b.label));
  cases.sort((a, b) => String(b.case?.created || "").localeCompare(String(a.case?.created || "")));
  return { templates, cases };
}
