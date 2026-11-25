// 建置差異摘要(藍圖 B3)的純函數:比對兩次建置的零件量測摘要,產生一行繁體中文說明。
// 輸入是 cadpy.build_delta.build_summary 的輸出(呼叫端另附 dofCount)。伺服器與瀏覽器共用,
// 不 import 任何東西;壞輸入不拋例外。由 Codex 依規格實作,接線在 server/cad/pipeline.mjs。
const isObject = (value) => value !== null && typeof value === "object";
const numberOrNull = (value) => Number.isFinite(value) ? value : null;
const round = (value, digits) => Number(value.toFixed(digits)) || 0;

function validPoint(point) {
  return Array.isArray(point) && point.length === 3 &&
    [point[0], point[1], point[2]].every(Number.isFinite);
}

function validBox(box) {
  return Array.isArray(box) && box.length === 2 && validPoint(box[0]) && validPoint(box[1]);
}

function boxSize(box) {
  return validBox(box) ? box[1].map((max, i) => max - box[0][i]) : null;
}

function partIndex(parts) {
  const index = new Map();
  for (const part of Array.isArray(parts) ? parts : []) {
    if (isObject(part) && typeof part.name === "string") index.set(part.name, part);
  }
  return index;
}

function measured(part) {
  return !("error" in part) && Boolean(part.key) && validBox(part.bbox);
}

// 包絡座標精度為 0.001 mm，中心精度為 0.0005 mm。先消除相減後的浮點尾差。
function exceeds(value, threshold) {
  return Math.abs(round(value, 8)) > threshold;
}

export function diffBuildSummaries(prev, cur) {
  if (!isObject(cur)) return null;
  const first = !isObject(prev);
  const before = partIndex(prev?.parts);
  const after = partIndex(cur.parts);
  const partCount = {
    from: first ? null : numberOrNull(prev.partCount) ?? before.size,
    to: numberOrNull(cur.partCount) ?? after.size,
  };
  const oldSize = boxSize(prev?.bbox);
  const newSize = boxSize(cur.bbox);
  const size = {
    from: oldSize?.map((n) => round(n, 1)) ?? null,
    to: newSize?.map((n) => round(n, 1)) ?? null,
  };
  const sizeChanged = Boolean(oldSize && newSize && newSize.some((n, i) => exceeds(n - oldSize[i], 0.05)));
  const dofs = { from: numberOrNull(prev?.dofCount), to: numberOrNull(cur.dofCount) };
  const dofsChanged = dofs.from !== dofs.to;
  const added = [];
  const removed = [];
  const changed = [];
  const moved = [];
  const unmeasured = [];

  for (const [name, part] of after) {
    if ("error" in part) unmeasured.push(name);
    if (first || !measured(part)) continue;
    const old = before.get(name);
    if (!old) {
      added.push(name);
      continue;
    }
    if (!measured(old)) continue;
    if (part.key !== old.key) {
      changed.push({ name, volume: { from: numberOrNull(old.volume), to: numberOrNull(part.volume) } });
      continue;
    }
    const by = part.bbox[0].map((min, i) =>
      ((min - old.bbox[0][i]) + (part.bbox[1][i] - old.bbox[1][i])) / 2);
    if (by.some((n) => exceeds(n, 0.01))) moved.push({ name, by: by.map((n) => round(n, 2)) });
  }
  for (const [name, part] of before) {
    if (measured(part) && !after.has(name)) removed.push(name);
  }
  const same = !first && partCount.from === partCount.to && !sizeChanged && !dofsChanged &&
    !added.length && !removed.length && !changed.length && !moved.length;

  return { first, partCount, size, sizeChanged, added, removed, changed, moved, unmeasured, dofs, dofsChanged, same };
}

function dimensions(size) {
  return size.map((axis) => round(axis, 1)).join("×");
}

function volumeText(volume) {
  return Number.isFinite(volume) ? Math.round(volume).toLocaleString("en-US") : "未知";
}

function signed(value) {
  const n = round(value, 2);
  return n > 0 ? `+${n}` : String(n);
}

export function formatBuildDelta(delta, { maxNames = 4 } = {}) {
  if (!delta) return "";
  const { partCount, size, dofs } = delta;
  function list(items, describe = String) {
    const names = items.slice(0, maxNames).map(describe).join("、");
    return items.length > maxNames ? `${names} 等 ${items.length} 件` : names;
  }
  const missing = delta.unmeasured.length ? `未量到 ${list(delta.unmeasured)}` : "";
  if (delta.first || delta.same) {
    const box = size.to ? `包絡 ${dimensions(size.to)} mm` : "包絡未知";
    const details = `${partCount.to} 件,${box}`;
    const line = delta.first ? `首次建置:${details}` : `與上一版相同(${details})`;
    return missing ? `${line};${missing}` : line;
  }

  const sections = [];
  if (partCount.from !== partCount.to) sections.push(`零件 ${partCount.from}→${partCount.to}`);
  if (delta.added.length) sections.push(`新增 ${list(delta.added)}`);
  if (delta.removed.length) sections.push(`移除 ${list(delta.removed)}`);
  if (delta.changed.length) {
    sections.push(`改了 ${list(delta.changed, ({ name, volume }) =>
      `${name}(體積 ${volumeText(volume.from)}→${volumeText(volume.to)} mm³)`)}`);
  }
  if (delta.moved.length) {
    sections.push(`移動 ${list(delta.moved, ({ name, by }) => `${name}(Δ ${by.map(signed).join(", ")})`)}`);
  }
  if (delta.sizeChanged) sections.push(`包絡 ${dimensions(size.from)} → ${dimensions(size.to)} mm`);
  if (delta.dofsChanged) sections.push(`自由度 ${dofs.from ?? "無"}→${dofs.to ?? "無"}`);
  if (missing) sections.push(missing);
  return `與上一版比:${sections.join(";") || "無可辨識的差異"}`;
}
