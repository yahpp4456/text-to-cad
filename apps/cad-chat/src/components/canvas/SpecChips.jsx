import React, { useState } from "react";

import { isAssumedChip, stripAssumedTag } from "../../lib/clarifyText.js";

// 規格 chips 的共用編輯器:ClarifyWizard 步驟 1 與視圖 SpecPanel 共用(聊天卡是
// 被動紀錄,不用這支)。edits 受控({k: 新值},空物件=無修正);inline 輸入態自持,
// 卸載(精靈換步/新規格 remount)即丟棄未確認草稿——與抽出前的精靈行為一致。
// editableAll:精靈只允許改「假設」值(確認值來自使用者輸入,不該在答題中改);
// SpecPanel 全部可改(事後修正=變更請求,不限假設值)。
export default function SpecChips({ specs, edits, onEdits, editableAll = false, readOnly = false }) {
  const [editing, setEditing] = useState(null); // { k, draft } inline 輸入中

  const confirmEdit = (c) => {
    const draft = String(editing?.draft ?? "").trim();
    const orig = stripAssumedTag(c.v);
    const next = { ...edits };
    // 空值或改回原值 = 取消這筆修正
    if (!draft || draft === orig) delete next[c.k];
    else next[c.k] = draft;
    onEdits(next);
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
            data-editable={editable || undefined}
            data-edited={edited || undefined}
            onClick={editable ? () => setEditing({ k: c.k, draft: shown }) : undefined}
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
