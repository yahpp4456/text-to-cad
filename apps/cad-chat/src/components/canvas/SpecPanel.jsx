import React, { useEffect, useState } from "react";

import { composeClarifyReply } from "../../lib/clarifyText.js";
import SpecChips from "./SpecChips.jsx";

// 視圖區「解析規格」面板——規格修正的唯一作答面(聊天 spec 卡是被動紀錄)。
// 資料源:transcript 最新 spec 卡(App 用 latestSpecItem 取,父層 key=item.id →
// 新規格到達即 remount,edits/收合歸零)。全部 chip 可改(事後修正=變更請求,
// 不限「假設」值);套用走 composeClarifyReply 的「規格修正:」prompt 契約——
// 回合進行中送出由 useChatStream 佇列接手,回合結束自動送。clarify 待答時由
// 父層隱藏(精靈步驟 1 就是規格確認面,不重複)。
export default function SpecPanel({ spec, onSubmitText, onEditsChange }) {
  const [open, setOpen] = useState(true);
  const [edits, setEdits] = useState({}); // { [k]: newV }
  // mount(含讓位後重掛)即把上游草稿 ref 對齊本地空 edits:上一輪轉交給精靈的
  // 草稿已被消費,不清的話下一個同鍵 clarify 會把送過的修正重複 seed 回精靈。
  useEffect(() => {
    onEditsChange?.(spec?.id, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chips = spec?.chips || [];
  const editCount = Object.keys(edits).length;
  if (!chips.length) return null;

  // 草稿同步上報 App(specDraftRef):clarify 到達會令本面板讓位卸載,未套用的
  // 修正由精靈步驟 1 接手續用,不靜默蒸發。
  const updateEdits = (next) => {
    setEdits(next);
    onEditsChange?.(spec.id, next);
  };

  const apply = async () => {
    const ok = await onSubmitText?.(composeClarifyReply({ edits }));
    // submitText 同步早退(附件上傳中/唯讀升級失敗)回 false → 保留 edits 供重試,
    // 否則修正一字未送就被清空。
    if (ok === false) return;
    updateEdits({});
  };

  return (
    <div className="canvas-spec" data-open={open}>
      <a className="canvas-spec-head" onClick={() => setOpen((v) => !v)}>
        <span className="canvas-spec-kicker">◈ 解析規格</span>
        <span className="canvas-spec-count">{chips.length}</span>
        <span className="canvas-spec-caret">{open ? "▾" : "▸"}</span>
      </a>
      {open && (
        <>
          <SpecChips specs={chips} edits={edits} onEdits={updateEdits} editableAll />
          <div className="cw-foot">
            {editCount > 0 ? (
              <a className="cw-confirm" onClick={apply}>
                套用修正({editCount})→
              </a>
            ) : (
              <span className="cw-hint">點任一值即可修改;套用後按修正重生。</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
