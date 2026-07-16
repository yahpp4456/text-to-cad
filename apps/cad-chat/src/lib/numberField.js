export function isIntDef(def) {
  return def?.int === true;
}

export function fmtValue(v, def) {
  if (!Number.isFinite(v)) return "";
  const rounded = isIntDef(def) ? Math.round(v) : Math.round(v * 100) / 100;
  return String(rounded);
}

export function commitValue(raw, def) {
  const text = String(raw).trim();
  if (!text) return { ok: false };

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { ok: false };

  let value = isIntDef(def) ? Math.round(parsed) : Math.round(parsed * 100) / 100;
  if (Number.isFinite(def?.min)) value = Math.max(def.min, value);
  if (Number.isFinite(def?.max)) value = Math.min(def.max, value);
  return { ok: true, value };
}

export function stepValue(current, def, dir) {
  const parsed = Number(current);
  const base = Number.isFinite(parsed) ? parsed : (def?.min ?? 0);
  return commitValue(Number(base) + dir * (Number(def?.step) || 1), def).value;
}
