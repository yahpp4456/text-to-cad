#!/usr/bin/env node
// 方案 B 注入(build 前置):讀 build 機的 .env.bake(Sam 的單一貼入點),驗證後寫
// .env.baked(隨打包產物散布;執行期由 config.loadBakedEnv fallback-only 載入)。
// 兩檔皆 gitignored;本 script 進 git,不含任何祕密。
//
//   輸入 apps/cad-chat/.env.bake(KEY=value):
//     ANTHROPIC_API_KEY=sk-ant-api…        # 散布用(env CADCHAT_BAKE_API_KEY 可覆寫)
//     CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…  # 個人自用(需 --allow-oauth;env CADCHAT_BAKE_OAUTH_TOKEN 可覆寫;
//                                          #   個人 build 未給時自動沿用 .env.local 的 token)
//     CADCHAT_MODEL=claude-sonnet-5        # 選填(任何 CADCHAT_* 預設皆可)
//     CADCHAT_EFFORT=high                  # 選填
//   輸出 apps/cad-chat/.env.baked(mode 0600)。認證二選一,至少一個。
//
// 驗證(fail loud,寧可擋下也不烙進壞產物):
//   - 兩種認證都缺 → 失敗;形狀不符(放錯欄位/雜訊)→ 失敗
//   - OAuth token 預設擋下(訂閱憑證只能本人自用,ToS 禁散布給第三方);要自用加 --allow-oauth
//   - 鍵白名單:只准 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 與 CADCHAT_*(防手滑帶進別的祕密)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IN_FILE = path.join(APP_ROOT, ".env.bake");
const OUT_FILE = path.join(APP_ROOT, ".env.baked");

// 與 config.loadEnvFile 同格式(KEY=value、# 註解、引號去殼),收進物件回傳。
export function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

// 純函數(L1 可測):{鍵:值} + env 覆寫 + opts → 驗證後的輸出行陣列。非法 → throw。
// opts.allowOauth:開啟才准把訂閱 OAuth token 烙進產物(個人自用;預設關 = 護欄)。
export function buildBakedEnv(fileVars, env = process.env, opts = {}) {
  const allowOauth = !!opts.allowOauth;
  const vars = { ...fileVars };
  const overrideKey = String(env.CADCHAT_BAKE_API_KEY || "").trim();
  if (overrideKey) vars.ANTHROPIC_API_KEY = overrideKey;
  const overrideOauth = String(env.CADCHAT_BAKE_OAUTH_TOKEN || "").trim();
  if (overrideOauth) vars.CLAUDE_CODE_OAUTH_TOKEN = overrideOauth;

  const key = String(vars.ANTHROPIC_API_KEY || "").trim();
  const oauth = String(vars.CLAUDE_CODE_OAUTH_TOKEN || "").trim();

  // 護欄:OAuth token 存在但沒開 opt-in → 擋下。訂閱憑證只能本人自用,ToS 禁止
  // 散布給第三方;預設不烙進產物,避免打包同事版時手滑把訂閱 token 一起送出去。
  if (oauth && !allowOauth) {
    throw new Error(
      "偵測到 CLAUDE_CODE_OAUTH_TOKEN。訂閱 OAuth 憑證只能本人自用(Anthropic 條款禁止散布給第三方)," +
        "預設不烙進產物。若這是你要自用的 build,改跑 `npm run dist:personal`(帶 --allow-oauth)。",
    );
  }

  // 個人 build(allowOauth)明確意圖 = 走訂閱:OAuth 優先,忽略殘留的 API key
  // (常見於「上一版是散布用 API key build,這版切個人自用」——不必去清 .env.bake)。
  // 非個人 build:oauth 已在上方護欄擋掉,這裡只會是 API key 路徑。
  const useOauth = oauth && allowOauth;
  if (!key && !useOauth) {
    throw new Error(
      "缺認證:在 apps/cad-chat/.env.bake 填 ANTHROPIC_API_KEY(散布用),或 " +
        "CLAUDE_CODE_OAUTH_TOKEN 並跑 `npm run dist:personal`(個人自用)。",
    );
  }

  const lines = [];
  if (useOauth) {
    if (!oauth.startsWith("sk-ant-")) {
      throw new Error(
        "CLAUDE_CODE_OAUTH_TOKEN 形狀不對(應以 sk-ant- 開頭;claude setup-token 產出的是 sk-ant-oat…)",
      );
    }
    if (oauth.startsWith("sk-ant-api")) {
      throw new Error(
        "CLAUDE_CODE_OAUTH_TOKEN 欄位放的是 API key(sk-ant-api…)。API key 請填 ANTHROPIC_API_KEY(不需 --allow-oauth)。",
      );
    }
    lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${oauth}`);
  } else {
    if (!key.startsWith("sk-ant-")) {
      throw new Error("ANTHROPIC_API_KEY 形狀不對(應以 sk-ant- 開頭)");
    }
    if (key.startsWith("sk-ant-oat")) {
      throw new Error(
        "ANTHROPIC_API_KEY 欄位放的是 OAuth token(sk-ant-oat…)。改填到 CLAUDE_CODE_OAUTH_TOKEN 並跑 `npm run dist:personal`。",
      );
    }
    lines.push(`ANTHROPIC_API_KEY=${key}`);
  }

  for (const [k, v] of Object.entries(vars)) {
    if (k === "ANTHROPIC_API_KEY" || k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    if (!/^CADCHAT_[A-Z0-9_]+$/.test(k)) {
      throw new Error(
        `非法鍵 ${k}:只准 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 與 CADCHAT_*(防手滑帶進別的祕密)`,
      );
    }
    lines.push(`${k}=${String(v)}`);
  }
  return lines;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const allowOauth = process.argv.includes("--allow-oauth");
  const fileVars = parseEnvFile(IN_FILE);
  // 個人 OAuth build 便利:.env.bake 沒給 token 時,沿用 .env.local 現成的訂閱 token
  // (你不用再貼一次)。只取 token 這個鍵,其餘設定(模型/effort)仍以 .env.bake 為準。
  if (allowOauth && !fileVars.CLAUDE_CODE_OAUTH_TOKEN) {
    const local = parseEnvFile(path.join(APP_ROOT, ".env.local"));
    if (local.CLAUDE_CODE_OAUTH_TOKEN) {
      fileVars.CLAUDE_CODE_OAUTH_TOKEN = local.CLAUDE_CODE_OAUTH_TOKEN;
      console.log("(沿用 .env.local 的 CLAUDE_CODE_OAUTH_TOKEN)");
    }
  }
  // 個人 build 走 OAuth 時,.env.bake 若還留著散布用的 API key,明說忽略(非破壞:不改檔)。
  if (allowOauth && fileVars.CLAUDE_CODE_OAUTH_TOKEN && fileVars.ANTHROPIC_API_KEY) {
    console.log("(.env.bake 有 ANTHROPIC_API_KEY;個人 OAuth build 忽略它,改烙訂閱 token)");
  }
  let lines;
  try {
    lines = buildBakedEnv(fileVars, process.env, { allowOauth });
  } catch (err) {
    console.error(`bake-auth 失敗:${err?.message || err}`);
    process.exit(1);
  }
  fs.writeFileSync(OUT_FILE, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`已寫 ${OUT_FILE}`);
  // 第一行是認證(ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN)——遮罩後印。
  const eq = lines[0].indexOf("=");
  const credKey = lines[0].slice(0, eq);
  const credVal = lines[0].slice(eq + 1);
  console.log(`  ${credKey}=${credVal.slice(0, 10)}…${credVal.slice(-4)}(遮罩)`);
  for (const l of lines.slice(1)) console.log(`  ${l}`);
}
