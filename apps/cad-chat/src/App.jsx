import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import Header from "./components/Header.jsx";
import FileBrowser from "./components/FileBrowser.jsx";
import StageStepper from "./components/StageStepper.jsx";
import Conversation from "./components/conversation/Conversation.jsx";
import Composer from "./components/conversation/Composer.jsx";
import Canvas3D from "./components/canvas/Canvas3D.jsx";
import ParamsBar from "./components/canvas/ParamsBar.jsx";
import VersionTimeline from "./components/versions/VersionTimeline.jsx";
import { useChatStream } from "./hooks/useChatStream.js";
import { initialState, reducer } from "./state/chatStore.js";

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

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { send, interrupt, setSessionId } = useChatStream(dispatch);
  const [health, setHealth] = useState(null);
  const [browserOpen, setBrowserOpen] = useState(false);
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
    dispatch({ type: "ADD_VERSION", version: { id: "v1", name, glbUrl: glb, formats: ["STEP", "GLB"] } });
    dispatch({ type: "PRESENT", glbUrl: glb, name, code: name, ver: "v1" });
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

  const isIdle = state.phase === "idle" && state.items.length === 0;
  const needAuth = health && !health.agentReady;

  return (
    <div className="app">
      <Header
        phase={state.phase}
        hasVersions={state.versions.length > 0}
        canvasType={state.canvas.type}
        canvasPartCount={state.versions.find((v) => v.id === state.activeVer)?.partCount}
        onOpenFiles={() => setBrowserOpen(true)}
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
        <div className="conv-col">
          <Conversation
            items={state.items}
            isIdle={isIdle}
            running={state.running}
            live={state.live}
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
          />
        </div>
      </div>
    </div>
  );
}
