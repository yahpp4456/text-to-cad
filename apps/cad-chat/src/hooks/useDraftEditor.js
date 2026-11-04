// 曲面草稿編輯器(產品設計工作窗的狀態核心;Canvas3D 持有,SurfaceWindow 只是它的視圖):
//   - history(復原/重做;lib/draft/revision.js)+ 選取曲線 + 本地即時驗證
//   - 自動保存:編輯後 AUTOSAVE_MS 去抖 → POST /api/surface-draft(帶 baseRevision);
//     409 → 以伺服端草稿重建(對話/回退更新了草稿),400 → 顯示 errors
//   - 拖曳:beginDrag/dragTo/endDrag(拖曳中只換 present 不推歷史;放手才一筆)
//   - 生成:flush 後 POST /api/surface-build → onBuilt(JSON)(App 分發 version/present/params)
//   - 來源同步:props.surfaceDraft(SSE surface_draft / 回灌 / 換版 fetch)revision 比本地新才接管
// 全部 handler 讀 ref(stRef/optsRef),不受 stale closure 影響;hook 永遠被呼叫(非 product 時
// surfaceDraft=null → hist=null,零成本)。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiUrl } from "@/lib/apiBase";
import { canRedo, canUndo, createHistory, isDirty, pushState, redo as redoH, undo as undoH } from "../lib/draft/revision.js";
import { withEditablePoint } from "../lib/surface/nurbsEval.js";
import { emptyDraft, validateDraft } from "../lib/surface/surfaceSchema.js";

export const AUTOSAVE_MS = 600;
const BUSY_RETRY_MS = 1200;

const INITIAL = {
  hist: null,
  name: "product",
  serverRev: null,
  baseline: null,
  selected: null,
  saving: false,
  building: false,
  notice: null,
  serverErrors: null,
  seq: 0,
};

export function useDraftEditor(opts) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [st, setSt] = useState(INITIAL);
  const stRef = useRef(st);
  // 同步鏡像:所有變更先在 ref 上算出下一狀態再 setSt(值),讓同一個 JS task 內連續的
  // handler(onStart → onDrag → onEnd、update → flush)讀到的是最新值——用 setSt(updater)
  // 會延到下次 render 才執行,endDrag 會讀到拖曳前的 present 而以為「沒動」。
  const patch = useCallback((upd) => {
    const n = typeof upd === "function" ? upd(stRef.current) : { ...stRef.current, ...upd };
    stRef.current = n;
    setSt(n);
  }, []);
  const aiRef = useRef(null); // 最近一次來自對話(source ai)的草稿 → 「重設為 AI 草稿」
  const sidRef = useRef(null); // 自動保存 mint 出的 session(App 的 state 更新是非同步)
  const timer = useRef(null);
  const inflight = useRef(null);
  const dragBase = useRef(null);

  // ── 來源同步 ──
  useEffect(() => {
    const sd = opts.surfaceDraft;
    const cur = stRef.current;
    if (!sd || !sd.draft) {
      if (cur.hist) patch({ ...INITIAL });
      aiRef.current = null;
      return;
    }
    if (sd.source === "ai") aiRef.current = sd.draft;
    if (cur.hist && cur.name === (sd.name || cur.name) && cur.serverRev != null && Number(sd.revision) <= cur.serverRev) return;
    const dirty = !!(cur.hist && cur.baseline && isDirty(cur.hist, cur.baseline));
    patch({
      hist: createHistory(sd.draft),
      name: sd.name || cur.name || "product",
      serverRev: Number(sd.revision) || 0,
      baseline: sd.draft,
      serverErrors: null,
      notice: dirty ? "草稿已由對話更新,未保存的本地修改已被取代" : cur.hist ? null : cur.notice,
      selected: cur.selected && sd.draft.curves?.some((c) => c.id === cur.selected) ? cur.selected : null,
    });
  }, [opts.surfaceDraft, patch]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // ── 自動保存 ──
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    const cur = stRef.current;
    if (!cur.hist) return;
    if (cur.baseline && !isDirty(cur.hist, cur.baseline)) return;
    if (validateDraft(cur.hist.present, { partial: true }).length) return; // 本地已顯示錯誤,不送
    if (optsRef.current.locked) {
      // 對話回合進行中(伺服端 session busy 會 409):稍後再試
      timer.current = setTimeout(() => flush(), BUSY_RETRY_MS);
      return;
    }
    const seqAtSend = cur.seq;
    const sessionId = optsRef.current.sessionId || sidRef.current || undefined;
    const body = {
      sessionId,
      name: cur.name,
      draft: { ...cur.hist.present, revision: cur.serverRev ?? 0 },
      baseRevision: cur.serverRev,
    };
    patch({ saving: true });
    const p = (async () => {
      try {
        const r = await fetch(apiUrl("/api/surface-draft"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.draft) {
          patch({ hist: createHistory(j.draft), serverRev: j.revision, baseline: j.draft, serverErrors: null, notice: "草稿已在對話/回退中更新,已重新載入(本地修改已捨棄)" });
          optsRef.current.onDraft?.({ name: cur.name, revision: j.revision, draft: j.draft, source: "ai" });
          return;
        }
        if (r.status === 409) {
          timer.current = setTimeout(() => flush(), BUSY_RETRY_MS); // session busy
          return;
        }
        if (!r.ok || !j.ok) {
          patch({ serverErrors: Array.isArray(j.errors) && j.errors.length ? j.errors : [{ path: "", message: j.error || `HTTP ${r.status}` }] });
          return;
        }
        if (j.sessionId && j.sessionId !== optsRef.current.sessionId) {
          sidRef.current = j.sessionId;
          optsRef.current.onSession?.(j.sessionId);
        }
        const s = stRef.current;
        const untouched = s.seq === seqAtSend;
        patch({
          serverRev: j.revision,
          baseline: j.draft,
          serverErrors: null,
          hist: untouched && s.hist ? { ...s.hist, present: j.draft } : s.hist,
        });
        optsRef.current.onDraft?.({ name: j.name || cur.name, revision: j.revision, draft: j.draft, source: "user" });
        if (!untouched) timer.current = setTimeout(() => flush(), AUTOSAVE_MS);
      } catch {
        patch({ serverErrors: [{ path: "", message: "無法連線到本機伺服器" }] });
      } finally {
        patch({ saving: false });
        inflight.current = null;
      }
    })();
    inflight.current = p;
    await p;
  }, [patch]);

  const scheduleSave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), AUTOSAVE_MS);
  }, [flush]);

  // ── 編輯 ──
  const update = useCallback((next) => {
    const cur = stRef.current;
    if (!cur.hist) return;
    const d = typeof next === "function" ? next(cur.hist.present) : next;
    if (!d || typeof d !== "object") return;
    patch({ hist: pushState(cur.hist, d), seq: cur.seq + 1, notice: null });
    scheduleSave();
  }, [patch, scheduleSave]);

  const undo = useCallback(() => {
    const cur = stRef.current;
    if (!cur.hist || !canUndo(cur.hist)) return;
    patch({ hist: undoH(cur.hist), seq: cur.seq + 1 });
    scheduleSave();
  }, [patch, scheduleSave]);

  const redo = useCallback(() => {
    const cur = stRef.current;
    if (!cur.hist || !canRedo(cur.hist)) return;
    patch({ hist: redoH(cur.hist), seq: cur.seq + 1 });
    scheduleSave();
  }, [patch, scheduleSave]);

  const select = useCallback((id) => patch({ selected: id || null }), [patch]);

  // 拖曳:拖曳中只換 present(不推歷史、不保存);放手一筆進歷史 + 保存
  const beginDrag = useCallback(() => {
    const cur = stRef.current;
    if (!cur.hist) return;
    dragBase.current = cur.hist.present;
  }, []);
  const dragTo = useCallback((curveId, index, p) => {
    const cur = stRef.current;
    if (!cur.hist || !dragBase.current) return;
    const base = dragBase.current;
    const curves = base.curves.map((c) => (c.id === curveId ? withEditablePoint(c, index, p) : c));
    patch({ hist: { ...cur.hist, present: { ...base, curves } }, seq: cur.seq + 1 });
  }, [patch]);
  const endDrag = useCallback(() => {
    const cur = stRef.current;
    const base = dragBase.current;
    dragBase.current = null;
    if (!cur.hist || !base) return;
    if (JSON.stringify(base) === JSON.stringify(cur.hist.present)) return;
    patch({ hist: pushState({ ...cur.hist, present: base }, cur.hist.present), notice: null });
    scheduleSave();
  }, [patch, scheduleSave]);

  const movePoint = useCallback((curveId, index, p) => {
    update((d) => ({ ...d, curves: d.curves.map((c) => (c.id === curveId ? withEditablePoint(c, index, p) : c)) }));
  }, [update]);

  const resetToAi = useCallback(() => {
    if (aiRef.current) update(aiRef.current);
  }, [update]);

  const newDraft = useCallback((name = "product") => {
    patch({ ...INITIAL, hist: createHistory(emptyDraft()), name, seq: stRef.current.seq + 1 });
    scheduleSave();
  }, [patch, scheduleSave]);

  const discard = useCallback(async () => {
    clearTimeout(timer.current);
    const cur = stRef.current;
    const sessionId = optsRef.current.sessionId || sidRef.current;
    if (sessionId && cur.hist) {
      try {
        await fetch(apiUrl("/api/surface-draft"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, name: cur.name, discard: true }),
        });
      } catch {
        /* 離線也要讓本地消失 */
      }
    }
    patch({ ...INITIAL });
    aiRef.current = null;
    optsRef.current.onDraft?.(null);
  }, [patch]);

  const build = useCallback(async () => {
    await flush();
    const cur = stRef.current;
    if (!cur.hist || cur.building) return false;
    if (validateDraft(cur.hist.present).length || cur.serverErrors) return false;
    const sessionId = optsRef.current.sessionId || sidRef.current;
    if (!sessionId) return false;
    patch({ building: true, notice: null });
    try {
      const r = await fetch(apiUrl("/api/surface-build"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, name: cur.name }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      optsRef.current.onBuilt?.(j);
      return !!j.ok;
    } catch {
      optsRef.current.onBuilt?.({ ok: false, error: "無法連線到本機伺服器" });
      return false;
    } finally {
      patch({ building: false });
    }
  }, [flush, patch]);

  const present = st.hist?.present ?? null;
  const errors = useMemo(() => (present ? validateDraft(present) : []), [present]);
  const partialErrors = useMemo(() => (present ? validateDraft(present, { partial: true }) : []), [present]);
  const dirty = !!(st.hist && (!st.baseline || isDirty(st.hist, st.baseline)));

  return {
    present,
    name: st.name,
    revision: st.serverRev,
    selected: st.selected,
    errors,
    partialErrors,
    serverErrors: st.serverErrors,
    dirty,
    saving: st.saving,
    building: st.building,
    notice: st.notice,
    hasAi: !!aiRef.current,
    canUndo: !!(st.hist && canUndo(st.hist)),
    canRedo: !!(st.hist && canRedo(st.hist)),
    historyDepth: st.hist ? { past: st.hist.past.length, future: st.hist.future.length } : null,
    update,
    movePoint,
    undo,
    redo,
    select,
    beginDrag,
    dragTo,
    endDrag,
    resetToAi,
    newDraft,
    discard,
    build,
    flush,
    clearNotice: () => patch({ notice: null }),
  };
}
