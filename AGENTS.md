# AGENTS.md

這是 text-to-cad 的 Windows 自用 fork。主要產品是 `apps/cad-chat/`：使用者在瀏覽器描述零件或機構，由起站時選定的 Claude 或 Codex 呼叫本庫的 CAD 工具，產生 STEP、GLB 並提供幾何檢查。修改前先確認問題屬於聊天應用、共用 CAD 套件，還是獨立 Viewer。

## Git 與發版

- 本 fork 的日常開發分支是 `開發`。在此分支工作，省略另開 feature branch 和送 PR 的步驟。`main` 保留作上游鏡像。
- 預設將修改留在工作樹。只有使用者明確要求時才 commit；push 由 Sam 執行。
- [CONTRIBUTING.md](CONTRIBUTING.md) 的 `develop`、symlink、release PR 與版本號流程屬於上游。保留 `plugins/cad/VERSION` 的上游版本；請勿觸發指向上游服務的 Release、Deploy 或 Upload Models 工作流程。
- 本 fork 的服務部署見 [服務部署文件](apps/cad-chat/DEPLOY.md)。Electron 桌面版已於 2026-11-25 移除。

## 修改 cad-chat

1. 先讀 [應用程式開發指引](apps/cad-chat/CLAUDE.md) 和 [cad-chat-verify](.claude/skills/cad-chat-verify/SKILL.md) 的「改動類型 → 必跑層」。架構、API、模型匯入與運動契約見 [cad-chat README](apps/cad-chat/README.md)；修改機構知識庫時另讀 [知識庫說明](apps/cad-chat/kb/README.md)。
2. Windows 本機從 repo 根目錄雙擊「用 Codex 啟動.cmd」或「用 Claude 啟動.cmd」選擇主代理。手動開發可執行 `npm --prefix apps/cad-chat run dev`，預設使用 Claude。前端支援 Vite 熱更新。修改 `apps/cad-chat/src/server/` 後，重新啟動開發伺服器再驗證。
3. 依驗證表跑受影響的層級，再完成建置與煙測回歸。建置指令是 `npm --prefix apps/cad-chat run build`。下列 PowerShell 指令在開發伺服器已啟動時執行；`CADCHAT_SMOKE=1` 讓連不上伺服器時回報失敗。需要驗證真實模型回合時，依驗證表啟用 `CADCHAT_SMOKE_LLM=1`。

```powershell
$env:PYTHONUTF8 = '1'
$env:CADCHAT_SMOKE = '1'
.\.venv\Scripts\python.exe apps/cad-chat/tests/smoke/run_all.py
```

## CAD 原始碼與同步

- `skills/` 放技能說明、參考資料與 CLI。優先使用目前 checkout 裡的技能；可安裝的技能必須自足。跨技能共用的程式放在 `packages/`，透過各技能的 runtime 載入，避免依賴 repo 根目錄或其他技能的匯入路徑。
- `packages/cadpy/` 和 `packages/cadpy_metadata/` 是共用 Python 套件的正本。Windows fork 以實體檔案保存技能、Viewer 與 plugin 下的複本。修改正本後，在 repo 根目錄以 **Git Bash** 執行下列同步與比對，再跑 `tests/python/` 中對應的測試。只改 metadata 時，將兩行的套件名稱改成 `cadpy_metadata`。

```bash
scripts/dev/sync-vendored.sh --package cadpy
scripts/dev/sync-vendored.sh --check --package cadpy
```

- 同步腳本僅處理上述兩個 Python 套件。保留本 fork 的實體複本配置，避免執行上游的 `setup-symlinks.sh`、`bundle.sh` 或自行遞迴覆寫同名目錄。
- `packages/cadjs/` 放共用 JS CAD 與渲染程式，供 cad-chat 直接載入；`packages/implicitjs/` 維持獨立。兩個套件都應保持與 React 無關。
- 獨立 CAD Viewer 的 UI 與服務原始碼在 `viewer/`。修改 Viewer 時，從 repo 根目錄執行 `npm --prefix viewer run dev` 開發，以 `npm --prefix viewer test` 和 `npm --prefix viewer run build` 驗證。若改動共用 JS，先確認 Viewer 載入的套件複本包含該次修改。
- Windows 上以 `.venv/Scripts/python.exe` 執行 CAD Python，啟動 Python 子程序時設 `PYTHONUTF8=1`。Repo 的 `.sh` 腳本使用 Git Bash。

## 模型與檢視

- CAD 與機器人描述的範例、測試模型及產物放在 `models/`。本機 cad-chat 的對話產物預設在 `models/.cadchat/<session>/`。一次性輔助腳本放在 `tmp/`，可重用的 repo 指令放在 `scripts/`。
- 只還原任務需要的 LFS 模型，優先使用本機快取，並保持 Git LFS filters 啟用。虛擬環境、依賴、暫存檔、憑證與對話產物均留在版本控制之外。
- 要用獨立 Viewer 檢視模型時，依 [cad-viewer 技能](skills/cad-viewer/SKILL.md) 使用 `agent:start`，以 `--dir` 傳入 `models/` 的絕對路徑。沿用 launcher 印出的 URL 與連接埠，確認檔案存在後再附上相對於該目錄的 `file=`。
