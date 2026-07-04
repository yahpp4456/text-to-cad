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

export function useCadViewport(mountRef, glbUrl, { name, onStatus, onReady, onFrame, onPickPart } = {}) {
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
        const meshes = (model.displayRecords || [])
          .map((r) => r.mesh)
          .filter((m) => m && m.visible !== false);
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
        const partId = raycastPartId(ev);
        onPickPart?.(partId ? { partId, mode: "focus" } : null);
      };
      canvasEl.addEventListener("pointerdown", onPointerDown);
      canvasEl.addEventListener("click", onClick);
      canvasEl.addEventListener("dblclick", onDblClick);

      // 選取視覺:選中件高亮、其餘 ghost(重用 viewer 的單一視覺狀態驅動)。
      // 接受單一 partId 或陣列(多選);zoom=true 才把鏡頭推至選取集合的聯合 bbox
      // (單擊圈選不動鏡頭,雙擊才推近)。
      const setSelection = (partIds, { zoom = false } = {}) => {
        const ids = (Array.isArray(partIds) ? partIds : partIds ? [partIds] : []).map(String);
        const records = model.displayRecords || [];
        applyPartVisualState(THREE, records, {
          focusedPartId: ids.length ? ids[ids.length - 1] : null,
          selectedPartIds: ids,
          hiddenPartIds: [],
          showEdges: true,
        });
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

      liveRef.current = {
        model,
        viewport,
        controls,
        ro,
        camera,
        canvasEl,
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
        onReady?.({ camera, host, runtime, viewport, model, setSelection, setAutoRotate });
      }
    })();

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
        s.viewport?.dispose?.();
        s.model?.dispose?.();
        s.canvasEl?.remove();
      } catch {
        /* ignore */
      }
      liveRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbUrl]);
}
