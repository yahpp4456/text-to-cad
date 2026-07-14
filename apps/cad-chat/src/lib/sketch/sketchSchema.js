// 草模場景 schema v1:normalize(填預設)+ validate(結構/引用/DOF/循環)。
// 單一真相源,前後端共用:server 的 sketch_present 與前端 SketchCanvas 都 import
// 本檔。零依賴(不 import three/cadjs)——asar 排除 node_modules/three,且
// node --test 不解析 Vite alias。錯誤訊息繁中、可執行,agent retry 迴圈直接吃。

export const SKETCH_SCHEMA_VERSION = 1;

// role → PBR 材質參數(mesh 層與圖例共用;hex 同時是圖例色塊)
export const ROLE_COLORS = {
  frame:     { color: "#9aa0a6", metalness: 0.55, roughness: 0.6 },
  output:    { color: "#1D9E75", metalness: 0.45, roughness: 0.45 },
  actuator:  { color: "#D85A30", metalness: 0.6, roughness: 0.38 },
  rod:       { color: "#dfe3e8", metalness: 0.95, roughness: 0.16 },
  coupler:   { color: "#E0A52E", metalness: 0.55, roughness: 0.4 },
  clevis:    { color: "#b9c0c7", metalness: 0.82, roughness: 0.3 },
  pin:       { color: "#515963", metalness: 0.92, roughness: 0.26 },
  hole:      { color: "#12161b", metalness: 0.3, roughness: 0.9 },
  workpiece: { color: "#6b7686", metalness: 0.5, roughness: 0.55 },
  accent:    { color: "#2bbf8f", metalness: 0.5, roughness: 0.4 },
  motor:     { color: "#4667a9", metalness: 0.7, roughness: 0.35 },
  belt:      { color: "#2f3640", metalness: 0.1, roughness: 0.85 },
};

export const PART_TYPES = new Set([
  "box", "cylinder", "plate", "hole", // 基元
  "pin_clevis", "gear", "rack", "link_eye", // 參數化 macro
  "motor", "pulley", "belt", // 傳動呈現 macro(馬達外形/皮帶輪/帶體)
]);

const JOINT_TYPES = new Set(["fixed", "revolute", "prismatic"]);
const DERIVED_TYPES = new Set(["pin_on_line", "actuator", "coupler", "attach"]);
const READOUT_KINDS = new Set(["drive", "joint", "stroke", "distance", "angle", "phase"]);
const EASES = new Set(["smooth", "linear"]);
const AXES = new Set(["x", "y", "z"]);

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const str = (v, d) => (typeof v === "string" && v.trim() ? v.trim() : d);
// 「缺欄位補預設、非法值原樣保留」:normalize 不吞錯,讓 validate 產生可回饋
// agent 的錯誤訊息(靜默修復會把壞範圍/壞座標變成看似合法的別的東西)。
const keepNum = (v, d) => (v === undefined ? d : v);
const keepVec3 = (v, d) => (v === undefined ? d : isVec3(v) ? [...v] : v);

function normAnchor(a) {
  if (!a || typeof a !== "object") return a;
  if ("point" in a) return { point: a.point };
  return { body: a.body, at: keepVec3(a.at, [0, 0, 0]) };
}

function normPart(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  out.at = keepVec3(p.at, [0, 0, 0]);
  if (p.rot !== undefined) out.rot = keepVec3(p.rot, [0, 0, 0]);
  return out;
}

// ---------------------------------------------------------------------------
// normalizeSketch:寬鬆填預設(不丟錯;垃圾留給 validate 抓)
// ---------------------------------------------------------------------------

export function normalizeSketch(raw) {
  const d = raw && typeof raw === "object" ? structuredClone(raw) : {};
  const doc = {
    schemaVersion: d.schemaVersion,
    name: str(d.name, "sketch"),
    title: str(d.title, str(d.name, "機構草模")),
    bodies: Array.isArray(d.bodies) ? d.bodies : [],
    drives: Array.isArray(d.drives) ? d.drives : [],
    derived: Array.isArray(d.derived) ? d.derived : [],
    program: d.program && typeof d.program === "object" ? d.program : { mode: "pingpong" },
    readouts: Array.isArray(d.readouts) ? d.readouts : [],
    annotations: Array.isArray(d.annotations) ? d.annotations : [],
    camera: d.camera && typeof d.camera === "object" ? d.camera : null,
  };

  doc.bodies = doc.bodies.map((b) => {
    if (!b || typeof b !== "object") return b;
    const j = b.joint && typeof b.joint === "object" ? b.joint : { type: "fixed" };
    return {
      id: b.id,
      label: str(b.label, ""),
      role: str(b.role, "frame"),
      parent: b.parent === undefined ? "world" : b.parent,
      origin: keepVec3(b.origin, [0, 0, 0]),
      joint: {
        type: str(j.type, "fixed"),
        axis: keepVec3(j.axis, [0, 0, 1]),
        drive: j.drive ?? null,
        scale: keepNum(j.scale, 1),
        offset: keepNum(j.offset, 0),
      },
      partsFrom: b.partsFrom && typeof b.partsFrom === "object"
        ? { body: b.partsFrom.body, mirror: b.partsFrom.mirror }
        : null,
      parts: Array.isArray(b.parts) ? b.parts.map(normPart) : [],
    };
  });

  doc.drives = doc.drives.map((dr) => {
    if (!dr || typeof dr !== "object") return dr;
    const min = keepNum(dr.min, 0);
    const max = keepNum(dr.max, (isNum(min) ? min : 0) + 1);
    return {
      id: dr.id,
      label: str(dr.label, typeof dr.id === "string" ? dr.id : ""),
      unit: str(dr.unit, ""),
      min,
      max,
      home: keepNum(dr.home, min),
      // 預設單程 2 秒;範圍非法時給 1 佔位(validate 會先抓 min/max)
      speed: keepNum(dr.speed, isNum(min) && isNum(max) && max > min ? (max - min) / 2 : 1),
    };
  });

  doc.derived = doc.derived.map((e) => {
    if (!e || typeof e !== "object") return e;
    const out = { ...e, id: e.id, type: e.type };
    if (e.type === "pin_on_line") {
      out.line = {
        origin: keepVec3(e.line?.origin, [0, 0, 0]),
        dir: keepVec3(e.line?.dir, [1, 0, 0]),
      };
      out.link = { to: normAnchor(e.link?.to), len: keepNum(e.link?.len, 0) };
      out.branch = e.branch === "+" ? "+" : "-";
    } else if (e.type === "actuator" || e.type === "coupler") {
      out.from = normAnchor(e.from);
      out.to = normAnchor(e.to);
      out.look = e.look && typeof e.look === "object" ? { ...e.look } : {};
      if (out.look.role === undefined) out.look.role = e.type === "actuator" ? "actuator" : "coupler";
      if (Array.isArray(out.look.parts)) out.look.parts = out.look.parts.map(normPart);
    } else if (e.type === "attach") {
      out.look = e.look && typeof e.look === "object" ? { ...e.look } : {};
      if (out.look.role === undefined) out.look.role = "workpiece";
      if (Array.isArray(out.look.parts)) out.look.parts = out.look.parts.map(normPart);
      const states = {};
      if (e.states && typeof e.states === "object") {
        for (const [k, s] of Object.entries(e.states)) {
          states[k] = {
            body: s?.body ?? "world",
            at: keepVec3(s?.at, [0, 0, 0]),
            rot: keepVec3(s?.rot, [0, 0, 0]),
          };
        }
      }
      out.states = states;
      out.initial = e.initial;
    }
    return out;
  });

  const p = doc.program;
  if (p.mode === "timeline") {
    doc.program = {
      mode: "timeline",
      cycleS: num(p.cycleS, 8),
      phases: Array.isArray(p.phases)
        ? p.phases.map((ph) => ({
            until: num(ph?.until, NaN),
            name: str(ph?.name, ""),
            drives: ph?.drives && typeof ph.drives === "object" ? { ...ph.drives } : {},
            attach: ph?.attach && typeof ph.attach === "object" ? { ...ph.attach } : {},
          }))
        : [],
    };
  } else {
    doc.program = { mode: "pingpong" };
  }

  doc.readouts = doc.readouts.map((r, i) => {
    if (!r || typeof r !== "object") return r;
    const out = { ...r, id: str(r.id, `r${i}`), label: str(r.label, "") };
    if (r.kind === "drive") {
      out.decimals = Math.max(0, Math.round(num(r.decimals, 1)));
      out.factor = num(r.factor, 1);
    } else if (r.kind === "angle") {
      out.at = normAnchor(r.at);
      out.arms = Array.isArray(r.arms) ? r.arms.map(normAnchor) : [];
      out.fold = r.fold !== false;
      out.thresholds = Array.isArray(r.thresholds) && r.thresholds.length === 2
        ? [...r.thresholds] : [30, 45];
      out.decimals = Math.max(0, Math.round(num(r.decimals, 1)));
    } else if (r.kind === "distance") {
      out.from = normAnchor(r.from);
      out.to = normAnchor(r.to);
      out.decimals = Math.max(0, Math.round(num(r.decimals, 1)));
    } else {
      out.decimals = Math.max(0, Math.round(num(r.decimals, r.kind === "stroke" ? 2 : 1)));
    }
    if (out.unit === undefined) out.unit = r.kind === "stroke" || r.kind === "distance" ? "mm" : "";
    return out;
  });

  doc.annotations = doc.annotations.map((a) => {
    if (!a || typeof a !== "object") return a;
    if (a.type === "trace") {
      return {
        type: "trace",
        point: normAnchor(a.point),
        drive: a.drive,
        samples: Math.max(2, Math.min(200, Math.round(num(a.samples, 40)))),
      };
    }
    return { ...a };
  });

  if (doc.camera) {
    doc.camera = {
      target: isVec3(doc.camera.target) ? [...doc.camera.target] : null,
      distance: num(doc.camera.distance, 0) > 0 ? doc.camera.distance : null,
    };
    if (!doc.camera.target && !doc.camera.distance) doc.camera = null;
  }

  return doc;
}

// ---------------------------------------------------------------------------
// validateSketch:回 {ok, errors, warnings, doc(normalized), order(topo)}
// ---------------------------------------------------------------------------

export function validateSketch(raw) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err("", "scene 必須是 JSON 物件");
    return { ok: false, errors, warnings, doc: null, order: null };
  }
  const doc = normalizeSketch(raw);

  if (doc.schemaVersion !== SKETCH_SCHEMA_VERSION) {
    err("schemaVersion", `schemaVersion 必須是 ${SKETCH_SCHEMA_VERSION}`);
  }

  // ---- id 空間(bodies ∪ drives ∪ derived ∪ readouts)----
  const bodyIds = new Set();
  const driveIds = new Set();
  const derivedIds = new Set();
  const allIds = new Set();
  const claimId = (path, id) => {
    if (typeof id !== "string" || !id.trim()) {
      err(path, "缺少 id(非空字串)");
      return null;
    }
    if (allIds.has(id)) {
      err(path, `id "${id}" 重複(bodies/drives/derived/readouts 全域唯一)`);
      return null;
    }
    allIds.add(id);
    return id;
  };

  if (!doc.bodies.length) err("bodies", "bodies 不可為空(至少一個剛體)");
  doc.bodies.forEach((b, i) => {
    if (!b || typeof b !== "object") return err(`bodies[${i}]`, "必須是物件");
    const id = claimId(`bodies[${i}].id`, b.id);
    if (id) bodyIds.add(id);
  });
  doc.drives.forEach((d, i) => {
    if (!d || typeof d !== "object") return err(`drives[${i}]`, "必須是物件");
    const id = claimId(`drives[${i}].id`, d.id);
    if (id) driveIds.add(id);
  });
  doc.derived.forEach((e, i) => {
    if (!e || typeof e !== "object") return err(`derived[${i}]`, "必須是物件");
    const id = claimId(`derived[${i}].id`, e.id);
    if (id) derivedIds.add(id);
  });
  doc.readouts.forEach((r, i) => {
    if (r && typeof r === "object") claimId(`readouts[${i}].id`, r.id);
  });

  const derivedById = new Map(doc.derived.filter((e) => e?.id).map((e) => [e.id, e]));
  const pointIds = new Set(
    doc.derived.filter((e) => e?.type === "pin_on_line" && e.id).map((e) => e.id),
  );

  const checkAnchor = (path, a, { allowPoint = true } = {}) => {
    if (!a || typeof a !== "object") return err(path, "anchor 必須是 {body,at} 或 {point}");
    if ("point" in a) {
      if (!allowPoint) return err(path, "此處不可引用派生點");
      if (!pointIds.has(a.point)) {
        return err(path, `point "${a.point}" 不存在(只能引用 pin_on_line 派生點)`);
      }
      return;
    }
    if (a.body !== "world" && !bodyIds.has(a.body)) {
      return err(path, `body "${a.body}" 不存在(可用 "world" 或既有 body id)`);
    }
    if (!isVec3(a.at)) err(`${path}.at`, "at 必須是 [x,y,z] 有限數字");
  };

  // ---- drives:1~2 個、範圍合法 ----
  if (doc.drives.length < 1 || doc.drives.length > 2) {
    err("drives", `drives 必須是 1~2 個驅動變數(目前 ${doc.drives.length});DOF≤2 是硬限制`);
  }
  doc.drives.forEach((d, i) => {
    if (!d || typeof d !== "object") return;
    const p = `drives[${i}]`;
    if (!(isNum(d.min) && isNum(d.max) && d.min < d.max)) {
      err(p, `min/max 必須是有限數字且 min < max(目前 ${d.min}..${d.max})`);
    }
    if (!(isNum(d.home) && d.home >= d.min && d.home <= d.max)) {
      err(`${p}.home`, `home 必須落在 [min,max] 內`);
    }
    if (!(isNum(d.speed) && d.speed > 0)) err(`${p}.speed`, "speed 必須 > 0");
  });

  // ---- bodies ----
  const usedDrives = new Set();
  doc.bodies.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    const p = `bodies[${i}]`;
    if (typeof b.parent === "object" && b.parent !== null) {
      if (!pointIds.has(b.parent.point)) {
        err(`${p}.parent`, `parent.point "${b.parent?.point}" 不存在(只能掛 pin_on_line 派生點)`);
      }
    } else if (b.parent !== "world" && !bodyIds.has(b.parent)) {
      err(`${p}.parent`, `parent "${b.parent}" 不存在(可用 "world"、body id 或 {point:…})`);
    } else if (b.parent === b.id) {
      err(`${p}.parent`, "parent 不可是自己");
    }
    if (!isVec3(b.origin)) err(`${p}.origin`, "origin 必須是 [x,y,z] 有限數字");
    const j = b.joint;
    if (!JOINT_TYPES.has(j.type)) {
      err(`${p}.joint.type`, `未知 joint type "${j.type}"(可用 fixed/revolute/prismatic)`);
    } else if (j.type !== "fixed") {
      if (!driveIds.has(j.drive)) {
        err(`${p}.joint.drive`, `joint 必須綁定既有 drive(得到 "${j.drive}");草模無自由關節`);
      } else {
        usedDrives.add(j.drive);
      }
      if (!isVec3(j.axis) || Math.hypot(...j.axis) < 1e-9) {
        err(`${p}.joint.axis`, "axis 必須是非零 [x,y,z]");
      }
      if (!isNum(j.scale) || !isNum(j.offset)) err(`${p}.joint`, "scale/offset 必須是有限數字");
    }
    if (b.partsFrom) {
      if (!bodyIds.has(b.partsFrom.body) || b.partsFrom.body === b.id) {
        err(`${p}.partsFrom.body`, `partsFrom.body 必須是另一個既有 body`);
      }
      if (!AXES.has(b.partsFrom.mirror)) {
        err(`${p}.partsFrom.mirror`, `mirror 必須是 "x"/"y"/"z"`);
      }
    }
    if (!ROLE_COLORS[b.role]) warn(`${p}.role`, `未知 role "${b.role}",將以 frame 材質呈現`);
    checkParts(`${p}.parts`, b.parts, err, warn);
  });

  // ---- derived ----
  doc.derived.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const p = `derived[${i}]`;
    if (!DERIVED_TYPES.has(e.type)) {
      return err(`${p}.type`, `未知 derived type "${e.type}"(可用 pin_on_line/actuator/coupler/attach)`);
    }
    if (e.type === "pin_on_line") {
      if (!isVec3(e.line.origin)) err(`${p}.line.origin`, "line.origin 必須是 [x,y,z]");
      if (!isVec3(e.line.dir) || Math.hypot(...e.line.dir) < 1e-9) {
        err(`${p}.line.dir`, "line.dir 必須是非零 [x,y,z]");
      }
      checkAnchor(`${p}.link.to`, e.link.to);
      if (!(isNum(e.link.len) && e.link.len > 0)) err(`${p}.link.len`, "link.len 必須 > 0");
    } else if (e.type === "actuator" || e.type === "coupler") {
      checkAnchor(`${p}.from`, e.from);
      checkAnchor(`${p}.to`, e.to);
      for (const k of ["bore", "barrelLen", "rodR", "w", "eyeR"]) {
        if (e.look[k] !== undefined && !(isNum(e.look[k]) && e.look[k] > 0)) {
          err(`${p}.look.${k}`, `${k} 必須 > 0`);
        }
      }
      if (e.look.role && !ROLE_COLORS[e.look.role]) {
        warn(`${p}.look.role`, `未知 role "${e.look.role}"`);
      }
    } else if (e.type === "attach") {
      const names = Object.keys(e.states || {});
      if (!names.length) return err(`${p}.states`, "attach 至少要有一個具名狀態");
      for (const [name, s] of Object.entries(e.states)) {
        const sp = `${p}.states.${name}`;
        if (s.body !== "world" && !bodyIds.has(s.body)) {
          err(`${sp}.body`, `body "${s.body}" 不存在`);
        }
        if (!isVec3(s.at)) err(`${sp}.at`, "at 必須是 [x,y,z]");
        if (!isVec3(s.rot)) err(`${sp}.rot`, "rot 必須是 [rx,ry,rz](度)");
      }
      if (!names.includes(e.initial)) {
        err(`${p}.initial`, `initial "${e.initial}" 必須是 states 之一(${names.join("/")})`);
      }
      if (Array.isArray(e.look.parts)) checkParts(`${p}.look.parts`, e.look.parts, err, warn);
    }
  });

  // ---- program ----
  const attachIds = new Set(
    doc.derived.filter((e) => e?.type === "attach" && e.id).map((e) => e.id),
  );
  if (doc.program.mode === "timeline") {
    const pr = doc.program;
    if (!(isNum(pr.cycleS) && pr.cycleS > 0)) err("program.cycleS", "cycleS 必須 > 0(秒)");
    if (!pr.phases.length) err("program.phases", "timeline 至少要有一段 phase");
    let prev = 0;
    pr.phases.forEach((ph, i) => {
      const p = `program.phases[${i}]`;
      if (!(isNum(ph.until) && ph.until > prev && ph.until <= 1 + 1e-9)) {
        err(`${p}.until`, `until 必須嚴格遞增且 ≤ 1(前值 ${prev},得到 ${ph.until})`);
      } else {
        prev = ph.until;
      }
      for (const [k, v] of Object.entries(ph.drives)) {
        if (!driveIds.has(k)) {
          err(`${p}.drives.${k}`, `drive "${k}" 不存在`);
        } else {
          usedDrives.add(k);
        }
        if (isNum(v)) continue;
        if (v && typeof v === "object" && isNum(v.to)) {
          if (v.ease !== undefined && !EASES.has(v.ease)) {
            err(`${p}.drives.${k}.ease`, `ease 只支援 smooth/linear`);
          }
        } else {
          err(`${p}.drives.${k}`, "drive 值必須是數字(定值)或 {to, ease?}");
        }
      }
      for (const [k, v] of Object.entries(ph.attach)) {
        if (!attachIds.has(k)) {
          err(`${p}.attach.${k}`, `attach "${k}" 不存在(必須是 derived attach 的 id)`);
        } else {
          const st = derivedById.get(k)?.states || {};
          if (!(v in st)) err(`${p}.attach.${k}`, `狀態 "${v}" 不存在(可用 ${Object.keys(st).join("/")})`);
        }
      }
    });
    if (pr.phases.length && Math.abs(pr.phases[pr.phases.length - 1].until - 1) > 1e-9) {
      err("program.phases", "最後一段的 until 必須是 1.0(涵蓋整個週期)");
    }
  }

  // ---- 每個 drive 都要有人用 ----
  doc.drives.forEach((d, i) => {
    if (d?.id && driveIds.has(d.id) && !usedDrives.has(d.id)) {
      err(`drives[${i}]`, `drive "${d.id}" 沒有任何 joint 或 timeline 使用(掛到 joint.drive 或刪掉)`);
    }
  });

  // ---- readouts ----
  const actuatorIds = new Set(
    doc.derived.filter((e) => e?.type === "actuator" && e.id).map((e) => e.id),
  );
  doc.readouts.forEach((r, i) => {
    if (!r || typeof r !== "object") return err(`readouts[${i}]`, "必須是物件");
    const p = `readouts[${i}]`;
    if (!READOUT_KINDS.has(r.kind)) {
      return err(`${p}.kind`, `未知 readout kind "${r.kind}"(drive/joint/stroke/distance/angle/phase)`);
    }
    if (r.kind === "drive" && !driveIds.has(r.drive)) err(`${p}.drive`, `drive "${r.drive}" 不存在`);
    if (r.kind === "joint" && !bodyIds.has(r.body)) err(`${p}.body`, `body "${r.body}" 不存在`);
    if (r.kind === "stroke" && !actuatorIds.has(r.actuator)) {
      err(`${p}.actuator`, `actuator "${r.actuator}" 不存在(必須是 derived actuator 的 id)`);
    }
    if (r.kind === "distance") {
      checkAnchor(`${p}.from`, r.from);
      checkAnchor(`${p}.to`, r.to);
    }
    if (r.kind === "angle") {
      checkAnchor(`${p}.at`, r.at);
      if (!Array.isArray(r.arms) || r.arms.length !== 2) {
        err(`${p}.arms`, "angle 需要恰兩個 arm anchor(頂點+兩臂三點定夾角)");
      } else {
        r.arms.forEach((a, k) => checkAnchor(`${p}.arms[${k}]`, a));
      }
      const t = r.thresholds;
      if (!(Array.isArray(t) && t.length === 2 && isNum(t[0]) && isNum(t[1]) && t[0] < t[1])) {
        err(`${p}.thresholds`, "thresholds 必須是遞增的 [警戒, 良好] 兩數");
      }
    }
  });

  // ---- annotations ----
  doc.annotations.forEach((a, i) => {
    if (!a || typeof a !== "object") return;
    const p = `annotations[${i}]`;
    if (a.type !== "trace") return warn(`${p}.type`, `未知 annotation type "${a.type}",將忽略`);
    checkAnchor(`${p}.point`, a.point);
    if (!driveIds.has(a.drive)) err(`${p}.drive`, `drive "${a.drive}" 不存在`);
  });

  // ---- camera ----
  if (doc.camera) {
    if (doc.camera.target && !isVec3(doc.camera.target)) {
      err("camera.target", "target 必須是 [x,y,z]");
    }
  }

  // ---- 依賴圖(bodies ∪ derived)循環偵測 + topo 排序 ----
  let order = null;
  if (!errors.length) {
    const res = topoOrder(doc);
    if (res.cycle) {
      err("", `依賴循環:${res.cycle.join(" → ")}(parent/anchor 引用繞成一圈,拆開其中一個)`);
    } else {
      order = res.order;
    }
  }

  return { ok: errors.length === 0, errors, warnings, doc, order };
}

function checkParts(path, parts, err, warn) {
  if (!Array.isArray(parts)) return err(path, "parts 必須是陣列");
  parts.forEach((p, i) => {
    if (!p || typeof p !== "object") return err(`${path}[${i}]`, "必須是物件");
    const pp = `${path}[${i}]`;
    if (!PART_TYPES.has(p.type)) {
      warn(`${pp}.type`, `未知 part type "${p.type}",將忽略該件`);
      return;
    }
    if (!isVec3(p.at)) err(`${pp}.at`, "at 必須是 [x,y,z]");
    if (p.role && !ROLE_COLORS[p.role]) warn(`${pp}.role`, `未知 role "${p.role}"`);
    // 逐型別的正尺寸檢查
    const pos = (k, v) => {
      if (!(isNum(v) && v > 0)) err(`${pp}.${k}`, `${k} 必須 > 0`);
    };
    if (p.type === "box") {
      if (!isVec3(p.size) || !p.size.every((v) => v > 0)) err(`${pp}.size`, "size 必須是三個正數 [x,y,z]");
    } else if (p.type === "cylinder" || p.type === "hole") {
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis 必須是 "x"/"y"/"z"`);
      pos("r", p.r);
      pos(p.type === "hole" ? "depth" : "len", p.type === "hole" ? p.depth : p.len);
    } else if (p.type === "plate") {
      if (!Array.isArray(p.size) || p.size.length !== 2 || !p.size.every((v) => isNum(v) && v > 0)) {
        err(`${pp}.size`, "plate.size 必須是 [寬, 高] 兩正數");
      }
      pos("t", p.t);
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis(厚度方向)必須是 "x"/"y"/"z"`);
      if (p.r !== undefined && !(isNum(p.r) && p.r >= 0)) err(`${pp}.r`, "圓角 r 必須 ≥ 0");
    } else if (p.type === "gear") {
      pos("teeth", p.teeth);
      pos("module", p.module);
      pos("width", p.width);
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis 必須是 "x"/"y"/"z"`);
    } else if (p.type === "rack") {
      pos("module", p.module);
      pos("count", p.count);
      pos("width", p.width);
      if (!AXES.has(p.dir)) err(`${pp}.dir`, `dir(齒排方向)必須是 "x"/"y"/"z"`);
    } else if (p.type === "pin_clevis") {
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis 必須是 "x"/"y"/"z"`);
      if (p.r !== undefined) pos("r", p.r);
      if (p.span !== undefined) pos("span", p.span);
    } else if (p.type === "link_eye") {
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis 必須是 "x"/"y"/"z"`);
      if (p.r !== undefined) pos("r", p.r);
    } else if (p.type === "motor") {
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis(輸出軸向)必須是 "x"/"y"/"z"`);
      for (const k of ["r", "l", "shaftLen", "shaftR"]) {
        if (p[k] !== undefined) pos(k, p[k]);
      }
    } else if (p.type === "pulley") {
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis(輪軸向)必須是 "x"/"y"/"z"`);
      pos("r", p.r);
      pos("width", p.width);
    } else if (p.type === "belt") {
      if (!AXES.has(p.axis)) err(`${pp}.axis`, `axis(輪軸向)必須是 "x"/"y"/"z"`);
      pos("rA", p.rA);
      pos("rB", p.rB);
      pos("width", p.width);
      if (p.t !== undefined) pos("t", p.t);
      // belt 由 a/b 定位:at/rot 會在 a/b 之外再疊一次平移/旋轉,帶體與兩輪靜默錯位
      if ((isVec3(p.at) && (p.at[0] !== 0 || p.at[1] !== 0 || p.at[2] !== 0)) || p.rot !== undefined) {
        err(`${pp}.at`, "belt 由 a/b 兩輪心定位,不支援 at/rot(請移除,或併入 a/b 座標)");
      }
      if (!isVec3(p.a) || !isVec3(p.b)) {
        err(`${pp}.a`, "a/b 必須是 [x,y,z] 兩輪心(本 body 局部座標)");
      } else if (AXES.has(p.axis)) {
        // 平面性不依賴 rA/rB——別被半徑錯誤閘住(錯誤要一次全浮現,省 agent retry)
        const ai = { x: 0, y: 1, z: 2 }[p.axis];
        if (Math.abs(p.a[ai] - p.b[ai]) > 1e-6) {
          err(`${pp}.a`, `帶體是平面環:a/b 沿 axis(${p.axis})的座標必須相同`);
        }
        if (isNum(p.rA) && isNum(p.rB) && p.rA > 0 && p.rB > 0) {
          const [u, v] = [0, 1, 2].filter((i) => i !== ai);
          const d = Math.hypot(p.a[u] - p.b[u], p.a[v] - p.b[v]);
          // d>rA+rB 同時涵蓋外公切線存在(d>|rA−rB|)與輪面不相碰
          if (!(d > p.rA + p.rB)) {
            err(
              `${pp}.b`,
              `兩輪心距 ${d.toFixed(2)} 必須 > rA+rB=${(p.rA + p.rB).toFixed(2)}` +
                "(輪面相碰或內含,沒有可行的外公切線帶體;拉開輪心或縮小輪徑)",
            );
          }
        }
      }
    }
  });
}

// 節點 = bodies + derived;邊 = parent 引用 + anchor 引用。Kahn topo。
function topoOrder(doc) {
  const nodes = new Map(); // id → {kind, deps:Set}
  for (const b of doc.bodies) {
    if (!b?.id) continue;
    const deps = new Set();
    if (typeof b.parent === "object" && b.parent?.point) deps.add(b.parent.point);
    else if (b.parent !== "world") deps.add(b.parent);
    nodes.set(b.id, { kind: "body", deps });
  }
  const anchorDep = (deps, a) => {
    if (!a || typeof a !== "object") return;
    if (a.point) deps.add(a.point);
    else if (a.body && a.body !== "world") deps.add(a.body);
  };
  for (const e of doc.derived) {
    if (!e?.id) continue;
    const deps = new Set();
    if (e.type === "pin_on_line") anchorDep(deps, e.link?.to);
    else if (e.type === "actuator" || e.type === "coupler") {
      anchorDep(deps, e.from);
      anchorDep(deps, e.to);
    } else if (e.type === "attach") {
      for (const s of Object.values(e.states || {})) {
        if (s?.body && s.body !== "world") deps.add(s.body);
      }
    }
    nodes.set(e.id, { kind: "derived", deps });
  }
  const order = [];
  const inDeg = new Map();
  for (const [id, n] of nodes) {
    let deg = 0;
    for (const d of n.deps) if (nodes.has(d)) deg++;
    inDeg.set(id, deg);
  }
  const queue = [...nodes.keys()].filter((id) => inDeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    order.push({ kind: nodes.get(id).kind, id });
    for (const [oid, n] of nodes) {
      if (n.deps.has(id)) {
        const d = inDeg.get(oid) - 1;
        inDeg.set(oid, d);
        if (d === 0) queue.push(oid);
      }
    }
  }
  if (order.length !== nodes.size) {
    const cycle = [...nodes.keys()].filter((id) => inDeg.get(id) > 0);
    return { cycle };
  }
  return { order };
}
