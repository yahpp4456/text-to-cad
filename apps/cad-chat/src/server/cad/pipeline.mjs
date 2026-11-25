// CAD 核心工作(寫產生器 / 改參數 / 跑 step / 驗證 / 呈現)。
// MCP 工具與「參數即時重生」路徑共用這些函式。
import fs from "node:fs";
import path from "node:path";

import { diffBuildSummaries, formatBuildDelta } from "../../lib/buildDelta.js";
import { BASE_PATH, DATA_ROOT, resolveMaxSnapshots } from "../config.mjs";
import { persistSession } from "../sessions.mjs";
import { checkStamp, hashTree, makeStamp, readStamp, writeStamp } from "./closure.mjs";
import { resolveInside, resolveModelRead } from "./paths.mjs";
import { PYTHON_CODE_DIRS, pythonKernelVersions, scrubPaths, spawnPython } from "./python.mjs";
import { pySourceFingerprint } from "./workerPool.mjs";

const STEP_DIR = "skills/cad/scripts/step";
const INSPECT_DIR = "skills/cad/scripts/inspect";
const VALIDATE_PY = "apps/cad-chat/src/server/cad/validate.py";
const FLAT_GLB_PY = "apps/cad-chat/src/server/cad/flat_glb.py";
const RENDER_PY = "apps/cad-chat/src/server/cad/render_view.py";

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
function flatGlbRel(session, name) {
  // 鈑金攤平預覽 GLB:.<name>.flat.step.glb(3D 視圖即時切換用;不寫 STEP)
  return `${session.workdirRel}/.${sanitizeName(name)}.flat.step.glb`;
}
export function glbUrlFor(session, name) {
  return `${BASE_PATH}/api/asset?file=${encodeURIComponent(glbRel(session, name))}`;
}

// ---------------------------------------------------------------------------
// 建置憑證(cad/closure.mjs):build 成功後記下「用了哪些輸入、產出了什麼」,之後輸入與
// 環境都沒變就直接沿用產物,不重建。只在明確要求 reuse 的呼叫點生效(開專案、回退版本
// ——這兩條路的輸入通常原封不動,卻每次都要完整重建加驗證)。
// 憑證與驗證快取是產物旁的隱藏檔,隨版本快照與專案儲存一起走:
//   .<name>.build.json     輸入雜湊 + 環境 + 產物雜湊
//   .<name>.validate.json  同一張憑證下的完整驗證結果
// 只有 worker 路徑寫得出憑證(讀檔紀錄與 kernel 版本來自 worker);CADCHAT_WORKER=0
// 或 worker 起不來時沒有憑證 = 每次重建,行為與以前相同。
// ---------------------------------------------------------------------------
const buildStampPath = (session, name) =>
  path.join(session.workdir, `.${sanitizeName(name)}.build.json`);
const validateCachePath = (session, name) =>
  path.join(session.workdir, `.${sanitizeName(name)}.validate.json`);

function rmQuiet(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 刪不掉就留著:核對時內容對不上自然不會命中 */
  }
}

// 入口腳本與 cad-chat 自己的 Python 的內容摘要。內容雜湊要讀不少檔,所以用「修改時間 +
// 檔案數」當記憶鍵:沒人動過就不重算。
let scriptsMemo = { fingerprint: null, digest: null };
function scriptsDigest() {
  const fingerprint = pySourceFingerprint(PYTHON_CODE_DIRS);
  if (fingerprint !== scriptsMemo.fingerprint) {
    scriptsMemo = { fingerprint, digest: hashTree(PYTHON_CODE_DIRS) };
  }
  return scriptsMemo.digest;
}

// 會影響建模結果的環境:kernel 版本、實際載入的 cadpy、入口腳本。worker 尚未就緒過回 null。
function buildEnv(versions = pythonKernelVersions()) {
  if (!versions) return null;
  return {
    python: versions.python,
    build123d: versions.build123d,
    ocp: versions.ocp,
    cadpy: versions.cadpy,
    scripts: scriptsDigest(),
  };
}

function stampVerdict(session, name) {
  try {
    return checkStamp(readStamp(buildStampPath(session, name)), {
      name: sanitizeName(name),
      env: buildEnv(),
      genDir: session.workdir,
      dataRoot: DATA_ROOT,
    });
  } catch (err) {
    return { hit: false, reason: `核對失敗:${err?.message || err}` };
  }
}

// build 成功後寫憑證。任何一步不成立(沒有讀檔紀錄、產物不齊…)就不寫——不影響 build 結果。
function writeBuildStamp(session, name, results) {
  const n = sanitizeName(name);
  const file = buildStampPath(session, name);
  try {
    const main = results[0];
    if (!main || !Array.isArray(main.reads)) return;
    const reads = results.flatMap((r) => (r && Array.isArray(r.reads) ? r.reads : []));
    const outputs = [`${n}.step`, `.${n}.step.glb`, `.${n}.step.meta.json`];
    for (const optional of [`.${n}.flat.step.glb`, `.${n}.flat.lines.json`]) {
      if (fs.existsSync(path.join(session.workdir, optional))) outputs.push(optional);
    }
    const stamp = makeStamp({
      name: n,
      env: buildEnv(main.versions),
      reads,
      genDir: session.workdir,
      dataRoot: DATA_ROOT,
      outputs,
    });
    if (stamp) writeStamp(file, stamp);
  } catch (err) {
    rmQuiet(file);
    console.warn(`[cad-chat] 建置憑證寫入失敗(不影響產物):${scrubPaths(String(err?.message || err))}`);
  }
}

// 寫產生器原始碼到 session 工作區。
export function writeGenerator(session, name, code) {
  fs.writeFileSync(genPyPath(session, name), code, "utf8");
}

// 把數值序列化成 Python dict literal(JSON 雙引號鍵,Python 可直接 eval)。
// floatKeys:原始碼字面帶小數點的鍵——整數值也要寫成 `20.0` 形,否則重生一次
// 小數點蒸發,paramDefsFromGenerator 的整數啟發式會把 mm 參數誤判成顆數
// (掛上 int:true 鎖整數)——連鎖雷。
function toPyDict(values, floatKeys = new Set()) {
  const entries = Object.entries(values).map(([k, v]) => {
    const n = Number(v);
    const lit = floatKeys.has(k) && Number.isInteger(n) ? `${n}.0` : `${n}`;
    return `${JSON.stringify(String(k))}: ${lit}`;
  });
  return `{${entries.join(", ")}}`;
}

// 原始碼 PARAMS 區塊裡「字面含小數點」的鍵集(float-ness 真相源;toPyDict 用)。
export function paramFloatKeysFromGenerator(session, name) {
  let src;
  try {
    src = fs.readFileSync(genPyPath(session, name), "utf8");
  } catch {
    return new Set();
  }
  const m = src.match(/PARAMS\s*=\s*\{([^{}]*)\}/);
  if (!m) return new Set();
  const out = new Set();
  const entry = /["']([^"']+)["']\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let e;
  while ((e = entry.exec(m[1])) !== null) {
    if (e[2].includes(".")) out.add(e[1]);
  }
  return out;
}

// 決定性參數重生:改寫產生器頂部的 `PARAMS = {…}` 區塊(免 LLM round-trip)。
// 傳入值先以磁碟現值墊底 merge:整塊替換的語意下,呼叫端(agent 的
// cad_build(params) 只 emit 部分滑桿、或前端漏鍵)送「子集」會把其餘鍵蒸發,
// 產生器 import 即 KeyError、滑桿永遠套不上——墊底後子集=只改那幾鍵,其餘照舊。
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
  const current = paramValuesFromGenerator(session, name) || {};
  const merged = { ...current, ...values };
  const floatKeys = paramFloatKeysFromGenerator(session, name); // float-ness 保留(見 toPyDict)
  fs.writeFileSync(file, src.replace(re, `PARAMS = ${toPyDict(merged, floatKeys)}`), "utf8");
  return { ok: true, prevSrc: src }; // prevSrc:build 失敗回滾用(buildOrRollback)
}

// 決定性重生的「建置 → 失敗還原」核心(chat.mjs deterministicRegen 用;agent 的
// cad_build(params) 刻意不走這裡——agent 拿到 stderr 後接著 edits 修,背後回滾會
// 讓它的「參數已套上」心智模型錯位)。build 可注入(單測不 spawn Python)。
// 失敗且未中斷 → 把 prevSrc(rewriteParams 改寫前整檔)原樣寫回,並還原 runStep
// 動過的 _geomDirty/_lastValidate/lastBuildMeta——回滾後磁碟 .py 與 .step/.glb 又是
// 同一版,session 不該殘留「重生中」狀態。磁碟 sidecar 已被失敗 build 清掉,但記憶
// 體 meta 描述的仍是同一份產生器,誠實可用(零 spawn 快路徑不受影響)。
// aborted 絕不寫檔/動狀態(interrupt 已放行鎖,新 turn 可能已接手改寫 .py);
// await 之後到寫檔全程同步,無再被搶佔的窗。
export async function buildOrRollback(session, name, prevSrc, { signal, build = runStep } = {}) {
  const saved = {
    geomDirty: session._geomDirty,
    lastValidate: session._lastValidate,
    buildMeta: session.lastBuildMeta,
  };
  const step = await build(session, name, { signal });
  if (step.ok || signal?.aborted) return { step, rolledBack: false };
  let rolledBack = false;
  try {
    writeGenerator(session, name, prevSrc);
    session._geomDirty = saved.geomDirty;
    session._lastValidate = saved.lastValidate;
    session.lastBuildMeta = saved.buildMeta;
    rolledBack = true;
  } catch {
    /* 回滾寫檔失敗(磁碟錯誤):rolledBack=false,呼叫端誠實告知留了壞檔 */
  }
  return { step, rolledBack };
}

// 結構重生:整塊改寫 `CABLE_SPEC` + `PARAMS` + `PARAM_RANGES`(規格表單改「層數 /
// 帶型」時走這條;只改數值仍走 rewriteParams)。與 rewriteParams 的三個關鍵差異:
//   ① PARAMS **整塊替換,不與磁碟現值 merge** —— 層數變少時 merge 會留下舊的 L 鍵,
//      paramDefsFromGenerator 對每個數值鍵都出滑桿 → 幽靈滑桿(拉了也沒用);
//   ② PARAM_RANGES 是純文字 regex 解析、Python 端不能由 N 算 —— 必須一起重寫
//      (L1..LN 各一列、head_h 下限 = 層數 × 線架高);
//   ③ CABLE_SPEC 用多行 JSON(收尾 `}` 頂第 0 欄,與 readFlatJsonDecl 的文法一致)。
// 回 {ok, prevSrc}(prevSrc = 改寫前整檔,build 失敗回滾用)或 {ok:false, error}。
export function rewriteSpec(session, name, { spec, params, ranges } = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "spec 必須是物件" };
  }
  const layers = Number(spec.layers);
  if (!Number.isInteger(layers) || layers < 1 || layers > 12) {
    return { ok: false, error: `spec.layers 必須是 1–12 的整數(got ${spec.layers})` };
  }
  if (!Array.isArray(spec.bands) || !spec.bands.length) {
    return { ok: false, error: "spec.bands 不能是空的" };
  }
  const lvls = new Set(spec.bands.map((b) => Number(b?.level)));
  for (let i = 0; i < layers; i++) {
    if (!lvls.has(i)) return { ok: false, error: `spec.bands 缺 level ${i} 的帶(層數 ${layers})` };
  }
  const bad = Object.entries(params || {}).filter(([, v]) => !Number.isFinite(Number(v)));
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
  const specRe = /^CABLE_SPEC\s*=\s*\{[\s\S]*?^\}[ \t]*$/m;
  if (!specRe.test(src)) return { ok: false, error: "產生器沒有可改寫的 CABLE_SPEC 區塊" };
  const paramsRe = /PARAMS\s*=\s*\{[^{}]*\}/;
  if (!paramsRe.test(src)) return { ok: false, error: "產生器沒有可改寫的 PARAMS 區塊" };

  // CABLE_SPEC:多行 JSON(bands 一行一筆,人讀得懂 diff)
  const specLines = [
    "CABLE_SPEC = {",
    `  "layers": ${layers},`,
    `  "riser_module": ${Number(spec.riser_module) || 0},`,
    ...(spec.measured ? [`  "measured": ${JSON.stringify(spec.measured)},`] : []),
    '  "bands": [',
    ...spec.bands.map(
      (b, i) => `    ${JSON.stringify(b)}${i === spec.bands.length - 1 ? "" : ","}`,
    ),
    "  ]",
    "}",
  ];
  let out = src.replace(specRe, specLines.join("\n"));
  // PARAMS:整塊替換(不 merge);mm 值一律帶小數點(float-ness,見 toPyDict)
  const floatKeys = new Set(Object.keys(params || {}));
  out = out.replace(paramsRe, `PARAMS = ${toPyDict(params || {}, floatKeys)}`);
  // PARAM_RANGES:給定就整塊重寫(層數變了必須跟著,否則新 L 鍵沒有固定範圍、
  // head_h 下限還停在舊層數)
  if (ranges && typeof ranges === "object") {
    const body = Object.entries(ranges)
      .map(([k, r]) => `    ${JSON.stringify(k)}: [${r.min}, ${r.max}, ${r.step}]`)
      .join(",\n");
    const rangesRe = /PARAM_RANGES\s*=\s*\{[^{}]*\}/;
    const block = `PARAM_RANGES = {\n${body},\n}`;
    out = rangesRe.test(out) ? out.replace(rangesRe, block) : out;
  }
  fs.writeFileSync(file, out, "utf8");
  return { ok: true, prevSrc: src };
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
export function resolveImportSource(modelsRelFile, { modelsRoot } = {}) {
  const clean = String(modelsRelFile || "")
    .replace(/\\/g, "/")
    .replace(/^models\//, "");
  let srcAbs;
  try {
    srcAbs = resolveModelRead(clean, { modelsRoot }); // 讀取:雙根(user 層優先、fixtures fallback)
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
  // 來源解析以 session 擁有者的 models 根為準(agent 的 cad_import 工具也經此,
  // user session 只能匯本人層 + 共用 fixtures)。另收 "uploads/…":session 內
  // 上傳件(cable 模式的客戶參考 STEP;HTTP /api/import 在 handleImport 先走
  // models-only 的 resolveImportSource,不經此分支)。
  const cleanRel = String(modelsRelFile || "").replace(/\\/g, "/");
  let src0;
  if (/^uploads\//.test(cleanRel)) {
    try {
      const abs = resolveInside(session.workdir, cleanRel);
      if (!/\.ste?p$/i.test(abs)) {
        src0 = { ok: false, error: "只能匯入 .step/.stp 檔" };
      } else if (!fs.statSync(abs).isFile()) {
        src0 = { ok: false, error: "不是檔案" };
      } else {
        src0 = { ok: true, srcAbs: abs };
      }
    } catch {
      src0 = { ok: false, error: "上傳檔不存在或路徑超出工作區" };
    }
  } else {
    src0 = resolveImportSource(cleanRel, { modelsRoot: session.modelsRoot });
  }
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

// 讀 build 收割 sidecar(`.{name}.step.meta.json`,cadpy generation 寫)。
// 壞 JSON / 缺檔 / schema 不符 → null(呼叫端退回 spawn fallback,絕不誤用)。
export function readBuildMeta(session, name) {
  return readBuildMetaFile(path.join(session.workdir, `.${sanitizeName(name)}.step.meta.json`));
}

// 零件 → 「由 <檔> 第 N 行 fn() 建立」(藍圖 C2 零件層級)。沒有紀錄回 ""。
// 值來自產生器行程寫的 sidecar,逐欄白名單化後才進 prompt。
export function madeByText(meta, part) {
  const site = meta?.madeBy && Object.hasOwn(meta.madeBy, part) ? meta.madeBy[part] : null;
  const line = Number(site?.line);
  if (!site || !Number.isInteger(line) || line < 1) return "";
  const file = String(site.file || "").replace(/[^\w.\-]/g, "").slice(0, 80);
  if (!file) return "";
  const func = /^[A-Za-z_]\w{0,60}$/.test(String(site.func || "")) ? ` 的 ${site.func}()` : "";
  return `由 ${file} 第 ${line} 行${func} 建立`;
}

// 點選參照屬於哪個零件:前端帶的零件名優先(必須真的在這次建置的零件表裡);
// 沒帶而模型只有一個零件時就是它。對不上回 null——不猜。
export function partOfRef(meta, ref) {
  const parts = Array.isArray(meta?.parts) ? meta.parts : [];
  const named = String(ref?.part || "");
  if (named && parts.includes(named)) return named;
  return !named && parts.length === 1 ? parts[0] : null;
}

// 同上,直接給檔案路徑(版本快照裡的那一份也用這個讀)。
function readBuildMetaFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const meta = JSON.parse(raw);
    if (meta?.schemaVersion !== 1 || !Array.isArray(meta.parts)) return null;
    return {
      parts: meta.parts.map(String),
      partCount: Number(meta.partCount) || meta.parts.length,
      motion: meta.motion || null, // 已是播放子集(cadpy.motion_decl.playback_motion)
      motionErrs: Array.isArray(meta.motionErrs) ? meta.motionErrs.map(String) : [],
      // 掃出路徑預覽折線(generator 模組層 SWEEP_PATHS,cadpy 收割時已防禦正規化)
      sweepPaths: Array.isArray(meta.sweepPaths) ? meta.sweepPaths : [],
      // 掃出工作窗資料(SWEEP_VIEW;cadpy 收割「任一欄壞=整份 None」)
      sweepView: meta.sweepView && typeof meta.sweepView === "object" ? meta.sweepView : null,
      // 每個零件的量測摘要(cadpy.build_delta);舊 sidecar 沒有這欄 → null,差異摘要就不出。
      summary: meta.summary && typeof meta.summary === "object" ? meta.summary : null,
      // 鈑金可製造性建議(findings 的 dict;cadpy 收割時已轉好)。舊 sidecar 沒有 → 空陣列
      advisories: Array.isArray(meta.advisories) ? meta.advisories : [],
      // 每個零件是產生器哪一行建的(cadpy.assembly.label_shape 記錄;藍圖 C2)。舊 sidecar 沒有 → {}
      madeBy: meta.madeBy && typeof meta.madeBy === "object" ? meta.madeBy : {},
      // 每個零件的面與邊的穩定名稱與建立行號(cadpy.kernel.naming;藍圖 C1)。沒有 → null
      names:
        meta.names?.schemaVersion === 1 && meta.names.parts && typeof meta.names.parts === "object"
          ? meta.names
          : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 建置差異摘要(藍圖 B3):這次建出來的東西和上一次差在哪——零件數、哪些件新增/移除/
// 改了/移動了、整體包絡、自由度數。一行字,給 agent(cad_build 的回覆)與使用者(時間軸
// 版本卡)看同一句。比對是純函數(src/lib/buildDelta.js);量測在 build 時由 cadpy 收割。
// 用意是讓「我以為只改了一個孔,結果整個件位移了」這種事在建置當下就看得到。
// ---------------------------------------------------------------------------
function summaryOf(meta) {
  if (!meta?.summary) return null;
  const dofs = Array.isArray(meta.motion?.dofs) ? meta.motion.dofs.length : 0;
  return { ...meta.summary, dofCount: dofs > 0 ? dofs : null };
}

// prevMeta 可為 null(沒有上一次)。本次沒有摘要(舊 sidecar、收割失敗)→ 空字串。
export function buildDeltaText(prevMeta, curMeta) {
  const cur = summaryOf(curMeta);
  if (!cur) return "";
  return formatBuildDelta(diffBuildSummaries(summaryOf(prevMeta), cur));
}

// 版本卡用:與「上一個含同名產物的版本快照」比。找不到上一版 → 只列件數與包絡。
function versionDeltaText(session, name, verNum) {
  const n = sanitizeName(name);
  const cur = readBuildMeta(session, name);
  if (!cur?.summary) return "";
  let prev = null;
  for (let k = verNum - 1; k >= 1 && k >= verNum - 40 && !prev; k -= 1) {
    prev = readBuildMetaFile(path.join(snapshotDir(session, k), `.${n}.step.meta.json`));
    if (prev && !prev.summary) prev = null;
  }
  return buildDeltaText(prev, cur).replace(/^首次建置:/, "");
}

// 掃出路徑預覽 sidecar(`.{name}.sweep.json`):把 meta 收割的 SWEEP_PATHS 落成
// /api/asset 可服務的獨立 JSON(不直接 serve .step.meta.json——那份還載 motion 等
// 別的語意)。空/缺 → 刪殘留,滑桿把路徑改沒了不留殘影(鏡射 asm.json 刪除語義)。
// sweepView(掃出工作窗資料)為選配 additive 欄位:schemaVersion 恆 1,舊消費者
// 不受影響;sidecar 存在性仍只由 paths 決定(view 依附路徑,無路徑無窗)。
// 獨立 export 供 L1 直測。
export function writeSweepSidecar(session, name, sweepPaths, sweepView = null) {
  const p = path.join(session.workdir, `.${sanitizeName(name)}.sweep.json`);
  const paths = Array.isArray(sweepPaths) ? sweepPaths : [];
  if (!paths.length) {
    fs.rmSync(p, { force: true });
    return null;
  }
  const body = { schemaVersion: 1, paths, ...(sweepView ? { view: sweepView } : {}) };
  fs.writeFileSync(p, JSON.stringify(body), "utf8");
  return p;
}

// build 產物就位後的 session 簿記(真的建完、或沿用既有產物,兩條路共用)。
function adoptBuild(session, name) {
  const n = sanitizeName(name);
  // sidecar → session(name 綁定):設計模式 cad_validate / 滑桿重生的零 spawn 來源。
  // sidecar 缺失(舊 cadpy 未同步等)→ 存 null,消費端自動退回 --motion-only spawn。
  const meta = readBuildMeta(session, name);
  session.lastBuildMeta = meta ? { name: n, ...meta } : null;
  // per-name 槽:派工模式多個子代理並行 build 不同名字,單槽 lastBuildMeta 會互相
  // 清掉(cad_validate 退回 spawn);單人路徑行為不變(lastBuildMeta 照舊)。
  (session.buildMeta ||= {})[n] = session.lastBuildMeta;
  // 權威 partCount 同步(來自同一次 gen_step):build 後未 validate 就 present 的
  // 回合,readTypeFor 的 fallback 與 badge 也拿到新鮮值。
  if (meta && meta.partCount > 0) session.lastPartCount = meta.partCount;
  // 掃出路徑預覽 sidecar 跟本次 build 的收割走(失敗 build 不動它:頂層殘檔只在
  // 下次成功 present 前有效,快照裡的舊版 sidecar 才是舊版 overlay 的真相源)。
  try {
    writeSweepSidecar(session, name, meta?.sweepPaths, meta?.sweepView);
  } catch {
    /* overlay 是輔助資訊,寫失敗不擋 build */
  }
  return meta;
}

// 跑 scripts/step:產 STEP + 隱藏 GLB。回 {ok, log, stderr, stepRel, glbRel, ms}。
// reuse:true → 先核對建置憑證,輸入與環境都沒變就沿用既有產物(回傳多一個 reused:true)。
export async function runStep(session, name, { onLog, signal, reuse = false } = {}) {
  const t0 = Date.now();
  const n = sanitizeName(name);
  // 幾何重生中:舊驗證判定即刻作廢(versionStamp 的 verified 誠實反映「當前幾何
  // 最後跑過哪級驗證」;build 後不 validate 直接 present → verified:false)。
  session._lastValidate = null;
  // 頂層工作基準開始漂移(build 後若 turn 被中斷、沒走到 present,頂層 ≠ 最新版本
  // 快照)。emitPresent 收斂回 false;精算(/api/validate)據此回 stale,前端不把
  // 「漂移幾何的驗證結果」誤標到舊快照版上。
  session._geomDirty = true;
  if (reuse) {
    const verdict = stampVerdict(session, name);
    // 憑證命中 = 輸入、環境、產物都與上次建置相同。sidecar 讀不到就當沒命中(照常重建)。
    if (verdict.hit && adoptBuild(session, name)) {
      const flatAbsReused = path.join(session.workdir, `.${n}.flat.step.glb`);
      return {
        ok: true,
        exitCode: 0,
        log: "",
        stderr: "",
        stepRel: relTarget(session, name, ".step"),
        glbRel: glbRel(session, name),
        flatGlbRel: fs.existsSync(flatAbsReused) ? flatGlbRel(session, name) : null,
        ms: Date.now() - t0,
        reused: true,
      };
    }
  }
  // 差異摘要的比較基準 = 上一次**成功**的建置。記憶體裡沒有(伺服器重啟後)就讀磁碟上
  // 還在的 sidecar——要在 spawn 之前讀,Python 端一開跑就會把它刪掉。
  const prevMeta = session._buildPrev?.[n] ?? readBuildMeta(session, name);
  // 要真的重建了:舊憑證與驗證快取描述的是即將被覆寫的產物,先作廢。
  rmQuiet(buildStampPath(session, name));
  rmQuiet(validateCachePath(session, name));
  const target = relTarget(session, name, ".py");
  // 鈑金件(產生器有 gen_flat):攤平預覽 GLB 與摺疊 build **併行**——兩者都只讀
  // 同一份 .py、寫不同 GLB(.step.glb vs .flat.step.glb),無檔案衝突;併行不拖長
  // build wall。best-effort:攤平 GLB 失敗不擋 build(只是沒有摺疊/攤平切換鈕)。
  const flatPromise = generatorHasFlat(session, name)
    ? spawnPython(FLAT_GLB_PY, [target, flatGlbRel(session, name)], { session, signal })
    : null;
  const stepRes = await spawnPython(STEP_DIR, [target, "--force"], { session, onLog, signal });
  const { code, stdout, stderr } = stepRes;
  const flatRes = flatPromise ? await flatPromise.catch(() => null) : null;
  const ok = code === 0;
  const stepAbs = path.join(session.workdir, `${name}.step`);
  const glbAbs = path.join(session.workdir, `.${name}.step.glb`);
  const flatAbs = path.join(session.workdir, `.${name}.flat.step.glb`);
  const artifactsOk = ok && fs.existsSync(stepAbs) && fs.existsSync(glbAbs);
  const flatRelVal =
    flatRes && flatRes.code === 0 && fs.existsSync(flatAbs) ? flatGlbRel(session, name) : null;
  let delta = "";
  if (artifactsOk) {
    const meta = adoptBuild(session, name);
    // 有 sidecar 才寫憑證:沿用產物時要靠 sidecar 還原 session 的 build 資訊。
    if (meta) writeBuildStamp(session, name, [stepRes, flatRes]);
    delta = buildDeltaText(prevMeta, meta);
    // 失敗的建置不更新基準:下一次成功時仍與「上一個做得出來的版本」比。
    if (meta?.summary) (session._buildPrev ||= {})[n] = meta;
  } else {
    // 失敗 build(Python 側已先 unlink sidecar):清掉記憶體 meta,雙保險防 stale。
    if (session.lastBuildMeta?.name === n) session.lastBuildMeta = null;
    if (session.buildMeta) session.buildMeta[n] = null;
  }
  return {
    ok: artifactsOk,
    exitCode: code,
    log: stdout,
    stderr,
    stepRel: relTarget(session, name, ".step"),
    glbRel: glbRel(session, name),
    flatGlbRel: flatRelVal, // 鈑金攤平預覽 GLB(null = 非鈑金件 / 攤平失敗)
    delta, // 與上一次成功建置的差異摘要(一行字;沒有摘要可比時為空字串)
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

// ---------------------------------------------------------------------------
// 檢查列的狀態(validate.py 檔頭有完整說明):
//   ok / failed / not_checked(該量而沒量到)/ not_applicable(這個模型不需要這項)
// 「量不到不算通過」:完整驗證的總判定只認 ok 與 not_applicable。not_checked 的列同時是
// skipped:true,所以 agent 的自修條件與教訓庫不會把它當成幾何錯誤——但它擋匯出。
// ---------------------------------------------------------------------------
export function checkStatus(check) {
  if (check?.status) return check.status;
  if (check?.skipped) return "not_checked"; // 沒標狀態的略過列:從嚴,當作沒量到
  return check?.ok ? "ok" : "failed";
}

// 完整驗證是否通過:至少有一列真的檢查,且每一列不是通過、不適用,就是建議(advisory:做得出來,
// 只是加工廠會提的事——不擋匯出)。只有建議列、沒有任何檢查列,不算通過。
export function fullValidationOk(checks) {
  if (!Array.isArray(checks)) return false;
  const judged = checks.filter((c) => checkStatus(c) !== "advisory");
  return (
    judged.length > 0 &&
    judged.every((c) => {
      const status = checkStatus(c);
      return status === "ok" || status === "not_applicable";
    })
  );
}

// 同一張建置憑證下的完整驗證結果(.<name>.validate.json)。憑證命中 = 輸入、環境、產物都
// 沒變,驗證是決定性的,結果必然相同。key 對不上、檔案壞掉、憑證不命中都回 null。
function readValidateCache(session, name) {
  const verdict = stampVerdict(session, name);
  if (!verdict.hit) return null;
  try {
    const stamp = readStamp(buildStampPath(session, name));
    const cached = JSON.parse(fs.readFileSync(validateCachePath(session, name), "utf8"));
    if (!cached || cached.schema !== 1 || cached.key !== stamp.key) return null;
    if (!Array.isArray(cached.checks) || cached.checks.length === 0) return null;
    return cached;
  } catch {
    return null;
  }
}

// 「逾時」的結果不是這份幾何的定論(換一台機器、機器閒一點就可能掃得完),不快取。
const VALIDATE_NOT_FINAL_RE = /逾時/;

function writeValidateCache(session, name, result) {
  const file = validateCachePath(session, name);
  try {
    // 有 not_checked 的結果不是定論(換一台機器、機器閒一點就可能量得完),不快取。
    if (result.checks.some((c) => checkStatus(c) === "not_checked" || VALIDATE_NOT_FINAL_RE.test(String(c.note || "")))) {
      return rmQuiet(file);
    }
    const verdict = stampVerdict(session, name);
    if (!verdict.hit) return rmQuiet(file); // 沒有可對應的憑證(或驗證期間輸入又變了)
    const stamp = readStamp(buildStampPath(session, name));
    fs.writeFileSync(file, JSON.stringify({ schema: 1, key: stamp.key, ...result }), "utf8");
  } catch {
    rmQuiet(file);
  }
}

// 跑 inspect(facts)+ validate.py(幾何檢查),合併成一份誠實清單。
// reuse:true → 同一張建置憑證下已有完整驗證結果就直接用(回傳多一個 reused:true)。
export async function runValidate(session, name, { signal, motionOnly = false, reuse = false } = {}) {
  const t0 = Date.now();
  if (reuse && !motionOnly) {
    const cached = readValidateCache(session, name);
    if (cached) {
      const partCount = Number(cached.partCount) || 0;
      const parts = Array.isArray(cached.parts) ? cached.parts.map(String) : [];
      try {
        writeAsmManifest(session, name, { partCount, parts });
      } catch {
        // 同下:manifest 寫失敗不影響驗證結果
      }
      session._lastValidate = { name: sanitizeName(name), full: true, ok: cached.ok === true };
      return {
        ok: cached.ok === true,
        checks: cached.checks,
        motion: cached.motion || null,
        partCount,
        parts,
        ms: Date.now() - t0,
        reused: true,
      };
    }
  }
  const stepTarget = relTarget(session, name, ".step");
  const pyTarget = relTarget(session, name, ".py");

  const [inspectRes, validateRes] = await Promise.all([
    spawnPython(
      INSPECT_DIR,
      ["refs", stepTarget, "--facts", "--planes", "--positioning", "--format", "json"],
      { session, signal },
    ),
    spawnPython(VALIDATE_PY, motionOnly ? [pyTarget, "--motion-only"] : [pyTarget], {
      session,
      signal,
    }),
  ]);

  const checks = [];

  // 幾何檢查(來自 validate.py)
  let geomOk = false;
  let motion = null;
  let partCount = 0;
  let parts = [];
  let conclusive = true; // 兩支腳本都正常回報(不是被中止、崩潰、輸出解析不了)才可快取
  try {
    const parsed = JSON.parse(validateRes.stdout.trim().split("\n").pop());
    if (!Array.isArray(parsed.checks) || parsed.error) conclusive = false;
    if (Array.isArray(parsed.checks)) checks.push(...parsed.checks);
    geomOk = parsed.ok === true;
    motion = parsed.motion || null; // 產生器 MOTION 宣告(前端播放用,已解析數值)
    partCount = Number(parsed.partCount) || 0; // 規模分級(決定性)
    parts = Array.isArray(parsed.parts) ? parsed.parts.map(String) : []; // 權威 label 清單
    if (parsed.error) {
      checks.push({ id: "generator", label: "產生器執行", ok: false, note: parsed.error });
    }
  } catch {
    conclusive = false;
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
      status: json.ok === true ? "ok" : "failed",
      note: `bbox ${size} mm · faces=${faces}`,
    });
  } catch {
    conclusive = false;
    checks.push({
      id: "facts",
      label: "拓撲 / 尺寸 topology",
      ok: inspectRes.code === 0,
      note: inspectRes.code === 0 ? "" : "inspect 失敗",
    });
  }

  // 完整驗證:量不到不算通過(not_checked 的列讓總判定為 false,匯出閘因此擋下)。
  // --motion-only 是設計模式的退路,本來就不宣稱驗證過,維持「沒有失敗就算過」。
  const overall = motionOnly ? checks.every((c) => c.skipped || c.ok) : fullValidationOk(checks);
  // 完整驗證且兩支腳本都有定論、沒被中止 → 記在憑證旁,同樣的輸入下次免重跑。
  if (!motionOnly) {
    if (conclusive && !signal?.aborted && validateRes.code === 0 && inspectRes.code === 0) {
      writeValidateCache(session, name, { ok: overall, checks, motion, partCount, parts });
    } else {
      rmQuiet(validateCachePath(session, name));
    }
  }
  // 幾何真的產出來了(partCount>0)才更新檔案類型 manifest
  try {
    writeAsmManifest(session, name, { partCount, parts });
  } catch {
    // manifest 寫失敗不影響驗證結果(type 有 lastPartCount fallback)
  }
  // versionStamp 用:「當前幾何最後跑過哪級驗證」。transient(底線前綴,不落盤);
  // runStep 開跑即清 → 這裡永遠描述本輪 build 之後的最新判定。
  session._lastValidate = { name: sanitizeName(name), full: !motionOnly, ok: overall };
  return { ok: overall, checks, motion, partCount, parts, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// 設計模式驗證:零 spawn。build 收割 sidecar(session.lastBuildMeta)直接組
// checks(全 skipped)+ motion;缺 meta(rehydrate 後沒 build 過等)退回
// validate.py --motion-only spawn。實際模式/精算一律走上面的 runValidate。
// ---------------------------------------------------------------------------

// 四列 checks(正常全 skipped)。文案逐字對齊 validate.py --motion-only 的輸出
// (validate.py 的 _check_* 各分支;pipeline.design.test.js 釘死,改一邊必改另一邊)
// ——motion_sweep 列在 motionErrs 非空時是**真 fail**(非 skipped):「宣告已知錯誤」
// 與「尚未做掃掠」是兩件事,前者要觸發 agent 的自修條件(prompt 只對非 skipped 的
// fail 自修;審查 F2)。note 前綴與 validate.py full 模式、lessons signature 同字。
export function designChecksFromMeta(meta) {
  // 設計模式略過的列是 not_checked(該量而沒量);模型本來就不需要的是 not_applicable。
  const skip = (id, label, note, status = "not_checked") => ({ id, label, ok: true, skipped: true, status, note });
  const MOTION_LABEL = "運動掃掠干涉 motion-sweep";
  let motionRow;
  if (meta.motionErrs.length) {
    motionRow = {
      id: "motion_sweep",
      label: MOTION_LABEL,
      ok: false,
      skipped: false,
      status: "failed",
      note: "MOTION 宣告無效: " + meta.motionErrs.slice(0, 2).join("; "),
      // 與 validate.py 同形:每條宣告錯誤一筆 finding(教訓庫依 rule 歸類)
      findings: meta.motionErrs.slice(0, 20).map((message) => ({ rule: "motion.declaration", status: "failed", message: String(message) })),
    };
  } else if (!meta.motion) {
    motionRow = skip("motion_sweep", MOTION_LABEL, "未提供運動學", "not_applicable");
  } else {
    motionRow = skip("motion_sweep", MOTION_LABEL, "設計模式:略過掃掠(未驗證)");
  }
  // 鈑金可製造性建議:有才列,永遠是 ok(不擋匯出)。與 validate.py 的同名列同一份資料、同一個形狀。
  const advisoryRows = meta.advisories?.length
    ? [{
        id: "sheet_dfm",
        label: advisoryLabel(meta.advisories),
        ok: true,
        skipped: false,
        status: "advisory",
        note: `${meta.advisories.length} 項建議`,
        findings: meta.advisories,
      }]
    : [];
  return [
    skip("valid_solid", "封閉性 / 有效實體 (watertight)", "設計模式:略過驗證(未驗證)"),
    meta.partCount >= 2
      ? skip("interference", "零件干涉 interference", "設計模式:略過驗證(未驗證)")
      : skip("interference", "零件干涉 interference", "單一零件,無需檢查", "not_applicable"),
    motionRow,
    // 零 spawn 後沒有 inspect 的 bbox/faceCount:誠實標 SKIP(精算此版會補真值)
    skip("facts", "拓撲 / 尺寸 topology", "設計模式:略過檢查(未驗證)"),
    ...advisoryRows,
  ];
}

// 建議列的標題:全是鈑金規則、全是切削規則,或兩者都有。與 validate.py 的 _advisory_label 逐字同步。
export function advisoryLabel(advisories) {
  const kinds = new Set((advisories || []).map((a) => String(a?.rule || "").split(".")[0]));
  if (kinds.size === 1 && kinds.has("sheet")) return "鈑金可製造性(建議)";
  if (kinds.size === 1 && kinds.has("cnc")) return "切削可製造性(建議)";
  return "可製造性(建議)";
}

export async function runValidateDesign(session, name, { signal } = {}) {
  const t0 = Date.now();
  const nn = sanitizeName(name);
  // 先查 per-name 槽(派工並行 build 後各自可驗),再退回單槽(同名才算;失敗 build 的
  // null 槽也走這條,滑桿重生 buildOrRollback 還原的 lastBuildMeta 因此仍可用)。
  const meta =
    session.buildMeta?.[nn] ?? (session.lastBuildMeta?.name === nn ? session.lastBuildMeta : null);
  if (meta && meta.name === nn) {
    const checks = designChecksFromMeta(meta);
    // sidecar 的權威 parts → asm manifest(拆件匯出/type badge 依賴;與 runValidate 同義務)
    try {
      writeAsmManifest(session, name, { partCount: meta.partCount, parts: meta.parts });
    } catch {
      // manifest 寫失敗不影響(type 有 lastPartCount fallback)
    }
    // 與 runValidate 同式:skipped 視為通過(空洞綠 ≠ verified,stamp 另管),
    // 但 MOTION 宣告無效那列是真 fail → overall false,agent 自修才會啟動。
    const ok = checks.every((c) => c.skipped || c.ok);
    session._lastValidate = { name: sanitizeName(name), full: false, ok };
    return {
      ok,
      checks,
      motion: meta.motion || null,
      partCount: meta.partCount,
      parts: meta.parts,
      ms: Date.now() - t0,
      design: true,
    };
  }
  return runValidate(session, name, { signal, motionOnly: true });
}

// version 事件的驗證戳記。verified = 當前頂層幾何「跑過 full 驗證且全過」**且驗的
// 就是這個產生器**(_lastValidate 綁 name:agent 對別的 part 直接 cad_present 換名
// 呈現時,不得繼承前一件的 full-ok——否則未驗證幾何出生即 verified、直通匯出閘
// memo)。open-project/revert 永遠 full、一般產圖走快路徑不驗——只有 server 知道
// 真相,所以 stamp 在這裡發,不在前端推。
export function versionStamp(session, name) {
  const lv = session._lastValidate;
  return {
    verified: !!(lv && lv.full && lv.ok && lv.name === sanitizeName(name)),
  };
}

// 快照版完整驗證(匯出閘用):對 versions/<ver>/ 凍結快照的產生器跑 validate.py
// (full)。刻意不動頂層狀態(_lastValidate / asm manifest)——快照是歷史,驗它
// 不改變工作基準的判定;也不跑 inspect(bbox/faces 對「放不放行出檔」無決策價值,
// 省一支 spawn)。overall 判定與 runValidate 同式:every(skipped || ok)。
export async function validateSnapshotFull(session, ver, name, { signal } = {}) {
  const t0 = Date.now();
  const pyTarget = `${session.workdirRel}/versions/${ver}/${sanitizeName(name)}.py`;
  const r = await spawnPython(VALIDATE_PY, [pyTarget], { session, signal });
  const checks = [];
  let partCount = 0;
  try {
    const parsed = JSON.parse(r.stdout.trim().split("\n").pop());
    if (Array.isArray(parsed.checks)) checks.push(...parsed.checks);
    partCount = Number(parsed.partCount) || 0;
    if (parsed.error) {
      checks.push({ id: "generator", label: "產生器執行", ok: false, note: parsed.error });
    }
  } catch {
    checks.push({
      id: "generator",
      label: "幾何檢查",
      ok: false,
      note: r.stderr.slice(-200) || "validate.py 無輸出",
    });
  }
  const overall = fullValidationOk(checks);
  return { ok: overall, checks, partCount, ms: Date.now() - t0 };
}

// 讀產生器 PARAMS 現值(全部鍵,不做滑桿範圍啟發式、不濾 0/負值——對照下方
// paramDefsFromGenerator 會濾)。regen 回滾後把前端滑桿值拉回磁碟真相用。
// 無檔/無 PARAMS 區塊 → null。
export function paramValuesFromGenerator(session, name) {
  let src;
  try {
    src = fs.readFileSync(genPyPath(session, name), "utf8");
  } catch {
    return null;
  }
  const m = src.match(/PARAMS\s*=\s*\{([^{}]*)\}/);
  if (!m) return null;
  const values = {};
  const entry = /["']([^"']+)["']\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let e;
  while ((e = entry.exec(m[1])) !== null) values[e[1]] = Number(e[2]);
  return values;
}

// 產生器可選宣告的固定滑桿範圍(單層 dict,值為 [min, max, step] 或
// (min, max, step)):`PARAM_RANGES = {"length": [260, 2000, 5], ...}`。
// 有宣告的鍵用「固定範圍」,不受當前值影響——範本要能大幅調參(不被啟發式
// 的「當前值×2.5」上限困住)就靠這個。未宣告的鍵仍走啟發式 fallback。
export function paramRangesFromGenerator(session, name) {
  let src;
  try {
    src = fs.readFileSync(genPyPath(session, name), "utf8");
  } catch {
    return {};
  }
  const m = src.match(/PARAM_RANGES\s*=\s*\{([^{}]*)\}/);
  if (!m) return {};
  const ranges = {};
  const num = "-?\\d+(?:\\.\\d+)?";
  const entry = new RegExp(
    `["']([^"']+)["']\\s*:\\s*[\\[(]\\s*(${num})\\s*,\\s*(${num})\\s*,\\s*(${num})\\s*[\\])]`,
    "g",
  );
  let e;
  while ((e = entry.exec(m[1])) !== null) {
    const min = Number(e[2]);
    const max = Number(e[3]);
    const step = Number(e[4]);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min && step > 0) {
      ranges[e[1]] = { min, max, step };
    }
  }
  return ranges;
}

// 選主產生器:指定 > 唯一 .py > 有同名 .asm.json > 檔案最大。回 stem|null。
// (open-project 與工作台範本掃描共用;讀不到目錄 → null,呼叫端當「不是專案」。)
export function pickGenerator(dir, requested) {
  let pys;
  try {
    pys = fs.readdirSync(dir).filter((f) => f.endsWith(".py"));
  } catch {
    return null;
  }
  if (!pys.length) return null;
  if (requested) {
    const want = `${sanitizeName(requested)}.py`;
    if (pys.includes(want)) return want.slice(0, -3);
  }
  if (pys.length === 1) return pys[0].slice(0, -3);
  const withManifest = pys.find((f) => fs.existsSync(path.join(dir, `${f.slice(0, -3)}.asm.json`)));
  if (withManifest) return withManifest.slice(0, -3);
  const largest = pys
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  return largest.f.slice(0, -3);
}

// 產生器可選宣告的「**JSON 相容 dict 區塊**」(TEMPLATE_META 範本中繼 /
// CABLE_SPEC 電纜結構規格 / PARAM_LABELS 欄位中文標籤)。文法(寫進範本 docstring):
//   KEY = { …JSON… }      單行,或
//   KEY = {               多行,**收尾的 `}` 必須頂到第 0 欄**
//     "family": "cable",
//   }
// 刻意用 JSON.parse 而非手刻 regex:PARAM_RANGES 那支只吃數值三元組,而這些宣告含
// 中文字串、巢狀陣列、括號與逗號,regex 切 key/value 必誤切。JSON 相容的代價是
// **不得出現 Python 的 True/False/None**(布林用 1/0、「不覆寫」用 0)——Python 端
// 照樣是合法 dict 字面量,兩邊讀同一份、零複本。
// 解析不到/壞掉 → null(該範本不列進工作台清單,不是壞 build,絕不 throw)。
export function readFlatJsonDecl(session, name, key = "TEMPLATE_META") {
  let src;
  try {
    src = fs.readFileSync(genPyPath(session, name), "utf8");
  } catch {
    return null;
  }
  // 先試單行,再試「多行 + 第 0 欄收尾 }」(非貪婪,取第一個頂欄 })
  const m =
    src.match(new RegExp(`^${key}\\s*=\\s*(\\{.*\\})[ \\t]*$`, "m")) ||
    src.match(new RegExp(`^${key}\\s*=\\s*(\\{[\\s\\S]*?^\\})[ \\t]*$`, "m"));
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function readCableSpec(session, name) {
  return readFlatJsonDecl(session, name, "CABLE_SPEC");
}

export function readTemplateMeta(session, name) {
  return readFlatJsonDecl(session, name, "TEMPLATE_META");
}

export function readParamLabels(session, name) {
  return readFlatJsonDecl(session, name, "PARAM_LABELS");
}

// 從產生器的 PARAMS dict 解析滑桿定義(決定性 fallback:agent 沒呼叫 emit_params
// 時仍要有滑桿可拉)。範圍優先讀 PARAM_RANGES(固定),否則用啟發式:整數小值
// 當顆數(step 1),其餘 0.4x~2.5x。
export function paramDefsFromGenerator(session, name) {
  let src;
  try {
    src = fs.readFileSync(genPyPath(session, name), "utf8");
  } catch {
    return [];
  }
  const m = src.match(/PARAMS\s*=\s*\{([^{}]*)\}/);
  if (!m) return [];
  const ranges = paramRangesFromGenerator(session, name);
  const defs = [];
  const entry = /["']([^"']+)["']\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let e;
  while ((e = entry.exec(m[1])) !== null) {
    const key = e[1];
    const value = Number(e[2]);
    // 0 或負值無法推範圍(會算出 min>max 的壞滑桿),留給 agent 的 emit_params。
    // (folded 已不再是 PARAMS 參數——攤平改由 3D 視圖即時切換鈕,見 flat_glb/gen_flat。)
    // 例外:有 PARAM_RANGES 明宣告的鍵放行(值可為 0/負,範圍不靠值推)。
    if ((!Number.isFinite(value) || value <= 0) && !ranges[key]) continue;
    const isInt = Number.isInteger(value) && value > 0 && value <= 20 && !e[2].includes(".");
    let def;
    if (ranges[key]) {
      // 固定範圍(範本專用):min/max/step 由產生器宣告,與當前值無關。
      const r = ranges[key];
      def = { key, label: key, min: r.min, max: r.max, step: r.step, value };
      if (isInt) def.int = true;
      else def.unit = "mm";
    } else if (isInt) {
      // int:true → NumberField 鎖整數(唯一判準;step==1 的 mm 參數不得掛)
      def = { key, label: key, min: 1, max: Math.max(value * 3, 12), step: 1, value, int: true };
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
  // .flat.step.glb + .flat.lines.json:鈑金攤平預覽 GLB 與折彎線 overlay,切舊版也要能
  // 切攤平/看折彎線 → 一併進快照(存在才複)。.sweep.json:掃出路徑預覽折線,
  // 同理跟版凍結(切舊版 overlay 要對舊幾何)。
  // .step.meta.json / .build.json / .validate.json:build 收割、建置憑證、驗證快取——回退到
  // 這一版時,輸入與環境沒變就能直接沿用這些產物,不必重建重驗(見檔頭「建置憑證」)。
  for (const f of [`${n}.py`, `${n}.step`, `.${n}.step.glb`, `.${n}.flat.step.glb`, `.${n}.flat.lines.json`, `.${n}.sweep.json`, `${n}.asm.json`, `.${n}.step.js`, `.${n}.step.meta.json`, `.${n}.build.json`, `.${n}.validate.json`]) {
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
export function pruneSnapshots(session, keep) {
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
// 鈑金件偵測:產生器頂層有 gen_dxf()(展開圖)才亮 DXF 匯出鈕/badge。regex 與
// cadpy metadata.py 的 AST 語意對齊(^def 錨定,縮排的內層 def 不算);決定性、
// 零 spawn,同 project.mjs 的 GEN_DXF_RE(匯出端點是第二道防線)。
export function generatorHasDxf(session, name) {
  try {
    return /^def\s+gen_dxf\s*\(/m.test(fs.readFileSync(genPyPath(session, name), "utf8"));
  } catch {
    return false;
  }
}

// 攤平預覽偵測:產生器頂層有 gen_flat()(回 flat 實體)才產攤平 GLB / 亮切換鈕。
// 只命中「獨立鈑金件」——組合件(如 sheet_stepper_mount)有 gen_dxf 但無 gen_flat
// (攤平組合件無意義),故用 gen_flat 而非 SheetMetal/gen_dxf 偵測。
export function generatorHasFlat(session, name) {
  try {
    return /^def\s+gen_flat\s*\(/m.test(fs.readFileSync(genPyPath(session, name), "utf8"));
  } catch {
    return false;
  }
}

export function emitPresent(session, name, emit) {
  session.version += 1;
  session.lastName = name;
  session._geomDirty = false; // 頂層基準已凍成本版快照(runStep 開跑時設 true)
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
  const gUrl = `${BASE_PATH}/api/asset?file=${encodeURIComponent(fileRel)}&v=${session.version}`;
  const ghost =
    (name || "PART").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "PART";
  const hasDxf = generatorHasDxf(session, name);
  const formats = hasDxf ? ["STEP", "GLB", "DXF"] : ["STEP", "GLB"];
  // 攤平預覽 GLB + 折彎線 sidecar 的本版快照 URL(產生器有 gen_flat 且檔案真的凍進
  // 快照才給)——前端據此顯示「摺疊/攤平」切換鈕與攤平態折彎虛線。快照失敗退頂層。
  let flatGlbUrl = null;
  let flatLinesUrl = null;
  const nn = sanitizeName(name);
  const snapPre = snapshotOk ? `versions/v${session.version}/` : "";
  const assetUrl = (rel) =>
    `${BASE_PATH}/api/asset?file=${encodeURIComponent(`${session.workdirRel}/${rel}`)}&v=${session.version}`;
  if (generatorHasFlat(session, name)) {
    const glbRelP = `${snapPre}.${nn}.flat.step.glb`;
    const linesRelP = `${snapPre}.${nn}.flat.lines.json`;
    if (fs.existsSync(path.join(session.workdir, glbRelP))) flatGlbUrl = assetUrl(glbRelP);
    if (fs.existsSync(path.join(session.workdir, linesRelP))) flatLinesUrl = assetUrl(linesRelP);
  }
  // 掃出路徑預覽 sidecar 的本版快照 URL(檔案真的凍進快照才給;無 generatorHas 閘
  // ——sidecar 存在本身就是閘)。前端據此疊路徑中心虛線 overlay。
  let sweepPathsUrl = null;
  {
    const sweepRelP = `${snapPre}.${nn}.sweep.json`;
    if (fs.existsSync(path.join(session.workdir, sweepRelP))) sweepPathsUrl = assetUrl(sweepRelP);
  }
  emit("artifact", {
    ver, name, code: name, ghost, formats,
    type, partCount, source: "generated",
  });
  const stamp = versionStamp(session, name);
  // 匯出閘的快照驗證 memo:full 驗證下產生的版本(開專案/回退)出生即已驗,
  // 出檔時免重驗。in-memory(與 _lastValidate 同壽命);重啟後首次匯出重驗一次即補登。
  if (stamp.verified && snapshotOk) (session._verifiedVers ||= new Set()).add(ver);
  emit("version", {
    id: ver,
    name,
    file: fileRel,
    glbUrl: gUrl,
    formats,
    type,
    partCount,
    source: "generated",
    snapshot: snapshotOk, // false = 本版無凍結快照(退回頂層檔,無法回退)
    hasDxf, // 鈑金件(產生器有 gen_dxf)→ 前端亮「⤓ DXF 展開圖」鈕
    flatGlbUrl, // 鈑金件(有 gen_flat)→ 前端「摺疊/攤平」即時切換(null=無)
    flatLinesUrl, // 折彎線 sidecar → 攤平態疊虛線 overlay(null=無)
    sweepPathsUrl, // 掃出路徑 sidecar → 3D 視圖路徑中心虛線 overlay(null=無)
    delta: versionDeltaText(session, name, session.version), // 與上一版的差異摘要(""=無可比)
    ...stamp, // verified(前端 badge / 匯出閘依賴)
  });
  emit("present", { ver, name, code: name, file: stepRel, glbUrl: gUrl, type, flatGlbUrl, flatLinesUrl, sweepPathsUrl });
  persistSession(session); // version/lastName 剛變動 → 落盤(重整/重啟後計數不歸零)
  return { ver, glbUrl: gUrl };
}

// ---------------------------------------------------------------------------
// 看圖(藍圖 E1):把目前的產生器離屏畫成 PNG,給 agent 自己看。render_view.py 開 OpenGL 環境,
// 一律在一次性行程裡跑(顯示卡驅動出事時不拖垮常駐 worker;不在 python.mjs 的 worker 白名單內)。
// 圖存在 session 的 .snapshots/(不進專案儲存、不進版本快照),只留最近的幾張。
// ---------------------------------------------------------------------------
export const SNAPSHOT_VIEWS = ["iso", "iso_back", "front", "back", "right", "left", "top", "bottom"];
const SNAPSHOT_MAX_VIEWS = 4;
const SNAPSHOT_KEEP_FILES = 16;

export function snapshotArgs(session, name, stem, { views, hide, ghost, clip, pose, mode } = {}) {
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);
  const wanted = list(views).slice(0, SNAPSHOT_MAX_VIEWS);
  const args = [
    relTarget(session, name, ".py"),
    `${session.workdirRel}/.snapshots`,
    "--views", (wanted.length ? wanted : ["iso"]).join(","),
    "--stem", stem,
    "--mode", mode === "wire" ? "wire" : "shaded",
  ];
  if (list(hide).length) args.push("--hide", list(hide).join(","));
  if (list(ghost).length) args.push("--ghost", list(ghost).join(","));
  if (clip && ["x", "y", "z"].includes(String(clip.axis).toLowerCase()) && Number.isFinite(Number(clip.at))) {
    args.push("--clip", `${String(clip.axis).toLowerCase()}:${Number(clip.at)}`);
  }
  if (pose && String(pose).trim()) args.push("--pose", String(pose).trim());
  return args;
}

// 回 { ok, views: [{ view, file(相對 DATA_ROOT), png(Buffer) }], legend, pose, ms } 或 { ok:false, error, ms }。
export async function runSnapshot(session, name, options = {}) {
  const t0 = Date.now();
  const stem = `${sanitizeName(name)}_${t0.toString(36)}`;
  const dir = path.join(session.workdir, ".snapshots");
  const res = await spawnPython(RENDER_PY, snapshotArgs(session, name, stem, options), { session, signal: options.signal });
  let parsed = null;
  try {
    parsed = JSON.parse(String(res.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop());
  } catch {
    parsed = null;
  }
  if (!parsed?.ok) {
    return {
      ok: false,
      error: parsed?.error || condenseSnapshotError(res.stderr) || "看圖失敗(渲染行程沒有回應)",
      ms: Date.now() - t0,
    };
  }
  const views = [];
  for (const v of parsed.views || []) {
    const base = path.basename(String(v.file || "").replace(/\\/g, "/"));
    try {
      views.push({ view: String(v.view), file: `${session.workdirRel}/.snapshots/${base}`, png: fs.readFileSync(path.join(dir, base)) });
    } catch {
      // 檔案讀不到:當作這一張沒畫出來
    }
  }
  pruneSnapshotFiles(dir, SNAPSHOT_KEEP_FILES);
  if (!views.length) return { ok: false, error: "看圖失敗(沒有產出圖檔)", ms: Date.now() - t0 };
  return { ok: true, views, legend: parsed.legend || [], pose: parsed.pose || null, ms: Date.now() - t0 };
}

function condenseSnapshotError(stderr) {
  const lines = String(stderr || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? scrubPaths(lines[lines.length - 1]).slice(0, 240) : "";
}

function pruneSnapshotFiles(dir, keep) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) rmQuiet(path.join(dir, f));
  } catch {
    // 目錄不存在或讀不到:沒有東西可清
  }
}

// motion 事件(SSE 與 JSON 路徑共用一個形狀):dofs 之外,具名姿態與動作序列有宣告才帶。
// 空 dofs = 清除舊宣告(重生成靜態件後播放鈕不殘留)。
export function motionEvent(name, motion) {
  const hasKeys = (v) => v && typeof v === "object" && Object.keys(v).length > 0;
  return {
    name,
    schemaVersion: 1,
    dofs: motion?.dofs || [],
    ...(hasKeys(motion?.states) ? { states: motion.states } : {}),
    ...(hasKeys(motion?.sequences) ? { sequences: motion.sequences } : {}),
  };
}

// 送到前端的一列檢查(decorateChecks 之後):圖示、顏色、備註、狀態,以及這一列的具體發現。
// findings 來自 cadpy.findings(validate.py 每列最多 20 筆,嚴重的在前);前端只顯示前幾筆,
// 這裡再截到 8 筆並附總數,避免大型組合件把事件撐大。
const FINDINGS_PER_ROW = 8;
export function checkView(c) {
  const findings = Array.isArray(c.findings) ? c.findings : [];
  return {
    label: c.label,
    icon: c.icon,
    color: c.color,
    note: c.noteText,
    skipped: !!c.skipped,
    status: c.status,
    ...(findings.length
      ? { findings: findings.slice(0, FINDINGS_PER_ROW), findingCount: findings.length }
      : {}),
  };
}

// 把 validate.py 的 {id,ok,skipped,note} 映射成前端 ValidateCard 需要的 icon/color。
// 每列一律帶 status(見 checkStatus)。not_checked 用問號 + 琥珀色:它不是通過,也不是
// 「這項不需要」,不能跟 not_applicable 的灰色橫線長得一樣。
export function decorateChecks(checks) {
  return checks.map((c) => {
    const status = checkStatus(c);
    if (status === "not_applicable") return { ...c, status, icon: "–", color: "#a3acba", noteText: c.note || "不適用" };
    if (status === "not_checked") return { ...c, status, icon: "?", color: "#c98a1b", noteText: c.note || "未量測" };
    // advisory:建議列(鈑金可製造性)。不是通過也不是失敗,不擋匯出;驚嘆號 + 琥珀色
    if (status === "advisory") return { ...c, status, icon: "!", color: "#c98a1b", noteText: c.note || "有建議" };
    return status === "ok"
      ? { ...c, status, icon: "✓", color: "#34ab86", noteText: c.note || "PASS" }
      : { ...c, status, icon: "✗", color: "#d64848", noteText: c.note || "FAIL" };
  });
}
