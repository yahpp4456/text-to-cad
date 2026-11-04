export const SCHEMA_VERSION = 1;
export const CURVE_KINDS = ["spline", "nurbs", "bezier", "arc3", "line", "circle"];
export const SURFACE_OPS = ["loft", "patch", "revolve", "extrude", "ruled", "sweep", "gordon"];
export const TOP_OPS = ["sew", "thicken", "fillet"];
export const PLANES = ["XY", "XZ", "YZ"];
export const CONTINUITY = ["G0", "G1", "G2"];
export const THICKEN_DIRS = ["outward", "inward"];
export const SURFACE_ROLES = ["body", "cut", "add"];
export const CAPPED_OPS = ["loft", "extrude", "revolve", "sweep"];
export const MAX_CURVES = 64;
export const MAX_SURFACES = 32;
export const MAX_POINTS = 64;
export const MAX_NURBS_DEGREE = 5;
export const MAX_BEZIER_POLES = 8;
export const ID_RE = /^[a-z][a-z0-9_]*$/;

export class DraftError extends Error {
  constructor(errors) {
    super(errors.map(({ path, message }) => `${path}: ${message}`).join("; ") || "invalid draft");
    this.name = "DraftError";
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const points = (v, lo, hi = MAX_POINTS) => Array.isArray(v) && v.length >= lo && v.length <= hi && v.every(vec3);
const zeroVector = (v) => v.every((x) => Math.abs(x) < 1e-12);
const has = (obj, key) => Object.hasOwn(obj, key);
const defaultValue = (v, fallback) => v === undefined ? fallback : v;

export function validateDraft(raw, { partial = false } = {}) {
  if (!isObject(raw)) return [{ path: "", message: "spec 必須是物件" }];
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (raw.schemaVersion !== SCHEMA_VERSION) err("schemaVersion", "必須是 1");
  if (defaultValue(raw.unit, "mm") !== "mm") err("unit", "只支援 mm");
  const result = defaultValue(raw.result, "solid");
  if (!["solid", "shell"].includes(result)) err("result", "必須是 solid 或 shell");
  if (raw.symmetry != null && !PLANES.includes(raw.symmetry)) err("symmetry", "必須是 null/XY/XZ/YZ");
  if (has(raw, "fuse") && typeof raw.fuse !== "boolean") err("fuse", "必須是布林");
  const revision = defaultValue(raw.revision, 0);
  if (!isInt(revision) || revision < 0) err("revision", "必須是 ≥0 的整數");

  let curves = raw.curves;
  if (!Array.isArray(curves) || curves.length === 0) {
    if (!Array.isArray(curves) || !partial) err("curves", "至少一條曲線");
    curves = [];
  }
  if (curves.length > MAX_CURVES) err("curves", "曲線數上限 64");
  const curveIds = new Set();
  curves.forEach((c, i) => {
    const p = `curves[${i}]`;
    if (!isObject(c)) { err(p, "必須是物件"); return; }
    if (typeof c.id !== "string" || !ID_RE.test(c.id)) err(`${p}.id`, "id 需為小寫字母開頭的 [a-z0-9_]");
    else if (curveIds.has(c.id)) err(`${p}.id`, `id 重複:${c.id}`);
    else curveIds.add(c.id);
    if (!CURVE_KINDS.includes(c.kind)) { err(`${p}.kind`, "kind 必須是 spline/nurbs/bezier/arc3/line/circle"); return; }
    if (c.plane != null && !PLANES.includes(c.plane)) err(`${p}.plane`, "必須是 null/XY/XZ/YZ");
    if (has(c, "closed") && typeof c.closed !== "boolean") err(`${p}.closed`, "必須是布林");
    switch (c.kind) {
      case "spline":
        if (!points(c.points, 2)) err(`${p}.points`, "需 2–64 個 [x,y,z]");
        if (c.tangents != null) {
          if (!isObject(c.tangents)) err(`${p}.tangents`, "需為 {start?, end?} 物件");
          else {
            for (const key of ["start", "end"]) {
              if (c.tangents[key] != null && !vec3(c.tangents[key])) err(`${p}.tangents.${key}`, "需為 [x,y,z]");
            }
            if (Object.keys(c.tangents).some((key) => !["start", "end"].includes(key))) err(`${p}.tangents`, "只允許 start/end");
          }
        }
        break;
      case "nurbs": {
        const degreeKnown = isInt(c.degree) && c.degree >= 1 && c.degree <= MAX_NURBS_DEGREE;
        if (!degreeKnown) err(`${p}.degree`, "degree 需為 1–5 整數");
        if (!points(c.poles, 2)) err(`${p}.poles`, "需 2–64 個 [x,y,z]");
        else if (degreeKnown && c.poles.length < c.degree + 1) err(`${p}.poles`, `degree ${c.degree} 至少 ${c.degree + 1} 個控制點`);
        if (c.weights != null) {
          if (!Array.isArray(c.weights) || !c.weights.every((v) => isNum(v) && v > 0)) err(`${p}.weights`, "需為正數陣列");
          else if (c.weights.length !== (Array.isArray(c.poles) ? c.poles.length : 0)) err(`${p}.weights`, "長度需與 poles 相同");
        }
        break;
      }
      case "bezier":
        if (!points(c.poles, 2, MAX_BEZIER_POLES)) err(`${p}.poles`, "需 2–8 個 [x,y,z]");
        break;
      case "arc3":
        if (!points(c.points, 3, 3)) err(`${p}.points`, "需恰 3 個 [x,y,z]");
        break;
      case "line":
        if (!points(c.points, 2, 2)) err(`${p}.points`, "需恰 2 個 [x,y,z]");
        break;
      case "circle":
        if (!vec3(c.center)) err(`${p}.center`, "需為 [x,y,z]");
        if (!vec3(c.normal)) err(`${p}.normal`, "需為 [x,y,z]");
        if (!isNum(c.r) || c.r <= 0) err(`${p}.r`, "半徑需 > 0");
        break;
    }
  });

  let surfaces = raw.surfaces;
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    if (!Array.isArray(surfaces) || !partial) err("surfaces", "至少一個曲面");
    surfaces = [];
  }
  if (surfaces.length > MAX_SURFACES) err("surfaces", "曲面數上限 32");
  const surfIds = new Set();
  const refCurve = (path, v) => {
    if (typeof v !== "string" || !curveIds.has(v)) err(path, `引用未宣告的曲線:${typeof v === "string" ? `'${v}'` : String(v)}`);
  };
  surfaces.forEach((s, i) => {
    const p = `surfaces[${i}]`;
    if (!isObject(s)) { err(p, "必須是物件"); return; }
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) err(`${p}.id`, "id 需為小寫字母開頭的 [a-z0-9_]");
    else if (surfIds.has(s.id) || curveIds.has(s.id)) err(`${p}.id`, `id 重複:${s.id}`);
    if (!SURFACE_OPS.includes(s.op)) {
      err(`${p}.op`, "op 必須是 loft/patch/revolve/extrude/ruled/sweep/gordon");
      if (typeof s.id === "string") surfIds.add(s.id);
      return;
    }
    if (!SURFACE_ROLES.includes(defaultValue(s.role, "body"))) err(`${p}.role`, "需為 body/cut/add");
    if (has(s, "capped")) {
      if (typeof s.capped !== "boolean") err(`${p}.capped`, "必須是布林");
      if (!CAPPED_OPS.includes(s.op)) err(`${p}.capped`, "只有 loft/extrude/revolve/sweep 支援 capped");
    }
    switch (s.op) {
      case "loft":
        if (!Array.isArray(s.sections) || s.sections.length < 2) err(`${p}.sections`, "至少 2 條截面曲線");
        else s.sections.forEach((v, j) => refCurve(`${p}.sections[${j}]`, v));
        if (has(s, "ruled") && typeof s.ruled !== "boolean") err(`${p}.ruled`, "必須是布林");
        break;
      case "patch": {
        let boundary = s.boundary;
        if (!Array.isArray(boundary) || boundary.length < 2) {
          err(`${p}.boundary`, "至少 2 條邊界曲線(需閉合成環)"); boundary = [];
        } else boundary.forEach((v, j) => refCurve(`${p}.boundary[${j}]`, v));
        if (s.continuity != null) {
          if (!isObject(s.continuity)) err(`${p}.continuity`, "需為 {curveId: {face, level}} 物件");
          else for (const [key, value] of Object.entries(s.continuity)) {
            const cp = `${p}.continuity.${key}`;
            if (!boundary.includes(key)) err(cp, "不是本補面的邊界曲線");
            if (!isObject(value) || !["G1", "G2"].includes(value.level) || typeof value.face !== "string") err(cp, "需為 {face: 曲面id, level: G1|G2}");
            else if (!surfIds.has(value.face)) err(`${cp}.face`, `引用未宣告(或尚未宣告)的曲面:${value.face}`);
          }
        }
        if (s.points != null && !points(s.points, 1, 16)) err(`${p}.points`, "需為 1–16 個 [x,y,z]");
        break;
      }
      case "revolve":
        refCurve(`${p}.curve`, s.curve);
        if (!isObject(s.axis) || !vec3(s.axis.origin) || !vec3(s.axis.dir)) err(`${p}.axis`, "需為 {origin:[x,y,z], dir:[x,y,z]}");
        else if (zeroVector(s.axis.dir)) err(`${p}.axis.dir`, "方向不可為零向量");
        if (!isNum(defaultValue(s.angle, 360)) || s.angle <= 0 || s.angle > 360) err(`${p}.angle`, "角度需在 (0, 360]");
        break;
      case "extrude":
        refCurve(`${p}.curve`, s.curve);
        if (!vec3(s.dir) || zeroVector(s.dir)) err(`${p}.dir`, "需為非零 [x,y,z]");
        if (!isNum(s.length) || s.length <= 0) err(`${p}.length`, "長度需 > 0");
        break;
      case "ruled":
        if (!Array.isArray(s.curves) || s.curves.length !== 2) err(`${p}.curves`, "需恰 2 條曲線");
        else s.curves.forEach((v, j) => refCurve(`${p}.curves[${j}]`, v));
        break;
      case "sweep":
        refCurve(`${p}.profile`, s.profile);
        refCurve(`${p}.rail`, s.rail);
        if (s.guide != null) refCurve(`${p}.guide`, s.guide);
        break;
      case "gordon":
        for (const key of ["profiles", "guides"]) {
          if (!Array.isArray(s[key]) || s[key].length < 2) err(`${p}.${key}`, "至少 2 條曲線");
          else s[key].forEach((v, j) => refCurve(`${p}.${key}[${j}]`, v));
        }
        break;
    }
    if (typeof s.id === "string") surfIds.add(s.id);
  });

  let ops = defaultValue(raw.ops, []);
  if (!Array.isArray(ops)) { err("ops", "必須是陣列"); ops = []; }
  const seenOps = new Set();
  ops.forEach((o, i) => {
    const p = `ops[${i}]`;
    if (!isObject(o) || !TOP_OPS.includes(o.op)) { err(p, "op 必須是 sew/thicken/fillet"); return; }
    if (seenOps.has(o.op)) err(p, `${o.op} 只能出現一次`);
    seenOps.add(o.op);
    if (o.op === "sew") {
      const tol = defaultValue(o.tol, 0.01);
      if (!isNum(tol) || tol <= 0) err(`${p}.tol`, "公差需 > 0");
    } else if (o.op === "thicken") {
      if (!isNum(o.t) || o.t <= 0) err(`${p}.t`, "厚度需 > 0");
      if (!THICKEN_DIRS.includes(defaultValue(o.dir, "outward"))) err(`${p}.dir`, "需為 outward/inward");
      if (result === "shell") err(p, "result=shell 不可加厚");
    } else {
      if (!isNum(o.r) || o.r <= 0) err(`${p}.r`, "半徑需 > 0");
      if (result === "shell") err(p, "result=shell 不可圓角(只對實體)");
    }
  });
  const an = raw.analysis ?? {};
  if (!isObject(an)) err("analysis", "必須是物件");
  else {
    if (!CONTINUITY.includes(defaultValue(an.minContinuity, "G1"))) err("analysis.minContinuity", "需為 G0/G1/G2");
    const creases = defaultValue(an.creases, 0);
    if (!isInt(creases) || creases < 0) err("analysis.creases", "需為 ≥0 整數");
    if (has(an, "zebra") && typeof an.zebra !== "boolean") err("analysis.zebra", "必須是布林");
  }
  return errors;
}

const v3 = (v) => v.map(Number);
const pointArray = (v) => v.map(v3);

export function normalizeDraft(raw, { partial = false } = {}) {
  const errors = validateDraft(raw, { partial });
  if (errors.length) throw new DraftError(errors);
  const curves = raw.curves.map((c) => {
    const out = { id: c.id, kind: c.kind };
    if (c.plane != null) out.plane = c.plane;
    switch (c.kind) {
      case "spline": {
        out.points = pointArray(c.points);
        out.closed = Boolean(c.closed ?? false);
        const tangents = {};
        for (const key of ["start", "end"]) if (c.tangents?.[key] != null) tangents[key] = v3(c.tangents[key]);
        if (Object.keys(tangents).length) out.tangents = tangents;
        break;
      }
      case "nurbs":
        out.degree = Math.trunc(c.degree);
        out.poles = pointArray(c.poles);
        if (c.weights != null) out.weights = c.weights.map(Number);
        out.closed = Boolean(c.closed ?? false);
        break;
      case "bezier": out.poles = pointArray(c.poles); break;
      case "arc3": case "line": out.points = pointArray(c.points); break;
      case "circle": out.center = v3(c.center); out.normal = v3(c.normal); out.r = Number(c.r); break;
    }
    return out;
  });
  const surfaces = raw.surfaces.map((s) => {
    const out = { id: s.id, op: s.op, role: s.role ?? "body" };
    if (CAPPED_OPS.includes(s.op)) out.capped = Boolean(s.capped ?? false);
    switch (s.op) {
      case "loft": out.sections = [...s.sections]; out.ruled = Boolean(s.ruled ?? false); break;
      case "patch":
        out.boundary = [...s.boundary];
        out.continuity = Object.fromEntries(Object.entries(s.continuity ?? {}).map(([key, value]) => [key, { face: value.face, level: value.level }]));
        if (s.points?.length) out.points = pointArray(s.points);
        break;
      case "revolve": out.curve = s.curve; out.axis = { origin: v3(s.axis.origin), dir: v3(s.axis.dir) }; out.angle = Number(s.angle ?? 360); break;
      case "extrude": out.curve = s.curve; out.dir = v3(s.dir); out.length = Number(s.length); break;
      case "ruled": out.curves = [...s.curves]; break;
      case "sweep": out.profile = s.profile; out.rail = s.rail; out.guide = s.guide ?? null; break;
      case "gordon": out.profiles = [...s.profiles]; out.guides = [...s.guides]; break;
    }
    return out;
  });
  const ops = (raw.ops ?? []).map((o) => {
    if (o.op === "sew") return { op: "sew", tol: Number(o.tol ?? 0.01) };
    if (o.op === "thicken") return { op: "thicken", t: Number(o.t), dir: o.dir ?? "outward" };
    return { op: "fillet", r: Number(o.r) };
  }).sort((a, b) => TOP_OPS.indexOf(a.op) - TOP_OPS.indexOf(b.op));
  if (!ops.some((o) => o.op === "sew")) ops.unshift({ op: "sew", tol: 0.01 });
  const an = raw.analysis ?? {};
  return {
    schemaVersion: SCHEMA_VERSION,
    unit: "mm",
    revision: Math.trunc(raw.revision ?? 0),
    result: raw.result ?? "solid",
    symmetry: raw.symmetry ?? null,
    fuse: raw.fuse ?? true,
    curves,
    surfaces,
    ops,
    analysis: { minContinuity: an.minContinuity ?? "G1", creases: Math.trunc(an.creases ?? 0), zebra: an.zebra ?? true },
  };
}

export function emptyDraft() {
  return {
    schemaVersion: 1, unit: "mm", revision: 0, result: "solid", symmetry: null, fuse: true,
    curves: [], surfaces: [], ops: [{ op: "sew", tol: 0.01 }],
    analysis: { minContinuity: "G1", creases: 0, zebra: true },
  };
}

export function applyPatch(draft, patch) {
  const fail = (path, message) => { throw new DraftError([{ path, message }]); };
  if (!isObject(patch)) fail("patch", "patch 必須是物件");
  const out = structuredClone(draft);
  if (has(patch, "remove")) {
    if (!isObject(patch.remove)) fail("patch.remove", "必須是物件");
    for (const key of ["curves", "surfaces", "ops"]) {
      if (!has(patch.remove, key)) continue;
      const ids = patch.remove[key];
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) fail(`patch.remove.${key}`, "需為字串陣列");
      out[key] = (out[key] ?? []).filter((item) => !ids.includes(item[key === "ops" ? "op" : "id"]));
    }
  }
  for (const key of ["curves", "surfaces", "ops"]) {
    if (!has(patch, key)) continue;
    if (!Array.isArray(patch[key])) fail(`patch.${key}`, "必須是陣列");
    const idKey = key === "ops" ? "op" : "id";
    out[key] ??= [];
    patch[key].forEach((item, i) => {
      if (!isObject(item) || typeof item[idKey] !== "string") fail(`patch.${key}[${i}].${idKey}`, `需要 ${idKey}`);
      const index = out[key].findIndex((old) => old[idKey] === item[idKey]);
      const replacement = structuredClone(item);
      if (index < 0) out[key].push(replacement);
      else out[key][index] = replacement;
    });
  }
  for (const key of ["result", "symmetry", "fuse"]) if (has(patch, key)) out[key] = structuredClone(patch[key]);
  if (isObject(patch.analysis)) out.analysis = { ...out.analysis, ...structuredClone(patch.analysis) };
  return out;
}

export function scalarParams(draft) {
  const out = {};
  for (const o of draft.ops ?? []) {
    if (o.op === "thicken") out.thick = o.t;
    if (o.op === "fillet") out.fillet_r = o.r;
  }
  for (const s of draft.surfaces ?? []) if (s.op === "revolve") out.revolve_deg ??= s.angle ?? 360;
  return out;
}

export function applyParams(draft, params) {
  if (params == null || Object.keys(params).length === 0) return draft;
  const out = structuredClone(draft);
  for (const o of out.ops ?? []) {
    if (o.op === "thicken" && isNum(params.thick) && params.thick > 0) o.t = params.thick;
    if (o.op === "fillet" && isNum(params.fillet_r) && params.fillet_r > 0) o.r = params.fillet_r;
  }
  if (isNum(params.revolve_deg) && params.revolve_deg > 0 && params.revolve_deg <= 360) {
    for (const s of out.surfaces ?? []) if (s.op === "revolve") s.angle = params.revolve_deg;
  }
  return out;
}
