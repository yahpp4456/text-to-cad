// 運動示意播放器:依產生器 MOTION dofs 對 displayRecords 做三角波往復平移。
// 正確做法是 record.effectMatrix + applyDisplayRecordTransform(mesh/邊線/silhouette
// 同步移動);不可只改 mesh.position(邊線脫節)、不可呼叫 model.update()(重置 transform)。
import { applyDisplayRecordTransform } from "cadjs/common/displayRecordTransform";

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
  const offsets = new Map(); // rec -> [x,y,z](每幀重算)

  function apply(motion, tSec) {
    const dofs = motion?.dofs || [];
    offsets.clear();
    dofs.forEach((dof, i) => {
      const T = Math.max(1, Math.min(20, Number(dof.period_s) || 4));
      const phase = (tSec / T + i * 0.17) % 1; // 相位錯開讓多軸疊加可辨
      const u = 1 - Math.abs(2 * phase - 1); // 三角波 0→1→0
      const axis = Array.isArray(dof.axis) ? dof.axis : [0, 0, 0];
      const travel = Number(dof.travel) || 0;
      for (const label of dof.moving || []) {
        for (const rec of byLabel.get(String(label)) || []) {
          const cur = offsets.get(rec) || [0, 0, 0];
          cur[0] += (axis[0] || 0) * u * travel;
          cur[1] += (axis[1] || 0) * u * travel;
          cur[2] += (axis[2] || 0) * u * travel; // ride-along = 多 DOF 平移相加
          offsets.set(rec, cur);
        }
      }
    });
    for (const [rec, off] of offsets) {
      if (!(rec.effectMatrix instanceof THREE.Matrix4)) rec.effectMatrix = new THREE.Matrix4();
      rec.effectMatrix.makeTranslation(off[0], off[1], off[2]);
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

  return { apply, reset, coverage, sample };
}
