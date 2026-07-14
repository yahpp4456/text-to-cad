import React, { useEffect, useMemo, useRef, useState } from "react";

import { useSketchViewport } from "../../hooks/useSketchViewport.js";
import { compileSketch } from "../../lib/sketch/sketchEval.js";
import { STAGES_SKETCH } from "../StageStepper.jsx";
import ClarifyWizard from "./ClarifyWizard.jsx";
import DofBar from "./DofBar.jsx";
import LessonOfferPanel from "./LessonOfferPanel.jsx";
import SpecPanel from "./SpecPanel.jsx";

// 草模視圖(Canvas3D 的平行元件,不動後者):fetch canvas.sceneUrl → 防禦性
// validate+compile → useSketchViewport 播放。回傳 fragment(.canvas 區 + DofBar
// 底欄)佔 Canvas3D+ParamsBar 的版位。讀數/滑桿值由 onTick 節流(~8Hz)餵 React。
export default function SketchCanvas3D({
  canvas,
  dispatch,
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
}) {
  const mountRef = useRef(null);
  const apiRef = useRef(null);
  const tickRef = useRef(0);
  const [compiled, setCompiled] = useState(null);
  const [uiTick, setUiTick] = useState(0); // 節流的讀數/滑桿刷新脈搏
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [gridOn, setGridOn] = useState(true);
  const [axesOn, setAxesOn] = useState(true);
  const [orbit, setOrbit] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const empty = !canvas.sceneUrl;

  // 場景載入:sceneUrl → JSON → compile(內含 validate;server 已驗過,這裡是
  // 防禦性重驗——localStorage 回灌/GC 後 404 都要誠實報錯不是白屏)。
  useEffect(() => {
    if (!canvas.sceneUrl) {
      setCompiled(null);
      return undefined;
    }
    let alive = true;
    dispatch({ type: "SET_CANVAS_STATUS", status: "loading" });
    (async () => {
      try {
        const r = await fetch(canvas.sceneUrl);
        if (!r.ok) throw new Error(`場景檔載入失敗(HTTP ${r.status},可能已被清理)`);
        const doc = await r.json();
        const c = compileSketch(doc);
        if (alive) setCompiled(c);
      } catch (err) {
        if (alive) {
          console.error("[cad-chat] 草模場景載入失敗", err);
          setCompiled(null);
          dispatch({ type: "SET_CANVAS_STATUS", status: "error" });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [canvas.sceneUrl]);

  useSketchViewport(mountRef, compiled, {
    onStatus: (status) => dispatch({ type: "SET_CANVAS_STATUS", status }),
    onReady: (api) => {
      apiRef.current = api;
      // 新草模到達 → 自動播放(概念展示的第一印象;誠實標語常駐兜底)
      setPlaying(true);
      setSpeed(1);
      setGridOn(true);
      setAxesOn(true);
      setOrbit(false);
      tickRef.current = 0;
      setUiTick((t) => t + 1);
    },
    onTick: (frame, program, clock) => {
      // ~8Hz 刷新 React 側讀數/滑桿(RAF 全速刷會浪費;1-2 支滑桿 8Hz 足夠滑順)
      const now = performance.now();
      if (now - tickRef.current > 125) {
        tickRef.current = now;
        setUiTick((t) => t + 1);
        if (clock.playing !== playing) setPlaying(clock.playing);
      }
    },
  });

  // Playwright / 除錯鉤(僅 dev):煙測注入場景後斷言 bodies/DOF/播放/scrub
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__cadSketch = {
      scene: () =>
        compiled
          ? {
              bodies: compiled.doc.bodies.length,
              drives: compiled.dofs.map((d) => d.id),
              derived: compiled.doc.derived.length,
              program: compiled.program.mode,
            }
          : null,
      state: () => apiRef.current?.state() ?? null,
      applyAt: (t) => (apiRef.current ? (apiRef.current.applyAt(t), true) : false),
      setDrive: (id, v) => {
        apiRef.current?.setDrive(id, v);
        setPlaying(false);
        // 回 manual(同步已設);drives 來自上一渲染幀,RAF 未跑前是 stale 值
        return apiRef.current?.state()?.manual?.[id] ?? null;
      },
      readout: (label) =>
        (apiRef.current?.frame()?.readouts || []).find((r) => r.label === label) ?? null,
      frame: () => apiRef.current?.frame() ?? null,
      legend: () => apiRef.current?.legend ?? [],
      // 場景真 Mesh 數:唯一釘得住 buildPart mesh 分支的訊號(圖例/scene() 都
      // 只讀 doc;未知 part type 靜默 return null 不丟錯,少長件數才看得出)。
      meshCount: () => apiRef.current?.meshCount?.() ?? 0,
    };
  }, [compiled]);

  const st = apiRef.current?.state();
  const readouts = apiRef.current?.frame()?.readouts || [];
  const phaseName = st?.phase ?? null;
  const legend = apiRef.current?.legend || [];
  const dofs = compiled?.dofs || [];
  const driveValues = st?.drives || {};
  void uiTick; // 讀數/滑桿依 uiTick 重渲染

  const togglePlay = () => {
    if (!apiRef.current) return;
    apiRef.current.toggle();
    setPlaying(apiRef.current.state().playing);
  };
  const pickSpeed = (x) => {
    setSpeed(x);
    apiRef.current?.setSpeed(x);
  };
  const resetPose = () => {
    apiRef.current?.reset();
    setPlaying(false);
  };
  const onDrive = (id, v) => {
    apiRef.current?.setDrive(id, v);
    setPlaying(false);
    setUiTick((t) => t + 1);
  };

  const title = useMemo(() => compiled?.doc?.title || canvas.name || "機構草模", [compiled, canvas.name]);

  return (
    <>
      <div className="canvas" data-empty={empty} data-sketch="true">
        <div className="canvas-tag">
          <span className="bar bar-sketch" />
          <span className="canvas-eyebrow">MOTION SKETCH · 機構草模</span>
        </div>

        {empty ? (
          running ? (
            <div className="canvas-progress">
              <span className="prog-eyebrow">SKETCHING · 搭建草模中</span>
              <div className="prog-stages">
                {STAGES_SKETCH.map(([cn, en], i) => {
                  const s = i < stageIdx ? "done" : i === stageIdx ? "cur" : "pending";
                  return (
                    <div className="prog-stage" data-state={s} key={en}>
                      <span className="prog-dot" data-state={s}>
                        {s === "done" ? "✓" : i + 1}
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
                      {t.note ? <span className="prog-tool-note">{t.note}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="canvas-empty">
              <span className="canvas-empty-box sketch">草模</span>
              <span className="canvas-empty-text">
                用一句話描述機構構想,幾秒搭出可玩的運動示意
              </span>
              <span className="canvas-empty-sub">
                例:汽缸推平台前傾 30°、旋轉臂夾爪 90° 翻轉取放、齒條行程 40mm
              </span>
              <span className="canvas-empty-sub dim">
                剛體示意 · 非真實幾何 · 要產可製造零件請切到「設計」模式
              </span>
            </div>
          )
        ) : (
          <>
            <span className="model-ghost">{(canvas.name || "SKETCH").toUpperCase()}</span>
            <div className="viewport" ref={mountRef} />
            {running && (
              <div className="canvas-progress-strip">
                <span className="live-dot" />
                <span>{live?.text || "回合進行中…"}</span>
              </div>
            )}
            {canvas.status === "loading" && (
              <div className="canvas-loading">
                <span className="live-dot" />
                <span>載入草模場景…</span>
              </div>
            )}
            {canvas.status === "error" && (
              <div className="canvas-loading">
                <span>⚠ 草模場景載入失敗(可能已被清理)</span>
              </div>
            )}
            <span className="orbit-hint">⟳ 拖曳旋轉</span>
            {/* 播放叢集(fold-switch 版位):主播放 + 速度 + 回原位 + 視角 */}
            <div className="sketch-play" role="group" aria-label="播放控制">
              <a className="fold-seg main" data-on={playing} onClick={togglePlay}>
                {playing ? "⏸ 暫停" : "▶ 播放"}
              </a>
              {[0.5, 1, 2].map((x) => (
                <a key={x} className="fold-seg spd" data-on={speed === x} onClick={() => pickSpeed(x)}>
                  {x}×
                </a>
              ))}
              <a className="fold-seg" onClick={resetPose} title="回到 home 姿態定格">
                ↺
              </a>
              <a className="fold-seg" onClick={() => apiRef.current?.homeCamera()} title="重設視角">
                ⌂
              </a>
            </div>
            <div className="canvas-tools">
              <a
                className="tool-chip"
                data-on={gridOn}
                onClick={() => {
                  setGridOn(!gridOn);
                  apiRef.current?.setGrid(!gridOn);
                }}
              >
                ⊞ 網格
              </a>
              <a
                className="tool-chip"
                data-on={axesOn}
                onClick={() => {
                  setAxesOn(!axesOn);
                  apiRef.current?.setAxes(!axesOn);
                }}
              >
                ⤱ 座標軸
              </a>
              <a
                className="tool-chip"
                data-on={orbit}
                onClick={() => {
                  setOrbit(!orbit);
                  apiRef.current?.setAutoRotate(!orbit);
                }}
              >
                ⟳ 環繞
              </a>
              <a className="tool-chip" data-on={legendOpen} onClick={() => setLegendOpen(!legendOpen)}>
                ≡ 圖例
              </a>
            </div>
            {legendOpen && legend.length > 0 && (
              <div className="sketch-legend">
                <span className="sketch-legend-t">圖例</span>
                {legend.map((l, i) => (
                  <span className="sketch-legend-row" key={i}>
                    <span className="sketch-sw" style={{ background: l.color }} />
                    {l.label}
                  </span>
                ))}
              </div>
            )}
            {(readouts.length > 0 || phaseName) && (
              <div className="sketch-readouts">
                {readouts.map((r) =>
                  r.kind === "phase" ? (
                    <span className="sk-read" key={r.id}>
                      <span className="sk-k">{r.label}</span>
                      <span className="sk-v">{phaseName || "—"}</span>
                    </span>
                  ) : (
                    <span className="sk-read" key={r.id} data-status={r.status || undefined}>
                      {r.status && <span className="sk-dot" data-status={r.status} />}
                      <span className="sk-k">{r.label}</span>
                      <span className="sk-v">
                        {r.text}
                        {r.unit || ""}
                      </span>
                    </span>
                  ),
                )}
                {st?.manual && <span className="sk-read sk-manual">手動</span>}
              </div>
            )}
            <span className="motion-note sketch-note">機構草模 · 剛體示意 · 非真實幾何</span>
            <div className="model-info">
              <span className="model-name">{title}</span>
              <span className="model-code">
                {canvas.name} · {canvas.ver} · 草模{dofs.length ? ` · ${dofs.length} DOF` : ""}
              </span>
              <span className="model-pick-hint">拖底部滑桿定格姿態 · ▶ 播放觀察動作</span>
            </div>
          </>
        )}

        {/* 作答面一律在視圖(同 Canvas3D):規格修正面板 + 教訓是/否面板,
            clarify 待答時讓位給聚光燈精靈 */}
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
      <DofBar
        dofs={dofs}
        values={driveValues}
        disabled={empty || canvas.status !== "ready"}
        onDrive={onDrive}
      />
    </>
  );
}
