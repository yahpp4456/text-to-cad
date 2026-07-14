import React from "react";

// 草模模式的底欄滑桿(佔 ParamsBar 位、沿用其視覺文法),但語意完全不同:
// **純客端 scrub**——拖動即時擺姿態(無 server 往返、無 dirty、無「套用·重生」);
// 拖曳自動暫停播放;播放中 thumb 與數值跟著動畫走(values 由 SketchCanvas3D 的
// uiTick 節流餵入)。
export default function DofBar({ dofs = [], values = {}, disabled, onDrive }) {
  return (
    <div className="paramsbar" data-sketch="true">
      <div className="paramsbar-tag">
        <span className="bar bar-sketch" />
        <div className="paramsbar-titles">
          <span className="paramsbar-eyebrow">DOF</span>
          <span className="paramsbar-cn">驅動</span>
        </div>
      </div>
      <div className="paramsbar-track">
        {dofs.length === 0 ? (
          <span className="paramsbar-empty">草模產出後,驅動滑桿會出現在這裡(拖動即時擺姿態)</span>
        ) : (
          dofs.map((d) => {
            const v = Number.isFinite(values[d.id]) ? values[d.id] : d.home;
            const span = d.max - d.min;
            const step = span > 20 ? 0.5 : span > 2 ? 0.1 : 0.01;
            return (
              <div className="param" key={d.id}>
                <div className="param-head">
                  <span className="param-label">{d.label || d.id}</span>
                  <span className="param-value">
                    {Math.round(v * 10) / 10}
                    {d.unit ? ` ${d.unit}` : ""}
                  </span>
                </div>
                <input
                  type="range"
                  min={d.min}
                  max={d.max}
                  step={step}
                  value={v}
                  disabled={disabled}
                  onChange={(e) => onDrive?.(d.id, parseFloat(e.target.value))}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
