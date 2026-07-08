import React from "react";

import TypeBadge from "./TypeBadge.jsx";

export default function Header({
  phase,
  hasVersions,
  canvasType,
  canvasPartCount,
  onOpenFiles,
  onSaveProject,
  onNewChat,
  onOpenLessons,
  running,
}) {
  const dot =
    phase === "running" ? "var(--design)" : hasVersions ? "var(--part)" : "#a3acba";
  const label = phase === "running" ? "思考中" : hasVersions ? "完成" : "待命";
  return (
    <header className="hdr">
      <div className="hdr-left">
        <span className="hdr-mark">穗</span>
        <span className="hdr-divider" />
        <div className="hdr-titles">
          <span className="hdr-eyebrow">SUIYAO · CONVERSATIONAL CAD</span>
          <h1 className="hdr-title">對話式 CAD 產圖</h1>
        </div>
      </div>
      <div className="hdr-right">
        <TypeBadge type={canvasType} partCount={canvasPartCount} />
        {onNewChat && (
          <a
            className="hdr-btn"
            data-disabled={running || undefined}
            onClick={running ? undefined : onNewChat}
            title={running ? "回合進行中,結束後才能開新對話" : "清空對話與畫布,開一個新檔"}
          >
            ＋ 新對話
          </a>
        )}
        {onSaveProject && (
          <a className="hdr-btn" onClick={onSaveProject} title="把目前產物存成 models/ 下的具名專案">
            ⤓ 另存專案
          </a>
        )}
        {onOpenFiles && (
          <a className="hdr-btn" onClick={onOpenFiles}>
            ⌸ 開啟檔案
          </a>
        )}
        {onOpenLessons && (
          <a className="hdr-btn" onClick={onOpenLessons} title="歷史失敗蒸餾成的教訓(自我演化)">
            📚 教訓
          </a>
        )}
        <span className="status-pill">
          <span className="status-dot" style={{ background: dot }} />
          {label}
        </span>
        <span className="session-tag">session · local</span>
      </div>
    </header>
  );
}
