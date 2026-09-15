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

// 無塵電纜模式 5 段:工作台動線(選範本→填規格→生成)取代通用的「理解/規劃」,
// 因為 cable 的主線是零 LLM 表單生成,不是對話推進。
export const STAGES_CABLE = [
  ["選範本", "TEMPLATE"],
  ["填規格", "SPEC"],
  ["生成", "GENERATE"],
  ["驗證", "VALIDATE"],
  ["呈現", "PRESENT"],
];

// 零件庫模式 3 段(對齊 prompt.library 的收庫流程)
export const STAGES_LIBRARY = [
  ["選檔", "PICK"],
  ["訪談", "INTERVIEW"],
  ["收庫", "ARCHIVE"],
];

export default function StageStepper({ stageIdx, mode }) {
  const stages =
    mode === "sketch"
      ? STAGES_SKETCH
      : mode === "library"
        ? STAGES_LIBRARY
        : mode === "cable"
          ? STAGES_CABLE
          : STAGES;
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
