// 檔案瀏覽 / 開檔看圖(免 LLM):
//   GET  /api/files?dir=<models 相對路徑>  — 列目錄(dir + .step/.stp/.glb)
//   POST /api/open  {file, kind?}          — 開既有檔;裸 STEP 按需產 topology GLB
// 回 JSON 不走 SSE(SSE 通道與 agent turn 生命周期綁死;開檔是瀏覽動作)。
// 前端拿回應自己 dispatch ADD_VERSION+PRESENT(與 ?glb= 捷徑同路徑)。
import fs from "node:fs";
import path from "node:path";

import { MODELS_ROOT, REPO_ROOT } from "../config.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { resolveInside } from "../cad/paths.mjs";
import { spawnPython } from "../cad/python.mjs";

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

function listDir(relDir) {
  const abs = resolveInside(MODELS_ROOT, relDir || ".");
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const name = ent.name;
    // 藏 dotfile(含隱藏 topology GLB)與快取;.cadchat 例外——先前 session 產物是匯入來源
    if (name.startsWith(".") && name !== ".cadchat") continue;
    if (name === "__pycache__") continue;
    const rel = relDir ? `${relDir}/${name}` : name;
    if (ent.isDirectory()) {
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
    out.push(entry);
  }
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

async function handleOpen(body, res) {
  const fileParam = normalizeRel(body?.file);
  if (!fileParam) {
    sendJson(res, 400, { ok: false, error: "missing file" });
    return;
  }
  let abs;
  try {
    abs = resolveInside(MODELS_ROOT, fileParam);
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
  const relDir = path.relative(MODELS_ROOT, dir).split(path.sep).join("/");
  const assetUrl = (rel) => `/api/asset?file=${encodeURIComponent(rel)}`;

  if (ext === ".glb") {
    const stem = base.replace(/\.glb$/i, "");
    sendJson(res, 200, {
      ok: true,
      name: stem,
      type: typeFromManifest(dir, stem) || "",
      file: fileParam,
      glbUrl: assetUrl(fileParam),
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

  if (!fs.existsSync(glbAbs)) {
    // 裸 STEP:scripts/step 對直接 STEP 目標必須帶 --kind(part|assembly)
    const kind = body?.kind === "assembly" || body?.kind === "part" ? body.kind : null;
    if (!kind) {
      sendJson(res, 200, { ok: false, error: "kind_required" });
      return;
    }
    const repoRel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPEN_TIMEOUT_MS);
    const { code, stderr } = await spawnPython(STEP_DIR, [repoRel, "--kind", kind, "--force"], {
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
    glbUrl: assetUrl(glbRel),
  });
}

export function filesMiddleware() {
  return function files(req, res, next) {
    const url = parseUrl(req);

    if (url.pathname === "/api/files" && req.method === "GET") {
      const relDir = normalizeRel(url.searchParams.get("dir"));
      let entries;
      try {
        entries = listDir(relDir);
      } catch (err) {
        const escaped = String(err?.message || "").includes("escapes");
        sendJson(res, escaped ? 403 : 404, {
          ok: false,
          error: escaped ? "路徑超出 models/" : "目錄不存在",
        });
        return;
      }
      sendJson(res, 200, { ok: true, dir: relDir, entries });
      return;
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => handleOpen(body, res))
        .catch((err) => sendJson(res, 400, { ok: false, error: String(err?.message || err) }));
      return;
    }

    next();
  };
}
