// 運動示意播放器:依產生器 MOTION dofs 對 displayRecords 做三角波往復平移。
// 正確做法是 record.effectMatrix + applyDisplayRecordTransform(mesh/邊線/silhouette
// 同步移動);不可只改 mesh.position(邊線脫節)、不可呼叫 model.update()(重置 transform)。
import { applyDisplayRecordTransform } from "cadjs/common/displayRecordTransform";

import { frameMatrix, triangleU } from "./cadMotionMath.js";

export function createMotionPlayer(THREE, model, runtime) {
  const records = model?.displayRecords || [];

  // label -> records 對應:CAD GLB 的 record.partId = occurrenceId,友善名走
  // selector shapes(occurrenceId ↔ name);無 bundle 時退回 sourcePart.name/label。
  const byLabel = new Map();
  const push = (label, rec) => {
    const k = label == null ? "" : String(label);
    if (!k || !rec) return;
    if (!byLabel.has(k)) byLabel.set(k, []);
    if (!byLabel.get(k).includes(rec)) byLabel.get(k).push(rec);
  };
  const recByPartId = new Map();
  for (const rec of records) {
    if (rec?.partId != null) recByPartId.set(String(rec.partId), rec);
    push(rec?.sourcePart?.name, rec);
    push(rec?.sourcePart?.label, rec);
  }
  for (const s of runtime?.shapes || []) {
    const rec = recByPartId.get(String(s?.occurrenceId ?? ""));
    if (rec) {
      push(s?.name, rec);
      push(s?.sourceName, rec);
    }
  }
  // 複合件母節點(馬達=body+shaft、軸承=內外圈…):occurrence label 沒有自己的
  // mesh,要把「該 occurrence 的所有後代 record」(partId 前綴 o1.9 → o1.9.*)都掛上,
  // 否則 MOTION 引用母 label 時整顆馬達/軸承不會跟著動。
  for (const o of runtime?.occurrences || []) {
    const oid = String(o?.id ?? "");
    const label = o?.name || o?.sourceName;
    if (!oid || !label) continue;
    for (const rec of records) {
      const pid = String(rec?.partId ?? "");
      if (pid === oid || pid.startsWith(oid + ".")) push(label, rec);
    }
  }

  const touched = new Set();
  const recMats = new Map(); // rec -> Matrix4(每幀重置為 identity 後累加)

  function apply(motion, tSec) {
    const dofs = motion?.dofs || [];
    const idxOf = new Map(dofs.map((d, i) => [String(d.id), i]));
    recMats.clear();
    dofs.forEach((dof, i) => {
      // 每 dof 每幀算一次 frame-matrix Mi(linear=平移;revolute=繞 pivot 軸旋轉);數學見 cadMotionMath.js
      // couple(嚙合耦合):從動 dof 借主動 dof 的 period 與相位 index → 同一 u,
      // 齒輪齒條在畫面上純滾動不打滑(相位錯開只給獨立 dof)。
      let pi = i;
      let pd = dof;
      if (dof.couple != null && idxOf.has(String(dof.couple))) {
        pi = idxOf.get(String(dof.couple));
        pd = dofs[pi];
      }
      const Mi = frameMatrix(THREE, dof, triangleU(tSec, pd.period_s, pi));
      for (const label of dof.moving || []) {
        for (const rec of byLabel.get(String(label)) || []) {
          let m = recMats.get(rec);
          if (!m) {
            m = new THREE.Matrix4();
            recMats.set(rec, m);
          } // identity 起手
          m.premultiply(Mi); // 依宣告序 premultiply → 後宣告者在外層(R_flip·T_jaw)
        }
      }
    });
    for (const [rec, m] of recMats) {
      rec.effectMatrix = m.clone();
      applyDisplayRecordTransform(THREE, rec);
      touched.add(rec);
    }
  }

  function reset() {
    for (const rec of touched) {
      rec.effectMatrix = null;
      applyDisplayRecordTransform(THREE, rec);
    }
    touched.clear();
  }

  // motion.moving 的 label 有幾成對得到 record(顯示/除錯用;0 = 完全對不上)
  function coverage(motion) {
    const want = new Set((motion?.dofs || []).flatMap((d) => (d.moving || []).map(String)));
    if (!want.size) return 0;
    let hit = 0;
    for (const l of want) if (byLabel.has(l)) hit += 1;
    return hit / want.size;
  }

  // Playwright 斷言用:touched record 的矩陣元素快照
  function sample() {
    return Array.from(touched, (rec) =>
      rec.effectMatrix ? rec.effectMatrix.elements.join(",") : "identity",
    );
  }

  // Playwright 斷言用:回具名 label 的 record effectMatrix 元素(16 個),對不上回 null
  function matrixFor(label) {
    for (const rec of byLabel.get(String(label)) || []) {
      if (rec.effectMatrix instanceof THREE.Matrix4) return rec.effectMatrix.elements.slice();
    }
    return null;
  }

  return { apply, reset, coverage, sample, matrixFor };
}
