// Read/Glob/Grep 讀取範圍硬閘(node --test):跨對話/跨使用者/系統檔 deny,
// 本對話工作目錄/本使用者 models/共用 fixtures/skills allow。純函數,注入假根目錄。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { READ_HOOK_MATCHER, makeReadScopeHook, makeToolGuard } from "./agent/guards.mjs";
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

// 2026-10-09:主代理的 Read/Glob/Grep 在 SDK default 模式免 permission、不經 canUseTool,硬閘改掛
// PreToolUse hook(同一 guard)。hook 契約:越界 → hookSpecificOutput deny + 原因;合法 → {}(不表態);
// 非讀取工具 → {};模式工具面不含 Read(草模)→ 一樣 deny;guard 丟錯 → deny(fail-closed)。
test("makeReadScopeHook:越界 deny、合法/非讀取工具不表態、工具面不含 Read 也 deny、guard 丟錯 fail-closed", async () => {
  assert.equal(READ_HOOK_MATCHER, "Read|Glob|Grep");
  const hook = makeReadScopeHook(makeToolGuard(["Read", "Glob", "Grep", "mcp__cadchat__cad_build"], { scope: scopeA }));
  const ev = (tool_name, tool_input) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1" });
  const denied = await hook(ev("Read", { file_path: path.join(DATA, "users/bob/models/x.py") }));
  assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(denied.hookSpecificOutput.permissionDecisionReason.includes("越界讀取被拒絕"));
  assert.deepEqual(await hook(ev("Read", { file_path: "skills/cad/SKILL.md" })), {});
  assert.equal((await hook(ev("Glob", { pattern: "**/*.py" }))).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await hook(ev("Glob", { pattern: "models/parts-library/*/meta.json" })), {});
  assert.equal((await hook(ev("Grep", { pattern: "PARAMS" }))).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await hook(ev("mcp__cadchat__cad_build", { code: "x" })), {}); // 非讀取工具不經 hook 判斷
  assert.deepEqual(await hook(ev("Bash", { command: "ls" })), {});
  // 草模工具面不含 Read:即使路徑合法也 deny(訊息是模式專屬的)
  const sketchHook = makeReadScopeHook(makeToolGuard(["mcp__cadchat__sketch_present"], { mode: "sketch", scope: scopeA }));
  const sd = await sketchHook(ev("Read", { file_path: "skills/cad/SKILL.md" }));
  assert.equal(sd.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(sd.hookSpecificOutput.permissionDecisionReason.includes("草模模式"));
  // guard 丟錯 → deny
  const boom = makeReadScopeHook(async () => { throw new Error("boom"); });
  assert.equal((await boom(ev("Read", { file_path: "skills/cad/SKILL.md" }))).hookSpecificOutput.permissionDecision, "deny");
  // 無 session/scope 的 guard(零回歸路徑):Read 合法即不表態
  assert.deepEqual(await makeReadScopeHook(makeToolGuard(["Read"]))(ev("Read", { file_path: path.join(DATA, "users/bob/models/x.py") })), {});
});
