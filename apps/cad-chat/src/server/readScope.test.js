// Read/Glob/Grep 讀取範圍硬閘(node --test):跨對話/跨使用者/系統檔 deny,
// 本對話工作目錄/本使用者 models/共用 fixtures/skills allow。純函數,注入假根目錄。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { makeToolGuard } from "./agent/guards.mjs";
import { globStaticPrefix, isReadAllowed, readScopeFor, readTargetOf } from "./agent/readScope.mjs";

const RT = path.resolve("/srv/cadchat"); // runtime root(cwd)
const DATA = path.resolve("/srv/data");
const sess = (user, id) => {
  const modelsRoot = user ? path.join(DATA, "users", user, "models") : path.join(RT, "models");
  return { user, modelsRoot, workdirAbs: path.join(modelsRoot, ".cadchat", id), workdirRel: `models/.cadchat/${id}` };
};
const opts = { runtimeRoot: RT, fixturesRoot: path.join(RT, "models") };
const scopeA = readScopeFor(sess("alice", "s_a1"), opts);
const scopeLegacy = readScopeFor(sess(null, "s_l1"), opts);

test("globStaticPrefix:取第一個萬用字元前的目錄;無萬用=整段;純萬用=空", () => {
  assert.equal(globStaticPrefix("models/parts-library/*/meta.json"), "models/parts-library");
  assert.equal(globStaticPrefix("**/meta.json"), "");
  assert.equal(globStaticPrefix("skills/cad/SKILL.md"), "skills/cad/SKILL.md");
  assert.equal(globStaticPrefix("models\\sheet_u_bracket\\*.py"), "models/sheet_u_bracket");
});

test("readTargetOf:Read 取 file_path;Glob/Grep path 優先、Glob 退 pattern 前綴、Grep 無 path=空", () => {
  assert.equal(readTargetOf("Read", { file_path: "a/b.py" }), "a/b.py");
  assert.equal(readTargetOf("Glob", { pattern: "models/x/*.py" }), "models/x");
  assert.equal(readTargetOf("Glob", { pattern: "*.py", path: "skills/cad" }), "skills/cad");
  assert.equal(readTargetOf("Grep", { pattern: "foo" }), "");
  assert.equal(readTargetOf("Grep", { pattern: "foo", path: "models/a" }), "models/a");
  assert.equal(readTargetOf("Bash", { command: "ls" }), null);
});

test("per-user:本對話 workdir / 本使用者 models / fixtures 範本 / skills 放行", () => {
  assert.ok(isReadAllowed(path.join(DATA, "users/alice/models/.cadchat/s_a1/part.py"), scopeA));
  assert.ok(isReadAllowed(path.join(DATA, "users/alice/models/parts-library/x/meta.json"), scopeA));
  assert.ok(isReadAllowed(path.join(DATA, "users/alice/models/my_proj/my_proj.py"), scopeA));
  assert.ok(isReadAllowed("models/sheet_u_bracket/sheet_u_bracket.py", scopeA)); // 相對 cwd=RUNTIME_ROOT
  assert.ok(isReadAllowed("skills/cad/SKILL.md", scopeA));
  assert.ok(isReadAllowed("models/parts-library", scopeA));
});

test("per-user:其他使用者 / 其他對話 / .cadchat 容器 / 系統檔 / 全域 Glob 一律拒絕", () => {
  assert.ok(!isReadAllowed(path.join(DATA, "users/bob/models/secret/secret.py"), scopeA));
  assert.ok(!isReadAllowed(path.join(DATA, "users/bob/models/.cadchat/s_b1/part.py"), scopeA));
  assert.ok(!isReadAllowed(path.join(DATA, "users/alice/models/.cadchat/s_a2/part.py"), scopeA)); // 同人他對話也不給
  assert.ok(!isReadAllowed(path.join(DATA, "users/alice/models/.cadchat"), scopeA)); // 容器列舉
  assert.ok(!isReadAllowed("models/.cadchat", scopeA)); // legacy 容器
  assert.ok(!isReadAllowed("models/.cadchat/s_other/part.py", scopeA));
  assert.ok(!isReadAllowed(path.join(DATA, "users"), scopeA));
  assert.ok(!isReadAllowed(".env", scopeA));
  assert.ok(!isReadAllowed("apps/cad-chat/src/server/agent/prompt.mjs", scopeA));
  assert.ok(!isReadAllowed("apps/cad-chat/data/lessons.sam.json", scopeA));
  assert.ok(!isReadAllowed("", scopeA)); // 無目錄 Glob/Grep
  assert.ok(!isReadAllowed("models/../apps/cad-chat/.env", scopeA)); // 越界 ..
  assert.ok(!isReadAllowed(null, scopeA));
});

test("legacy(user=null,dev):同樣只放本對話 + models + skills,其他對話拒絕", () => {
  assert.ok(isReadAllowed("models/.cadchat/s_l1/part.py", scopeLegacy));
  assert.ok(!isReadAllowed("models/.cadchat/s_l2/part.py", scopeLegacy));
  assert.ok(isReadAllowed("models/sheet_control_box/sheet_control_box.py", scopeLegacy));
  assert.ok(!isReadAllowed("apps/cad-chat/README.md", scopeLegacy));
});

test("makeToolGuard 接線:帶 scope 時 Read 越界 deny、合法 allow;MCP 工具不受影響;無 scope 零回歸", async () => {
  const g = makeToolGuard(["Read", "Glob", "Grep", "mcp__cadchat__cad_build"], { scope: scopeA });
  assert.equal((await g("Read", { file_path: path.join(DATA, "users/bob/models/x.py") })).behavior, "deny");
  assert.equal((await g("Read", { file_path: "skills/cad/SKILL.md" })).behavior, "allow");
  assert.equal((await g("Glob", { pattern: "**/*.py" })).behavior, "deny");
  assert.equal((await g("Glob", { pattern: "models/parts-library/*/meta.json" })).behavior, "allow");
  assert.equal((await g("Grep", { pattern: "PARAMS" })).behavior, "deny");
  assert.equal((await g("Grep", { pattern: "PARAMS", path: "models/sheet_u_bracket" })).behavior, "allow");
  assert.equal((await g("mcp__cadchat__cad_build", { code: "x" })).behavior, "allow");
  assert.equal((await g("Bash", { command: "ls" })).behavior, "deny");
  const g0 = makeToolGuard(["Read"]);
  assert.equal((await g0("Read", { file_path: path.join(DATA, "users/bob/models/x.py") })).behavior, "allow");
});
