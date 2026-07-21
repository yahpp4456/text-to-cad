import React from "react";

import { DEMO_TIP } from "../lib/demo.js";
import ModeSwitch from "./ModeSwitch.jsx";
import TypeBadge from "./TypeBadge.jsx";

// demo(展示身分):另存專案/開啟檔案/教訓三鈕**照常渲染但禁用**(不是藏)——
// 讓展示者看得到產品有這些功能,只是這個身分不開放。安全邊界仍在 server 的
// demoGuard(403),這裡純 UX。「＋ 新對話」對 demo 開放,不受影響。
export default function Header({
  demo = false,
  phase,
  hasVersions,
  canvasType,
  canvasPartCount,
  mode,
  onSwitchMode,
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
      {/* 模式切換器:Header 正中央(絕對置中,不擠佔左右功能區) */}
      {onSwitchMode && <ModeSwitch mode={mode} running={running} onSwitch={onSwitchMode} />}
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
          <a
            className="hdr-btn"
            data-disabled={demo || undefined}
            onClick={demo ? undefined : onSaveProject}
            title={demo ? DEMO_TIP : "把目前產物存成 models/ 下的具名專案"}
          >
            ⤓ 另存專案
          </a>
        )}
        {onOpenFiles && (
          <a
            className="hdr-btn"
            data-disabled={demo || undefined}
            onClick={demo ? undefined : onOpenFiles}
            title={demo ? DEMO_TIP : undefined}
          >
            ⌸ 開啟檔案
          </a>
        )}
        {onOpenLessons && (
          <a
            className="hdr-btn"
            data-disabled={demo || undefined}
            onClick={demo ? undefined : onOpenLessons}
            title={demo ? DEMO_TIP : "歷史失敗蒸餾成的教訓(自我演化)"}
          >
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
