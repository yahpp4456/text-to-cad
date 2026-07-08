import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import Header from "./components/Header.jsx";
import FileBrowser from "./components/FileBrowser.jsx";
import LessonsPanel from "./components/LessonsPanel.jsx";
import StageStepper from "./components/StageStepper.jsx";
import Conversation from "./components/conversation/Conversation.jsx";
import Composer from "./components/conversation/Composer.jsx";
import Canvas3D from "./components/canvas/Canvas3D.jsx";
import ParamsBar from "./components/canvas/ParamsBar.jsx";
import VersionTimeline from "./components/versions/VersionTimeline.jsx";
import { useChatStream } from "./hooks/useChatStream.js";
import { initialState, reducer } from "./state/chatStore.js";

// 跨重整續聊的 localStorage key(bump 版號即讓舊快照自然失效)
const STORE_KEY = "cadchat.session.v1";

function AuthBanner({ warnings }) {
  return (
    <div className="auth-banner">
      <span>
        <b>尚未設定認證</b> — 二選一:①自用(綁訂閱):終端機跑一次{" "}
        <code>claude setup-token</code>,token 設為 <code>CLAUDE_CODE_OAUTH_TOKEN</code>;
        ②產品/多人(API 按量計費):Claude Console 取得 <code>ANTHROPIC_API_KEY</code>。
        寫入 <code>apps/cad-chat/.env.local</code> 後重啟伺服器。
      </span>
      {warnings?.map((w, i) => (
        <span key={i} style={{ fontSize: 12, opacity: 0.85 }}>
          ⚠ {w}
        </span>
      ))}
    </div>
  );
}

// 另存專案的小對話框:單一名稱輸入;目標已存在時就地引導改名或確認覆蓋。
function SaveDialog({ open, defaultName, onClose, onSave }) {
  const [name, setName] = useState("");
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(defaultName || "");
      setExists(false);
    }
  }, [open, defaultName]);
  if (!open) return null;
  const submit = async (overwrite) => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const r = await onSave(n, overwrite);
    setBusy(false);
    if (r?.exists) setExists(true);
  };
  return (
    <div className="fb-overlay" onClick={onClose}>
      <div className="save-dialog" onClick={(e) => e.stopPropagation()}>
        <span className="save-eyebrow">SAVE PROJECT · 另存專案</span>
        <p className="save-hint">
          存到 <code>models/&lt;名稱&gt;/</code>,之後可從「開啟檔案」載回並用對話續改。
          名稱僅限英數、底線與連字號。
        </p>
        <input
          className="save-input"
          value={name}
          autoFocus
          placeholder="專案名稱(如 my_linear_stage)"
          onChange={(e) => {
            setName(e.target.value);
            setExists(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(false);
            if (e.key === "Escape") onClose();
          }}
        />
        {exists && (
          <p className="save-warn">
            ⚠ models/{name.trim()} 已存在——換個名稱,或確認覆蓋(舊內容會被取代)。
          </p>
        )}
        <div className="save-actions">
          {exists ? (
            <a className="save-btn save-danger" onClick={() => submit(true)}>
              覆蓋既有專案
            </a>
          ) : (
            <a
              className="save-btn"
              data-disabled={!name.trim() || busy || undefined}
              onClick={() => submit(false)}
            >
              {busy ? "儲存中…" : "儲存"}
            </a>
          )}
          <a className="save-btn save-cancel" onClick={onClose}>
            取消
          </a>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { send, interrupt, setSessionId, resetSession } = useChatStream(dispatch);
  const [health, setHealth] = useState(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [exporting, setExporting] = useState(null); // "v2:stl" | null(匯出中鎖鈕)
  const openSeqRef = useRef(0); // opened 版本 id(o1,o2…),與伺服端 v* 分軌不相撞

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ agentReady: false, warnings: ["無法連線到本機伺服器。"] }));
  }, []);

  // 開發/預覽捷徑:?glb=<asset-url>&name=<n>[&motion=<json>] 直接載入畫布(不需對話)。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const glb = params.get("glb");
    if (!glb) return;
    const name = params.get("name") || "preview";
    const motionRaw = params.get("motion");
    if (motionRaw) {
      try {
        const dofs = JSON.parse(motionRaw)?.dofs || JSON.parse(motionRaw);
        if (Array.isArray(dofs) && dofs.length) {
          dispatch({ type: "SET_MOTION", motion: { name, dofs } });
        }
      } catch {
        console.warn("[cad-chat] ?motion= 解析失敗");
      }
    }
    // id 用 p1(不用 v1):伺服端產生的版本從 v1 起跳,撞號會被 ADD_VERSION 去重
    // 吃掉,之後點時間軸 v1 顯示的是預覽模型、匯出的卻是 session 的 v1 快照。
    // source 標 opened:預覽本質就是「開檔看圖」,拆件/轉檔匯出一律不適用。
    dispatch({
      type: "ADD_VERSION",
      version: { id: "p1", name, glbUrl: glb, formats: ["STEP", "GLB"], source: "opened" },
    });
    dispatch({ type: "PRESENT", glbUrl: glb, name, code: name, ver: "p1", source: "opened" });
  }, []);

  const submitText = useCallback(
    (text) => {
      if (!text || !text.trim()) return;
      const pickRefs = state.pickRefs;
      dispatch({
        type: "ADD_USER",
        text,
        ref: pickRefs.map((r) => r.label || r.token).join("、"),
      });
      dispatch({ type: "CLEAR_PICKREFS" });
      send({ text, pickRefs });
    },
    [send, state.pickRefs],
  );

  const applyParams = useCallback(() => {
    dispatch({ type: "CLEAR_PARAMS_DIRTY" });
    dispatch({ type: "ADD_USER", text: `套用參數 ${JSON.stringify(state.params.values)}` });
    send({ text: "", params: state.params.values });
  }, [send, state.params.values]);

  const bringToChat = useCallback((token, label) => {
    dispatch({ type: "ADD_PICKREF", pickRef: { token, label } });
  }, []);

  // 系統訊息進對話流(匯入/開專案的錯誤與提示)。
  const notify = useCallback((text, isError = false) => {
    dispatch({ type: "ADD_ITEM", item: { type: "ai", text: isError ? `⚠ ${text}` : text, isError } });
  }, []);

  // 匯入元件(UI 軌):複製進 session imported/ → 預填 composer 讓使用者決定何時請 AI 組裝。
  const importFile = useCallback(
    async (rel) => {
      if (state.running) return;
      // 開跑先進一則訊息:①使用者看得到動靜(inspectFacts 最長 30s);②同步佔住
      // items,開機還原的探測若在匯入往返中回來,guard 才擋得住 RESTORE 蓋狀態。
      notify(`匯入 models/${rel},讀取尺寸中…`);
      try {
        const r = await fetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: state.sessionId, file: rel }),
        });
        const j = await r.json();
        if (!j.ok) {
          notify(j.error || "匯入失敗", true);
          return;
        }
        if (j.sessionId) {
          setSessionId(j.sessionId);
          dispatch({ type: "SET_SESSION", sessionId: j.sessionId });
        }
        const size = Array.isArray(j.sizeMm)
          ? `(bbox ${j.sizeMm.map((n) => Math.round(n * 10) / 10).join(" × ")} mm)`
          : "";
        dispatch({
          type: "SET_PREFILL",
          text: `已匯入 ${j.rel}${size},請把它組進目前的模型:先討論擺放位置與結合方式,確認後再動手。`,
        });
      } catch {
        notify("無法連線到本機伺服器", true);
      }
    },
    [state.running, state.sessionId, setSessionId, notify],
  );

  // 開既有專案:新 session + 伺服端同步重建,回應帶 version/present/params/motion。
  const openProject = useCallback(
    async (dirRel) => {
      if (state.running) return;
      notify(`開啟專案 models/${dirRel},重建中…`);
      try {
        const r = await fetch("/api/open-project", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dir: dirRel }),
        });
        const j = await r.json();
        if (j.sessionId) {
          setSessionId(j.sessionId);
          dispatch({ type: "SET_SESSION", sessionId: j.sessionId });
        }
        if (!j.ok) {
          notify(j.error || "開啟專案失敗", true);
          return;
        }
        if (j.motion?.dofs?.length) {
          dispatch({ type: "SET_MOTION", motion: { name: j.name, dofs: j.motion.dofs } });
        }
        if (j.version) dispatch({ type: "ADD_VERSION", version: j.version });
        if (j.present) {
          dispatch({
            type: "PRESENT",
            glbUrl: j.present.glbUrl,
            name: j.present.name,
            code: j.present.code,
            ver: j.present.ver,
            fileType: j.present.type || "",
          });
        }
        if (j.params?.length) dispatch({ type: "SET_PARAMS", defs: j.params });
        (j.warnings || []).forEach((w) => notify(w, true)); // 快照失敗等伺服端警告
        notify(
          `專案 ${j.name} 已載入(${j.type === "assembly" ? "組合件" : "元件"}${j.validateOk === false ? ",驗證有未過項,可要求我修復" : ""})。後續訊息會接續此專案。`,
        );
      } catch {
        notify("無法連線到本機伺服器", true);
      }
    },
    [state.running, setSessionId, notify],
  );

  // 開檔看圖(免 LLM):/api/open 回應 → 走 ?glb= 捷徑同款 dispatch。
  const openFile = useCallback((r) => {
    openSeqRef.current += 1;
    const id = `o${openSeqRef.current}`;
    dispatch({
      type: "ADD_VERSION",
      version: {
        id,
        name: r.name,
        glbUrl: r.glbUrl,
        file: r.file,
        formats: /\.(step|stp)$/i.test(r.file || "") ? ["STEP", "GLB"] : ["GLB"],
        type: r.type || "",
        source: "opened",
      },
    });
    dispatch({
      type: "PRESENT",
      glbUrl: r.glbUrl,
      name: r.name,
      code: r.name,
      ver: id,
      fileType: r.type || "",
      source: "opened",
    });
  }, []);

  const handlers = useMemo(
    () => ({
      onToggle: (id) => dispatch({ type: "TOGGLE_ITEM", id }),
      onSubmitText: submitText,
      onSelectVersion: (ver) => dispatch({ type: "SELECT_VERSION", id: ver }),
      // 點規格 chip → 預填 composer 讓使用者接著改值
      onChipEdit: (chip) =>
        dispatch({ type: "SET_PREFILL", text: `${chip.k} 改為 ` }),
    }),
    [submitText],
  );

  // 回退:把 vK 快照還原成工作基準(server 複回頂層+重建),產生新版 = vK 複本。
  const revertVersion = useCallback(
    async (ver) => {
      if (state.running) return;
      notify(`回退到 ${ver},還原並重建中…`);
      try {
        const r = await fetch("/api/revert-version", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: state.sessionId, ver }),
        });
        const j = await r.json();
        if (!j.ok) {
          notify(j.error || "回退失敗", true);
          return;
        }
        if (j.motion?.dofs?.length) {
          dispatch({ type: "SET_MOTION", motion: { name: j.name, dofs: j.motion.dofs } });
        }
        if (j.version) dispatch({ type: "ADD_VERSION", version: j.version });
        if (j.present) {
          dispatch({
            type: "PRESENT",
            glbUrl: j.present.glbUrl,
            name: j.present.name,
            code: j.present.code,
            ver: j.present.ver,
            fileType: j.present.type || "",
          });
        }
        if (j.params?.length) dispatch({ type: "SET_PARAMS", defs: j.params });
        (j.warnings || []).forEach((w) => notify(w, true)); // 快照失敗等伺服端警告
        notify(`已回到 ${ver}(以新版 ${j.version?.id || ""} 繼續)。後續訊息會基於這一版修改。`);
      } catch {
        notify("無法連線到本機伺服器", true);
      }
    },
    [state.running, state.sessionId, notify],
  );

  // 免 LLM 匯出:版本快照 STEP → STL/3MF,成功後以 asset download 觸發瀏覽器下載。
  const exportVersion = useCallback(
    async (ver, format) => {
      if (state.running || exporting) return;
      setExporting(`${ver}:${format}`);
      try {
        const r = await fetch("/api/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: state.sessionId, ver, format }),
        });
        const j = await r.json();
        if (!j.ok) {
          notify(j.error || "匯出失敗", true);
          return;
        }
        const a = document.createElement("a");
        a.href = `/api/asset?file=${encodeURIComponent(j.file)}&download=${encodeURIComponent(`${j.name}_${ver}.${format}`)}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        notify("無法連線到本機伺服器", true);
      } finally {
        setExporting(null);
      }
    },
    [state.running, state.sessionId, exporting, notify],
  );

  // 拆件匯出:圈選零件(selInfos 給定)或整機零件包(null → 全部)→ STEP/STL,
  // 多件 zip。ver 用使用者眼前那一版(canvas.ver 是版本快照 id 時)。
  const exportParts = useCallback(
    async (selInfos, format) => {
      if (state.running || exporting) return;
      // 只對本對話產生的模型有意義:檢視「開啟的檔案」(o* 版)時若 fallback 到
      // session 頂層產物,occurrence id 是位置型的(o1/o2 兩邊都有)→ 會默默抽出
      // 「錯誤模型」的零件。UI 已藏鈕(見 Canvas3D onExportParts prop),這裡再守一層。
      if (state.canvas.source === "opened") {
        notify("目前檢視的是開啟的檔案,拆件匯出僅支援本對話產生的版本(請先切回 v* 版本)", true);
        return;
      }
      setExporting(`parts:${format}`);
      try {
        const occs = (selInfos || [])
          .map((s) => String(s.token || "").replace(/^#/, ""))
          .filter((t) => /^o\d+(\.\d+)*$/.test(t));
        const ver = /^v\d+$/.test(state.canvas.ver || "") ? state.canvas.ver : undefined;
        const r = await fetch("/api/export-parts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: state.sessionId, ver, format, occs }),
        });
        const j = await r.json();
        if (!j.ok) {
          notify(j.error || "拆件匯出失敗", true);
          return;
        }
        const ext = j.file.endsWith(".zip") ? "zip" : format;
        const tag = ext === "zip" ? "parts" : (j.parts?.[0]?.label || "part");
        const a = document.createElement("a");
        a.href = `/api/asset?file=${encodeURIComponent(j.file)}&download=${encodeURIComponent(
          `${j.name}_${ver || "cur"}_${tag}.${ext}`,
        )}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        notify("無法連線到本機伺服器", true);
      } finally {
        setExporting(null);
      }
    },
    [state.running, state.sessionId, state.canvas.ver, state.canvas.source, exporting, notify],
  );

  // 另存專案:session 產物 → models/<name>/(server 端 copy;成功後可從開啟檔案載回)
  const saveProject = useCallback(
    async (name, overwrite = false) => {
      try {
        const r = await fetch("/api/save-project", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: state.sessionId, name, overwrite }),
        });
        const j = await r.json();
        if (j.ok) {
          setSaveOpen(false);
          notify(`已另存為 models/${j.dir}/,之後可從「開啟檔案」載回續改。`);
          return { ok: true };
        }
        if (j.error === "exists") return { ok: false, exists: true };
        notify(j.error || "另存失敗", true);
        return { ok: false };
      } catch {
        notify("無法連線到本機伺服器", true);
        return { ok: false };
      }
    },
    [state.sessionId, notify],
  );

  // 新對話:斷開 session、前端狀態全清(不必重新整理頁面),續聊快照一併作廢。
  const newChat = useCallback(() => {
    if (state.running) return;
    resetSession();
    dispatch({ type: "RESET" });
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* ignore */
    }
    // 清掉 ?glb= 等預覽參數,避免看起來像新對話還載著舊模型
    if (window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [state.running, resetSession]);

  // 可另存 = 這條 session 產過東西(開檔看圖的 o* 版本不算,那本來就在 models/ 裡)
  const canSave = !!(
    state.sessionId &&
    state.canvas.glbUrl &&
    state.canvas.source !== "opened"
  );

  // ── 跨重整續聊 ──
  // 持久化:工作狀態 500ms throttle 落 localStorage;sessionId 空(新對話/未開聊)即清。
  // restoreDoneRef:開機還原嘗試結束前不清 key——fetch 失敗(伺服器沒起來)時快照要留著下次再試。
  const persistTimerRef = useRef(null);
  const restoreDoneRef = useRef(false);
  const stateRef = useRef(state); // 給開機還原的 async 回呼讀「當下」狀態(closure 是舊的)
  stateRef.current = state;
  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      try {
        if (!state.sessionId) {
          if (restoreDoneRef.current) localStorage.removeItem(STORE_KEY);
          return;
        }
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            sessionId: state.sessionId,
            _seq: state._seq,
            items: state.items,
            versions: state.versions,
            activeVer: state.activeVer,
            canvas: state.canvas,
            params: state.params,
            motion: state.motion,
            savedAt: Date.now(),
          }),
        );
      } catch {
        /* 配額滿等,略過(下次再試) */
      }
    }, 500);
    return () => clearTimeout(persistTimerRef.current);
  }, [
    state.sessionId,
    state._seq,
    state.items,
    state.versions,
    state.activeVer,
    state.canvas,
    state.params,
    state.motion,
  ]);

  // 還原:開機一次;?glb= 預覽優先不還原;session-info 驗證產物還在才回灌
  // (被 GC/刪除 → 誠實告知並乾淨新開)。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("glb")) {
      // 預覽模式無還原。restoreDoneRef 留 false:設 true 會武裝持久化 effect 的
      // 清除分支,預覽流(sessionId 恆 null)的第一個 persist tick 就把使用者的
      // 舊對話快照刪了。留 false 只擋自動清除;之後若在預覽頁開聊,setItem 分支
      // (有 sessionId)照常覆寫,不受影響。
      return;
    }
    let snap = null;
    try {
      snap = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch {
      snap = null;
    }
    if (!snap?.sessionId) {
      restoreDoneRef.current = true;
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/session-info?id=${encodeURIComponent(snap.sessionId)}`);
        const info = await r.json();
        // 探測往返期間使用者已開始互動(送訊息/匯入/開檔/開專案):不回灌舊快照——
        // 無條件 RESTORE 會把進行中的對話整個蓋掉,還把串流中的 sessionId 換走,
        // 之後的 interrupt/追問全打到錯的 session。快照留著(不清 key)下次再說。
        const cur = stateRef.current;
        if (cur.sessionId || cur.running || cur.items.length > 0 || cur.versions.length > 0) {
          // 注意:這裡「不」設 restoreDoneRef=true——設了會武裝持久化 effect 的
          // 清除分支,開檔看圖流(sessionId 恆 null)的下一次 persist tick 就把
          // 舊對話快照刪掉。留 false 只擋自動清除,不影響有 sessionId 時的正常寫入。
          return;
        }
        const hasGenVersions = (snap.versions || []).some((v) => v.source !== "opened");
        if (info.exists && (!hasGenVersions || info.hasGenerator)) {
          dispatch({ type: "RESTORE", snapshot: snap });
          setSessionId(snap.sessionId);
          notify(`已接續上次對話${info.lastName ? `(${info.lastName})` : ""}。`);
        } else {
          localStorage.removeItem(STORE_KEY);
          if (hasGenVersions) notify("上次的工作階段已過期(產物已被清理),已開新對話。");
        }
        restoreDoneRef.current = true;
      } catch {
        /* 伺服器未就緒等:不還原也不標記完成,快照留著下次再試 */
      }
    })();
  }, []);

  // 視圖區進度面板吃的工具事件小卡(最近 4 筆)
  const toolFeed = useMemo(
    () => state.items.filter((it) => it.type === "tool").slice(-4),
    [state.items],
  );

  // Playwright / 除錯鉤(僅 dev):讓煙測能注入 SET_CLARIFY 等 action 驗渲染。
  useEffect(() => {
    if (import.meta.env.DEV) window.__cadDispatch = dispatch;
  }, []);

  const isIdle = state.phase === "idle" && state.items.length === 0;
  // 問卷待答的唯一真相:clarify 焦點模式(左欄反灰凍結 + 視圖置中聚光燈)由此驅動。
  // 只由 ADD_USER 清成 null(任何送出=已答);running/phase 不參與。
  const clarifyPending = state.clarify != null;
  const needAuth = health && !health.agentReady;

  return (
    <div className="app">
      <Header
        phase={state.phase}
        hasVersions={state.versions.length > 0}
        canvasType={state.canvas.type}
        canvasPartCount={state.versions.find((v) => v.id === state.activeVer)?.partCount}
        onOpenFiles={() => setBrowserOpen(true)}
        onSaveProject={canSave ? () => setSaveOpen(true) : null}
        onNewChat={newChat}
        onOpenLessons={() => setLessonsOpen(true)}
        running={state.running}
      />
      <LessonsPanel open={lessonsOpen} onClose={() => setLessonsOpen(false)} />
      <SaveDialog
        open={saveOpen}
        defaultName={state.canvas.name}
        onClose={() => setSaveOpen(false)}
        onSave={saveProject}
      />
      <FileBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onOpenFile={openFile}
        onImportFile={(rel) => {
          setBrowserOpen(false);
          importFile(rel);
        }}
        onOpenProject={(rel) => {
          setBrowserOpen(false);
          openProject(rel);
        }}
      />
      {needAuth && <AuthBanner warnings={health.warnings} />}
      <StageStepper stageIdx={state.stageIdx} />
      <div className="body">
        {/* clarify 待答 → 左欄整塊反灰凍結(見 app.css .conv-col[data-frozen]);
            false 時不出屬性,沿用 data-cited 慣例 */}
        <div className="conv-col" data-frozen={clarifyPending || undefined}>
          <Conversation
            items={state.items}
            isIdle={isIdle}
            running={state.running}
            live={state.live}
            frozen={clarifyPending}
            onSubmitText={submitText}
            handlers={handlers}
          />
          <Composer
            running={state.running}
            pickRefs={state.pickRefs}
            prefill={state.prefill}
            onPrefillConsumed={() => dispatch({ type: "CLEAR_PREFILL" })}
            onRemovePick={(token) => dispatch({ type: "REMOVE_PICKREF", token })}
            onClearPicks={() => dispatch({ type: "CLEAR_PICKREFS" })}
            onSubmit={submitText}
            onInterrupt={interrupt}
          />
        </div>
        <div className="right-col">
          <Canvas3D
            canvas={state.canvas}
            propsOpen={state.propsOpen}
            selNode={state.selNode}
            dispatch={dispatch}
            onBringToChat={bringToChat}
            pickRefs={state.pickRefs}
            running={state.running}
            live={state.live}
            stageIdx={state.stageIdx}
            toolFeed={toolFeed}
            clarify={state.clarify}
            onSubmitText={submitText}
            onExportParts={
              // 檢視開啟的檔案(o* 版)時藏拆件匯出:server 只能從 session 產物抽件,
              // fallback 會抽到錯的模型(見 exportParts 內的守衛註解)
              state.sessionId && state.canvas.source !== "opened" ? exportParts : null
            }
            partsBusy={exporting === "parts:step" || exporting === "parts:stl"}
            exportNote={
              exporting
                ? exporting.startsWith("parts:")
                  ? `正在匯出零件檔(${(exporting.split(":")[1] || "").toUpperCase()})…`
                  : `正在轉出 ${(exporting.split(":")[1] || "").toUpperCase()} 檔…`
                : null
            }
            motion={
              state.motion && state.motion.forVer === state.canvas.ver ? state.motion : null
            }
          />
          <ParamsBar
            params={state.params}
            disabled={state.canvas.status !== "ready" || state.running}
            onParam={(k, v) => dispatch({ type: "SET_PARAM_VALUE", key: k, value: v })}
            onApply={applyParams}
          />
          <VersionTimeline
            versions={state.versions}
            activeVer={state.activeVer}
            onSelect={(id) => dispatch({ type: "SELECT_VERSION", id })}
            onRevert={revertVersion}
            onExport={state.sessionId ? exportVersion : null}
            onExportParts={
              state.sessionId && state.canvas.type === "assembly"
                ? () => exportParts(null, "step")
                : null
            }
            exporting={exporting}
            running={state.running}
          />
        </div>
      </div>
    </div>
  );
}
