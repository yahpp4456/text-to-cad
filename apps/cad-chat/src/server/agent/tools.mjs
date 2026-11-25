// 每個 turn 建一個 in-process MCP server,工具 closures over 當前 session/emit/signal,
// 同步把 UI 事件 emit 到 SSE(不靠 re-parse stream,確保保序)。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  applyEdits,
  checkView,
  decorateChecks,
  motionEvent,
  runSnapshot,
  SNAPSHOT_VIEWS,
  emitPresent,
  generatorHasDxf,
  importStepIntoSession,
  inspectFacts,
  paramDefsFromGenerator,
  readBuildMeta,
  runStep,
  runValidate,
  runValidateDesign,
  rewriteParams,
  sanitizeName,
  writeGenerator,
} from "../cad/pipeline.mjs";
import path from "node:path";

import { readOccurrences } from "../cad/occurrences.mjs";
import { condenseTraceback, spawnPython } from "../cad/python.mjs";
import { isPartRef, resolveSelector } from "../../lib/partRefs.js";
import { BASE_PATH, lessonsEnabled } from "../config.mjs";
import { unescapeNewlines } from "../../lib/clarifyText.js";
import { makeClarifyGate, makeUiTools, result, toolId } from "./tools.shared.mjs";
import {
  noteBuildSuccess,
  noteFixAttempt,
  noteValidateSuccess,
  recordApplyFailure,
  recordBuildFailure,
  recordCheckFailure,
} from "../lessons.mjs";

// 工具參數裡用零件名稱寫的參照(@arm / @bolt.2 / @arm#f3;藍圖 C3)→ 位置 token。
// 沒有任何 @ 參照時不讀檔、原樣通過;對不上或不只一個 → ok:false + 候選,絕不代選。
// 獨立 export 供 L1 直測。
export function resolveSelectors(session, part, refs) {
  const entries = Object.entries(refs);
  if (!entries.some(([, v]) => isPartRef(v))) return { ok: true, tokens: refs };
  const occurrences = readOccurrences(path.join(session.workdir, `.${part}.step.glb`));
  // @零件#~穩定名稱 要查這次建置的名稱表(sidecar);其他寫法用不到,不讀
  const names = entries.some(([, v]) => String(v).includes("#~")) ? readBuildMeta(session, part)?.names || null : null;
  const tokens = {};
  for (const [key, value] of entries) {
    const r = resolveSelector(value, occurrences, names);
    if (!r.ok) return { ok: false, error: `${key}: ${r.error}`, candidates: r.candidates };
    tokens[key] = r.token;
  }
  return { ok: true, tokens };
}

export function buildCadchatServer({ session, emit, signal }) {
  const n = () => session.lastName || "part";
  const clarifyGate = makeClarifyGate(session);
  // 派工實驗:子代理發的 cad_build/cad_validate 卡標 sub:true(runner 從子代理 stream_event
  // 收 tool_use id;CLI 每次 MCP 呼叫帶 _meta["claudecode/toolUseId"])。純裝飾,缺 _meta 即無。
  const subTag = (extra) => {
    try {
      const id = extra?._meta?.["claudecode/toolUseId"];
      return id && session._subToolUseIds?.has(id) ? { sub: true } : {};
    } catch {
      return {};
    }
  };

  return createSdkMcpServer({
    name: "cadchat",
    version: "1.0.0",
    tools: [
      // ---- UI 訊號(emit_stage/spec/clarify/retry 與草模工具集共用)----
      ...makeUiTools({ session, emit }),
      tool(
        "emit_plan",
        "宣告執行步驟清單。",
        { steps: z.array(z.object({ n: z.number().int(), t: z.string() })) },
        async ({ steps }) => {
          emit("plan", { steps });
          return result({ ok: true });
        },
      ),
      tool(
        "emit_params",
        "宣告參數輸入欄(鍵須對應產生器 PARAMS)。整數參數(顆數/口袋數/齒數等)必標 int:true——UI 據此鎖整數輸入。",
        {
          defs: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              unit: z.string().optional(),
              min: z.number(),
              max: z.number(),
              step: z.number(),
              value: z.number(),
              int: z.boolean().optional(),
            }),
          ),
        },
        async ({ defs }) => {
          session._paramsEmitted = true;
          emit("params", { defs });
          return result({ ok: true });
        },
      ),
      tool(
        "emit_lesson_offer",
        "修正『驗證全綠卻看圖才發現』的缺陷後,問使用者是否把它記成教訓(對話流是/否卡)。" +
          "symptom=原本錯在哪、rootCause=為何是決定性可預防的且驗證為何沒攔到、fix=下次正確寫法" +
          "(具體到 API)、tag=短主題 slug(如 mirror-symmetry)。只在使用者回饋的視覺/幾何缺陷" +
          "且該缺陷通過了驗證時用;build/validate 紅燈的自修已自動記錄,不要為它發卡。",
        {
          symptom: z.string(),
          rootCause: z.string(),
          fix: z.string(),
          tag: z.string(),
        },
        async ({ symptom, rootCause, fix, tag }) => {
          // 停用時不出卡(避免「卡出了按了沒反應」);出卡不寫任何東西,提交交給按鈕。
          if (!lessonsEnabled()) return result({ ok: false, note: "教訓系統已停用,未出卡。" });
          emit("lesson_offer", {
            symptom: unescapeNewlines(symptom),
            rootCause: unescapeNewlines(rootCause),
            fix: unescapeNewlines(fix),
            tag: String(tag || "").trim(),
          });
          return result({ ok: true, note: "已請使用者確認是否加入教訓。" });
        },
      ),

      // ---- 做事 ----
      tool(
        "cad_import",
        "把 models/ 下既有 STEP 元件複製進工作區 imported/,回相對路徑(組合件用它引用)與 bbox/面數摘要。",
        { file: z.string() },
        async ({ file }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const id = toolId();
          const short = String(file).split("/").pop();
          emit("tool", { id, name: `cad.import(${short})`, label: "匯入元件", status: "running" });
          const imp = importStepIntoSession(session, file);
          if (!imp.ok) {
            emit("tool", { id, status: "error", note: imp.error });
            return result({ ok: false, error: imp.error });
          }
          if (!session.imports.includes(imp.rel)) session.imports.push(imp.rel);
          const facts = await inspectFacts(session, imp.rel, { signal });
          emit("tool", {
            id,
            status: "done",
            note: imp.reused ? `${imp.rel}(已存在,重用)` : imp.rel,
            outputs: [{ path: imp.rel, kind: "step" }],
          });
          return result({ ok: true, rel: imp.rel, label: imp.label, facts });
        },
      ),
      tool(
        "cad_source_part",
        "選用標準件。requirement 鍵(依 family):cylinder={load_N,stroke_mm,pressure_bar?,action?=push|pull|double,body_shape?=round|square|null(圓身預設/薄型方身如 SMC CQ2/不限)} bearing={shaft_dia,radial_load_N?} stepper={torque_Nm}(與保持扭矩比;運轉可用扭矩較低,所需扭矩先乘安全係數) linear_guide={load_N,rail_len}(load_N 直接與額定動負荷比,不含安全係數——傳單顆滑塊等效負載×3–5) ball_screw={load_N,travel,target_speed_mm_s,accuracy?,rated_rpm?}(導程由速度÷rated_rpm 反推;rated_rpm 預設 3000=伺服,步進馬達帶 600) gripper={grip_force_N,opening_mm,pressure_MPa?}(平行氣爪) gear={torque_Nm,shaft_dia?,teeth_min?}(正齒輪,容許轉矩取彎曲/齒面耐久較小者)。",
        { family: z.string(), requirement: z.record(z.string(), z.any()).optional() },
        async ({ family, requirement }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const id = toolId();
          emit("tool", { id, name: `parts.select_${family}`, label: "選用標準件", status: "running" });
          const res = await spawnPython(
            "apps/cad-chat/src/server/cad/select_part.py",
            [family, JSON.stringify(requirement || {})],
            { session, signal },
          );
          let parsed;
          try {
            parsed = JSON.parse(res.stdout.trim().split("\n").pop());
          } catch {
            parsed = { ok: false, reason: res.stderr.slice(-200) || "解析失敗" };
          }
          emit("tool", {
            id,
            status: parsed.ok ? "done" : "error",
            note: parsed.ok ? `${family} 已選定` : parsed.reason,
          });
          return result(parsed);
        },
      ),
      tool(
        "cad_build",
        "寫產生器原始碼(code)並執行產 STEP+GLB;或給 edits([{find,replace}] 逐字唯一比對)對既有產生器做最小段精修;或只給 params 做參數重生。",
        {
          name: z.string().optional(),
          code: z.string().optional(),
          edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional(),
          params: z.record(z.string(), z.number()).optional(),
        },
        async ({ name, code, edits, params }, extra) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          const sub = subTag(extra);
          // 教訓案例:記本次修法(kind+edits 摘要),成功時回填給被閉環的失敗案例
          noteFixAttempt(session, { kind: code ? "code" : edits?.length ? "edits" : "params", edits });
          if (code) {
            writeGenerator(session, part, code);
          } else if (edits?.length) {
            const r = applyEdits(session, part, edits);
            if (!r.ok) {
              recordApplyFailure(session, { part, kind: "edits", error: r.error });
              emit("tool", { id, name: `cad.build(${part}.py)`, label: "精修重生", status: "error", note: r.error });
              return result({ ok: false, error: r.error });
            }
          } else if (params) {
            // 此路徑 build 失敗刻意不回滾(對照 chat.mjs deterministicRegen 的
            // buildOrRollback):agent 拿到 stderr 後通常接著 edits 修,背後把
            // PARAMS 還原會讓它「參數已套上」的心智模型錯位。
            const r = rewriteParams(session, part, params);
            if (!r.ok) {
              recordApplyFailure(session, { part, kind: "params", error: r.error });
              emit("tool", { id, name: `cad.build(${part}.py)`, label: "參數重生", status: "error", note: r.error });
              return result({ ok: false, error: r.error });
            }
          } else {
            return result({ ok: false, error: "需要 code、edits 或 params" });
          }
          emit("tool", {
            id,
            name: `cad.build(${part}.py)`,
            label: "撰寫幾何 → 執行 → 產出",
            status: "running",
            ...sub,
            code:
              code ||
              (edits?.length
                ? `# 精修 ${edits.length} 段\n${edits.map((e) => `# - ${e.find.split("\n")[0].slice(0, 60)}`).join("\n")}`
                : `# 參數重生 ${JSON.stringify(params)}`),
          });
          const res = await runStep(session, part, { signal });
          if (!res.ok) {
            // 中斷/斷線殺掉的子程序不是生成失敗,不記教訓案例(鏡射 runner 的 aborted 守衛)
            if (!signal?.aborted) {
              recordBuildFailure(session, { part, exitCode: res.exitCode, stderr: res.stderr, source: "build" });
            }
            // note 給人看(縮成例外摘要);回 agent 的 stderr 保留完整尾段供修碼
            emit("tool", { id, status: "error", note: condenseTraceback(res.stderr, { generatorName: part }), ms: res.ms });
            return result({ ok: false, exitCode: res.exitCode, stderr: (res.stderr || "").slice(-1500) });
          }
          noteBuildSuccess(session); // 同 turn 前面的 build 失敗至此閉環
          session.lastName = part;
          emit("tool", {
            id,
            status: "done",
            ms: res.ms,
            outputs: [
              { path: `${part}.step`, kind: "step" },
              { path: `.${part}.step.glb`, kind: "glb" },
            ],
          });
          // delta:這次建出來的東西與上一次成功建置的差異(零件數、哪些件改了/移動了、包絡)。
          return result({
            ok: true,
            name: part,
            stepRel: res.stepRel,
            ...(res.delta ? { delta: res.delta } : {}),
            log: (res.log || "").slice(-1200),
          });
        },
      ),
      tool(
        "cad_validate",
        "快速結構驗證:讀 build 自檢結果與 MOTION 宣告(干涉/掃掠等幾何細檢由使用者精算/匯出閘執行,回合內標 SKIP 屬正常),回傳逐項清單。",
        { name: z.string().optional() },
        async ({ name }, extra) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = name || n();
          session._valAttempt = (session._valAttempt || 0) + 1;
          // 一律快路徑:零 spawn(build sidecar 直讀;缺 sidecar 內部退回 --motion-only)。
          // 完整驗證(inspect ∥ validate.py 掃掠)由「精算此版」與匯出閘承擔。
          const { ok, checks, motion, partCount, ms, design } = await runValidateDesign(
            session,
            part,
            { signal },
          );
          if (partCount > 0) session.lastPartCount = partCount; // 規模分級(決定性)
          // 教訓案例:每顆真的 FAIL 的檢查一筆(快路徑的紅只可能來自 --motion-only
          // fallback);中斷殺掉的 validate.py 會產出幽靈紅,不記。閉環:零 spawn 的
          // 全 skipped 是空洞綠不算真成功;fallback(design 旗標缺席=真 spawn 過)
          // 的綠才閉環 validate 類案例——精算/匯出閘跑在 turn 外,接不到 recorder,
          // 那邊的紅綠不進教訓迴圈(已知限制,README 教訓章有記)。
          if (!signal?.aborted) {
            for (const c of checks) {
              if (!c.skipped && !c.ok) recordCheckFailure(session, { part, check: c, partCount, source: "validate" });
            }
            if (ok && !design) noteValidateSuccess(session);
          }
          const decorated = decorateChecks(checks);
          emit("validate", {
            ok,
            attempt: session._valAttempt,
            ms,
            partCount,
            name: part,
            ...subTag(extra),
            checks: decorated.map(checkView),
          });
          // 一律發 motion(空 dofs = 清除舊宣告),防止重生成靜態件後播放鈕殘留
          emit("motion", motionEvent(part, motion));
          return result({ ok, checks, motionDeclared: !!motion?.dofs?.length });
        },
      ),
      tool(
        "cad_present",
        "把最新產物載入 3D 畫布並出產物卡(計為新版本)。",
        { name: z.string().optional() },
        async ({ name }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = name || n();
          const r = emitPresent(session, part, emit);
          // agent 沒宣告滑桿時的決定性 fallback:直接從 PARAMS 解析
          if (!session._paramsEmitted) {
            const defs = paramDefsFromGenerator(session, part);
            if (defs.length) {
              session._paramsEmitted = true;
              emit("params", { defs });
            }
          }
          session._valAttempt = 0;
          return result({ ok: true, ...r });
        },
      ),
      tool(
        "cad_measure",
        "量測兩個幾何參考間的有號距離(read-only)。參考可寫位置 token(#o1.2 / #o1.f3)或零件名稱(@arm、@gantry/arm、同名第 2 個 @bolt.2、arm 的第 3 個面 @arm#f3);名稱對不上或不只一個時會列出候選。使用者點選時附的穩定參照(@arm#~3fa9c2d1e0)也可直接用,它在重建後仍指同一個面。無法推斷共同軸時會回錯誤,請帶 axis 重試。",
        {
          from: z.string(),
          to: z.string(),
          axis: z.enum(["x", "y", "z"]).optional(),
          name: z.string().optional(),
        },
        async ({ from: fromRef, to: toRef, axis, name }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          const sel = resolveSelectors(session, part, { from: fromRef, to: toRef });
          if (!sel.ok) {
            emit("tool", { id, name: `cad.measure(${fromRef} → ${toRef})`, label: "量測", status: "error", note: sel.error });
            return result(sel);
          }
          const { from, to } = sel.tokens;
          emit("tool", { id, name: `cad.measure(${fromRef} → ${toRef})`, label: "量測", status: "running" });
          const args = [
            "measure", `${session.workdirRel}/${part}.step`,
            "--from", from, "--to", to, "--format", "json",
          ];
          if (axis) args.push("--axis", axis);
          const res = await spawnPython("skills/cad/scripts/inspect", args, { session, signal });
          let parsed;
          try {
            parsed = JSON.parse(res.stdout);
          } catch {
            parsed = { ok: false, error: (res.stderr || res.stdout).slice(-300) || "量測失敗" };
          }
          const measured = parsed.measurement?.signedDistance;
          emit("tool", {
            id,
            status: parsed.ok ? "done" : "error",
            note: parsed.ok
              ? (measured != null ? `距離 ${Math.round(measured * 100) / 100} mm` : undefined)
              : parsed.errors?.[0]?.message || parsed.error || "量測失敗",
          });
          return result(parsed);
        },
      ),
      tool(
        "cad_snapshot",
        "看圖:把目前的模型畫成圖片回給你(read-only)。每個零件一個顏色,回傳的 legend 說明哪個顏色是哪個零件。views 最多 4 個,可用 " +
          SNAPSHOT_VIEWS.join("/") +
          " 或「方位角:仰角」(度,例 45:30);ghost 的零件畫成半透明(看殼裡面);hide 的零件不畫;clip 把指定軸座標正的那一側切掉看剖面;pose 擺到已宣告的具名姿態;mode=wire 是線框。",
        {
          name: z.string().optional(),
          views: z.array(z.string()).max(4).optional(),
          ghost: z.array(z.string()).optional(),
          hide: z.array(z.string()).optional(),
          clip: z.object({ axis: z.enum(["x", "y", "z"]), at: z.number() }).optional(),
          pose: z.string().optional(),
          mode: z.enum(["shaded", "wire"]).optional(),
        },
        async ({ name, views, ghost, hide, clip, pose, mode }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          const wanted = (views?.length ? views : ["iso"]).slice(0, 4);
          emit("tool", { id, name: `cad.snapshot(${wanted.join(", ")})`, label: "看圖", status: "running" });
          const snap = await runSnapshot(session, part, { views: wanted, ghost, hide, clip, pose, mode, signal });
          if (!snap.ok) {
            emit("tool", { id, status: "error", note: snap.error, ms: snap.ms });
            return result({ ok: false, error: snap.error });
          }
          emit("tool", {
            id,
            status: "done",
            ms: snap.ms,
            note: `${snap.views.length} 張${snap.pose ? ` · 姿態 ${snap.pose}` : ""}`,
            // 使用者也看得到 agent 看的是哪幾張(對話裡的工具卡顯示縮圖)
            images: snap.views.map((v) => ({ view: v.view, url: `${BASE_PATH}/api/asset?file=${encodeURIComponent(v.file)}` })),
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  views: snap.views.map((v) => v.view),
                  legend: snap.legend,
                  pose: snap.pose,
                  note: "圖片依 views 的順序附在後面。尺寸與距離不要從圖上讀,用量測工具或 check_geometry 的斷言。",
                }),
              },
              ...snap.views.map((v) => ({ type: "image", data: v.png.toString("base64"), mimeType: "image/png" })),
            ],
          };
        },
      ),
      tool(
        "cad_align",
        "計算對齊 delta(read-only,只算不動幾何):moving/target 為 selector token 或零件名稱(@arm 這種,寫法同 cad_measure)。mode ∈ flush|center|axis:flush/center 回平移;axis 回旋轉(axis-angle+pivot+eulerXYZDeg)加徑向對心平移,把 moving 的方向(圓柱軸/線/法向/occurrence frame)轉到 target 方向。把 delta 落到產生器定位常數(cad_build edits),勿手算座標;沿軸定位用 flush 補。",
        {
          moving: z.string(),
          target: z.string(),
          mode: z.enum(["flush", "center", "axis"]).optional(),
          axis: z.enum(["x", "y", "z"]).optional(),
          offset: z.number().optional(),
          name: z.string().optional(),
        },
        async ({ moving: movingRef, target: targetRef, mode, axis, offset, name }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          const sel = resolveSelectors(session, part, { moving: movingRef, target: targetRef });
          if (!sel.ok) {
            emit("tool", { id, name: `cad.align(${movingRef} → ${targetRef})`, label: "對齊計算", status: "error", note: sel.error });
            return result(sel);
          }
          const { moving, target } = sel.tokens;
          emit("tool", { id, name: `cad.align(${movingRef} → ${targetRef})`, label: "對齊計算", status: "running" });
          const args = [
            "align", `${session.workdirRel}/${part}.step`,
            "--moving", moving, "--target", target,
            "--mode", mode || "flush", "--format", "json",
          ];
          if (axis) args.push("--axis", axis);
          if (offset != null) args.push("--offset", String(offset));
          const res = await spawnPython("skills/cad/scripts/inspect", args, { session, signal });
          let parsed;
          try {
            parsed = JSON.parse(res.stdout);
          } catch {
            parsed = { ok: false, error: (res.stderr || res.stdout).slice(-300) || "對齊計算失敗" };
          }
          const rot = parsed.alignment?.rotation;
          emit("tool", {
            id,
            status: parsed.ok ? "done" : "error",
            note: parsed.ok
              ? (rot ? `旋轉 ${Math.round(rot.angleDeg * 10) / 10}°(${rot.variant})` : undefined)
              : parsed.errors?.[0]?.message || parsed.error || "對齊計算失敗",
          });
          return result(parsed);
        },
      ),
      tool(
        "cad_export",
        "匯出 stl/3mf/glb/dxf/pdf(下游,需要才用)。dxf=鈑金展開圖:產生器須有 gen_dxf()(SheetMetal 件回 sm.dxf())。pdf=四視圖工程圖(俯/前/側/等角+包絡尺寸標註)。",
        { name: z.string().optional(), format: z.enum(["stl", "3mf", "glb", "dxf", "pdf"]) },
        async ({ name, format }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          const target = `${session.workdirRel}/${part}.py`;
          const out = `${session.workdirRel}/${part}.${format}`;
          const isDxf = format === "dxf";
          const flag = { stl: "--stl", "3mf": "--3mf", glb: "--glb" }[format];
          if (isDxf && !generatorHasDxf(session, part)) {
            emit("tool", { id, name: "cad.export(dxf)", label: "匯出", status: "error", note: "產生器沒有 gen_dxf(),無展開圖可匯" });
            return result({
              ok: false,
              error: "產生器沒有 gen_dxf();鈑金件請補 def gen_dxf(): return _build().dxf() 再匯。",
            });
          }
          emit("tool", { id, name: `cad.export(${format})`, label: "匯出", status: "running" });
          // 匯出閘(與 /api/export 同一不變式:出檔的東西必然驗過):頂層當前產物
          // 未經 full 驗證(或驗的是別件/基準已漂移)→ 先補跑完整驗證;未過 → 拒絕
          // 出檔並把 checks 回給 agent 自修——agent 這條出口不得繞過閘。
          const lv = session._lastValidate;
          if (!(lv && lv.full && lv.ok && lv.name === part && !session._geomDirty)) {
            const val = await runValidate(session, part, { signal });
            if (val.partCount > 0) session.lastPartCount = val.partCount;
            const dec = decorateChecks(val.checks || []);
            emit("validate", {
              ok: val.ok,
              attempt: session._valAttempt || 1,
              ms: val.ms,
              partCount: val.partCount,
              checks: dec.map(checkView),
            });
            if (!val.ok || signal?.aborted) {
              emit("tool", { id, status: "error", note: "匯出已擋下:完整驗證未過(見驗證卡)。" });
              return result({
                ok: false,
                error: "匯出閘:完整幾何驗證未過,不得出檔;先修復未過項再匯。",
                checks: val.checks,
              });
            }
          }
          // dxf 走 skills/dxf CLI 跑 gen_dxf()(寫兄弟檔 <part>.dxf);pdf 走
          // drawing_pdf.py 對既有 STEP 做 HLR 四視圖;其餘走 scripts/step 的
          // mesh sidecar
          const res = isDxf
            ? await spawnPython("skills/dxf/scripts/dxf", [target], { session, signal })
            : format === "pdf"
              ? await spawnPython(
                  "apps/cad-chat/src/server/cad/drawing_pdf.py",
                  [`${session.workdirRel}/${part}.step`, "--out", out],
                  { session, signal },
                )
              : await spawnPython("skills/cad/scripts/step", [target, flag, out, "--force"], {
                  session,
                  signal,
                });
          const ok = res.code === 0;
          emit("tool", {
            id,
            status: ok ? "done" : "error",
            outputs: ok ? [{ path: `${part}.${format}`, kind: format }] : undefined,
            note: ok ? undefined : condenseTraceback(res.stderr, { generatorName: part }),
          });
          if (ok) emit("artifact_format", { format: format.toUpperCase() });
          return result({ ok });
        },
      ),
    ],
  });
}
