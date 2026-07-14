// 草模 three.js viewport:compileSketch 的 compiled → buildSketchScene → 單一 RAF
// 恆跑(播放只決定 masterT 是否推進;拖轉視角時模擬照跑)。與 useCadViewport 平行
// 的獨立 hook——不載 GLB、零 cadjs;真狀態(時鐘/播放/手動覆寫/凍結 attach)全在
// 這裡,evalProgram/evalPose 是純函數。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { evalPose, evalProgram } from "../lib/sketch/sketchEval.js";
import { buildSketchScene } from "../lib/sketch/sketchMesh.js";

export function useSketchViewport(mountRef, compiled, { onStatus, onReady, onTick } = {}) {
  const liveRef = useRef({});

  useEffect(() => {
    if (!compiled || !mountRef.current) return undefined;
    const host = mountRef.current;
    let disposed = false;
    onStatus?.("loading");

    let built;
    let renderer;
    try {
      built = buildSketchScene(compiled);

      const scene = new THREE.Scene();
      scene.add(built.root);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4ad, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 1.0);
      sun.position.set(120, -160, 200);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xffffff, 0.28);
      fill.position.set(-100, 120, 90);
      scene.add(fill);

      const canvasEl = document.createElement("canvas");
      canvasEl.className = "cad-canvas";
      host.appendChild(canvasEl);
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;

      const camera = new THREE.PerspectiveCamera(
        48,
        (host.clientWidth || 1) / (host.clientHeight || 1),
        0.1,
        50000,
      );
      camera.up.set(0, 0, 1); // Z-up(schema 慣例,同 CAD 視圖)

      // 相機定位:doc.camera 提示優先,否則 bbox auto-fit(方向手感對齊 useCadViewport)
      const center = built.bbox.getCenter(new THREE.Vector3());
      const camCfg = compiled.doc.camera;
      const target = camCfg?.target ? new THREE.Vector3(...camCfg.target) : center;
      const dist = camCfg?.distance || built.radius * 2.8;
      const homeCam = () => {
        camera.position
          .copy(target)
          .add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(dist));
        controls.target.copy(target);
        controls.update();
      };
      const controls = new OrbitControls(camera, canvasEl);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      homeCam();

      // 地板網格 + 座標軸(GridHelper 原生 XZ 平面 → Z-up 要 rotation.x=π/2)
      const gridSize = Math.max(200, Math.ceil((built.radius * 3) / 50) * 50);
      const grid = new THREE.GridHelper(gridSize, gridSize / 10, 0x8fa5bf, 0xc0cbda);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(center.x, center.y, 0);
      grid.material.transparent = true;
      grid.material.opacity = 0.45;
      scene.add(grid);
      const axes = new THREE.AxesHelper(built.radius * 1.2);
      scene.add(axes);

      // ---- 時鐘/播放/手動覆寫(viewport 的唯一真狀態)----
      const clock = {
        tSec: 0,
        playing: true,
        speed: 1,
        manual: null, // 手動 drive 覆寫 {id:value} | null(=跟程式)
        frozenAttach: { ...compiled.attachInitials },
        lastFrame: null,
        lastProgram: null,
      };
      const computeFrame = () => {
        const program = evalProgram(compiled, clock.tSec);
        const values = clock.manual ? { ...program.driveValues, ...clock.manual } : program.driveValues;
        const attach = clock.manual ? clock.frozenAttach : program.attachStates;
        const frame = evalPose(compiled, values, attach);
        clock.lastFrame = frame;
        clock.lastProgram = program;
        return { frame, program };
      };

      let raf = 0;
      let last = performance.now();
      const loop = (now) => {
        if (disposed) return;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (clock.playing) clock.tSec += dt * clock.speed;
        const { frame, program } = computeFrame();
        built.applyFrame(frame);
        controls.update();
        renderer.render(scene, camera);
        onTick?.(frame, program, clock);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      const ro =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              const w = host.clientWidth;
              const h = host.clientHeight;
              if (w && h) {
                renderer.setSize(w, h, false);
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
              }
            })
          : null;
      ro?.observe(host);

      // ---- 對外 API(SketchCanvas3D 的控制面)----
      const api = {
        play: () => {
          // 從手動姿態續跑:回到程式軌(manual 清除)
          clock.manual = null;
          clock.playing = true;
        },
        pause: () => {
          clock.playing = false;
        },
        toggle: () => (clock.playing ? api.pause() : api.play()),
        setSpeed: (x) => {
          clock.speed = Number(x) > 0 ? Number(x) : 1;
        },
        // ↺ 回原位:home 姿態定格(drive=home、attach=initial、時鐘歸零)
        reset: () => {
          clock.playing = false;
          clock.tSec = 0;
          clock.manual = { ...compiled.homeDrives };
          clock.frozenAttach = { ...compiled.attachInitials };
        },
        homeCamera: homeCam,
        // 手動拖滑桿:暫停 + 凍結 attach(標準 sim scrub 語意)
        setDrive: (id, v) => {
          if (!clock.manual) {
            clock.manual = { ...(clock.lastProgram?.driveValues || compiled.homeDrives) };
            clock.frozenAttach = { ...(clock.lastProgram?.attachStates || compiled.attachInitials) };
          }
          clock.manual[id] = Number(v);
          clock.playing = false;
        },
        // 煙測探針:定格到絕對秒數(去 RAF flake)
        applyAt: (tSec) => {
          clock.manual = null;
          clock.playing = false;
          clock.tSec = Number(tSec) || 0;
          const { frame } = computeFrame();
          built.applyFrame(frame);
          return frame;
        },
        state: () => ({
          playing: clock.playing,
          t: clock.tSec,
          speed: clock.speed,
          manual: clock.manual ? { ...clock.manual } : null,
          drives: { ...(clock.lastFrame?.drives || {}) },
          phase: clock.lastProgram?.phaseName ?? null,
        }),
        frame: () => clock.lastFrame,
        setGrid: (on) => {
          grid.visible = !!on;
        },
        setAxes: (on) => {
          axes.visible = !!on;
        },
        setAutoRotate: (on) => {
          controls.autoRotate = !!on;
          controls.autoRotateSpeed = 1.6;
        },
        legend: built.legend,
        dofs: compiled.dofs,
        // 煙測探針:場景 root 下的真 Mesh 數(不含 grid/axes chrome、不含 trace
        // Line)。圖例/scene() 計數都來自 doc,唯有這個數字釘得住 buildPart 的
        // mesh 分支真的長出幾何(未知 type 靜默 return null 不丟錯)。
        meshCount: () => {
          let n = 0;
          built.root.traverse((o) => {
            if (o.isMesh) n += 1;
          });
          return n;
        },
        chrome: { grid, axes },
      };

      liveRef.current = { renderer, controls, ro, canvasEl, built, stop: () => cancelAnimationFrame(raf) };
      onStatus?.("ready");
      onReady?.(api);
    } catch (err) {
      console.error("[cad-chat] sketch viewport 初始化失敗", err);
      onStatus?.("error");
      host.querySelector("canvas.cad-canvas")?.remove();
      return undefined;
    }

    return () => {
      disposed = true;
      const s = liveRef.current;
      try {
        s.stop?.();
        s.ro?.disconnect();
        s.controls?.dispose?.();
        s.built?.dispose?.();
        s.renderer?.dispose?.();
        s.canvasEl?.remove();
      } catch {
        /* ignore */
      }
      liveRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled]);
}
