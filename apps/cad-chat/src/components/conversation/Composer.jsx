import React, { useEffect, useRef, useState } from "react";

export default function Composer({
  running,
  pickRefs = [],
  prefill,
  onPrefillConsumed,
  onRemovePick,
  onClearPicks,
  onSubmit,
  onInterrupt,
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);
  const canSend = !running && draft.trim().length > 0;

  // 點規格 chip → 預填草稿並聚焦,讓使用者接著打修正值。
  useEffect(() => {
    if (prefill == null) return;
    setDraft(prefill);
    onPrefillConsumed?.();
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [prefill]);

  const submit = () => {
    const text = draft.trim();
    if (!text || running) return;
    onSubmit(text);
    setDraft("");
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      {pickRefs.length > 0 && (
        <div className="pick-chips">
          {pickRefs.map((r) => (
            <span className="pick-chip" key={r.token}>
              ⊹ {r.label || r.token}
              <a className="pick-clear" onClick={() => onRemovePick?.(r.token)}>
                ✕
              </a>
            </span>
          ))}
          {pickRefs.length > 1 && (
            <a className="pick-clear-all" onClick={onClearPicks}>
              全部清除
            </a>
          )}
        </div>
      )}
      <div className="composer-row">
        <textarea
          rows={1}
          ref={inputRef}
          className="composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="描述零件,或追加修改（Enter 送出）…"
        />
        {running ? (
          <a className="composer-btn interrupt" title="中斷" onClick={onInterrupt}>
            <span className="stop-square" />
          </a>
        ) : (
          <a
            className="composer-btn send"
            data-active={canSend}
            onClick={canSend ? submit : undefined}
          >
            ↑
          </a>
        )}
      </div>
    </div>
  );
}
