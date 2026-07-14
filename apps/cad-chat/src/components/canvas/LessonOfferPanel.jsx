import React from "react";

// 視圖區教訓「是/否」面板——lesson_offer 的唯一作答面(聊天卡是被動紀錄)。
// offer 由 App 用 pendingLessonOffer 取「最舊未答」(佇列語意:多張未答依序輪答,
// 答完自動出下一張)。answered:"pending" = POST 進行中(App handler 樂觀收鈕),
// 面板留在原卡顯示進度;防雙擊守衛也在 App handler(lessonOfferBusyRef)。
export default function LessonOfferPanel({ offer, onLessonOffer }) {
  const pending = offer.answered === "pending";
  return (
    <div className="canvas-offer">
      <span className="canvas-offer-kicker">✎ 要把這件事加入教訓嗎?</span>
      <div className="lesson-offer-body">
        {offer.symptom && (
          <span className="lesson-offer-line">
            <b>症狀</b> {offer.symptom}
          </span>
        )}
        {offer.fix && (
          <span className="lesson-offer-line">
            <b>修法</b> {offer.fix}
          </span>
        )}
      </div>
      {pending ? (
        <div className="lesson-offer-done" data-outcome="pending">
          加入中…
        </div>
      ) : (
        <div className="lesson-offer-actions">
          <a
            className="fb-action primary"
            onClick={() =>
              onLessonOffer?.(offer.id, "added", {
                symptom: offer.symptom,
                rootCause: offer.rootCause,
                fix: offer.fix,
                tag: offer.tag,
              })
            }
          >
            是,加入教訓
          </a>
          <a className="fb-action" onClick={() => onLessonOffer?.(offer.id, "skipped")}>
            否
          </a>
        </div>
      )}
    </div>
  );
}
