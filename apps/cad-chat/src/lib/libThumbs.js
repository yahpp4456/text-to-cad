// 零件庫卡片縮圖:GLB → 離屏 three 渲染一次 → PNG dataURL。
// 快取 key = glbUrl(含 &v= mtime buster,檔案更新自然失效);串行佇列——
// 多卡同時進視野也只開一個離屏 WebGL context(context 數量有限,並發開會被
// 瀏覽器踢掉最舊的)。渲染配方鏡射 useCadViewport(等角視角、Z-up)。
import * as THREE from "three";

import { buildModel, centerAndRadiusFromBounds, renderModel } from "cadjs";
import { loadRenderGlb } from "cadjs/lib/renderAssetClient";

const cache = new Map(); // glbUrl -> dataURL(記憶體級;重整重算,量小可接受)
let queue = Promise.resolve();

export function thumbFor(glbUrl, { size = 220 } = {}) {
  if (!glbUrl) return Promise.reject(new Error("no glbUrl"));
  if (cache.has(glbUrl)) return Promise.resolve(cache.get(glbUrl));
  const job = queue.then(() => renderThumb(glbUrl, size));
  // 佇列尾巴吞錯誤(單卡失敗不卡住後面的卡);呼叫端自己拿 job 的 reject
  queue = job.catch(() => {});
  return job;
}

async function renderThumb(glbUrl, size) {
  if (cache.has(glbUrl)) return cache.get(glbUrl); // 佇列等待期間別人已算好
  const meshData = await loadRenderGlb(glbUrl);
  const model = buildModel(THREE, meshData, {});
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50000);
  camera.up.set(0, 0, 1);
  let viewport = null;
  try {
    viewport = renderModel(THREE, model, {
      canvas,
      camera,
      width: size,
      height: size,
      alpha: true,
      autoResize: false,
      autoStart: false,
      autoRender: false,
    });
    const { center, radius } = centerAndRadiusFromBounds(THREE, model.bounds, "cad");
    camera.position
      .copy(center)
      .add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(radius * 3.0));
    camera.lookAt(center);
    const dataUrl = viewport.capturePng();
    cache.set(glbUrl, dataUrl);
    return dataUrl;
  } finally {
    viewport?.dispose(); // disposeModel 預設 true → mesh/geometry 一併釋放
  }
}
