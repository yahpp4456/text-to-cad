import React, { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "@/lib/apiBase";
import { thumbFor } from "../../lib/libThumbs.js";

// 零件庫貨架(僅零件庫模式,畫布上方常駐、可收合):直接展開看庫、含 3D 縮圖,
// 不走 AI 問答。卡片動作:預覽(載進畫布,不進時間軸)、⇪ 設計(確認切設計模式
// 後走既有匯入流程)、刪除(inline 二次確認)。
// 縮圖鏈:library-list 回 glbRel(收庫時順產);缺 GLB 的卡序列呼叫 /api/library-glb
// 補轉,拿到 GLB 後 libThumbs 離屏渲染 dataURL。
export default function LibraryShelf({ onPreview, onImportToDesign, refreshSignal }) {
  const [parts, setParts] = useState(null); // null=載入中
  const [open, setOpen] = useState(true);
  const [thumbs, setThumbs] = useState({}); // slug -> dataURL
  const [confirmDel, setConfirmDel] = useState(null); // slug 待確認刪除
  const [busyDel, setBusyDel] = useState("");
  const aliveRef = useRef(true);

  const glbUrlOf = (p) =>
    p.glbRel ? apiUrl(`/api/asset?file=${encodeURIComponent(p.glbRel)}&v=${p.glbMtime}`) : null;

  // 拿到可用的 GLB asset URL:缺 sidecar 就打補轉端點(縮圖鏈與預覽點擊共用)
  const ensureGlbUrl = useCallback(async (p) => {
    const direct = glbUrlOf(p);
    if (direct) return direct;
    const r = await fetch(apiUrl("/api/library-glb"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: p.slug }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "轉檔失敗");
    return apiUrl(`/api/asset?file=${encodeURIComponent(j.glbRel)}&v=${j.glbMtime}`);
  }, []);

  const preview = useCallback(
    async (p) => {
      try {
        onPreview?.(p, await ensureGlbUrl(p));
      } catch {
        /* 轉檔失敗:占位卡不動,無害 */
      }
    },
    [ensureGlbUrl, onPreview],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/library-list"));
      const j = await r.json();
      if (aliveRef.current && j.ok) setParts(j.parts);
    } catch {
      if (aliveRef.current) setParts([]);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  // 收庫回合結束(running true→false)重抓:agent 可能剛 library_add 了新件
  const prevRunning = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !refreshSignal) refresh();
    prevRunning.current = !!refreshSignal;
  }, [refreshSignal, refresh]);

  // 縮圖鏈:有 GLB 的直接離屏渲染;缺 GLB 的序列補轉(避免 spawn 突刺)再渲染
  useEffect(() => {
    if (!parts?.length) return;
    let cancelled = false;
    (async () => {
      for (const p of parts) {
        if (cancelled || thumbs[p.slug]) continue;
        try {
          const url = await ensureGlbUrl(p);
          const dataUrl = await thumbFor(url);
          if (!cancelled) setThumbs((prev) => ({ ...prev, [p.slug]: dataUrl }));
        } catch {
          /* 補轉/縮圖失敗:卡片維持無圖占位,不擋其他卡 */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parts]); // eslint-disable-line react-hooks/exhaustive-deps

  const doDelete = async (slug) => {
    setBusyDel(slug);
    try {
      const r = await fetch(apiUrl("/api/library-delete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const j = await r.json();
      if (j.ok) {
        setConfirmDel(null);
        await refresh();
      }
    } finally {
      setBusyDel("");
    }
  };

  // dev 鉤:煙測斷卡片數/縮圖數
  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__cadLibShelf = {
        count: () => parts?.length ?? -1,
        thumbCount: () => Object.keys(thumbs).length,
      };
    }
  }, [parts, thumbs]);

  return (
    <div className="lib-shelf" data-open={open}>
      <div className="lib-shelf-head">
        <span className="bar bar-ink" />
        <span className="lib-shelf-eyebrow">PARTS LIBRARY · 零件庫</span>
        <span className="lib-shelf-count">{parts ? `${parts.length} 件` : "…"}</span>
        <span className="grow" />
        <a className="lib-shelf-toggle" onClick={() => setOpen(!open)}>
          {open ? "▾ 收合" : "▸ 展開"}
        </a>
      </div>
      {open && (
        <div className="lib-shelf-track">
          {parts?.length === 0 && <span className="lib-shelf-empty">庫是空的——丟一顆 STP 開始收。</span>}
          {(parts || []).map((p) => (
            <div className="lib-card" key={p.slug} data-slug={p.slug}>
              <a className="lib-card-thumb" title="載入 3D 預覽" onClick={() => preview(p)}>
                {thumbs[p.slug] ? <img src={thumbs[p.slug]} alt="" /> : <span className="lib-card-ph">⬡</span>}
              </a>
              <span className="lib-card-label" title={p.notes || p.label}>
                {p.label}
              </span>
              <span className="lib-card-meta">
                {p.family}
                {p.bboxMm ? ` · ${p.bboxMm.map((n) => Math.round(n)).join("×")}mm` : ""}
              </span>
              <div className="lib-card-actions">
                {confirmDel === p.slug ? (
                  <>
                    <a className="fb-action" onClick={() => !busyDel && doDelete(p.slug)}>
                      {busyDel === p.slug ? "刪除中…" : "確定刪"}
                    </a>
                    <a className="fb-action" onClick={() => setConfirmDel(null)}>
                      取消
                    </a>
                  </>
                ) : (
                  <>
                    <a className="fb-action" onClick={() => preview(p)}>
                      預覽
                    </a>
                    <a className="fb-action" title="切到設計模式並匯入場景" onClick={() => onImportToDesign?.(p)}>
                      ⇪ 設計
                    </a>
                    <a className="fb-action lib-del" onClick={() => setConfirmDel(p.slug)}>
                      刪
                    </a>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
