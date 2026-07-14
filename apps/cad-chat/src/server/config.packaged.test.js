// 打包佈局(env 覆寫)單元測:CADCHAT_* 路徑 env 必須在 import config 前設好
// (常數是 module-level 推導),故本檔不 static import config,全部走動態 import。
// node --test 每檔獨立進程,這裡動 process.env 不會污染其他測試檔。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-pkg-"));
const RT = path.join(tmp, "runtime");
const DT = path.join(tmp, "data");
fs.mkdirSync(RT, { recursive: true });
fs.mkdirSync(DT, { recursive: true });

process.env.CADCHAT_RUNTIME_ROOT = RT;
process.env.CADCHAT_DATA_ROOT = DT;
process.env.CADCHAT_PYTHON_EXE = path.join(RT, "python", "python.exe");

const config = await import("./config.mjs");
const { scrubPaths, spawnPython } = await import("./cad/python.mjs");

test("packaged:根常數全隨 env;PACKAGED=true;models 雙層分離", () => {
  assert.equal(config.RUNTIME_ROOT, RT);
  assert.equal(config.REPO_ROOT, RT); // 相容匯出
  assert.equal(config.DATA_ROOT, DT);
  assert.equal(config.PACKAGED, true);
  assert.equal(config.PYTHON_EXE, path.join(RT, "python", "python.exe"));
  assert.equal(config.MODELS_ROOT, path.join(DT, "models")); // 可寫層
  assert.equal(config.MODELS_FIXTURES_ROOT, path.join(RT, "models")); // 唯讀 fixtures 層
  assert.equal(config.SESSIONS_ROOT, path.join(DT, "models", ".cadchat"));
});

test("packaged:agentEnv 注入 CLAUDE_CONFIG_DIR=DATA_ROOT/.claude(尊重顯式設定)", () => {
  const a = config.agentEnv({ ANTHROPIC_API_KEY: "k" });
  assert.equal(a.CLAUDE_CONFIG_DIR, path.join(DT, ".claude"));
  const b = config.agentEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "X" });
  assert.equal(b.CLAUDE_CONFIG_DIR, "X");
});

test("packaged:scrubPaths 雙根都遮(RUNTIME_ROOT 與 DATA_ROOT 分離時)", () => {
  const out = scrubPaths(
    `File "${RT}\\skills\\cad\\x.py", line 3; wrote ${DT}\\models\\.cadchat\\s1\\a.step`,
  );
  assert.ok(!out.includes(RT));
  assert.ok(!out.includes(DT));
  assert.ok(out.includes("skills\\cad\\x.py")); // 檔案/行號仍看得出
});

test("packaged:spawnPython 腳本絕對化到 RUNTIME_ROOT、cwd=DATA_ROOT(spawn 失敗誠實回 -1)", async () => {
  // PYTHON_EXE 指向不存在的檔 → spawn error 路徑;驗的是「不炸、誠實 code=-1」
  // (真跑通由 Phase 0 出口閘負責;這裡只鎖 plumbing 不拋例外)
  const r = await spawnPython("skills/cad/scripts/step", ["x.py"]);
  assert.equal(r.code, -1);
  assert.ok(!r.stderr.includes(RT)); // 錯誤訊息也過 scrub
});
