// 草模求值核心(純函數、零依賴):
//   compileSketch(doc)                          → compiled(topo 序、程式段 fold、致動器配尺寸、軌跡預取樣)
//   evalProgram(compiled, tSec)                 → {driveValues, phaseName, attachStates, masterT}
//   evalPose(compiled, driveValues, attachStates) → frame(可 JSON 序列化;three 側只 fromArray 套矩陣)
// FSM 不是 runtime 狀態:attach 是時間的純函數(掃到 t 的最後一次宣告),scrub 決定性。

import {
  aimMatrixY,
  deg2rad,
  mApplyPoint,
  mEulerXYZ,
  mIdentity,
  mMul,
  mRotationAxis,
  mTranslation,
  smooth01,
  triangle01,
  vAdd,
  vDot,
  vNorm,
  vScale,
  vSub,
} from "./sketchMath.js";
import { validateSketch } from "./sketchSchema.js";

// ---------------------------------------------------------------------------
// compileSketch
// ---------------------------------------------------------------------------

export function compileSketch(raw) {
  const res = validateSketch(raw);
  if (!res.ok) {
    const e = new Error(
      "scene 驗證失敗:" + res.errors.map((x) => `${x.path}: ${x.message}`).join("; "),
    );
    e.errors = res.errors;
    throw e;
  }
  const doc = res.doc;
  const compiled = {
    doc,
    order: res.order,
    warnings: res.warnings,
    bodiesById: Object.fromEntries(doc.bodies.map((b) => [b.id, b])),
    derivedById: Object.fromEntries(doc.derived.map((e) => [e.id, e])),
    drivesById: Object.fromEntries(doc.drives.map((d) => [d.id, d])),
    driveIds: doc.drives.map((d) => d.id),
    homeDrives: Object.fromEntries(doc.drives.map((d) => [d.id, d.home])),
    attachInitials: Object.fromEntries(
      doc.derived.filter((e) => e.type === "attach").map((e) => [e.id, e.initial]),
    ),
    program: compileProgram(doc),
    actuatorDims: {},
    traces: [],
    dofs: doc.drives.map((d) => ({
      id: d.id, label: d.label, unit: d.unit, min: d.min, max: d.max, home: d.home,
    })),
  };

  // ---- 致動器配尺寸:掃一個週期取 len 範圍(此時 dims 未定,rodLen 不使用)----
  const actuators = doc.derived.filter((e) => e.type === "actuator");
  const lenSamples = Object.fromEntries(actuators.map((e) => [e.id, []]));
  if (actuators.length) {
    const windowS = compiled.program.mode === "timeline"
      ? compiled.program.cycleS
      : Math.max(...compiled.program.pingpong.map((p) => p.period));
    for (let i = 0; i <= 32; i++) {
      const p = evalProgram(compiled, (windowS * i) / 32);
      const frame = evalPose(compiled, p.driveValues, p.attachStates);
      for (const e of actuators) lenSamples[e.id].push(frame.derivedPose[e.id].len);
    }
  }
  for (const e of actuators) {
    const lens = lenSamples[e.id];
    const lenMin = Math.min(...lens);
    const lenMax = Math.max(...lens);
    const look = e.look || {};
    const bore = look.bore > 0 ? look.bore : 25;
    let barrelLen = look.barrelLen;
    if (!(barrelLen > 0)) {
      // 桿件永遠要有正伸出量:上限 lenMin−4;下限涵蓋行程(活塞在缸內走得完)
      const stroke = lenMax - lenMin;
      const cap = lenMin - 4;
      barrelLen = Math.max(stroke + 12, 0.55 * lenMax);
      barrelLen = cap >= 6 ? Math.min(barrelLen, cap) : Math.max(2, lenMin * 0.5);
    }
    compiled.actuatorDims[e.id] = {
      bore,
      odR: (1.18 * bore) / 2,
      rodR: look.rodR > 0 ? look.rodR : bore * 0.2,
      barrelLen,
    };
  }

  // ---- home 姿態(stroke 讀數基準)----
  const homeFrame = evalPose(compiled, compiled.homeDrives, compiled.attachInitials);
  for (const e of actuators) {
    compiled.actuatorDims[e.id].homeLen = homeFrame.derivedPose[e.id].len;
  }

  // ---- 軌跡註解預取樣(靜態虛線;掃單一 drive、其餘停 home)----
  for (const a of doc.annotations) {
    if (a.type !== "trace") continue;
    const d = compiled.drivesById[a.drive];
    const pts = [];
    for (let i = 0; i <= a.samples; i++) {
      const v = d.min + ((d.max - d.min) * i) / a.samples;
      const frame = evalPose(
        compiled,
        { ...compiled.homeDrives, [d.id]: v },
        compiled.attachInitials,
      );
      pts.push(anchorWorld(frame, a.point));
    }
    compiled.traces.push({ points: pts });
  }

  return compiled;
}

// timeline 段首值 fold:每段的 startVals 在 compile 一次算好,scrub 任意 t 決定性。
function compileProgram(doc) {
  if (doc.program.mode === "timeline") {
    const cur = Object.fromEntries(doc.drives.map((d) => [d.id, d.home]));
    let prev = 0;
    const segments = doc.program.phases.map((ph) => {
      const seg = {
        start: prev,
        until: ph.until,
        name: ph.name,
        drives: ph.drives,
        attach: ph.attach,
        startVals: { ...cur },
      };
      for (const [k, v] of Object.entries(ph.drives)) {
        cur[k] = typeof v === "number" ? v : v.to;
      }
      prev = ph.until;
      return seg;
    });
    return { mode: "timeline", cycleS: doc.program.cycleS, segments };
  }
  // pingpong:各 drive 三角波;period = 來回一趟;index 錯相讓雙軸可辨
  return {
    mode: "pingpong",
    pingpong: doc.drives.map((d, i) => ({
      id: d.id,
      min: d.min,
      max: d.max,
      period: Math.max(1e-6, (2 * (d.max - d.min)) / d.speed),
      phase: i * 0.17,
    })),
  };
}

// ---------------------------------------------------------------------------
// evalProgram:tSec(絕對秒)→ 驅動值 + 相位名 + attach 狀態
// ---------------------------------------------------------------------------

export function evalProgram(compiled, tSec) {
  const pr = compiled.program;
  if (pr.mode === "pingpong") {
    const driveValues = {};
    for (const p of pr.pingpong) {
      const u = triangle01(tSec / p.period + p.phase);
      driveValues[p.id] = p.min + u * (p.max - p.min);
    }
    return {
      driveValues,
      phaseName: null,
      attachStates: { ...compiled.attachInitials },
      masterT: null,
    };
  }
  const masterT = (((tSec / pr.cycleS) % 1) + 1) % 1;
  let seg = pr.segments[pr.segments.length - 1];
  for (const s of pr.segments) {
    if (masterT < s.until) {
      seg = s;
      break;
    }
  }
  const driveValues = {};
  for (const id of compiled.driveIds) {
    const entry = seg.drives[id];
    if (entry === undefined) {
      driveValues[id] = seg.startVals[id];
    } else if (typeof entry === "number") {
      driveValues[id] = entry;
    } else {
      const s = (masterT - seg.start) / Math.max(1e-9, seg.until - seg.start);
      const u = entry.ease === "linear" ? Math.max(0, Math.min(1, s)) : smooth01(s);
      driveValues[id] = seg.startVals[id] + (entry.to - seg.startVals[id]) * u;
    }
  }
  // attach = 從 t=0 掃到當前段(含)的最後一次宣告;t wrap 回 0 自然回 initial
  const attachStates = { ...compiled.attachInitials };
  for (const s of pr.segments) {
    if (s.start > masterT) break;
    for (const [k, v] of Object.entries(s.attach)) attachStates[k] = v;
  }
  return { driveValues, phaseName: seg.name || null, attachStates, masterT };
}

// ---------------------------------------------------------------------------
// evalPose:驅動值 + attach 狀態 → 世界姿態 frame(依 topo 序一遍走完)
// ---------------------------------------------------------------------------

export function evalPose(compiled, driveValues, attachStates) {
  const bodyWorld = {};
  const jointValues = {};
  const points = {};
  const derivedPose = {};
  const attach = {};

  const resolveAnchor = (a) => {
    if (a.point !== undefined) return points[a.point];
    if (a.body === "world") return [...a.at];
    return mApplyPoint(bodyWorld[a.body], a.at);
  };

  for (const { kind, id } of compiled.order) {
    if (kind === "body") {
      const b = compiled.bodiesById[id];
      let parentMat = null;
      if (typeof b.parent === "object" && b.parent?.point) {
        parentMat = mTranslation(...points[b.parent.point]);
      } else if (b.parent !== "world") {
        parentMat = bodyWorld[b.parent];
      }
      const j = b.joint;
      let J = null;
      if (j.type !== "fixed") {
        const val = (driveValues[j.drive] ?? 0) * j.scale + j.offset;
        jointValues[id] = val;
        const axis = vNorm(j.axis);
        J = j.type === "revolute"
          ? mRotationAxis(axis, deg2rad(val))
          : mTranslation(...vScale(axis, val));
      }
      let world = mTranslation(...b.origin);
      if (J) world = mMul(world, J);
      if (parentMat) world = mMul(parentMat, world);
      bodyWorld[id] = world;
      continue;
    }
    const e = compiled.derivedById[id];
    if (e.type === "pin_on_line") {
      // 圓(心 A、半徑 len)∩ 直線:|o + t·d − A| = len 的閉式解,branch 選根
      const A = resolveAnchor(e.link.to);
      const dn = vNorm(e.line.dir);
      const oa = vSub(e.line.origin, A);
      const b_ = vDot(dn, oa);
      const c_ = vDot(oa, oa) - e.link.len * e.link.len;
      const disc = Math.max(0, b_ * b_ - c_); // 負值=構型脫離,鉗到切點(仿 ref 防呆)
      const t = -b_ + (e.branch === "+" ? 1 : -1) * Math.sqrt(disc);
      const P = vAdd(e.line.origin, vScale(dn, t));
      points[id] = P;
      derivedPose[id] = { point: P, degenerate: b_ * b_ - c_ < 0 };
    } else if (e.type === "actuator") {
      const F = resolveAnchor(e.from);
      const T = resolveAnchor(e.to);
      const { mat, len } = aimMatrixY(F, T);
      const dims = compiled.actuatorDims[id];
      derivedPose[id] = { mat, len, rodLen: len - (dims ? dims.barrelLen : 0) };
    } else if (e.type === "coupler") {
      const F = resolveAnchor(e.from);
      const T = resolveAnchor(e.to);
      const { mat, len } = aimMatrixY(F, T);
      derivedPose[id] = { mat, len };
    } else if (e.type === "attach") {
      const stName = attachStates?.[id] ?? e.initial;
      const st = e.states[stName];
      let mat = mMul(mTranslation(...st.at), mEulerXYZ(st.rot));
      if (st.body !== "world") mat = mMul(bodyWorld[st.body], mat);
      derivedPose[id] = { mat, state: stName };
      attach[id] = stName;
    }
  }

  const readouts = compiled.doc.readouts.map((r) => {
    const out = { id: r.id, kind: r.kind, label: r.label, unit: r.unit };
    if (r.kind === "drive") {
      out.value = (driveValues[r.drive] ?? 0) * r.factor;
      out.unit = r.unit || compiled.drivesById[r.drive].unit;
    } else if (r.kind === "joint") {
      out.value = jointValues[r.body] ?? 0;
    } else if (r.kind === "stroke") {
      const pose = derivedPose[r.actuator];
      const base = compiled.actuatorDims[r.actuator]?.homeLen;
      out.value = pose.len - (base ?? pose.len);
    } else if (r.kind === "distance") {
      const F = resolveAnchor(r.from);
      const T = resolveAnchor(r.to);
      out.value = Math.hypot(...vSub(T, F));
    } else if (r.kind === "angle") {
      const at = resolveAnchor(r.at);
      const a0 = vNorm(vSub(resolveAnchor(r.arms[0]), at));
      const a1 = vNorm(vSub(resolveAnchor(r.arms[1]), at));
      let deg = (Math.acos(Math.max(-1, Math.min(1, vDot(a0, a1)))) * 180) / Math.PI;
      if (r.fold && deg > 90) deg = 180 - deg;
      out.value = deg;
      out.status = deg < r.thresholds[0] ? "bad" : deg < r.thresholds[1] ? "warn" : "ok";
      out.unit = r.unit || "°";
    } else if (r.kind === "phase") {
      out.value = null;
    }
    if (out.value !== null && out.value !== undefined) {
      out.text = out.value.toFixed(r.decimals ?? 1);
    }
    return out;
  });

  return { drives: { ...driveValues }, attach, bodyWorld, jointValues, points, derivedPose, readouts };
}

// anchor → 世界座標(給軌跡/外部 UI 用;frame 為 evalPose 輸出)
export function anchorWorld(frame, a) {
  if (a.point !== undefined) return frame.points[a.point];
  if (a.body === "world") return [...a.at];
  return mApplyPoint(frame.bodyWorld[a.body], a.at);
}

export { mIdentity }; // re-export 供播放器組 fallback 矩陣,不用另 import math 層
