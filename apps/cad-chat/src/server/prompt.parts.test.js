// 設計 prompt 內嵌的 cadpy.parts 簽章防漂移鎖(node --test):2026-10-09 減模型往返——
// 原本 agent 每個建模回合都 Read 個人記憶檔 + Grep/Read cadpy 原始碼確認簽章與座標慣例
// (5–8 次往返),改成把簽章內嵌 prompt。內嵌文字與 python 原始碼若漂移,agent 會照錯簽章
// 寫產生器 → build 紅;本測試逐參數比對 def 行,並鎖「流程不再要求 emit_stage」與收尾限長。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildSystemPrompt } from "./agent/prompt.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../../..");
const PARTS = path.join(REPO, "packages/cadpy/src/cadpy/parts");
const session = { sessionId: "s_test", workdirRel: "models/.cadchat/s_test", mode: "design" };
const prompt = buildSystemPrompt(session);

// python 原始碼 `def <fn>(…) -> Any:` 的參數名清單(含 keyword-only;略過 `*`)。
function pyParams(file, fn) {
  const src = fs.readFileSync(path.join(PARTS, file), "utf8");
  const m = src.match(new RegExp(`^def ${fn}\\(([\\s\\S]*?)\\)\\s*->`, "m"));
  assert.ok(m, `${file}: 找不到 def ${fn}(`);
  return m[1]
    .split(",")
    .map((s) => s.trim().split(":")[0].split("=")[0].trim())
    .filter((s) => s && s !== "*");
}

const FAMILIES = [
  ["linear_guide.py", "linear_guide", "linear_guides.json"],
  ["ball_screw.py", "ball_screw", "ball_screws.json"],
  ["stepper_motor.py", "stepper_motor", "motors.json"],
  ["deep_groove_bearing.py", "deep_groove_bearing", "bearings.json"],
  ["pneumatic_cylinder.py", "pneumatic_cylinder", "cylinders.json"],
  ["gripper.py", "gripper", "grippers.json"],
];

// 簽章行 = prompt 中含 `<fn>(` 的那一行(反引號起頭),取到行尾比對參數名。
function promptSignatureLine(fn) {
  const line = prompt.split("\n").find((l) => l.includes(`\`${fn}(`));
  assert.ok(line, `prompt 缺 ${fn}( 簽章行`);
  return line.slice(line.indexOf(`\`${fn}(`));
}

test("prompt 內嵌的六個 cadpy.parts 簽章與 python def 參數逐一對齊(防漂移)", () => {
  for (const [file, fn] of FAMILIES) {
    const sig = promptSignatureLine(fn);
    const params = pyParams(file, fn);
    assert.ok(params.length >= 3, `${fn}: 原始碼參數抽取異常 ${params}`);
    for (const p of params) {
      assert.ok(new RegExp(`\\b${p}\\b`).test(sig), `${fn}: prompt 簽章缺參數 ${p}(原始碼已變?)`);
    }
    // 反向:prompt 簽章括號內的識別字都要是真參數(抓 prompt 寫錯/多寫)
    const inner = sig.slice(sig.indexOf("(") + 1, sig.indexOf(")"));
    for (const tok of inner.split(",").map((s) => s.trim().split("=")[0].trim()).filter((s) => s && s !== "*")) {
      assert.ok(params.includes(tok), `${fn}: prompt 簽章多出 ${tok}`);
    }
  }
});

test("prompt 宣稱「row 鍵名與參數同名」:spec 檔的幾何鍵都要是同名函式的參數", () => {
  // 規格 row 的非幾何中繼鍵(型號/來源/額定/範圍),不餵進產生器
  const META = new Set([
    "series", "model", "source", "confidence", "C_dynamic_N", "grade", "root_dia", "nema",
    "holding_torque_Nm", "stroke_min", "stroke_max", "port", "mount", "type", "gripping_force_N",
    "force_pressure_MPa", "weight_g",
  ]);
  for (const [file, fn, spec] of FAMILIES) {
    const rows = JSON.parse(fs.readFileSync(path.join(PARTS, "specs", spec), "utf8"));
    const row = Array.isArray(rows) ? rows[0] : rows;
    const params = new Set(pyParams(file, fn));
    for (const k of Object.keys(row)) {
      if (META.has(k)) continue;
      assert.ok(params.has(k), `${spec}: 幾何鍵 ${k} 不是 ${fn}() 的參數(prompt 的「同名」宣稱失效)`);
    }
  }
});

test("流程不再要求 emit_stage(階段由 runner 依工具呼叫推進);收尾回覆限長規則存在", () => {
  assert.ok(!/emit_stage\(\d\)/.test(prompt), "流程段仍有 emit_stage(n)");
  assert.ok(prompt.includes("不必呼叫 emit_stage"));
  assert.ok(prompt.includes("收尾回覆(cad_present 之後)限 8 行內"));
  assert.ok(prompt.includes("不要再 Read/Grep cadpy 原始碼或範例檔"));
  // 內嵌段標題存在且只出現一次
  assert.equal(prompt.split("# 標準件幾何(cadpy.parts").length - 1, 1);
});
