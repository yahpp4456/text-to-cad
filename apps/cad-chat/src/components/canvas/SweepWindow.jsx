import React, { useMemo } from "react";

import NumberField from "../NumberField.jsx";
import {
  fitViewBox,
  loopsToPathD,
  polylineToPathD,
  projectPathTo2D,
  sampleDragChain,
  sampleLine,
} from "@/lib/sweepView";

// 掃出工作窗(蓋在 3D 上的浮動雙欄視窗;觸發=視圖左上「⟜ 掃出」chip):
// 左半=路徑 2D 圖(baked=sidecar 灰虛線;live=現值即時取樣)+ 路徑參數
// NumberField(改值即時重畫,按套用才真重生 3D);右半=輪廓 2D 剖面(唯讀,
// fill-rule evenodd 鏤空內腔)+ 輪廓參數唯讀 chips +「用對話修改輪廓」
// (prefill,輪廓只能透過 chat 改)。
// props:view=sidecar 的 view、paths=sidecar 的 paths、params=全域 params 切片
// (共享 dirty;套用=App.applyParams 送全份 values,server 磁碟墊底 merge 保底)。
export default function SweepWindow({
  view,
  paths,
  params,
  disabled,
  onParam,
  onApply,
  onClose,
  onChatProfile,
}) {
  const { defs, values, dirty } = params;
  const pathDefs = (view.pathParams || [])
    .map((k) => defs.find((d) => d.key === k))
    .filter(Boolean);

  // baked:sidecar 世界點 → (d,e) 平面(套用後隨新 sidecar 重derive)
  const baked = useMemo(
    () => projectPathTo2D(paths?.[0]?.points || []),
    [paths],
  );
  // live:現值即時取樣(僅解析式 pathKind;其他 kind 隱藏 live 層)
  const live = useMemo(() => {
    if (view.pathKind === "drag_chain") return sampleDragChain(values, 96);
    if (view.pathKind === "line") return sampleLine(values, 96);
    return null;
  }, [view.pathKind, values]);
  const liveSupported = view.pathKind === "drag_chain" || view.pathKind === "line";

  const pathBox = fitViewBox([baked, ...(live ? [live] : [])]);
  const profBox = fitViewBox(view.profileLoops || []);
  const profD = loopsToPathD(view.profileLoops || []);

  const chipText = (p) => `${p.key}=${p.value}${p.unit ? ` ${p.unit}` : ""}`;

  return (
    <div className="sweep-window">
      <div className="sweepwin-head">
        <span className="sweepwin-title">⟜ 掃出工作窗</span>
        <a className="sweepwin-close" onClick={onClose}>
          ✕
        </a>
      </div>
      <div className="sweepwin-body">
        <div className="sweepwin-col sweepwin-path">
          <span className="sweepwin-eyebrow">PATH · 路徑</span>
          <span className="sweepwin-hint">
            {liveSupported ? "改值即時預覽 · 按套用才重生 3D" : "此路徑型式僅套用後更新預覽"}
          </span>
          <svg className="sweepwin-svg" viewBox={pathBox} preserveAspectRatio="xMidYMid meet">
            {baked.length >= 2 && (
              <path className="sweepwin-baked" d={polylineToPathD(baked)} />
            )}
            {live && <path className="sweepwin-live" d={polylineToPathD(live)} />}
          </svg>
          <div className="sweepwin-fields">
            {pathDefs.map((d) => (
              <div className="param param-num" key={d.key}>
                <span className="param-label">{d.label}</span>
                <NumberField def={d} value={values[d.key]} disabled={disabled} onCommit={onParam} />
              </div>
            ))}
          </div>
          {dirty && !disabled && (
            <a className="sweepwin-apply" onClick={onApply}>
              套用 · 重生 ▸
            </a>
          )}
        </div>
        <div className="sweepwin-col sweepwin-profile">
          <span className="sweepwin-eyebrow">PROFILE · 輪廓(唯讀)</span>
          <span className="sweepwin-hint">輪廓修改請用對話描述</span>
          <svg className="sweepwin-svg" viewBox={profBox} preserveAspectRatio="xMidYMid meet">
            {profD && <path className="sweepwin-prof" d={profD} fillRule="evenodd" />}
          </svg>
          <div className="sweepwin-chips">
            {(view.profileParams || []).map((p) => (
              <span className="sweepwin-chip" key={p.key}>
                {chipText(p)}
              </span>
            ))}
          </div>
          <a
            className="sweepwin-chat"
            onClick={() =>
              onChatProfile(
                `修改掃出輪廓(目前 ${(view.profileParams || []).map(chipText).join("、")}):`,
              )
            }
          >
            💬 用對話修改輪廓
          </a>
        </div>
      </div>
    </div>
  );
}
