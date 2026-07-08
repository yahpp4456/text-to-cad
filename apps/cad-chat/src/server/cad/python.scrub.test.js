// scrubPaths 單元測(node --test):把子程序輸出裡的本機絕對路徑收斂,
// 避免在 UI 錯誤卡 / LOG / 回給 agent 的文字裡洩漏使用者的機器路徑。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "../config.mjs";
import { scrubPaths } from "./python.mjs";

const HOME = os.homedir();
const winRepo = REPO_ROOT.replace(/\//g, "\\"); // 反斜線形式(Windows traceback 慣用)

test("Python traceback(單反斜線)移除 repo 根,留相對路徑與行號", () => {
  const line = `  File "${winRepo}\\skills\\cad\\scripts\\packages\\cadpy\\src\\cadpy\\geometry_checks.py", line 434, in assert_no_interference`;
  const out = scrubPaths(line);
  assert.ok(!out.includes(winRepo), "不應再含 repo 絕對路徑");
  assert.ok(!out.includes(HOME), "不應再含使用者家目錄");
  assert.match(out, /skills\\cad\\scripts\\packages\\cadpy\\src\\cadpy\\geometry_checks\.py/);
  assert.match(out, /line 434/); // 仍看得出檔案與行號
});

test("正斜線形式(POSIX 風)也收斂", () => {
  const line = `File "${REPO_ROOT}/skills/cad/x.py", line 12`;
  const out = scrubPaths(line);
  assert.ok(!out.includes(REPO_ROOT));
  assert.match(out, /skills\/cad\/x\.py/);
});

test("JSON 字串內逸出的雙反斜線路徑收斂後仍是合法 JSON", () => {
  const jsonBackslashes = winRepo.replace(/\\/g, "\\\\"); // JSON 逸出形式
  const raw = JSON.stringify({ ok: false, error: "boom" }).replace(
    '"boom"',
    JSON.stringify(`${jsonBackslashes}\\\\models\\\\.cadchat\\\\s1\\\\part.py fail`),
  );
  const out = scrubPaths(raw);
  assert.ok(!out.includes("Sam") || !out.includes("Users\\\\Sam"), "不應含逸出的家目錄路徑");
  const parsed = JSON.parse(out); // 收斂後仍可 parse
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.error.includes(REPO_ROOT.split(path.sep).slice(0, 3).join(path.sep)));
});

test("repo 外但家目錄內的路徑收成 ~/", () => {
  const p = path.join(HOME, ".claude", "projects", "x.jsonl");
  const out = scrubPaths(p);
  assert.ok(!out.includes(HOME));
  assert.match(out, /~[\\/]\.claude/);
});

test("共用前綴的兄弟 checkout 不誤傷(text-to-cad-main ≠ repo 根)", () => {
  const line = `  File "${winRepo}-main\\skills\\cad\\gen.py", line 3`;
  const out = scrubPaths(line);
  // 舊 bug:repo 根 regex 缺結尾錨定,把前綴咬掉輸出 "-main\skills\..."(指錯位置)。
  // 正確行為:repo 根不匹配;整段路徑要嘛原樣、要嘛被 HOME 規則收成 ~/ 開頭,
  // 但「text-to-cad-main」這一段必須完整保留。
  assert.ok(out.includes("text-to-cad-main\\skills\\cad\\gen.py"));
});

test("共用前綴的兄弟使用者目錄不誤傷(如 Samantha ≠ Sam)", () => {
  const sibling = `${HOME}antha\\project\\x.py`;
  assert.equal(scrubPaths(sibling), sibling);
});

test("根路徑後面直接接行尾/引號(無尾隨分隔符)也收斂", () => {
  const out = scrubPaths(`cwd is ${winRepo}`);
  assert.ok(!out.includes(winRepo));
  const quoted = scrubPaths(`chdir("${REPO_ROOT}") failed`);
  assert.ok(!quoted.includes(REPO_ROOT));
});

test("null / undefined / 空字串安全通過", () => {
  assert.equal(scrubPaths(null), null);
  assert.equal(scrubPaths(undefined), undefined);
  assert.equal(scrubPaths(""), "");
});

test("不含本機路徑的文字原樣返回", () => {
  const s = "AssertionError: interference: 2 undeclared pair(s)";
  assert.equal(scrubPaths(s), s);
});
