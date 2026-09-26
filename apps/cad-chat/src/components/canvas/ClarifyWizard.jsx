import React, { useState } from "react";

import { composeClarifyReply } from "../../lib/clarifyText.js";
import SpecChips from "./SpecChips.jsx";

// 視圖區聚光燈卡的兩步精靈:步驟 1 確認/修改解析規格(chips 編輯器抽共用
// SpecChips;僅 assumed chip 可 inline 編輯,修改累積在 local state)→ 步驟 2
// 澄清選項;所有送出走 composeClarifyReply 把修改與答案併成一則人話回覆
// (「規格修正:」前綴是 prompt 契約:個別修正優先於選項內嵌值)。
// 無 specs 的 clarify(如結合流程提問)退化成單步。step/edits 刻意不進 store——
// 父層以 key={clarify.id} 管生命週期,跨回合新 clarify 自動 remount 歸零。
//
// 步驟 2 版面(2026-09-26 重設計):
//   ① 你改過的值(優先套用)——說明它會蓋掉選項/建議裡的同名值(以前 150 N 與
//      建議組合裡的 100 N 並排出現,使用者不知道哪個算數);
//   ② 選項列:label 當標題、value 當說明(prompt 規定 value 要寫完整人話內容,
//      以前只顯示 label,「輕負載精巧型」裡面是什麼看不到);
//   ③ 一顆主按鈕「照 AI 建議組合」——有修改時併掉舊的「僅套用修正,其餘照建議」
//      (兩者送出的回覆語意本來就相同),動作從五個收成三類:選項 / 建議 / 返回。
// 選擇器契約(煙測/其他面板依賴,勿改名):.canvas-clarify-opt、.canvas-clarify-suggest、
// .cw-fixes-only(有修改才存在)、.cw-edited(含「k 改為 v」)、.cw-back、.cw-steps。

// label 尾的「(建議)」改成 badge 呈現(送出的 value 不受影響)。
const RECOMMEND_RE = /\s*[(（]\s*(?:AI\s*)?建議\s*[)）]\s*$/;

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
  const opts = clarify.opts || [];
  const suggested = clarify.suggested || "";

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
            <span className="cw-hint">標「假設」的值可點擊修改(離開欄位或按 Enter 即確認);確認後才進入選項。</span>
            <a className="cw-confirm" onClick={() => setStep(2)}>
              確認規格 →
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="canvas-clarify-q">{clarify.q}</p>

          {editCount > 0 && (
            <div className="cw-edits">
              <span className="cw-section">你改過的值 · 優先套用</span>
              <div className="cw-edits-list">
                {Object.entries(edits).map(([k, v]) => (
                  <span key={k} className="cw-edited">
                    {k} 改為 <b>{v}</b>
                  </span>
                ))}
              </div>
              <span className="cw-edits-note">
                下方選項或建議組合裡若有同名項目,以你改的值為準。
              </span>
            </div>
          )}

          {opts.length > 0 && (
            <div className="cw-block">
              <span className="cw-section">
                {suggested ? "選一個配置" : "選一個"}
              </span>
              <div className="canvas-clarify-opts">
                {opts.map((op, i) => {
                  const label = String(op.label || "");
                  const recommended = RECOMMEND_RE.test(label) || (!!suggested && op.value === suggested);
                  const title = label.replace(RECOMMEND_RE, "") || label;
                  const desc = op.value && op.value !== op.label ? op.value : "";
                  return (
                    <a
                      key={i}
                      className="canvas-clarify-opt"
                      data-recommended={recommended || undefined}
                      onClick={() => submit(op.value || op.label)}
                    >
                      <span className="cw-opt-title">
                        {title}
                        {recommended && <span className="cw-badge">AI 建議</span>}
                      </span>
                      {desc && <span className="cw-opt-desc">{desc}</span>}
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {suggested && (
            <div className="cw-block">
              {opts.length > 0 && <span className="cw-or">或</span>}
              {/* 有修改:同一顆按鈕就是「套用修正 + 其餘照建議」(送 submit(null),
                  合成「規格修正:…其餘採用建議:…」);無修改:原樣送 suggested。 */}
              <a
                className={"canvas-clarify-suggest" + (editCount > 0 ? " cw-fixes-only" : "")}
                onClick={() => submit(editCount > 0 ? null : suggested)}
              >
                <span className="cw-suggest-title">
                  ✦ {editCount > 0 ? "套用我改的值,其餘照 AI 建議組合" : "照 AI 建議組合進行"} →
                </span>
                <span className="cw-suggest-desc">{suggested}</span>
              </a>
            </div>
          )}

          {!suggested && editCount > 0 && (
            <div className="cw-block">
              {opts.length > 0 && <span className="cw-or">或</span>}
              <a className="canvas-clarify-suggest cw-fixes-only" onClick={() => submit(null)}>
                <span className="cw-suggest-title">✦ 只套用我改的值,其餘由 AI 決定 →</span>
              </a>
            </div>
          )}

          {hasSpecs && (
            <a className="cw-back" onClick={() => setStep(1)}>
              ← 返回修改規格
            </a>
          )}
        </>
      )}
    </div>
  );
}
