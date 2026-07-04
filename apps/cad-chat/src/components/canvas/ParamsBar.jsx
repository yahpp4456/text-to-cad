import React from "react";

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
            <div className="param" key={d.key}>
              <div className="param-head">
                <span className="param-label">{d.label}</span>
                <span className="param-value">
                  {values[d.key]}
                  {d.unit ? ` ${d.unit}` : ""}
                </span>
              </div>
              <input
                type="range"
                min={d.min}
                max={d.max}
                step={d.step}
                value={values[d.key]}
                disabled={disabled}
                onChange={(e) => onParam(d.key, parseFloat(e.target.value))}
              />
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
