// 檔案瀏覽 / 開檔看圖(免 LLM):
//   GET  /api/files?dir=<models 相對路徑>  — 列目錄(dir + .step/.stp/.glb)
//   POST /api/open  {file, kind?}          — 開既有檔;裸 STEP 按需產 topology GLB
// 回 JSON 不走 SSE(SSE 通道與 agent turn 生命周期綁死;開檔是瀏覽動作)。
// 前端拿回應自己 dispatch ADD_VERSION+PRESENT(與 ?glb= 捷徑同路徑)。
import fs from "node:fs";
import path from "node:path";

import { BASE_PATH, DATA_ROOT, MODELS_FIXTURES_ROOT, MODELS_ROOT } from "../config.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { pathIsInside, resolveInside, resolveModelRead } from "../cad/paths.mjs";
import { scrubPaths, spawnPython } from "../cad/python.mjs";

const STEP_DIR = "skills/cad/scripts/step";
const OPEN_TIMEOUT_MS = 120_000; // 裸 STEP 轉 GLB 上限(大檔 tessellation 可能要一陣子)

// 使用者傳入的 models 相對路徑正規化(容忍 models/ 前綴與反斜線)。
function normalizeRel(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^models\//, "").replace(/^\/+/, "");
}

// 目錄下有沒有 gen_step 產生器(輕量字串判斷,開專案入口用;不 AST)。
function dirHasGenerator(absDir) {
  try {
    const pys = fs
      .readdirSync(absDir)
      .filter((f) => f.endsWith(".py"))
      .slice(0, 12);
    return pys.some((f) => {
      try {
        return fs.readFileSync(path.join(absDir, f), "utf8").includes("def gen_step");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// 讀同目錄 <stem>.asm.json 的類型(組合件 manifest;無或壞 → null,不猜)。
function typeFromManifest(absDir, stem) {
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(absDir, `${stem}.asm.json`), "utf8"));
    return mf?.type === "assembly" ? "assembly" : null;
  } catch {
    return null;
  }
}

function listDir(relDir, ctx = {}) {
  // 雙層 merge:可寫層(per-user 根;無 user = legacy DATA_ROOT/models)優先、
  // 唯讀 fixtures 層補集(同名以可寫層為準);dev 兩層同根 → 單層,行為與舊版
  // 完全一致。兩層都開不了才拋(403/404 分流由呼叫端依 escape 訊息判斷,語意不變)。
  const modelsRoot = ctx.modelsRoot || MODELS_ROOT;
  const roots = [modelsRoot];
  if (MODELS_FIXTURES_ROOT !== modelsRoot) roots.push(MODELS_FIXTURES_ROOT);
  const out = [];
  const seen = new Set();
  let opened = 0;
  let lastErr = null;
  for (const root of roots) {
    let abs;
    let ents;
    try {
      abs = resolveInside(root, relDir || ".");
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      lastErr = err;
      continue;
    }
    opened += 1;
    for (const ent of ents) {
      const name = ent.name;
      if (seen.has(name)) continue;
      // 藏 dotfile(含隱藏 topology GLB)與快取;.cadchat 例外——先前 session 產物是匯入來源
      if (name.startsWith(".") && name !== ".cadchat") continue;
      if (name === "__pycache__") continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (ent.isDirectory()) {
        seen.add(name);
        out.push({ name, kind: "dir", rel, project: dirHasGenerator(path.join(abs, name)) });
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (ext !== ".step" && ext !== ".stp" && ext !== ".glb") continue;
      let st;
      try {
        st = fs.statSync(path.join(abs, name));
      } catch {
        continue;
      }
      const entry = {
        name,
        kind: ext === ".glb" ? "glb" : "step",
        rel,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      };
      if (entry.kind === "step") {
        const stem = name.replace(/\.(step|stp)$/i, "");
        // 隱藏 topology GLB 約定:.<檔名>.glb(與 pipeline/scripts/step 一致)
        entry.hasGlb = fs.existsSync(path.join(abs, `.${name}.glb`));
        const t = typeFromManifest(abs, stem);
        if (t) entry.type = t;
      }
      seen.add(name);
      out.push(entry);
    }
  }
  if (!opened) throw lastErr || new Error("目錄不存在");
  // 目錄在前,同類按名稱
  out.sort((a, b) =>
    (a.kind === "dir") === (b.kind === "dir")
      ? a.name.localeCompare(b.name)
      : a.kind === "dir"
        ? -1
        : 1,
  );
  return out;
}

async function handleOpen(body, res, ctx = {}) {
  const modelsRoot = ctx.modelsRoot || MODELS_ROOT;
  const fileParam = normalizeRel(body?.file);
  if (!fileParam) {
    sendJson(res, 400, { ok: false, error: "missing file" });
    return;
  }
  let abs;
  try {
    abs = resolveModelRead(fileParam, { modelsRoot }); // 讀取:雙根(user 層優先、fixtures fallback)
  } catch {
    sendJson(res, 403, { ok: false, error: "路徑超出 models/" });
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    sendJson(res, 404, { ok: false, error: "檔案不存在" });
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  // rel 基準取檔案實際所在層的 models 根(dev 同根 = modelsRoot,行為不變)
  const rootOf = pathIsInside(abs, modelsRoot) ? modelsRoot : MODELS_FIXTURES_ROOT;
  const relDir = path.relative(rootOf, dir).split(path.sep).join("/");
  // projectDir:此檔所屬目錄是否為可編輯專案(有 gen_step)。非 null = 前端可把這個
  // 唯讀檢視「帶入可編輯工作區」(open-project 目標);裸檔(匯入/獨立)→ null。
  const projectDir = dirHasGenerator(dir) ? (relDir && relDir !== "." ? relDir : "") : null;
  // glbUrl 帶檔案 mtime buster(同 emitPresent 的 &v= 慣例):同一檔重複開啟時,
  // 檔案沒變=同 URL(前端不重載),外部重生過=新 URL(逼前端真重載)。
  const assetUrl = (rel, srcAbs) => {
    let v = "";
    try {
      v = `&v=${Math.round(fs.statSync(srcAbs).mtimeMs)}`;
    } catch {
      /* stat 失敗保守降級成無 buster,開檔仍可用 */
    }
    return `${BASE_PATH}/api/asset?file=${encodeURIComponent(rel)}${v}`;
  };

  if (ext === ".glb") {
    const stem = base.replace(/\.glb$/i, "");
    sendJson(res, 200, {
      ok: true,
      name: stem,
      type: typeFromManifest(dir, stem) || "",
      file: fileParam,
      projectDir,
      glbUrl: assetUrl(fileParam, abs),
    });
    return;
  }
  if (ext !== ".step" && ext !== ".stp") {
    sendJson(res, 400, { ok: false, error: "只支援 .step/.stp/.glb" });
    return;
  }

  const stem = base.replace(/\.(step|stp)$/i, "");
  const glbName = `.${base}.glb`;
  const glbAbs = path.join(dir, glbName);
  const glbRel = relDir && relDir !== "." ? `${relDir}/${glbName}` : glbName;
  const mfType = typeFromManifest(dir, stem);

  // 重轉條件:GLB 缺席,或 STEP 比 GLB 新「超過偏斜窗」(外部改寫 STEP 而舊 GLB
  // 還在——只看缺席會拿舊 GLB 的 mtime buster,靜默呈現舊幾何)。偏斜窗必要:
  // git/LFS checkout 同批寫檔時 dotfile GLB 排序在前先落地,STEP 毫秒級較新,
  // 嚴格比較會把每個剛 hydrate 的 fixture 誤判 stale(重跑 tessellation,無
  // manifest 的還退到 kind_required)。真正的外部改寫與再開啟至少分鐘級。
  const REGEN_SKEW_MS = 10_000;
  let needRegen = !fs.existsSync(glbAbs);
  if (!needRegen) {
    try {
      needRegen = fs.statSync(glbAbs).mtimeMs + REGEN_SKEW_MS < fs.statSync(abs).mtimeMs;
    } catch {
      needRegen = true;
    }
  }
  if (needRegen) {
    // 裸 STEP:scripts/step 對直接 STEP 目標必須帶 --kind(part|assembly);
    // 有組合件 manifest 就不再問(manifest 權威),否則要求前端二選一。
    const kind = body?.kind === "assembly" || body?.kind === "part" ? body.kind : mfType;
    if (!kind) {
      sendJson(res, 200, { ok: false, error: "kind_required" });
      return;
    }
    // 目標在可寫資料根內 → cwd(DATA_ROOT)相對;唯讀 fixtures 層(packaged 跨根)
    // → 絕對路徑輸入(cadpy CLI 只拒絕對「輸出」option,輸入目標可絕對)。dev 同根
    // 恆走相對(= 舊 repoRel 行為)。
    const target = pathIsInside(abs, DATA_ROOT)
      ? path.relative(DATA_ROOT, abs).split(path.sep).join("/")
      : abs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPEN_TIMEOUT_MS);
    const { code, stderr } = await spawnPython(STEP_DIR, [target, "--kind", kind, "--force"], {
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (code !== 0 || !fs.existsSync(glbAbs)) {
      sendJson(res, 200, {
        ok: false,
        error: `轉檔失敗:${(stderr || "").trim().slice(-300) || `exit ${code}`}`,
      });
      return;
    }
  }

  sendJson(res, 200, {
    ok: true,
    name: stem,
    // 類型:manifest 優先;無 manifest 時採使用者指定的 kind(推導值,badge 誠實標示來源)
    type: mfType || (body?.kind === "assembly" || body?.kind === "part" ? body.kind : ""),
    file: fileParam,
    projectDir,
    glbUrl: assetUrl(glbRel, glbAbs),
  });
}

export function filesMiddleware() {
  return function files(req, res, next) {
    const url = parseUrl(req);

    if (url.pathname === "/api/files" && req.method === "GET") {
      const relDir = normalizeRel(url.searchParams.get("dir"));
      let entries;
      try {
        entries = listDir(relDir, req.cadchat);
      } catch (err) {
        const escaped = String(err?.message || "").includes("escapes");
        sendJson(res, escaped ? 403 : 404, {
          ok: false,
          error: escaped ? "路徑超出 models/" : "目錄不存在",
        });
        return;
      }
      // 每個子目錄列各自的 project 旗標(可編輯專案 → 整列一鍵開)在 listDir 已標;
      // 當前目錄不再進得去專案(option C:專案目錄整列開啟不導航),故無需回當前目錄旗標。
      sendJson(res, 200, { ok: true, dir: relDir, entries });
      return;
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => handleOpen(body, res, req.cadchat))
        .catch((err) => sendJson(res, 400, { ok: false, error: scrubPaths(String(err?.message || err)) }));
      return;
    }

    next();
  };
}
