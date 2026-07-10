# apps/cad-chat — 代理入口（本 fork 主軸）

本機網頁「對話式 CAD」：瀏覽器描述零件 → **Claude Agent SDK**（訂閱 OAuth 或
API key）驅動 repo 既有 text-to-cad pipeline → 真 STEP/GLB + 幾何驗證 → 用文字 /
點選幾何 / 拉參數迭代。這是這個 Windows 自用 fork 的日常主要工作區。

## 先讀這些

- **完整文件在 [`README.md`](README.md)**：架構、`/api/*` 端點、MOTION 契約、
  元件/組合件檔案類型、開檔/匯入/結合流程、視圖體驗、拆件匯出、跨重整續聊。
  改任何東西前先在 README 找對應章節，本檔只指路不複述。
- **改 cad-chat 前先載入 `cad-chat-verify` skill**
  （`.claude/skills/cad-chat-verify/SKILL.md`）：L0 build → L4 LLM 的分層驗證
  金字塔、「改動類型 → 必跑層」表、「新需求 → 驗證擴充決策樹」。每層都免 LLM
  可跑到底；真 LLM 回合是最後、最貴、被 gate 的一層。

## 硬規則（fork-local，見根 `CLAUDE.md`）

- **除非使用者明確要求，否則絕不 commit。** 工作留在 working tree。
- Python 一律 `.venv/Scripts/python.exe`（Windows 是 `Scripts/` 不是 `bin/`）；
  spawn Python 要帶 `PYTHONUTF8=1`（否則 cp950 炸繁中/✓）。
- **`src/server/**.mjs` 沒有 HMR**：改完必須重啟 dev server 才生效。
  前端 jsx/css/js 有 Vite HMR。
- 動到 `packages/cadpy*`（Python 根源）後跑 `scripts/dev/sync-vendored.sh`
  同步 8 份獨立複本（本 fork 無 symlink），再回驗證表。

## 啟動 / 驗證速查

```bash
cd apps/cad-chat && npm run dev          # 單一埠，預設 http://127.0.0.1:8788/
npm run build                            # L0：語法/import/JSX
cd apps/cad-chat && node --test src/server/*.test.js src/server/cad/*.test.js src/lib/*.test.js src/state/*.test.js  # L1 單元
# 全套煙測（repo 根；server 沒起會印指引後跳過 exit 0）
PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/smoke/run_all.py
```

`CADCHAT_SMOKE=1` 把「server 不可達」轉為失敗；`CADCHAT_SMOKE_LLM=1` 才跑燒真
LLM 回合的 `smoke_queue_live`。dev 預覽捷徑：
`?glb=/api/asset?file=<models 內 .glb>&name=<n>[&motion=<json>]` 免對話載模型。

## 原始碼地圖

- `src/server/`：單一埠 `node:http`（dev 委派 Vite middlewareMode，prod serve `dist/`）。
  - `agent/`：`query()` 依認證模式傳憑證，掛 in-process MCP 工具（`emit_*` 推進
    UI + `cad_*` 實跑 `.venv` 的 `scripts/step`/`scripts/inspect`/`geometry_checks`）。
    白名單沙箱：只允許 Read/Glob/Grep + cad 工具，**整個非同步家族被 disallow**
    （Agent/Task/ScheduleWakeup/Workflow… 不經 canUseTool，只能整個移除）。
  - `cad/`：pipeline 接線 + Python spawn（`python.mjs` 有 `scrubPaths` 遮絕對路徑）。
  - `middleware/`：chat(SSE)/interrupt/health/asset/files/project。
- `src/`（React + Vite）：SUIYAO 6 區；3D 用 `packages/cadjs` three.js 載真 GLB，
  物件屬性/幾何點選來自 GLB 內嵌的 STEP topology。**three 必須單一副本**
  （Vite alias）；`renderModel()` 不掛 canvas，需自建 host。
- `tests/smoke/`：對跑中的 dev server 驗 UI + 免 LLM API 鏈路（Playwright）。

產物寫 `models/.cadchat/<session>/`（gitignored，啟動時 GC 超過
`CADCHAT_GC_DAYS` 天沒動的 session）。憑證與更細的實作 gotcha 見 README 與根
`CLAUDE.md`。
