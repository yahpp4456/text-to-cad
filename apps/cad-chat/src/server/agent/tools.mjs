// 每個 turn 建一個 in-process MCP server,工具 closures over 當前 session/emit/signal,
// 同步把 UI 事件 emit 到 SSE(不靠 re-parse stream,確保保序)。
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  applyEdits,
  decorateChecks,
  emitPresent,
  importStepIntoSession,
  inspectFacts,
  paramDefsFromGenerator,
  runStep,
  runValidate,
  runValidateDesign,
  rewriteParams,
  sanitizeName,
  writeGenerator,
} from "../cad/pipeline.mjs";
import { condenseTraceback, spawnPython } from "../cad/python.mjs";
import { unescapeNewlines } from "../../lib/clarifyText.js";
import {
  noteBuildSuccess,
  noteFixAttempt,
  noteValidateSuccess,
  noteRetry,
  recordApplyFailure,
  recordBuildFailure,
  recordCheckFailure,
} from "../lessons.mjs";

const result = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const toolId = () => `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export function buildCadchatServer({ session, emit, signal }) {
  const n = () => session.lastName || "part";
  // emit_clarify 之後,本回合任何建模工具一律拒絕(等使用者回答;prompt 紀律的程式閘門)。
  const clarifyGate = () =>
    session._clarifyPending
      ? result({
          ok: false,
          error: "已向使用者提問(emit_clarify),請結束本回合等待回答,不得先繼續建模。",
        })
      : null;

  return createSdkMcpServer({
    name: "cadchat",
    version: "1.0.0",
    tools: [
      // ---- UI 訊號 ----
      tool(
        "emit_stage",
        "推進頂部階段列。index:0=理解 1=規劃 2=生成 3=驗證 4=呈現。",
        { index: z.number().int().min(0).max(4) },
        async ({ index }) => {
          emit("stage", { index });
          return result({ ok: true });
        },
      ),
      tool(
        "emit_spec",
        "把解析到的規格丟成可點擊修正的 chips;你自行假設(使用者未給)的值標 assumed:true,v 不要再寫「(假設)」字樣。",
        { chips: z.array(z.object({ k: z.string(), v: z.string(), assumed: z.boolean().optional() })) },
        async ({ chips }) => {
          // choke point 正規化:模型可能在 tool JSON 寫字面 \n(雙重跳脫),原樣轉手會直接印在 UI。
          emit("spec", {
            chips: chips.map((c) => ({
              k: unescapeNewlines(c.k),
              v: unescapeNewlines(c.v),
              ...(c.assumed === true ? { assumed: true } : {}),
            })),
          });
          return result({ ok: true });
        },
      ),
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
        "emit_clarify",
        "向使用者提問(規格不足時)。呼叫後請結束本回合等待回答。",
        {
          question: z.string(),
          options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
          suggested: z.string().optional(),
        },
        async ({ question, options, suggested }) => {
          // 硬閘門:提問後本回合禁止再建模(見下方各 cad_* 工具的檢查)。
          session._clarifyPending = true;
          // choke point 正規化字面 \n;opts 的 label/value 與 suggested 會被原樣
          // 送回當使用者回覆,一併處理。
          emit("clarify", {
            q: unescapeNewlines(question),
            opts: (options || []).map((o) => ({
              label: unescapeNewlines(o.label),
              value: unescapeNewlines(o.value),
            })),
            suggested: unescapeNewlines(suggested || ""),
          });
          return result({ ok: true, awaiting: true, note: "已提問,請結束本回合等待使用者回答。" });
        },
      ),
      tool(
        "emit_retry",
        "驗證失敗自我修正時的說明橫幅。",
        {
          attempt: z.number().int(),
          reason: z.string(),
          adjustment: z.string().optional(),
        },
        async ({ attempt, reason, adjustment }) => {
          noteRetry(session, { attempt, reason, adjustment }); // 教訓案例:agent 自診
          emit("retry", { attempt, reason, adjustment: adjustment || "" });
          return result({ ok: true });
        },
      ),
      tool(
        "emit_params",
        "宣告參數滑桿(鍵須對應產生器 PARAMS)。",
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
            }),
          ),
        },
        async ({ defs }) => {
          session._paramsEmitted = true;
          emit("params", { defs });
          return result({ ok: true });
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
        "選用標準件。requirement 鍵(依 family):cylinder={load_N,stroke_mm,pressure_bar?,action?=push|pull|double} bearing={shaft_dia,radial_load_N?} stepper={torque_Nm} linear_guide={load_N,rail_len} ball_screw={load_N,travel,target_speed_mm_s,accuracy?} gripper={grip_force_N,opening_mm,pressure_MPa?}(平行氣爪) gear={torque_Nm,shaft_dia?,teeth_min?}(正齒輪,容許轉矩取彎曲/齒面耐久較小者)。",
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
        async ({ name, code, edits, params }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
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
          return result({ ok: true, name: part, stepRel: res.stepRel, log: (res.log || "").slice(-1200) });
        },
      ),
      tool(
        "cad_validate",
        "快速結構驗證:讀 build 自檢結果與 MOTION 宣告(干涉/掃掠等幾何細檢由使用者精算/匯出閘執行,回合內標 SKIP 屬正常),回傳逐項清單。",
        { name: z.string().optional() },
        async ({ name }) => {
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
            checks: decorated.map((c) => ({
              label: c.label,
              icon: c.icon,
              color: c.color,
              note: c.noteText,
              skipped: !!c.skipped,
            })),
          });
          // 一律發 motion(空 dofs = 清除舊宣告),防止重生成靜態件後播放鈕殘留
          emit("motion", { name: part, schemaVersion: 1, dofs: motion?.dofs || [] });
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
        "量測兩個幾何參考(selector token,如 #o1.2 / #o1.f3)間的有號距離(read-only)。無法推斷共同軸時會回錯誤,請帶 axis 重試。",
        {
          from: z.string(),
          to: z.string(),
          axis: z.enum(["x", "y", "z"]).optional(),
          name: z.string().optional(),
        },
        async ({ from, to, axis, name }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          emit("tool", { id, name: `cad.measure(${from} → ${to})`, label: "量測", status: "running" });
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
        "cad_align",
        "計算對齊 delta(read-only,只算不動幾何):moving/target 為 selector token。mode ∈ flush|center|axis:flush/center 回平移;axis 回旋轉(axis-angle+pivot+eulerXYZDeg)加徑向對心平移,把 moving 的方向(圓柱軸/線/法向/occurrence frame)轉到 target 方向。把 delta 落到產生器定位常數(cad_build edits),勿手算座標;沿軸定位用 flush 補。",
        {
          moving: z.string(),
          target: z.string(),
          mode: z.enum(["flush", "center", "axis"]).optional(),
          axis: z.enum(["x", "y", "z"]).optional(),
          offset: z.number().optional(),
          name: z.string().optional(),
        },
        async ({ moving, target, mode, axis, offset, name }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          emit("tool", { id, name: `cad.align(${moving} → ${target})`, label: "對齊計算", status: "running" });
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
        "匯出 stl/3mf/glb(下游)。dxf 需另寫 gen_dxf,本工具暫不支援。",
        { name: z.string().optional(), format: z.enum(["stl", "3mf", "glb"]) },
        async ({ name, format }) => {
          const gated = clarifyGate();
          if (gated) return gated;
          const part = sanitizeName(name || n());
          const id = toolId();
          const target = `${session.workdirRel}/${part}.py`;
          const out = `${session.workdirRel}/${part}.${format}`;
          const flag = { stl: "--stl", "3mf": "--3mf", glb: "--glb" }[format];
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
              checks: dec.map((c) => ({
                label: c.label,
                icon: c.icon,
                color: c.color,
                note: c.noteText,
                skipped: !!c.skipped,
              })),
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
          const res = await spawnPython("skills/cad/scripts/step", [target, flag, out, "--force"], {
            session,
            signal,
          });
          const ok = res.code === 0;
          emit("tool", {
            id,
            status: ok ? "done" : "error",
            outputs: ok ? [{ path: `${part}.${format}`, kind: format }] : undefined,
            note: ok ? undefined : (res.stderr || "").slice(-300),
          });
          if (ok) emit("artifact_format", { format: format.toUpperCase() });
          return result({ ok });
        },
      ),
    ],
  });
}
