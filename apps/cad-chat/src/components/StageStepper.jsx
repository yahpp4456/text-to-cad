import React from "react";

export const STAGES = [
  ["理解", "UNDERSTAND"],
  ["規劃", "PLAN"],
  ["生成", "GENERATE"],
  ["驗證", "VALIDATE"],
  ["呈現", "PRESENT"],
];

// 草模模式只有 3 段(emit_stage 索引 0-2;段數差異本身就是模式訊號)
export const STAGES_SKETCH = [
  ["理解", "UNDERSTAND"],
  ["搭建", "COMPOSE"],
  ["演示", "PLAY"],
];

export default function StageStepper({ stageIdx, mode }) {
  const stages = mode === "sketch" ? STAGES_SKETCH : STAGES;
  return (
    <div className="stepper">
      {stages.map(([cn, en], i) => {
        const state = i < stageIdx ? "done" : i === stageIdx ? "cur" : "pending";
        return (
          <div className="step" key={en}>
            <span className="step-num" data-state={state}>
              {state === "done" ? "✓" : i + 1}
            </span>
            <div className="step-labels">
              <span className="step-cn" data-state={state}>
                {cn}
              </span>
              <span className="step-en">{en}</span>
            </div>
            <span className="step-spacer" />
            <span className="step-tick" />
          </div>
        );
      })}
    </div>
  );
}
