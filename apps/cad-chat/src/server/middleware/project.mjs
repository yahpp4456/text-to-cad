// 專案生命周期(免 LLM 直接操作,回 JSON):
//   POST /api/import        {sessionId?, file}     — 複製 models/ 下 STEP 進 session imported/
//   POST /api/open-project  {dir, generator?, mode?, params?} — 開既有專案:複製樹到新
//                            session(mode 隨模式 mint)+ 可選參數覆寫 + 重建
//   POST /api/save-project  {sessionId, name, overwrite?} — session 產物存成 models/<name>/
//   POST /api/revert-version {sessionId, ver}             — 回退到 vK 快照(產生新版=vK 複本)
//   POST /api/export        {sessionId, ver?, format}     — 快照/頂層 STEP → STL/3MF(免 LLM;
//                            內建匯出閘:未驗證先自動完整驗證,未過擋下)
//   POST /api/validate-ver  {sessionId, ver?}              — 匯出閘單獨入口(STEP 直下載把關用)
// 與 agent 的 cad_import 工具收斂到同一份 pipeline.importStepIntoSession。
// save ↔ open-project 互為讀寫方向:存出去的專案可再開回來續改。
import fs from "node:fs";
import path from "node:path";

import { MODELS_ROOT } from "../config.mjs";
import { isDesignLike } from "../../lib/chatModes.js";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { pathIsInside, resolveInside, resolveModelRead } from "../cad/paths.mjs";
import { copyProjectTree, validateProjectDir, writeProjectTreeAtomic } from "../cad/projectTree.mjs";
import { CASE_FILE, buildCaseMeta, readCaseMeta } from "../cad/templates.mjs";
import {
  acquireBusy,
  getOrCreateSession,
  persistSession,
  probeSessionOnDisk,
  releaseBusy,
} from "../sessions.mjs";
import { condenseTraceback, scrubPaths, spawnPython } from "../cad/python.mjs";
import {
  decorateChecks,
  emitPresent,
  importStepIntoSession,
  inspectFacts,
  paramDefsFromGenerator,
  paramRangesFromGenerator,
  paramValuesFromGenerator,
  pickGenerator,
  readCableSpec,
  readTemplateMeta,
  resolveImportSource,
  rewriteParams,
  rewriteSpec,
  runStep,
  runValidate,
  sanitizeName,
  validateSnapshotFull,
} from "../cad/pipeline.mjs";
import { emitSketchPresent, sketchFileName } from "../sketch/present.mjs";

const REBUILD_TIMEOUT_MS = 300_000; // 開專案同步重建上限(大組合件 tessellation 較久)
const FACTS_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 120_000; // 「精算此版」完整驗證含運動掃掠(75s 閘)+ 餘裕

async function handleImport(body, res, ctx = {}) {
  // 先驗來源檔再取 session:getOrCreateSession 會 mint 目錄,壞檔的失敗請求
  // 不該留下空 session(還會讓 session-info 對死 id 誤回 exists:true)。
  const src = resolveImportSource(body?.file, { modelsRoot: ctx.modelsRoot });
  if (!src.ok) {
    sendJson(res, 200, { ok: false, error: src.error });
    return;
  }
  const session = getOrCreateSession(body?.sessionId, { user: ctx.user }); // 無 sessionId 就開新的(回給前端採用)
  // 刻意的單向互斥:匯入會被進行中的 turn 擋(409),但不 acquireBusy——
  // inspectFacts 最長 30s,持鎖會讓聊天訊息在匯入期間 409。代價:turn 在 facts
  // 窗口內開始且被 interrupt 時,killTree 會連匯入的 inspect 子程序一起殺,
  // sizeMm 靜默變 null(prefill 缺 bbox),匯入本身仍成功。
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  if (rejectNonDesignSession(session, res, "匯入 STEP")) return;
  const imp = importStepIntoSession(session, body?.file);
  if (!imp.ok) {
    sendJson(res, 200, { ok: false, error: imp.error });
    return;
  }
  if (!session.imports.includes(imp.rel)) session.imports.push(imp.rel);
  persistSession(session);
  // bbox 摘要(給 prefill 訊息;逾時就省略,不擋匯入)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FACTS_TIMEOUT_MS);
  const facts = await inspectFacts(session, imp.rel, { signal: ac.signal });
  clearTimeout(timer);
  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    rel: imp.rel,
    label: imp.label,
    reused: !!imp.reused,
    sizeMm: facts?.size || null,
  });
}

// 開專案時的 session mode 裁定(純函數,L1 可測)。session.mode 是出生恆定屬性,
// mint 時不帶就永遠是 design——前端停在 cable 段一鍵開專案後,下一次 /api/chat
// (含滑桿 paramsOnly)必回 400 mode_mismatch(實測過的死路)。
//   ① body.mode 是設計鏈模式(design/cable)→ 採納(使用者在哪個模式按開啟就是哪個);
//   ② 否則看範本家族(TEMPLATE_META.family;Phase 1 起有值)——cable 範本從
//      sketch/library 模式開也該是 cable session;
//   ③ 再不然 design。
// **刻意不回 400**:sketch/library 模式下用 FileBrowser 一鍵開專案是既有動線,
// 擋掉是回歸;非設計鏈的 body.mode 一律忽略而非拒絕。
export function resolveOpenMode(body, { family } = {}) {
  const req = body?.mode;
  if (isDesignLike(req)) return req;
  if (isDesignLike(family)) return family;
  return "design";
}

// 開專案時附帶的參數覆寫檢查(純函數,L1 可測)。規格表單「直接生成」把值一次帶進
// open-project,build 前先擋掉壞值:鍵必須是產生器 PARAMS 既有鍵(免打錯字靜默無效)、
// 值必須是有限數、且落在產生器宣告的 PARAM_RANGES 內(未宣告的鍵不設限——跨參數耦合
// 約束仍由 _check_params 在 build 時把關並回報下限)。
// 回 {ok:true, values|null} 或 {ok:false, error}。
export function validateOpenParams(params, current, ranges = {}) {
  if (params === undefined || params === null) return { ok: true, values: null };
  if (typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "params 必須是 {鍵: 數值} 物件" };
  }
  const keys = Object.keys(params);
  if (!keys.length) return { ok: true, values: null };
  if (!current || !Object.keys(current).length) {
    return { ok: false, error: "此專案的產生器沒有可覆寫的 PARAMS 區塊" };
  }
  const values = {};
  for (const k of keys) {
    const n = Number(params[k]);
    if (!Number.isFinite(n)) return { ok: false, error: `參數 ${k} 必須是數值` };
    if (!(k in current)) {
      return { ok: false, error: `產生器沒有參數 ${k}(可用:${Object.keys(current).join("、")})` };
    }
    const r = ranges?.[k];
    if (r && (n < r.min || n > r.max)) {
      return { ok: false, error: `參數 ${k}=${n} 超出範圍 ${r.min}–${r.max}` };
    }
    values[k] = n;
  }
  return { ok: true, values };
}

// 開專案時要不要把 session 綁到來源目錄(純函數,L1 可測)。不綁的情況:
//   ① 範本(TEMPLATE_META 且無 case.json;案件的 .py 也帶 TEMPLATE_META,只看它不夠):
//      CableShelf「開啟」範本後拉一次滑桿 + Ctrl+S 會把 tracked 範本的預設值改壞;
//   ② 帶參數/規格開(「填規格→直接生成」「複製成新案」):來源是範本或別人的案件,
//      綁了就是蓋回來源;等另存後才綁到新名;
//   ③ 來源不在本人可寫層(per-user 從 fixtures 層開):就地儲存會寫到另一個實體目錄,
//      chip 說的與磁碟不同;要 fork 走另存,綁定才誠實(dev 兩根同一,不受此限)。
export function shouldBindOnOpen({ isTemplate, hasParams, hasSpec, inWritableRoot }) {
  if (isTemplate) return false;
  if (hasParams || hasSpec) return false;
  if (!inWritableRoot) return false;
  return true;
}

// 結構改動(層數/帶型)時的 PARAMS 鍵集與滑桿範圍。層數 N 決定 L1..LN——舊的
// L 鍵要消失(整塊替換,見 rewriteSpec),新的要有固定範圍,head_h 下限跟著層數走。
export function paramShapeForSpec(spec, srcValues, srcRanges) {
  const n = Number(spec?.layers) || 0;
  const keys = {};
  for (let i = 1; i <= n; i++) keys[`L${i}`] = srcValues?.[`L${i}`] ?? 0;
  for (const [k, v] of Object.entries(srcValues || {})) if (!/^L\d+$/.test(k)) keys[k] = v;
  const lTpl =
    Object.entries(srcRanges || {}).find(([k]) => /^L\d+$/.test(k))?.[1] || { min: 200, max: 3000, step: 5 };
  const ranges = {};
  for (let i = 1; i <= n; i++) ranges[`L${i}`] = srcRanges?.[`L${i}`] || lTpl;
  for (const [k, v] of Object.entries(srcRanges || {})) if (!/^L\d+$/.test(k)) ranges[k] = v;
  if (ranges.head_h) {
    const mh = Number(spec?.measured?.module_h) || 11.5;
    ranges.head_h = { ...ranges.head_h, min: Math.round(n * mh * 10) / 10 };
  }
  return { keys, ranges };
}

async function handleOpenProject(body, res, ctx = {}) {
  const clean = String(body?.dir || "")
    .replace(/\\/g, "/")
    .replace(/^models\//, "");
  let srcAbs;
  try {
    srcAbs = resolveModelRead(clean, { modelsRoot: ctx.modelsRoot }); // 讀取:雙根(user 層優先、fixtures fallback)
  } catch {
    sendJson(res, 403, { ok: false, error: "路徑超出 models/" });
    return;
  }
  if (!clean || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) {
    sendJson(res, 404, { ok: false, error: "目錄不存在" });
    return;
  }

  // 參數覆寫先對「來源」產生器驗(mint 之前):壞請求不得在磁碟留下空 session 目錄
  // (session-info 之後會誤回 exists:true)。paramValues/RangesFromGenerator 只讀
  // session.workdir → 直接餵來源目錄即可。
  const srcName = pickGenerator(srcAbs, body?.generator);
  const srcRef = { workdir: srcAbs };
  const srcValues = srcName ? paramValuesFromGenerator(srcRef, srcName) : null;
  const srcRanges = srcName ? paramRangesFromGenerator(srcRef, srcName) : {};
  // 結構改動(規格表單改層數/帶型):鍵集與範圍由新 spec 決定,不是來源 .py 的舊鍵
  const wantSpec = body?.spec && typeof body.spec === "object" ? body.spec : null;
  const shape = wantSpec ? paramShapeForSpec(wantSpec, srcValues, srcRanges) : null;
  const pchk = validateOpenParams(
    body?.params,
    shape ? shape.keys : srcValues,
    shape ? shape.ranges : srcRanges,
  );
  if (!pchk.ok) {
    sendJson(res, 400, { ok: false, error: pchk.error });
    return;
  }
  if (wantSpec && !(srcName && readCableSpec(srcRef, srcName))) {
    sendJson(res, 400, { ok: false, error: "此範本沒有 CABLE_SPEC,不能改結構" });
    return;
  }

  // 開新 session(不原地續用:舊 workdir 是歷史快照,兩個 session 同目錄會互踩)
  const session = getOrCreateSession(null, {
    user: ctx.user,
    mode: resolveOpenMode(body, {
      family: srcName ? readTemplateMeta(srcRef, srcName)?.family : null,
    }),
  });
  copyProjectTree(srcAbs, session.workdir);

  const name = pickGenerator(session.workdir, body?.generator);
  if (!name) {
    sendJson(res, 200, {
      ok: false,
      sessionId: session.sessionId,
      mode: session.mode,
      error: "目錄裡沒有產生器 .py(純檔案請用「開啟」看圖)",
    });
    return;
  }
  session.lastName = name;
  session.rehydratedFrom = clean;
  persistSession(session);
  // 參數覆寫(規格表單「直接生成」):在 runStep 之前決定性改寫 PARAMS,一次 build
  // 就得到使用者要的配置(免「先建範本預設值、再重生一次」雙倍等待)。值已於 mint
  // 前驗過(validateOpenParams);跨參數耦合違規由 _check_params 在 build 時擋,錯誤
  // 走下方 !step.ok 分支帶人話訊息回前端(session 保留,可改值重來或用對話修)。
  let appliedValues = null;
  if (wantSpec) {
    // 結構重生:CABLE_SPEC + PARAMS(整塊替換,縮層不留幽靈鍵)+ PARAM_RANGES 一起改寫
    const rw = rewriteSpec(session, name, {
      spec: wantSpec,
      params: pchk.values || shape.keys,
      ranges: shape.ranges,
    });
    if (!rw.ok) {
      sendJson(res, 200, {
        ok: false,
        sessionId: session.sessionId,
        name,
        mode: session.mode,
        error: `套用結構失敗:${rw.error}`,
      });
      return;
    }
    appliedValues = paramValuesFromGenerator(session, name);
  } else if (pchk.values) {
    const rw = rewriteParams(session, name, pchk.values);
    if (!rw.ok) {
      sendJson(res, 200, {
        ok: false,
        sessionId: session.sessionId,
        name,
        mode: session.mode,
        error: `套用參數失敗:${rw.error}`,
      });
      return;
    }
    appliedValues = paramValuesFromGenerator(session, name);
  }
  // rehydrate 後首個 agent turn 的一次性接續提示(chat.mjs 取用後清空)
  session._rehydrateNote =
    `（本對話接續既有專案 ${name}(來源 models/${clean})。產生器已在 ${session.workdirAbs}/${name}.py,` +
    `修改前先 Read 它,沿用其 PARAMS/INTENDED_CONTACT/MOTION 結構,用 cad_build(edits) 精修。` +
    (appliedValues
      ? `本專案由規格表單建立,PARAMS 現值 = ${JSON.stringify(appliedValues)}——以產生器內現值為準,不要沿用範本預設。`
      : "") +
    `）`;

  // 同步重建:防 cadpy 版本漂移的舊 GLB,並重寫 manifest / 取回 motion
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REBUILD_TIMEOUT_MS);
  let step;
  let val = null;
  try {
    step = await runStep(session, name, { signal: ac.signal });
    if (step.ok) {
      val = await runValidate(session, name, { signal: ac.signal });
      if (val.partCount > 0) session.lastPartCount = val.partCount;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!step.ok) {
    sendJson(res, 200, {
      ok: false,
      sessionId: session.sessionId,
      name,
      mode: session.mode,
      // 參數覆寫路徑的失敗多半是 _check_params 的人話下限(如「L2 至少 872」)——
      // 前端規格表單據此標紅欄位,所以訊息要原樣帶回,不要包成一句「重建失敗」。
      error: `重建失敗:${condenseTraceback(step.stderr, { generatorName: name }) || `exit ${step.exitCode}`}(session 已保留,可改值重來或用對話修復)`,
    });
    return;
  }

  // 收集 emitPresent 的三事件讓前端 dispatch(無 SSE 通道,JSON 帶回)
  const events = [];
  emitPresent(session, name, (ev, data) => events.push([ev, data]));
  const version = events.find(([e]) => e === "version")?.[1] || null;
  const present = events.find(([e]) => e === "present")?.[1] || null;

  // 專案綁定(「儲存」就地覆寫的目標):重建成功、v1 已出之後才綁——所有 ok:false 早退
  // 都不綁,綁到壞產生器等於讓 Ctrl+S 蓋掉好目錄。規則見 shouldBindOnOpen。
  const isTemplate = !!(srcName && readTemplateMeta(srcRef, srcName)) && !readCaseMeta(srcAbs);
  const bindable =
    shouldBindOnOpen({
      isTemplate,
      hasParams: !!pchk.values,
      hasSpec: !!wantSpec,
      inWritableRoot: pathIsInside(srcAbs, session.modelsRoot || MODELS_ROOT),
    }) && validateProjectDir(clean);
  session.project = bindable ? { dir: clean, ver: session.version, origin: "opened" } : null;
  persistSession(session); // emitPresent 已 persist 過一次,但那時 project 還沒設

  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    // session 的真實 mode:前端據此 SET_MODE 校正切換器(不校正 → 下一次 /api/chat
    // 含滑桿 paramsOnly 必回 400 mode_mismatch)。
    mode: session.mode,
    project: session.project, // 綁定(null=未綁定,只有另存);前端 SET_PROJECT
    name,
    type: version?.type || "part",
    version,
    present,
    params: paramDefsFromGenerator(session, name),
    values: paramValuesFromGenerator(session, name), // PARAMS 現值(表單回填/回聲用)
    motion: val?.motion || null,
    validateOk: val ? val.ok : null,
    warnings: presentWarnings(events),
  });
}

// 回退:把 versions/vK 快照複回 workdir 頂層(消除「看的版 vs 改的基準」分歧),
// 重建+驗證後 emitPresent 產生「新版 v{N+1} = vK 複本」——歷史線性,不竄改既有版號。
async function handleRevertVersion(body, res, ctx = {}) {
  const session = requireExistingSession(body, res, ctx);
  if (!session) return;
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const ver = String(body?.ver || "");
  if (!/^v\d+$/.test(ver)) {
    sendJson(res, 400, { ok: false, error: "版本 id 無效" });
    return;
  }
  const snapDir = path.join(session.workdir, "versions", ver);
  const metaPath = path.join(snapDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    sendJson(res, 404, { ok: false, error: `${ver} 沒有快照可回退(較舊的 session 產物)` });
    return;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    sendJson(res, 400, { ok: false, error: "快照 meta 損毀,無法回退" });
    return;
  }
  const name = sanitizeName(meta.name);
  // 草模版本:複回一個 JSON 檔 + emitSketchPresent,零 spawn(無重建/驗證可言)。
  // 全程同步無 await → 無 interrupt 窗,不需 busyToken 作廢檢查。
  if (meta.type === "sketch") {
    const busyToken = acquireBusy(session);
    try {
      const file = sketchFileName(name);
      const src = path.join(snapDir, file);
      if (!fs.existsSync(src)) {
        sendJson(res, 404, { ok: false, error: `${ver} 快照缺草模檔,無法回退` });
        return;
      }
      fs.copyFileSync(src, path.join(session.workdir, file));
      session.lastName = name;
      const events = [];
      emitSketchPresent(session, name, (ev, data) => events.push([ev, data]));
      const version = events.find(([e]) => e === "version")?.[1] || null;
      const present = events.find(([e]) => e === "present")?.[1] || null;
      sendJson(res, 200, {
        ok: true,
        from: ver,
        name,
        version,
        present,
        params: [],
        motion: null,
        validateOk: null,
        warnings: presentWarnings(events),
      });
    } finally {
      releaseBusy(session, busyToken);
    }
    return;
  }
  const busyToken = acquireBusy(session);
  try {
    // 快照複回頂層;單件版要清掉頂層殘留的 asm.json,type 才不會誤判成組合件。
    // .flat.step.glb + .flat.lines.json:攤平預覽 GLB 與折彎線也複回(回退版要能用)。
    // .sweep.json:掃出路徑 overlay 同理——快照沒有就刪頂層殘留(防 stale overlay)。
    for (const f of [`${name}.py`, `${name}.step`, `.${name}.step.glb`, `.${name}.flat.step.glb`, `.${name}.flat.lines.json`, `.${name}.sweep.json`, `${name}.asm.json`, `.${name}.step.js`]) {
      const src = path.join(snapDir, f);
      const dst = path.join(session.workdir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      else if ((f === `${name}.asm.json` || f === `.${name}.flat.step.glb` || f === `.${name}.flat.lines.json` || f === `.${name}.sweep.json`) && fs.existsSync(dst)) fs.rmSync(dst);
    }
    session.lastName = name;
    if (Number(meta.partCount) > 0) session.lastPartCount = Number(meta.partCount);

    // 同步重建+驗證(比照 open-project:防 cadpy 漂移、刷新 motion/partCount)。
    // 重建炸掉也不算全毀——頂層已是 vK 的有效產物,對話仍可修復。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REBUILD_TIMEOUT_MS);
    let step;
    let val = null;
    try {
      step = await runStep(session, name, { signal: ac.signal });
      if (step.ok) {
        val = await runValidate(session, name, { signal: ac.signal });
        if (val.partCount > 0) session.lastPartCount = val.partCount;
      }
    } finally {
      clearTimeout(timer);
    }
    if (!step.ok) {
      sendJson(res, 200, {
        ok: false,
        error: `回退重建失敗:${condenseTraceback(step.stderr, { generatorName: name }) || `exit ${step.exitCode}`}(頂層檔已還原成 ${ver},可用對話修復)`,
      });
      return;
    }
    // interrupt 在重建窗口把鎖撤走(殺了我們的 python、新 turn 可能已接手):
    // 本次回退作廢,不得再 bump 版本/凍結快照/動 session 狀態。
    if (session._busyToken !== busyToken) {
      sendJson(res, 200, { ok: false, error: "回退被中斷,未產生新版本" });
      return;
    }
    const events = [];
    emitPresent(session, name, (ev, data) => events.push([ev, data]));
    const version = events.find(([e]) => e === "version")?.[1] || null;
    const present = events.find(([e]) => e === "present")?.[1] || null;
    sendJson(res, 200, {
      ok: true,
      from: ver,
      name,
      version,
      present,
      params: paramDefsFromGenerator(session, name),
      motion: val?.motion || null,
      validateOk: val ? val.ok : null,
      warnings: presentWarnings(events), // 快照失敗等警告(SSE 路徑有 error 卡,JSON 路徑靠這裡)
    });
  } finally {
    releaseBusy(session, busyToken);
  }
}

// emitPresent 在 JSON 收集路徑(open-project / revert-version)emit 的 error 事件
// 不能默默丟掉——快照失敗(磁碟滿)時回應仍 ok:true,警告要隨回應帶給前端 notify。
function presentWarnings(events) {
  return events
    .filter(([e]) => e === "error")
    .map(([, d]) => String(d?.message || ""))
    .filter(Boolean);
}

// 免 LLM 匯出:版本快照(ver 給定)或頂層工作基準的 .step → STL/3MF。
// 輸入用既有 STEP 直接 mesh(不重跑產生器,決定性且快;同 files.mjs 開裸 STEP 的
// 呼叫形狀),輸出寫在與輸入同目錄,前端再經 /api/asset?download= 觸發下載。
const EXPORT_TIMEOUT_MS = 180_000;
const EXPORT_FLAGS = { stl: "--stl", "3mf": "--3mf" };
// 鈑金展開圖:同一 .py 定義 gen_dxf()(cadpy catalog 自動配對)。頂層 def 的決定性
// 偵測,與 cadpy metadata.py 的 AST 語意對齊(縮排的內層 def 不算)。
const GEN_DXF_RE = /^def\s+gen_dxf\s*\(/m;

// 轉檔工作區 .exports/<ver|current>/:轉檔絕不在來源目錄跑——step CLI 的 --force 會
// 重生隱藏 GLB/topology sidecar,在 versions/vK/ 裡跑等於改寫「凍結快照」(時間軸
// 縮圖與 revert 的依據);中途 timeout 被 killTree 還會留半檔。輸入 STEP 複製進來,
// 輸出也落在這裡(不進版控、不被 save-project 帶走、隨 session GC)。
function makeExportScratch(session, rawVer) {
  const key = /^v\d+$/.test(String(rawVer || "")) ? String(rawVer) : "current";
  const abs = path.join(session.workdir, ".exports", key);
  fs.mkdirSync(abs, { recursive: true });
  return { abs, rel: `${session.workdirRel}/.exports/${key}` };
}

// 取既有 session(絕不 mint):getOrCreateSession 對格式合法但已 GC/不存在的 id 會
// mkdirSync 一個全新空目錄——壞請求(stale localStorage 的死 id)不該在磁碟留垃圾,
// 空目錄還會讓 session-info 對死 id 誤回 exists:true。probeSessionOnDisk 唯讀。
// 非設計鏈 session 的顯式 400 拒絕:這些端點只對設計鏈模式有意義(草模無 STEP/
// 產生器;零件庫是收藏管理,收庫產物在 models/parts-library/ 而非 session 工作區)。
// cable(無塵電纜)是設計特化,六端點全放行(isDesignLike)。
// 不靠 resolveExportBase 的「STEP 不存在」404 兜底——顯式拒絕才誠實、才可測。
// 訊息措辭:草模保留「草模模式沒有…」逐字(smoke_sketch D 段斷言),library 對應
// 「零件庫模式沒有…」。
function rejectNonDesignSession(session, res, what) {
  if (!session?.mode || isDesignLike(session.mode)) return false;
  const label = session.mode === "sketch" ? "草模" : "零件庫";
  sendJson(res, 400, {
    ok: false,
    error: `${label}模式沒有${what}(切到「設計」模式產出真 CAD 後才可用)`,
  });
  return true;
}

function requireExistingSession(body, res, ctx = {}) {
  if (!body?.sessionId) {
    sendJson(res, 400, { ok: false, error: "缺 sessionId" });
    return null;
  }
  // probe 與 getOrCreate 必須同一 user:跨 user 的 id 在本人空間 probe-miss → 404,
  // 絕不落到 mint(否則 B 送 A 的 id 會在 B 空間長出空目錄)。
  if (!probeSessionOnDisk(body.sessionId, ctx.user).exists) {
    sendJson(res, 404, { ok: false, error: "session 不存在(可能已被清理),請重新產生模型" });
    return null;
  }
  return getOrCreateSession(body.sessionId, { user: ctx.user });
}

// 匯出端點共用:基準解析(ver 給定 → versions/<ver>/ 快照,name/kind 讀 meta.json;
// 否則頂層工作基準)+ STEP 存在檢查。失敗時已回應,回傳 null。
function resolveExportBase(session, rawVer, res) {
  let name;
  let kind;
  let baseAbs;
  let baseRel;
  const ver = rawVer ? String(rawVer) : "";
  if (ver) {
    if (!/^v\d+$/.test(ver)) {
      sendJson(res, 400, { ok: false, error: "版本 id 無效" });
      return null;
    }
    baseAbs = path.join(session.workdir, "versions", ver);
    baseRel = `${session.workdirRel}/versions/${ver}`;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(baseAbs, "meta.json"), "utf8"));
    } catch {
      sendJson(res, 404, { ok: false, error: `${ver} 沒有快照,無法匯出` });
      return null;
    }
    name = sanitizeName(meta.name);
    kind = meta.type === "assembly" || Number(meta.partCount) > 1 ? "assembly" : "part";
  } else {
    if (!session.lastName) {
      sendJson(res, 400, { ok: false, error: "目前沒有可匯出的產物(先讓 AI 產出模型)" });
      return null;
    }
    baseAbs = session.workdir;
    baseRel = session.workdirRel;
    name = sanitizeName(session.lastName);
    kind = fs.existsSync(path.join(baseAbs, `${name}.asm.json`)) ? "assembly" : "part";
  }
  if (!fs.existsSync(path.join(baseAbs, `${name}.step`))) {
    sendJson(res, 404, { ok: false, error: "STEP 檔不存在,無法轉換" });
    return null;
  }
  return { name, kind, baseAbs, baseRel };
}

// 匯出閘:未驗證的基準在出檔前自動補跑完整驗證,通過才放行(產圖收斂單一快路徑後,
// 一般產出不再跑 full 驗證——把關移到「出口」,匯出的東西必然驗過)。verified 真相:
//   頂層(無 ver)= session._lastValidate(full 且 ok)且基準未漂移(_geomDirty);
//   快照版 vN    = session._verifiedVers memo(emitPresent 對 full 驗證出生的版本
//                  登記;閘驗過後補登)。皆 in-memory 與 session 同壽命:伺服器重啟
//                  後首次匯出會重驗一次,冪等無害。
// 回 { ok, ran, ver, partCount?, checks? };ok=false = 驗證未過,呼叫端拒絕出檔。
async function ensureVerifiedForExport(session, base, rawVer) {
  const ver = rawVer ? String(rawVer) : "";
  const memo = (session._verifiedVers ||= new Set());
  const entryDirty = session._geomDirty; // 入場快照:漂移守衛只認「驗證期間才變 dirty」
  const isCurrent = !!ver && ver === `v${session.version}` && !entryDirty;
  const topVerified = !!(
    session._lastValidate?.full &&
    session._lastValidate.ok &&
    session._lastValidate.name === base.name &&
    !entryDirty
  );
  // 已驗過即免重跑:快照 memo 命中,或(最新版/頂層)頂層已 full 驗過且未漂移
  const already = ver ? memo.has(ver) || (isCurrent && topVerified) : topVerified;
  if (already) {
    if (ver) memo.add(ver);
    return { ok: true, ran: false, ver: ver || null };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
  let val;
  try {
    // 「最新版且基準未漂移」= 頂層內容與快照相同 → 走精算同款 runValidate(頂層有
    // imported/,含匯入件的組合件也驗得動;順帶更新 _lastValidate)。只有舊版快照才
    // 驗快照本體(自足產生器 OK;倚賴 imported/ 的舊版會誠實紅在「產生器執行」——
    // 此時先「回到此版繼續」再匯出即可,README 有記)。
    val =
      ver && !isCurrent
        ? await validateSnapshotFull(session, ver, base.name, { signal: ac.signal })
        : await runValidate(session, base.name, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  // 漂移守衛:頂層/最新版路徑驗的是活檔——interrupt 提早放行 busy 後,新 turn 的
  // runStep 可能在驗證窗內改寫頂層(_geomDirty false→true 的轉變)。此時結果描述的
  // 是「別的幾何」,不得進 memo、不得放行(凍結快照路徑驗 versions/vN,天然免疫)。
  // 入場就 dirty 的裸 API 無 ver 路徑不算漂移:驗的本來就是活頂層,結果如實。
  const drifted = (!ver || isCurrent) && !entryDirty && session._geomDirty;
  if (val.ok && ver && !drifted) memo.add(ver);
  return {
    ok: val.ok && !drifted,
    ran: true,
    stale: drifted || undefined,
    ver: ver || null,
    partCount: val.partCount,
    checks: decorateChecks(val.checks || []).map((c) => ({
      label: c.label,
      icon: c.icon,
      color: c.color,
      note: c.noteText,
      skipped: !!c.skipped,
    })),
  };
}

async function handleExport(body, res, ctx = {}) {
  if (!body?.sessionId) {
    sendJson(res, 400, { ok: false, error: "缺 sessionId" });
    return;
  }
  const format = String(body?.format || "");
  // 屬性查找要擋原型鏈:format="constructor" 這類繼承鍵是 truthy,會帶著非字串
  // flag 一路撞進 spawn 變成難懂的內部 TypeError,而不是這裡的清楚 400。
  const flag = Object.hasOwn(EXPORT_FLAGS, format) ? EXPORT_FLAGS[format] : null;
  const isDxf = format === "dxf";
  const isPdf = format === "pdf";
  if (!flag && !isDxf && !isPdf) {
    sendJson(res, 400, { ok: false, error: "format 僅支援 stl / 3mf / dxf / pdf" });
    return;
  }
  const session = requireExistingSession(body, res, ctx);
  if (!session) return;
  if (rejectNonDesignSession(session, res, "匯出")) return;
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const base = resolveExportBase(session, body?.ver, res);
  if (!base) return;
  const { name, kind } = base;

  const busyToken = acquireBusy(session);
  try {
    // 匯出閘:未驗證 → 自動補跑完整驗證;未過 → 擋下不出檔
    let gate;
    try {
      gate = await ensureVerifiedForExport(session, base, body?.ver);
    } catch (err) {
      sendJson(res, 200, { ok: false, error: `匯出前驗證失敗:${scrubPaths(String(err?.message || err))}` });
      return;
    }
    if (!gate.ok) {
      sendJson(res, 200, {
        ok: false,
        error: gate.stale
          ? "匯出中止:驗證期間工作基準被改動(中斷/新回合搶先),請重試。"
          : "匯出已擋下:此版本未通過完整幾何驗證(逐項見驗證卡)。",
        gate,
      });
      return;
    }
    // DXF(鈑金展開圖)走 skills/dxf CLI 對產生器 .py 現算(展開從 PARAMS 導出,
    // 不從 STEP 反推;快照裡的 .py 即該版真相源)。缺 .py / 缺 gen_dxf 統一回
    // 200 ok:false(與其他匯出失敗同型,前端呈現一致)。
    if (isDxf) {
      let src;
      try {
        src = fs.readFileSync(path.join(base.baseAbs, `${name}.py`), "utf8");
      } catch {
        sendJson(res, 200, { ok: false, error: "此版沒有產生器原始碼,無法產展開圖" });
        return;
      }
      if (!GEN_DXF_RE.test(src)) {
        sendJson(res, 200, { ok: false, error: "此版產生器沒有 gen_dxf(),無展開圖可匯(鈑金件才有)" });
        return;
      }
    }
    // 輸入(STEP 或 .py)複製到轉檔工作區再跑(絕不污染快照/工作基準,見 makeExportScratch)
    let scratch;
    try {
      scratch = makeExportScratch(session, body?.ver);
      const input = isDxf ? `${name}.py` : `${name}.step`;
      fs.copyFileSync(path.join(base.baseAbs, input), path.join(scratch.abs, input));
      // PDF 工程圖的電纜解析側視要讀 build meta 的中心線(sweepPaths)——連 STEP
      // 旁的 .{name}.step.meta.json 一併帶進 scratch(缺了就退回 HLR 側視,不致命)。
      if (isPdf) {
        // 版本快照只凍結 .sweep.json 不凍 meta(見 snapshotVersion 清單)→ 兩份都帶,
        // drawing_pdf 讀 meta 沒有就退 .sweep.json,快照匯出的側視才不會靜默退回 HLR。
        // 產生器 .py 也帶進 scratch:drawing_pdf 讀 STEP 旁同名 .py 的 PARAMS 印參數表
        // (逐層電纜長這類投影量不到的輸入規格);缺了只是沒表,不致命。
        for (const f of [`.${name}.step.meta.json`, `.${name}.sweep.json`, `${name}.py`]) {
          const src = path.join(base.baseAbs, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(scratch.abs, f));
        }
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `匯出準備失敗:${scrubPaths(String(err?.message || err))}` });
      return;
    }
    const outRel = `${scratch.rel}/${name}.${format}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), EXPORT_TIMEOUT_MS);
    let r;
    try {
      r = isDxf
        ? // skills/dxf CLI:跑 gen_dxf() 寫兄弟檔 <name>.dxf(cwd=REPO_ROOT 相對路徑)
          await spawnPython(
            "skills/dxf/scripts/dxf",
            [`${scratch.rel}/${name}.py`],
            { session, signal: ac.signal },
          )
        : isPdf
          ? // 四視圖工程圖:HLR 投影既有 STEP(俯/前/側/等角+包絡尺寸標註)
            await spawnPython(
              "apps/cad-chat/src/server/cad/drawing_pdf.py",
              [`${scratch.rel}/${name}.step`, "--out", `${scratch.rel}/${name}.pdf`],
              { session, signal: ac.signal },
            )
          : // sidecar 輸出路徑由 CLI 解讀為「相對 STEP 目標所在目錄」(cadpy
            // _resolve_step_option_output_path,且拒絕絕對路徑)→ 只傳檔名,寫在 STEP 旁。
            await spawnPython(
              "skills/cad/scripts/step",
              [`${scratch.rel}/${name}.step`, "--kind", kind, flag, `${name}.${format}`, "--force"],
              { session, signal: ac.signal },
            );
    } finally {
      clearTimeout(timer);
    }
    if (r.code !== 0 || !fs.existsSync(path.join(scratch.abs, `${name}.${format}`))) {
      sendJson(res, 200, {
        ok: false,
        error: `匯出失敗:${condenseTraceback(r.stderr, { generatorName: name }) || `exit ${r.code}`}`,
      });
      return;
    }
    sendJson(res, 200, { ok: true, file: outRel, format, name, gate });
  } finally {
    // 落盤一筆 session.json:gcSessions 只看頂層 mtime,重複匯出只寫 .exports/<key>/
    // 第二層,不 touch 頂層的話「最近只做匯出」的活 session 會被啟動 GC 誤判過期。
    persistSession(session);
    releaseBusy(session, busyToken);
  }
}

// 拆件匯出:occs 給定=圈選那幾件(#o1.2 token 去掉 #),省略=整機零件包
// (root 直接子件各一檔,子組合件=一個 compound 檔)。幾何抽取走 export_parts.py
// (cadpy scene API 讀既有 STEP,不重跑產生器);1 件=單檔、多件=zip。
const OCC_ID_RE = /^o\d+(\.\d+)*$/;
const PARTS_FORMATS = new Set(["step", "stl"]);
const PARTS_MAX = 8;

async function handleExportParts(body, res, ctx = {}) {
  if (!body?.sessionId) {
    sendJson(res, 400, { ok: false, error: "缺 sessionId" });
    return;
  }
  const format = String(body?.format || "");
  if (!PARTS_FORMATS.has(format)) {
    sendJson(res, 400, { ok: false, error: "format 僅支援 step / stl" });
    return;
  }
  const occs = Array.isArray(body?.occs) ? body.occs.map(String) : [];
  if (occs.length > PARTS_MAX) {
    sendJson(res, 400, { ok: false, error: `一次最多匯出 ${PARTS_MAX} 件` });
    return;
  }
  if (occs.some((o) => !OCC_ID_RE.test(o))) {
    sendJson(res, 400, { ok: false, error: "occurrence id 格式不對(應為 o1.2 形式)" });
    return;
  }
  const session = requireExistingSession(body, res, ctx);
  if (!session) return;
  if (rejectNonDesignSession(session, res, "拆件匯出")) return;
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const base = resolveExportBase(session, body?.ver, res);
  if (!base) return;

  const busyToken = acquireBusy(session);
  try {
    // 匯出閘:與 /api/export 同一道(拆件也是「出檔」)
    let gate;
    try {
      gate = await ensureVerifiedForExport(session, base, body?.ver);
    } catch (err) {
      sendJson(res, 200, { ok: false, error: `匯出前驗證失敗:${scrubPaths(String(err?.message || err))}` });
      return;
    }
    if (!gate.ok) {
      sendJson(res, 200, {
        ok: false,
        error: gate.stale
          ? "匯出中止:驗證期間工作基準被改動(中斷/新回合搶先),請重試。"
          : "匯出已擋下:此版本未通過完整幾何驗證(逐項見驗證卡)。",
        gate,
      });
      return;
    }
    // 輸入 STEP 唯讀(export_parts.py 只讀場景),但輸出/暫存目錄一律指到轉檔
    // 工作區——別在 versions/vK/ 快照目錄裡堆 zip/暫存(凍結快照保持純淨)。
    let scratch;
    try {
      scratch = makeExportScratch(session, body?.ver);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `匯出準備失敗:${scrubPaths(String(err?.message || err))}` });
      return;
    }
    const stepRel = `${base.baseRel}/${base.name}.step`;
    const outBaseRel = `${scratch.rel}/${base.name}_${occs.length ? "sel" : "parts"}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), EXPORT_TIMEOUT_MS);
    let r;
    try {
      r = await spawnPython(
        "apps/cad-chat/src/server/cad/export_parts.py",
        [stepRel, outBaseRel, format, ...occs],
        { session, signal: ac.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    let out = null;
    try {
      out = JSON.parse((r.stdout || "").trim().split("\n").pop());
    } catch {
      out = null;
    }
    if (r.code !== 0 || !out) {
      sendJson(res, 200, {
        ok: false,
        error: `拆件匯出失敗:${(r.stderr || "").trim().slice(-300) || `exit ${r.code}`}`,
      });
      return;
    }
    if (!out.ok) {
      sendJson(res, 200, { ok: false, error: out.error || "拆件匯出失敗" });
      return;
    }
    // 腳本以 cwd(REPO_ROOT)相對路徑寫出;Windows 會回反斜線 → 正規化給 asset 用
    const fileRel = String(out.file || "").replace(/\\/g, "/");
    sendJson(res, 200, { ok: true, file: fileRel, format, name: base.name, parts: out.parts || [], gate });
  } finally {
    persistSession(session); // touch 頂層 mtime,防啟動 GC 誤判(同 handleExport)
    releaseBusy(session, busyToken);
  }
}

// session 產物 → models/<name>/。兩路:
//   另存(對話框;無 inPlace):name 由 body 給、sanitizeName 單段;目標已存在要求 overwrite
//   確認;overwrite = 整目錄取代(舊產生器殘檔不留,免干擾之後 open-project 的 pickGenerator)。
//   儲存(inPlace:true):目標 = session.project.dir(伺服端說了算,忽略 body.name);未綁定
//   400 not_bound;目的地是範本 409;**合併語意**——只換產生器家族檔,其餘(tracked .dxf、
//   PDF 圖面、子資料夾)保留,case.json 合併(buildCaseMeta:沒帶 customer/note 不清空)。
// 兩路都走 writeProjectTreeAtomic(暫存 → 換名):完整替代品就位前目的地絕不消失
// (舊做法 rmSync 再複製,複製中途炸掉 = 唯一存檔消失)。
async function handleSaveProject(body, res, ctx = {}) {
  // 先驗證再取 session:getOrCreateSession 對缺席/不安全/GC 掉的 id 會 mint 一個
  // 全新空 session 目錄——壞請求不該在 models/.cadchat/ 留下垃圾(其他 handler
  // 都先驗 sessionId,這裡比照)。probeSessionOnDisk 唯讀,絕不建目錄。
  const sid = String(body?.sessionId || "");
  if (!sid || !probeSessionOnDisk(sid, ctx.user).exists) {
    sendJson(res, 400, { ok: false, error: "目前沒有可保存的產物(先讓 AI 產出模型)" });
    return;
  }
  const session = getOrCreateSession(sid, { user: ctx.user });
  if (rejectNonDesignSession(session, res, "另存專案")) return;
  if (!session.lastName) {
    sendJson(res, 400, { ok: false, error: "目前沒有可保存的產物(先讓 AI 產出模型)" });
    return;
  }
  // workdir 被手動刪但 session 還活在記憶體(probe 因 live 放行):先驗來源,
  // 否則 overwrite 路徑會先 rmSync 毀掉既有存檔、copyProjectTree 才炸 ENOENT。
  if (!fs.existsSync(session.workdir)) {
    sendJson(res, 404, { ok: false, error: "session 工作目錄不存在(可能已被清理)" });
    return;
  }
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const inPlace = body?.inPlace === true;
  if (inPlace && !session.project) {
    sendJson(res, 400, { ok: false, error: "not_bound", message: "這個對話還沒綁定專案,請先「另存」" });
    return;
  }
  // 中斷後的半成品:interrupt 清 busy 時 kill 尚未完成、頂層 STEP 可能截斷;_geomDirty =
  // runStep 開跑後還沒 emitPresent(build 了沒 present)——存出去的會與時間軸任何一版都不同。
  if (session._geomDirty || session.childProcs.size > 0) {
    sendJson(res, 409, {
      ok: false,
      error: "工作基準與最新版本不一致(上輪被中斷或尚未產圖),請重新產圖後再儲存",
    });
    return;
  }
  // 就地:目標由綁定決定,逐段驗證後 resolveInside(不走 sanitizeName——它會把 / 拍掉,
  // cases/x 會變成 casesx,chip 說存到 A 實際寫到 B)。另存:單段 sanitizeName 照舊。
  const name = inPlace ? session.project.dir : sanitizeName(body?.name || session.lastName);
  if (inPlace && !validateProjectDir(name)) {
    sendJson(res, 400, { ok: false, error: "綁定的專案目錄名無效" });
    return;
  }
  let dstAbs;
  try {
    // 寫入只准本人可寫層(session.modelsRoot;legacy session = 全域 MODELS_ROOT)
    dstAbs = resolveInside(session.modelsRoot || MODELS_ROOT, name);
  } catch {
    sendJson(res, 400, { ok: false, error: "名稱無效" });
    return;
  }
  const dstExists = fs.existsSync(dstAbs);
  if (inPlace) {
    // 目的地是範本(TEMPLATE_META 且無 case.json)→ 拒絕:tracked 範本的預設值不該被
    // 一次 Ctrl+S 改掉(綁定規則本就不綁範本;這是伺服端第二道閘)。
    const dstGen = dstExists ? pickGenerator(dstAbs) : null;
    if (dstGen && readTemplateMeta({ workdir: dstAbs }, dstGen) && !readCaseMeta(dstAbs)) {
      sendJson(res, 409, { ok: false, error: "範本目錄不可就地覆蓋,請另存新案" });
      return;
    }
  } else if (dstExists && !body?.overwrite) {
    sendJson(res, 200, { ok: false, error: "exists", dir: name });
    return;
  }
  // 案件紀錄(工作台「案件」頁籤的來源)。可變的案件中繼**不寫進 .py**——.py 的
  // 寫入者只有 rewriteParams 一個;客戶/日期/來源範本/備註放 sidecar。prev 要在換名前
  // 從**目的地**讀(workdir 裡那份是開啟時複製的舊檔,不是真相);只有 cable session 寫
  // (design 的另存語意仍是「存成範本/專案」,不是案件)。
  const prevCase = session.mode === "cable" ? readCaseMeta(dstAbs) : null;
  const prepare =
    session.mode === "cable"
      ? (tmp) => {
          const meta = buildCaseMeta(prevCase, body, {
            name,
            fallbackSourceTemplate: session.rehydratedFrom || "",
          });
          fs.writeFileSync(path.join(tmp, CASE_FILE), JSON.stringify(meta, null, 1), "utf8");
        }
      : null;
  // 複製期間鎖 busy:換名重試會 await,不鎖的話同時進來的回合可能改寫頂層檔。
  const busyToken = acquireBusy(session);
  let swap;
  try {
    swap = await writeProjectTreeAtomic(session.workdir, dstAbs, { merge: inPlace, prepare });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: `儲存失敗:${scrubPaths(String(err?.message || err))}` });
    return;
  } finally {
    releaseBusy(session, busyToken);
  }
  // 綁定跟著儲存走:另存 → 綁到新名(origin saved);就地 → 只推進 ver(origin 不變)。
  session.project = {
    dir: name,
    ver: session.version,
    origin: inPlace ? session.project.origin : "saved",
  };
  persistSession(session); // 綁定落盤 + touch 頂層 mtime(防啟動 GC 誤判)
  sendJson(res, 200, { ok: true, dir: name, inPlace, project: session.project, swap });
}

// POST /api/validate {sessionId} — 對 session 當前頂層產物跑「完整」幾何驗證(含運動掃掠),
// 不重新產生(快路徑產物已寫精確 STEP)。給版本上的「精算此版」用:快速迭代後一鍵
// 補做真驗證;通過後匯出/下載免等閘(memo 由 emitPresent/匯出閘管理)。
async function handleValidate(body, res, ctx = {}) {
  const session = requireExistingSession(body, res, ctx);
  if (!session) return;
  if (rejectNonDesignSession(session, res, "精算")) return;
  if (!session.lastName) {
    sendJson(res, 400, { ok: false, error: "目前沒有可驗證的產物(先讓 AI 產出模型)" });
    return;
  }
  if (!fs.existsSync(path.join(session.workdir, `${session.lastName}.py`))) {
    sendJson(res, 404, { ok: false, error: "產物不存在(可能已被清理)" });
    return;
  }
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const name = session.lastName;
  const busyToken = acquireBusy(session);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const val = await runValidate(session, name, { signal: ac.signal }); // 一律 full 驗證
    // interrupt 在驗證窗口把鎖撤走(殺了 python、新 turn 可能已接手):作廢,不動 session 狀態。
    if (session._busyToken !== busyToken) {
      sendJson(res, 200, { ok: false, error: "驗證被中斷" });
      return;
    }
    if (val.partCount > 0) session.lastPartCount = val.partCount;
    // 精算通過且基準未漂移 → 最新版進匯出閘 memo(之後匯出/下載免等閘重驗)
    if (val.ok && !session._geomDirty && session.version > 0) {
      (session._verifiedVers ||= new Set()).add(`v${session.version}`);
    }
    const decorated = decorateChecks(val.checks || []);
    sendJson(res, 200, {
      ok: true,
      validateOk: val.ok,
      // 頂層基準漂移(上輪 build 後被中斷、沒走到 present):此結果驗的是漂移幾何,
      // 前端不得把它標到最新版本快照上(不 MARK_VERSION_VERIFIED、不掛 motion)。
      stale: !!session._geomDirty,
      partCount: val.partCount,
      checks: decorated.map((c) => ({
        label: c.label,
        icon: c.icon,
        color: c.color,
        note: c.noteText,
        skipped: !!c.skipped,
      })),
      motion: val.motion || null,
    });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: `驗證失敗:${scrubPaths(String(err?.message || err))}` });
  } finally {
    clearTimeout(timer);
    persistSession(session); // touch 頂層 mtime,防啟動 GC 誤判
    releaseBusy(session, busyToken);
  }
}

// POST /api/validate-ver {sessionId, ver?} — 對指定版本快照(或頂層)跑匯出閘同款
// 完整驗證並登記 memo。給前端 STEP 直下載把關:/api/asset 是裸 GET 沒有閘,前端
// 下載未驗證版的 STEP 前先打這裡,verified=true 才觸發下載(單人本機 app,閘是
// UX 契約,不是安全邊界——直接敲 asset URL 仍可繞過,README 有記)。
async function handleValidateVer(body, res, ctx = {}) {
  const session = requireExistingSession(body, res, ctx);
  if (!session) return;
  if (rejectNonDesignSession(session, res, "匯出前驗證")) return;
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
  const base = resolveExportBase(session, body?.ver, res);
  if (!base) return;
  const busyToken = acquireBusy(session);
  try {
    const gate = await ensureVerifiedForExport(session, base, body?.ver);
    sendJson(res, 200, { ok: true, verified: gate.ok, gate });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: `驗證失敗:${scrubPaths(String(err?.message || err))}` });
  } finally {
    persistSession(session); // touch 頂層 mtime,防啟動 GC 誤判(同 handleValidate)
    releaseBusy(session, busyToken);
  }
}

export function projectMiddleware() {
  return function project(req, res, next) {
    const url = parseUrl(req);
    const routes = {
      "/api/import": handleImport,
      "/api/open-project": handleOpenProject,
      "/api/save-project": handleSaveProject,
      "/api/revert-version": handleRevertVersion,
      "/api/export": handleExport,
      "/api/export-parts": handleExportParts,
      "/api/validate": handleValidate,
      "/api/validate-ver": handleValidateVer,
    };
    const handler = req.method === "POST" ? routes[url.pathname] : null;
    if (!handler) {
      next();
      return;
    }
    readJsonBody(req)
      .then((body) => handler(body, res, req.cadchat))
      .catch((err) => sendJson(res, 400, { ok: false, error: scrubPaths(String(err?.message || err)) }));
  };
}
