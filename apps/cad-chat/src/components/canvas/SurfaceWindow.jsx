import React, { useEffect, useState } from "react";

import { CONTINUITY, CURVE_KINDS, MAX_BEZIER_POLES, MAX_NURBS_DEGREE, PLANES, SURFACE_OPS, SURFACE_ROLES, THICKEN_DIRS } from "@/lib/surface/surfaceSchema";
import { editablePoints } from "@/lib/surface/nurbsEval";

// 曲面草稿工作窗(產品設計;停靠在 3D 視圖左側,右側留給 3D 拖曳把手):
//   特徵樹(全域 → 曲線 → 曲面 → 操作)+ 選取項的數值編輯 + 即時驗證 + 復原/重做/重設/捨棄 +
//   「確認生成」。資料與動作全來自 useDraftEditor(editor prop);這裡零 fetch、零 three。
// DOM 契約(煙測):.surface-window / .surfwin-row[data-kind=curve|surface|op][data-id][data-sel]
//   / .surfwin-num input[data-key] / .surfwin-err / .surfwin-build[data-disabled] / .surfwin-undo
//   / .surfwin-redo / .surfwin-reset / .surfwin-discard[data-arm] / .surfwin-notice / .surfwin-add[data-kind]
const KIND_HINT = {
  spline: "過點插值(拖點即改形;3D 預覽為近似,生成後以實際為準)",
  nurbs: "控制點 + 權重(精確預覽)",
  bezier: "控制點(≤ 8;精確預覽)",
  arc3: "三點圓弧",
  line: "兩點直線",
  circle: "中心/法向/半徑(數值編輯)",
};
const OP_FIELDS = {
  loft: ["sections", "ruled", "closed", "capped"],
  patch: ["boundary", "continuity"],
  revolve: ["curve", "axis", "angle", "capped"],
  extrude: ["curve", "dir", "length", "capped"],
  ruled: ["curves"],
  sweep: ["profile", "rail", "guide", "capped"],
  gordon: ["profiles", "guides"],
};

// 數值欄:失焦/Enter 提交。**只有使用者真的打過字(edited)才提交**——聚焦中若外部值被
// 3D 拖曳/復原改掉,未編輯的欄位要跟著外部值走,否則失焦時會把舊值蓋回去(把拖曳吃掉)。
function Num({ value, onCommit, step = 1, disabled, dataKey, min, max }) {
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!focused || !edited) setText(fmt(value));
  }, [value, focused, edited]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== value && (min == null || v >= min) && (max == null || v <= max)) onCommit(v);
    else setText(fmt(value));
  };
  return (
    <span className="surfwin-num">
      <input
        type="number"
        step={step}
        data-key={dataKey}
        value={text}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setText(e.target.value);
          setEdited(true);
        }}
        onBlur={() => {
          setFocused(false);
          if (edited) commit();
          setEdited(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(fmt(value));
            setEdited(false);
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}
function fmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  return String(Math.round(Number(v) * 1000) / 1000);
}

// id 清單文字欄(「c1, c2 c3」→ ["c1","c2","c3"];失焦/Enter 提交)
function IdList({ value, onCommit, disabled, dataKey, single = false }) {
  const toText = (v) => (Array.isArray(v) ? v.join(", ") : v || "");
  const [text, setText] = useState(toText(value));
  const [focused, setFocused] = useState(false);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!focused || !edited) setText(toText(value));
  }, [value, focused, edited]);
  const commit = () => {
    const ids = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const next = single ? ids[0] || null : ids;
    if (JSON.stringify(next) !== JSON.stringify(value)) onCommit(next);
  };
  return (
    <input
      className="surfwin-ids"
      type="text"
      data-key={dataKey}
      value={text}
      disabled={disabled}
      placeholder={single ? "曲線 id" : "曲線 id,逗號分隔"}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        setText(e.target.value);
        setEdited(true);
      }}
      onBlur={() => {
        setFocused(false);
        if (edited) commit();
        setEdited(false);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

function Vec3({ value, onCommit, disabled, dataKey, step = 1 }) {
  const v = Array.isArray(value) ? value : [0, 0, 0];
  return (
    <span className="surfwin-vec">
      {["x", "y", "z"].map((ax, i) => (
        <Num key={ax} dataKey={`${dataKey}.${ax}`} value={v[i]} step={step} disabled={disabled} onCommit={(n) => onCommit(v.map((x, k) => (k === i ? n : x)))} />
      ))}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <label className="surfwin-field">
      <span className="surfwin-label">{label}</span>
      {children}
    </label>
  );
}

function nextId(prefix, existing) {
  let i = existing.length + 1;
  while (existing.includes(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
}

function defaultCurve(id, kind) {
  switch (kind) {
    case "line": return { id, kind, points: [[0, 0, 0], [40, 0, 0]] };
    case "arc3": return { id, kind, points: [[-20, 0, 0], [0, 20, 0], [20, 0, 0]] };
    case "circle": return { id, kind, center: [0, 0, 0], normal: [0, 0, 1], r: 20 };
    case "bezier": return { id, kind, poles: [[0, 0, 0], [15, 20, 0], [30, 20, 0], [45, 0, 0]] };
    case "nurbs": return { id, kind, degree: 3, poles: [[0, 0, 0], [15, 20, 0], [30, 20, 0], [45, 0, 0]], weights: [1, 1, 1, 1] };
    default: return { id, kind: "spline", points: [[0, 0, 0], [20, 15, 0], [40, 0, 0]], closed: false };
  }
}

function convertCurve(c, kind) {
  if (c.kind === kind) return c;
  const pts = editablePoints(c);
  const base = { id: c.id, kind };
  if (c.plane) base.plane = c.plane;
  if (kind === "circle") return { ...base, center: pts[0] || [0, 0, 0], normal: [0, 0, 1], r: 20 };
  const src = pts.length ? pts : editablePoints(defaultCurve(c.id, kind));
  if (kind === "bezier") return { ...base, poles: src.slice(0, MAX_BEZIER_POLES) };
  if (kind === "nurbs") return { ...base, degree: Math.min(3, Math.max(1, src.length - 1)), poles: src, weights: src.map(() => 1) };
  if (kind === "line") return { ...base, points: [src[0], src[src.length - 1]] };
  if (kind === "arc3") return { ...base, points: src.length >= 3 ? [src[0], src[Math.floor(src.length / 2)], src[src.length - 1]] : editablePoints(defaultCurve(c.id, kind)) };
  return { ...base, points: src, closed: !!c.closed };
}

function defaultSurface(id, op, curveIds) {
  const c0 = curveIds[0] || "c1";
  const c1 = curveIds[1] || c0;
  switch (op) {
    case "revolve": return { id, op, role: "body", curve: c0, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, capped: false };
    case "extrude": return { id, op, role: "body", curve: c0, dir: [0, 0, 1], length: 30, capped: false };
    case "ruled": return { id, op, role: "body", curves: [c0, c1] };
    case "sweep": return { id, op, role: "body", profile: c0, rail: c1, guide: null, capped: false };
    case "patch": return { id, op, role: "body", boundary: curveIds.slice(0, 4), continuity: {} };
    case "gordon": return { id, op, role: "body", profiles: curveIds.slice(0, 2), guides: curveIds.slice(2, 4) };
    default: return { id, op: "loft", role: "body", sections: curveIds.slice(0, 3), ruled: false, closed: false, capped: false };
  }
}

export default function SurfaceWindow({ editor, disabled, onClose }) {
  const d = editor.present;
  const [sel, setSel] = useState({ kind: "curve", id: editor.selected });
  const [armDiscard, setArmDiscard] = useState(false);
  const [addKind, setAddKind] = useState("spline");
  const [addOp, setAddOp] = useState("loft");
  useEffect(() => {
    if (sel.kind === "curve" && sel.id !== editor.selected) setSel({ kind: "curve", id: editor.selected });
  }, [editor.selected]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const curveIds = (d.curves || []).map((c) => c.id);
  const pick = (kind, id) => {
    setSel({ kind, id });
    editor.select(kind === "curve" ? id : null);
    setArmDiscard(false);
  };
  const setCurve = (id, fn) => editor.update((cur) => ({ ...cur, curves: cur.curves.map((c) => (c.id === id ? fn(c) : c)) }));
  const setSurface = (id, fn) => editor.update((cur) => ({ ...cur, surfaces: cur.surfaces.map((s) => (s.id === id ? fn(s) : s)) }));
  const setOp = (op, fn) => editor.update((cur) => ({ ...cur, ops: cur.ops.map((o) => (o.op === op ? fn(o) : o)) }));
  const setGlobal = (patch) => editor.update((cur) => ({ ...cur, ...patch }));
  const setAnalysis = (patch) => editor.update((cur) => ({ ...cur, analysis: { ...(cur.analysis || {}), ...patch } }));
  const removeCurve = (id) => {
    editor.update((cur) => ({ ...cur, curves: cur.curves.filter((c) => c.id !== id) }));
    if (sel.id === id) pick("curve", null);
  };
  const removeSurface = (id) => {
    editor.update((cur) => ({ ...cur, surfaces: cur.surfaces.filter((s) => s.id !== id) }));
    if (sel.id === id) setSel({ kind: "surface", id: null });
  };
  const removeOp = (op) => editor.update((cur) => ({ ...cur, ops: cur.ops.filter((o) => o.op !== op) }));
  const addCurve = () => {
    const id = nextId("c", curveIds);
    editor.update((cur) => ({ ...cur, curves: [...cur.curves, defaultCurve(id, addKind)] }));
    pick("curve", id);
  };
  const addSurface = () => {
    const id = nextId("s", (d.surfaces || []).map((s) => s.id));
    editor.update((cur) => ({ ...cur, surfaces: [...cur.surfaces, defaultSurface(id, addOp, curveIds)] }));
    pick("surface", id);
  };
  const addOpRow = (op) => {
    if ((d.ops || []).some((o) => o.op === op)) return;
    const row = op === "sew" ? { op, tol: 0.01 } : op === "thicken" ? { op, t: 2, dir: "inward" } : { op, r: 1.5 };
    editor.update((cur) => ({ ...cur, ops: [...cur.ops, row] }));
  };
  const selCurve = sel.kind === "curve" ? d.curves.find((c) => c.id === sel.id) : null;
  const selSurface = sel.kind === "surface" ? (d.surfaces || []).find((s) => s.id === sel.id) : null;
  const hasOp = (op) => (d.ops || []).some((o) => o.op === op);
  const allErrors = [...editor.errors, ...(editor.serverErrors || [])];
  const buildBlocked = disabled || editor.building || editor.saving || editor.errors.length > 0 || !!editor.serverErrors;

  return (
    <div className="surface-window" data-building={editor.building || undefined}>
      <div className="sweepwin-head">
        <span className="sweepwin-title">✎ 曲面草稿 · {editor.name}{editor.revision != null ? ` · r${editor.revision}` : ""}</span>
        <span className="surfwin-state">
          {editor.building ? "生成中…" : editor.saving ? "保存中…" : editor.dirty ? "未保存" : "已保存"}
        </span>
        <a className="sweepwin-close" onClick={onClose}>✕</a>
      </div>
      {editor.notice && (
        <div className="surfwin-notice" onClick={editor.clearNotice}>{editor.notice}</div>
      )}
      <div className="surfwin-body">
        {/* ── 全域 ── */}
        <div className="surfwin-sec">
          <span className="surfwin-eyebrow">GLOBAL · 全域</span>
          <div className="surfwin-grid">
            <Field label="結果">
              <select value={d.result || "solid"} disabled={disabled} data-key="result" onChange={(e) => setGlobal({ result: e.target.value })}>
                <option value="solid">實體</option>
                <option value="shell">殼</option>
              </select>
            </Field>
            <Field label="對稱面">
              <select value={d.symmetry || ""} disabled={disabled} data-key="symmetry" onChange={(e) => setGlobal({ symmetry: e.target.value || null })}>
                <option value="">無(全模)</option>
                {PLANES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="連續性目標">
              <select value={d.analysis?.minContinuity || "G1"} disabled={disabled} data-key="minContinuity" onChange={(e) => setAnalysis({ minContinuity: e.target.value })}>
                {CONTINUITY.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="允許摺線">
              <Num dataKey="creases" value={d.analysis?.creases ?? 0} min={0} disabled={disabled} onCommit={(v) => setAnalysis({ creases: Math.max(0, Math.round(v)) })} />
            </Field>
            <Field label="多殼融合">
              <input type="checkbox" data-key="fuse" checked={d.fuse !== false} disabled={disabled} onChange={(e) => setGlobal({ fuse: e.target.checked })} />
            </Field>
          </div>
        </div>

        {/* ── 曲線 ── */}
        <div className="surfwin-sec">
          <div className="surfwin-sechead">
            <span className="surfwin-eyebrow">CURVES · 曲線({d.curves.length})</span>
            <span className="surfwin-addrow">
              <select value={addKind} disabled={disabled} onChange={(e) => setAddKind(e.target.value)}>
                {CURVE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <a className="surfwin-add" data-kind="curve" data-disabled={disabled || undefined} onClick={() => !disabled && addCurve()}>+ 新增</a>
            </span>
          </div>
          <div className="surfwin-rows">
            {d.curves.map((c) => (
              <a key={c.id} className="surfwin-row" data-kind="curve" data-id={c.id} data-sel={sel.kind === "curve" && sel.id === c.id} onClick={() => pick("curve", c.id)}>
                <span className="surfwin-dot" />
                <span className="surfwin-rowid">{c.id}</span>
                <span className="surfwin-rowmeta">{c.kind} · {c.kind === "circle" ? `r${fmt(c.r)}` : `${editablePoints(c).length} 點`}{c.plane ? ` · ${c.plane}` : ""}</span>
              </a>
            ))}
            {!d.curves.length && <span className="surfwin-empty">還沒有曲線——用對話描述,或按「+ 新增」。</span>}
          </div>
          {selCurve && (
            <div className="surfwin-edit" data-edit="curve">
              <div className="surfwin-grid">
                <Field label="型式">
                  <select value={selCurve.kind} disabled={disabled} data-key="kind" onChange={(e) => setCurve(selCurve.id, (c) => convertCurve(c, e.target.value))}>
                    {CURVE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
                <Field label="工作平面">
                  <select value={selCurve.plane || ""} disabled={disabled} data-key="plane" onChange={(e) => setCurve(selCurve.id, (c) => {
                    const n = { ...c };
                    if (e.target.value) n.plane = e.target.value;
                    else delete n.plane;
                    return n;
                  })}>
                    <option value="">依視角</option>
                    {PLANES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
                {selCurve.kind === "spline" && (
                  <Field label="閉合">
                    <input type="checkbox" data-key="closed" checked={!!selCurve.closed} disabled={disabled} onChange={(e) => setCurve(selCurve.id, (c) => ({ ...c, closed: e.target.checked }))} />
                  </Field>
                )}
                {selCurve.kind === "nurbs" && (
                  <Field label="次數">
                    <Num dataKey="degree" value={selCurve.degree ?? 3} min={1} max={MAX_NURBS_DEGREE} disabled={disabled} onCommit={(v) => setCurve(selCurve.id, (c) => ({ ...c, degree: Math.round(v) }))} />
                  </Field>
                )}
              </div>
              <span className="surfwin-hint">{KIND_HINT[selCurve.kind]}</span>
              {selCurve.kind === "circle" ? (
                <div className="surfwin-grid">
                  <Field label="中心"><Vec3 dataKey="center" value={selCurve.center} disabled={disabled} onCommit={(v) => setCurve(selCurve.id, (c) => ({ ...c, center: v }))} /></Field>
                  <Field label="法向"><Vec3 dataKey="normal" value={selCurve.normal} step={0.1} disabled={disabled} onCommit={(v) => setCurve(selCurve.id, (c) => ({ ...c, normal: v }))} /></Field>
                  <Field label="半徑"><Num dataKey="r" value={selCurve.r} min={0.001} disabled={disabled} onCommit={(v) => setCurve(selCurve.id, (c) => ({ ...c, r: v }))} /></Field>
                </div>
              ) : (
                <table className="surfwin-pts">
                  <thead>
                    <tr><th>#</th><th>x</th><th>y</th><th>z</th>{selCurve.kind === "nurbs" && <th>w</th>}<th /></tr>
                  </thead>
                  <tbody>
                    {editablePoints(selCurve).map((p, i) => (
                      <tr key={i} data-index={i}>
                        <td className="surfwin-ptidx">{i + 1}</td>
                        {[0, 1, 2].map((ax) => (
                          <td key={ax}>
                            <Num dataKey={`p${i}.${"xyz"[ax]}`} value={p[ax]} disabled={disabled} onCommit={(v) => editor.movePoint(selCurve.id, i, p.map((x, k) => (k === ax ? v : x)))} />
                          </td>
                        ))}
                        {selCurve.kind === "nurbs" && (
                          <td>
                            <Num dataKey={`w${i}`} value={selCurve.weights?.[i] ?? 1} step={0.1} min={0.001} disabled={disabled} onCommit={(v) => setCurve(selCurve.id, (c) => ({ ...c, weights: c.poles.map((_, k) => (k === i ? v : c.weights?.[k] ?? 1)) }))} />
                          </td>
                        )}
                        <td>
                          {!["line", "arc3"].includes(selCurve.kind) && editablePoints(selCurve).length > 2 && (
                            <a className="surfwin-ptdel" title="刪除此點" onClick={() => !disabled && setCurve(selCurve.id, (c) => {
                              const key = c.kind === "bezier" || c.kind === "nurbs" ? "poles" : "points";
                              const n = { ...c, [key]: c[key].filter((_, k) => k !== i) };
                              if (c.kind === "nurbs" && Array.isArray(c.weights)) n.weights = c.weights.filter((_, k) => k !== i);
                              return n;
                            })}>−</a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="surfwin-actions">
                {!["line", "arc3", "circle"].includes(selCurve.kind) && (
                  <a className="surfwin-mini" data-act="addpoint" onClick={() => !disabled && setCurve(selCurve.id, (c) => {
                    const key = c.kind === "bezier" || c.kind === "nurbs" ? "poles" : "points";
                    const arr = c[key];
                    if (c.kind === "bezier" && arr.length >= MAX_BEZIER_POLES) return c;
                    const a = arr[arr.length - 2] || arr[arr.length - 1];
                    const b = arr[arr.length - 1];
                    const np = b.map((x, k) => x + (x - a[k]) * 0.5);
                    const n = { ...c, [key]: [...arr, np] };
                    if (c.kind === "nurbs") n.weights = [...(c.weights || arr.map(() => 1)), 1];
                    return n;
                  })}>+ 點</a>
                )}
                <a className="surfwin-mini surfwin-del" data-act="delcurve" onClick={() => !disabled && removeCurve(selCurve.id)}>刪除曲線</a>
              </div>
            </div>
          )}
        </div>

        {/* ── 曲面 ── */}
        <div className="surfwin-sec">
          <div className="surfwin-sechead">
            <span className="surfwin-eyebrow">SURFACES · 曲面({(d.surfaces || []).length})</span>
            <span className="surfwin-addrow">
              <select value={addOp} disabled={disabled} onChange={(e) => setAddOp(e.target.value)}>
                {SURFACE_OPS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <a className="surfwin-add" data-kind="surface" data-disabled={disabled || undefined} onClick={() => !disabled && addSurface()}>+ 新增</a>
            </span>
          </div>
          <div className="surfwin-rows">
            {(d.surfaces || []).map((s) => (
              <a key={s.id} className="surfwin-row" data-kind="surface" data-id={s.id} data-sel={sel.kind === "surface" && sel.id === s.id} onClick={() => pick("surface", s.id)}>
                <span className="surfwin-dot" data-role={s.role || "body"} />
                <span className="surfwin-rowid">{s.id}</span>
                <span className="surfwin-rowmeta">{s.op}{s.role && s.role !== "body" ? ` · ${s.role === "cut" ? "切除" : "加料"}` : ""}</span>
              </a>
            ))}
          </div>
          {selSurface && (
            <div className="surfwin-edit" data-edit="surface">
              <div className="surfwin-grid">
                <Field label="操作">
                  <select value={selSurface.op} disabled={disabled} data-key="op" onChange={(e) => setSurface(selSurface.id, (s) => ({ ...defaultSurface(s.id, e.target.value, curveIds), role: s.role || "body" }))}>
                    {SURFACE_OPS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
                <Field label="角色">
                  <select value={selSurface.role || "body"} disabled={disabled} data-key="role" onChange={(e) => setSurface(selSurface.id, (s) => ({ ...s, role: e.target.value }))}>
                    {SURFACE_ROLES.map((r) => <option key={r} value={r}>{r === "body" ? "本體" : r === "cut" ? "切除" : "加料"}</option>)}
                  </select>
                </Field>
              </div>
              <div className="surfwin-grid">
                {(OP_FIELDS[selSurface.op] || []).map((f) => {
                  const v = selSurface[f];
                  const set = (val) => setSurface(selSurface.id, (s) => ({ ...s, [f]: val }));
                  if (["sections", "boundary", "curves", "profiles", "guides"].includes(f)) {
                    return <Field key={f} label={f}><IdList dataKey={f} value={v || []} disabled={disabled} onCommit={set} /></Field>;
                  }
                  if (["curve", "profile", "rail", "guide"].includes(f)) {
                    return <Field key={f} label={f}><IdList dataKey={f} value={v || ""} single disabled={disabled} onCommit={set} /></Field>;
                  }
                  if (["ruled", "closed", "capped"].includes(f)) {
                    return <Field key={f} label={f}><input type="checkbox" data-key={f} checked={!!v} disabled={disabled} onChange={(e) => set(e.target.checked)} /></Field>;
                  }
                  if (f === "angle") return <Field key={f} label="角度"><Num dataKey="angle" value={v ?? 360} min={0.1} max={360} disabled={disabled} onCommit={set} /></Field>;
                  if (f === "length") return <Field key={f} label="長度"><Num dataKey="length" value={v ?? 10} min={0.001} disabled={disabled} onCommit={set} /></Field>;
                  if (f === "dir") return <Field key={f} label="方向"><Vec3 dataKey="dir" value={v} step={0.1} disabled={disabled} onCommit={set} /></Field>;
                  if (f === "axis") {
                    const ax = v || { origin: [0, 0, 0], dir: [0, 0, 1] };
                    return (
                      <React.Fragment key={f}>
                        <Field label="軸原點"><Vec3 dataKey="axis.origin" value={ax.origin} disabled={disabled} onCommit={(o) => set({ ...ax, origin: o })} /></Field>
                        <Field label="軸方向"><Vec3 dataKey="axis.dir" value={ax.dir} step={0.1} disabled={disabled} onCommit={(o) => set({ ...ax, dir: o })} /></Field>
                      </React.Fragment>
                    );
                  }
                  if (f === "continuity") {
                    const cont = v || {};
                    return (
                      <div key={f} className="surfwin-cont">
                        <span className="surfwin-label">邊界連續性(對鄰面)</span>
                        {(selSurface.boundary || []).map((cid) => (
                          <span key={cid} className="surfwin-controw">
                            <span className="surfwin-contid">{cid}</span>
                            <IdList dataKey={`cont.${cid}.face`} value={cont[cid]?.face || ""} single disabled={disabled} onCommit={(face) => set(face ? { ...cont, [cid]: { face, level: cont[cid]?.level || "G1" } } : Object.fromEntries(Object.entries(cont).filter(([k]) => k !== cid)))} />
                            <select value={cont[cid]?.level || "G1"} disabled={disabled || !cont[cid]} data-key={`cont.${cid}.level`} onChange={(e) => set({ ...cont, [cid]: { ...cont[cid], level: e.target.value } })}>
                              {CONTINUITY.map((g) => <option key={g} value={g}>{g}</option>)}
                            </select>
                          </span>
                        ))}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
              <div className="surfwin-actions">
                <a className="surfwin-mini surfwin-del" data-act="delsurface" onClick={() => !disabled && removeSurface(selSurface.id)}>刪除曲面</a>
              </div>
            </div>
          )}
        </div>

        {/* ── 操作 ── */}
        <div className="surfwin-sec">
          <div className="surfwin-sechead">
            <span className="surfwin-eyebrow">OPS · 操作</span>
            <span className="surfwin-addrow">
              {["sew", "thicken", "fillet"].filter((o) => !hasOp(o)).map((o) => (
                <a key={o} className="surfwin-add" data-kind={`op-${o}`} data-disabled={disabled || undefined} onClick={() => !disabled && addOpRow(o)}>+ {o}</a>
              ))}
            </span>
          </div>
          <div className="surfwin-rows">
            {(d.ops || []).map((o) => (
              <div key={o.op} className="surfwin-row surfwin-oprow" data-kind="op" data-id={o.op}>
                <span className="surfwin-rowid">{o.op}</span>
                {o.op === "sew" && <Field label="縫合公差"><Num dataKey="tol" value={o.tol ?? 0.01} step={0.01} min={0.0001} disabled={disabled} onCommit={(v) => setOp("sew", (x) => ({ ...x, tol: v }))} /></Field>}
                {o.op === "thicken" && (
                  <>
                    <Field label="厚度"><Num dataKey="t" value={o.t} step={0.5} min={0.001} disabled={disabled} onCommit={(v) => setOp("thicken", (x) => ({ ...x, t: v }))} /></Field>
                    <Field label="方向">
                      <select value={o.dir || "inward"} disabled={disabled} data-key="dir" onChange={(e) => setOp("thicken", (x) => ({ ...x, dir: e.target.value }))}>
                        {THICKEN_DIRS.map((k) => <option key={k} value={k}>{k === "inward" ? "向內" : "向外"}</option>)}
                      </select>
                    </Field>
                  </>
                )}
                {o.op === "fillet" && <Field label="圓角半徑"><Num dataKey="r" value={o.r} step={0.5} min={0.001} disabled={disabled} onCommit={(v) => setOp("fillet", (x) => ({ ...x, r: v }))} /></Field>}
                <a className="surfwin-ptdel" title="移除此操作" onClick={() => !disabled && removeOp(o.op)}>−</a>
              </div>
            ))}
          </div>
        </div>

        {allErrors.length > 0 && (
          <div className="surfwin-errs">
            {allErrors.slice(0, 8).map((e, i) => (
              <span key={i} className="surfwin-err">{e.path ? `${e.path}:` : ""}{e.message}</span>
            ))}
            {allErrors.length > 8 && <span className="surfwin-err">… 共 {allErrors.length} 項</span>}
          </div>
        )}
      </div>
      <div className="surfwin-foot">
        <a className="surfwin-mini surfwin-undo" data-disabled={!editor.canUndo || disabled || undefined} onClick={() => !disabled && editor.undo()} title="復原">↶</a>
        <a className="surfwin-mini surfwin-redo" data-disabled={!editor.canRedo || disabled || undefined} onClick={() => !disabled && editor.redo()} title="重做">↷</a>
        <a className="surfwin-mini surfwin-reset" data-disabled={!editor.hasAi || disabled || undefined} onClick={() => !disabled && editor.resetToAi()} title="回到對話最後給的草稿">重設</a>
        <a
          className="surfwin-mini surfwin-discard"
          data-arm={armDiscard || undefined}
          data-disabled={disabled || undefined}
          onClick={() => {
            if (disabled) return;
            if (!armDiscard) {
              setArmDiscard(true);
              return;
            }
            setArmDiscard(false);
            editor.discard();
            onClose?.();
          }}
          title="刪除草稿(已生成的版本不受影響)"
        >
          {armDiscard ? "確定捨棄?" : "捨棄"}
        </a>
        <span className="surfwin-spacer" />
        <a className="surfwin-build" data-disabled={buildBlocked || undefined} onClick={() => !buildBlocked && editor.build()}>
          {editor.building ? "生成中…" : "確認生成 ▸"}
        </a>
      </div>
    </div>
  );
}
