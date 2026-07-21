import React, { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "@/lib/apiBase";
import { DEMO_TIP } from "../../lib/demo.js";
import { thumbFor } from "../../lib/libThumbs.js";

// 零件庫貨架(僅零件庫模式,畫布上方常駐、可收合):直接展開看庫、含 3D 縮圖,
// 不走 AI 問答。卡片動作:預覽(載進畫布,不進時間軸)、⇪ 設計(確認切設計模式
// 後走既有匯入流程)。刪除收進標頭「管理」模式:進模式後點卡選取(預覽/⇪ 設計
// 讓位)→「刪除 N 件」二段確認 → 逐件打既有單 slug API,刪完自動退出。
// 縮圖鏈:library-list 回 glbRel(收庫時順產);缺 GLB 的卡序列呼叫 /api/library-glb
// 補轉,拿到 GLB 後 libThumbs 離屏渲染 dataURL。
// readOnly(DEMO 帳號):**預覽開放**(純唯讀,/api/asset 對 demo 放行)、⇪ 設計與
// 管理照常渲染但禁用+提示(不是藏);縮圖只用現成 GLB(不打 /api/library-glb
// 補轉,該端點對 demo 是 403;缺圖卡維持 ⬡ 占位)。
export default function LibraryShelf({ onPreview, onImportToDesign, refreshSignal, readOnly = false }) {
  const [parts, setParts] = useState(null); // null=載入中
  const [open, setOpen] = useState(true);
  const [thumbs, setThumbs] = useState({}); // slug -> dataURL
  const [manage, setManage] = useState(false); // 管理(批次刪除)模式
  const [selected, setSelected] = useState(() => new Set()); // 待刪 slug 集合
  const [armed, setArmed] = useState(false); // 批次刪除二段確認
  const [busy, setBusy] = useState(false); // 批次刪除進行中
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

  // ⇪ 設計:同預覽鏈拿 GLB URL 一併帶出,匯入成功後可直接上畫布;
  // 轉檔失敗傳 null——匯入照走,只是少了畫布回饋(匯入本體不因縮圖鏈壞而擋)。
  const importToDesign = useCallback(
    async (p) => {
      let glbUrl = null;
      try {
        glbUrl = await ensureGlbUrl(p);
      } catch {
        /* 同上:無害 */
      }
      onImportToDesign?.(p, glbUrl);
    },
    [ensureGlbUrl, onImportToDesign],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/library-list"));
      const j = await r.json();
      if (aliveRef.current && j.ok) {
        setParts(j.parts);
        // 選取集合對新清單過濾(agent 收庫觸發的重抓可能讓選中的件消失);
        // 「刪除 N 件」的 N 從 selected.size 現算,過濾後不會漂移
        setSelected((prev) => {
          const kept = new Set([...prev].filter((s) => j.parts.some((p) => p.slug === s)));
          return kept.size === prev.size ? prev : kept;
        });
      }
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
          const url = readOnly ? glbUrlOf(p) : await ensureGlbUrl(p);
          if (!url) continue; // readOnly 且無現成 GLB:不補轉,維持占位
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
  }, [parts, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const exitManage = () => {
    setManage(false);
    setSelected(new Set());
    setArmed(false);
  };

  const toggleSelect = (slug) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
    setArmed(false); // 選取變動退回一段,重新確認
  };

  // 批次刪除:逐件序列打既有單 slug API(server 零改動),全數完成後重抓一次並退出模式
  const doDeleteBatch = async () => {
    if (!selected.size || busy) return;
    setBusy(true);
    try {
      for (const slug of selected) {
        await fetch(apiUrl("/api/library-delete"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug }),
        });
      }
      await refresh();
      if (aliveRef.current) exitManage();
    } finally {
      if (aliveRef.current) setBusy(false);
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
        {manage ? (
          <>
            <a
              className="fb-action lib-del"
              data-armed={armed || undefined}
              data-disabled={!selected.size || busy || undefined}
              onClick={() => {
                if (!selected.size || busy) return;
                if (!armed) setArmed(true);
                else doDeleteBatch();
              }}
            >
              {busy ? "刪除中…" : `${armed ? "確定刪" : "刪除"} ${selected.size} 件`}
            </a>
            <a className="fb-action" onClick={() => !busy && exitManage()}>
              取消
            </a>
          </>
        ) : (
          parts?.length > 0 && (
            <a
              className="fb-action lib-del"
              data-disabled={readOnly || undefined}
              title={readOnly ? DEMO_TIP : "進入批次刪除模式"}
              onClick={readOnly ? undefined : () => setManage(true)}
            >
              管理
            </a>
          )
        )}
        <a className="lib-shelf-toggle" onClick={() => setOpen(!open)}>
          {open ? "▾ 收合" : "▸ 展開"}
        </a>
      </div>
      {open && (
        <div className="lib-shelf-track">
          {parts?.length === 0 && (
            <span className="lib-shelf-empty">
              {readOnly ? "庫是空的。" : "庫是空的——丟一顆 STP 開始收。"}
            </span>
          )}
          {(parts || []).map((p) => (
            <div
              className="lib-card"
              key={p.slug}
              data-slug={p.slug}
              data-selected={(manage && selected.has(p.slug)) || undefined}
            >
              <a
                className="lib-card-thumb"
                title={manage ? "選取/取消選取" : "載入 3D 預覽"}
                onClick={() => (manage ? toggleSelect(p.slug) : preview(p))}
              >
                {thumbs[p.slug] ? <img src={thumbs[p.slug]} alt="" /> : <span className="lib-card-ph">⬡</span>}
                {manage && selected.has(p.slug) && <span className="lib-card-check">✓</span>}
              </a>
              <span className="lib-card-label" title={p.notes || p.label}>
                {p.label}
              </span>
              <span className="lib-card-meta">
                {p.family}
                {p.bboxMm ? ` · ${p.bboxMm.map((n) => Math.round(n)).join("×")}mm` : ""}
              </span>
              {!manage && (
                <div className="lib-card-actions">
                  {/* 預覽=純唯讀載入畫布(/api/asset 對 demo 本就放行):readOnly 也開放,
                      否則 demo 只能看縮圖,「看得到貨」這件事就沒了。 */}
                  <a className="fb-action" onClick={() => preview(p)}>
                    預覽
                  </a>
                  <a
                    className="fb-action"
                    data-disabled={readOnly || undefined}
                    title={readOnly ? DEMO_TIP : "切到設計模式並匯入場景"}
                    onClick={readOnly ? undefined : () => importToDesign(p)}
                  >
                    ⇪ 設計
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
