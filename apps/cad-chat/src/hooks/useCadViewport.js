// cadjs three.js viewport:載入 GLB → buildModel → renderModel + OrbitControls。
// 同時載 selector bundle 供物件屬性與幾何點選(無 STEP_topology 時優雅降級)。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { buildModel, centerAndRadiusFromBounds, renderModel } from "cadjs";
import { loadRenderGlb, loadRenderSelectorBundle } from "cadjs/lib/renderAssetClient";
import { buildSelectorRuntime } from "cadjs/lib/selectors/runtime";
import { applyPartVisualState } from "cadjs/lib/viewer/partVisualState";
import { autoZoomFrameForBounds, focusedDisplayRecordsBounds } from "cadjs/lib/viewer/autoZoom";
import { niceGridStep, updateGridHelper } from "cadjs/lib/viewer/stageGrid";
import { syncDisplayMeshFaceIds } from "cadjs/lib/viewer/selectorPickGroups";
import {
  buildFaceFillGeometryFromDisplayMeshes,
  createReferenceEdgeGeometryFromPoints,
  REFERENCE_SELECTED_COLOR,
  REFERENCE_SELECTED_FILL_OPACITY,
} from "cadjs/lib/viewer/referenceGeometry";

import { buildSweepSegments } from "../lib/sweepOverlay.js";

export function useCadViewport(
  mountRef,
  glbUrl,
  { name, onStatus, onReady, onFrame, onPickPart, bendLines, sweepPaths, measureModeRef, onMeasurePick } = {},
) {
  const liveRef = useRef({});

  useEffect(() => {
    if (!glbUrl || !mountRef.current) return undefined;
    const host = mountRef.current;
    const ac = new AbortController();
    let disposed = false;
    onStatus?.("loading");

    (async () => {
      let meshData;
      try {
        meshData = await loadRenderGlb(glbUrl, { signal: ac.signal });
      } catch (err) {
        if (!disposed) {
          console.error("[cad-chat] loadRenderGlb failed", err);
          onStatus?.("error");
        }
        return;
      }
      if (disposed) return;

      // 載入後整段初始化也要設防:renderModel 的 new WebGLRenderer 在 WebGL
      // context 建立失敗(硬體加速關閉/GPU 重置/遠端桌面)會直接 throw——
      // 不接住的話 onStatus 永遠停在 reducer 已設的 "loading",浮層卡死。
      try {
        await initViewport(meshData);
      } catch (err) {
        if (!disposed) {
          console.error("[cad-chat] viewport 初始化失敗", err);
          onStatus?.("error");
        }
        // 半成品 canvas 別留在 host(liveRef 尚未寫入,effect cleanup 掃不到)
        host.querySelector("canvas.cad-canvas")?.remove();
      }
    })();

    async function initViewport(meshData) {
      const model = buildModel(THREE, meshData, {});
      const camera = new THREE.PerspectiveCamera(
        48,
        (host.clientWidth || 1) / (host.clientHeight || 1),
        0.1,
        50000,
      );
      camera.up.set(0, 0, 1);

      // renderModel 不會把 canvas 掛進 DOM —— 自建一個、掛入 host、當 options.canvas。
      const canvasEl = document.createElement("canvas");
      canvasEl.className = "cad-canvas";
      host.appendChild(canvasEl);

      const viewport = renderModel(THREE, model, {
        canvas: canvasEl,
        hostElement: host,
        camera,
        alpha: true, // 透明背景 → CSS 藍圖底透出
        autoResize: false,
        autoStart: true,
        disposeModel: false,
        beforeRender: () => {
          controls.update();
          onFrame?.({ camera, host });
        },
      });

      const controls = new OrbitControls(camera, viewport.renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      const { center, radius } = centerAndRadiusFromBounds(THREE, model.bounds, "cad");
      camera.position
        .copy(center)
        .add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(radius * 3.2));
      controls.target.copy(center);
      controls.update();

      // 地板網格:複用 viewer 的 shader 網格(有限圓盤、格距貼齊模型尺度、拉遠不會
      // 變成無限蜘蛛網)。顏色壓暗配藍圖底,透明度低於模型不搶戲。
      const gridRt = { THREE, scene: viewport.scene };
      const floorZ = Array.isArray(model.bounds?.min) ? Number(model.bounds.min[2]) || 0 : 0;
      updateGridHelper(gridRt, undefined, radius, floorZ, undefined, undefined, {
        floorSettings: {
          // 淺色藍圖底 → 柔和藍灰線,major(center)略深;壓低透明度不搶模型
          grid: { enabled: true, centerColor: "#8fa5bf", cellColor: "#c0cbda", opacity: 0.5 },
        },
      });
      // cad-chat 不把模型 recenter 到原點 → fade 圓盤與載體平面要跟著模型中心走
      // (stageGrid 建構時 uGridCenter 固定 [0,0],假設模型已置中)。
      // 另把格距換成 1/2/5 nice 刻度(約模型半徑 1/6,如 50mm)——預設 density 的
      // cell ≈ 1.8R 對單一模型視角太稀,量不出尺寸感。
      const gridMesh = gridRt.gridHelper || null;
      if (gridMesh) {
        gridMesh.position.set(center.x, center.y, floorZ);
        const uu = gridMesh.material?.uniforms || {};
        if (uu.uGridCenter) uu.uGridCenter.value = [center.x, center.y];
        if (uu.uCellSize) uu.uCellSize.value = niceGridStep(radius / 6);
      }
      // 座標系:世界原點三軸(X 紅 / Y 綠 / Z 藍)——CAD 產生器的座標原點有語義。
      const axes = new THREE.AxesHelper(radius * 1.2);
      viewport.scene.add(axes);
      // 鈑金攤平態折彎虛線 overlay(仿 axes:輔助幾何直接加進 scene)。只在載入攤平
      // GLB 時傳入 bendLines(Canvas3D view==="flat" 才給),摺疊態不傳 → 不建;切換
      // 是整個場景重建,故天然「攤平顯示、摺疊消失」。座標直接用 builder flat XY
      // (GLB 無 recenter、Z-up,世界座標==flat XY),疊在頂面 z=t+ε 防 z-fighting。
      const bendGroup = new THREE.Group();
      bendGroup.renderOrder = 26;
      if (bendLines && Array.isArray(bendLines.lines) && bendLines.lines.length) {
        const zTop = (Number(bendLines.t) || 0) + Math.max(radius * 0.001, 0.02);
        const mkLine = (segs, color) => {
          if (!segs.length) return null;
          const pos = new Float32Array(segs.length * 6);
          segs.forEach((s, i) => {
            pos.set([s.a[0], s.a[1], zTop, s.b[0], s.b[1], zTop], i * 6);
          });
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
          const mat = new THREE.LineDashedMaterial({
            color,
            dashSize: Math.max(radius * 0.025, 1.5),
            gapSize: Math.max(radius * 0.018, 1.0),
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            toneMapped: false,
          });
          const line = new THREE.LineSegments(geo, mat);
          line.computeLineDistances(); // LineDashedMaterial 必須,否則不斷線
          line.frustumCulled = false;
          line.renderOrder = 27;
          return line;
        };
        const up = mkLine(bendLines.lines.filter((l) => l.up), 0x2f6fe0); // 藍 = 上折
        const down = mkLine(bendLines.lines.filter((l) => !l.up), 0xd64848); // 紅 = 下折
        if (up) bendGroup.add(up);
        if (down) bendGroup.add(down);
        viewport.scene.add(bendGroup);
      }
      // 掃出路徑中心線 overlay(仿 bendGroup 的 dashed LineSegments;資料 = present 的
      // sweepPathsUrl sidecar,Canvas3D fetch 後傳入)。depthTest:false —— 掃出中心線
      // 在(常為空心的)實體內部,不穿透深度就永遠看不到;起終點小球仿 measure mkDot。
      const sweepGroup = new THREE.Group();
      sweepGroup.renderOrder = 28;
      {
        const built = buildSweepSegments(sweepPaths);
        if (built.length) {
          const dotGeo = new THREE.SphereGeometry(Math.max(radius * 0.012, 0.4), 16, 12);
          for (const pd of built) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pd.segments), 3));
            const line = new THREE.LineSegments(
              geo,
              new THREE.LineDashedMaterial({
                color: 0x18a0c4,
                dashSize: Math.max(radius * 0.025, 1.5),
                gapSize: Math.max(radius * 0.018, 1.0),
                transparent: true,
                opacity: 0.9,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
              }),
            );
            line.computeLineDistances(); // LineDashedMaterial 必須,否則不斷線
            line.frustumCulled = false;
            line.renderOrder = 29;
            sweepGroup.add(line);
            for (const p of [pd.start, pd.end]) {
              const dot = new THREE.Mesh(
                dotGeo,
                new THREE.MeshBasicMaterial({ color: 0x18a0c4, depthTest: false, toneMapped: false }),
              );
              dot.position.set(p[0], p[1], p[2]);
              dot.renderOrder = 30;
              sweepGroup.add(dot);
            }
          }
          viewport.scene.add(sweepGroup);
        }
      }
      const setGrid = (on) => {
        if (gridMesh) gridMesh.visible = !!on;
      };
      const setAxes = (on) => {
        axes.visible = !!on;
      };
      const setBendLines = (on) => {
        bendGroup.visible = !!on;
      };
      const setSweepPaths = (on) => {
        sweepGroup.visible = !!on;
      };

      const ro =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              const w = host.clientWidth;
              const h = host.clientHeight;
              if (w && h) {
                viewport.renderer.setSize(w, h, false);
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
              }
            })
          : null;
      ro?.observe(host);

      // 零件級拾取:raycast displayRecords 的 mesh,回報 userData.partId。
      // 單擊=圈選 toggle(延遲 220ms,讓 dblclick 有機會取消,避免「選→消→選」閃爍);
      // 雙擊=確保選中+鏡頭推近;位移 >5px 視為旋轉拖曳,不當點擊。
      const raycaster = new THREE.Raycaster();
      const pointerV = new THREE.Vector2();
      const raycastPartId = (ev) => {
        const rect = canvasEl.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        pointerV.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        pointerV.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
        raycaster.setFromCamera(pointerV, camera);
        // hidden 已因 mesh.visible=false 被濾;ghost(半透明)也要點擊穿透——
        // 透視的意義就是選得到內部件(要再選外殼從物件樹點)。
        const meshes = (model.displayRecords || [])
          .map((r) => r.mesh)
          .filter(
            (m) =>
              m &&
              m.visible !== false &&
              !idInSet(String(m.userData?.partId || ""), displayState.ghost),
          );
        const hit = raycaster.intersectObjects(meshes, false)[0];
        const partId = hit?.object?.userData?.partId;
        return partId ? String(partId) : null;
      };
      let downPos = null;
      let clickTimer = null;
      const onPointerDown = (ev) => {
        if (ev.button === 0) downPos = { x: ev.clientX, y: ev.clientY };
      };
      const onClick = (ev) => {
        if (!downPos) return;
        const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
        downPos = null;
        if (moved > 5) return; // 旋轉拖曳,不是點擊
        // 量測模式:分流到面級 pick(唯讀查詢),不走零件圈選命令流。
        if (measureModeRef?.current) {
          onMeasurePick?.(pickFaceAt(ev.clientX, ev.clientY));
          return;
        }
        const partId = raycastPartId(ev);
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          clickTimer = null;
          onPickPart?.(partId ? { partId, mode: "toggle" } : null);
        }, 220);
      };
      const onDblClick = (ev) => {
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        if (measureModeRef?.current) return; // 量測模式不推近(單擊已被面 pick 佔用)
        const partId = raycastPartId(ev);
        onPickPart?.(partId ? { partId, mode: "focus" } : null);
      };
      canvasEl.addEventListener("pointerdown", onPointerDown);
      canvasEl.addEventListener("click", onClick);
      canvasEl.addEventListener("dblclick", onDblClick);

      // 選取視覺:選中件高亮、其餘 ghost(重用 viewer 的單一視覺狀態驅動)。
      // 接受單一 partId 或陣列(多選);zoom=true 才把鏡頭推至選取集合的聯合 bbox
      // (單擊圈選不動鏡頭,雙擊才推近)。
      // 逐件顯示三態(物件樹眼睛):solid(預設)/ ghost(半透明,可透視外殼)/
      // hidden——與圈選是兩個正交來源,合流在同一次 applyPartVisualState:
      // hidden 走原生 hiddenPartIds;ghost 走 record.effectStyle.opacity
      // (cad-chat 內 effectStyle 無其他寫入者,直接 set/null 安全)。
      const GHOST_OPACITY = 0.16;
      const displayState = { ghost: new Set(), hidden: new Set() };
      let curSelIds = [];
      const idInSet = (partId, set) => {
        const pid = String(partId || "");
        for (const c of set) if (pid === c || pid.startsWith(`${c}.`)) return true;
        return false;
      };
      const applyVisual = () => {
        const records = model.displayRecords || [];
        for (const rec of records) {
          rec.effectStyle = idInSet(rec.partId, displayState.ghost)
            ? { opacity: GHOST_OPACITY, edgeOpacity: 0.3 }
            : null;
        }
        applyPartVisualState(THREE, records, {
          focusedPartId: curSelIds.length ? curSelIds[curSelIds.length - 1] : null,
          selectedPartIds: curSelIds,
          hiddenPartIds: [...displayState.hidden],
          showEdges: true,
        });
      };
      const setPartDisplay = (map) => {
        displayState.ghost = new Set(
          Object.keys(map || {}).filter((k) => map[k] === "ghost"),
        );
        displayState.hidden = new Set(
          Object.keys(map || {}).filter((k) => map[k] === "hidden"),
        );
        applyVisual();
      };
      const setSelection = (partIds, { zoom = false } = {}) => {
        const ids = (Array.isArray(partIds) ? partIds : partIds ? [partIds] : []).map(String);
        const records = model.displayRecords || [];
        curSelIds = ids;
        applyVisual();
        if (zoom && ids.length) {
          const bounds = focusedDisplayRecordsBounds(records, {
            partIds: new Set(ids),
          });
          const frame = bounds
            ? autoZoomFrameForBounds(THREE, { camera, controls, bounds, padding: 1.7 })
            : null;
          if (frame) {
            camera.position.copy(frame.position);
            controls.target.copy(frame.target);
            controls.update();
          }
        }
      };
      const setAutoRotate = (on) => {
        controls.autoRotate = !!on;
        controls.autoRotateSpeed = 1.6;
      };

      // selector runtime(屬性 + 點選);失敗則降級
      let runtime = null;
      try {
        const bundle = await loadRenderSelectorBundle(glbUrl, { signal: ac.signal });
        if (!disposed) runtime = buildSelectorRuntime(bundle, { copyCadPath: name || "part" });
      } catch (err) {
        console.warn("[cad-chat] selector bundle unavailable", err?.message || err);
      }

      // 面級填色高亮(cad-viewer 同款機制):faceRuns → 每三角形 faceIds →
      // 抽該面三角形建 overlay 填色 mesh。舊 bundle 無 faceRuns 時整段靜默降級
      // (菱形照常,只是不填色)。
      if (runtime) {
        try {
          syncDisplayMeshFaceIds({ displayRecords: model.displayRecords || [] }, meshData, runtime);
        } catch (err) {
          console.warn("[cad-chat] faceIds sync 失敗(面填色停用)", err?.message || err);
        }
      }
      const faceFill = { group: null };
      const setFaceHighlights = (entries) => {
        const records = model.displayRecords || [];
        const parent = records[0]?.mesh?.parent || viewport.scene;
        if (!faceFill.group) {
          faceFill.group = new THREE.Group();
          faceFill.group.renderOrder = 24;
          parent.add(faceFill.group);
        }
        for (const child of [...faceFill.group.children]) {
          faceFill.group.remove(child);
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        }
        if (!runtime?.faceReferenceByRowIndex) return;
        // faceFillOffset 需要 camera/modelGroup/modelRadius 才會沿法向偏移防 z-fighting
        const fillRt = { displayRecords: records, camera, modelGroup: parent, modelRadius: radius };
        for (const e of entries || []) {
          const reference = runtime.faceReferenceByRowIndex.get(Number(e.rowIndex));
          if (!reference) continue;
          const geometry = buildFaceFillGeometryFromDisplayMeshes(fillRt, THREE, reference);
          if (!geometry) continue;
          const material = new THREE.MeshBasicMaterial({
            color: e.color || REFERENCE_SELECTED_COLOR,
            transparent: true,
            opacity: Number.isFinite(e.opacity) ? e.opacity : REFERENCE_SELECTED_FILL_OPACITY,
            depthTest: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            side: THREE.DoubleSide,
            toneMapped: false,
          });
          const fillMesh = new THREE.Mesh(geometry, material);
          fillMesh.renderOrder = 25;
          faceFill.group.add(fillMesh);
        }
      };
      const faceFillCount = () => faceFill.group?.children.length || 0;
      // 除錯/煙測探針:faceRuns 映射鏈路各環節的健康度
      const faceFillDebug = () => ({
        refs: runtime?.faceReferenceByRowIndex?.size || 0,
        runs: runtime?.proxy?.faceRuns?.length || 0,
        runCols: runtime?.proxy?.faceRunColumns || null,
        synced: (model.displayRecords || []).filter((r) => r?.mesh?.userData?.faceIds).length,
        records: (model.displayRecords || []).length,
      });

      // 量測模式的面級 pick:raycast → hit.faceIndex → mesh.userData.faceIds(逐三角形 →
      // faceRow)→ faceReference(帶已 transform 的世界座標 center)。回 null(無 runtime/
      // faceIds、未命中面、舊 bundle 無面拓撲)= 點到空白,呼叫端忽略。定義在 runtime 賦值
      // 之後——onClick 是事件時才執行,那時閉包解析得到本函式。
      const pickFaceAt = (clientX, clientY) => {
        if (!runtime?.faceReferenceByRowIndex) return null;
        const rect = canvasEl.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        pointerV.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointerV.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
        raycaster.setFromCamera(pointerV, camera);
        const meshes = (model.displayRecords || [])
          .map((r) => r.mesh)
          .filter(
            (m) =>
              m &&
              m.visible !== false &&
              !idInSet(String(m.userData?.partId || ""), displayState.ghost),
          );
        const hit = raycaster.intersectObjects(meshes, false)[0];
        if (!hit || hit.faceIndex == null) return null;
        const faceIds = hit.object?.userData?.faceIds;
        if (!faceIds) return null;
        const rowIndex = faceIds[hit.faceIndex];
        if (rowIndex == null || rowIndex === 0xffffffff) return null;
        const reference = runtime.faceReferenceByRowIndex.get(Number(rowIndex));
        const center = reference?.pickData?.center;
        if (!reference || !Array.isArray(center)) return null;
        return {
          token: reference.copyText,
          label: reference.pickData?.surfaceType || reference.copyText,
          center,
          rowIndex: Number(rowIndex),
          pick: reference.pickData, // 完整 facts 給前端 measureBetween 即時算
        };
      };

      // 量測尺寸線 overlay(仿 bendGroup:輔助幾何直接 scene.add;數值標籤走 Canvas3D 的
      // HTML 投影,不畫在 3D)。端點球 + 連線,depthTest:false 讓尺寸線恆可見(穿透實體)。
      const measureGroup = new THREE.Group();
      measureGroup.renderOrder = 28;
      viewport.scene.add(measureGroup);
      const clearMeasureChildren = () => {
        for (const child of [...measureGroup.children]) {
          measureGroup.remove(child);
          child.geometry?.dispose?.();
          child.material?.dispose?.();
        }
      };
      const setMeasure = ({ a, b } = {}) => {
        clearMeasureChildren();
        if (!Array.isArray(a) || !Array.isArray(b)) return;
        const dotGeo = new THREE.SphereGeometry(Math.max(radius * 0.012, 0.4), 16, 12);
        const mkDot = (p) => {
          const dot = new THREE.Mesh(
            dotGeo,
            new THREE.MeshBasicMaterial({ color: 0x1f9d55, depthTest: false, toneMapped: false }),
          );
          dot.position.set(p[0], p[1], p[2]);
          dot.renderOrder = 30;
          return dot;
        };
        measureGroup.add(mkDot(a), mkDot(b));
        const lineGeo = createReferenceEdgeGeometryFromPoints(THREE, [a, b]);
        if (lineGeo) {
          const line = new THREE.Line(
            lineGeo,
            new THREE.LineBasicMaterial({
              color: 0x1f9d55,
              transparent: true,
              opacity: 0.95,
              depthTest: false,
              toneMapped: false,
            }),
          );
          line.frustumCulled = false;
          line.renderOrder = 29;
          measureGroup.add(line);
        }
      };
      const clearMeasure = () => clearMeasureChildren();

      liveRef.current = {
        model,
        viewport,
        controls,
        ro,
        camera,
        canvasEl,
        gridMesh,
        axes,
        bendGroup,
        sweepGroup,
        measureGroup,
        faceFill,
        onPointerDown,
        onClick,
        onDblClick,
        clearClickTimer: () => {
          if (clickTimer) clearTimeout(clickTimer);
          clickTimer = null;
        },
      };
      if (!disposed) {
        onStatus?.("ready");
        onReady?.({
          camera,
          host,
          runtime,
          viewport,
          model,
          setSelection,
          setPartDisplay,
          setAutoRotate,
          setGrid,
          setAxes,
          setBendLines,
          setSweepPaths,
          setFaceHighlights,
          setMeasure,
          clearMeasure,
          faceFillCount,
          faceFillDebug,
          chrome: { grid: gridMesh, axes, bendLines: bendGroup, sweepPaths: sweepGroup, measure: measureGroup }, // dev/測試檢視用(visible/children 斷言)
        });
      }
    }

    return () => {
      disposed = true;
      ac.abort();
      const s = liveRef.current;
      try {
        s.clearClickTimer?.();
        if (s.canvasEl) {
          if (s.onPointerDown) s.canvasEl.removeEventListener("pointerdown", s.onPointerDown);
          if (s.onClick) s.canvasEl.removeEventListener("click", s.onClick);
          if (s.onDblClick) s.canvasEl.removeEventListener("dblclick", s.onDblClick);
        }
        s.ro?.disconnect();
        s.controls?.dispose?.();
        if (s.faceFill?.group) {
          for (const child of [...s.faceFill.group.children]) {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
          }
          s.faceFill.group.parent?.remove(s.faceFill.group);
          s.faceFill.group = null;
        }
        if (s.gridMesh) {
          s.gridMesh.parent?.remove(s.gridMesh);
          s.gridMesh.geometry?.dispose?.();
          s.gridMesh.material?.dispose?.();
        }
        if (s.axes) {
          s.axes.parent?.remove(s.axes);
          s.axes.dispose?.();
        }
        if (s.bendGroup) {
          for (const child of [...s.bendGroup.children]) {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
          }
          s.bendGroup.parent?.remove(s.bendGroup);
        }
        if (s.sweepGroup) {
          for (const child of [...s.sweepGroup.children]) {
            child.geometry?.dispose?.(); // 端點球共用 dotGeo,重複 dispose 無害
            child.material?.dispose?.();
          }
          s.sweepGroup.parent?.remove(s.sweepGroup);
        }
        if (s.measureGroup) {
          for (const child of [...s.measureGroup.children]) {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
          }
          s.measureGroup.parent?.remove(s.measureGroup);
        }
        s.viewport?.dispose?.();
        s.model?.dispose?.();
        s.canvasEl?.remove();
      } catch {
        /* ignore */
      }
      liveRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbUrl, bendLines, sweepPaths]);
}
