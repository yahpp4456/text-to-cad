import assert from "node:assert/strict";
import test from "node:test";

import { DISALLOWED } from "./agent/runner.mjs";

// 2026-10-25:唯讀 Bash 在 SDK default 模式下不經 canUseTool 直接放行(實測 ls/grep/sed/wc 真執行),
// 守衛擋不到,只能從工具清單整個移除。這條釘住清單,別人日後「精簡」時不會把它拿掉。
test("DISALLOWED 必含 Bash 與 Write/Edit 家族(canUseTool 擋不到的工具)", () => {
  for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.ok(DISALLOWED.includes(t), `DISALLOWED 缺 ${t}`);
  }
  // 原有的非同步/編排家族不得被擠掉
  for (const t of ["Agent", "Task", "WebFetch", "ScheduleWakeup", "Skill"]) {
    assert.ok(DISALLOWED.includes(t), `DISALLOWED 缺 ${t}`);
  }
});
