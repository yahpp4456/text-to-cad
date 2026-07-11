// POST /api/chat — 起/續一個 agent turn,以 SSE 串流回前端。
// body: { message?, sessionId?, pickRef?, params?, imageRefs? }
import fs from "node:fs";
import path from "node:path";

import { resolveAuth } from "../config.mjs";
import { parseUrl, readJsonBody, sendJson } from "../httpUtil.mjs";
import { acquireBusy, getOrCreateSession, persistSession, releaseBusy } from "../sessions.mjs";
import { condenseTraceback, scrubPaths } from "../cad/python.mjs";
import { resolveInside } from "../cad/paths.mjs";
import { MAX_IMAGE_BYTES, sniffImageType } from "../images.mjs";
import { openSse } from "../sse.mjs";
import { runTurn } from "../agent/runner.mjs";
import {
  buildOrRollback,
  decorateChecks,
  emitPresent,
  paramValuesFromGenerator,
  rewriteParams,
  runValidateDesign,
} from "../cad/pipeline.mjs";
import {
  beginTurnRecorder,
  flushTurnRecorder,
  noteValidateSuccess,
  recordBuildFailure,
  recordCheckFailure,
} from "../lessons.mjs";
import { maybeDistill } from "../lessons.distill.mjs";

export function chatMiddleware() {
  return async function chat(req, res, next) {
    const url = parseUrl(req);
    if (url.pathname !== "/api/chat") return next();
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const auth = resolveAuth();
    if (!auth.agentReady) {
      sendJson(res, 503, { error: "agent_not_ready", warnings: auth.warnings });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "bad body" });
      return;
    }
    // JSON.parse("null") / 純量也是合法 JSON:非物件 body 一律 400,別讓
    // body.sessionId 的 TypeError 變成 500。
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "bad body" });
      return;
    }

    const session = getOrCreateSession(body.sessionId);
    if (session.busy) {
      sendJson(res, 409, { error: "session busy" });
      return;
    }
    // busy 鎖領 token:interrupt 提早放行後新 turn 可能先 begin,本 turn 的
    // finally 只准釋放自己領的鎖(見 sessions.mjs acquireBusy 註解)。
    const busyToken = acquireBusy(session);
    // 教訓案例:本 turn 的紅色先進記憶體 buffer,finally 一次落盤(涵蓋 agent 與參數重生兩路)。
    // 持有 rec 引用:interrupt 提早放行 busy 後新 turn 可能先 begin,舊 turn 的 finally
    // 只准 flush 自己的 buffer(lessons.mjs 以身份比對防呆)。
    const imgCount = Array.isArray(body.imageRefs) ? body.imageRefs.length : 0;
    const lessonRec = beginTurnRecorder(session, {
      userText:
        (String(body.message || "").trim() ||
          (body.params ? `(參數重生 ${JSON.stringify(body.params)})` : "")) +
        (imgCount ? `(含 ${imgCount} 張圖)` : ""),
    });

    const sse = openSse(res);
    const emit = (event, data) => sse.emit(event, data);
    session.emit = emit;
    emit("session", { sessionId: session.sessionId, sdkSessionId: session.sdkSessionId });
    // 斷線只准中止自己這個 turn:interrupt 放行後 currentAbort 可能已是新 turn 的
    sse.onClose(() => {
      if (session._busyToken === busyToken) session.currentAbort?.abort();
    });

    try {
      const img = readImageBlocks(body, session);
      const paramsOnly =
        body.params &&
        Object.keys(body.params).length > 0 &&
        (!body.message || !String(body.message).trim()) &&
        img.blocks.length === 0; // 帶圖訊息絕不走決定性重生路(圖必須進 agent)

      if (paramsOnly && session.lastName) {
        // 掛 abort controller:瀏覽器斷線 / interrupt 時要能殺掉重生的 Python 子程序。
        const abort = new AbortController();
        session.currentAbort = abort;
        try {
          await deterministicRegen(session, body.params, emit, abort.signal);
        } finally {
          // 只清自己掛的 abort(新 turn 可能已接手 currentAbort)
          if (session.currentAbort === abort) session.currentAbort = null;
        }
        // 被 interrupt 的 regen 早退時別回 ok:true 誤報成功
        sse.end({ ok: !abort.signal.aborted, version: session.version });
      } else {
        const { ok } = await runTurn({
          session,
          emit,
          message: buildUserText(body, session, img),
          imageBlocks: img.blocks,
        });
        sse.end({ ok, version: session.version });
      }
    } catch (err) {
      // 例外訊息可能含本機絕對路徑(spawn ENOENT、transcript 檔錯誤)→ 同 Python
      // 輸出一樣過 scrubPaths,別讓錯誤路徑繞過消毒直達 UI。
      emit("error", { message: scrubPaths(String(err?.message || err)) });
      sse.end({ ok: false });
    } finally {
      // 鎖已被 interrupt 放行 / 新 turn 接手 → emit 也已是別人的,一併不動
      if (releaseBusy(session, busyToken)) {
        session.emit = null;
      }
      persistSession(session); // turn 尾統一落盤(涵蓋 imports/lastPartCount 等變動)
      flushTurnRecorder(session, { rec: lessonRec }); // 教訓案例落盤(no-throw;只刷本 turn 的 buffer)
      // 蒸餾 fire-and-forget:絕不阻塞回應;single-flight 與門檻在 maybeDistill 內把關
      setImmediate(() => {
        maybeDistill().catch(() => {});
      });
    }
  };
}

// body.imageRefs(輕量 rel,如 "uploads/xxx.png")→ 從 session workdir 讀檔組
// API image content blocks。雙重沙箱:強制 uploads/ 前綴 + resolveInside;
// media_type 重嗅探(不信副檔名,容忍手放檔案);超限/嗅探失敗丟棄、缺檔記 missing。
export function readImageBlocks(body, session) {
  const refs = Array.isArray(body?.imageRefs) ? body.imageRefs.slice(0, 4) : [];
  const blocks = [];
  const names = [];
  const missing = [];
  for (const raw of refs) {
    const rel = String(raw || "").replace(/\\/g, "/");
    if (!rel.startsWith("uploads/")) continue;
    let abs;
    try {
      abs = resolveInside(session.workdir, rel);
    } catch {
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      missing.push(path.basename(rel));
      continue;
    }
    const sniffed = sniffImageType(buf);
    if (!sniffed || buf.length > MAX_IMAGE_BYTES) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: sniffed.mediaType, data: buf.toString("base64") },
    });
    names.push(path.basename(rel));
  }
  return { blocks, names, missing };
}

export function buildUserText(body, session, img) {
  let t = String(body.message || "").trim();
  // 多選幾何參考(pickRefs[]);舊單選字串 pickRef 保留相容
  const refs = Array.isArray(body.pickRefs)
    ? body.pickRefs
        .slice(0, 6)
        .map((r) => ({
          token: String(r?.token || "").slice(0, 120),
          label: String(r?.label || "").slice(0, 120),
        }))
        .filter((r) => r.token)
    : [];
  const fmt = (r) => `${r.token}${r.label && r.label !== r.token ? `「${r.label}」` : ""}`;
  if (refs.length > 1) {
    const list = refs.map((r, i) => `  ${i + 1}. ${fmt(r)}`).join("\n");
    const src = session?.lastName ? `,來自 ${session.lastName}.step` : "";
    t = `（已帶入 ${refs.length} 個幾何參考${src}:\n${list}\n可用 cad_measure / cad_align 對這些參考取決定性距離與對齊平移。）\n${t}`;
  } else if (refs.length === 1) {
    t = `（已帶入幾何參考 ${fmt(refs[0])}）\n${t}`;
  } else if (body.pickRef) {
    t = `（已帶入幾何參考 ${body.pickRef}）\n${t}`;
  }
  if (body.params && Object.keys(body.params).length) {
    t += `\n（使用者把參數調整為 ${JSON.stringify(body.params)},請據此重生新版本。）`;
  }
  // 附圖註記:image blocks 已內嵌在同一則 user message(runner streaming input),
  // 這行讓 transcript/教訓錄製可讀,也保證「純圖無文字」的 userText 非空。
  if (img?.names?.length) {
    t += `\n（附圖 ${img.names.length} 張:${img.names.join("、")}——圖已內嵌於本訊息,直接讀圖,不需 Read 開檔。）`;
  }
  if (img?.missing?.length) {
    t += `\n（附圖 ${img.missing.join("、")} 已遺失,未內嵌。）`;
  }
  // 當前畫布語境(安全網):使用者在唯讀檢視某外部檔案時,agent 否則完全不知道
  // 畫布上開著什麼(此 turn 的 session 通常沒 lastName)。只在 source="opened" 且
  // 「沒有 _rehydrateNote」時注入——後者是 open-project/自動帶入編輯的權威續接語境,
  // 有它就代表 session 已擁有該模型,不必再靠 canvas 提示(且避免升級瞬間的 stale
  // canvas 與新 session 語境打架)。
  const cv = body?.canvas;
  if (cv?.source === "opened" && !session?._rehydrateNote) {
    const nm = String(cv.name || "").slice(0, 120);
    const file = String(cv.file || "").slice(0, 200);
    const pd = cv.projectDir ? String(cv.projectDir).slice(0, 200) : null;
    if (pd) {
      t = `（使用者目前在畫布上開著專案「${nm}」,產生器在 models/${pd}/${nm}.py。要了解它先 Read 該 .py;若他要求修改或調參數,提醒他用檔案瀏覽器的「開啟」把它帶入可編輯工作區。）\n${t}`;
    } else if (file) {
      t = `（使用者目前在畫布上檢視 models/${file}(匯入/獨立檔,無產生器,無法參數化編輯)。可 Read 它回答問題,或另外建模新版本。）\n${t}`;
    }
  }
  // rehydrate 後首個 turn 的一次性接續提示(open-project / resume 降級時設定)。
  // 這裡只讀不清:清除點在 runner 的 init 成功(SDK 已收下含提示的 prompt)——
  // 若在這裡就清,turn 又在 pre-init 失敗,提示就永久遺失,之後成功的 turn
  // 對既有產物零語境。
  if (session?._rehydrateNote) {
    t = `${session._rehydrateNote}\n${t}`;
  }
  return t || "（空訊息）";
}

// 參數即時重生:改 PARAMS → step → validate → present,免 LLM round-trip。
async function deterministicRegen(session, params, emit, signal) {
  const name = session.lastName;
  const id = `tool_${Date.now().toString(36)}`;
  session._valAttempt = 0;

  const rw = rewriteParams(session, name, params);
  if (!rw.ok) {
    emit("error", { message: rw.error });
    return;
  }

  emit("stage", { index: 2 });
  emit("tool", {
    id,
    name: `cad.build(${name}.py)`,
    label: "參數重生 → 執行",
    status: "running",
    code: `# PARAMS → ${JSON.stringify(params)}`,
  });
  // build 失敗 → 把 .py 還原成改寫前(aborted 不寫檔;見 buildOrRollback 註解)。
  // 不回滾的話,磁碟 .py 與 .step/.glb 漂移:之後任何會重跑 .py 的動作(agent
  // edits、精算、回退)都踩同一炸點,快照還會凍出「壞 .py + 舊幾何」的幻影版。
  const { step, rolledBack } = await buildOrRollback(session, name, rw.prevSrc, { signal });
  if (!step.ok) {
    // 中斷/斷線殺掉的子程序不是生成失敗,不記教訓案例
    if (!signal?.aborted) {
      recordBuildFailure(session, { part: name, exitCode: step.exitCode, stderr: step.stderr, source: "regen_build" });
    }
    emit("tool", { id, status: "error", note: condenseTraceback(step.stderr, { generatorName: name }) });
    if (rolledBack) {
      emit("error", { message: "參數重生失敗:參數已還原為上次成功值,滑桿已拉回,請調整後再套用。" });
      // 滑桿值拉回磁碟真相(只送 values:重發 params/defs 會把 agent 用 emit_params
      // 給的 label/unit/range 降級成啟發式品質)
      const values = paramValuesFromGenerator(session, name);
      if (values) emit("params_values", { values });
    } else if (!signal?.aborted) {
      emit("error", { message: "參數重生失敗(參數回寫也失敗,產生器仍是失敗值)" });
    } else {
      emit("error", { message: "參數重生失敗" });
    }
    return;
  }
  emit("tool", {
    id,
    status: "done",
    ms: step.ms,
    outputs: [
      { path: `${name}.step`, kind: "step" },
      { path: `.${name}.step.glb`, kind: "glb" },
    ],
  });

  emit("stage", { index: 3 });
  // 滑桿重生一律走快路徑:零 spawn(runStep 剛 prime 的 build sidecar 直讀)——
  // 整輪只剩 build 一個 spawn,拖桿保持互動性。完整驗證由「精算此版」與匯出閘承擔。
  const val = await runValidateDesign(session, name, { signal });
  // interrupt 已放行鎖(甚至新 turn 已接手):被中斷的 regen 不得再動 session
  // 狀態——繼續走會 bump 版本、把「可能已被新 turn 改寫的 .py + 本輪舊幾何」
  // 凍成不一致的幻影快照。此檢查之後到 emitPresent 全程同步,無再被搶佔的窗。
  if (signal?.aborted) return;
  if (val.partCount > 0) session.lastPartCount = val.partCount;
  // 教訓案例:參數重生的紅也記(source 標 regen_*;快路徑的紅只可能來自缺 sidecar
  // 的 --motion-only fallback);中斷產生的幽靈紅不記。閉環:零 spawn 空洞綠不算,
  // fallback 真綠(val.design 缺席)才閉環;精算/匯出閘在 turn 外接不到 recorder,
  // 那邊的紅綠不進教訓迴圈(已知限制)。
  if (!signal?.aborted) {
    for (const c of val.checks) {
      if (!c.skipped && !c.ok) {
        recordCheckFailure(session, { part: name, check: c, partCount: val.partCount, source: "regen_validate" });
      }
    }
    if (val.ok && !val.design) noteValidateSuccess(session);
  }
  const dec = decorateChecks(val.checks);
  emit("validate", {
    ok: val.ok,
    attempt: 1,
    ms: val.ms,
    partCount: val.partCount,
    checks: dec.map((c) => ({
      label: c.label,
      icon: c.icon,
      color: c.color,
      note: c.noteText,
      skipped: !!c.skipped,
    })),
  });
  // MOTION 的 travel 引用 PARAMS,重生後重新 import 的新值在這裡帶回(播放自動跟上)
  emit("motion", { name, schemaVersion: 1, dofs: val.motion?.dofs || [] });

  emit("stage", { index: 4 });
  emitPresent(session, name, emit);
}
