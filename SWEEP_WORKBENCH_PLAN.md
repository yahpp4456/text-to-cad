# ChatCAD 設計模式：AI 路徑掃出工作台

## 摘要

- 在「設計」模式加入暫存的 Sweep 工作台，中央視圖分成左右兩區：左側編輯 2D／3D 路徑，右側編輯封閉輪廓。
- AI 可一次提供完整草稿，也可先提供路徑、下一回合再補輪廓；兩者寫入同一份 session 草稿。
- 使用者可拖曳控制點，也可精確輸入座標、尺寸、圓弧與 Bézier 控制值。
- 草稿確認後由後端決定性產生 build123d generator，沿用既有 STEP／GLB、快速驗證與版本流程，不再消耗 AI 回合。

## 主要實作

### AI 與資料契約

- 新增 `sweep-draft-v1` schema：
  - 路徑支援開放或封閉的 2D／3D 直線、三點圓弧、三次 Bézier。
  - 輪廓支援圓、矩形、圓角矩形，以及單一封閉的線段／圓弧自訂輪廓。
  - 朝向包含自動平行傳輸、可選起始法向量及端到端扭轉角。
  - 允許 `profile: null` 的半完成草稿，以支援分兩次描述。
- 新增 AI 工具：
  - `sweep_get_draft`：讀取目前 session 草稿。
  - `sweep_present_draft`：建立或局部更新路徑、輪廓與朝向，驗證後發出 `sweep_draft` SSE 事件。
- 更新設計模式 prompt：辨識掃出需求後先建立草稿，不直接呼叫 `cad_build`；路徑或輪廓資訊不足時保留半完成狀態，不自行猜測關鍵拓撲。
- 草稿帶單調遞增 revision；前端儲存時以 base revision 防止 AI 更新與手動編輯互相覆蓋。

### 工作台與互動

- `Canvas3D` 收到草稿後切換為 `SweepWorkbench`：
  - 左側為路徑視圖，提供透視、XY、XZ、YZ 視角；拖曳在目前工作平面進行，第三軸由數值欄調整。
  - 右側為 2D 輪廓編輯器，支援形狀預設、控制點拖曳、尺寸及圓角輸入。
  - 左側同步顯示路徑、起始截面及半透明掃出網格；預覽採與正式建模相同的曲線取樣及平行傳輸框架。
- 提供新增、刪除、切換線段類型、復原／重做、重設為 AI 草稿、關閉工作台、捨棄草稿及「確認掃出」。
- 編輯採 debounce 自動保存；路徑或輪廓不合法時即時標示問題並停用確認。
- 正式建模後回到一般 3D 視圖，保留「編輯掃出」入口；再次修改並確認會建立下一個正式版本。
- 草稿狀態納入 reducer、localStorage restore 與 session 檔案；開專案、存專案及重整後仍可繼續編輯。

### 後端建模與端點

- 新增：
  - `GET /api/sweep-draft?id=…`：取得 session 草稿。
  - `POST /api/sweep-draft`：保存或捨棄草稿，使用 revision 做衝突檢查。
  - `POST /api/sweep-build`：驗證完整草稿並產生正式 CAD。
- 建模器將 schema 轉成固定格式的 build123d `.py` generator：
  - 零扭轉使用單截面 sweep。
  - 有扭轉時沿路徑建立旋轉後的多截面並執行 multisection sweep。
  - generator 內嵌正規化後的 sweep spec，確保專案重開與版本回退可重現。
- 建模採交易式更新：先保留現有 generator／產物，build 失敗時完整回滾且不新增版本；成功後走既有快速驗證、STEP／GLB、`version` 與 `present` 流程。
- 所有端點沿用 session user scope、busy gate、路徑沙箱與現有未驗證版本規則；完整幾何驗證仍由「精算此版」及匯出閘負責。

## 測試與驗收

- 單元測試：
  - schema 正規化、局部合併、revision 衝突及錯誤輸入。
  - 直線、圓弧、Bézier 取樣與 3D 平行傳輸框架連續性。
  - 2D／3D、開放／封閉路徑、各輪廓及扭轉 generator 產出。
- API 測試：
  - 半完成草稿保存、跨重整讀回、捨棄、per-user 隔離。
  - 缺輪廓、斷裂路徑、自交輪廓、零長線段回 400；revision 衝突回 409；busy session 回 409。
  - 成功建模確實產生非空 STEP／GLB 與新版本；失敗時 generator、產物及版號不變。
- UI 煙測：
  - 注入免 LLM 的 `sweep_draft` 事件，驗證左右分割、拖曳、數值輸入、undo/redo、驗證訊息與重新開啟。
  - 實際確認建模後載入 GLB，並驗證再次編輯會新增版本。
- L4 真 AI 測試：
  - 一次描述完整路徑與輪廓。
  - 第一回合只描述路徑、第二回合補輪廓，確認 AI 更新同一草稿且不提前建模。
- 最後執行 cad-chat L0 build、相關 L1、功能煙測、全套 `run_all.py`，並更新 README 與驗證說明。

## 假設與邊界

- 第一版單位固定為 mm，只支援單一外輪廓；孔洞、多截面 loft sweep、導引軌與逐點扭轉不納入。
- 預覽網格是互動提示，正式 STEP 幾何與驗證結果才是權威。
- 實作前從 `develop` 建功能分支；若目前 `開發` 不是同一分支，使用獨立 worktree，避免碰觸現有未提交修改。
- 視覺延續 ChatCAD 現有工業／工程工作台語言，不另引入 UI framework 或 CAD runtime 依賴。
