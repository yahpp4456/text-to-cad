import React, { useRef, useState } from "react";

import { isAssumedChip, stripAssumedTag } from "../../lib/clarifyText.js";

// 規格 chips 的共用編輯器:ClarifyWizard 步驟 1 與視圖 SpecPanel 共用(聊天卡是
// 被動紀錄,不用這支)。edits 受控({k: 新值},空物件=無修正);inline 輸入態自持,
// 提交語意:Enter / ✓ / 失焦(blur)三者都算確認,Escape 取消。失焦提交是 2026-09-23
// 的修法——之前只認 Enter/✓,使用者打完值直接點「確認規格 →」時精靈換步卸載,
// 草稿靜默丟掉,送出的只剩選項原文(內嵌 AI 原值),第一次建模仍用舊值。
// editableAll:精靈只允許改「假設」值(確認值來自使用者輸入,不該在答題中改);
// SpecPanel 全部可改(事後修正=變更請求,不限假設值)。
export default function SpecChips({ specs, edits, onEdits, editableAll = false, readOnly = false }) {
  const [editing, setEditing] = useState(null); // { k, draft } inline 輸入中
  // 本次 inline 編輯是否已收尾(提交或取消)。失焦即提交(onBlur)之後,Enter/Escape/✓
  // 收尾時輸入框卸載仍可能補一次 blur——不得再提交一次(Escape 取消會被翻成提交、
  // ✓ 的空草稿會把剛提交的值刪掉),用 ref 擋而非 state:blur 走的是舊 render 的閉包。
  const doneRef = useRef(true);

  const startEdit = (c, shown) => {
    doneRef.current = false;
    setEditing({ k: c.k, draft: shown });
  };

  // commit=false 是 Escape 取消:草稿丟棄、edits 不動。
  const finishEdit = (c, commit) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) {
      const draft = String(editing?.draft ?? "").trim();
      const orig = stripAssumedTag(c.v);
      const next = { ...edits };
      // 空值或改回原值 = 取消這筆修正
      if (!draft || draft === orig) delete next[c.k];
      else next[c.k] = draft;
      onEdits(next);
    }
    setEditing(null);
  };

  return (
    <div className="cw-chips">
      {specs.map((c, i) => {
        const assumed = isAssumedChip(c);
        const edited = c.k in edits;
        // edited 也算 editable:精靈接手 SpecPanel 轉交的草稿時,非 assumed 的
        // 「已修正」chip 也要能點開回退(改回原值即取消該筆修正)。
        // readOnly(回合進行中)一律關閉:光靠 editableAll=false 不夠,assumed/edited
        // chip 仍會可點——這裡短路才真正靜態化(onClick/✎/data-editable/inline 全歸零)。
        const editable = !readOnly && (editableAll || assumed || edited);
        const shown = edited ? edits[c.k] : stripAssumedTag(c.v);
        if (editing?.k === c.k && !readOnly) {
          return (
            <span className="cw-chip" data-editing="true" key={i}>
              <span className="chip-k">{c.k}</span>
              <input
                className="cw-chip-input"
                autoFocus
                value={editing.draft}
                onChange={(e) => setEditing({ k: c.k, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishEdit(c, true);
                  if (e.key === "Escape") finishEdit(c, false);
                }}
                // 失焦即提交:打完直接點「確認規格 →」/「套用」/別的 chip 都算確認,
                // 否則精靈換步卸載時未按 Enter 的草稿會靜默丟掉(使用者以為改了 1500,
                // 送出的卻是選項原文內嵌的舊值)。
                onBlur={() => finishEdit(c, true)}
              />
              {/* mousedown 攔掉焦點轉移:不然點 ✓ 會先 blur 提交、再由 ✓ 走一次收尾 */}
              <a
                className="cw-chip-ok"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => finishEdit(c, true)}
              >
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
            data-editable={editable || undefined}
            data-edited={edited || undefined}
            onClick={editable ? () => startEdit(c, shown) : undefined}
          >
            <span className="chip-k">{c.k}</span>
            <span className="chip-v">{shown}</span>
            {edited ? (
              <span className="chip-assumed edited">已修正</span>
            ) : (
              assumed && <span className="chip-assumed">假設</span>
            )}
            {editable && <span className="chip-edit">✎</span>}
          </a>
        );
      })}
    </div>
  );
}
