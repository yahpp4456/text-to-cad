import React, { useEffect, useMemo, useRef } from "react";

// 零件庫空狀態的上傳區(硬閘:先上傳 STP 才會開始;點擊選檔+拖放二路)
// disabled(DEMO):上傳區照常渲染但整塊禁用(點擊/拖放 no-op),副標換成
// 不可用原因——藏掉整區會讓展示者以為零件庫沒有收庫功能。
function LibraryDropzone({ onAttachFiles, disabled = false, disabledTip }) {
  const fileRef = useRef(null);
  return (
    <div
      className="lib-dropzone"
      data-disabled={disabled || undefined}
      title={disabled ? disabledTip : undefined}
      onClick={disabled ? undefined : () => fileRef.current?.click()}
      onDragOver={disabled ? undefined : (e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (disabled) return;
        const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
          /\.ste?p$/i.test(f.name || ""),
        );
        if (files.length) onAttachFiles?.(files);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".step,.stp"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) onAttachFiles?.(e.target.files);
          e.target.value = "";
        }}
      />
      <span className="lib-dz-icon">⬆</span>
      <span className="lib-dz-title">拖放 STP 到這裡,或點擊選檔</span>
      <span className="lib-dz-sub">
        {disabled
          ? disabledTip
          : "上傳後 AI 會呈現外形、量測尺寸,訪談幾個基本欄位就收進零件庫。"}
      </span>
    </div>
  );
}

import Message from "./Message.jsx";

const EXAMPLES = [
  { text: "外徑 20mm 的圓法蘭,均布 4 個 M4 螺孔,厚度 6mm", accent: "var(--design)" },
  { text: "一個內徑 16mm 的軸承座,單邊壁厚 4mm", accent: "var(--emit)" },
  { text: "SKF 6204 軸承的安裝定位座", accent: "var(--part)" },
  { text: "行程 100mm 的電動線性滑台:底板、線軌滑塊、滾珠螺桿與步進馬達", accent: "var(--ink)" },
];

// 草模模式的閒置範例:機構構想(拓撲/DOF/動作),不是零件規格
const EXAMPLES_SKETCH = [
  { text: "水平汽缸經連桿推末端平台前傾 30°", accent: "var(--sketch)" },
  { text: "旋轉臂夾爪:夾取工件、90° 翻轉後放到定位座", accent: "var(--emit)" },
  { text: "齒輪齒條轉向機構,輸入 ±45°", accent: "var(--part)" },
  { text: "兩軸取放:水平滑台 + 升降夾爪的動作流程", accent: "var(--ink)" },
];

// (零件庫模式無閒置範例:硬閘=先上傳 STP 才會開始,空狀態是 LibraryDropzone)

export default function Conversation({
  items,
  isIdle,
  running,
  live,
  frozen,
  mode,
  specLiveId,
  onSubmitText,
  onAttachFiles, // 零件庫空狀態上傳區用(其他模式不渲染)
  attachDisabled = false, // DEMO:上傳區禁用但照常渲染
  attachDisabledTip,
  handlers,
}) {
  const scrollRef = useRef(null);
  // clarify 焦點模式凍結期:抑制強拉到底,讓使用者能安心上捲讀歷史(答案的重心已移到
  // 視圖聚光燈卡)。答完 frozen 轉 false → effect 重跑 → 平滑回到底。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !frozen) el.scrollTop = el.scrollHeight;
  }, [items, live, frozen]);

  // 待答中的 clarify(最後一張、其後無 user)→ 那張左欄紀錄卡顯示「作答中…▸」指路。
  const pendingId = useMemo(() => {
    if (!frozen) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.type === "user") return null;
      if (items[i]?.type === "clarify") return items[i].id;
    }
    return null;
  }, [items, frozen]);

  // specLiveId 由 App 下傳(與視圖 SpecPanel 同一資料源+同一讓位規則推導),
  // 這裡只比對 id,不自行推導——兩端永不漂移。

  return (
    <section className="conv">
      <div className="conv-head">
        <span className="bar bar-ink tall" />
        <span className="conv-eyebrow">CONVERSATION</span>
      </div>
      <div className="conv-scroll" ref={scrollRef}>
        {isIdle ? (
          <div className="empty">
            <div className="empty-hero">
              <span className="empty-title">
                {mode === "sketch" ? (
                  <>
                    描述機構,
                    <br />
                    看 AI 搭出會動的草模。
                  </>
                ) : mode === "library" ? (
                  <>
                    丟一個 STP,
                    <br />
                    訪談後收進零件庫。
                  </>
                ) : (
                  <>
                    描述零件,
                    <br />
                    看 AI 產出 CAD。
                  </>
                )}
              </span>
              <span className="empty-sub">
                {mode === "sketch"
                  ? "用一句話描述機構構想(拓撲、驅動方式、行程)。AI 會在幾秒內搭出可播放、可拉滑桿的剛體運動示意——快速驗證想法,要產真零件再切「設計」。"
                  : mode === "library"
                    ? "把原廠 STP 交給 AI:先呈現 3D 外形並量測尺寸,訪談名稱/型號/分類後收進零件庫;之後在「設計」模式一句話就能引用。"
                    : "用自然語言描述你要的機構或零件。AI 會解析規格 → 規劃 → 參數化生成 → 自我檢查與修正 → 把 3D 模型載入右側畫布。"}
              </span>
            </div>
            {mode === "library" ? (
              // 硬閘:先上傳 STP 才會開始(範例列讓位給上傳區)。
              // DEMO:上傳區照出但禁用(見 LibraryDropzone 註解)。
              <LibraryDropzone
                onAttachFiles={onAttachFiles}
                disabled={attachDisabled}
                disabledTip={attachDisabledTip}
              />
            ) : (
              <div className="empty-examples">
                <span className="empty-examples-eyebrow">範例 · 點擊開始</span>
                {(mode === "sketch" ? EXAMPLES_SKETCH : EXAMPLES).map((ex, i) => (
                  <a className="example" key={i} onClick={() => onSubmitText(ex.text)}>
                    <span className="example-bar" style={{ background: ex.accent }} />
                    <span className="example-text">{ex.text}</span>
                    <span className="example-arrow">▸</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {items.map((it) => (
              <div className="msg-wrap" key={it.id}>
                <Message
                  it={it}
                  handlers={handlers}
                  pending={it.id === pendingId}
                  specLive={it.id === specLiveId}
                />
              </div>
            ))}
            {running && live && (
              <div className="live-row">
                <span className="live-dot" />
                <span className="live-text">{live.text}</span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
