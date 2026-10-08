import React from "react";

import { isDemoAllowedMode, MODE_LABELS } from "../lib/chatModes.js";

// 模式切換器(Header 正中央,放大版 fold-switch):「草模」快速機構示意、
// 「設計」真幾何 CAD、「無塵電纜」電纜組專門設計鏈、「零件庫」對話式收 STP/查庫
// (分隔線隔開——創作組 vs 管理組)。mode 是 session 出生時的恆定屬性——切換時
// 若已有對話內容,由 App 端 confirm 後開新對話;running 期間鎖定。
// demo:不開放的模式(lib/chatModes DEMO_HIDDEN_MODES,目前除「設計」外全藏)整段
// 不渲染——這是「藏」不是「禁用」:展示身分只看設計一條線。分隔線跟著零件庫走
// (它只隔創作組 vs 管理組,管理組不出就沒有分隔的對象)。安全邊界在 server。
export default function ModeSwitch({ mode, running, onSwitch, demo = false }) {
  const show = (key) => !demo || isDemoAllowedMode(key);
  const seg = (key, cn, en, icon) => (
    <a
      className="mode-seg"
      data-on={mode === key}
      data-mode={key}
      onClick={running || mode === key ? undefined : () => onSwitch(key)}
    >
      <span className="mode-cn">
        {icon} {cn}
      </span>
      <span className="mode-en">{en}</span>
    </a>
  );
  return (
    <div
      className="mode-switch"
      role="group"
      aria-label="模式切換"
      data-disabled={running || undefined}
      title={
        running
          ? "回合進行中,結束後才能切換模式"
          : [
              show("sketch") && "草模=快速機構運動示意",
              "設計=真幾何 CAD",
              show("cable") && "無塵電纜=電纜組長寬高參數化重建",
              show("library") && "零件庫=收 STP 進庫/查庫",
            ]
              .filter(Boolean)
              .join(";") + (demo ? "" : "(切換會開新對話)")
      }
    >
      {show("sketch") && seg("sketch", MODE_LABELS.sketch, "SKETCH", "✎")}
      {seg("design", MODE_LABELS.design, "DESIGN", "⬡")}
      {show("cable") && seg("cable", MODE_LABELS.cable, "CABLE", "⌒")}
      {show("library") && <span className="mode-divider" />}
      {show("library") && seg("library", MODE_LABELS.library, "LIBRARY", "⬢")}
    </div>
  );
}
