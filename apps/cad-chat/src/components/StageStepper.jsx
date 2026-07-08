import React from "react";

export const STAGES = [
  ["理解", "UNDERSTAND"],
  ["規劃", "PLAN"],
  ["生成", "GENERATE"],
  ["驗證", "VALIDATE"],
  ["呈現", "PRESENT"],
];

export default function StageStepper({ stageIdx }) {
  return (
    <div className="stepper">
      {STAGES.map(([cn, en], i) => {
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
