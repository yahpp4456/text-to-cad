import React, { useCallback, useEffect, useState } from "react";

import { apiUrl } from "@/lib/apiBase";

// 教訓面板 overlay(pull-only,不碰 chatStore):列已蒸餾教訓與待蒸餾統計,
// 可停用/啟用/刪除/重新蒸餾單條、手動觸發整體蒸餾。
// 畢業候選(★)= 蒸餾器判定夠通用穩定,值得人工升級進 skills/cad/references/lessons.md
// 或決定性檢查 —— 系統絕不自動改 skill 檔,升級永遠人工。
export default function LessonsPanel({ open, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(""); // 進行中動作 key(鎖鈕)
  const [confirmId, setConfirmId] = useState(null); // 教訓刪除二段確認
  const [confirmCaseId, setConfirmCaseId] = useState(null); // 未蒸餾案例刪除二段確認
  const [toast, setToast] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const r = await fetch(apiUrl("/api/lessons"));
      const j = await r.json();
      if (j.ok) setData(j);
      else setError(j.error || "讀取失敗");
    } catch {
      setError("無法連線到本機伺服器");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setConfirmId(null);
    setConfirmCaseId(null);
    setToast("");
    refresh();
  }, [open, refresh]);

  // Playwright / 除錯鉤(僅 dev)
  useEffect(() => {
    if (import.meta.env.DEV) window.__cadLessons = { refresh, last: data };
  }, [refresh, data]);

  if (!open) return null;

  const post = async (path, body, key) => {
    setBusy(key);
    setError("");
    setToast("");
    try {
      const r = await fetch(apiUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const j = await r.json().catch(() => ({}));
      // 先 refresh 再落訊息:refresh 內的 setError("") 會抹掉先設的錯誤(順序反了=死碼)
      await refresh();
      if (r.status === 409) setToast("蒸餾進行中,請稍候再試");
      else if (r.status === 503) setToast("認證未就緒,無法蒸餾");
      else if (!j.ok && j.reason === "bad_output") setToast("蒸餾輸出不合法,已略過(案例保留,可再試)");
      else if (!j.ok && j.reason === "no_cases") setToast("此教訓已無保留案例,無法重新蒸餾");
      else if (!j.ok && (j.error || j.reason)) {
        setError(j.error === "store_write_failed" ? "寫入教訓庫失敗(檔案被佔用?),請重試" : j.error || j.reason);
      }
      return j;
    } catch {
      setError("無法連線到本機伺服器");
      return null;
    } finally {
      setBusy("");
    }
  };

  const distillAll = async () => {
    const j = await post("/api/lessons/distill", {}, "distill");
    if (j?.ok) {
      // skipped(如 bad_output)必須誠實回報——燒了 LLM 卻沒產出,不能謊稱「沒東西可蒸」
      if (j.distilled?.length) {
        setToast(`已蒸餾:${j.distilled.join("、")}`);
      } else if (j.skipped?.length) {
        setToast(`未產出教訓:${j.skipped.map((s) => `${s.signature}(${s.reason})`).join("、")}——案例保留,可再試`);
      } else {
        setToast("沒有可蒸餾的待處理案例");
      }
    }
  };

  const daysAgo = (iso) => {
    if (!iso) return "";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return d <= 0 ? "今天" : `${d} 天前`;
  };

  const lessons = data?.lessons || [];
  const pending = data?.pending || [];
  const pendingTotal = pending.reduce((s, g) => s + g.count, 0);

  return (
    <div className="fb-overlay" onClick={onClose}>
      <div className="lessons-panel" onClick={(e) => e.stopPropagation()}>
        <div className="fb-head">
          <span className="bar bar-ink" />
          <div className="fb-titles">
            <span className="fb-eyebrow">LESSONS · 自我演化</span>
            <span className="fb-title">累積教訓</span>
          </div>
          <a className="fb-close" onClick={onClose}>
            ✕
          </a>
        </div>

        {data && data.enabled === false && (
          <div className="fb-error">⚠ 教訓系統已停用(CADCHAT_LESSONS=0)——只能檢視,不再錄製/蒸餾/注入。</div>
        )}
        {error && <div className="fb-error">⚠ {error}</div>}
        {toast && <div className="lessons-toast">{toast}</div>}

        <div className="fb-list">
          {lessons.map((l) => (
            <div className="lessons-row" key={l.id} data-status={l.status}>
              <div className="lessons-row-head">
                <span className="lessons-id">{l.id}</span>
                <span className="lessons-pill" data-status={l.status}>
                  {l.status === "active" ? "生效中" : "已停用"}
                </span>
                <span className="lessons-title">
                  {l.title}
                  {l.graduationCandidate && (
                    <span
                      className="lessons-grad"
                      title="畢業候選:夠通用且穩定,建議人工升級進 skills/cad/references/lessons.md 或決定性檢查"
                    >
                      ★
                    </span>
                  )}
                </span>
                <span className="grow" />
                <span className="lessons-meta">
                  {l.caseCount} 例({l.resolvedCount} 修復)
                  {l.lastHitAt ? ` · 最近 ${daysAgo(l.lastHitAt)}` : ""}
                </span>
              </div>
              <div className="lessons-rule">{l.rule}</div>
              <div className="lessons-cause">
                根因:{l.rootCause}
                <span className="lessons-sig" title={[l.signature, ...(l.altSignatures || [])].join("、")}>
                  {l.signature}
                </span>
              </div>
              <div className="lessons-actions">
                <a
                  className="fb-action"
                  data-disabled={!!busy || undefined}
                  onClick={() =>
                    !busy &&
                    post(
                      "/api/lessons/update",
                      { id: l.id, status: l.status === "active" ? "disabled" : "active" },
                      `upd:${l.id}`,
                    )
                  }
                >
                  {l.status === "active" ? "停用" : "啟用"}
                </a>
                <a
                  className="fb-action"
                  data-disabled={!!busy || undefined}
                  onClick={() => !busy && post("/api/lessons/redistill", { id: l.id }, `re:${l.id}`)}
                >
                  {busy === `re:${l.id}` ? "蒸餾中…" : "重新蒸餾"}
                </a>
                {confirmId === l.id ? (
                  <>
                    <a
                      className="fb-action lessons-danger"
                      data-disabled={!!busy || undefined}
                      onClick={() => !busy && post("/api/lessons/delete", { id: l.id }, `del:${l.id}`)}
                    >
                      確認刪除
                    </a>
                    <a
                      className="fb-action"
                      data-disabled={!!busy || undefined}
                      onClick={() => !busy && setConfirmId(null)}
                    >
                      取消
                    </a>
                  </>
                ) : (
                  <a
                    className="fb-action lessons-danger"
                    data-disabled={!!busy || undefined}
                    onClick={() => !busy && setConfirmId(l.id)}
                  >
                    刪除
                  </a>
                )}
              </div>
            </div>
          ))}
          {lessons.length === 0 && !error && (
            <div className="fb-empty">
              尚無蒸餾教訓 —— 驗證出紅色會自動累積案例,同類達 {data?.threshold ?? 3} 件即自動蒸餾。
            </div>
          )}

          {pending.length > 0 && (
            <div className="lessons-pending">
              <div className="lessons-pending-head">
                待蒸餾案例 · 未蒸餾({pendingTotal} 筆,可逐筆刪除,或底部「立即蒸餾」整體處理)
              </div>
              {pending.map((g) => (
                <div className="pending-group" key={g.signature}>
                  <div className="pending-sig">
                    {g.signature}
                    <span className="pending-x">×{g.count}</span>
                    {(g.attempts || 0) >= 2 && <span className="pending-warn">自動已停,可手動</span>}
                  </div>
                  {(g.cases || []).map((cs) => (
                    <div className="pending-case" key={cs.id}>
                      <span className="pending-case-id">{cs.id}</span>
                      <span className="pending-case-note">{cs.note || cs.source}</span>
                      <span className="grow" />
                      <span className="pending-case-meta">
                        {cs.partName ? `${cs.partName} · ` : ""}
                        {daysAgo(cs.at)}
                      </span>
                      {confirmCaseId === cs.id ? (
                        <>
                          <a
                            className="fb-action lessons-danger"
                            data-disabled={!!busy || undefined}
                            onClick={() =>
                              !busy && post("/api/lessons/delete-case", { id: cs.id }, `delc:${cs.id}`)
                            }
                          >
                            確認刪除
                          </a>
                          <a
                            className="fb-action"
                            data-disabled={!!busy || undefined}
                            onClick={() => !busy && setConfirmCaseId(null)}
                          >
                            取消
                          </a>
                        </>
                      ) : (
                        <a
                          className="fb-action lessons-danger"
                          data-disabled={!!busy || undefined}
                          onClick={() => !busy && setConfirmCaseId(cs.id)}
                        >
                          刪除
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="fb-foot lessons-foot">
          <span>
            {pendingTotal > 0
              ? `待蒸餾:${pending
                  .map((g) => `${g.signature} ×${g.count}${(g.attempts || 0) >= 2 ? "(自動已停,可手動)" : ""}`)
                  .join("、")}`
              : `無待蒸餾案例(累計 ${data?.stats?.totalCases ?? 0} 筆)`}
          </span>
          <span className="grow" />
          <a
            className="fb-action"
            data-disabled={busy === "distill" || data?.enabled === false || undefined}
            onClick={() => busy !== "distill" && data?.enabled !== false && distillAll()}
          >
            {busy === "distill" ? "蒸餾中…" : "立即蒸餾"}
          </a>
        </div>
      </div>
    </div>
  );
}
