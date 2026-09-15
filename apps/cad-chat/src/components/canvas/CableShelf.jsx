import React, { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "@/lib/apiBase";
import { DEMO_TIP } from "../../lib/demo.js";
import { thumbFor } from "../../lib/libThumbs.js";

// 無塵電纜工作台貨架(僅 cable 模式,畫布上方常駐、可收合):兩個頁籤——
//   範本:models/ 裡宣告了 TEMPLATE_META(family=cable)的產生器目錄。點卡 =
//        「填規格」開規格表單(零等待,欄位定義隨清單一起回來,不必先建 session)。
//   案件:另存出去的客戶案(目錄有 case.json)。看/開/複製成新案。
// 清單來源 GET /api/templates?family=cable —— 真相是產生器 .py 頂部的宣告,
// 沒有第二份型錄檔;縮圖沿用零件庫那條離屏渲染鏈(libThumbs.thumbFor)。
// readOnly(DEMO):整個貨架照渲染但動作禁用+提示(/api/templates 對 demo 是
// 403,清單會是空的——文案要說清楚是身分限制,不是「沒有範本」)。
export default function CableShelf({
  onPickTemplate,
  onOpenProject,
  onPreview,
  refreshSignal,
  autoCollapse = false, // 生出第一版後自動收合(把畫面讓給模型;之後手動展開不會被再收)
  readOnly = false,
  busy = false,
}) {
  const [data, setData] = useState(null); // {templates, cases} | null=載入中
  const [tab, setTab] = useState("templates");
  const [open, setOpen] = useState(true);
  const [thumbs, setThumbs] = useState({}); // dir -> dataURL
  const [err, setErr] = useState("");
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/templates?family=cable"));
      const j = await r.json();
      if (!aliveRef.current) return;
      if (j.ok) {
        setData({ templates: j.templates || [], cases: j.cases || [] });
        setErr("");
      } else {
        setData({ templates: [], cases: [] });
        setErr(j.error || "清單讀取失敗");
      }
    } catch {
      if (aliveRef.current) {
        setData({ templates: [], cases: [] });
        setErr("無法連線到本機伺服器");
      }
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  // 另存案件後(refreshSignal 變動)重抓:新案要立刻出現在「案件」頁籤
  useEffect(() => {
    if (refreshSignal) refresh();
  }, [refreshSignal, refresh]);

  // autoCollapse 由 false→true 的那一次收合(effect 只在值變動時跑 → 使用者之後
  // 手動展開不會被反覆收掉)
  useEffect(() => {
    if (autoCollapse) setOpen(false);
  }, [autoCollapse]);

  // 縮圖:只用現成的 tracked GLB(範本/案件目錄裡的 .<name>.step.glb);缺就占位,
  // 不做補轉(工作台不該為了縮圖 spawn Python)。
  useEffect(() => {
    const items = [...(data?.templates || []), ...(data?.cases || [])];
    if (!items.length) return;
    let cancelled = false;
    (async () => {
      for (const it of items) {
        if (cancelled || thumbs[it.dir] || !it.glbRel) continue;
        try {
          const dataUrl = await thumbFor(apiUrl(`/api/asset?file=${encodeURIComponent(it.glbRel)}`));
          if (!cancelled) setThumbs((prev) => ({ ...prev, [it.dir]: dataUrl }));
        } catch {
          /* 縮圖失敗:卡片維持 ⌒ 占位,不擋其他卡 */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // dev 鉤:煙測斷卡片數/頁籤/縮圖數(WebGL 與元件內部 state 從 DOM 看不到)
  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__cadCableShelf = {
        counts: () => ({
          templates: data?.templates?.length ?? -1,
          cases: data?.cases?.length ?? -1,
        }),
        tab: () => tab,
        thumbCount: () => Object.keys(thumbs).length,
      };
    }
  }, [data, tab, thumbs]);

  const items = tab === "cases" ? data?.cases : data?.templates;
  const guard = (fn) => (readOnly || busy ? undefined : fn);
  const tip = readOnly ? DEMO_TIP : busy ? "生成中,完成後才能再開" : undefined;

  const card = (it) => {
    const isCase = it.kind === "case";
    const layers = Number.isFinite(it.layers) ? `${it.layers} 層` : "";
    const meta = isCase
      ? [it.case?.customer, it.case?.created].filter(Boolean).join(" · ") || layers
      : [layers, it.form === "envelope" ? "圖面長寬高" : "逐層定長"].filter(Boolean).join(" · ");
    return (
      <div className="lib-card cable-card" key={it.dir} data-dir={it.dir} data-kind={it.kind}>
        <a
          className="lib-card-thumb"
          title={isCase ? "以此案的規格開表單(複製成新案)" : "填規格"}
          onClick={guard(() => onPickTemplate?.(it))}
        >
          {thumbs[it.dir] ? <img src={thumbs[it.dir]} alt="" /> : <span className="lib-card-ph">⌒</span>}
        </a>
        <span className="lib-card-label" title={it.summary || it.label}>
          {it.label}
        </span>
        <span className="lib-card-meta">{meta}</span>
        <div className="lib-card-actions">
          <a className="fb-action" data-disabled={readOnly || busy || undefined} title={tip} onClick={guard(() => onPickTemplate?.(it))}>
            {isCase ? "複製成新案" : "填規格"}
          </a>
          <a
            className="fb-action"
            data-disabled={readOnly || busy || undefined}
            title={tip || "開成可編輯 session(滑桿/匯出)"}
            onClick={guard(() => onOpenProject?.(it))}
          >
            開啟
          </a>
          <a
            className="fb-action"
            data-disabled={readOnly || busy || undefined}
            title={tip || "唯讀看件(不建 session)"}
            onClick={guard(() => onPreview?.(it))}
          >
            預覽
          </a>
        </div>
      </div>
    );
  };

  return (
    <div className="lib-shelf cable-shelf" data-open={open}>
      <div className="lib-shelf-head">
        <span className="bar bar-cable" />
        <span className="lib-shelf-eyebrow">CABLE WORKBENCH · 無塵電纜工作台</span>
        <a
          className="cable-tab"
          data-on={tab === "templates"}
          onClick={() => setTab("templates")}
        >
          範本 {data ? data.templates.length : "…"}
        </a>
        <a className="cable-tab" data-on={tab === "cases"} onClick={() => setTab("cases")}>
          案件 {data ? data.cases.length : "…"}
        </a>
        <span className="grow" />
        <a className="lib-shelf-toggle" onClick={() => setOpen(!open)}>
          {open ? "▾ 收合" : "▸ 展開"}
        </a>
      </div>
      {open && (
        <div className="lib-shelf-track">
          {items?.length === 0 && (
            <span className="lib-shelf-empty">
              {readOnly
                ? DEMO_TIP
                : err
                  ? err
                  : tab === "cases"
                    ? "還沒有存過案件——生成後用標頭「⤓ 另存案件」存起來,之後可複製成新案。"
                    : "找不到電纜範本(產生器 .py 要宣告 TEMPLATE_META family=cable)。"}
            </span>
          )}
          {(items || []).map(card)}
        </div>
      )}
    </div>
  );
}
