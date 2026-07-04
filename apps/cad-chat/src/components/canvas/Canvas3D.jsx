import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { useCadViewport } from "../../hooks/useCadViewport.js";
import { createMotionPlayer } from "../../lib/cadMotion.js";
import { buildTopologyModel } from "../../lib/cadTopology.js";
import PropertiesDrawer from "./PropertiesDrawer.jsx";

// 面標記顯示上限:每個被圈選零件最多 6 個、整體最多 12(避免大組合件菱形海)。
const MARKERS_PER_PART = 6;
const MARKERS_TOTAL = 12;

export default function Canvas3D({ canvas, propsOpen, selNode, dispatch, onBringToChat, motion, pickRefs }) {
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
  const [orbit, setOrbit] = useState(false);
  const [playing, setPlaying] = useState(false);
  const empty = !canvas.glbUrl;

  motionRef.current = motion || null;

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

  useCadViewport(mountRef, canvas.glbUrl, {
    name: canvas.name,
    onStatus: (status) => dispatch({ type: "SET_CANVAS_STATUS", status }),
    onReady: ({ runtime, model, setSelection, setAutoRotate }) => {
      const t = buildTopologyModel(runtime);
      topoRef.current = t;
      setTopo(t);
      apiRef.current = { model, runtime, setSelection, setAutoRotate };
      playerRef.current = model ? createMotionPlayer(THREE, model, runtime) : null;
      selRef.current = [];
      playingRef.current = false;
      setSelParts([]);
      setOrbit(false);
      setPlaying(false);
    },
    onFrame: ({ camera, host }) => {
      updateMarkers(camera, host);
      if (playingRef.current && playerRef.current && motionRef.current) {
        playerRef.current.apply(motionRef.current, performance.now() / 1000);
      }
    },
    onPickPart: (hit) => selectPart(hit?.partId || null, hit?.mode || "toggle"),
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

  // 「已帶入對話」= pickRefs 現存的 token(chips 移除/送出即熄滅,生命週期跟著 composer)。
  const citedTokens = useMemo(
    () => new Set((pickRefs || []).map((r) => r.token)),
    [pickRefs],
  );

  // 面標記:單件模型直接顯示前 6 個面;組合件要先雙擊圈選零件,
  // 才顯示「被圈選那幾件」的面標記(避免 6 個菱形全擠在第一個零件上)。
  const isAsm = (topo?.overall?.shapeCount || 0) > 1;
  const faceMarkers = useMemo(() => {
    const faceNodes = (topo?.nodes || []).filter(
      (n) => n.kind === "face" && Array.isArray(n.row?.center),
    );
    if (!isAsm) return faceNodes.slice(0, MARKERS_PER_PART);
    if (!selParts.length) return [];
    const out = [];
    const perPart = {};
    for (const n of faceNodes) {
      if (out.length >= MARKERS_TOTAL) break;
      const occ = n.ownerOcc;
      if (!occ) continue;
      const pid = selParts.find((p) => occ === p || occ.startsWith(`${p}.`));
      if (!pid) continue;
      perPart[pid] = (perPart[pid] || 0) + 1;
      if (perPart[pid] > MARKERS_PER_PART) continue;
      out.push(n);
    }
    return out;
  }, [topo, isAsm, selParts]);
  markersRef.current = [];

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
        <div className="canvas-empty">
          <span className="canvas-empty-box">3D</span>
          <span className="canvas-empty-text">產出後,模型會在這裡出現</span>
        </div>
      ) : (
        <>
          <span className="model-ghost">{(canvas.name || "MODEL").toUpperCase()}</span>
          <div className="viewport" ref={mountRef} />
          <div className="markers">
            {faceMarkers.map((n, i) => {
              const token = n.ref?.copyText || n.label;
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
                >
                  <span className="pick-diamond" />
                </a>
              );
            })}
          </div>
          <span className="orbit-hint">⟳ 拖曳旋轉</span>
          <div className="canvas-tools" data-drawer={propsOpen}>
            <a className="tool-chip" data-on={orbit} onClick={toggleOrbit}>
              ⟳ 環繞
            </a>
            {motionReady && (
              <a className="tool-chip motion-toggle" data-on={playing} onClick={togglePlay}>
                {playing ? "⏸ 停止" : "▶ 運動示意"}
              </a>
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
              <a className="sel-action sel-clear" onClick={() => selectPart(null)}>
                ✕
              </a>
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
            />
          )}
        </>
      )}
    </div>
  );
}
