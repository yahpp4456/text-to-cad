// bake-auth(方案 B 注入)純函數單元測:buildBakedEnv 的驗證與白名單。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildBakedEnv, parseEnvFile } from "../../scripts/bake-auth.mjs";

test("buildBakedEnv:合法 key + CADCHAT_* 通過;key 恆排第一行", () => {
  const lines = buildBakedEnv(
    { CADCHAT_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "sk-ant-abc123", CADCHAT_EFFORT: "high" },
    {},
  );
  assert.equal(lines[0], "ANTHROPIC_API_KEY=sk-ant-abc123");
  assert.deepEqual(lines.slice(1).sort(), ["CADCHAT_EFFORT=high", "CADCHAT_MODEL=claude-sonnet-5"]);
});

test("buildBakedEnv:認證全缺 / 形狀不對 → throw(fail loud)", () => {
  assert.throws(() => buildBakedEnv({}, {}), /缺認證/);
  assert.throws(
    () => buildBakedEnv({ ANTHROPIC_API_KEY: "sk-ant-oat01-xxx".replace("sk-ant-", "oauth-") }, {}),
    /形狀不對/,
  );
});

test("buildBakedEnv:鍵白名單——非認證/CADCHAT_* 一律拒(防手滑帶祕密)", () => {
  assert.throws(
    () => buildBakedEnv({ ANTHROPIC_API_KEY: "sk-ant-x", AWS_SECRET: "s" }, {}),
    /非法鍵 AWS_SECRET/,
  );
});

test("buildBakedEnv:env CADCHAT_BAKE_API_KEY 覆寫檔內 key", () => {
  const lines = buildBakedEnv(
    { ANTHROPIC_API_KEY: "sk-ant-file" },
    { CADCHAT_BAKE_API_KEY: "sk-ant-env" },
  );
  assert.equal(lines[0], "ANTHROPIC_API_KEY=sk-ant-env");
});

// ── OAuth(個人自用)路徑 ──
test("buildBakedEnv:OAuth token 沒開 --allow-oauth → 護欄擋下(不烙進產物)", () => {
  assert.throws(
    () => buildBakedEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" }, {}),
    /訂閱 OAuth 憑證只能本人自用/,
  );
  // 連同 CADCHAT_* 一起給,護欄仍先擋(OAuth 檢查在白名單迴圈之前)
  assert.throws(
    () => buildBakedEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc", CADCHAT_MODEL: "m" }, {}),
    /訂閱 OAuth 憑證只能本人自用/,
  );
});

test("buildBakedEnv:allowOauth + 合法 token → 認證行恆排第一,CADCHAT_* 跟隨", () => {
  const lines = buildBakedEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc", CADCHAT_MODEL: "claude-opus-4-8" },
    {},
    { allowOauth: true },
  );
  assert.equal(lines[0], "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc");
  assert.deepEqual(lines.slice(1), ["CADCHAT_MODEL=claude-opus-4-8"]);
});

test("buildBakedEnv:allowOauth + 兩種並存 → 用 OAuth、丟棄 API key(切個人 build 免清檔)", () => {
  const lines = buildBakedEnv(
    { ANTHROPIC_API_KEY: "sk-ant-api03-x", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-y" },
    {},
    { allowOauth: true },
  );
  assert.equal(lines[0], "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-y");
  // API key 不得出現在任何一行
  assert.ok(!lines.some((l) => l.startsWith("ANTHROPIC_API_KEY=")));
});

test("buildBakedEnv:放錯欄位 → 形狀檢查抓出(雙向)", () => {
  // API key 放進 OAuth 欄位
  assert.throws(
    () => buildBakedEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-x" }, {}, { allowOauth: true }),
    /放的是 API key/,
  );
  // OAuth token 放進 API key 欄位
  assert.throws(
    () => buildBakedEnv({ ANTHROPIC_API_KEY: "sk-ant-oat01-x" }, {}),
    /放的是 OAuth token/,
  );
});

test("buildBakedEnv:env CADCHAT_BAKE_OAUTH_TOKEN 覆寫(需 allowOauth)", () => {
  const lines = buildBakedEnv(
    {},
    { CADCHAT_BAKE_OAUTH_TOKEN: "sk-ant-oat01-env" },
    { allowOauth: true },
  );
  assert.equal(lines[0], "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-env");
});

test("parseEnvFile:KEY=value / 註解 / 引號去殼 / 缺檔回空物件", () => {
  const f = path.join(os.tmpdir(), `cadchat-bake-${process.pid}.txt`);
  fs.writeFileSync(f, '# c\nANTHROPIC_API_KEY="sk-ant-q"\nCADCHAT_MODEL=m\n', "utf8");
  try {
    assert.deepEqual(parseEnvFile(f), { ANTHROPIC_API_KEY: "sk-ant-q", CADCHAT_MODEL: "m" });
    assert.deepEqual(parseEnvFile(`${f}.nope`), {});
  } finally {
    fs.rmSync(f, { force: true });
  }
});
