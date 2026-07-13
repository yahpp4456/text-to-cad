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
| L1 單元 | 純函數/reducer/server 邏輯 | `cd apps/cad-chat && node --test src/server/*.test.js src/server/cad/*.test.js src/lib/*.test.js src/state/*.test.js` | ~1s |
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
- **煙測 seed 真資料檔(如 `models/.cadchat/lessons.json`,server 每請求重讀免重啟)要
  三段式備份**:①開頭偵測前次殘留備份(硬中止時 finally 沒跑,磁碟=假資料/備份=真資料)
  先還原、②`copy2` 備份、③`finally` 還原或刪除。範本:`smoke_lessons.py` /
  `smoke_lesson_offer.py`。少了 ①,無條件 copy2 會用假資料蓋掉唯一真備份。
- **`node --test` 不解析 cadjs Vite alias**:import `cadjs/...` 的前端 lib(如 `cadMotion.js`)
  無法直接 node 測 → 把純邏輯抽到無 cadjs 依賴的檔(如 `cadMotionMath.js`)再 L1 測;
  render/side-effect 部分靠 L3 `__cadMotion`。`three` 本身在 node 可解析(node_modules)。
- **spawned Python(validate.py 等)的單元/整合測**放 `apps/cad-chat/tests/*.py`(unittest),
  直跑 `PYTHONUTF8=1 <venv-python> apps/cad-chat/tests/test_*.py`(不在 node --test / smoke 內)。
- **MOTION 契約單一真相源在 `cadpy.motion_decl`**(validate.py `_read_motion` 與 build
  sidecar 收割共同委派):動它必跑 `tests/python/packages/cadpy/test_motion_decl.py` +
  `apps/cad-chat/tests/test_build_meta.py`(sidecar↔validate 防漂移)+ 全部 motion 迴歸,
  且**先 sync-vendored**(venv editable 指向 vendored 複本,不同步=ImportError)。
- **MOTION `couple`(嚙合耦合)三個消費端要一起想**:motion_decl 驗宣告(主/從必明給
  pairs、禁鏈)、validate.py 掃掠把耦合群同 u「真滾動」(跨成員 pair 保留=嚙合面;
  齒比錯了 `test_validate_motion.CoupledSweepIntegration` 會抓)、cadMotion.js 播放從動
  借主動 period+相位 index(`smoke_verify_gate` F 段斷純滾動 y=-R·θ)。動任一端 →
  三處測試都跑;L4 `smoke_gear_rackpinion_live.py` 驗 agent 真的會宣告。
- **齒輪幾何只能用 `cadpy.parts.gear` family,不要手刻**:單弦梯形齒 vs 直邊齒條滾動
  必互咬(需隨 module 放大的減薄 ≈(0.05+2/z)·m,齒會瘦到難看);family 齒腹是
  「過真漸開線點的折線」(內接弦只減料不加料),0.05 背隙即全 z 零穿透——嚙合面
  因此**不進 INTENDED_CONTACT**,列進 pairs 就是真檢查。相位閉式
  `rack_mesh_phase_deg`(嚙合座標系:齒輪軸+Z、齒條 -X 側沿 Y、齒心 y=k·p 格點);
  測試:`test_parts_geometry.GearGeometryTests`(含錯半齒相位 must-FAIL)+
  `test_parts_models.SteeringBoxGateTests`(fixture 滾動 gate)。
  快路徑 checks 文案在 `designChecksFromMeta`(pipeline.mjs)與 validate.py 兩處逐字
  同步,`pipeline.design.test.js` 釘死——改文案兩邊一起改。
- **滑桿重生煙測必送「全部」參數值**(`rewriteParams` 整塊替換 PARAMS;只送單一 key 會讓
  產生器 import KeyError)。快路徑零 spawn 的實證斷言用 validate 事件 `ms < 1500`
  (spawn 路徑 ≥8s)。
- **鈑金(2026-07-11)**:幾何一律 `cadpy.parts.SheetMetal`(fold tree 單一真相源,
  folded/flat/dxf 三出口;攤平自交/摺疊自碰是 builder 內建 ValueError 閘)。DXF 匯出
  走 `skills/dxf` CLI 對產生器 .py 現跑 gen_dxf(**不走 scripts/step**);UI 的 DXF 鈕
  依 version 事件 `hasDxf`(regex 掃頂層 `def gen_dxf`);`paramDefsFromGenerator` 對
  `folded` 有 {min:0,max:1,step:1} 特例(必須在 value≤0 濾網之前)。DXF 層名契約:
  `CUT` / `BEND_UP_<deg>` / `BEND_DOWN_<deg>`(lower() 含 "bend",N 折=N 條帶中心線)。
  動鈑金幾何 → `tests/python/packages/cadpy/test_sheet_metal.py` + `test_parts_models`
  三個 Sheet*GateTests + `smoke_versions.py` DXF 段;動 cadpy 正本先 sync-vendored;
  動 prompt 鈑金教學 → L4 `smoke_sheetmetal_live.py`。
- **開檔 option C + 自動帶入編輯(2026-07-11)**:唯讀檢視(`/api/open`)是死路(無
  session/滑桿/agent 語境)。修法(option C 最終版):`/api/files` 每 entry `project` 旗標
  + `/api/open.projectDir`;FileBrowser **可編輯專案目錄整列點擊=一鍵 open-project**
  (`.fb-projrow`,無獨立按鈕、不導航進去);非專案容器才導航,其裸檔走唯讀「開啟」。
  `submitText` 在 `canvas.source==="opened" && canvas.projectDir && !sessionId` 時先
  `await openProject` 再 `send`(`setSessionId` 同步設 ref 無 race);`buildUserText` 對
  `source==="opened" && !_rehydrateNote` 注入 canvas 語境(安全網,option C 下少觸發但
  仍是 restore/?glb/bare 檔的網)。**gotcha**:option C 移除了「唯讀瀏覽專案檔」工作流
  → `smoke_open_dedupe.py` 退場(同 glbUrl 保留 status 由 chatStore.test.js 覆蓋);
  open 流測試在 `smoke_open_project.py`(目錄列一鍵開 + 注入式 escalation + 換 session)。
  動這條路 → smoke_open_project + smoke_versions §9 + L4 smoke_canvas_context_live。
- **鈑金摺疊/攤平即時切換(2026-07-11 二版)**:folded 已非 PARAMS 滑桿——3D 視圖 chip
  即時切換(換 glbUrl,零重算)。獨立鈑金件三出口 `gen_step/gen_flat/gen_dxf`;`runStep`
  併行 spawn `flat_glb.py`(cad-chat 端,零改 cadpy)產 `.<name>.flat.step.glb`;
  `generatorHasFlat`(`/^def gen_flat/m`,排除組合件);`emitPresent` 發 `flatGlbUrl`;
  snapshotVersion/revert 清單含攤平 GLB。**gotcha**:JSON 路徑(open-project/revert)的
  PRESENT dispatch 要**手帶 `flatGlbUrl`**(SSE 路徑走 events.js 自動帶,但 App.jsx 的
  openProject/revert 是手組 present——漏帶則 chip 不出現)。動鈑金攤平 → `smoke_flat_toggle.py`
  (chip 切換 + 攔 asset 證明載入 .flat.step.glb + 零 /api/chat)+ smoke_versions flatGlbUrl 段。
- **攤平折彎虛線 overlay(2026-07-11 三版)**:攤平態板面疊折彎中心線(藍上折/紅下折)。
  資料源 `SheetMetal.flat_bend_lines()`(公開,動它要 sync-vendored)→ `flat_glb.py` 併寫
  `.<name>.flat.lines.json` sidecar → `flatLinesUrl` **完全鏡射 flatGlbUrl 全鏈**(快照凍結
  清單、project revert 清單、emitPresent、version/present、events/App/store),漏一處則
  overlay 跨切版/重整失效。`useCadViewport` 新 opt `bendLines`(仿 axes chrome 直接
  `viewport.scene.add`,deps 加 `bendLines`);`bendGroup` 恆建(空)供 `setBendLines`/
  `chrome.bendLines`——**摺疊態斷言用 count===0 而非「group 不存在」**。座標直接對位(攤平
  GLB Z-up 無 recenter)。dev 鉤 `__cadChrome.bendLines()` → {visible,count};smoke_flat_toggle
  已擴充(攤平 count>0、摺疊 count=0)。
- **單一快路徑 + 匯出閘(2026-07-10 收斂,雙模式已拆)**:產圖回合一律零 spawn 快路徑;
  完整驗證只在精算(/api/validate)、匯出閘(/api/export、/api/export-parts 內建;
  /api/validate-ver 是 STEP 直下載的單獨入口)、開專案、回退。verified memo=
  `session._verifiedVers`(in-memory,重啟後首匯重驗冪等)。**動閘/驗證路徑必跑**
  `smoke_verify_gate.py`(含打滑 fixture 的擋下負案例——它是「唯掃掠可抓」缺陷類的
  最小重現);動 agent 回合語意(prompt/tools 的驗證措辭)→ L4 `smoke_revolute_live`
  (回合斷 MOTION 契約、掃掠改由精算端點斷真跑)。舊 `smoke_output_mode.py` 已由
  `smoke_verify_gate.py` 取代。
- **runner 的 prompt 恆走 streaming input**(async generator;SDK 字串 prompt 會被傳輸層
  硬編成純 text block,image block 只能走 generator 路)。動 `runner.mjs` 的 query 呼叫
  → 必跑 L4 `smoke_queue_live`(兩回合=resume+streaming 併用的最小驗證)。
- **clarify 兩步精靈的注入契約**:`SET_CLARIFY` 帶 `specs`(chips 陣列)→ 兩步;不帶 →
  單步(舊煙測注入不必改)。合成回覆「規格修正:…」由 `src/lib/clarifyText.js`
  `composeClarifyReply` 釘死(L1)+ `smoke_clarify_wizard.py` 端到端(page.route stub
  `/api/chat` 截 POST body,免 LLM 可驗送出)。
- **上傳端點超限要「排水」不可立刻 destroy**:client(fetch/urllib)先送完 body 才讀回應,
  馬上斷線只看到 connection reset 而非 413(`readRawBody` 已內建:reject 後丟棄到
  2×limit 才斷)。上傳檔 media_type/副檔名一律信 magic bytes 嗅探(`images.mjs`),
  不信 client content-type。
- **emit_spec/emit_clarify 文字欄位在 server choke point 過 `unescapeNewlines`**(模型會在
  tool JSON 寫字面 `\n`)。改 clarify 欄位/合成格式 → L1 `clarifyText.test.js` +
  `events.test.js`;改 prompt 措辭(消冗/「規格修正:」優先/圖面附件節)→ L4
  `smoke_image_clarify_live.py`(附圖型號表 → 多型號 clarify → 跨回合圖面記憶)。

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
   visible)、`__cadFaceFill.count()/debug()`、`__cadPreview.group()`、`__cadMotion`、
   `__cadVisual.display()/stateFor(label)`(眼睛三態:材質 opacity/mesh.visible)。
   Playwright 樹節點 locator 用 `has_text` 是**子字串比對**——label 斷言/定位要全等
   就用 `re.compile(r"^label$")`(「pinion」會先鎖到根 ASSEMBLY 列 steering_box_rack_pinion)。
   `inner_text()` 回傳**渲染後**文字:CSS `text-transform: uppercase` 的元素
   (如 `.model-code`)拿到的是大寫,比對前先 `.lower()`。FileBrowser 的 `dir`
   state **跨開闔保留**(overlay 關閉不重置)——煙測重進要先點 breadcrumb「models」回根。

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
