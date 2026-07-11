# -*- coding: utf-8 -*-
"""cad-chat 煙測總 runner(Playwright,對著跑中的 dev server)。

預設行為:8788 不可達 → 印指引後跳過(exit 0);設 CADCHAT_SMOKE=1 則視為失敗
(仿 repo 的 env-gate 慣例)。smoke_queue_live 會消耗真 LLM 回合,另以
CADCHAT_SMOKE_LLM=1 閘門,預設跳過。

跑法(Git Bash / PowerShell 皆可):
  PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/smoke/run_all.py
"""
import os
import subprocess
import sys

from _util import BASE, HERE, server_alive

# versions 先於 restore:restore 吃 versions 產出的 .out/versions_session.json
ORDER = [
    "smoke_view_chrome.py",
    "smoke_clarify_wizard.py",
    "smoke_upload.py",
    "smoke_verify_gate.py",
    "smoke_asm_ui.py",
    "smoke_occ_tree.py",
    "smoke_click_select.py",
    "smoke_part_visibility.py",
    # smoke_open_dedupe 退場:option C(專案目錄整列一鍵開)移除了它測的「唯讀瀏覽專案
    # 檔去重」工作流;同 glbUrl 保留 status 由 chatStore.test.js 單元測覆蓋。
    "smoke_open_project.py",
    "smoke_flat_toggle.py",
    "smoke_versions.py",
    "smoke_restore.py",
    "smoke_lessons.py",
]
# 消耗訂閱/API 回合
LLM_GATED = [
    "smoke_queue_live.py",
    "smoke_revolute_live.py",
    "smoke_gear_rackpinion_live.py",
    "smoke_image_clarify_live.py",
    "smoke_sheetmetal_live.py",
    "smoke_canvas_context_live.py",
]

if not server_alive():
    msg = (
        f"[smoke] {BASE} 不可達——先起 dev server:\n"
        "  npm --prefix apps/cad-chat run dev\n"
        "並確認 fixture 為實體檔:git lfs checkout models/motorized_linear_stage models/xyz_pickplace_gantry"
    )
    print(msg)
    sys.exit(1 if os.environ.get("CADCHAT_SMOKE") == "1" else 0)

env = {**os.environ, "PYTHONUTF8": "1"}
targets = list(ORDER)
if os.environ.get("CADCHAT_SMOKE_LLM") == "1":
    targets += LLM_GATED
else:
    print(f"[smoke] 跳過 {', '.join(LLM_GATED)}(消耗 LLM 回合;CADCHAT_SMOKE_LLM=1 開啟)")

failures = []
for name in targets:
    print(f"\n===== {name} =====")
    rc = subprocess.call([sys.executable, os.path.join(HERE, name)], env=env, cwd=HERE)
    if rc != 0:
        failures.append(name)

print("\n" + ("=" * 40))
if failures:
    print("[smoke] FAILED:", *failures, sep="\n  - ")
    sys.exit(1)
print(f"[smoke] 全數通過({len(targets)} 支)")
