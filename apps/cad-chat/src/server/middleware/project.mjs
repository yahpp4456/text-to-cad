// 專案生命周期(免 LLM 直接操作,回 JSON):
//   POST /api/import        {sessionId?, file}     — 複製 models/ 下 STEP 進 session imported/
//   POST /api/open-project  {dir, generator?}      — 開既有專案:複製樹到新 session + 重建
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
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { resolveInside } from "../cad/paths.mjs";
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
  resolveImportSource,
  runStep,
  runValidate,
  sanitizeName,
  validateSnapshotFull,
} from "../cad/pipeline.mjs";

const REBUILD_TIMEOUT_MS = 300_000; // 開專案同步重建上限(大組合件 tessellation 較久)
const FACTS_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 120_000; // 「精算此版」完整驗證含運動掃掠(75s 閘)+ 餘裕

async function handleImport(body, res) {
  // 先驗來源檔再取 session:getOrCreateSession 會 mint 目錄,壞檔的失敗請求
  // 不該留下空 session(還會讓 session-info 對死 id 誤回 exists:true)。
  const src = resolveImportSource(body?.file);
  if (!src.ok) {
    sendJson(res, 200, { ok: false, error: src.error });
    return;
  }
  const session = getOrCreateSession(body?.sessionId); // 無 sessionId 就開新的(回給前端採用)
  // 刻意的單向互斥:匯入會被進行中的 turn 擋(409),但不 acquireBusy——
  // inspectFacts 最長 30s,持鎖會讓聊天訊息在匯入期間 409。代價:turn 在 facts
  // 窗口內開始且被 interrupt 時,killTree 會連匯入的 inspect 子程序一起殺,
  // sizeMm 靜默變 null(prefill 缺 bbox),匯入本身仍成功。
  if (session.busy) {
    sendJson(res, 409, { ok: false, error: "session 忙碌中(等目前回合結束)" });
    return;
  }
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

// 遞迴複製專案樹(跳過快取/隱藏目錄雜物;隱藏 topology GLB 要帶——重建失敗時至少能看圖)。
// versions/ 也跳過:那是 session 內部的版本快照歷史——存出的專案是「成品」不是「歷史」,
// 開回來的新 session 版本計數從 0 起,帶舊快照只會 id 錯位。
// session.json / .exports/ 也跳過:前者是 session 私有中繼資料(sdkSessionId 等機器
// 本地識別;models/<name>/ 是 git 追蹤的,存出去就是把它發佈出去),後者是轉檔
// 工作區雜物;兩者對「存出的成品/開回來的新 session」都沒有意義。
// (轉檔區取名 .exports 帶點前綴,避免與手工專案裡使用者自己的 exports/ 目錄撞名被丟。)
function copyProjectTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (
      ent.name === "__pycache__" ||
      ent.name === "versions" ||
      ent.name === ".exports" ||
      ent.name === "session.json" ||
      ent.name.endsWith(".pyc") ||
      // 展開圖 DXF 是「按需匯出」產物,不隨滑桿重生更新:帶出去會是與 STEP
      // 尺寸不符的過期圖(viewer 又會自動與同名 .py 配對)。要展開圖用匯出鈕現算。
      ent.name.endsWith(".dxf")
    )
      continue;
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyProjectTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

// 選主產生器:指定 > 唯一 .py > 有同名 .asm.json > 檔案最大。回 stem|null。
function pickGenerator(dir, requested) {
  const pys = fs.readdirSync(dir).filter((f) => f.endsWith(".py"));
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

async function handleOpenProject(body, res) {
  const clean = String(body?.dir || "")
    .replace(/\\/g, "/")
    .replace(/^models\//, "");
  let srcAbs;
  try {
    srcAbs = resolveInside(MODELS_ROOT, clean);
  } catch {
    sendJson(res, 403, { ok: false, error: "路徑超出 models/" });
    return;
  }
  if (!clean || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) {
    sendJson(res, 404, { ok: false, error: "目錄不存在" });
    return;
  }

  // 開新 session(不原地續用:舊 workdir 是歷史快照,兩個 session 同目錄會互踩)
  const session = getOrCreateSession(null);
  copyProjectTree(srcAbs, session.workdir);

  const name = pickGenerator(session.workdir, body?.generator);
  if (!name) {
    sendJson(res, 200, {
      ok: false,
      sessionId: session.sessionId,
      error: "目錄裡沒有產生器 .py(純檔案請用「開啟」看圖)",
    });
    return;
  }
  session.lastName = name;
  session.rehydratedFrom = clean;
  persistSession(session);
  // rehydrate 後首個 agent turn 的一次性接續提示(chat.mjs 取用後清空)
  session._rehydrateNote =
    `（本對話接續既有專案 ${name}(來源 models/${clean})。產生器已在 ${session.workdirRel}/${name}.py,` +
    `修改前先 Read 它,沿用其 PARAMS/INTENDED_CONTACT/MOTION 結構,用 cad_build(edits) 精修。）`;

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
      error: `重建失敗:${condenseTraceback(step.stderr, { generatorName: name }) || `exit ${step.exitCode}`}(session 已保留,可用對話修復)`,
    });
    return;
  }

  // 收集 emitPresent 的三事件讓前端 dispatch(無 SSE 通道,JSON 帶回)
  const events = [];
  emitPresent(session, name, (ev, data) => events.push([ev, data]));
  const version = events.find(([e]) => e === "version")?.[1] || null;
  const present = events.find(([e]) => e === "present")?.[1] || null;

  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    name,
    type: version?.type || "part",
    version,
    present,
    params: paramDefsFromGenerator(session, name),
    motion: val?.motion || null,
    validateOk: val ? val.ok : null,
    warnings: presentWarnings(events),
  });
}

// 回退:把 versions/vK 快照複回 workdir 頂層(消除「看的版 vs 改的基準」分歧),
// 重建+驗證後 emitPresent 產生「新版 v{N+1} = vK 複本」——歷史線性,不竄改既有版號。
async function handleRevertVersion(body, res) {
  const session = requireExistingSession(body, res);
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
  const busyToken = acquireBusy(session);
  try {
    // 快照複回頂層;單件版要清掉頂層殘留的 asm.json,type 才不會誤判成組合件。
    // .flat.step.glb:鈑金攤平預覽 GLB 也複回(回退版的攤平切換要能用)。
    for (const f of [`${name}.py`, `${name}.step`, `.${name}.step.glb`, `.${name}.flat.step.glb`, `${name}.asm.json`, `.${name}.step.js`]) {
      const src = path.join(snapDir, f);
      const dst = path.join(session.workdir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      else if ((f === `${name}.asm.json` || f === `.${name}.flat.step.glb`) && fs.existsSync(dst)) fs.rmSync(dst);
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
function requireExistingSession(body, res) {
  if (!body?.sessionId) {
    sendJson(res, 400, { ok: false, error: "缺 sessionId" });
    return null;
  }
  if (!probeSessionOnDisk(body.sessionId).exists) {
    sendJson(res, 404, { ok: false, error: "session 不存在(可能已被清理),請重新產生模型" });
    return null;
  }
  return getOrCreateSession(body.sessionId);
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

async function handleExport(body, res) {
  if (!body?.sessionId) {
    sendJson(res, 400, { ok: false, error: "缺 sessionId" });
    return;
  }
  const format = String(body?.format || "");
  // 屬性查找要擋原型鏈:format="constructor" 這類繼承鍵是 truthy,會帶著非字串
  // flag 一路撞進 spawn 變成難懂的內部 TypeError,而不是這裡的清楚 400。
  const flag = Object.hasOwn(EXPORT_FLAGS, format) ? EXPORT_FLAGS[format] : null;
  const isDxf = format === "dxf";
  if (!flag && !isDxf) {
    sendJson(res, 400, { ok: false, error: "format 僅支援 stl / 3mf / dxf" });
    return;
  }
  const session = requireExistingSession(body, res);
  if (!session) return;
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

async function handleExportParts(body, res) {
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
  const session = requireExistingSession(body, res);
  if (!session) return;
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

// session 產物 → models/<name>/(另存專案)。目標已存在時要求 overwrite 確認,
// 覆蓋前先清掉舊樹(避免舊產生器殘檔干擾之後 open-project 的 pickGenerator)。
function handleSaveProject(body, res) {
  // 先驗證再取 session:getOrCreateSession 對缺席/不安全/GC 掉的 id 會 mint 一個
  // 全新空 session 目錄——壞請求不該在 models/.cadchat/ 留下垃圾(其他 handler
  // 都先驗 sessionId,這裡比照)。probeSessionOnDisk 唯讀,絕不建目錄。
  const sid = String(body?.sessionId || "");
  if (!sid || !probeSessionOnDisk(sid).exists) {
    sendJson(res, 400, { ok: false, error: "目前沒有可保存的產物(先讓 AI 產出模型)" });
    return;
  }
  const session = getOrCreateSession(sid);
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
  const name = sanitizeName(body?.name || session.lastName);
  let dstAbs;
  try {
    dstAbs = resolveInside(MODELS_ROOT, name);
  } catch {
    sendJson(res, 400, { ok: false, error: "名稱無效" });
    return;
  }
  if (fs.existsSync(dstAbs)) {
    if (!body?.overwrite) {
      sendJson(res, 200, { ok: false, error: "exists", dir: name });
      return;
    }
    fs.rmSync(dstAbs, { recursive: true, force: true });
  }
  copyProjectTree(session.workdir, dstAbs);
  sendJson(res, 200, { ok: true, dir: name });
}

// POST /api/validate {sessionId} — 對 session 當前頂層產物跑「完整」幾何驗證(含運動掃掠),
// 不重新產生(快路徑產物已寫精確 STEP)。給版本上的「精算此版」用:快速迭代後一鍵
// 補做真驗證;通過後匯出/下載免等閘(memo 由 emitPresent/匯出閘管理)。
async function handleValidate(body, res) {
  const session = requireExistingSession(body, res);
  if (!session) return;
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
async function handleValidateVer(body, res) {
  const session = requireExistingSession(body, res);
  if (!session) return;
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
      .then((body) => handler(body, res))
      .catch((err) => sendJson(res, 400, { ok: false, error: scrubPaths(String(err?.message || err)) }));
  };
}
