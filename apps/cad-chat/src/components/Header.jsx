import React from "react";

import TypeBadge from "./TypeBadge.jsx";

export default function Header({ phase, hasVersions, canvasType, canvasPartCount, onOpenFiles }) {
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
        {onOpenFiles && (
          <a className="hdr-btn" onClick={onOpenFiles}>
            ⌸ 開啟檔案
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
