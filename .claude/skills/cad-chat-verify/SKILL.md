---
name: cad-chat-verify
description: apps/cad-chat 的分層驗證流程與擴充守則。改動 cad-chat(前端 React/後端 node:http/agent 工具/CAD pipeline 接線)後,依此挑最小夠用的驗證層執行;新增功能時,依「新需求 → 驗證擴充決策樹」決定加哪種測試。通用的 Playwright 自我驗證機制見 references/playwright-self-verify.md。
---

# cad-chat 驗證 Skill

適用範圍:`apps/cad-chat`(本機網頁對話式 CAD;fork 自用,永不自動 commit)。
核心原則:**每一層都免 LLM 可跑到底;真 LLM 回合是最後、最貴、被 gate 的一層**。
改動只算「完成」當:對應層級綠 + 全套煙測迴歸綠 + build 綠。

## 驗證金字塔(由快到貴,先跑最小夠用層)

| 層 | 驗什麼 | 指令 | 時間 |
|---|---|---|---|
| L0 建置 | 語法/import/JSX | `npm --prefix apps/cad-chat run build` | ~5s |
| L1 單元 | 純函數/reducer/server 邏輯 | `cd apps/cad-chat && node --test src/server/*.test.js src/server/cad/*.test.js src/lib/*.test.js` | ~1s |
| L2 API | 免 LLM 端點鏈路(open-project/save/revert/export/asset…) | 煙測內含(smoke_versions),或 curl 手打 | 秒~分 |
| L3 UI | 真瀏覽器互動與渲染 | `PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/smoke/run_all.py` | ~6-8min |
| L4 LLM | 必須靠模型的行為(對話語境/工具編排) | `CADCHAT_SMOKE_LLM=1` 跑 run_all,或手動一輪對話 | 分鐘級+燒回合 |

**改動類型 → 必跑層**:
- 純前端(jsx/css/前端 js):L0 + 相關 L3 單支;HMR 生效免重啟。
- `src/server/**.mjs`:**必重啟 dev server(無 HMR)**,再 L1(若有測試)+ L2/L3 相關段。
- `src/state/`(reducer/events):L1(若可純函數測)+ L3 相關段(dev 鉤注入驗渲染)。
- agent 工具/prompt(`src/server/agent/`):L0 + 重啟 + L4 一輪(這層沒有免 LLM 等價品)。
- cadpy/skills 端(Python):先 `scripts/dev/sync-vendored.sh` 同步 8 份複本,再
  `tests/python/` 對應單元測,最後回到本表。

## 指令速查

```bash
# 起 dev server(8788;背景跑)
cd apps/cad-chat && npm run dev
# 殺佔埠孤兒(TaskStop 殺不到 node 子程序時)— PowerShell:
#   Get-NetTCPConnection -LocalPort 8788 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
# 健康探測
curl -s http://127.0.0.1:8788/api/health
# 全套煙測(repo 根;server 沒起會印指引後跳過)
PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/smoke/run_all.py
# 單支(在 tests/smoke/ 目錄下;versions 先於 restore——後者吃前者的 .out/ handoff)
cd apps/cad-chat/tests/smoke && PYTHONUTF8=1 <venv-python> smoke_asm_ui.py
```

## 環境 gotcha(踩過的坑,先讀省一小時)

- **PYTHONUTF8=1 必帶**:Windows cp950 對 ✓/✗/中文輸出直接 UnicodeEncodeError。
- **Python 是 `.venv/Scripts/python.exe`**(Windows venv;playwright 1.60 已裝,勿另裝)。
- **fixture 是 LFS**:`models/motorized_linear_stage`、`models/xyz_pickplace_gantry`
  必須是實體檔(STEP 開頭 `ISO-10303-21`、GLB 數百 KB);131B 的是 pointer →
  `git lfs checkout <path>`。
- **server 端 .mjs 零 HMR**:改了不重啟 = 你在測舊 code(health 回 200 不代表新 code)。
- **背景起 server 要在 `apps/cad-chat` 目錄**:repo 根 `npm run dev` 是 enoent(exit 127)。
- CLI sidecar 匯出(`--stl OUT`)的 OUT 是**相對 STEP 所在目錄**且拒絕絕對路徑——只傳檔名。
- 煙測產物(截圖/handoff)一律寫 `tests/smoke/.out/`(gitignored),別寫測試目錄根。

## 新需求 → 驗證擴充決策樹

新功能落地時,照改動的「形狀」決定加什麼測試(可複選;由上而下問):

1. **加了純函數 / reducer case / server 純邏輯?**
   → co-located `node:test`(`src/**/<module>.test.js`),合成輸入、不碰網路;
   需要檔案系統就注入 root(參考 `sessions.gc.test.js` 的 tmp-root 模式)或用
   SESSIONS_ROOT 下唯一 test-id + finally 清理(參考 `sessions.persist.test.js`)。

2. **加了 API 端點 / 改了端點行為?**
   → 在 `smoke_versions.py`(或新開一支)加 API 段:用 `_util.post()` /
   `get_with_headers()`。**負案例是必填項**:壞參數 400、不存在 404、busy 409、
   白名單外值——伺服器怎麼守,測試就怎麼打。回應宣稱寫了檔案 → 磁碟 stat 斷言
   (存在 + size>0),別信 `ok:true`。

3. **加了 UI 行為 / 視覺狀態?**
   → 既有煙測加段落(同一頁面流程)或新開 `smoke_<feature>.py`(獨立流程)。
   斷 DOM(selector/count/inner_text/attribute);**WebGL 或元件內部 state DOM 看不到
   → 先在產品碼加 dev 鉤**(`window.__cadXxx`,只在 `import.meta.env.DEV`),
   再寫斷言。既有鉤:`__cadDispatch`(注入 store action)、`__cadChrome`(網格/軸
   visible)、`__cadFaceFill.count()/debug()`、`__cadPreview.group()`、`__cadMotion`。

4. **行為要 LLM 才會發生(對話回覆、工具鏈)?**
   → 先問:「能不能用 `__cadDispatch` 注入等價的 SSE action 免 LLM 驗渲染?」
   (clarify 卡、進度面板、工具卡全是這樣測的)。只有「模型的判斷本身」需要真回合
   → 寫進 LLM-gated 煙測(參考 `smoke_queue_live.py`:極短 prompt、明令不建模
   不呼叫工具,壓成本),或手動一輪並把結果記錄在交付摘要。

5. **收尾(每次都做)**:
   - 新煙測掛進 `run_all.py` 的 `ORDER`(注意依賴順序;LLM 的進 `LLM_GATED`);
   - 全套 run_all 重跑綠(改 A 不只跑 A);
   - `apps/cad-chat/README.md` 對應章節同步;重大 gotcha 進本 skill 的清單。

## 失敗分流紀律

測試紅了,先分辨三種情況再動手:
1. **產品真的壞了** → 修產品,測試不動。
2. **測試的世界模型錯了**(產品行為正確,斷言的訊號假設錯)→ 修測試,**並在測試裡
   註解為什麼**。實例:背靠背回合間 END_RUN+START_RUN 被 React 批次合併,「中斷鈕
   detach→attach」永不發生,要改斷最終產出(AI 氣泡數);雙擊圈選後滑鼠恰停在菱形上,
   hover 填色已觸發,要先把滑鼠移開再量「初始值」。
3. **鏈路靜默失效**(斷言 0/null 但沒報錯)→ 別瞎猜,先加/用 debug 探針把鏈路每環
   數字化(`__cadFaceFill.debug()` 模式),一眼看斷在哪環。實例:hook 有傳新 API
   但元件解構沒接 → 全部 `undefined` 靜默 no-op。

通用的 Playwright 自我驗證機制(dev 鉤模式、反 flake 規則、分層 gate、骨架範本)
見 [references/playwright-self-verify.md](references/playwright-self-verify.md)。
