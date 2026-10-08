import React, { useEffect, useState } from "react";

import { apiUrl } from "@/lib/apiBase";

// DEMO 進場詢問:要不要先看 30 秒「設計模式」介紹影片。
// 兩階段:ask(觀看/略過)→ play(內嵌 <video> + 關閉)。任何一個出口都算「看過」
// (由 App 記 localStorage,不再問);Escape 等同關閉。影片來源 /api/demo-intro.mp4
// (server Range 串流);只有 /api/health 回 introVideo:true 才會被掛出來。
export const INTRO_VIDEO_SRC = "/api/demo-intro.mp4";

export default function DemoIntroDialog({ open, onClose }) {
  const [stage, setStage] = useState("ask");
  useEffect(() => {
    if (!open) return undefined;
    setStage("ask");
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fb-overlay intro-overlay" onClick={onClose}>
      <div
        className={`save-dialog intro-dialog${stage === "play" ? " intro-playing" : ""}`}
        data-stage={stage}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="save-eyebrow">DEMO · 設計模式介紹</span>
        {stage === "ask" ? (
          <>
            <p className="confirm-msg">
              歡迎體驗穗鈅對話式 CAD。要先看 30 秒的「設計模式」介紹影片嗎?
            </p>
            <p className="save-hint">
              影片示範從一句需求到可下載 STEP 的完整流程;略過也可以隨時直接開始。
            </p>
            <div className="save-actions">
              <a className="save-btn save-cancel" onClick={onClose}>
                略過
              </a>
              <a className="save-btn" onClick={() => setStage("play")}>
                ▶ 觀看
              </a>
            </div>
          </>
        ) : (
          <>
            <video
              className="intro-video"
              src={apiUrl(INTRO_VIDEO_SRC)}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onEnded={onClose}
            />
            <div className="save-actions">
              <a className="save-btn" onClick={onClose}>
                開始使用
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
