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
  onSave = null, // 就地儲存(綁定專案且可儲存時才給;null = 不渲染)
  saving = false,
  project = null, // {dir:"models/x", state:"dirty"|"saved", stateText}(lib/projectState.projectChipLabel)
  onNewChat,
  onOpenLessons,
  running,
}) {
  const saveBlocked = demo || saving || running;
  const saveTitle = demo
    ? DEMO_TIP
    : running
      ? "回合進行中,結束後再儲存"
      : `儲存到 ${project?.dir || "專案目錄"}/(Ctrl+S / ⌘S)`;
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
        {/* 專案 chip(綁定了才出;dirty/saved 兩態,文字單一真相在 lib/projectState)。
            放左側標題旁(像文件標題列):右側群組已滿,再塞 200px 會壓進置中的切換器。 */}
        {project && (
          <span
            className="proj-chip"
            data-state={project.state}
            title={
              project.state === "dirty"
                ? `最新版尚未寫回 ${project.dir}/——按「儲存」或 Ctrl+S`
                : `工作區與 ${project.dir}/ 一致`
            }
          >
            <span className="proj-chip-dir">{project.dir}</span>
            <span className="proj-chip-sep">·</span>
            <span className="proj-chip-state">{project.stateText}</span>
          </span>
        )}
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
        {/* 儲存鈕:標籤固定寬(儲存中只變 data-busy),右側群組每多 20px 就更貼近切換器 */}
        {onSave && (
          <a
            className="hdr-btn hdr-save"
            data-disabled={saveBlocked || undefined}
            data-busy={saving || undefined}
            onClick={saveBlocked ? undefined : onSave}
            title={saving ? "儲存中…" : saveTitle}
          >
            ⤓ 儲存
          </a>
        )}
        {onSaveProject && (
          <a
            className="hdr-btn"
            data-disabled={demo || undefined}
            onClick={demo ? undefined : onSaveProject}
            title={demo ? DEMO_TIP : "把目前產物存成 models/ 下的具名專案"}
          >
            {mode === "cable" ? "⤓ 另存案件" : "⤓ 另存專案"}
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
        {/* 綁定專案時讓位給右側儲存鈕(1480px 寬右側群組本就只剩 4px 才碰到置中切換器);
            chip 已標明這條 session 綁在哪個 models 目錄,「session · local」沒有新資訊 */}
        {!project && <span className="session-tag">session · local</span>}
      </div>
    </header>
  );
}
