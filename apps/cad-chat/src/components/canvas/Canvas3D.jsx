import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { useCadViewport } from "../../hooks/useCadViewport.js";
import { createMotionPlayer } from "../../lib/cadMotion.js";
import { measureBetween } from "../../lib/measureFacts.js";
import { buildTopologyModel } from "../../lib/cadTopology.js";
import { STAGES } from "../StageStepper.jsx";
import ClarifyWizard from "./ClarifyWizard.jsx";
import LessonOfferPanel from "./LessonOfferPanel.jsx";
import PropertiesDrawer from "./PropertiesDrawer.jsx";
import SpecPanel from "./SpecPanel.jsx";

// 面標記「預設顯示」上限:每件 6 個、整體 12(避免菱形海)。這只是預設——
// 候選面不設限,使用者可從「◇ 面標記」面板切全部/隱藏/逐面勾選。
const MARKERS_PER_PART = 6;
const MARKERS_TOTAL = 12;
// 面法向相對關係(measure vectorRelationship.relation)→ 中文
const REL_ZH = {
  opposed: "面相對",
  parallel: "面平行",
  perpendicular: "面垂直",
  coincident: "面重合",
  aligned: "面同向",
};

// 預設那 6 個面用最遠點取樣挑「空間上散得開」的:同軸疊在一起的外圓柱/頂底面
// 只會入選一兩個,名額讓給孔壁這類散佈的特徵(否則法蘭 7 面取前 6,第 4 個孔沒標記)。
function spreadPick(nodes, k) {
  if (nodes.length <= k) return nodes;
  const pts = nodes.map((n) => n.row.center);
  const d2 = (a, b) => {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  };
  const keep = new Set([0]);
  const minD = pts.map((p) => d2(p, pts[0]));
  while (keep.size < k) {
    let bi = -1;
    let bd = -1;
    for (let i = 0; i < pts.length; i++) {
      if (!keep.has(i) && minD[i] > bd) {
        bd = minD[i];
        bi = i;
      }
    }
    if (bi < 0) break;
    keep.add(bi);
    for (let i = 0; i < pts.length; i++) {
      const nd = d2(pts[i], pts[bi]);
      if (nd < minD[i]) minD[i] = nd;
    }
  }
  return nodes.filter((_, i) => keep.has(i));
}

export default function Canvas3D({
  canvas,
  propsOpen,
  selNode,
  dispatch,
  onBringToChat,
  motion,
  pickRefs,
  running,
  live,
  stageIdx,
  toolFeed,
  clarify,
  clarifySeedEdits,
  spec,
  lessonOffer,
  onLessonOffer,
  onSpecEdits,
  onSubmitText,
  onExportParts,
  partsBusy,
  exportNote,
}) {
  const mountRef = useRef(null);
  const markersRef = useRef([]);
  const [topo, setTopo] = useState(null);
  const topoRef = useRef(null);
  const apiRef = useRef({});
  const selRef = useRef([]);
  const playerRef = useRef(null);
  const playingRef = useRef(false);
  const motionRef = useRef(null);
  const [selParts, setSelParts] = useState([]); // partId(occurrenceId) 陣列(多選,上限 4)
  // 逐件顯示三態(物件樹眼睛):{occurrenceId: "ghost"|"hidden"},缺項=solid。
  // 透視外殼看內部機構用;隨新模型載入重置(ref 供 dev 鉤讀最新值)。
  const [partDisplay, setPartDisplayState] = useState({});
  const partDisplayRef = useRef({});
  partDisplayRef.current = partDisplay;
  const [orbit, setOrbit] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [axesOn, setAxesOn] = useState(true);
  // 鈑金摺疊/攤平即時切換(canvas.flatGlbUrl 存在才出鈕):換 activeGlbUrl,零重算
  // (攤平 GLB 生成時已預先產好、glbCache 命中)。換版重置回 folded(見下 effect)。
  const [view, setView] = useState("folded");
  const [hoverFaceRow, setHoverFaceRow] = useState(null); // 菱形 hover → 面填色預覽
  // 面標記顯示模式:default=散佈取樣 6/件、all=全部候選、none=隱藏、custom=手動勾選集
  const [markerMode, setMarkerMode] = useState("default");
  const [markerPick, setMarkerPick] = useState(() => new Set()); // custom 模式的 node.id 集合
  const [pickerOpen, setPickerOpen] = useState(false); // ◇ 面標記面板開闔
  // 量測模式(唯讀查詢,獨立於零件圈選命令流):選兩面 → /api/measure → 3D 尺寸線 + 數值。
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePicks, setMeasurePicks] = useState([]); // [{token,center,rowIndex,label}] ≤2
  const [measureResult, setMeasureResult] = useState(null); // {value,axis,rel} | {error,axisFail}
  const [measureAxis, setMeasureAxis] = useState(null); // 軸 fallback:ok:false 時使用者指定
  const measureModeRef = useRef(false);
  measureModeRef.current = measureMode; // 給 viewport onClick 讀最新模式(不進 hook deps)
  const measurePicksRef = useRef([]);
  measurePicksRef.current = measurePicks; // dev 鉤讀最新值(繞開 [playing] deps 的 stale closure)
  const measureResultRef = useRef(null);
  measureResultRef.current = measureResult;
  const measureLabelRef = useRef({ el: null, center: null }); // 3D 中點數值標籤投影
  const previewGroupRef = useRef(null); // GROUP 節點預覽高亮中的群組 id(dev 鉤用)
  const markerProbeRef = useRef({}); // 標記顯示狀態探針(dev 鉤用,渲染期賦值)
  const empty = !canvas.glbUrl;

  motionRef.current = motion || null;

  // 攤平 GLB 存在且 view=flat 才顯示攤平,否則摺疊(換版/非鈑金件 flatGlbUrl=null → 恆摺疊)
  const flatUrl = canvas.flatGlbUrl || null;
  const activeGlbUrl = view === "flat" && flatUrl ? flatUrl : canvas.glbUrl;
  // 折彎線資料:換版時 fetch 該版 sidecar JSON(很小),攤平態疊虛線 overlay 用。
  const [flatLines, setFlatLines] = useState(null);
  useEffect(() => {
    if (!canvas.flatLinesUrl) {
      setFlatLines(null);
      return undefined;
    }
    let live = true;
    fetch(canvas.flatLinesUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live) setFlatLines(j && Array.isArray(j.lines) ? j : null);
      })
      .catch(() => live && setFlatLines(null));
    return () => {
      live = false;
    };
  }, [canvas.flatLinesUrl]);
  // 換版重置回摺疊(避免上一版停在攤平、新版無 flatGlbUrl 時卡住)
  useEffect(() => {
    setView("folded");
  }, [canvas.ver]);
  const selectView = (next) => {
    if (!flatUrl || next === view) return;
    // 切到攤平先停運動示意(展開態播放無意義)
    if (next === "flat" && playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      playerRef.current?.reset?.();
    }
    setView(next);
  };

  // 眼睛三態循環:solid → ghost(半透明,點擊穿透)→ hidden → solid。
  const cyclePartDisplay = useCallback((occId) => {
    if (!occId) return;
    setPartDisplayState((prev) => {
      const cur = prev[String(occId)];
      const nextVal = cur === "ghost" ? "hidden" : cur === "hidden" ? undefined : "ghost";
      const next = { ...prev };
      if (nextVal) next[String(occId)] = nextVal;
      else delete next[String(occId)];
      apiRef.current.setPartDisplay?.(next);
      return next;
    });
  }, []);

  // 圈選(多選,上限 4,超限丟最舊):單擊=toggle(再擊同件移除、擊空白清空,不動鏡頭);
  // 雙擊=focus(確保選中+鏡頭推近,不 toggle 取消)。屬性抽屜連動最後選的那件。
  const selectPart = useCallback(
    (partId, mode = "toggle") => {
      let next;
      if (!partId) {
        next = [];
      } else {
        const id = String(partId);
        const cur = selRef.current || [];
        if (mode === "focus") {
          next = cur.includes(id) ? cur : [...cur, id].slice(-4);
        } else {
          next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-4);
        }
      }
      selRef.current = next;
      apiRef.current.setSelection?.(next, { zoom: mode === "focus" && next.length > 0 });
      setSelParts(next);
      if (next.length) {
        const last = next[next.length - 1];
        const nodes = topoRef.current?.nodes || [];
        const nd = nodes.find((x) => x.kind === "shape" && x.row?.occurrenceId === last);
        dispatch({ type: "SELECT_NODE", id: nd ? nd.id : "__root" });
        dispatch({ type: "TOGGLE_PROPS", open: true });
      }
    },
    [dispatch],
  );

  // 量測 callbacks:必須定義在 useCadViewport 呼叫「之前」——onMeasurePick 被同步傳入
  // hook,若定義在後會 TDZ「Cannot access before initialization」整個 Canvas3D 白屏。
  const fmtMeasure = (v) => String(Math.round(Math.abs(v) * 100) / 100);
  // 面 pick 進來(viewport 量測分流,或 dev 鉤注入):累積至 2,第 3 面清空重來。每次新
  // pick 清掉上一組的軸指定;face 為 null(點空白)忽略。
  const onMeasurePick = useCallback((face) => {
    if (!face) return;
    setMeasureAxis(null);
    setMeasurePicks((prev) => (prev.length >= 2 ? [face] : [...prev, face]));
  }, []);
  const clearMeasureSel = useCallback(() => {
    setMeasurePicks([]);
    setMeasureResult(null);
    setMeasureAxis(null);
    apiRef.current.clearMeasure?.();
  }, []);

  useCadViewport(mountRef, activeGlbUrl, {
    name: canvas.name,
    // 攤平態才疊折彎虛線(摺疊態傳 null → 不建 overlay)
    bendLines: view === "flat" ? flatLines : null,
    onStatus: (status) => dispatch({ type: "SET_CANVAS_STATUS", status }),
    onReady: ({
      runtime,
      model,
      setSelection,
      setPartDisplay,
      setAutoRotate,
      setGrid,
      setAxes,
      setBendLines,
      setFaceHighlights,
      setMeasure,
      clearMeasure,
      faceFillCount,
      faceFillDebug,
      chrome,
    }) => {
      const t = buildTopologyModel(runtime);
      topoRef.current = t;
      setTopo(t);
      apiRef.current = {
        model,
        runtime,
        setSelection,
        setPartDisplay,
        setAutoRotate,
        setGrid,
        setAxes,
        setBendLines,
        setFaceHighlights,
        setMeasure,
        clearMeasure,
        faceFillCount,
        faceFillDebug,
        chrome,
      };
      playerRef.current = model ? createMotionPlayer(THREE, model, runtime) : null;
      selRef.current = [];
      playingRef.current = false;
      setSelParts([]);
      setOrbit(false);
      setPlaying(false);
      setGridOn(true); // 新模型載入 → 網格/座標軸回到預設開
      setAxesOn(true);
      setMarkerMode("default"); // 標記顯示模式跟著新模型重置
      setMarkerPick(new Set());
      setPickerOpen(false);
      setHoverFaceRow(null); // 舊模型的 rowIndex 在新拓撲上是隨機別的面,不得殘留
      setPartDisplayState({}); // 眼睛三態隨新模型重置(新版本全件回到可見)
      setMeasureMode(false); // 量測隨新模型重置(舊面 token 對新模型無效)
      setMeasurePicks([]);
      setMeasureResult(null);
      setMeasureAxis(null);
    },
    onFrame: ({ camera, host }) => {
      updateMarkers(camera, host);
      updateMeasureLabel(camera, host);
      if (playingRef.current && playerRef.current && motionRef.current) {
        playerRef.current.apply(motionRef.current, performance.now() / 1000);
      }
    },
    onPickPart: (hit) => selectPart(hit?.partId || null, hit?.mode || "toggle"),
    measureModeRef,
    onMeasurePick,
  });

  // 版本切換/重生把 motion 清掉時,停播並還原姿態
  useEffect(() => {
    if (!motion && playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      playerRef.current?.reset?.();
    }
  }, [motion]);

  // Playwright / 除錯鉤(僅 dev)
  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__cadMotion = {
        playing,
        sample: () => playerRef.current?.sample?.() || [],
        coverage: () =>
          motionRef.current && playerRef.current
            ? playerRef.current.coverage(motionRef.current)
            : null,
        // 定時套用(去 RAF flake):未播放時強制擺到 tSec 的姿態供斷言
        applyAt: (tSec) => {
          if (!playerRef.current || !motionRef.current) return false;
          playerRef.current.apply(motionRef.current, Number(tSec) || 0);
          return true;
        },
        matrixFor: (label) => playerRef.current?.matrixFor?.(label) ?? null,
      };
      window.__cadChrome = {
        grid: () => apiRef.current.chrome?.grid?.visible ?? null,
        axes: () => apiRef.current.chrome?.axes?.visible ?? null,
        // 折彎線 overlay 探針:{visible, count=線段組數(藍+紅)}(攤平態才存在)
        bendLines: () => {
          const g = apiRef.current.chrome?.bendLines;
          return g ? { visible: g.visible, count: g.children.length } : null;
        },
      };
      window.__cadFaceFill = {
        count: () => apiRef.current.faceFillCount?.() ?? 0,
        debug: () => apiRef.current.faceFillDebug?.() ?? null,
      };
      // 量測探針:mode/選面數/結果 + 尺寸線 group children 數;pickFace(rowIndex) 繞過
      // raycast 注入面 pick(smoke 用,免在畫布特定像素命中面)。全讀 ref/穩定 callback,
      // 不受 [playing] deps 的 stale closure 影響。
      window.__cadMeasure = {
        mode: () => measureModeRef.current,
        picks: () => measurePicksRef.current.length,
        result: () => measureResultRef.current,
        groupCount: () => apiRef.current.chrome?.measure?.children.length ?? 0,
        faceRows: () => [...(apiRef.current.runtime?.faceReferenceByRowIndex?.keys() || [])],
        faceFactsOf: (rowIndex) => {
          const ref = apiRef.current.runtime?.faceReferenceByRowIndex?.get(Number(rowIndex));
          const pd = ref?.pickData;
          return pd
            ? { token: ref.copyText, center: pd.center, normal: pd.normal, surfaceType: pd.surfaceType, params: pd.params }
            : null;
        },
        setMode: (on) => setMeasureMode(!!on),
        pickFace: (rowIndex) => {
          const ref = apiRef.current.runtime?.faceReferenceByRowIndex?.get(Number(rowIndex));
          const center = ref?.pickData?.center;
          if (!ref || !Array.isArray(center)) return false;
          onMeasurePick({ token: ref.copyText, center, rowIndex: Number(rowIndex), label: ref.copyText, pick: ref.pickData });
          return true;
        },
      };
      window.__cadPreview = { group: () => previewGroupRef.current };
      window.__cadMarkers = { state: () => markerProbeRef.current };
      // 眼睛三態探針:display()=目前 map;stateFor(labelOrOccId)=該件第一筆
      // record 的 {opacity, visible}(label 經 topo shape 列解析成 occurrenceId)
      window.__cadVisual = {
        display: () => ({ ...partDisplayRef.current }),
        stateFor: (key) => {
          const k = String(key || "");
          const nodes = topoRef.current?.nodes || [];
          const nd = nodes.find((x) => x.kind === "shape" && (x.label === k || x.row?.occurrenceId === k));
          const occ = nd?.row?.occurrenceId || k;
          const rec = (apiRef.current.model?.displayRecords || []).find(
            (r) => String(r.partId) === occ || String(r.partId).startsWith(`${occ}.`),
          );
          return rec
            ? { opacity: rec.material?.opacity ?? null, visible: rec.mesh?.visible ?? null }
            : null;
        },
      };
    }
  }, [playing]);

  function updateMarkers(camera, host) {
    const w = host.clientWidth;
    const h = host.clientHeight;
    const v = new THREE.Vector3();
    for (const m of markersRef.current) {
      if (!m?.el || !m.center) continue;
      v.set(m.center[0], m.center[1], m.center[2]).project(camera);
      m.el.style.opacity = v.z > 1 ? "0" : "1";
      m.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-50%)`;
    }
  }

  // 量測數值標籤:把兩面中點投影成畫面像素(仿 updateMarkers)。center 由量測 effect 設,
  // el 由 JSX ref 回呼設(measureResult.value 存在才渲染)。
  function updateMeasureLabel(camera, host) {
    const ref = measureLabelRef.current;
    if (!ref?.el) return;
    if (!ref.center) {
      ref.el.style.opacity = "0";
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    const v = new THREE.Vector3(ref.center[0], ref.center[1], ref.center[2]).project(camera);
    ref.el.style.opacity = v.z > 1 ? "0" : "1";
    ref.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-50%)`;
  }

  const togglePlay = () => {
    const next = !playing;
    playingRef.current = next;
    setPlaying(next);
    if (!next) playerRef.current?.reset?.();
  };
  const toggleOrbit = () => {
    const next = !orbit;
    setOrbit(next);
    apiRef.current.setAutoRotate?.(next);
  };
  const toggleGrid = () => {
    const next = !gridOn;
    setGridOn(next);
    apiRef.current.setGrid?.(next);
  };
  const toggleAxes = () => {
    const next = !axesOn;
    setAxesOn(next);
    apiRef.current.setAxes?.(next);
  };
  const toggleMeasure = () => {
    const next = !measureMode;
    setMeasureMode(next);
    if (next) setPickerOpen(false); // 進量測關面標記面板(避免菱形干擾點選)
    else clearMeasureSel();
  };

  // 「已帶入對話」= pickRefs 現存的 token(chips 移除/送出即熄滅,生命週期跟著 composer)。
  const citedTokens = useMemo(
    () => new Set((pickRefs || []).map((r) => r.token)),
    [pickRefs],
  );

  // 面級填色:已帶入的面持續亮 amber(不只亮菱形),hover 菱形時該面亮 emit 青做預覽。
  // 掃全部 face 節點而非只掃目前顯示的菱形——組合件切換圈選後,已帶入的面仍要亮著。
  useEffect(() => {
    const entries = [];
    for (const n of topo?.nodes || []) {
      if (n.kind !== "face" || !n.ref) continue;
      const rowIndex = n.ref.rowIndex ?? n.ref.pickData?.rowIndex;
      if (!Number.isInteger(rowIndex)) continue;
      const token = n.ref.copyText || n.label;
      if (citedTokens.has(token)) {
        entries.push({ rowIndex, color: "#e8a13a", opacity: 0.32 }); // --amber
      }
    }
    if (hoverFaceRow != null && !entries.some((e) => e.rowIndex === hoverFaceRow)) {
      entries.push({ rowIndex: hoverFaceRow, color: "#18a0c4", opacity: 0.3 }); // --emit
    }
    // 量測選中面亮綠(與端點球/尺寸線同色)。與 cited/hover 併入同一批——setFaceHighlights
    // 是整批替換,不可另開 effect 呼叫它,否則互相覆蓋(見 cad-chat-verify skill)。
    for (const p of measurePicks) {
      if (Number.isInteger(p.rowIndex) && !entries.some((e) => e.rowIndex === p.rowIndex)) {
        entries.push({ rowIndex: p.rowIndex, color: "#1f9d55", opacity: 0.34 });
      }
    }
    apiRef.current.setFaceHighlights?.(entries);
  }, [citedTokens, topo, hoverFaceRow, measurePicks]);

  // 量測:滿兩面 → 畫 3D 尺寸線(setMeasure,measureGroup)+ 前端 facts 即時算距離
  // (measureBetween,微秒,免 /api/measure round-trip、免「量測中」)。精度=後端 measure_targets
  // (兩者都是 facts 數學),座標系一致,防漂移靠 measureFacts.test.js 的後端 golden。measureAxis
  // 變(點軸 chip)對同兩面重算。面填色由上一個 effect 統一管(含量測面),此處只碰 measureGroup。
  useEffect(() => {
    if (measurePicks.length < 2) {
      apiRef.current.clearMeasure?.();
      measureLabelRef.current.center = null;
      setMeasureResult(null);
      return;
    }
    const [p, q] = measurePicks;
    apiRef.current.setMeasure?.({ a: p.center, b: q.center });
    measureLabelRef.current.center = [
      (p.center[0] + q.center[0]) / 2,
      (p.center[1] + q.center[1]) / 2,
      (p.center[2] + q.center[2]) / 2,
    ];
    const r = measureBetween(p.pick, q.pick, measureAxis);
    if (r.ok) {
      setMeasureResult({ value: r.signedDistance, axis: r.axis, rel: r.vectorRelationship });
    } else {
      setMeasureResult({ error: r.error || "無法量測這兩個面", axisFail: !!r.needAxis });
    }
  }, [measurePicks, measureAxis]);

  // GROUP 中繼節點(屬性樹點子組件)→ 3D 預覽高亮其所有後代:
  // occurrenceId 是點分前綴,applyPartVisualState 的比對前綴感知,直接把群組 id
  // 疊在圈選集合上呼叫 setSelection 即可;不寫 selParts → 不佔 4 件上限、
  // 名牌與面標記不受影響。點回葉節點/清空即還原。
  useEffect(() => {
    if (!apiRef.current.setSelection) return;
    const nd = selNode ? (topo?.nodes || []).find((x) => x.id === selNode) : null;
    if (nd && nd.kind === "occurrence") {
      previewGroupRef.current = nd.id;
      apiRef.current.setSelection([...(selRef.current || []), nd.id], { zoom: false });
    } else if (previewGroupRef.current) {
      previewGroupRef.current = null;
      apiRef.current.setSelection(selRef.current || [], { zoom: false });
    }
  }, [selNode, topo]);

  // 面標記三層:候選(不設限)→ 預設集(散佈取樣 6/件)→ 可見(依 markerMode)。
  // 單件模型候選=全部面;組合件要先圈選零件,候選=被圈選那幾件的面。
  const isAsm = (topo?.overall?.shapeCount || 0) > 1;
  const markerCandidates = useMemo(() => {
    const faceNodes = (topo?.nodes || []).filter(
      (n) => n.kind === "face" && Array.isArray(n.row?.center),
    );
    if (!isAsm) return faceNodes;
    if (!selParts.length) return [];
    return faceNodes.filter((n) => {
      const occ = n.ownerOcc;
      return occ && selParts.some((p) => occ === p || occ.startsWith(`${p}.`));
    });
  }, [topo, isAsm, selParts]);

  const defaultMarkerIds = useMemo(() => {
    if (!isAsm) return new Set(spreadPick(markerCandidates, MARKERS_PER_PART).map((n) => n.id));
    const ids = new Set();
    for (const pid of selParts) {
      if (ids.size >= MARKERS_TOTAL) break;
      const own = markerCandidates.filter(
        (n) => n.ownerOcc === pid || n.ownerOcc.startsWith(`${pid}.`),
      );
      for (const n of spreadPick(own, MARKERS_PER_PART)) {
        if (ids.size >= MARKERS_TOTAL) break;
        ids.add(n.id);
      }
    }
    return ids;
  }, [markerCandidates, isAsm, selParts]);

  const faceMarkers = useMemo(() => {
    if (markerMode === "all") return markerCandidates;
    if (markerMode === "none") return [];
    if (markerMode === "custom") return markerCandidates.filter((n) => markerPick.has(n.id));
    return markerCandidates.filter((n) => defaultMarkerIds.has(n.id));
  }, [markerMode, markerPick, markerCandidates, defaultMarkerIds]);
  const visibleMarkerIds = useMemo(() => new Set(faceMarkers.map((n) => n.id)), [faceMarkers]);
  markersRef.current = [];
  markerProbeRef.current = {
    mode: markerMode,
    visible: faceMarkers.length,
    total: markerCandidates.length,
  };

  // 圈選改變 = 候選面換了一批 → 顯示模式回預設(custom 勾選集是針對舊候選的)
  useEffect(() => {
    setMarkerMode("default");
    setMarkerPick(new Set());
  }, [selParts]);

  // hover 面填色只靠標記/面板列的 onMouseLeave 熄滅,但 hover 來源可能在滑鼠
  // 還沒離開時就 unmount(切換圈選、topo 換掉)——mouseleave 永不觸發,青色
  // 預覽就永久卡住。候選集裡已沒有這個 rowIndex 時強制熄滅。
  useEffect(() => {
    if (hoverFaceRow == null) return;
    const valid = markerCandidates.some((n) => {
      const ri = n.ref ? (n.ref.rowIndex ?? n.ref.pickData?.rowIndex) : null;
      return ri === hoverFaceRow;
    });
    if (!valid) setHoverFaceRow(null);
  }, [markerCandidates, hoverFaceRow]);

  // 面板勾選:以「目前可見集」為基底增減,一動就進 custom 模式
  const toggleMarker = (id) => {
    const next = new Set(visibleMarkerIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMarkerPick(next);
    setMarkerMode("custom");
  };

  const ver = canvas.ver || (topo ? "v1" : "");
  // 選取集合 → {pid,label,token}(token 給 cad_measure/cad_align;單件模型無 shape 節點時退回 #pid)
  const selInfos = selParts.map((pid) => {
    const nd = (topo?.nodes || []).find((x) => x.kind === "shape" && x.row?.occurrenceId === pid);
    return { pid, label: nd?.label || pid, token: nd?.token || `#${pid}` };
  });
  const motionReady = !!(motion && motion.dofs?.length);

  return (
    <div className="canvas" data-empty={empty}>
      <div className="canvas-tag">
        <span className="bar bar-emit" />
        <span className="canvas-eyebrow">3D CANVAS</span>
      </div>

      {empty ? (
        running ? (
          // 產圖進行中(還沒有模型):把 AI 的詳細處理進度攤在視圖區。
          <div className="canvas-progress">
            <span className="prog-eyebrow">GENERATING · 產圖中</span>
            <div className="prog-stages">
              {STAGES.map(([cn, en], i) => {
                const st = i < stageIdx ? "done" : i === stageIdx ? "cur" : "pending";
                return (
                  <div className="prog-stage" data-state={st} key={en}>
                    <span className="prog-dot" data-state={st}>
                      {st === "done" ? "✓" : i + 1}
                    </span>
                    <span className="prog-cn">{cn}</span>
                    <span className="prog-en">{en}</span>
                  </div>
                );
              })}
            </div>
            <div className="prog-live">
              <span className="live-dot" />
              <span>{live?.text || "思考中…"}</span>
            </div>
            {(toolFeed || []).length > 0 && (
              <div className="prog-feed">
                {toolFeed.map((t) => (
                  <div className="prog-tool" key={t.id} data-status={t.status}>
                    <span className="prog-tool-ic">
                      {t.status === "done" ? "✓" : t.status === "error" ? "✕" : "…"}
                    </span>
                    <span className="prog-tool-label">{t.label || t.name}</span>
                    {t.ms ? <span className="prog-tool-ms">{(t.ms / 1000).toFixed(1)}s</span> : null}
                    {t.note ? <span className="prog-tool-note">{t.note}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="canvas-empty">
            <span className="canvas-empty-box">3D</span>
            <span className="canvas-empty-text">產出後,模型會在這裡出現</span>
          </div>
        )
      ) : (
        <>
          <span className="model-ghost">{(canvas.name || "MODEL").toUpperCase()}</span>
          <div className="viewport" ref={mountRef} />
          <div className="markers">
            {faceMarkers.map((n, i) => {
              const token = n.ref?.copyText || n.label;
              const rowIndex = n.ref ? (n.ref.rowIndex ?? n.ref.pickData?.rowIndex) : null;
              return (
                <a
                  key={n.id}
                  className="pick-marker"
                  data-cited={citedTokens.has(token) || undefined}
                  ref={(el) => {
                    markersRef.current[i] = { el, center: n.row.center };
                  }}
                  title={citedTokens.has(token) ? `${n.label} · 已帶入對話` : n.label}
                  onClick={() => onBringToChat(token, n.label)}
                  onMouseEnter={() => Number.isInteger(rowIndex) && setHoverFaceRow(rowIndex)}
                  onMouseLeave={() =>
                    setHoverFaceRow((cur) => (cur === rowIndex ? null : cur))
                  }
                >
                  <span className="pick-diamond" />
                </a>
              );
            })}
          </div>
          {measureResult?.value != null && (
            <div
              className="measure-label"
              ref={(el) => {
                measureLabelRef.current.el = el;
              }}
            >
              {fmtMeasure(measureResult.value)} mm
            </div>
          )}
          {running && (
            <div className="canvas-progress-strip">
              <span className="live-dot" />
              <span>{live?.text || "回合進行中…"}</span>
            </div>
          )}
          {canvas.status === "loading" && (
            <div className="canvas-loading">
              <span className="live-dot" />
              <span>載入 3D 模型…</span>
            </div>
          )}
          {/* 匯出/轉檔是背景 spawn Python(OCCT 冷啟動首次較久)→ 中央明顯提示,
              視線在畫布也看得到;完成即消失(觸發下載)、失敗走對話 notify。 */}
          {exportNote && (
            <div className="canvas-export-note">
              <span className="live-dot" />
              <span className="canvas-export-main">{exportNote}</span>
              <span className="canvas-export-sub">首次轉檔較久,請稍候(不會離開此畫面)</span>
            </div>
          )}
          <span className="orbit-hint">⟳ 拖曳旋轉</span>
          {/* 鈑金摺疊/攤平:左上明顯雙段切換(點哪段切哪態,零重算) */}
          {flatUrl && (
            <div className="fold-switch" role="group" aria-label="摺疊/攤平">
              <a className="fold-seg" data-on={view === "folded"} onClick={() => selectView("folded")}>
                ◈ 摺疊
              </a>
              <a className="fold-seg" data-on={view === "flat"} onClick={() => selectView("flat")}>
                ▣ 攤平
              </a>
            </div>
          )}
          <div className="canvas-tools" data-drawer={propsOpen}>
            <a className="tool-chip" data-on={gridOn} onClick={toggleGrid}>
              ⊞ 網格
            </a>
            <a className="tool-chip" data-on={axesOn} onClick={toggleAxes}>
              ⤱ 座標軸
            </a>
            <a className="tool-chip" data-on={orbit} onClick={toggleOrbit}>
              ⟳ 環繞
            </a>
            <a className="tool-chip" data-on={measureMode} onClick={toggleMeasure}>
              📏 量測
            </a>
            <a
              className="tool-chip marker-toggle"
              data-on={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
            >
              ◇ 面標記 {faceMarkers.length}/{markerCandidates.length}
            </a>
            {motionReady && view !== "flat" && (
              <a className="tool-chip motion-toggle" data-on={playing} onClick={togglePlay}>
                {playing ? "⏸ 停止" : "▶ 運動示意"}
              </a>
            )}
            {pickerOpen && (
              <div className="marker-panel">
                <div className="marker-panel-acts">
                  <a
                    data-on={markerMode === "default"}
                    onClick={() => {
                      setMarkerMode("default");
                      setMarkerPick(new Set());
                    }}
                  >
                    預設
                  </a>
                  <a data-on={markerMode === "all"} onClick={() => setMarkerMode("all")}>
                    全部
                  </a>
                  <a data-on={markerMode === "none"} onClick={() => setMarkerMode("none")}>
                    隱藏
                  </a>
                </div>
                {markerCandidates.length === 0 ? (
                  <div className="marker-panel-hint">
                    {isAsm ? "先點擊圈選零件,才會列出可選面" : "此模型沒有可選面"}
                  </div>
                ) : (
                  <div className="marker-panel-list">
                    {markerCandidates.map((n) => {
                      const token = n.ref?.copyText || n.label;
                      const rowIndex = n.ref ? (n.ref.rowIndex ?? n.ref.pickData?.rowIndex) : null;
                      const ownerTag = isAsm
                        ? selInfos.find(
                            (s) => n.ownerOcc === s.pid || n.ownerOcc.startsWith(`${s.pid}.`),
                          )?.label || ""
                        : "";
                      return (
                        <label
                          key={n.id}
                          className="marker-row"
                          data-cited={citedTokens.has(token) || undefined}
                          onMouseEnter={() =>
                            Number.isInteger(rowIndex) && setHoverFaceRow(rowIndex)
                          }
                          onMouseLeave={() =>
                            setHoverFaceRow((cur) => (cur === rowIndex ? null : cur))
                          }
                        >
                          <input
                            type="checkbox"
                            checked={visibleMarkerIds.has(n.id)}
                            onChange={() => toggleMarker(n.id)}
                          />
                          <span className="marker-row-label">{n.label}</span>
                          {ownerTag ? <span className="marker-row-owner">{ownerTag}</span> : null}
                          {citedTokens.has(token) ? (
                            <span className="marker-row-cited">已帶入</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          {playing && <span className="motion-note">運動示意 · 等速往復 · 非物理模擬</span>}
          <div className="model-info">
            <span className="model-name">{canvas.name || "model"}</span>
            <span className="model-code">
              {canvas.code || canvas.name} · {ver}
              {canvas.type === "assembly" ? " · 組合件" : canvas.type === "part" ? " · 元件" : ""}
            </span>
            <span className="model-pick-hint">
              {isAsm && !selParts.length
                ? "點擊圈選零件 → 顯示面標記(◇)可帶入對話 · 雙擊推近"
                : "點面標記(◇)帶入對話 · 點擊圈選零件 · 雙擊推近"}
            </span>
          </div>
          {selInfos.length > 0 && (
            <div className="sel-nameplate">
              <span className="sel-kicker">已圈選 {selInfos.length > 1 ? `${selInfos.length} 件` : ""}</span>
              <span className="sel-name">{selInfos.map((s) => s.label).join(" + ")}</span>
              {selInfos.every((s) => citedTokens.has(s.token)) ? (
                <span className="sel-action" data-cited="true">
                  ✓ 已帶入
                </span>
              ) : (
                <a
                  className="sel-action"
                  onClick={() => selInfos.forEach((s) => onBringToChat?.(s.token, s.label))}
                >
                  帶入對話{selInfos.length > 1 ? ` (${selInfos.length})` : ""}
                </a>
              )}
              {isAsm && onExportParts
                ? ["step", "stl"].map((f) => (
                    <a
                      key={f}
                      className="sel-action sel-export"
                      data-busy={partsBusy || undefined}
                      title={`把圈選的 ${selInfos.length} 件各自匯出為 ${f.toUpperCase()}(多件打包 zip)`}
                      onClick={() => !partsBusy && !running && onExportParts(selInfos, f)}
                    >
                      {partsBusy ? "⤓ 匯出中…" : `⤓ ${f.toUpperCase()}`}
                    </a>
                  ))
                : null}
              <a className="sel-action sel-clear" onClick={() => selectPart(null)}>
                ✕
              </a>
            </div>
          )}

          {measureMode && (
            <div className="measure-hud">
              <span className="measure-kicker">
                📏 量測{measureAxis ? ` · ${measureAxis.toUpperCase()} 軸` : ""}
              </span>
              {measurePicks.length < 2 ? (
                <span className="measure-hint">點選第 {measurePicks.length + 1} / 2 個面</span>
              ) : measureResult?.value != null ? (
                <>
                  <span className="measure-value">{fmtMeasure(measureResult.value)} mm</span>
                  <span className="measure-sub">
                    {measureResult.axis ? `沿 ${measureResult.axis.toUpperCase()} 軸` : ""}
                    {measureResult.rel?.relation
                      ? ` · ${REL_ZH[measureResult.rel.relation] || measureResult.rel.relation}`
                      : ""}
                  </span>
                </>
              ) : measureResult?.error ? (
                <>
                  <span className="measure-err">{measureResult.error}</span>
                  {measureResult.axisFail && (
                    <span className="measure-axes">
                      指定軸
                      {["x", "y", "z"].map((ax) => (
                        <a
                          key={ax}
                          className="measure-axis-chip"
                          data-on={measureAxis === ax}
                          onClick={() => setMeasureAxis(ax)}
                        >
                          {ax.toUpperCase()}
                        </a>
                      ))}
                    </span>
                  )}
                </>
              ) : null}
              {(measurePicks.length > 0 || measureResult) && (
                <a className="measure-clear" onClick={clearMeasureSel}>
                  ✕ 清除
                </a>
              )}
            </div>
          )}

          <a
            className="props-toggle"
            data-open={propsOpen}
            onClick={() => dispatch({ type: "TOGGLE_PROPS" })}
          >
            ⊞ 物件屬性 {propsOpen ? "▸" : "◂"}
          </a>

          {propsOpen && (
            <PropertiesDrawer
              topo={topo}
              selNode={selNode || "__root"}
              canvas={canvas}
              activeVer={ver}
              dispatch={dispatch}
              onBringToChat={onBringToChat}
              citedTokens={citedTokens}
              partDisplay={partDisplay}
              onCycleDisplay={cyclePartDisplay}
              onPickPart={selectPart}
            />
          )}
        </>
      )}

      {/* 需要使用者作答的介面一律在視圖(聊天卡全為被動紀錄):
          規格修正 → SpecPanel(左上;clarify 待答時讓位,精靈步驟 1 即規格面);
          教訓是/否 → LessonOfferPanel(下方置中;同樣讓位給 clarify 聚光燈)。 */}
      {spec && !clarify && (
        <SpecPanel
          key={spec.id}
          spec={spec}
          onSubmitText={onSubmitText}
          onEditsChange={onSpecEdits}
        />
      )}
      {lessonOffer && !clarify && (
        <LessonOfferPanel offer={lessonOffer} onLessonOffer={onLessonOffer} />
      )}
      {/* 選擇題(clarify)= 焦點模式:scrim 壓暗背景 + 置中兩步精靈(步驟 1 確認/修改
          解析規格 → 步驟 2 選項;無 specs 退化單步)。左欄那張卡是被動紀錄(反灰、
          選項不可點),這裡才是唯一作答面。AI 還在講也能點;佇列會等回合結束自動送出。
          key=clarify.id:跨回合新 clarify 令精靈 remount,step/edits 歸零。 */}
      {clarify && (
        <>
          <div className="canvas-clarify-scrim" />
          <ClarifyWizard
            key={clarify.id || clarify.q}
            clarify={clarify}
            initialEdits={clarifySeedEdits}
            onSubmitText={onSubmitText}
          />
        </>
      )}
    </div>
  );
}
