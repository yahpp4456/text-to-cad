import React, { useEffect, useRef, useState } from "react";
import { commitValue, fmtValue, isIntDef, stepValue } from "@/lib/numberField";

export default function NumberField({ def, value, disabled, onCommit }) {
  const [draft, setDraft] = useState(() => fmtValue(value, def));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [selectRequest, setSelectRequest] = useState(0);
  const inputRef = useRef(null);

  // 未聚焦時以外部值為準,避免回滾事件被舊草稿遮住。
  useEffect(() => {
    if (!focused) setDraft(fmtValue(value, def));
  }, [def, focused, value]);

  useEffect(() => {
    if (selectRequest > 0) inputRef.current?.select();
  }, [selectRequest]);

  const finishDraft = (keepFocused) => {
    const result = commitValue(draft, def);
    if (result.ok) {
      setDraft(fmtValue(result.value, def));
      if (result.value !== value) onCommit?.(def.key, result.value);
    } else {
      setDraft(fmtValue(value, def));
    }
    setInvalid(false);
    if (!keepFocused) setFocused(false);
  };

  const applyStep = (dir) => {
    if (disabled) return;
    const parsedDraft = focused ? commitValue(draft, def) : { ok: false };
    const current = parsedDraft.ok ? parsedDraft.value : value;
    const next = stepValue(current, def, dir);
    setDraft(fmtValue(next, def));
    setInvalid(false);
    if (next !== current) onCommit?.(def.key, next);
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishDraft(true);
      setSelectRequest((request) => request + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      applyStep(1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      applyStep(-1);
    }
  };

  return (
    <div className="numfield" data-invalid={invalid || undefined} data-key={def.key}>
      <a
        className="numfield-btn"
        data-dir="down"
        data-disabled={disabled || undefined}
        onClick={() => applyStep(-1)}
      >
        −
      </a>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={focused ? draft : fmtValue(value, def)}
        disabled={disabled}
        onFocus={() => {
          setDraft(fmtValue(value, def));
          setFocused(true);
          setInvalid(false);
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          setInvalid(!commitValue(next, def).ok);
        }}
        onBlur={() => finishDraft(false)}
        onKeyDown={onKeyDown}
      />
      {def.unit ? <span className="numfield-unit">{def.unit}</span> : null}
      <a
        className="numfield-btn"
        data-dir="up"
        data-disabled={disabled || undefined}
        onClick={() => applyStep(1)}
      >
        +
      </a>
    </div>
  );
}
