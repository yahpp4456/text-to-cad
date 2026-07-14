import React, { useState } from "react";

import { composeClarifyReply } from "../../lib/clarifyText.js";
import SpecChips from "./SpecChips.jsx";

// 視圖區聚光燈卡的兩步精靈:步驟 1 確認/修改解析規格(chips 編輯器抽共用
// SpecChips;僅 assumed chip 可 inline 編輯,修改累積在 local state)→ 步驟 2
// 澄清選項;所有送出走 composeClarifyReply 把修改與答案併成一則人話回覆
// (「規格修正:」前綴是 prompt 契約:個別修正優先於選項內嵌值)。
// 無 specs 的 clarify(如結合流程提問)退化成單步。step/edits 刻意不進 store——
// 父層以 key={clarify.id} 管生命週期,跨回合新 clarify 自動 remount 歸零。
export default function ClarifyWizard({ clarify, onSubmitText, initialEdits }) {
  const specs = clarify.specs || [];
  const hasSpecs = specs.length > 0;
  const [step, setStep] = useState(hasSpecs ? 1 : 2);
  // initialEdits = SpecPanel 讓位時轉交的未套用草稿(clarify 到達即卸載面板;
  // 沒有轉交則使用者剛改的值靜默蒸發)。只收本份規格有的鍵,防殘稿汙染。
  const [edits, setEdits] = useState(() => {
    const keys = new Set(specs.map((c) => c?.k));
    return Object.fromEntries(
      Object.entries(initialEdits || {}).filter(([k]) => keys.has(k)),
    );
  });
  const editCount = Object.keys(edits).length;

  const submit = (answer) =>
    onSubmitText?.(composeClarifyReply({ edits, answer, suggested: clarify.suggested }));

  return (
    <div className="canvas-clarify">
      <div className="cw-head">
        <span className="canvas-clarify-kicker">◈ 需要你決定</span>
        {hasSpecs && (
          <span className="cw-steps">
            步驟 {step}/2 · {step === 1 ? "確認解析規格" : "選擇配置"}
          </span>
        )}
      </div>

      {step === 1 ? (
        <>
          {/* 換步即卸載 SpecChips → 未確認的 inline 草稿自然丟棄(舊行為) */}
          <SpecChips specs={specs} edits={edits} onEdits={setEdits} />
          <div className="cw-foot">
            <span className="cw-hint">標「假設」的值可點擊修改;確認後才進入選項。</span>
            <a className="cw-confirm" onClick={() => setStep(2)}>
              確認規格 →
            </a>
          </div>
        </>
      ) : (
        <>
          {editCount > 0 && (
            <span className="cw-edited">
              已修正:
              {Object.entries(edits)
                .map(([k, v]) => `${k} 改為 ${v}`)
                .join(";")}
            </span>
          )}
          <p className="canvas-clarify-q">{clarify.q}</p>
          {(clarify.opts || []).length > 0 && (
            <div className="canvas-clarify-opts">
              {clarify.opts.map((op, i) => (
                <a
                  key={i}
                  className="canvas-clarify-opt"
                  onClick={() => submit(op.value || op.label)}
                >
                  {op.label}
                </a>
              ))}
            </div>
          )}
          {clarify.suggested && (
            <a className="canvas-clarify-suggest" onClick={() => submit(clarify.suggested)}>
              ✦ 用建議組合:{clarify.suggested}
            </a>
          )}
          {editCount > 0 && (
            <a className="cw-fixes-only" onClick={() => submit(null)}>
              僅套用修正,其餘照建議 →
            </a>
          )}
          {hasSpecs && (
            <a className="cw-back" onClick={() => setStep(1)}>
              ← 返回規格
            </a>
          )}
        </>
      )}
    </div>
  );
}
