import React, { useEffect, useRef } from "react";

import Message from "./Message.jsx";

const EXAMPLES = [
  { text: "外徑 20mm 的圓法蘭,均布 4 個 M4 螺孔,厚度 6mm", accent: "var(--design)" },
  { text: "一個內徑 16mm 的軸承座,單邊壁厚 4mm", accent: "var(--emit)" },
  { text: "SKF 6204 軸承的安裝定位座", accent: "var(--part)" },
  { text: "行程 100mm 的電動線性滑台:底板、線軌滑塊、滾珠螺桿與步進馬達", accent: "var(--ink)" },
];

export default function Conversation({ items, isIdle, running, live, onSubmitText, handlers }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, live]);

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
                描述零件,
                <br />
                看 AI 產出 CAD。
              </span>
              <span className="empty-sub">
                用自然語言描述你要的機構或零件。AI 會解析規格 → 規劃 → 參數化生成 →
                自我檢查與修正 → 把 3D 模型載入右側畫布。
              </span>
            </div>
            <div className="empty-examples">
              <span className="empty-examples-eyebrow">範例 · 點擊開始</span>
              {EXAMPLES.map((ex, i) => (
                <a className="example" key={i} onClick={() => onSubmitText(ex.text)}>
                  <span className="example-bar" style={{ background: ex.accent }} />
                  <span className="example-text">{ex.text}</span>
                  <span className="example-arrow">▸</span>
                </a>
              ))}
            </div>
          </div>
        ) : (
          <>
            {items.map((it) => (
              <div className="msg-wrap" key={it.id}>
                <Message it={it} handlers={handlers} />
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
