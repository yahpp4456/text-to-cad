import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DraftError, validateDraft, normalizeDraft, emptyDraft, applyPatch, scalarParams, applyParams,
  SCHEMA_VERSION, CURVE_KINDS, SURFACE_OPS, TOP_OPS, PLANES, CONTINUITY,
  THICKEN_DIRS, SURFACE_ROLES, MAX_CURVES, MAX_SURFACES, MAX_POINTS,
  MAX_NURBS_DEGREE, MAX_BEZIER_POLES, ID_RE,
} from "./surfaceSchema.js";

const example = (name) => JSON.parse(fs.readFileSync(new URL(`./examples/${name}.json`, import.meta.url), "utf8"));
const line = (id = "a") => ({ id, kind: "line", points: [[0, 0, 0], [10, 0, 0]] });
const minimal = () => ({ schemaVersion: 1, curves: [line()], surfaces: [{ id: "s", op: "extrude", curve: "a", dir: [0, 0, 1], length: 5 }] });
const paths = (draft, options) => new Set(validateDraft(draft, options).map((e) => e.path));
const hasPath = (draft, path) => assert.ok(paths(draft).has(path), `missing ${path}: ${JSON.stringify(validateDraft(draft))}`);
const throwsPath = (fn, path, message) => assert.throws(fn, (err) => err instanceof DraftError && err.errors.some((e) => e.path === path && (message === undefined || e.message === message)));

test("three examples validate, normalize idempotently and serialize", () => {
  for (const name of ["mouse_shell", "vase", "mickey"]) {
    const raw = example(name);
    const before = structuredClone(raw);
    assert.deepStrictEqual(validateDraft(raw), []);
    const normalized = normalizeDraft(raw);
    assert.deepStrictEqual(normalizeDraft(normalized), normalized);
    assert.equal(normalized.ops[0].op, "sew");
    assert.doesNotThrow(() => JSON.stringify(normalized));
    assert.deepStrictEqual(raw, before);
  }
});

test("minimal draft receives all defaults in canonical key order", () => {
  const d = normalizeDraft(minimal());
  assert.equal(d.result, "solid");
  assert.equal(d.symmetry, null);
  assert.equal(d.fuse, true);
  assert.equal(d.revision, 0);
  assert.equal(d.unit, "mm");
  assert.deepStrictEqual(d.ops, [{ op: "sew", tol: 0.01 }]);
  assert.deepStrictEqual(d.analysis, { minContinuity: "G1", creases: 0, zebra: true });
  assert.equal(d.surfaces[0].role, "body");
  assert.equal(d.surfaces[0].capped, false);
  assert.deepStrictEqual(Object.keys(d), ["schemaVersion", "unit", "revision", "result", "symmetry", "fuse", "curves", "surfaces", "ops", "analysis"]);
  assert.deepStrictEqual(Object.keys(d.surfaces[0]), ["id", "op", "role", "capped", "curve", "dir", "length"]);
});

test("ops sort sew then thicken then fillet and report duplicates", () => {
  const d = minimal();
  d.ops = [{ op: "thicken", t: 2 }, { op: "sew" }];
  assert.deepStrictEqual(normalizeDraft(d).ops.map((o) => o.op), ["sew", "thicken"]);
  d.ops.push({ op: "thicken", t: 3 });
  assert.ok(validateDraft(d).some((e) => e.path === "ops[2]" && e.message === "thicken 只能出現一次"));
  d.ops = [{ op: "fillet", r: 1 }, { op: "thicken", t: 2 }];
  assert.deepStrictEqual(normalizeDraft(d).ops.map((o) => o.op), ["sew", "thicken", "fillet"]);
});

test("mouse shell mutation table reports every requested error path", () => {
  const cases = [
    ["schemaVersion", (d) => { d.schemaVersion = 2; }],
    ["result", (d) => { d.result = "mesh"; }],
    ["symmetry", (d) => { d.symmetry = "ZX"; }],
    ["curves", (d) => { d.curves = []; }],
    ["curves[0].id", (d) => { d.curves[0].id = "Bad-Id"; }],
    ["curves[1].id", (d) => { d.curves[1].id = d.curves[0].id; }],
    ["curves[0].kind", (d) => { d.curves[0].kind = "unknown"; }],
    ["curves[0].points", (d) => { d.curves[0].points = [[0, 0, 0]]; }],
    ["curves[0].tangents", (d) => { d.curves[0].tangents = { mid: [1, 0, 0] }; }],
    ["surfaces[0].sections[1]", (d) => { d.surfaces[0].sections[1] = "ghost"; }],
    ["surfaces[0].sections", (d) => { d.surfaces[0].sections = ["sec_front"]; }],
    ["surfaces[0].op", (d) => { d.surfaces[0].op = "unknown"; }],
    ["ops[1].t", (d) => { d.ops[1].t = -1; }],
    ["ops[1].dir", (d) => { d.ops[1].dir = "up"; }],
    ["analysis.minContinuity", (d) => { d.analysis.minContinuity = "G3"; }],
    ["analysis.creases", (d) => { d.analysis.creases = -1; }],
    ["revision", (d) => { d.revision = -1; }],
    ["surfaces[0].role", (d) => { d.surfaces[0].role = "trim"; }],
    ["surfaces[0].capped", (d) => { d.surfaces[0].capped = "yes"; }],
  ];
  for (const [path, mutate] of cases) {
    const d = example("mouse_shell");
    mutate(d);
    hasPath(d, path);
  }
  const d = example("mouse_shell");
  d.surfaces[0].sections[1] = "ghost";
  assert.deepStrictEqual(validateDraft(d), [{ path: "surfaces[0].sections[1]", message: "引用未宣告的曲線:'ghost'" }]);
});

test("shell forbids thicken and fillet", () => {
  const d = example("mouse_shell");
  d.result = "shell";
  assert.ok(validateDraft(d).some((e) => e.path === "ops[1]" && e.message === "result=shell 不可加厚"));
  d.ops = [{ op: "fillet", r: 2 }];
  assert.deepStrictEqual(validateDraft(d), [{ path: "ops[0]", message: "result=shell 不可圓角(只對實體)" }]);
});

test("patch continuity refers only to its boundary and earlier surfaces", () => {
  const d = example("mouse_shell");
  d.curves.push(line("c_a"), line("c_b"));
  d.surfaces.push({ id: "cap", op: "patch", boundary: ["c_a", "c_b"], continuity: { c_a: { face: "body", level: "G2" } }, points: [[0, 0, 0]] });
  assert.deepStrictEqual(validateDraft(d), []);
  const normalized = normalizeDraft(d);
  assert.deepStrictEqual(normalizeDraft(normalized), normalized);
  assert.deepStrictEqual(Object.keys(normalized.surfaces[1]), ["id", "op", "role", "boundary", "continuity", "points"]);
  const wrongBoundary = structuredClone(d);
  wrongBoundary.surfaces[1].continuity = { sec_mid: { face: "body", level: "G2" } };
  hasPath(wrongBoundary, "surfaces[1].continuity.sec_mid");
  for (const face of ["ghost", "cap", "later"]) {
    const wrongFace = structuredClone(d);
    wrongFace.surfaces[1].continuity.c_a.face = face;
    wrongFace.surfaces.push({ id: "later", op: "ruled", curves: ["c_a", "c_b"] });
    hasPath(wrongFace, "surfaces[1].continuity.c_a.face");
  }
  d.surfaces[1].continuity.c_a.level = "C2";
  hasPath(d, "surfaces[1].continuity.c_a");
});

test("nurbs requires degree plus one poles and matching positive weights", () => {
  const d = example("mouse_shell");
  const c = { id: "n", kind: "nurbs", degree: 3, poles: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] };
  d.curves.push(c);
  assert.deepStrictEqual(validateDraft(d), [{ path: "curves[3].poles", message: "degree 3 至少 4 個控制點" }]);
  c.poles.push([3, 0, 0]);
  c.weights = [1, 1, 1];
  hasPath(d, "curves[3].weights");
  c.weights.push(1);
  assert.deepStrictEqual(validateDraft(d), []);
  assert.deepStrictEqual(normalizeDraft(normalizeDraft(d)), normalizeDraft(d));
  c.weights[0] = 0;
  assert.deepStrictEqual(validateDraft(d), [{ path: "curves[3].weights", message: "需為正數陣列" }]);
});

test("empty drafts validate only in partial mode and are freshly allocated", () => {
  const d = emptyDraft();
  assert.deepStrictEqual(validateDraft(d, { partial: true }), []);
  assert.deepStrictEqual([...paths(d)], ["curves", "surfaces"]);
  assert.deepStrictEqual(normalizeDraft(d, { partial: true }), d);
  assert.notStrictEqual(emptyDraft().analysis, d.analysis);
  assert.notStrictEqual(emptyDraft().ops[0], d.ops[0]);
  d.curves = null;
  hasPath(d, "curves");
  assert.ok(paths(d, { partial: true }).has("curves"));
});

test("DraftError exposes ordered errors and joins their messages", () => {
  throwsPath(() => normalizeDraft({ schemaVersion: 1 }), "curves");
  const errors = [{ path: "a", message: "bad" }, { path: "b", message: "worse" }];
  const err = new DraftError(errors);
  assert.strictEqual(err.errors, errors);
  assert.equal(err.message, "a: bad; b: worse");
  assert.equal(new DraftError([]).message, "invalid draft");
});

test("applyPatch replaces whole entries, appends, removes and preserves both inputs", () => {
  const d = example("mouse_shell");
  const patch = {
    remove: { curves: ["sec_back", "missing"], surfaces: ["missing"], ops: ["sew"] },
    curves: [line("sec_front"), line("new_edge")],
    surfaces: [{ id: "body", op: "extrude", curve: "sec_front", dir: [0, 0, 1], length: 5 }, { id: "cap", op: "ruled", curves: ["sec_front", "new_edge"] }],
    ops: [{ op: "thicken", t: 3 }, { op: "fillet", r: 1 }],
    result: "shell", symmetry: null, fuse: false, analysis: { creases: 2 },
    revision: 99, schemaVersion: 2, unit: "cm", ignored: "value",
  };
  const beforeDraft = structuredClone(d);
  const beforePatch = structuredClone(patch);
  const out = applyPatch(d, patch);
  assert.deepStrictEqual(out.curves.map((c) => c.id), ["sec_front", "sec_mid", "new_edge"]);
  assert.deepStrictEqual(out.curves[0], line("sec_front"));
  assert.deepStrictEqual(out.surfaces, patch.surfaces);
  assert.deepStrictEqual(out.ops, [{ op: "thicken", t: 3 }, { op: "fillet", r: 1 }]);
  assert.equal(out.result, "shell");
  assert.equal(out.symmetry, null);
  assert.equal(out.fuse, false);
  assert.deepStrictEqual(out.analysis, { minContinuity: "G1", creases: 2, zebra: true });
  assert.equal(out.revision, d.revision);
  assert.equal(out.schemaVersion, d.schemaVersion);
  assert.equal(out.unit, d.unit);
  assert.ok(!Object.hasOwn(out, "ignored"));
  assert.deepStrictEqual(d, beforeDraft);
  assert.deepStrictEqual(patch, beforePatch);
  out.curves[0].points[0][0] = 999;
  out.curves[1].points[0][0] = 999;
  assert.deepStrictEqual(d, beforeDraft);
  assert.deepStrictEqual(patch, beforePatch);
  throwsPath(() => applyPatch(d, { curves: [{}] }), "patch.curves[0].id", "需要 id");
});

test("scalarParams and applyParams match example scalars without mutating drafts", () => {
  assert.deepStrictEqual(scalarParams(example("mouse_shell")), { thick: 2 });
  const vase = example("vase");
  const before = structuredClone(vase);
  assert.deepStrictEqual(scalarParams(vase), { thick: 2, revolve_deg: 360 });
  assert.equal(applyParams(vase, { revolve_deg: 180 }).surfaces[0].angle, 180);
  assert.deepStrictEqual(vase, before);
  assert.equal(applyParams(vase, { thick: -1 }).ops[1].t, 2);
});

test("schema source contains no forbidden dependency name", () => {
  const source = fs.readFileSync(new URL("./surfaceSchema.js", import.meta.url), "utf8");
  assert.ok(!source.includes("three"));
});

test("all exported constants match the contract", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepStrictEqual(CURVE_KINDS, ["spline", "nurbs", "bezier", "arc3", "line", "circle"]);
  assert.deepStrictEqual(SURFACE_OPS, ["loft", "patch", "revolve", "extrude", "ruled", "sweep", "gordon"]);
  assert.deepStrictEqual(TOP_OPS, ["sew", "thicken", "fillet"]);
  assert.deepStrictEqual(PLANES, ["XY", "XZ", "YZ"]);
  assert.deepStrictEqual(CONTINUITY, ["G0", "G1", "G2"]);
  assert.deepStrictEqual(THICKEN_DIRS, ["outward", "inward"]);
  assert.deepStrictEqual(SURFACE_ROLES, ["body", "cut", "add"]);
  assert.deepStrictEqual([MAX_CURVES, MAX_SURFACES, MAX_POINTS, MAX_NURBS_DEGREE, MAX_BEZIER_POLES], [64, 32, 64, 5, 8]);
  assert.equal(ID_RE.source, "^[a-z][a-z0-9_]*$");
});

test("all curve and surface variants normalize without sharing nested references", () => {
  const d = minimal();
  d.curves.push(
    { id: "spline", kind: "spline", plane: "XY", closed: true, points: [[0, 0, 0], [1, 0, 0]], tangents: { start: [1, 0, 0], end: null } },
    { id: "nurbs", kind: "nurbs", degree: 1, poles: [[0, 0, 0], [1, 0, 0]], weights: [1, 2] },
    { id: "bezier", kind: "bezier", poles: [[0, 0, 0], [1, 0, 0]] },
    { id: "arc", kind: "arc3", points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] },
    { id: "circle", kind: "circle", center: [0, 0, 0], normal: [0, 0, 1], r: 3 },
  );
  d.surfaces.push(
    { id: "loft", op: "loft", sections: ["a", "spline"] },
    { id: "patch", op: "patch", boundary: ["a", "spline"], continuity: { a: { face: "s", level: "G1" } } },
    { id: "revolve", op: "revolve", curve: "a", axis: { origin: [0, 0, 0], dir: [0, 0, 1] } },
    { id: "ruled", op: "ruled", curves: ["a", "spline"], role: "cut" },
    { id: "sweep", op: "sweep", profile: "a", rail: "spline" },
    { id: "gordon", op: "gordon", profiles: ["a", "spline"], guides: ["a", "circle"] },
  );
  const before = structuredClone(d);
  const out = normalizeDraft(d);
  assert.deepStrictEqual(normalizeDraft(out), out);
  assert.deepStrictEqual(Object.keys(out.curves[1]), ["id", "kind", "plane", "points", "closed", "tangents"]);
  assert.deepStrictEqual(Object.keys(out.curves[2]), ["id", "kind", "degree", "poles", "weights", "closed"]);
  assert.equal(out.surfaces[3].angle, 360);
  assert.equal(out.surfaces[5].guide, null);
  function checkDetached(a, b) {
    if (a !== null && typeof a === "object") {
      assert.notStrictEqual(a, b);
      for (const key of Object.keys(a)) if (Object.hasOwn(b, key)) checkDetached(a[key], b[key]);
    }
  }
  checkDetached(d, out);
  assert.deepStrictEqual(d, before);
});

test("validation reports exact messages and order without throwing on malformed JSON values", () => {
  for (const raw of [null, [], 1, "draft", false]) assert.deepStrictEqual(validateDraft(raw), [{ path: "", message: "spec 必須是物件" }]);
  const d = minimal();
  Object.assign(d, { schemaVersion: 2, unit: "cm", result: "mesh", symmetry: "ZX", fuse: 1, revision: -1, curves: null, surfaces: null, ops: null, analysis: [] });
  assert.deepStrictEqual(validateDraft(d), [
    { path: "schemaVersion", message: "必須是 1" }, { path: "unit", message: "只支援 mm" },
    { path: "result", message: "必須是 solid 或 shell" }, { path: "symmetry", message: "必須是 null/XY/XZ/YZ" },
    { path: "fuse", message: "必須是布林" }, { path: "revision", message: "必須是 ≥0 的整數" },
    { path: "curves", message: "至少一條曲線" }, { path: "surfaces", message: "至少一個曲面" },
    { path: "ops", message: "必須是陣列" }, { path: "analysis", message: "必須是物件" },
  ]);
  for (const value of [null, [], {}, "bad", true, 0]) {
    for (const kind of CURVE_KINDS) {
      const raw = minimal();
      raw.curves.push({ id: "bad", kind, points: value, poles: value, weights: value, tangents: value, degree: value, center: value, normal: value, r: value });
      assert.doesNotThrow(() => validateDraft(raw));
    }
    for (const op of SURFACE_OPS) {
      const raw = minimal();
      raw.surfaces.push({ id: "bad", op, boundary: value, continuity: value, sections: value, axis: value, dir: value, curves: value, profiles: value, guides: value });
      assert.doesNotThrow(() => validateDraft(raw));
    }
  }
});

test("numeric limits, item types, references and optional booleans are checked", () => {
  const cases = [
    ["curves", (d) => { d.curves = Array.from({ length: 65 }, (_, i) => line(`a${i}`)); }],
    ["surfaces", (d) => { d.surfaces = Array.from({ length: 33 }, (_, i) => ({ ...d.surfaces[0], id: `s${i}` })); }],
    ["curves[0]", (d) => { d.curves[0] = []; }],
    ["curves[0].plane", (d) => { d.curves[0].plane = "ZX"; }],
    ["curves[0].closed", (d) => { d.curves[0].closed = 1; }],
    ["curves[0].points", (d) => { d.curves[0].points[0][0] = Infinity; }],
    ["surfaces[0]", (d) => { d.surfaces[0] = null; }],
    ["surfaces[0].id", (d) => { d.surfaces[0].id = "a"; }],
    ["surfaces[0].dir", (d) => { d.surfaces[0].dir = [1e-13, 0, 0]; }],
    ["surfaces[0].length", (d) => { d.surfaces[0].length = "5"; }],
    ["ops[0]", (d) => { d.ops = [null]; }],
    ["ops[0].tol", (d) => { d.ops = [{ op: "sew", tol: 0 }]; }],
    ["ops[0].r", (d) => { d.ops = [{ op: "fillet", r: NaN }]; }],
    ["analysis.zebra", (d) => { d.analysis = { zebra: null }; }],
  ];
  for (const [path, mutate] of cases) { const d = minimal(); mutate(d); hasPath(d, path); }
  const d = example("vase");
  d.surfaces[0].capped = "yes"; // revolve 也支援 capped,改用非布林觸發同一路徑
  d.surfaces[0].axis.dir = [0, 0, 0];
  d.surfaces[0].angle = 361;
  assert.deepStrictEqual([...paths(d)], ["surfaces[0].capped", "surfaces[0].axis.dir", "surfaces[0].angle"]);
  const ref = minimal();
  ref.surfaces[0].curve = null;
  assert.deepStrictEqual(validateDraft(ref), [{ path: "surfaces[0].curve", message: "引用未宣告的曲線:null" }]);
});

test("applyPatch validates patch containers and removal lists, and removes before adding", () => {
  for (const bad of [null, [], 1]) throwsPath(() => applyPatch(minimal(), bad), "patch", "patch 必須是物件");
  for (const key of ["curves", "surfaces", "ops"]) {
    throwsPath(() => applyPatch(minimal(), { remove: { [key]: [1] } }), `patch.remove.${key}`, "需為字串陣列");
    throwsPath(() => applyPatch(minimal(), { [key]: {} }), `patch.${key}`, "必須是陣列");
    const idKey = key === "ops" ? "op" : "id";
    throwsPath(() => applyPatch(minimal(), { [key]: [null] }), `patch.${key}[0].${idKey}`, `需要 ${idKey}`);
  }
  const d = minimal();
  d.curves.push(line("b"));
  const out = applyPatch(d, { remove: { curves: ["a"], surfaces: ["s"] }, curves: [line("a")] });
  assert.deepStrictEqual(out.curves.map((c) => c.id), ["b", "a"]);
  assert.deepStrictEqual(out.surfaces, []);
  assert.deepStrictEqual(applyPatch(d, { analysis: [] }), d);
});

test("scalar overrides ignore invalid values and apply angles to every revolve", () => {
  const d = example("mickey");
  assert.deepStrictEqual(scalarParams(d), { fillet_r: 3, revolve_deg: 360 });
  d.surfaces[1].angle = 90;
  assert.equal(scalarParams(d).revolve_deg, 360);
  assert.deepStrictEqual(applyParams(d, { revolve_deg: 180 }).surfaces.map((s) => s.angle), [180, 180]);
  assert.equal(applyParams(d, { fillet_r: 1.5 }).ops[1].r, 1.5);
  for (const value of [-1, 0, "2", null, NaN, Infinity]) {
    assert.deepStrictEqual(applyParams(d, { revolve_deg: value, fillet_r: value }), d);
    const vase = example("vase");
    assert.deepStrictEqual(applyParams(vase, { thick: value }), vase);
  }
  assert.deepStrictEqual(applyParams(d, { revolve_deg: 361 }), d);
  assert.strictEqual(applyParams(d, null), d);
  assert.strictEqual(applyParams(d, {}), d);
  const vase = example("vase");
  delete vase.surfaces[0].angle;
  assert.equal(scalarParams(vase).revolve_deg, 360);
  assert.equal(applyParams(vase, { thick: 4 }).ops[1].t, 4);
});
