// CAD 核心工作(寫產生器 / 改參數 / 跑 step / 驗證 / 呈現)。
// MCP 工具與「參數即時重生」路徑共用這些函式。
import fs from "node:fs";
import path from "node:path";

import { MODELS_ROOT, resolveMaxSnapshots } from "../config.mjs";
import { persistSession } from "../sessions.mjs";
import { resolveInside } from "./paths.mjs";
import { scrubPaths, spawnPython } from "./python.mjs";

const STEP_DIR = "skills/cad/scripts/step";
const INSPECT_DIR = "skills/cad/scripts/inspect";
const VALIDATE_PY = "apps/cad-chat/src/server/cad/validate.py";

// 產生器名只留安全字元(它會進檔案路徑;name 來自 LLM / client)。
export function sanitizeName(name) {
  return String(name || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "part";
}

function genPyPath(session, name) {
  return path.join(session.workdir, `${sanitizeName(name)}.py`);
}
function relTarget(session, name, ext) {
  return `${session.workdirRel}/${sanitizeName(name)}${ext}`;
}
function glbRel(session, name) {
  // 隱藏 topology GLB:.<name>.step.glb
  return `${session.workdirRel}/.${sanitizeName(name)}.step.glb`;
}
export function glbUrlFor(session, name) {
  return `/api/asset?file=${encodeURIComponent(glbRel(session, name))}`;
}

// 寫產生器原始碼到 session 工作區。
export function writeGenerator(session, name, code) {
  fs.writeFileSync(genPyPath(session, name), code, "utf8");
}

// 把數值序列化成 Python dict literal(JSON 雙引號鍵,Python 可直接 eval)。
function toPyDict(values) {
  const entries = Object.entries(values).map(
    ([k, v]) => `${JSON.stringify(String(k))}: ${Number(v)}`,
  );
  return `{${entries.join(", ")}}`;
}

// 決定性參數重生:改寫產生器頂部的 `PARAMS = {…}` 區塊(免 LLM round-trip)。
export function rewriteParams(session, name, values) {
  const bad = Object.entries(values).filter(([, v]) => !Number.isFinite(Number(v)));
  if (bad.length) {
    return { ok: false, error: `參數必須是數值:${bad.map(([k]) => k).join(", ")}` };
  }
  const file = genPyPath(session, name);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, error: `找不到產生器 ${name}.py` };
  }
  const re = /PARAMS\s*=\s*\{[^{}]*\}/;
  if (!re.test(src)) {
    return { ok: false, error: "產生器沒有可改寫的 PARAMS 區塊" };
  }
  fs.writeFileSync(file, src.replace(re, `PARAMS = ${toPyDict(values)}`), "utf8");
  return { ok: true };
}

// 最小段精修:對既有產生器套用 find/replace 清單(字面比對;find 必須唯一命中)。
// retry 修復用——LLM 不必重送整份原始碼。
export function applyEdits(session, name, edits) {
  const file = genPyPath(session, name);
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, error: `找不到產生器 ${name}.py(edits 模式需要既有產生器)` };
  }
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i] || {};
    if (typeof find !== "string" || !find.length || typeof replace !== "string") {
      return { ok: false, error: `edits[${i}] 需要非空 find 與 replace 字串` };
    }
    const hits = src.split(find).length - 1;
    if (hits === 0) {
      return { ok: false, error: `edits[${i}] 找不到片段:${find.slice(0, 60)}…(逐字比對,含縮排/空白)` };
    }
    if (hits > 1) {
      return { ok: false, error: `edits[${i}] 片段不唯一(${hits} 處),請加長 find 使其唯一` };
    }
    src = src.split(find).join(replace); // 全字面替換(replace 內 $& 等不被解讀)
  }
  fs.writeFileSync(file, src, "utf8");
  return { ok: true, size: src.length };
}

// ---------------------------------------------------------------------------
// 匯入既有 STEP 元件進 session 工作區 imported/ 子目錄。
// 複製(非引用):session 自包含,rehydrate=整目錄複製;envelope path 基準是 .py
// 所在目錄,"imported/x.step" 直接合法。撞名附序號;內容相同直接重用(冪等)。
// ---------------------------------------------------------------------------
// 匯入來源驗證(不碰 session):handleImport 先驗 file 再 getOrCreateSession,
// 否則 ghost sessionId + 壞檔的失敗請求會在磁碟留下剛 mint 的空 session 目錄。
export function resolveImportSource(modelsRelFile) {
  const clean = String(modelsRelFile || "")
    .replace(/\\/g, "/")
    .replace(/^models\//, "");
  let srcAbs;
  try {
    srcAbs = resolveInside(MODELS_ROOT, clean);
  } catch {
    return { ok: false, error: "路徑超出 models/" };
  }
  if (!/\.ste?p$/i.test(srcAbs)) return { ok: false, error: "只能匯入 .step/.stp 檔" };
  let st;
  try {
    st = fs.statSync(srcAbs);
  } catch {
    return { ok: false, error: "檔案不存在" };
  }
  if (!st.isFile()) return { ok: false, error: "不是檔案" };
  return { ok: true, srcAbs };
}

export function importStepIntoSession(session, modelsRelFile) {
  const src0 = resolveImportSource(modelsRelFile);
  if (!src0.ok) return src0;
  const srcAbs = src0.srcAbs;

  const importDir = path.join(session.workdir, "imported");
  fs.mkdirSync(importDir, { recursive: true });
  const base = path.basename(srcAbs);
  const stem = base.replace(/\.ste?p$/i, "");
  const ext = path.extname(base);
  const src = fs.readFileSync(srcAbs);
  let candidate = base;
  for (let i = 2; fs.existsSync(path.join(importDir, candidate)); i += 1) {
    // 內容相同 → 冪等重用(UI 匯入與 agent cad_import 重覆同檔不產生分身)
    if (src.equals(fs.readFileSync(path.join(importDir, candidate)))) {
      return { ok: true, rel: `imported/${candidate}`, label: sanitizeName(candidate.replace(/\.ste?p$/i, "")), reused: true };
    }
    candidate = `${stem}_${i}${ext}`;
  }
  fs.writeFileSync(path.join(importDir, candidate), src);
  return {
    ok: true,
    rel: `imported/${candidate}`,
    label: sanitizeName(candidate.replace(/\.ste?p$/i, "")),
  };
}

// 對工作區內檔案跑 inspect facts,回 {size,faceCount}|null(免 agent 猜尺寸)。
export async function inspectFacts(session, rel, { signal } = {}) {
  const res = await spawnPython(
    INSPECT_DIR,
    ["refs", `${session.workdirRel}/${rel}`, "--facts", "--format", "json"],
    { session, signal },
  );
  try {
    const json = JSON.parse(res.stdout);
    const tok = json.tokens?.[0] || {};
    return {
      size: Array.isArray(tok.entryFacts?.size)
        ? tok.entryFacts.size.map((v) => Math.round(v * 100) / 100)
        : null,
      faceCount: tok.summary?.faceCount ?? null,
    };
  } catch {
    return null;
  }
}

// 跑 scripts/step:產 STEP + 隱藏 GLB。回 {ok, log, stderr, stepRel, glbRel, ms}。
export async function runStep(session, name, { onLog, signal } = {}) {
  const t0 = Date.now();
  const target = relTarget(session, name, ".py");
  const { code, stdout, stderr } = await spawnPython(
    STEP_DIR,
    [target, "--force"],
    { session, onLog, signal },
  );
  const ok = code === 0;
  const stepAbs = path.join(session.workdir, `${name}.step`);
  const glbAbs = path.join(session.workdir, `.${name}.step.glb`);
  const artifactsOk = ok && fs.existsSync(stepAbs) && fs.existsSync(glbAbs);
  return {
    ok: artifactsOk,
    exitCode: code,
    log: stdout,
    stderr,
    stepRel: relTarget(session, name, ".step"),
    glbRel: glbRel(session, name),
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// 組合件 manifest 側檔 <name>.asm.json:檔案類型的真相標記。
// 驗證成功後由伺服端決定性推導(validate.py 的權威 parts 清單 + 原始碼掃描),
// agent 零負擔;UI 靠它區分「元件 vs 組合件」。
// ---------------------------------------------------------------------------
function asmManifestPath(session, name) {
  return path.join(session.workdir, `${sanitizeName(name)}.asm.json`);
}

// 掃描產生器原始碼裡的外部 STEP 引用:
// import_step("…/x.step") 與 envelope "path": "x.step"(決定性 regex,不跑碼)。
function scanGeneratorImports(src) {
  const found = new Set();
  const res = [
    // 同行第一個 .step 字串;[^"'\n]* 允許 str(Path(__file__).parent / …) 的括號
    /import_step\([^"'\n]*["']([^"']+\.ste?p)["']/gi,
    /["']path["']\s*:\s*["']([^"']+\.ste?p)["']/gi,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return [...found];
}

// partCount≥2 寫 manifest;=1(確定單件)刪殘留防類型漂移;=0(產生器掛)不動。
export function writeAsmManifest(session, name, { partCount, parts }) {
  const file = asmManifestPath(session, name);
  if (partCount >= 2) {
    let imports = [];
    try {
      imports = scanGeneratorImports(fs.readFileSync(genPyPath(session, name), "utf8"));
    } catch {
      // 沒有產生器(理論上不會發生)→ imports 留空
    }
    const stem = (p) => p.split("/").pop().replace(/\.ste?p$/i, "");
    const manifest = {
      schemaVersion: 1,
      type: "assembly",
      generator: `${sanitizeName(name)}.py`,
      partCount,
      parts: (parts || []).map((label) => {
        const source = imports.find((p) => stem(p) === label);
        return source ? { label, source } : { label };
      }),
      imports,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } else if (partCount === 1) {
    fs.rmSync(file, { force: true });
  }
}

// 檔案類型三層 fallback:manifest → session.lastPartCount≥2 → part(寧可少標 ASM)。
export function readTypeFor(session, name) {
  try {
    const m = JSON.parse(fs.readFileSync(asmManifestPath(session, name), "utf8"));
    if (m?.type === "assembly") {
      return { type: "assembly", partCount: Number(m.partCount) || 0 };
    }
  } catch {
    // 無 manifest → fallback
  }
  if (session.lastPartCount >= 2) {
    return { type: "assembly", partCount: session.lastPartCount };
  }
  return { type: "part", partCount: session.lastPartCount || 0 };
}

// 跑 inspect(facts)+ validate.py(幾何檢查),合併成一份誠實清單。
export async function runValidate(session, name, { signal } = {}) {
  const t0 = Date.now();
  const stepTarget = relTarget(session, name, ".step");
  const pyTarget = relTarget(session, name, ".py");

  const [inspectRes, validateRes] = await Promise.all([
    spawnPython(
      INSPECT_DIR,
      ["refs", stepTarget, "--facts", "--planes", "--positioning", "--format", "json"],
      { session, signal },
    ),
    spawnPython(VALIDATE_PY, [pyTarget], { session, signal }),
  ]);

  const checks = [];

  // 幾何檢查(來自 validate.py)
  let geomOk = false;
  let motion = null;
  let partCount = 0;
  let parts = [];
  try {
    const parsed = JSON.parse(validateRes.stdout.trim().split("\n").pop());
    if (Array.isArray(parsed.checks)) checks.push(...parsed.checks);
    geomOk = parsed.ok === true;
    motion = parsed.motion || null; // 產生器 MOTION 宣告(前端播放用,已解析數值)
    partCount = Number(parsed.partCount) || 0; // 規模分級(決定性)
    parts = Array.isArray(parsed.parts) ? parsed.parts.map(String) : []; // 權威 label 清單
    if (parsed.error) {
      checks.push({ id: "generator", label: "產生器執行", ok: false, note: parsed.error });
    }
  } catch {
    checks.push({
      id: "generator",
      label: "幾何檢查",
      ok: false,
      note: validateRes.stderr.slice(-200) || "validate.py 無輸出",
    });
  }

  // 拓撲 / 尺寸(來自 inspect)
  try {
    const json = JSON.parse(inspectRes.stdout);
    const tok = json.tokens?.[0] || {};
    const facts = tok.entryFacts || {};
    const size = Array.isArray(facts.size)
      ? facts.size.map((n) => Math.round(n * 100) / 100).join(" × ")
      : "?";
    const faces = tok.summary?.faceCount ?? "?";
    checks.push({
      id: "facts",
      label: "拓撲 / 尺寸 topology",
      ok: json.ok === true,
      note: `bbox ${size} mm · faces=${faces}`,
    });
  } catch {
    checks.push({
      id: "facts",
      label: "拓撲 / 尺寸 topology",
      ok: inspectRes.code === 0,
      note: inspectRes.code === 0 ? "" : "inspect 失敗",
    });
  }

  const overall = checks.every((c) => c.skipped || c.ok);
  // 幾何真的產出來了(partCount>0)才更新檔案類型 manifest
  try {
    writeAsmManifest(session, name, { partCount, parts });
  } catch {
    // manifest 寫失敗不影響驗證結果(type 有 lastPartCount fallback)
  }
  return { ok: overall, checks, motion, partCount, parts, ms: Date.now() - t0 };
}

// 從產生器的 PARAMS dict 解析滑桿定義(決定性 fallback:agent 沒呼叫 emit_params
// 時仍要有滑桿可拉)。範圍用啟發式:整數小值當顆數(step 1),其餘 0.4x~2.5x。
export function paramDefsFromGenerator(session, name) {
  let src;
  try {
    src = fs.readFileSync(genPyPath(session, name), "utf8");
  } catch {
    return [];
  }
  const m = src.match(/PARAMS\s*=\s*\{([^{}]*)\}/);
  if (!m) return [];
  const defs = [];
  const entry = /["']([^"']+)["']\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let e;
  while ((e = entry.exec(m[1])) !== null) {
    const key = e[1];
    const value = Number(e[2]);
    // 0 或負值無法推範圍(會算出 min>max 的壞滑桿),留給 agent 的 emit_params。
    if (!Number.isFinite(value) || value <= 0) continue;
    let def;
    if (Number.isInteger(value) && value > 0 && value <= 20 && !e[2].includes(".")) {
      def = { key, label: key, min: 1, max: Math.max(value * 3, 12), step: 1, value };
    } else {
      const step = value >= 20 ? 1 : value >= 2 ? 0.5 : 0.1;
      def = {
        key,
        label: key,
        unit: "mm",
        min: Math.max(Math.round(value * 0.4 * 10) / 10, step),
        max: Math.round(value * 2.5 * 10) / 10,
        step,
        value,
      };
    }
    defs.push(def);
  }
  return defs;
}

// 每版快照:把頂層產物凍結到 versions/v{N}/,讓時間軸切舊版看「真舊檔」、
// 回退(revert-version)有原料。selector 拓撲內嵌 GLB,快照 .glb 點選即完整。
export function snapshotDir(session, verNum) {
  return path.join(session.workdir, "versions", `v${verNum}`);
}
function snapshotVersion(session, name, verNum, { type, partCount }) {
  const n = sanitizeName(name);
  const dir = snapshotDir(session, verNum);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [`${n}.py`, `${n}.step`, `.${n}.step.glb`, `${n}.asm.json`, `.${n}.step.js`]) {
    const src = path.join(session.workdir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ name: n, type, partCount, ts: Date.now() }),
    "utf8",
  );
  return `${session.workdirRel}/versions/v${verNum}/.${n}.step.glb`;
}

// 快照數量有界:超過上限(resolveMaxSnapshots,預設 30)刪最舊的 v* 目錄。
// 沒有它,參數滑桿的每次套用都複製整組 STEP+GLB(大組合件數 MB/版),長 session
// 會無上限吃磁碟直到快照開始失敗。被剪掉的舊版行為同「較舊的 session 產物」:
// 時間軸縮圖/下載 404、revert 回誠實的「沒有快照可回退」。
function pruneSnapshots(session, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const root = path.join(session.workdir, "versions");
  let names;
  try {
    names = fs.readdirSync(root).filter((n) => /^v\d+$/.test(n));
  } catch {
    return; // 尚無 versions/
  }
  names.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.rmSync(path.join(root, n), { recursive: true, force: true });
    } catch {
      /* 單一目錄刪失敗不擋(下次再剪) */
    }
  }
}

// 呈現:bump 版本並 emit artifact / version / present 三事件(MCP present 與參數重生共用)。
export function emitPresent(session, name, emit) {
  session.version += 1;
  session.lastName = name;
  const ver = `v${session.version}`;
  const stepRel = relTarget(session, name, ".step");
  // 檔案類型(元件/組合件)由 manifest 決定性推導,隨三事件送進前端 badge
  const { type, partCount } = readTypeFor(session, name);
  // glbUrl 指本版快照(每版路徑天然唯一);快照失敗(磁碟滿等)誠實退回頂層檔
  // ——此時保留 &v= cache-buster 的原始用途(同路徑重生時逼前端重載)。
  let fileRel;
  let snapshotOk = true;
  try {
    fileRel = snapshotVersion(session, name, session.version, { type, partCount });
  } catch (err) {
    snapshotOk = false;
    console.warn(`[cad-chat] 版本快照失敗(退回頂層檔):${err?.message || err}`);
    fileRel = glbRel(session, name);
    // 退回頂層檔的後果不能無聲吞掉:此版在時間軸會永遠跟著「最新」幾何走、
    // 無法回退——使用者(常見原因:磁碟滿)必須當下知道。
    emit("error", {
      message: `${ver} 的版本快照建立失敗(${scrubPaths(String(err?.message || err))}):此版無法回退,時間軸縮圖將跟隨最新幾何。`,
    });
  }
  // 成敗都剪(pruneSnapshots 內部全 try/catch,不會拋):持續失敗 regime(磁碟滿)
  // 下半成品 v* 目錄也要有界,而且剪掉舊快照釋放的空間可能就是下一版自癒的空間。
  pruneSnapshots(session, resolveMaxSnapshots());
  const gUrl = `/api/asset?file=${encodeURIComponent(fileRel)}&v=${session.version}`;
  const ghost =
    (name || "PART").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "PART";
  emit("artifact", {
    ver, name, code: name, ghost, formats: ["STEP", "GLB"],
    type, partCount, source: "generated",
  });
  emit("version", {
    id: ver,
    name,
    file: fileRel,
    glbUrl: gUrl,
    formats: ["STEP", "GLB"],
    type,
    partCount,
    source: "generated",
    snapshot: snapshotOk, // false = 本版無凍結快照(退回頂層檔,無法回退)
  });
  emit("present", { ver, name, code: name, file: stepRel, glbUrl: gUrl, type });
  persistSession(session); // version/lastName 剛變動 → 落盤(重整/重啟後計數不歸零)
  return { ver, glbUrl: gUrl };
}

// 把 validate.py 的 {id,ok,skipped,note} 映射成前端 ValidateCard 需要的 icon/color。
export function decorateChecks(checks) {
  return checks.map((c) => {
    if (c.skipped) return { ...c, icon: "–", color: "#a3acba", noteText: c.note || "SKIP" };
    return c.ok
      ? { ...c, icon: "✓", color: "#34ab86", noteText: c.note || "PASS" }
      : { ...c, icon: "✗", color: "#d64848", noteText: c.note || "FAIL" };
  });
}
