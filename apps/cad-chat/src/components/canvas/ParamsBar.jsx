import React from "react";

import NumberField from "../NumberField.jsx";

// 底部參數列:number 輸入框+步進鈕(2026-07-16 拉桿改版——拉桿不直覺且參數多
// 要橫向捲動找;數字框窄得多 + flex-wrap 換行,見 app.css .paramsbar-track)。
// 介面不變:{params:{defs,values,dirty}, disabled, onParam, onApply}。
// 草模的 DofBar 是獨立元件(純客端 scrub 語意),仍用 range,不在此改。
export default function ParamsBar({ params, disabled, onParam, onApply }) {
  const { defs, values, dirty } = params;
  return (
    <div className="paramsbar">
      <div className="paramsbar-tag">
        <span className="bar bar-part" />
        <div className="paramsbar-titles">
          <span className="paramsbar-eyebrow">PARAMS</span>
          <span className="paramsbar-cn">參數</span>
        </div>
      </div>
      <div className="paramsbar-track">
        {defs.length === 0 ? (
          <span className="paramsbar-empty">產出後,可調參數會出現在這裡</span>
        ) : (
          defs.map((d) => (
            <div className="param param-num" key={d.key}>
              <span className="param-label">{d.label}</span>
              <NumberField def={d} value={values[d.key]} disabled={disabled} onCommit={onParam} />
            </div>
          ))
        )}
      </div>
      {dirty && !disabled && (
        <a className="paramsbar-apply" onClick={onApply}>
          套用 · 重生 ▸
        </a>
      )}
    </div>
  );
}
