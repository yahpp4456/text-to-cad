// 頂層狀態(useReducer),鏡射設計稿 DCLogic.state。
import { normalizeMode } from "../lib/chatModes.js";
import { pendingClarifyFromItems } from "../lib/clarifyText.js";

export const initialState = {
  _seq: 0,
  sessionId: null,
  // 模式:「design」真幾何 CAD(現行)|「sketch」草模(快速機構示意)。
  // per-session 恆定屬性——切換=開新對話;RESET 保留(新對話沿用當前模式)。
  mode: "design",
  phase: "idle", // idle | running | done
  running: false,
  stageIdx: -1, // 驅動 StageStepper(D)
  items: [], // 對話 transcript
  // verified 由 server versionStamp 發(三態:undefined=未知,舊快照/opened 檔)
  versions: [], // [{ id:'v1', name, glbUrl, formats, verified? }]
  activeVer: null,
  // type: "part" | "assembly" | ""(未知,藏 badge);source: "generated" | "opened"
  // projectDir:唯讀檢視的檔案若屬可編輯專案(有 gen_step),存其目錄 rel;submitText
  // 據此「自動帶入編輯」。非專案檢視/一般產出 = null。
  // flatGlbUrl:鈑金件(有 gen_flat)的攤平預覽 GLB;非 null → 3D 視圖出摺疊/攤平切換鈕。
  // flatLinesUrl:折彎線 sidecar;攤平態疊虛線 overlay 用。
  // sweepPathsUrl:掃出路徑 sidecar(SWEEP_PATHS);非 null → 3D 視圖疊路徑虛線 overlay + 「⌒ 路徑」chip。
  // sceneUrl:草模場景 JSON(type:"sketch" 的版本);SketchCanvas3D 據此載入播放。
  canvas: { glbUrl: "", name: "", code: "", ver: "", status: "empty", type: "", source: "", projectDir: null, flatGlbUrl: null, flatLinesUrl: null, sweepPathsUrl: null, sceneUrl: null }, // status: empty|loading|ready|error
  params: { defs: [], values: {}, dirty: false },
  pickRefs: [], // [{token,label}] 帶入對話的幾何參考(多選;UI 上限 4,去重,超限丟最舊)
  propsOpen: false,
  selNode: null,
  live: null, // { text } 進行中活動列(僅 running 時顯示)
  prefill: null, // 點規格 chip → 預填 composer 的文字
  // 運動宣告(validate 後由後端決定性發出;forVer 在 PRESENT 時蓋上 → 版本切換
  // 或跳過 validate 的 present 自動不顯示播放鈕,不需清理邏輯)
  motion: null, // { name, dofs, forVer } | null
  // 視圖區兩步精靈的資料(ADD_USER 即視為已回答);id 由 reducer mint,React key
  // 用它管精靈 remount(跨回合連續 clarify 自動歸零 step/edits);specs 併自 turnSpec。
  clarify: null, // { id, q, opts, suggested, specs } | null
  turnSpec: null, // 本回合最新 emit_spec 的 chips(START_RUN 清空;SET_CLARIFY 併進 clarify.specs)
};

function nextId(state) {
  return { seq: state._seq + 1, id: `m${state._seq + 1}` };
}

function patchTool(items, id, patch) {
  let found = false;
  const next = items.map((it) => {
    if (it.type === "tool" && it.id === id) {
      found = true;
      return { ...it, ...patch };
    }
    return it;
  });
  return { items: next, found };
}

export function reducer(state, action) {
  switch (action.type) {
    case "SET_SESSION":
      return { ...state, sessionId: action.sessionId ?? state.sessionId };

    // 模式切換(切換器/開機還原/伺服端 session 事件校正);非法值收斂 design。
    case "SET_MODE":
      return { ...state, mode: normalizeMode(action.mode) };

    case "ADD_USER": {
      const { seq, id } = nextId(state);
      return {
        ...state,
        _seq: seq,
        clarify: null, // 任何送出=已回答選擇題(對齊 server 端 _clarifyPending 新 turn 重設)
        items: [
          ...state.items,
          // images:附件縮圖 [{url,name}](/api/asset URL;RESTORE 原樣回灌,GC 後破圖走降級)
          {
            type: "user",
            id,
            text: action.text,
            ref: action.ref || "",
            images: action.images || [],
          },
        ],
      };
    }

    case "START_RUN":
      // turnSpec 清空:精靈只信「本回合」的規格快照——沒新 emit_spec 就不再要求確認舊規格
      return { ...state, running: true, phase: "running", live: { text: "思考中…" }, turnSpec: null };

    case "END_RUN":
      return {
        ...state,
        running: false,
        live: null,
        // 收掉還開著的串流氣泡(中斷/斷線時)
        items: state.items.map((it) =>
          it.type === "ai" && it.streaming ? { ...it, streaming: false } : it,
        ),
        phase: state.versions.length ? "done" : "idle",
      };

    case "SET_LIVE":
      return { ...state, live: action.live };

    case "AI_STREAM_START": {
      const last = state.items[state.items.length - 1];
      // 已有開著的串流氣泡就沿用(同一則訊息的第二個 text 區塊),隔行續寫。
      if (last && last.type === "ai" && last.streaming) {
        return {
          ...state,
          live: null,
          items: state.items.map((it, i) =>
            i === state.items.length - 1 ? { ...it, text: `${it.text}\n\n` } : it,
          ),
        };
      }
      const { seq, id } = nextId(state);
      return {
        ...state,
        _seq: seq,
        live: null,
        items: [...state.items, { type: "ai", id, text: "", streaming: true }],
      };
    }

    case "AI_STREAM_DELTA": {
      const idx = state.items.length - 1;
      const last = state.items[idx];
      if (!last || last.type !== "ai" || !last.streaming) {
        // 沒有開著的氣泡(邊界情況):直接開一個。
        const { seq, id } = nextId(state);
        return {
          ...state,
          _seq: seq,
          items: [...state.items, { type: "ai", id, text: action.text, streaming: true }],
        };
      }
      return {
        ...state,
        items: state.items.map((it, i) =>
          i === idx ? { ...it, text: it.text + action.text } : it,
        ),
      };
    }

    case "AI_FINALIZE": {
      // 完整訊息到達:若最後一項是串流氣泡,以最終文字取代並收斂;否則新增。
      const idx = state.items.length - 1;
      const last = state.items[idx];
      if (last && last.type === "ai" && last.streaming) {
        return {
          ...state,
          items: state.items.map((it, i) =>
            i === idx ? { ...it, text: action.text, streaming: false } : it,
          ),
        };
      }
      if (!action.text || !String(action.text).trim()) return state;
      const { seq, id } = nextId(state);
      return {
        ...state,
        _seq: seq,
        items: [...state.items, { type: "ai", id, text: action.text }],
      };
    }

    case "SET_PREFILL":
      return { ...state, prefill: action.text };

    case "CLEAR_PREFILL":
      return { ...state, prefill: null };

    case "SET_STAGE":
      return { ...state, stageIdx: action.index };

    case "ADD_ITEM": {
      const { seq, id } = nextId(state);
      return {
        ...state,
        _seq: seq,
        items: [...state.items, { id, ...action.item }],
      };
    }

    case "TOGGLE_ITEM":
      return {
        ...state,
        items: state.items.map((it) =>
          it.id === action.id ? { ...it, open: !it.open } : it,
        ),
      };

    // 人工記教訓「是/否卡」作答:標記該卡 answered(added|skipped);冪等,答過即 disabled。
    // 非阻塞——不進 busy、不像 clarify 那樣 gate turn;answered 隨 RESTORE items 快照存活。
    case "ANSWER_LESSON_OFFER":
      return {
        ...state,
        items: state.items.map((it) =>
          it.id === action.id && it.type === "lesson_offer"
            ? { ...it, answered: action.outcome }
            : it,
        ),
      };

    case "UPSERT_TOOL": {
      const { id, patch } = action;
      const { items, found } = patchTool(state.items, id, patch);
      if (found) return { ...state, items };
      return {
        ...state,
        items: [...state.items, { type: "tool", id, open: false, ...patch }],
      };
    }

    case "ADD_VERSION": {
      // 撞 id 以「新版本物件取代」而非保留舊的:唯一撞號源是對話中途 open-project
      // (新 session 版號從 v1 重起)——保留舊物件會把伺服端權威 stamp
      // (verified/glbUrl/name)靜默丟棄 → 假 badge。
      // 重複事件重放(同內容)取代=冪等,語意不變。
      const exists = state.versions.some((v) => v.id === action.version.id);
      return {
        ...state,
        versions: exists
          ? state.versions.map((v) => (v.id === action.version.id ? action.version : v))
          : [...state.versions, action.version],
        activeVer: action.version.id,
      };
    }

    // 精算成功(full 驗證全過)→ 該版翻成已驗證(badge 琥珀→綠)。id 不存在天然 no-op。
    case "MARK_VERSION_VERIFIED":
      return {
        ...state,
        versions: state.versions.map((v) =>
          v.id === action.id ? { ...v, verified: true } : v,
        ),
      };

    case "SELECT_VERSION": {
      const v = state.versions.find((x) => x.id === action.id);
      if (!v) return state;
      // 同 glbUrl(草模版=同 sceneUrl)保留現有 status:viewport 只依賴 URL,URL 沒變
      // 不會重載,設 "loading" 就永遠等不到 ready(重複開同檔的檢視版、點已啟用的
      // chip 都會踩)。
      const sameUrl =
        (v.glbUrl || v.sceneUrl || "") === (state.canvas.glbUrl || state.canvas.sceneUrl || "");
      return {
        ...state,
        activeVer: v.id,
        canvas: {
          ...state.canvas,
          glbUrl: v.glbUrl || "",
          name: v.name,
          code: v.name, // 不繼承前一個模型的 code(版本物件無獨立 code,各路徑 code===name)
          ver: v.id,
          status: sameUrl ? state.canvas.status : "loading",
          type: v.type || "",
          source: v.source || "",
          projectDir: v.projectDir ?? null, // 切到唯讀專案檢視版 → 帶回其升級目錄
          flatGlbUrl: v.flatGlbUrl ?? null, // 切版帶回該版攤平 GLB(非鈑金版=null)
          flatLinesUrl: v.flatLinesUrl ?? null, // 切版帶回該版折彎線
          sweepPathsUrl: v.sweepPathsUrl ?? null, // 切版帶回該版掃出路徑 overlay
          sceneUrl: v.sceneUrl ?? null, // 草模版帶回場景 JSON(CAD 版=null)
        },
      };
    }

    case "PRESENT": {
      const motion =
        state.motion && state.motion.name === action.name && state.motion.forVer == null
          ? { ...state.motion, forVer: action.ver || "" }
          : state.motion;
      return {
        ...state,
        motion,
        canvas: {
          glbUrl: action.glbUrl || "",
          name: action.name || state.canvas.name,
          code: action.code || state.canvas.code,
          ver: action.ver || state.canvas.ver,
          // 同 URL 保留現有 status(同 SELECT_VERSION 的理由;重複開同一檔會走到這)
          status:
            (action.glbUrl || action.sceneUrl || "") ===
            (state.canvas.glbUrl || state.canvas.sceneUrl || "")
              ? state.canvas.status
              : "loading",
          type: action.fileType || "", // 未帶類型就藏 badge(誠實,不繼承舊模型的)
          source: action.source || "generated",
          projectDir: action.projectDir ?? null, // openFile 唯讀檢視帶入;其餘路徑 null
          flatGlbUrl: action.flatGlbUrl ?? null, // 鈑金攤平 GLB(present 帶;非鈑金=null)
          flatLinesUrl: action.flatLinesUrl ?? null, // 折彎線 sidecar
          sweepPathsUrl: action.sweepPathsUrl ?? null, // 掃出路徑 sidecar(present 帶;無=null)
          sceneUrl: action.sceneUrl ?? null, // 草模場景 JSON(present type:"sketch" 帶)
        },
      };
    }

    case "SET_CANVAS_STATUS":
      return { ...state, canvas: { ...state.canvas, status: action.status } };

    case "SET_PARAMS": {
      const values = {};
      for (const d of action.defs) values[d.key] = d.value;
      return { ...state, params: { defs: action.defs, values, dirty: false } };
    }

    case "SET_PARAM_VALUE":
      return {
        ...state,
        params: {
          ...state.params,
          values: { ...state.params.values, [action.key]: action.value },
          dirty: true,
        },
      };

    case "CLEAR_PARAMS_DIRTY":
      return { ...state, params: { ...state.params, dirty: false } };

    // regen 失敗回滾:server 把滑桿值拉回磁碟真相(params_values 事件)。
    // 只 merge defs 已知鍵(defs 是 UI 真相,未知鍵沒有滑桿可顯示);清 dirty——
    // 目前值就是磁碟值,沒有「未套用的調整」。
    case "SET_PARAM_VALUES": {
      if (!state.params.defs.length) return state;
      const values = { ...state.params.values };
      for (const [k, v] of Object.entries(action.values || {})) {
        if (k in values && Number.isFinite(Number(v))) values[k] = Number(v);
      }
      return { ...state, params: { ...state.params, values, dirty: false } };
    }

    case "ADD_PICKREF": {
      const ref = action.pickRef;
      if (!ref?.token) return state;
      const rest = state.pickRefs.filter((r) => r.token !== ref.token); // 同 token 去重(移到最新)
      return { ...state, pickRefs: [...rest, ref].slice(-4) };
    }

    case "REMOVE_PICKREF":
      return { ...state, pickRefs: state.pickRefs.filter((r) => r.token !== action.token) };

    case "CLEAR_PICKREFS":
      return { ...state, pickRefs: [] };

    case "TOGGLE_PROPS":
      return { ...state, propsOpen: action.open ?? !state.propsOpen };

    case "SELECT_NODE":
      return { ...state, selNode: action.id };

    case "SET_TURN_SPEC":
      return { ...state, turnSpec: action.chips || null };

    case "SET_CLARIFY": {
      if (!action.clarify) return { ...state, clarify: null };
      // mint 遞增 id(精靈 remount key);specs 放 spread 前 → 煙測注入可覆寫
      const { seq } = nextId(state);
      return {
        ...state,
        _seq: seq,
        clarify: { id: `c${seq}`, specs: state.turnSpec, ...action.clarify },
      };
    }

    // 跨重整續聊:回灌 localStorage 快照。暫態欄位一律收斂(不還原 running/live/
    // pickRefs);_seq 取 max 防新訊息 id 撞還原的 items。clarify 例外:transcript
    // 尾端有「未答」的 clarify → re-arm 精靈(連同同段最近 spec),重整後浮卡/左欄
    // 凍結一致重現;已答(clarify 後有 user)不 re-arm。
    case "RESTORE": {
      const s = action.snapshot || {};
      const items = (Array.isArray(s.items) ? s.items : []).map((it) => {
        let out = it?.streaming ? { ...it, streaming: false } : it;
        // lesson_offer 樂觀暫態:「加入中」(answered:"pending")若在 POST 在途時
        // 關頁/崩潰會落盤——原樣回灌則 pendingLessonOffer 視它為「輪到中」,面板
        // 只渲染「加入中…」無按鈕,佇列頭永久死鎖。一律收斂回未答,恢復可重試。
        if (out?.type === "lesson_offer" && out.answered === "pending") {
          out = { ...out, answered: null };
        }
        return out;
      });
      const pendingClarify = pendingClarifyFromItems(items);
      // verified 三態 normalize:舊快照無欄位 → undefined(未知,不顯 badge)——
      // 絕不能預設 false,否則舊資料全掛「未驗證」誤報。舊快照的 mode 欄位(雙模式
      // 時代遺留)原樣透傳、無人讀取。
      const versions = (Array.isArray(s.versions) ? s.versions : []).map((v) => ({
        ...v,
        verified: typeof v?.verified === "boolean" ? v.verified : undefined,
      }));
      return {
        ...initialState,
        sessionId: s.sessionId || null,
        // mode normalize:白名單外一律 design(舊快照無欄位 → design,向後相容)
        mode: normalizeMode(s.mode),
        _seq: Math.max(Math.trunc(Number(s._seq)) || 0, items.length),
        items,
        versions,
        activeVer: s.activeVer || null,
        // 「畫布有內容」判定放寬:草模版只有 sceneUrl 沒有 glbUrl
        canvas: s.canvas?.glbUrl || s.canvas?.sceneUrl
          ? { ...initialState.canvas, ...s.canvas, status: "loading" }
          : { ...initialState.canvas },
        params: Array.isArray(s.params?.defs)
          ? { defs: s.params.defs, values: s.params.values || {}, dirty: false }
          : { ...initialState.params },
        motion: s.motion?.dofs?.length ? s.motion : null,
        clarify: pendingClarify ? { id: `c_restored_${items.length}`, ...pendingClarify } : null,
        stageIdx: versions.length ? 4 : -1,
        phase: versions.length ? "done" : "idle",
      };
    }

    // 對話中途換 session(open-project 開新 session):版本/運動/參數歸零,對話與
    // 畫布保留。舊 session 的 v* chip 若殘留,latestGen 會指向它——「精算此版」
    // 驗的是新 session 幾何卻 MARK 舊版(假 badge)、舊 chip 的匯出/回退拿新
    // sessionId 找不到快照必 404;新 session 的 v1 又與舊 v1 撞號互蓋。
    case "CLEAR_WORKSPACE":
      return {
        ...state,
        versions: [],
        activeVer: null,
        motion: null,
        params: { ...initialState.params },
        // 換 session=換設計:舊 spec 卡標 stale(latestSpecItem 會跳過)——否則
        // 舊設計的「解析規格」面板浮在新專案上,「套用修正」會把無關鍵值以
        // 「規格修正:」契約打進新 session;聊天指路(同 helper)一併熄滅。
        items: state.items.map((it) =>
          it?.type === "spec" && !it.stale ? { ...it, stale: true } : it,
        ),
      };

    // 「新對話」:回到初始狀態(對話/版本/畫布/參數/選取/運動/選擇題全清)。
    // mode 保留:正在草模腦暴的人開新對話,多半還要草模(切模式走 SET_MODE)。
    case "RESET":
      return { ...initialState, mode: state.mode };

    case "SET_MOTION":
      return {
        ...state,
        motion: action.motion?.dofs?.length
          ? { name: action.motion.name || "", dofs: action.motion.dofs, forVer: action.motion.forVer ?? null }
          : null,
      };

    default:
      return state;
  }
}
