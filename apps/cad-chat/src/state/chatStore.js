// 頂層狀態(useReducer),鏡射設計稿 DCLogic.state。
export const initialState = {
  _seq: 0,
  sessionId: null,
  phase: "idle", // idle | running | done
  running: false,
  stageIdx: -1, // 驅動 StageStepper(D)
  items: [], // 對話 transcript
  versions: [], // [{ id:'v1', name, glbUrl, formats }]
  activeVer: null,
  // type: "part" | "assembly" | ""(未知,藏 badge);source: "generated" | "opened"
  canvas: { glbUrl: "", name: "", code: "", ver: "", status: "empty", type: "", source: "" }, // status: empty|loading|ready|error
  params: { defs: [], values: {}, dirty: false },
  pickRefs: [], // [{token,label}] 帶入對話的幾何參考(多選;UI 上限 4,去重,超限丟最舊)
  propsOpen: false,
  selNode: null,
  live: null, // { text } 進行中活動列(僅 running 時顯示)
  prefill: null, // 點規格 chip → 預填 composer 的文字
  // 運動宣告(validate 後由後端決定性發出;forVer 在 PRESENT 時蓋上 → 版本切換
  // 或跳過 validate 的 present 自動不顯示播放鈕,不需清理邏輯)
  motion: null, // { name, dofs, forVer } | null
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

    case "ADD_USER": {
      const { seq, id } = nextId(state);
      return {
        ...state,
        _seq: seq,
        items: [
          ...state.items,
          { type: "user", id, text: action.text, ref: action.ref || "" },
        ],
      };
    }

    case "START_RUN":
      return { ...state, running: true, phase: "running", live: { text: "思考中…" } };

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
      const exists = state.versions.some((v) => v.id === action.version.id);
      return {
        ...state,
        versions: exists ? state.versions : [...state.versions, action.version],
        activeVer: action.version.id,
      };
    }

    case "SELECT_VERSION": {
      const v = state.versions.find((x) => x.id === action.id);
      if (!v) return state;
      return {
        ...state,
        activeVer: v.id,
        canvas: {
          ...state.canvas,
          glbUrl: v.glbUrl,
          name: v.name,
          ver: v.id,
          status: "loading",
          type: v.type || "",
          source: v.source || "",
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
          glbUrl: action.glbUrl,
          name: action.name || state.canvas.name,
          code: action.code || state.canvas.code,
          ver: action.ver || state.canvas.ver,
          status: "loading",
          type: action.fileType || "", // 未帶類型就藏 badge(誠實,不繼承舊模型的)
          source: action.source || "generated",
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
