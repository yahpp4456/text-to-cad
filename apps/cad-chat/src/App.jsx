import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import Header from "./components/Header.jsx";
import FileBrowser from "./components/FileBrowser.jsx";
import LessonsPanel from "./components/LessonsPanel.jsx";
import StageStepper from "./components/StageStepper.jsx";
import Conversation from "./components/conversation/Conversation.jsx";
import Composer from "./components/conversation/Composer.jsx";
import Canvas3D from "./components/canvas/Canvas3D.jsx";
import LibraryShelf from "./components/canvas/LibraryShelf.jsx";
import ParamsBar from "./components/canvas/ParamsBar.jsx";
import SketchCanvas3D from "./components/canvas/SketchCanvas3D.jsx";
import VersionTimeline from "./components/versions/VersionTimeline.jsx";
import { useChatStream } from "./hooks/useChatStream.js";
import { normalizeMode } from "./lib/chatModes.js";
import { latestSpecItem, pendingLessonOffer } from "./lib/clarifyText.js";
import { DEMO_TIP } from "./lib/demo.js";
import { apiUrl } from "@/lib/apiBase";
import { initialState, reducer } from "./state/chatStore.js";

// 跨重整續聊的 localStorage key(bump 版號即讓舊快照自然失效)
const STORE_KEY = "cadchat.session.v1";
// 模式偏好(草模/設計):跨開機記住切換器位置(session 快照另有 mode,還原時以快照為準)
const MODE_KEY = "cadchat.mode";

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

// 通用確認框(取代原生 window.confirm 的醜視窗):沿用 SaveDialog 的視覺語言。
// box = { eyebrow, body, actionLabel, accent?, onConfirm } | null。
// Enter=確定、Escape=取消(全域監聽,開著才掛)。
function ConfirmDialog({ box, onClose }) {
  useEffect(() => {
    if (!box) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") {
        onClose();
        box.onConfirm?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [box, onClose]);
  if (!box) return null;
  return (
    <div className="fb-overlay" onClick={onClose}>
      <div
        className="save-dialog confirm-dialog"
        style={box.accent ? { borderTopColor: box.accent } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="save-eyebrow">{box.eyebrow || "CONFIRM · 確認"}</span>
        <p className="confirm-msg">{box.body}</p>
        <div className="save-actions">
          <a
            className="save-btn"
            onClick={() => {
              onClose();
              box.onConfirm?.();
            }}
          >
            {box.actionLabel || "確定"}
          </a>
          <a className="save-btn save-cancel" onClick={onClose}>
            取消
          </a>
        </div>
      </div>
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
  // 每次 POST /api/chat 帶當前模式(useChatStream 開火時讀 ref,不吃 stale closure)
  const modeRef = useRef("design");
  modeRef.current = state.mode;
  const { send, interrupt, setSessionId, resetSession } = useChatStream(dispatch, modeRef);
  const [health, setHealth] = useState(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [confirmBox, setConfirmBox] = useState(null); // 通用確認框(切模式/升級)
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [exporting, setExporting] = useState(null); // "v2:stl" | null(匯出中鎖鈕)
  // 附件圖片(composer 暫態,刻意不進 reducer/localStorage 快照;選檔即上傳,
  // 送出時只帶輕量 rel)。status: uploading | ready | error。
  // 附件佇列(圖片+STEP 共用):{id, kind:"image"|"step", name, status, rel, url}
  const [pendingFiles, setPendingFiles] = useState([]);
  const fileSeqRef = useRef(0);

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ agentReady: false, warnings: ["無法連線到本機伺服器。"] }));
  }, []);
  // DEMO 帳號(server 依 X-Remote-User 判定,經 /api/health 回旗):展示身分——
  // 開啟檔案/教訓/另存專案、零件庫寫入動作與附件上傳一律**照常渲染但禁用**
  // (hover 出 DEMO_TIP),而不是藏起來:藏會讓展示者以為產品沒這些功能。
  // 例外是教訓是/否面板——那是「要求使用者作答」的面板,出現卻不能答=死路,
  // 所以 demo 直接不出(見 liveLessonOffer)。零件庫「預覽」純唯讀故放行。
  // server 端 demoGuard 對應端點回 403;前端禁用只是 UX,不是安全邊界。
  // health 未回前 demo=false:入口短暫可用,點了也被 403 擋。
  const demo = !!health?.demo;

  // 模式偏好:開機還原切換器位置(session 快照的 RESTORE 之後會以快照 mode 蓋過,
  // 兩者一致——快照存在即上次也在那個模式);之後每次變動回寫。
  useEffect(() => {
    try {
      const m = normalizeMode(localStorage.getItem(MODE_KEY));
      if (m !== "design") dispatch({ type: "SET_MODE", mode: m });
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, state.mode);
    } catch {
      /* ignore */
    }
  }, [state.mode]);

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

  // openProject 定義在 submitText 之後(TDZ),用 ref 轉接讓「自動帶入編輯」呼叫得到。
  const openProjectRef = useRef(null);

  // 回傳布林=「這次送出有沒有真的成立」:false 是同步早退(空文字/附件上傳中/
  // 唯讀升級失敗)。SpecPanel 等旁路呼叫端靠它決定要不要清掉自己的草稿——
  // Composer 走自身 UI 閘,不讀回傳值。
  const submitText = useCallback(
    async (text) => {
      const ready = pendingFiles.filter((p) => p.status === "ready");
      const readyImgs = ready.filter((p) => p.kind !== "step");
      const readySteps = ready.filter((p) => p.kind === "step");
      if ((!text || !text.trim()) && ready.length === 0) return false;
      if (pendingFiles.some((p) => p.status === "uploading")) return false; // Composer 已擋,雙保險
      const pickRefs = state.pickRefs;
      const cv = state.canvas;
      dispatch({
        type: "ADD_USER",
        // STEP 附件無縮圖:進 transcript 的 text 前綴檔名讓紀錄可讀
        text: readySteps.length ? `（附 STEP:${readySteps.map((p) => p.name).join("、")}）${text || ""}` : text,
        ref: pickRefs.map((r) => r.label || r.token).join("、"),
        images: readyImgs.map(({ url, name }) => ({ url, name })), // 縮圖進 transcript
      });
      dispatch({ type: "CLEAR_PICKREFS" });
      setPendingFiles([]);
      // 自動帶入編輯:唯讀檢視某可編輯專案(有產生器)時,先升級成 session 再送——
      // 唯讀工作區本來就只有那個檢視版,CLEAR_WORKSPACE 換上同模型可編輯 v1 幾乎無縫。
      // guard `!state.sessionId`:升級後有 session,之後聊天走現狀不重複升級。
      if (cv.source === "opened" && cv.projectDir && !state.sessionId) {
        const sid = await openProjectRef.current?.(cv.projectDir, { auto: true });
        if (!sid) return false; // 升級失敗:openProject 已 notify,使用者文字已在 transcript
      }
      // 當前畫布身分只在唯讀檢視(source "opened")時附上——那是 agent 否則零語境的
      // 情境;升級後 session 靠 _rehydrateNote 已知模型(server 端會略過此注入)。
      const canvas =
        cv.source === "opened"
          ? {
              name: cv.name,
              file: state.versions.find((v) => v.id === cv.ver)?.file || "",
              source: cv.source,
              type: cv.type,
              projectDir: cv.projectDir,
            }
          : undefined;
      send({
        text,
        pickRefs,
        imageRefs: readyImgs.length ? readyImgs.map((p) => p.rel) : undefined,
        stepRefs: readySteps.length ? readySteps.map((p) => p.rel) : undefined,
        canvas,
      });
      return true;
    },
    [send, state.pickRefs, state.canvas, state.sessionId, state.versions, pendingFiles],
  );

  const applyParams = useCallback(() => {
    dispatch({ type: "CLEAR_PARAMS_DIRTY" });
    dispatch({
      type: "ADD_USER",
      // 顯示用 k=v(server payload 仍是 send 的 params 物件,與此無關)
      text: `套用參數 ${Object.entries(state.params.values)
        .map(([k, v]) => `${k}=${v}`)
        .join("、")}`,
    });
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
  // opts.sessionId 顯式覆寫(含 null=強制 server mint 新設計 session——LibraryShelf
  // 「⇪ 設計」切模式後閉包裡的 state.sessionId 還是舊零件庫 session,不覆寫必 400)。
  // opts.present={glbUrl,name}:匯入成功後把零件 GLB 上畫布(零件庫軌帶;檔案瀏覽器
  // 軌沒有現成 GLB 不帶=行為不變)——沒有這個,匯入後畫布空白+訊息停在「讀取尺寸
  // 中…」,看起來像當掉(2026-07-21 調查結論)。
  const importFile = useCallback(
    async (rel, opts = {}) => {
      if (state.running) return;
      const sid = "sessionId" in opts ? opts.sessionId : state.sessionId;
      // 開跑先進一則訊息:①使用者看得到動靜(inspectFacts 最長 30s);②同步佔住
      // items,開機還原的探測若在匯入往返中回來,guard 才擋得住 RESTORE 蓋狀態。
      notify(`匯入 models/${rel},讀取尺寸中…`);
      try {
        const r = await fetch(apiUrl("/api/import"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, file: rel }),
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
        if (opts.present?.glbUrl) {
          // 同 library_preview 契約:只發 present(source:"opened"),不進時間軸
          dispatch({
            type: "PRESENT",
            glbUrl: opts.present.glbUrl,
            name: opts.present.name || j.label,
            code: opts.present.name || j.label,
            ver: "",
            fileType: "part",
            source: "opened",
          });
        }
        // 完成回饋:沒有這則,「讀取尺寸中…」是聊天裡最後一句話,像卡死
        notify(`✓ 已匯入 ${j.label || j.rel}${size},組裝指令已放進輸入框,按送出即開始組裝。`);
      } catch {
        notify("無法連線到本機伺服器", true);
      }
    },
    [state.running, state.sessionId, setSessionId, notify],
  );

  // 附加檔案(附件鈕/貼上/拖放共用):選檔即上傳 → chip(圖片有縮圖、STEP 無)。
  // 圖片走 /api/upload-image;STEP 只在零件庫模式收、走 /api/upload-step。
  // 位元組只傳這一次;送訊息只帶 rel(imageRefs/stepRefs),佇列/409 重試不重傳。
  // 無 session 時 server 順手建並回傳(同 /api/import 模式,前端採納)。上限 4 件/訊息。
  const attachFiles = useCallback(
    async (files) => {
      const room = 4 - pendingFiles.length;
      for (const f of Array.from(files).slice(0, Math.max(0, room))) {
        const isStep = /\.ste?p$/i.test(f.name || "");
        if (isStep && (modeRef.current !== "library" || demo)) continue; // 模式邊界+demo 唯讀(Composer 已濾,雙保險)
        const kind = isStep ? "step" : "image";
        const id = `f${++fileSeqRef.current}`;
        setPendingFiles((prev) => [
          ...prev,
          { id, kind, name: f.name || kind, status: "uploading", rel: null, url: null },
        ]);
        try {
          const endpoint = isStep ? "/api/upload-step" : "/api/upload-image";
          const r = await fetch(
            apiUrl(
              `${endpoint}?sessionId=${encodeURIComponent(state.sessionId || "")}&name=${encodeURIComponent(f.name || kind)}`,
            ),
            {
              method: "POST",
              headers: {
                "content-type": isStep ? "application/octet-stream" : f.type || "application/octet-stream",
              },
              body: f,
            },
          );
          const j = await r.json().catch(() => ({}));
          if (!j.ok) throw new Error(j.error || `上傳失敗(HTTP ${r.status})`);
          if (j.sessionId && j.sessionId !== state.sessionId) {
            setSessionId(j.sessionId);
            dispatch({ type: "SET_SESSION", sessionId: j.sessionId });
          }
          setPendingFiles((prev) =>
            prev.map((p) =>
              p.id === id
                ? { ...p, status: "ready", rel: j.rel, url: isStep ? null : j.url }
                : p,
            ),
          );
        } catch (err) {
          setPendingFiles((prev) =>
            prev.map((p) =>
              p.id === id ? { ...p, status: "error", error: String(err?.message || err) } : p,
            ),
          );
        }
      }
    },
    [state.sessionId, setSessionId, pendingFiles.length, demo],
  );

  // 開既有專案:新 session + 伺服端同步重建,回應帶 version/present/params/motion。
  // 回傳新 sessionId(或 null)——submitText 的「自動帶入編輯」據此確認升級成功再送。
  // opts.auto:由聊天自動觸發(非使用者手動開專案),notify 文案改成貼合語境。
  const openProject = useCallback(
    async (dirRel, opts = {}) => {
      if (state.running) return null;
      notify(
        opts.auto
          ? `偵測到你要編輯,正把 models/${dirRel} 帶入可編輯工作區…`
          : `開啟專案 models/${dirRel},重建中…`,
      );
      try {
        const r = await fetch(apiUrl("/api/open-project"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dir: dirRel }),
        });
        const j = await r.json();
        if (j.sessionId) {
          setSessionId(j.sessionId);
          dispatch({ type: "SET_SESSION", sessionId: j.sessionId });
          // 換了 session 就清舊工作區(版本/運動/參數;對話保留):舊 session 的
          // v* chip 對新 sessionId 全是死引用(精算標錯版、匯出/回退 404、v1 撞號)。
          // 重建失敗(!j.ok)也已換 session,同樣要清。
          dispatch({ type: "CLEAR_WORKSPACE" });
        }
        if (!j.ok) {
          notify(j.error || "開啟專案失敗", true);
          return null;
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
            flatGlbUrl: j.present.flatGlbUrl ?? null, // 鈑金攤平切換(JSON 路徑亦需帶)
            flatLinesUrl: j.present.flatLinesUrl ?? null, // 攤平折彎線 overlay
            sweepPathsUrl: j.present.sweepPathsUrl ?? null, // 掃出路徑 overlay(JSON 路徑亦需帶)
          });
        }
        if (j.params?.length) dispatch({ type: "SET_PARAMS", defs: j.params });
        (j.warnings || []).forEach((w) => notify(w, true)); // 快照失敗等伺服端警告
        notify(
          `專案 ${j.name} 已載入(${j.type === "assembly" ? "組合件" : "元件"}${j.validateOk === false ? ",驗證有未過項,可要求我修復" : ""})。後續訊息會接續此專案。`,
        );
        return j.sessionId ?? null;
      } catch {
        notify("無法連線到本機伺服器", true);
        return null;
      }
    },
    [state.running, setSessionId, notify],
  );
  // 供 submitText 的「自動帶入編輯」呼叫(openProject 定義在 submitText 之後,避 TDZ)。
  openProjectRef.current = openProject;

  // 開檔看圖(免 LLM):/api/open 回應 → 走 ?glb= 捷徑同款 dispatch。
  // 同一檔重複開啟去重:沿用既有檢視版的 id(ADD_VERSION 撞 id=取代),時間軸不長
  // 出 o1/o2/o3 分身。glbUrl 帶檔案 mtime buster:檔案沒變=同 URL(不重載、status
  // 保留),外部重生過=新 URL(觸發真重載換新幾何)。
  const openFile = useCallback(
    (r) => {
      const existing = state.versions.find(
        (v) => v.source === "opened" && v.file && v.file === r.file,
      );
      // 序號從現有版本推導(不用 mount 期 ref):RESTORE 還原的 o1/o2 仍在時間軸,
      // ref 歸零會再 mint o1 撞號、靜默取代別檔的檢視版。
      const nextSeq =
        state.versions.reduce((m, v) => {
          const mt = /^o(\d+)$/.exec(String(v.id || ""));
          return mt ? Math.max(m, Number(mt[1])) : m;
        }, 0) + 1;
      const id = existing?.id || `o${nextSeq}`;
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
          projectDir: r.projectDir ?? null, // 屬可編輯專案 → 聊天可自動帶入編輯
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
        projectDir: r.projectDir ?? null,
      });
    },
    [state.versions],
  );

  // 防雙擊:同步 in-flight 守衛(不依賴 React re-render 收鈕,擋同一 tick 內的重複點擊
  // →否則會發出多個 POST /api/lessons/record,落重複 manual case)。
  const lessonOfferBusyRef = useRef(new Set());
  // SpecPanel 草稿(未套用的 chip 修正)最新值;見 clarifySeedEdits 註解。
  const specDraftRef = useRef(null);
  const onSpecEdits = useCallback((specId, edits) => {
    specDraftRef.current = { specId, edits };
  }, []);
  const handlers = useMemo(
    () => ({
      onToggle: (id) => dispatch({ type: "TOGGLE_ITEM", id }),
      onSubmitText: submitText,
      onSelectVersion: (ver) => dispatch({ type: "SELECT_VERSION", id: ver }),
      // 人工記教訓「是/否卡」:否=純前端標記;是=POST 落一筆未蒸餾 case。sessionId 讀
      // stateRef(handlers memo deps 不含 state,直讀 state.sessionId 會是 stale closure);
      // 依 j.ok 決定成功/錯誤,不吞成假✓。
      onLessonOffer: async (id, outcome, payload) => {
        if (outcome !== "added") {
          dispatch({ type: "ANSWER_LESSON_OFFER", id, outcome: "skipped" });
          return;
        }
        if (lessonOfferBusyRef.current.has(id)) return; // 同步守衛:雙擊只送一次
        lessonOfferBusyRef.current.add(id);
        dispatch({ type: "ANSWER_LESSON_OFFER", id, outcome: "pending" }); // 樂觀:立即收鈕
        try {
          const r = await fetch(apiUrl("/api/lessons/record"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: stateRef.current.sessionId, ...payload }),
          });
          const j = await r.json();
          if (j.ok) {
            dispatch({ type: "ANSWER_LESSON_OFFER", id, outcome: "added" });
            notify("已加入教訓(未蒸餾)。可在「教訓」面板按「立即蒸餾」升級。");
          } else {
            dispatch({ type: "ANSWER_LESSON_OFFER", id, outcome: null }); // 回滾:恢復鈕可重試
            notify(j.error === "disabled" ? "教訓系統已停用。" : "加入教訓失敗。", true);
          }
        } catch {
          dispatch({ type: "ANSWER_LESSON_OFFER", id, outcome: null });
          notify("無法連線到本機伺服器", true);
        } finally {
          lessonOfferBusyRef.current.delete(id);
        }
      },
    }),
    [submitText],
  );

  // 回退:把 vK 快照還原成工作基準(server 複回頂層+重建),產生新版 = vK 複本。
  const revertVersion = useCallback(
    async (ver) => {
      if (state.running) return;
      notify(`回退到 ${ver},還原並重建中…`);
      try {
        const r = await fetch(apiUrl("/api/revert-version"), {
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
            flatGlbUrl: j.present.flatGlbUrl ?? null, // 鈑金攤平切換(JSON 路徑亦需帶)
            flatLinesUrl: j.present.flatLinesUrl ?? null, // 攤平折彎線 overlay
            sweepPathsUrl: j.present.sweepPathsUrl ?? null, // 掃出路徑 overlay(JSON 路徑亦需帶)
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

  // 匯出閘結果落地:通過 → 版本 badge 轉綠(**不看 ran**——server memo 命中時
  // ran=false 但同樣代表「此版已驗」,client 端 badge 可能因舊快照落後,要同步);
  // 閘真的跑了 → 另出一張驗證卡。
  const applyGate = useCallback((gate, verFallback) => {
    if (!gate) return;
    const id = gate.ver || verFallback;
    if (gate.ok && id) dispatch({ type: "MARK_VERSION_VERIFIED", id });
    if (!gate.ran) return;
    dispatch({
      type: "ADD_ITEM",
      item: { type: "validate", ok: gate.ok !== false, partCount: gate.partCount, checks: gate.checks || [] },
    });
  }, []);

  // 免 LLM 匯出:版本快照 STEP → STL/3MF,成功後以 asset download 觸發瀏覽器下載。
  // 匯出閘在 server 端:未驗證版會先自動完整驗證(未過 → 擋下,gate.checks 進驗證卡)。
  const exportVersion = useCallback(
    async (ver, format) => {
      if (state.running || exporting) return;
      // session 綁定:閘驗證最長 2 分鐘,期間開專案/新對話不擋 exporting——回來時
      // session 已換人就整包作廢(MARK/驗證卡/下載都不做,否則污染新對話還可能把
      // 新 session 撞號的 v1 偽標成已驗證、繞過 STEP 閘)。
      const startSession = state.sessionId;
      if (state.versions.find((x) => x.id === ver)?.verified !== true) {
        notify("此版尚未驗證:匯出前自動精算中(含運動掃掠,約數秒~分鐘)…");
      }
      setExporting(`${ver}:${format}`);
      try {
        const r = await fetch(apiUrl("/api/export"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: startSession, ver, format }),
        });
        const j = await r.json();
        if (stateRef.current.sessionId !== startSession) return; // 對話已切換:作廢
        if (j.gate) applyGate(j.gate, ver);
        if (!j.ok) {
          notify(j.error || "匯出失敗", true);
          return;
        }
        const a = document.createElement("a");
        a.href = apiUrl(`/api/asset?file=${encodeURIComponent(j.file)}&download=${encodeURIComponent(`${j.name}_${ver}.${format}`)}`);
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        if (stateRef.current.sessionId === startSession) notify("無法連線到本機伺服器", true);
      } finally {
        setExporting(null);
      }
    },
    [state.running, state.sessionId, state.versions, exporting, notify, applyGate],
  );

  // 最新的自產版本(= 精算/回退的工作基準;與 VersionTimeline 內同式)
  const latestGen = useMemo(
    () => [...state.versions].reverse().find((v) => v.source !== "opened"),
    [state.versions],
  );

  // 精算此版:對頂層工作基準跑「完整」幾何驗證(含運動掃掠),不重新產生。
  // 快路徑迭代後一鍵補做真驗證;結果落成一張驗證卡並刷新運動示意。
  const validateVersion = useCallback(async () => {
    if (state.running || exporting) return;
    // session 綁定:精算可跑數分鐘,期間 openProject/newChat 不擋 exporting——
    // 回來時 session 已換人就整包作廢(否則 MARK/SET_MOTION/驗證卡污染新對話)。
    const startSession = state.sessionId;
    setExporting("validate");
    notify("精算此版:完整幾何驗證中(含運動掃掠,約數秒~分鐘)…");
    try {
      const r = await fetch(apiUrl("/api/validate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: startSession }),
      });
      const j = await r.json();
      if (stateRef.current.sessionId !== startSession) return; // 對話已切換:結果作廢
      if (!j.ok) {
        notify(j.error || "驗證失敗", true);
        return;
      }
      dispatch({
        type: "ADD_ITEM",
        item: { type: "validate", ok: j.validateOk, partCount: j.partCount, checks: j.checks || [] },
      });
      // /api/validate 驗的是 session「頂層工作基準」= latestGen 的內容(與使用者眼前
      // 選的 active 是誰無關)——motion/verified 一律綁 latestGen,不綁 canvas.ver
      // (檢視舊版時綁 canvas.ver 會把新幾何的運動宣告掛到舊模型上)。
      // j.stale = 頂層基準已漂移(上輪 build 後被中斷、沒 present):結果只出驗證卡,
      // 不標記版本、不掛 motion——標了就是把「別的幾何」的判定記到快照版上。
      if (!j.stale && latestGen) {
        dispatch({
          type: "SET_MOTION",
          motion: { name: latestGen.name, dofs: j.motion?.dofs || [], forVer: latestGen.id },
        });
        if (j.validateOk) dispatch({ type: "MARK_VERSION_VERIFIED", id: latestGen.id });
      }
      notify(
        j.stale
          ? `精算完成:${j.validateOk ? "全部通過" : "有未過項(見驗證卡)"}——但目前工作基準與最新版本快照不一致(上輪可能被中斷),結果不標記到版本;請重新產圖後再精算。`
          : j.validateOk
            ? "精算完成:全部通過"
            : "精算完成:有未過項(見驗證卡)",
        !j.validateOk,
      );
    } catch {
      if (stateRef.current.sessionId === startSession) notify("無法連線到本機伺服器", true);
    } finally {
      setExporting(null);
    }
  }, [state.running, exporting, state.sessionId, latestGen, notify]);

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
      const startSession = state.sessionId; // session 綁定,同 exportVersion
      if (state.versions.find((x) => x.id === state.canvas.ver)?.verified !== true) {
        notify("此版尚未驗證:匯出前自動精算中(含運動掃掠,約數秒~分鐘)…");
      }
      setExporting(`parts:${format}`);
      try {
        const occs = (selInfos || [])
          .map((s) => String(s.token || "").replace(/^#/, ""))
          .filter((t) => /^o\d+(\.\d+)*$/.test(t));
        const ver = /^v\d+$/.test(state.canvas.ver || "") ? state.canvas.ver : undefined;
        const r = await fetch(apiUrl("/api/export-parts"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: startSession, ver, format, occs }),
        });
        const j = await r.json();
        if (stateRef.current.sessionId !== startSession) return; // 對話已切換:作廢
        if (j.gate) applyGate(j.gate, ver);
        if (!j.ok) {
          notify(j.error || "拆件匯出失敗", true);
          return;
        }
        const ext = j.file.endsWith(".zip") ? "zip" : format;
        const tag = ext === "zip" ? "parts" : (j.parts?.[0]?.label || "part");
        const a = document.createElement("a");
        a.href = apiUrl(`/api/asset?file=${encodeURIComponent(j.file)}&download=${encodeURIComponent(
          `${j.name}_${ver || "cur"}_${tag}.${ext}`,
        )}`);
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        if (stateRef.current.sessionId === startSession) notify("無法連線到本機伺服器", true);
      } finally {
        setExporting(null);
      }
    },
    [state.running, state.sessionId, state.canvas.ver, state.canvas.source, state.versions, exporting, notify, applyGate],
  );

  // STEP 直下載的匯出閘:/api/asset 是裸 GET 沒有閘,未驗證版先打 /api/validate-ver
  // (memo 命中=秒回;沒驗過=自動精算),verified 才觸發下載。已驗證版與開檔檢視版
  // 在 VersionTimeline 端直接走 href,不進這裡。
  const downloadStep = useCallback(
    async (v, rel) => {
      if (state.running || exporting) return;
      const startSession = state.sessionId;
      setExporting("stepdl");
      notify("此版尚未驗證:下載前自動精算中(含運動掃掠,約數秒~分鐘)…");
      try {
        const r = await fetch(apiUrl("/api/validate-ver"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: startSession, ver: v.id }),
        });
        const j = await r.json();
        if (stateRef.current.sessionId !== startSession) return; // 對話已切換:作廢
        if (!j.ok) {
          notify(j.error || "驗證失敗", true);
          return;
        }
        applyGate(j.gate, v.id);
        if (!j.verified) {
          notify("下載已擋下:此版本未通過完整幾何驗證(逐項見驗證卡)。", true);
          return;
        }
        const a = document.createElement("a");
        a.href = apiUrl(`/api/asset?file=${encodeURIComponent(rel)}&download=${encodeURIComponent(`${v.name}_${v.id}.step`)}`);
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        if (stateRef.current.sessionId === startSession) notify("無法連線到本機伺服器", true);
      } finally {
        setExporting(null);
      }
    },
    [state.running, state.sessionId, exporting, notify, applyGate],
  );

  // 另存專案:session 產物 → models/<name>/(server 端 copy;成功後可從開啟檔案載回)
  const saveProject = useCallback(
    async (name, overwrite = false) => {
      try {
        const r = await fetch(apiUrl("/api/save-project"), {
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
  // mode 由 reducer RESET 保留(新對話沿用當前模式)。
  const newChat = useCallback(() => {
    if (state.running) return;
    setPendingFiles([]); // 附件屬於舊 session(rel 對新 session 無效);遲到的上傳回應 no-op
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

  // 模式切換(草模/設計/零件庫):mode 是 session 出生時的恆定屬性——已有內容就出
  // 樣式化確認框(非原生 confirm)後開新對話;還沒開聊(含只上傳過圖的處女
  // session)直接切,首則訊息會讓 server 採納新 mode(resolveTurnMode 的處女例外)。
  const switchMode = useCallback(
    (next) => {
      if (state.running || next === state.mode) return;
      const hasContent = state.items.length > 0 || state.versions.length > 0;
      if (!hasContent) {
        dispatch({ type: "SET_MODE", mode: next });
        return;
      }
      const name = next === "sketch" ? "草模" : next === "library" ? "零件庫" : "設計";
      setConfirmBox({
        eyebrow: `SWITCH MODE · 切換到「${name}」`,
        body: "切換模式會開一個新對話:目前的對話與畫布會清空,已產出的檔案仍保留在磁碟。",
        actionLabel: `切換到「${name}」`,
        accent: next === "sketch" ? "var(--sketch)" : next === "library" ? "var(--part)" : "var(--design)",
        onConfirm: () => {
          newChat();
          dispatch({ type: "SET_MODE", mode: next });
        },
      });
    },
    [state.running, state.mode, state.items.length, state.versions.length, newChat],
  );

  // 草模 → 正式設計(升級路徑):切設計模式開新對話,把場景規格摘要 prefill 進
  // composer(不自動送出——AI 動手前,人先過目;匯入元件流程的同一哲學)。
  const promoteSketch = useCallback(
    (v) => {
      if (state.running) return;
      setConfirmBox({
        eyebrow: "PROMOTE · 轉為正式設計",
        body: `切到「設計」模式開新對話,並把草模「${v.title || v.name}」的規格摘要(機構件、驅動範圍)帶入輸入框——可先修改再送出。`,
        actionLabel: "切換並帶入規格",
        accent: "var(--sketch)",
        onConfirm: async () => {
          let specText = `照草模「${v.title || v.name}」做正式設計:沿用其關節配置與行程;截面、材料與軸承配置由你建議,先列規格再動工。`;
          try {
            const r = await fetch(v.sceneUrl);
            if (r.ok) {
              const doc = await r.json();
              const drives = (doc.drives || [])
                .map((d) => `${d.label || d.id} ${d.min}~${d.max}${d.unit || ""}`)
                .join("、");
              const bodies = (doc.bodies || [])
                .filter((b) => b?.label)
                .map((b) => b.label)
                .join("、");
              specText =
                `照機構草模「${doc.title || v.name}」做正式設計:` +
                (bodies ? `機構件=${bodies};` : "") +
                (drives ? `驅動=${drives};` : "") +
                `沿用其關節配置與行程,截面、材料與軸承配置由你建議,先列規格再動工。`;
            }
          } catch {
            /* fetch 失敗用降級摘要 */
          }
          newChat();
          dispatch({ type: "SET_MODE", mode: "design" });
          dispatch({ type: "SET_PREFILL", text: specText });
        },
      });
    },
    [state.running, newChat],
  );

  // 可另存 = 這條 session 產過東西(開檔看圖的 o* 版本不算,那本來就在 models/ 裡;
  // 草模/零件庫不支援另存——只有設計模式有 session 產物專案)
  const canSave = !!(
    state.mode === "design" &&
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
            mode: state.mode,
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
    state.mode,
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
        const r = await fetch(apiUrl(`/api/session-info?id=${encodeURIComponent(snap.sessionId)}`));
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
        // 草模 session 的產物訊號是 hasSketch(session-info 另回);設計走 hasGenerator;
        // 零件庫無建模產物(versions 恆空,hasGenVersions=false 本就繞過)→ 恆 true 防禦
        const artifactAlive =
          snap.mode === "sketch"
            ? info.hasSketch
            : snap.mode === "library"
              ? true
              : info.hasGenerator;
        if (info.exists && (!hasGenVersions || artifactAlive)) {
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
  const sketchMode = state.mode === "sketch";
  const designMode = state.mode === "design"; // 時間軸動作/ParamsBar 只屬於設計模式
  // 零件庫硬閘:新對話(還沒有任何訊息)未附上 STP 前鎖定輸入框——訪談開始後
  // 不再鎖(否則沒法回答 AI 的追問)。附件鈕/拖放/空狀態上傳區是解鎖的路。
  // demo 例外:零件庫全程鎖(demo 不能收庫訪談,upload-step 端點也被擋)。
  const libraryLocked =
    state.mode === "library" &&
    (demo ||
      (state.items.length === 0 &&
        !pendingFiles.some((p) => p.kind === "step" && p.status === "ready")));

  // LibraryShelf 卡片動作:預覽=載進畫布(單純檢視,不進時間軸——與 library_preview
  // 工具同語意);⇪ 設計=確認切設計模式(開新對話)後強制 mint 新 session 匯入。
  const shelfPreview = useCallback((p, glbUrl) => {
    if (!glbUrl) return;
    dispatch({
      type: "PRESENT",
      glbUrl,
      name: p.slug,
      code: p.slug,
      ver: "",
      fileType: "part",
      source: "opened",
    });
  }, []);
  const shelfImportToDesign = useCallback(
    (p, glbUrl) => {
      if (state.running) return;
      setConfirmBox({
        eyebrow: "USE PART · 用這件零件",
        body: `切到「設計」模式開新對話,並把「${p.label}」匯入場景——匯入後描述要怎麼配上你的設計幾何即可。`,
        actionLabel: "切換並匯入",
        accent: "var(--part)",
        onConfirm: async () => {
          newChat();
          dispatch({ type: "SET_MODE", mode: "design" });
          await importFile(p.rel, {
            sessionId: null, // 強制新設計 session(舊閉包是零件庫 session)
            present: glbUrl ? { glbUrl, name: p.slug } : undefined, // 匯入即上畫布
          });
        },
      });
    },
    [state.running, newChat, importFile],
  );
  // 需要使用者作答的介面一律在視圖(聊天卡=被動紀錄):
  // 最新 spec 卡 → 視圖 SpecPanel(規格修正);最舊未答 lesson_offer → 視圖是/否面板。
  const liveSpec = useMemo(() => latestSpecItem(state.items), [state.items]);
  // demo 不出教訓是/否面板:按「是」的 /api/lessons/record 會被 demoGuard 403
  const liveLessonOffer = useMemo(
    () => (demo ? null : pendingLessonOffer(state.items)),
    [state.items, demo],
  );
  // 聊天最新 spec 卡的「請在右側操作」指路:specs 空的 clarify(單步精靈)待答時
  // 右側沒有任何規格編輯面 → 指路要熄,否則主動誤導。
  const specLiveId =
    liveSpec && (!state.clarify || (state.clarify.specs || []).length > 0) ? liveSpec.id : null;
  // SpecPanel 未套用的草稿:clarify 到達會令面板讓位卸載,草稿經此 ref 轉交給
  // 精靈步驟 1 續用(ref 不觸發重渲染;clarify 到達的那次渲染讀到的即最新草稿,
  // specId 比對防舊規格殘稿汙染)。
  const clarifySeedEdits =
    state.clarify && liveSpec && specDraftRef.current?.specId === liveSpec.id
      ? specDraftRef.current.edits
      : null;

  return (
    <div className="app" data-mode={state.mode}>
      <Header
        phase={state.phase}
        hasVersions={state.versions.length > 0}
        canvasType={state.canvas.type}
        canvasPartCount={state.versions.find((v) => v.id === state.activeVer)?.partCount}
        mode={state.mode}
        onSwitchMode={switchMode}
        demo={demo}
        onOpenFiles={() => setBrowserOpen(true)}
        onSaveProject={canSave ? () => setSaveOpen(true) : null}
        onNewChat={newChat}
        onOpenLessons={() => setLessonsOpen(true)}
        running={state.running}
      />
      <LessonsPanel open={lessonsOpen} onClose={() => setLessonsOpen(false)} />
      <ConfirmDialog box={confirmBox} onClose={() => setConfirmBox(null)} />
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
      <StageStepper stageIdx={state.stageIdx} mode={state.mode} />
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
            mode={state.mode}
            specLiveId={specLiveId}
            onSubmitText={submitText}
            onAttachFiles={attachFiles}
            attachDisabled={demo}
            attachDisabledTip={DEMO_TIP}
            handlers={handlers}
          />
          <Composer
            running={state.running}
            mode={state.mode}
            locked={libraryLocked}
            lockedHint={demo ? DEMO_TIP : undefined}
            attachDisabled={demo}
            attachDisabledTip={DEMO_TIP}
            pickRefs={state.pickRefs}
            pendingFiles={pendingFiles}
            onAttachFiles={attachFiles}
            onRemoveFile={(id) => setPendingFiles((prev) => prev.filter((p) => p.id !== id))}
            prefill={state.prefill}
            onPrefillConsumed={() => dispatch({ type: "CLEAR_PREFILL" })}
            onRemovePick={(token) => dispatch({ type: "REMOVE_PICKREF", token })}
            onClearPicks={() => dispatch({ type: "CLEAR_PICKREFS" })}
            onSubmit={submitText}
            onInterrupt={interrupt}
          />
        </div>
        <div className="right-col">
          {state.mode === "library" && (
            <LibraryShelf
              onPreview={shelfPreview}
              onImportToDesign={shelfImportToDesign}
              refreshSignal={state.running}
              readOnly={demo}
            />
          )}
          {sketchMode ? (
            // 草模世界:SketchCanvas3D(內含 DofBar 底欄)取代 Canvas3D+ParamsBar;
            // 面標記/物件屬性/匯出提示/運動示意 chip 天然不存在(獨立元件)
            <SketchCanvas3D
              canvas={state.canvas}
              dispatch={dispatch}
              running={state.running}
              live={state.live}
              stageIdx={state.stageIdx}
              toolFeed={toolFeed}
              clarify={state.clarify}
              clarifySeedEdits={clarifySeedEdits}
              spec={liveSpec}
              lessonOffer={liveLessonOffer}
              onLessonOffer={handlers.onLessonOffer}
              onSpecEdits={onSpecEdits}
              onSubmitText={submitText}
            />
          ) : (
            <>
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
                clarifySeedEdits={clarifySeedEdits}
                spec={liveSpec}
                lessonOffer={liveLessonOffer}
                onLessonOffer={handlers.onLessonOffer}
                onSpecEdits={onSpecEdits}
                onSubmitText={submitText}
                onExportParts={
                  // 檢視開啟的檔案(o* 版)時藏拆件匯出:server 只能從 session 產物抽件,
                  // fallback 會抽到錯的模型(見 exportParts 內的守衛註解)
                  state.sessionId && state.canvas.source !== "opened" ? exportParts : null
                }
                partsBusy={exporting === "parts:step" || exporting === "parts:stl"}
                exportNote={
                  exporting
                    ? exporting === "validate"
                      ? "精算此版:完整幾何驗證中…"
                      : exporting === "stepdl"
                        ? "下載前驗證中(未驗證版的匯出閘)…"
                        : exporting.startsWith("parts:")
                          ? `正在匯出零件檔(${(exporting.split(":")[1] || "").toUpperCase()})…`
                          : `正在轉出 ${(exporting.split(":")[1] || "").toUpperCase()} 檔…`
                    : null
                }
                motion={
                  state.motion && state.motion.forVer === state.canvas.ver ? state.motion : null
                }
                // 掃出工作窗:與底部 ParamsBar 共享同一份 params state/dirty/套用
                params={state.params}
                onParam={(k, v) => dispatch({ type: "SET_PARAM_VALUE", key: k, value: v })}
                onApplyParams={applyParams}
              />
              {designMode && (
                <ParamsBar
                  params={state.params}
                  disabled={state.canvas.status !== "ready" || state.running}
                  onParam={(k, v) => dispatch({ type: "SET_PARAM_VALUE", key: k, value: v })}
                  onApply={applyParams}
                />
              )}
            </>
          )}
          <VersionTimeline
            versions={state.versions}
            activeVer={state.activeVer}
            onSelect={(id) => dispatch({ type: "SELECT_VERSION", id })}
            onRevert={revertVersion}
            onExport={designMode && state.sessionId ? exportVersion : null}
            onDownloadStep={designMode && state.sessionId ? downloadStep : null}
            onValidate={designMode && state.sessionId ? validateVersion : null}
            onExportParts={
              designMode && state.sessionId && state.canvas.type === "assembly"
                ? () => exportParts(null, "step")
                : null
            }
            onPromote={sketchMode ? promoteSketch : null}
            exporting={exporting}
            running={state.running}
          />
        </div>
      </div>
    </div>
  );
}
