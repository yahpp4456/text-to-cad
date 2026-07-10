import React, { useState } from "react";

import { composeClarifyReply, isAssumedChip, stripAssumedTag } from "../../lib/clarifyText.js";

// 視圖區聚光燈卡的兩步精靈:步驟 1 確認/修改解析規格(僅 assumed chip 可 inline 編輯,
// 修改累積在 local state)→ 步驟 2 澄清選項;所有送出走 composeClarifyReply 把修改與
// 答案併成一則人話回覆(「規格修正:」前綴是 prompt 契約:個別修正優先於選項內嵌值)。
// 無 specs 的 clarify(如結合流程提問)退化成單步。step/edits 刻意不進 store——
// 父層以 key={clarify.id} 管生命週期,跨回合新 clarify 自動 remount 歸零。
export default function ClarifyWizard({ clarify, onSubmitText }) {
  const specs = clarify.specs || [];
  const hasSpecs = specs.length > 0;
  const [step, setStep] = useState(hasSpecs ? 1 : 2);
  const [edits, setEdits] = useState({}); // { [k]: newV }
  const [editing, setEditing] = useState(null); // { k, draft } inline 輸入中
  const editCount = Object.keys(edits).length;

  const submit = (answer) =>
    onSubmitText?.(composeClarifyReply({ edits, answer, suggested: clarify.suggested }));

  const confirmEdit = (c) => {
    const draft = String(editing?.draft ?? "").trim();
    const orig = stripAssumedTag(c.v);
    setEdits((prev) => {
      const next = { ...prev };
      // 空值或改回原值 = 取消這筆修正
      if (!draft || draft === orig) delete next[c.k];
      else next[c.k] = draft;
      return next;
    });
    setEditing(null);
  };

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
          <div className="cw-chips">
            {specs.map((c, i) => {
              const assumed = isAssumedChip(c);
              const edited = c.k in edits;
              const shown = edited ? edits[c.k] : stripAssumedTag(c.v);
              if (editing?.k === c.k) {
                return (
                  <span className="cw-chip" data-assumed="true" key={i}>
                    <span className="chip-k">{c.k}</span>
                    <input
                      className="cw-chip-input"
                      autoFocus
                      value={editing.draft}
                      onChange={(e) => setEditing({ k: c.k, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") confirmEdit(c);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <a className="cw-chip-ok" onClick={() => confirmEdit(c)}>
                      ✓
                    </a>
                  </span>
                );
              }
              return (
                <a
                  className="cw-chip"
                  key={i}
                  data-assumed={assumed || undefined}
                  data-edited={edited || undefined}
                  onClick={assumed ? () => setEditing({ k: c.k, draft: shown }) : undefined}
                >
                  <span className="chip-k">{c.k}</span>
                  <span className="chip-v">{shown}</span>
                  {edited ? (
                    <span className="chip-assumed edited">已修正</span>
                  ) : (
                    assumed && <span className="chip-assumed">假設</span>
                  )}
                  {assumed && <span className="chip-edit">✎</span>}
                </a>
              );
            })}
          </div>
          <div className="cw-foot">
            <span className="cw-hint">標「假設」的值可點擊修改;確認後才進入選項。</span>
            <a
              className="cw-confirm"
              onClick={() => {
                setEditing(null);
                setStep(2);
              }}
            >
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
