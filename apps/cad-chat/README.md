# cad-chat — 本機網頁版「對話式 CAD 產圖」

在瀏覽器用自然語言描述零件 → 看 AI 逐步思考/動手 → 真實 3D CAD 模型即時出現 →
用文字 / 點選幾何 / 拉參數迭代。後端用 **Claude Agent SDK**(訂閱 OAuth 或 API key
雙模式),驅動 repo 既有的 text-to-cad pipeline 產出真 STEP/GLB 並跑幾何驗證。

設計來自 Claude Design 稿 `cad-chat.dc.html`(SUIYAO 淺色企業風);產品定義見
`ref/web-agent-ui-design-brief.md`。

## 一次性設定(認證,二選一)

**A. 自用(綁訂閱)** — 需 Claude Pro / Max / Team / Enterprise:

```bash
# 1) 安裝相依(在本資料夾)
cd apps/cad-chat
npm install

# 2) 產生綁訂閱的 OAuth token(會開瀏覽器授權,印出一年期 token)
claude setup-token

# 3) 把 token 設給本 app(擇一)
#    A. 寫進 apps/cad-chat/.env.local(已被 .gitignore 忽略):
#         CLAUDE_CODE_OAUTH_TOKEN=<貼上 token>
#    B. 或設成系統環境變數(Windows):
#         setx CLAUDE_CODE_OAUTH_TOKEN "<貼上 token>"
```

**B. 產品/多人(API key)** — 在 [Claude Console](https://platform.claude.com/) 建
API key,寫進 `.env.local` 的 `ANTHROPIC_API_KEY=`。按量計費(Commercial Terms)。

> ⚠ **條款界線**(官方 legal-and-compliance 頁明文):訂閱 OAuth 僅供訂閱者本人
> 日常使用;*"Anthropic does not permit third-party developers to offer Claude.ai
> login or to route requests through Free, Pro, or Max plan credentials on behalf
> of their users."* 要把本 app 提供給其他使用者,必須走 API key。
>
> 兩者都設時採 **API key**;呼叫 Agent 時只傳入選中的那一種憑證(`agentEnv`),
> Python 子程序(跑 LLM 產生器碼)一律看不到任何憑證(`sandboxEnv`)。

## 啟動

```bash
cd apps/cad-chat
npm run dev        # 開發(單一埠 + Vite HMR),預設 http://127.0.0.1:8788/
# 或
npm run build && npm run serve   # 正式(serve dist/)
```

打開 `http://127.0.0.1:8788/`,在左側輸入框描述零件即可。若上方出現「尚未設定認證」
橫幅,表示兩種憑證都沒設 —— 完成上面的一次性設定並重啟伺服器。

**agent 調校(`.env.local`,改後重啟)**:`CADCHAT_MODEL`(模型別名/ID)、
`CADCHAT_EFFORT`(推理 effort `low|medium|high|xhigh|max`,**預設 xhigh**;只有支援
effort 的模型有效,否則 SDK 靜默降級)、`CADCHAT_THINKING`(深度思考
`off|disabled|adaptive|<正整數 budgetTokens>`,**預設 off**——不做可見深度思考、避免長
停頓,深度由 effort 控)。三者只作用於主 agent(`runner.mjs`);教訓蒸餾 agent 用 SDK 預設。

## 打包散布(Electron 內測版;操作手冊見 [PACKAGING.md](PACKAGING.md),計畫/驗證紀錄見 repo 根 `b-calm-swing.md`)

**日常打包/換 key = 編輯 `.env.bake` → `npm run dist`**(bake 驗證→vite build→electron-builder
一條龍);細節、檢查清單、troubleshooting 全在 PACKAGING.md。以下是機制說明:

發給內部可信同事的 Windows 桌面版。**認證 = build 時注入 Sam 自備 API key(方案 B)**;
key 明文躺產物內是已知並接受的風險(防線 = 可信對象 + 專屬 key + Console 花費上限;
asar 非加密,寫死源碼同樣可抽,故不採)。

- **單一貼入點**:build 機建 `apps/cad-chat/.env.bake`(gitignored)貼
  `ANTHROPIC_API_KEY`(必填,`sk-ant-` 形狀檢查)+ 任何 `CADCHAT_*` 預設(選填,鍵白名單)。
  `npm run bake-auth` 驗證後產 `.env.baked`(隨包散布);`npm run build:packaged` 一條龍。
- **執行期載入**(`config.loadBakedEnv`):**fallback-only**——真 env / `.env.local` 已有
  任一認證則整檔略過(`resolveAuth` 的 tie-break 是 apikey 一律勝 oauth,不加這道 guard,
  dev 機殘留 `.env.baked` 會靜默改用 baked key 計費)。
- **路徑契約**(`config.mjs`,env 優先 + `import.meta.url` fallback;dev 不設 = 恆等式零回歸):
  `CADCHAT_RUNTIME_ROOT`(唯讀程式資產根)/`CADCHAT_DATA_ROOT`(可寫資料根)/
  `CADCHAT_PYTHON_EXE`/`CADCHAT_DIST_ROOT`/`CADCHAT_MODELS_FIXTURES_ROOT`。models 為
  雙層:可寫 `DATA_ROOT/models` 優先、唯讀 fixtures fallback(`cad/paths.mjs
  resolveModelRead`;寫入永遠只准可寫層)。`spawnPython` 腳本絕對化到 RUNTIME_ROOT、
  `cwd=DATA_ROOT`(產物相對基準);`scrubPaths` 雙根+HOME 全遮。
- **可搬移 Python runtime**(`build-runtime/python/`,gitignored):python.org embeddable
  3.13 + 白名單套件(build123d novtk 鏈 + ezdxf)+ **非-editable** cadpy wheel——無
  `.pth` 絕對路徑、無 Store Python 依賴、無 vtk/playwright,約 556MB。重建腳本見
  `b-calm-swing.md` P0-1。
- **SDK CLI 釘死**:兩處 `query()`(runner + lessons.distill)在 packaged 下傳
  `pathToClaudeCodeExecutable`(`resolveClaudeCliExe`:asar→`.unpacked` 改寫、
  `CADCHAT_CLAUDE_CLI` 覆寫;dev 回 null 走 SDK 內建);`agentEnv` 恆刪
  `ELECTRON_RUN_AS_NODE`,packaged 下設 `CLAUDE_CONFIG_DIR=DATA_ROOT/.claude` 隔離 transcript。
- **Electron 殼(Phase 1)**:`npm run electron:dev` 起桌面殼(dev 模式,走 repo 恆等式+Vite)。
  組裝鏈:`electron/main.cjs`(CJS,single-instance、BrowserWindow `contextIsolation+sandbox`
  無 preload——渲染層=純瀏覽器,信任模型與網頁版相同)→ 動態 import `electron/launch.mjs`
  (`computeRuntimeEnv` 依 `app.isPackaged` 算 `CADCHAT_*` 路徑 env,**只餵路徑不碰憑證**;
  `CADCHAT_PORT=0`=OS 配臨時埠免競態)→ `utilityProcess.fork src/server/entry.child.mjs`
  (`ready` IPC 回實際 port/url)→ `loadURL`。退出:`before-quit` → `taskkill /pid /T /F`
  連根清 server 子樹(python.exe / claude.exe 孫程序)。server 組裝本體在
  `src/server/start.mjs` 的 `startServer({dev,port})`(`server.mjs` 只是薄 CLI wrapper,
  `npm run dev/serve` 介面不變)。

## 架構

- **單一埠 `node:http` 伺服器**(`src/server/`):dev 委派 Vite middlewareMode,prod serve `dist/`。
  - `POST /api/chat`(SSE,`{message?,sessionId?,pickRefs?,params?}`):起/續一個 agent turn,串流 `stage/ai/spec/plan/tool/validate/retry/artifact/present/version/params/motion` 事件。產圖一律快路徑:cad_validate **零 spawn**——直讀 build 收割 sidecar,checks 全標 skipped、MOTION 照供播放,產物未驗證(完整驗證在精算/匯出閘;缺 sidecar 退回 `validate.py --motion-only` spawn)。`version` 事件帶 `verified`(server `versionStamp` 權威發:full 驗證跑過且全過才 `verified:true`)。
  - `POST /api/interrupt`:中斷當前 turn 並殺 Python 子程序。
  - `GET /api/health`:認證狀態(`authMode` = oauth / apikey / missing)。
  - `GET /api/asset?file=…`:把 `models/` 下產物(GLB 等)串流給 cadjs。
  - `GET /api/files?dir=…` / `POST /api/open`:models/ 檔案瀏覽與開檔看圖(免 LLM;
    裸 STEP 按需以 `--kind` 轉隱藏 topology GLB)。
  - `POST /api/import` / `POST /api/open-project`:匯入元件進 session `imported/`、
    開既有專案(複製樹到新 session + 同步重建 rehydrate)。
  - `POST /api/save-project`(`{sessionId,name,overwrite?}`):把 session 產物存成
    `models/<name>/`(與 open-project 互為讀寫方向;已存在回 `error:"exists"` 待確認覆蓋)。
  - `POST /api/revert-version`(`{sessionId,ver}`):回退到 vK 快照——複回頂層+重建驗證,
    產生新版 v{N+1}=vK 複本(歷史線性)。
  - `POST /api/validate`(`{sessionId}`):對 session 頂層工作基準跑「完整」幾何驗證(含運動掃掠),
    不重新產生——版本上的「✓ 精算此版」用:快速迭代後一鍵補驗,通過後匯出免等閘。
  - `POST /api/validate-ver`(`{sessionId,ver?}`):匯出閘單獨入口(STEP 直下載把關;
    memo 命中秒回,未驗過自動完整驗證)。
  - `GET /api/session-info?id=`:唯讀探測 session 是否還救得回來(前端開機還原用)。
- **Agent**(`src/server/agent/`):`query()` 依認證模式傳憑證(`agentEnv`),掛 in-process MCP 工具
  (`emit_*` 推進 UI + `cad_import/cad_build/cad_validate/cad_source_part/cad_present/
  cad_measure/cad_align/cad_export` 實跑 `.venv` 的 `scripts/step`、`scripts/inspect`、
  `geometry_checks`)。產物寫 `models/.cadchat/<session>/`。工具只允許
  Read/Glob/Grep + cad 工具(canUseTool 沙箱)。
- **前端**(`src/`,React + Vite):還原 SUIYAO 6 區;3D 用 `packages/cadjs` three.js
  載入真實 GLB;物件屬性 / 幾何點選來自 GLB 內嵌的 STEP topology。

## 注意

- `gen_step()` 不吃參數:參數寫死在產生器 `PARAMS = {…}` 區塊。參數滑桿「套用·重生」
  走決定性路徑(改寫 `PARAMS` + 重跑 `scripts/step`,免 LLM round-trip)。
  **build 失敗自動回滾**(`buildOrRollback`):`.py` 原樣還原成上次成功值(磁碟不與
  `.step/.glb` 漂移),SSE `params_values` 事件把前端滑桿值拉回磁碟真相(defs 不動,
  不降級 `emit_params` 給的 label/範圍);中斷(aborted)不寫檔——新 turn 可能已接手。
  agent 的 `cad_build(params)` 路徑刻意不回滾(agent 接著用 edits 修)。
- 失敗錯誤呈現走 `condenseTraceback`(`python.mjs`):tool card / 開專案 / 回退的 note
  縮成「最後例外行 + 產生器內最深 frame 行號」一~兩行;產生器 `_check_params()` 的
  `ValueError` 繁中訊息直出(prompt 已規範新產生器必寫跨參數防呆)。回 agent 的
  stderr 仍是完整尾段。
- 驗證只報「真的有跑」的檢查;產圖回合一律快路徑(checks 全 SKIP,誠實揭露),
  完整驗證(有效實體 BRepCheck / 干涉 / 運動掃掠 `cadpy.geometry_checks.sweep_interference`)
  在「✓ 精算此版」與匯出閘執行;pipeline 沒有的自交、壁厚恆標 SKIP,不假裝通過。
- 開發預覽:`?glb=/api/asset?file=<models 內的 .glb 相對路徑>&name=<n>[&motion=<json>]`
  可不經對話直接把既有 GLB 載入畫布(驗 3D / 運動播放用)。
- 對話 scratch(`models/.cadchat/`)已被 `.gitignore` 忽略。**啟動時 GC** 會刪掉
  超過 `CADCHAT_GC_DAYS`(預設 7)天沒動過的 session 目錄;設 0 停用。中斷留下的
  半成品在期限內保留 —— rehydrate 與 edits 修復靠它們。

## per-user 資料隔離(2026-07-15;VM 部署啟用,dev 零回歸)

反代(BasicAuth)驗過後注入 **`X-Remote-User`** header(先刪 client 自帶值=防偽),
後端據此把每個帳號的資料切到獨立命名空間;**dev / 直連(無 header)= legacy 全域根,
行為與舊版完全一致**——所有既有測試與本機開發流程不受影響。

- **推導**:`users.mjs` 的 `rootsFor(user)` → `DATA_ROOT/users/<u>/models(/.cadchat)`;
  `USER_RE = /^[a-z0-9_-]{1,32}$/i` 白名單(webauth 帳號必須符合)。header 有值但不合法
  → 全域 403(`middleware/userContext.mjs`,middleware 鏈**首位**,掛 `req.cadchat`)。
- **session 家族自動跟隨**:`getOrCreateSession(id, {user})` 把 workdir 切到 user 根;
  registry key 含 user(**同 id 跨 user 不碰撞**=反劫持);`getSession`/`probeSessionOnDisk`
  同帶 user。`workdirRel` 仍是 DATA_ROOT 相對正斜線(`users/<u>/models/.cadchat/<id>`)
  → **spawnPython(cwd=DATA_ROOT)與 python.mjs/tools.mjs/runner.mjs 零改動**。
- **models 直接取用者帶 ctx**:`resolveModelRead(rel, {modelsRoot})` 參數化;
  `/api/asset` 是租戶邊界——`users/<u>/models/<rest>` 形只准本人(否則 403),
  legacy 形走「user 層優先、共用 fixtures 兜底」雙根。files/project/pipeline 的
  handler 都收 `req.cadchat` 第三參數。
- **刻意共享**:lessons.json(legacy `models/.cadchat/`)、`CLAUDE_CONFIG_DIR`、
  fixtures 層(`RUNTIME_ROOT/models` 唯讀)。GC 改 `gcAllSessions`(legacy+全 user 掃)。
- **定位**:同一擁有者多帳號的「資料整理+防誤用」邊界,**不是**對抗惡意 LLM 輸出的
  安全邊界(agent 沙箱/生成的 Python 同 uid,可讀整個 DATA_ROOT——見 DEPLOY.md §11)。
- **測試**:L1 `users.test.js` / `sessions.user.test.js` / `asset.user.test.js` /
  `sessions.gc.test.js`(gcAllSessions 段);L2 `tests/smoke/smoke_users.py`(已進
  run_all ORDER;直打 :8788 用 header 模擬反代)。本機開發注意:**client 側零改動**,
  但 server 發的 asset URL 在有 header 時會帶 `users/<u>/…` 前綴——寫新煙測若自帶
  `X-Remote-User`,磁碟斷言要對到 `DATA_ROOT/users/<u>/` 下。

## 草模模式(MOTION SKETCH,2026-07-14)

「**草模**」是與現行「**設計**」並列的第二種聊天模式(Header 正中央切換器):
描述機構構想 → agent 產出**宣告式場景 JSON**(基元幾何+關節+1~2 DOF 閉式運動
+動作腳本)→ 3D 視圖即時播放剛體運動示意(播放/速度/回原位、DofBar 滑桿 scrub、
傳動角紅黃綠讀數、圖例、軌跡虛線)。**零 Python、零 STEP**——快速驗證拓撲與動作,
要產可製造零件再「⇪ 轉為正式設計」。

- **模式契約(per-session 恆定)**:`mode` 在 session 出生時決定(`POST /api/chat`
  body 帶 `mode`,`sessions.mjs` persist/hydrate;hydrate 產物守衛 mode-aware——
  草模認 `<name>.sketch.json` 非 `.py`)。UI 切換=開新對話(有內容先 confirm);
  處女 session(upload 先 mint 的)首則訊息可採納 mode(`resolveTurnMode`,
  `middleware/chat.mjs`);已有歷史不符 → `400 mode_mismatch`(不靜默改道)。
- **scene schema v1 單一真相源**:`src/lib/sketch/sketchSchema.js`(normalize+validate,
  零依賴、前後端共用;**此鏈禁 import three**——asar 排除 node_modules/three)。
  求值:`sketchMath.js`(自帶 vec3/mat4)+ `sketchEval.js`(compile topo 排序/timeline
  段首 fold/致動器自動配尺寸/軌跡預取樣;evalProgram+evalPose 純函數,FSM 是 masterT
  的純函數、scrub 決定性)。mesh:`sketchMesh.js`(唯一碰 three;基元 box/cylinder/
  plate/hole + macro pin_clevis/gear/rack/link_eye;actuator/coupler/attach 派生視覺)。
  agent 契約整份內嵌 `agent/prompt.sketch.mjs`(範例由 `prompt.sketch.test.js` 用真
  validator 鎖住防漂移);工具集 `agent/tools.sketch.mjs` = 共用 emit_stage/spec/
  clarify/retry(`tools.shared.mjs` 抽取)+ `sketch_present`(驗證失敗回 errors 給
  agent 自修 ≤3 次,不寫檔不 bump;**無 Read/Glob/Grep、無 cad_***)。
- **驅動/傳動先問(2026-07-14)**:需求含運動軸而**未指明「驅動方式(汽缸/馬達)」
  或「傳動呈現(皮帶/齒輪齒條/直接耦合的加工幾何)」→ 必 emit_clarify**(拓撲級
  選擇,猜錯整台重搭;紀律搬自設計模式 prompt 的「未指明驅動必列澄清」)。一次整合
  問完:options=2~4 個**整機配置組合**(人話寫齊各軸驅動+傳動)、suggested=建議組合
  全文;已指明的軸不重複問、使用者明示免問則直接 assumed 搭;尺寸類照舊不問。
  emit_spec 逐軸出「驅動(軸名)」「傳動(軸名)」chips → 事後在視圖 SpecPanel 走
  「規格修正:」改驅動/傳動 = 拓撲變更,agent 重新設計傳動鏈後整份重送。
  配套三個**傳動呈現積木**(part macro,純視覺、零 eval/derived 改動):
  `motor{axis,at,r?,l?,shaftLen?,shaftR?}`(機身+法蘭+軸伸沿 +axis)、
  `pulley{axis,r,width,at}`(輪面+雙凸緣;role 繼承 body)、
  `belt{axis,a,b,rA,rB,width,t?}`(繞兩輪心的外公切線跑道環,掛共同安裝體;
  **由 a/b 定位、帶非零 at 或 rot 是 error**;validator 驗平面性 a/b 沿 axis 同座標
  + 輪心距 > rA+rB 輪面不相碰)。運動耦合沿用
  「同 drive + scale」:**皮帶從動 scale=rA/rB 同號;外嚙合齒輪對 −z1/z2 異號**,
  中心距=module×(z1+z2)/2(fixture:`fixtures/belt_drive.json` 馬達+皮帶減速 3:1)。
- **產物與版本**:`sketch_present` → `src/server/sketch/present.mjs` 寫
  `<name>.sketch.json` → version++ → `versions/vN/`(只凍 scene+meta)→ 發
  artifact/version/present 三事件(`type:"sketch"` + `sceneUrl` + `dofs` 摘要;
  **不帶 glbUrl/verified、禁帶 `mode` 欄位**——events.js 有已拆除雙模式的 legacy
  `mode` 映射殘留,撞名必踩)。回退走 `meta.json` 分流:複回一個 JSON 檔+
  `emitSketchPresent`,零 spawn。
- **端點行為**:草模 session 打 `/api/export`、`/api/export-parts`、`/api/validate`、
  `/api/validate-ver`、`/api/import`、`/api/save-project` → **顯式 400**(訊息含
  「草模」,不靠 404 兜底)。精算/匯出閘/教訓 digest/lesson_offer 均不適用草模。
- **前端**:`state.mode`(RESET 保留;localStorage `cadchat.mode` 記偏好;session
  事件的 mode 回聲校正切換器)。草模世界:`SketchCanvas3D`(fetch `canvas.sceneUrl`
  → 防禦性 compile → `useSketchViewport` 單 RAF 恆跑、自動播放)+ `DofBar`(純客端
  scrub,拖曳自動暫停、播放中 thumb 跟動)取代 Canvas3D+ParamsBar;StageStepper 換
  3 段(理解→搭建→演示);時間軸草模 chip=琥珀 S 縮圖+「草模」badge,動作只有
  ⟲ 回退與「⇪ 轉為正式設計」(confirm → 設計模式新對話 + 規格摘要 prefill,不自動
  送出)。dev 鉤 `window.__cadSketch`(scene/state/applyAt/setDrive/readout/frame)。
- **已知限制(v1 defer)**:另存專案/open-project/FileBrowser 不支援草模 session
  (升級路徑是草模的耐久出口);圓∩圓派生(真四連桿搖桿閉鏈)、任意表達式讀數、
  螺旋牙紋視覺排 v1.5。
- **測試**:L1 `src/lib/sketch/*.test.js`(schema/math/eval 對 ref 閉式的已知值;
  belt_drive 皮帶比閉式 + motor/pulley/belt 負案例)+
  `sketch.present.test.js`/`chat.mode.test.js`/`prompt.sketch.test.js`(含驅動/傳動
  先問措辭鎖)/`sessions.persist.test.js`(mode 段)+ events/chatStore 擴充;
  L3 `smoke_sketch.py`(切換器/注入渲染/`__cadSketch` 契約/B2 皮帶積木渲染+耦合/
  負案例/回退磁碟斷言/混排守衛/跨重整);L4 `smoke_sketch_live.py`(真回合:工具面
  隔離+場景結構最低限;訊息明說「馬達直驅」避開必問規則)+
  `smoke_sketch_clarify_live.py`(未指明驅動 → 必 clarify、含驅動/傳動關鍵詞、
  零 present——「必問」的模型判斷驗證點)。
  **注意 L1 glob**:`src/lib/*.test.js` 掃不到子目錄,要加 `src/lib/sketch/*.test.js`。

## 零件庫模式(PARTS LIBRARY,2026-07-17)

「**零件庫**」是第三種聊天模式(切換器與「草模|設計」間有**分隔線**、綠色
`--part`;創作組 vs 管理組):把原廠 STP **拖進聊天** → agent `library_preview`
轉 GLB 呈現 3D 外形+量測 bbox/面數 → `emit_spec`+`emit_clarify` **訪談一次問齊**
(名稱/型號、family、廠牌來源、備註)→ `library_add` 收進
`models/parts-library/<slug>/`(`<slug>.step` 忠實外形+`meta.json`)。
取代 FileBrowser「收入庫」鈕深埋四步的舊路(該鈕仍在,低頻備用)。

- **硬閘:先上傳才會開始**:零件庫模式的新對話(尚無訊息)未附 STP 前
  composer 鎖定(placeholder 提示、送出鈕不亮);空狀態=大型上傳區
  `LibraryDropzone`(拖放/點擊選檔,取代範例列)。附上 STP → 解鎖;訪談開始後
  (items 非空)不再鎖——使用者要能回答 AI 的追問。閘門推導在 App
  `libraryLocked`(mode/items/pendingFiles 三條件)。
- **LibraryShelf 直接看庫(不走 AI 問答)**:零件庫模式畫布上方常駐、可收合的
  卡片貨架(`components/canvas/LibraryShelf.jsx`)——每卡=**離屏 three 縮圖**
  (`src/lib/libThumbs.js`:GLB→`renderModel.capturePng()` dataURL,串行佇列單
  context、快取 key=glbUrl 含 mtime buster)+ label/family/bbox +兩動作:
  「預覽」(PRESENT 進畫布,source:"opened" 不進時間軸)、「⇪ 設計」(確認切
  設計模式開新對話 → `/api/import` 強制 mint 新 session + prefill——注意閉包裡
  的舊 sessionId 是零件庫 session,`importFile(rel, {sessionId:null})` 顯式覆寫)。
  刪除收進標頭「**管理**」批次模式(破壞性動作不常駐卡面):進模式後點卡選取
  (紅框+✓ 角標,預覽/⇪ 設計讓位)→「刪除 N 件」二段確認 → 逐件序列打既有
  單 slug `/api/library-delete`(server 零改動),完成後自動退出。
  縮圖鏈:收庫兩路(endpoint+agent 工具)成功後
  fire-and-forget `ensureStepGlb` 順產庫內 GLB sidecar;缺 GLB 的卡由
  `POST /api/library-glb` 按需補轉(序列,防 spawn 突刺)。
- **瀏覽端點**:`GET /api/library-list`(meta+GLB 存在性,addedAt 降冪)、
  `POST /api/library-glb {slug}`(補轉)、`POST /api/library-delete {slug}`
  (整目錄移除;slug 過 librarySlug+resolveInside 沙箱)。

- **mode 白名單單一真相源**:`src/lib/chatModes.js`(`MODES=["design","sketch",
  "library"]`;`normalizeMode`=垃圾收斂 design 供 reducer/persist/hydrate、
  `isMode`=嚴格判別供 events 校正/`resolveTurnMode`——兩語意分別被
  chatStore.test 與 events.test 鎖死,勿統一)。全庫已無散落的
  `=== "sketch" ? "sketch" : "design"` 三元式(那會把新 mode 靜默壓成 design)。
- **STP 上傳鏈**:`POST /api/upload-step`(`middleware/upload.mjs`;
  octet-stream、25MB 上限含排水語意、magic 檔頭 `ISO-10303-21` 嗅探=
  `src/server/stepFiles.mjs`)→ 落 session `uploads/` → `/api/chat` body 帶
  `stepRefs`(`readStepRefs` 雙沙箱+重嗅探,**非 library session 直接丟棄**)→
  `buildUserText` 只注入路徑註記(STEP 不進 content blocks)。Composer 的
  accept/貼上/拖放只在 library 模式收 `.step/.stp`(App `attachFiles` 雙保險);
  附件佇列泛化為 `pendingFiles`(`kind:"image"|"step"`,step chip ▤ 無縮圖)。
- **工具集**(`agent/tools.library.mjs`;prompt=`agent/prompt.library.mjs`):
  共用 emit 4 工具 + `library_preview`(轉檔管線重用 `cad/stepPreview.mjs`
  ——從 files.mjs 抽出的 `ensureStepGlb`/`inspectFactsAbs` choke point;
  **只發 present 事件**,`source:"opened"`、不發 version/不動 lastName——
  收庫不進時間軸)+ `library_add`(重用 `addLibraryPart`;`resolveLibrarySource`
  只准 `uploads/` 與 models/ 相對路徑,**絕對路徑拒收**;CJK slug 全滅防呆
  =淨化退 "part" 時回 error 要英數 slug)。白名單 `LIBRARY_ALLOWED` =
  Read/Glob/Grep(查庫)+ 6 MCP 工具;lessons digest 不注入(同草模)。
  family 分類單一真相源 `src/lib/libraryFamilies.js`(9 類;FileBrowser 下拉、
  z.enum、prompt 分類表同源)。
- **family 是跨來源共用的分類軸**(用語約定):同一個 family 詞彙表底下有兩種
  零件「容器」——講「**產生器家族**」指 cadpy.parts 那組程式、「**庫件**」指
  收藏的原廠 STP、「**family**」保留給分類值本身(`LIBRARY_FAMILIES` 變數名
  =庫件允許的 family 列舉,不動)。分類名刻意與產生器家族**同名對齊**
  (`linear_guide` 對 `linear_guide`),agent 靠同詞彙判斷「庫裡撈現成 vs
  cadpy.parts 生一個」,勿改成 category 之類把對映變隱性:

  | | cadpy.parts 產生器 | 零件庫庫件 |
  |---|---|---|
  | 幾何來源 | 參數閉式生成(build123d) | 原廠 STP 原樣收藏 |
  | 能調尺寸 | 能(滑桿/選型換型號) | 不能 |
  | 適用 | 有規格表、可參數化的標準件 | 只有原廠圖檔、不值得重建模的件 |
- **端點行為**:library session 打 export/export-parts/validate/validate-ver/
  import/save-project → 顯式 400(`rejectNonDesignSession`,訊息含「零件庫」;
  草模訊息字樣「草模」不變)。hydrate 產物守衛第三分支:library 無建模產物
  (lastName 恆 null),artifact=null 跳過檢查。
- **前端**:StageStepper 3 段(選檔→訪談→收庫);空狀態/範例/placeholder 專屬
  文案;畫布=Canvas3D **無 ParamsBar**(預覽 `source:"opened"` 讓拆件匯出閘
  天然關);時間軸動作鈕全走 `designMode` 閘。跨重整:RESTORE 走 library
  守衛(versions 恆空天然放行),畫布 glbUrl 回灌。
- **測試**:L1 `chatModes.test.js`/`stepFiles.sniff.test.js`/
  `prompt.library.test.js`(白名單 deepEqual+prompt 字面鎖+FAMILY_DESC 鍵集合)
  + chat.mode/chatStore/events/sessions.persist/library.test 各 library 案例
  (含 listLibraryParts/deleteLibraryPart);
  L3 `smoke_library_mode.py`(護欄/upload 正負案/切換器/硬閘鎖與解鎖/附件流/
  LibraryShelf 縮圖·預覽·刪除/跨重整);
  L4 `smoke_library_live.py`(四回合:preview+必問+零 version → 收庫落盤 →
  查庫回答 → **庫件匯入新設計 session 配安裝底板組裝**——產生器引用 imported/
  的磁碟證據)。

## MOTION 運動宣告(linear + revolute + couple)

產生器模組層宣告(與 `INTENDED_CONTACT` 同慣例),**一份真相三個消費者**:
(a) validate.py 據此建 poses 跑真運動掃掠(per-「群」獨立掃、baseline=seated、
預算 600 pair-frames / 每 DOF 12 對 / 75s 深水閘,降級誠實寫進 note;無耦合時
一群=一個 DOF,舊語意不變);
(b) `cad_validate` / 滑桿重生後一律 `emit("motion")`,前端畫布出現「▶ 運動示意」
(三角波往復、多 DOF 疊加=ride-along 依宣告序矩陣疊加、非物理模擬);
(c) travel/angle_deg 引用 `PARAMS` → 滑桿重生後 import 重解析,播放與掃掠自動跟新值。

支援兩種 dof:`linear`(沿 axis 平移 travel)與 `revolute`(繞「過 pivot、方向 axis」的軸
旋轉 angle_deg;= URDF revolute 關節語義)。**嚙合傳動(齒輪齒條/齒輪對)加
`"couple": "<主動 dof id>"`(2026-07-10)**:從動 dof 與主動 dof 由同一參數 u 同步驅動——
掃掠把耦合群「真滾動」一起掃(跨成員 pair 如 rack×pinion 保留,正是被驗證的嚙合面;
比率不符純滾動 travel = R×θ(rad) 會被抓到穿透),前端播放從動借主動的 period+相位
index(嚙合不打滑;獨立 dof 仍相位錯開以便辨識)。規則:主/從都必須明給 pairs、
禁止鏈式耦合。`schemaVersion` 維持 `1`(加法式擴充)。

```python
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "x", "label": "X 行程", "type": "linear", "axis": [1, 0, 0],
         "travel": PARAMS["x_stroke"],        # 必引用 PARAMS
         "moving": ["x_carriage", "bridge"],  # AssemblyHelper label(在組合件內必須唯一)
         "pairs": [["x_carriage", "x_rail"]], # linear 省略 → 掃掠 AABB 預過濾自動配對
         "samples": 8},
        {"id": "flip", "label": "90° 前傾", "type": "revolute", "axis": [0, 1, 0],
         "pivot": [0.0, 0.0, -31.0],          # 旋轉軸通過點(mm,產生器/STEP 座標)
         "angle_deg": PARAMS["flip_deg"],     # 必引用 PARAMS(角度制)
         "moving": ["bracket", "gripper", "jaw_left"],
         "pairs": [["bracket", "body"]],      # revolute 必明給 pairs(不走 AABB 自動配對)
         "samples": 24},                       # 旋轉弧建議較密(抓中程最深穿透)
    ],
}
```

**規則**:revolute 必明給 `pairs`;某件同時被平移+翻轉承載時,revolute dof 宣告在該 linear
dof 之後(ride-along 讓翻轉在外層合成 R·T)。前端播放器 `src/lib/cadMotion.js` 用
`frameMatrix`(純數學抽在 `src/lib/cadMotionMath.js`,可 `node --test`)把每 dof 算成
Matrix4 疊加(linear=平移;revolute=`T(+pivot)·R(axis,θ)·T(−pivot)`)。原生關節基準用
`asm.revolute_frame(part, name, Axis(pivot, axis))` 嵌進 STEP。範例模型:
`models/flip_gripper`(90° 前傾鉸鏈,`flip_deg` 滑桿;托架幾何已讓 0→90° 全程淨空)、
`models/steering_box_rack_pinion`(齒輪齒條式迴轉缸內部機構,照 ref sim 尺寸:m0.7 z14、
行程 7.70↔90°;**gear family + couple 的 dogfood**——linear 齒條主動 + revolute pinion
從動,嚙合零 INTENDED_CONTACT)。

**齒輪原子概念(cadpy.parts gear family,2026-07-10)**:齒輪/齒條幾何**不要手刻**——
`from cadpy.parts import gear, gear_rack, pitch_radius, rack_mesh_phase_deg`。齒腹是
「過真漸開線點的折線」(基圓/節圓/中齒頂/齒頂;基圓下走徑向線),配 0.05 背隙即可
與直邊齒條(精確基準齒形)純滾動零穿透——單弦梯形齒做不到(需隨 module 放大的減薄),
所以嚙合面不必進 INTENDED_CONTACT,掃掠是真檢查。嚙合座標系(相位閉式的單一真相):
齒輪軸=局部 +Z 過原點、齒條在 -X 側沿 Y 滑移(節線 x=0,置於 x=-pitch_radius)、
齒條齒心落 y=k·p 格點;`rack_mesh_phase_deg(module, teeth, rack_y_offset)` 回傳讓兩者
正確嚙合的 `tooth_phase_deg`。選型 `select_gear(torque_Nm, shaft_dia?, teeth_min?)`
(KHK SS 目錄列,容許轉矩取彎曲/齒面耐久較小者——非硬化 S45C 由齒面耐久支配)。

畫布互動:拖曳旋轉、`⟳ 環繞`(turntable)、**單擊圈選零件(多選 toggle,上限 4)**
(選中高亮+其餘 ghost+屬性抽屜連動最後選件+「帶入對話 (N)」;再擊同件移除、
擊空白清空;位移 >5px 視為旋轉不觸發)、**雙擊=確保選中+鏡頭推近**、
點菱形標記帶入幾何參考。

**逐件透視(物件樹眼睛三態,2026-07-10)**:物件樹每個零件列有 ● 眼睛,點擊循環
solid → **ghost(半透明 0.16,琥珀;滑鼠射線點擊穿透——透視外殼直接圈選內部件)**
→ hidden(整件隱藏,標籤刪除線)→ solid。齒輪箱這類「殼包機構」把 housing 轉
ghost 就能看內部滾動。**樹節點點擊同時連動 3D 圈選(toggle)**——殼擋住 raycast
點不到內部件時,從樹選是逃生口。眼睛狀態隨新模型載入重置;實作:圈選與眼睛兩個
正交來源合流在同一次 `applyPartVisualState`(hidden 走原生 `hiddenPartIds`、ghost 走
`record.effectStyle.opacity`,與運動示意的 `effectMatrix` 正交可同時作用);dev 鉤
`__cadVisual.display()/stateFor(label)`。

## 單一快路徑 + 匯出閘(2026-07-10 收斂;前身為 2026-07-09 的產圖雙模式)

2026-07-10 的效用實測(`tmp/eval_output_mode/REPORT.md`)證實:雙模式的幾何產物逐位元組
相同、下載/匯出從未依模式設限,唯一實質差異是「標準化驗證跑不跑」(滑桿每輪差 8.7~24.5s、
快速迭代回合差 ~36% wall)。據此把 toggle(連同確認框/氣泡染色/切換 hint/`outputMode`
欄位)**全數拆除**,收斂成:**產圖一律走快路徑,完整驗證移到「出口」把關**。

- **產圖一律快路徑——零 spawn**:build(`scripts/step`)時 cadpy 順帶收割模組層 MOTION +
  權威 parts,原子寫 `.{name}.step.meta.json` sidecar;`runStep` 讀進 `session.lastBuildMeta`,
  `cad_validate` / 滑桿重生走 `runValidateDesign` **不 spawn 任何 Python**(spawn 路徑
  ≈12s → ~10ms)。checks 六列全 skipped(文案與 `--motion-only` 逐字一致,
  `designChecksFromMeta` 註解標對照行)、MOTION 照 `emit("motion")` 供「▶ 運動示意」、
  asm manifest 照寫。缺 sidecar(rehydrate 後沒 build 過)退回 `validate.py --motion-only`
  spawn fallback。空洞綠**不**閉環教訓迴圈(閉環由 build 綠的 `noteBuildSuccess` 承擔)。
  注意 build 本身仍執行產生器自帶的 `check_geometry`(cadpy `generation.py` 的 opt-in 閘):
  靜態壞幾何在任何路徑都活不過 build,連版本都不會產生。
- **匯出閘(`ensureVerifiedForExport`,project.mjs)**:`/api/export`(STL/3MF)與
  `/api/export-parts`(拆件 zip)出檔前,未驗證的版本**自動補跑完整驗證**——通過才轉檔
  (回應帶 `gate:{ran,ok,ver,checks}`,前端落成驗證卡 + badge 轉綠),未過回
  `ok:false` + 「匯出已擋下」+ 紅 checks。agent 的 `cad_export` 工具走同一道閘
  (turn 內未驗證先 full 驗證、未過拒絕出檔並回 checks 給 agent 自修)。已驗證版(open-project/revert 出生即 full、
  精算過、閘驗過)走 in-memory memo(`session._verifiedVers`)免重驗、秒放行;伺服器
  重啟後首次匯出重驗一次冪等補登。**STEP 直下載**(`/api/asset` 是裸 GET)由前端把關:
  未驗證版的「⤓ STEP」鈕先打 `POST /api/validate-ver {sessionId, ver}`(同一道閘的單獨
  入口),verified 才觸發下載;已驗證版/開檔檢視版直連 href。閘是 UX 契約非安全邊界
  (單人本機 app,直接敲 asset URL 仍可繞過)。
  - 快照驗證細節:匯「最新版且基準未漂移」走頂層 `runValidate`(頂層有 `imported/`,
    含匯入件的組合件也驗得動);舊版快照驗快照本體(`validateSnapshotFull`,不動頂層
    狀態)——**倚賴 `imported/` 的舊版快照會誠實紅在「產生器執行」**,此時先「⟲ 回到
    此版繼續」再匯出即可(快照不複製 imported/ 的已知限制)。
- **MOTION 單一真相源**:正規化搬進 `packages/cadpy/src/cadpy/motion_decl.py`
  (`normalize_motion`/`playback_motion`,純 stdlib);validate.py `_read_motion` 與 build
  收割都委派它,兩邊逐位一致(`apps/cad-chat/tests/test_build_meta.py` 釘死)。改 cadpy 後
  **必跑 `scripts/dev/sync-vendored.sh`**(venv editable 指向 vendored 複本,不同步直接
  ImportError)。
- **版本驗證狀態(`versionStamp`)**:`version` 事件帶 `verified`(server 權威:
  `runStep` 開跑清 `_lastValidate`、驗證結束記 `{full,ok}`,full 且全過才 `verified:true`;
  快路徑產圖一律 `false`)。版本時間軸掛琥珀「未驗證」/ 綠「✓ 已驗證」badge(舊資料
  `undefined` 三態不渲染、不誤報;舊快照的 `mode` 欄位是雙模式遺留,原樣透傳無人讀)。
- **精算此版**:快路徑版已寫精確 STEP → 版本時間軸 `✓ 精算此版`(工作基準未驗證時琥珀強調)
  對最新版跑 full `runValidate`(`POST /api/validate`),不重新產生;成功且全過 →
  `MARK_VERSION_VERIFIED` badge 轉綠 + 最新版進匯出閘 memo(之後出檔免等閘)。三道防護:
  (1) **session 綁定**——精算跑數分鐘,回來時 session 換人就整包作廢;(2) **stale 基準**——
  上輪 build 後被中斷沒 present 時頂層 ≠ 最新快照,回 `stale:true`(`_geomDirty`),前端
  只出驗證卡、不 MARK 不掛 motion;(3) **motion/verified 一律綁 latestGen**(不綁
  `canvas.ver`)。已知限制:精算/匯出閘期間送訊息會撞 server busy,由既有 409 佇列重試消化。
- 運動示意動畫照常(播放很便宜,`cadMotion.js`);開既有專案 / 回退一律 full 驗證
  (出生即已驗,匯出免等閘——它們的 `runStep` 也會 prime sidecar)。

## 兩步澄清精靈 + 圖片附件(2026-07-10)

### 兩步澄清精靈(取代舊的單卡選擇題)

使用者回饋:「解析規格」與「需要澄清」兩處各說各話、沒有先後次序,且澄清問題整段複述
規格 chips、還印出字面 `\n`。整改為**單一決策面的兩步精靈**:

- **資料流**:`emit_spec` 的 chips 進 store `turnSpec`(`START_RUN` 清空——精靈只信本回合
  的規格快照);`emit_clarify` 到達時 `SET_CLARIFY` reducer 把 `turnSpec` 併進
  `clarify.specs` 並 mint 遞增 `id`。**純前端組裝**,不擴充 emit_clarify schema(不讓模型
  再抄一次規格)。無 spec 的回合(如多件結合提問)`specs=null` → 精靈退化單步。
- **精靈**(`ClarifyWizard.jsx`,容器沿用 `.canvas-clarify` 聚光燈卡;`key={clarify.id}`
  → 跨回合新 clarify 自動 remount 歸零):
  - 步驟 1/2「確認解析規格」:chips 全列,標「假設」的(琥珀 badge)可點開 **inline 輸入框**
    修改(累積在元件 local state 的 `edits`);按 `確認規格 →` 才進步驟 2(閘門)。
  - 步驟 2/2「需要你決定」:q + 選項 + 建議組合列;有修改時多「僅套用修正」鈕與修正摘要,
    `← 返回規格` 可回頭。所有送出走 `composeClarifyReply`(`src/lib/clarifyText.js` 純函式)
    合成一則人話回覆:`規格修正:導軌 改為 HGR20。\n其餘採用:{選項 value}`——
    「規格修正:」前綴是 prompt 契約(個別修正**優先於**選項文字內嵌的假設值)。
- **「假設」偵測**:emit_spec chips schema 加 `assumed: z.boolean().optional()`(結構化
  旗標為主);前端 `isAssumedChip` 同時認 v 內「(假設)」文字慣例(舊快照/模型不聽話
  fallback),顯示時 `stripAssumedTag` 剝字樣改 badge。
- **左欄降為被動紀錄**:ClarifyCard 選項變 `.static`(pointer-events:none)存檔 pill,
  待答時顯示「作答中 · 請在右側畫布回答 ▸」;答完 transcript 自然是「問題+選項紀錄 →
  使用者氣泡(所選答案)」。精靈故障逃生口=composer 直接打字(`ADD_USER` 即清 clarify)。
- **RESTORE re-arm**:重整後 transcript 尾端有未答 clarify(其後無 user)→
  `pendingClarifyFromItems` 連同同段最近 spec 重建 `state.clarify` → 精靈/凍結
  一致重現(順帶修掉舊版「重整後浮卡消失只剩左欄卡」的斷面);已答不 re-arm。
- **字面 `\n` 修復(三層)**:根因是模型在 tool JSON 裡雙重跳脫。server choke point
  (tools.mjs 的 emit_spec/emit_clarify handler)以 `unescapeNewlines` 正規化全部文字欄位
  (q / opts.label / opts.value / suggested / chips k+v——value 會被原樣送回,一併處理)+
  前端 events.js 同 helper 防禦一次 + CSS `.clarify-q`/`.canvas-clarify-q` 加
  `white-space: pre-line`(真換行才真的斷行)。
- **prompt 消冗**:`emit_clarify` 的 question 改為「一兩句描述決策點本身」,不再要求列出
  各假設值(chips 已承載、精靈步驟 1 會呈現)。

### 圖片附件(上傳工程圖跟 AI 討論)

場景:上傳馬達外形圖(含 ARM66/ARM69 尺寸表)+「幫我繪製對應的馬達固定座」→ agent
讀圖抽尺寸;**圖中多型號而使用者未指定 → 型號必列入 emit_clarify options,不得擅選**
(prompt「# 圖面附件」節)。

- **上傳**:`POST /api/upload-image?sessionId=<id?>&name=<原名?>`——位元組直傳(非 JSON/
  multipart;`readRawBody` 上限 3.5MB/張,超限回 413 並排水丟棄)。**magic bytes 嗅探**
  (`src/server/images.mjs`,png/jpeg/gif/webp)是 media_type 與落地副檔名的唯一真相,
  不信 client content-type 與原檔名(嗅探失敗 415)。檔案落 `<workdir>/uploads/`
  (與 session 同生命週期同 GC),回 `{ok, sessionId, rel, url}`;無 sessionId 順手建
  (同 `/api/import` 模式)。
- **前端**:composer 附件鈕 ⌲ + Ctrl+V 貼上 + 拖放;**選檔即上傳**,縮圖 chip 直接用
  `/api/asset` URL(uploading 半透明/error 紅框 ✕ 可移除);上傳中送出鈕鎖住;純圖無
  文字可送。送出時 `/api/chat` body 只帶輕量 `imageRefs:["uploads/…"]` → 佇列/409 重試
  原封重送也只是 rel 字串(冪等,不重傳位元組)。user 氣泡渲染縮圖,GC 後 404 走
  `.broken` dashed 降級。
- **進 agent**:`readImageBlocks`(chat.mjs)從 workdir 讀檔(強制 `uploads/` 前綴 +
  `resolveInside` 雙沙箱、重嗅探)組 base64 image blocks,排在 text block 前;
  `buildUserText` 尾附「(附圖 N 張:…)」註記(transcript/教訓錄製可讀、純圖訊息不空)。
  **runner 的 prompt 恆走 streaming input**(async generator yield 單則 user message)——
  SDK 的字串 prompt 會被傳輸層硬編成純 text block,永遠帶不了圖;resume/canUseTool 與
  prompt 形狀正交(`smoke_queue_live` 實測綠)。帶圖訊息不走參數決定性重生路
  (paramsOnly 條件擋)。
- **已知限制(token 成本)**:圖片 base64 內嵌後進 SDK transcript,**每次 resume 重放
  都重付**(單張上限 ~1.6k tokens;CLI prompt cache 5 分內命中約一折)。緩解:上限
  4 張/訊息、建議先裁切到需要的區域;不做自動壓縮。

## 量測尺寸(前端 facts 即時,2026-07-15)

3D 檢視器「📏 量測」工具 chip:進量測模式 → 點兩個面 → **即時**顯示有號距離 + 3D 尺寸線(微秒,
免 round-trip、免「量測中」)。與既有「幾何點選 → 帶入對話 → agent 改模型」的**命令流**乾淨分離
——量測是**唯讀查詢流**,不進聊天、不觸發 agent(設計模式:State/Mode + Query/Command 分離)。

- **計算在前端**(`src/lib/measureFacts.js`,純函數,零 three/cadjs 依賴):把後端 `cadpy.analysis` +
  `inspect.measure_targets` 的數學(沿軸座標差 + 歐氏 + 向量關係 + 軸推斷)搬到前端,用 runtime 已載的
  `pickData` facts(center/normal/surfaceType/params,世界座標)即時算。**精度=後端 measure_targets**:
  後端本來就是「讀 manifest facts 算」(非 OCP),那 ~11s 花在 inspect 載入 selector bundle,而前端渲染
  時早已載入 → 前端算距離是微秒級。**座標系一致已驗證**(前端 `pickData.center` 與後端 manifest row
  逐位相同)。限「面對面」(檢視器量測範圍)。
- **防漂移(第二計算源紀律)**:`src/lib/measureFacts.test.js` 對真 pickData 斷結果逐位等於後端
  `inspect measure` CLI 的 golden(f1→f2=320/x/opposed、圓柱→平面=-63、垂直面=0/perpendicular)。
  **動 `cadpy.analysis` 的 positioning 數學時,這裡的 golden 要一起更新**。
- **前端接線**:`useCadViewport` 的 `onClick` 在量測模式分流到面級 pick(`hit.faceIndex →
  mesh.userData.faceIds → runtime.faceReferenceByRowIndex → pickData`),`measureGroup`(仿 `bendGroup`)
  畫端點球 + 連線;measure effect **同步**呼叫 `measureBetween(p.pick, q.pick, axis)` → HUD 顯示距離/軸/
  面法向關係 + 3D 中點浮動數值標籤(`.project(camera)` 投影,仿 `updateMarkers`)。無共同軸 → 露出
  x/y/z 軸 fallback chip(重算)。量測用綠色系(`#1f9d55`)區別 emit 青「帶入對話」/amber「已帶入」。
- **gotcha**:①`onMeasurePick` 被同步傳入 `useCadViewport`,必須定義在 hook 呼叫「之前」否則 TDZ
  白屏;②`setMeasure`/`clearMeasure` 由 hook `onReady` 導出後,Canvas3D 的 `onReady` 解構要接住並存進
  `apiRef.current`,漏接則靜默 no-op(3D 線不畫)。
- **無後端端點**:量測純前端不打 HTTP;agent 的 `cad_measure` 工具(直接 spawn inspect,建模時用)獨立
  不受影響。**未來若要 OCP 曲面對曲面真實最短距離**(`BRepExtrema`,前端 facts 做不到)——那是另一種
  計算,屆時新加後端端點,不是復用 facts。
- **dev 鉤** `window.__cadMeasure`:`mode()/picks()/result()/groupCount()/setMode/pickFace(row)/
  faceRows()/faceFactsOf(row)`(全讀 ref,不受 `[playing]` deps stale 影響)。
- **驗證**:`measureFacts.test.js`(L1,8 項對後端 golden 逐位)+ `smoke_measure.py`(L3,?glb= 直開免
  session → pickFace×2 → 即時 result==320 + 尺寸線 + HUD 無「量測中」)。

## 路徑掃出(sweep)+ 無塵護套 + STP 零件庫(2026-07-16)

**幾何掃出**(2D 封閉輪廓沿路徑實體化)落地為 `cadpy.parts.sweep` 家族,repo 首個
幾何掃出能力(先前的 "sweep" 全是運動掃掠驗證):

- **API**(`from cadpy.parts import …`):`swept_solid(profile, path, wall_t=…)`
  通用掃出(circle/stadium/rounded_rect/polyline 輪廓 × line/waypoints/drag_chain
  路徑;`wall_t>0`=空心薄壁);`cleanroom_sleeve(pockets, pocket_w, …)` Elocab EHSL
  無塵護套(N 豆莢橢圓弧帶,總寬=N×(袋寬+1)+3 型錄閉式);`kcl_clamp`/`clamp_location`
  端部固定頭;`select_sleeve`/`select_kcl_clamp` 選型(specs:`ehsl_sleeves.json`
  /`kcl_clamps.json`);`path_polyline(path, n)` 等弧長取樣(零 OCP)。
- **kernel 陷阱由 API 建構保證擋**(BRepCheck 對這些全判 valid,不能靠驗證):路徑
  弧側(ThreePointArc 解析中點,無 RadiusArc 正負號歧義)、接點相切(彎角必給圓角
  半徑)、彎徑地板(r−輪廓半高≥0.5mm 否則 ValueError)、空心=帶孔面一次掃優先
  +失敗退外/內雙掃相減。閉式測試:`tests/python/packages/cadpy/test_sweep_parts.py`
  (Pappus 體積、總寬、零扭轉 bbox 證人)。
- **路徑預覽 overlay**:generator 模組層 `SWEEP_PATHS=[{"label","points":
  path_polyline(同一路徑 spec)}]` → build meta 收割(`_harvest_build_meta`,壞項
  整條丟棄、8 條×512 點上限)→ `.{name}.sweep.json` sidecar → `sweepPathsUrl`
  (**完全鏡射 flatLinesUrl 全鏈**:快照凍結清單、revert 複回清單、emitPresent、
  version/present 事件、events/chatStore/App.jsx 兩處手組 PRESENT——漏任一處跨
  切版/重整就失效)→ `useCadViewport` sweepGroup(dashed LineSegments,
  `depthTest:false` 因中心線在空心體內部)+「⌒ 路徑」chip + `__cadChrome.sweepPaths()`。
- **滑桿硬化**:`rewriteParams` 傳入值先以磁碟現值墊底 merge——agent 只 emit 部分
  滑桿(舊 KeyError gotcha)或前端漏鍵時,子集=只改那幾鍵,其餘不蒸發。
- **dogfood fixtures**:`models/cleanroom_sleeve_x`(6袋16mm+雙端 KCL,對齊原廠
  `models/ref-cable-sheath/cable_x.stp`)、`models/cleanroom_sleeve_y`(select_sleeve
  電纜清單選款、直段 600、單端夾板)。
- **驗證**:L1 `pipeline.sweep.test.js`/`sweepOverlay.test.js`/chatStore/events 案例、
  cadpy 側 `test_build_meta_sidecar.py` 收割案例;L3 `smoke_sweep_overlay.py`
  (API 鏈+子集重生 lockstep+UI chip/探針+負案);L4 `smoke_sweep_live.py`
  (agent 採用契約:cleanroom_sleeve/SWEEP_PATHS/型錄彎徑/總寬實測)。

**掃出工作窗 + 參數列 number 化(2026-07-16 二輪)**:

- **「⟜ 掃出」工作窗**(掃出件專屬視圖功能,fold-switch 同位階 chip):浮動
  雙欄視窗蓋在 3D 上——左半=路徑 2D 圖(baked=sidecar 灰虛線;live=現值即時
  取樣,`src/lib/sweepView.js` **逐式鏡射** cadpy `_resolve_path`/`_seg_point`
  等弧長取樣,golden 測試釘死,套用後兩層逐字重合)+路徑參數 NumberField
  (改值即時重畫,按套用才重生 3D);右半=輪廓 2D 剖面(`fill-rule:evenodd`
  鏤空內腔)+輪廓唯讀 chips+「💬 用對話修改輪廓」(SET_PREFILL;輪廓只能
  透過 chat 改)。資料源=sidecar 新增選配 `view` 欄位(generator 模組層
  `SWEEP_VIEW`:pathKind/pathParams=PARAMS 鍵/profileParams=值物件/
  profileLoops=`sleeve_profile_loops()`/`profile_loops()` 零 OCP 取樣;
  `_harvest_sweep_view` 任一欄壞=整份 None)。開闔不隨版本重置;clarify 讓位;
  dev 鉤 `__cadSweepWin`。
- **參數列 number 化**:range 拉桿 → `NumberField`(text input+▲▼ 步進;
  `def.int===true` 鎖整數(唯一判準,禁 step==1 啟發式)、float 兩位小數、
  clamp min/max、blur/Enter commit、未聚焦一律渲染 prop 值=回滾事件可拉回);
  `.paramsbar-track` flex-wrap 換行+max-height 封頂,不再橫向捲動。
  草模 DofBar 仍用 range(純客端 scrub,語意不同)。
- **float-ness 連鎖雷修復**:`toPyDict` 對「源碼字面含小數點的鍵」把整數值寫成
  `20.0` 形(`paramFloatKeysFromGenerator`)——否則重生一次小數點蒸發,
  `paramDefsFromGenerator` 整數啟發式把 mm 參數誤掛 `int:true` 鎖死。
- 驗證:`numberField.test.js`/`sweepView.test.js`(golden)/pipeline sweep+params
  擴充;L3 `smoke_sweep_window.py`(19 斷言:sidecar view/開窗/live 即時零 chat/
  套用跟版重合/prefill/int/clamp/負案);`smoke_open_project.py` 滑桿斷言改
  numfield。emit_params 契約加 `int:true`;掃出配方段加 SWEEP_VIEW 必宣告。

**STP 零件庫 MVP**(`models/parts-library/<slug>/{<slug>.step, meta.json}`):把
外部 STP(如新汽缸)收成耐久忠實外形庫,重複引用不重新生成。

- **收庫**:FileBrowser step 列「收入庫」inline 表單(名稱+family)→ 免 LLM
  `POST /api/library-add {file,label?,family?,notes?,overwrite?}`(來源重用
  `resolveImportSource` 沙箱;bbox 用 inspect facts best-effort;同 slug 回
  `exists` 由前端二次確認覆蓋)。純邏輯在 `src/server/cad/library.mjs`(L1 直測)。
- **用庫**:零新機制——agent 白名單本就有 Glob/Read,prompt 教它
  `Glob models/parts-library/*/meta.json` → `Read` 核對 → `cad_import(...)` 走既有
  imported/ 慣例(**generator 絕不直引 models/ 路徑**,否則 session 自包含不變式
  全破)。分工:`cad_source_part`=選型簡化替身;零件庫=忠實外形。
- **驗證**:L1 `library.test.js`;L3 `smoke_library.py`(收庫磁碟斷言+負案 5 發+
  UI inline 表單流+庫內檔不套娃)。

## 視圖作答面(2026-07-14):需要使用者回答的一律在視圖操作

原則收斂(兩模式通用):**凡需要使用者作答的「選項類/規格類」互動,唯一作答面在
3D 視圖區;聊天卡一律是被動紀錄**(clarify 聚光燈精靈 2026-07-10 已如此,本輪把
剩下兩個聊天內互動一併遷移)。聊天側僅保留非作答型操作(計畫/LOG 展開、產物卡
「在 3D 開啟」等導航)。

- **規格修正 → `SpecPanel.jsx`**(視圖左上,`.canvas-spec`,可收合):資料源=
  transcript **最新一張 spec 卡**(`latestSpecItem`,`src/lib/clarifyText.js`;跨回合
  持續有效——它就是目前設計的已解析規格,RESTORE 免額外持久化)。**全部 chip 可點**
  開 inline 輸入框修改(不限「假設」——事後修正=變更請求),`套用修正(N)→` 走
  `composeClarifyReply({edits})` 的「規格修正:」prompt 契約送出(回合中送出由佇列
  接手)。父層 `key={spec.id}`:新 spec 到達即 remount 歸零 edits。聊天 SpecCard
  eyebrow 改「解析規格」、chips 變 span 不可點無 ✎,最新一張標
  「可修正 · 請在右側畫布操作 ▸」指路(同一 helper 推導,兩端不漂移)。
  舊行為(點聊天 chip 預填 composer 的 `onChipEdit`)移除。
- **教訓是/否 → `LessonOfferPanel.jsx`**(視圖下方置中,`.canvas-offer`):資料源=
  **最舊一張未答** lesson_offer(`pendingLessonOffer`;佇列語意——多張未答依序輪答,
  答完自動出下一張;`answered:"pending"`(POST 進行中)留在原卡顯示「加入中…」)。
  按鈕仍走 App 的 `onLessonOffer`(樂觀收鈕/防雙擊/失敗回滾邏輯不動)。聊天
  LessonOfferCard 未答顯示「請在右側畫布回答 ▸」,答過顯示結果(隨 RESTORE 存活)。
- **chips 編輯器抽共用 `SpecChips.jsx`**(受控 edits;inline 草稿自持,卸載即棄):
  ClarifyWizard 步驟 1 與 SpecPanel 共用;`editableAll` 開關(精靈只讓「假設」可改,
  面板全開)。編輯中 chip 的視覺從硬編碼 `data-assumed="true"` 改 `data-editing`。
- **讓位規則**:clarify 待答時兩個面板都隱藏(`!clarify`)——精靈步驟 1 本身就是
  規格確認面,scrim 也會蓋住下層互動,不重複、不誤觸。**面板未套用的草稿會轉交
  精靈續用**(SpecPanel `onEditsChange` → App `specDraftRef` → ClarifyWizard
  `initialEdits`,只收本份規格有的鍵;面板重掛即清 ref 防重複 seed)——否則
  「emit_spec 後幾秒 emit_clarify」的標準流程會把剛改的值靜默丟掉。
- **對抗審查後補上的護欄(2026-07-14 同輪)**:
  - `CLEAR_WORKSPACE`(open-project 換 session=換設計)把舊 spec 卡標 `stale`,
    `latestSpecItem` 跳過——否則舊設計的規格面板浮在新專案上,套用會把無關鍵值
    打進新 session;聊天指路同 helper 一併熄滅。
  - `RESTORE` 把 lesson_offer 的 `answered:"pending"`(POST 在途時關頁落盤的樂觀
    暫態)收斂回未答——否則面板永久「加入中…」且佇列頭死鎖,聊天卡已無按鈕可解。
  - `submitText` 回傳布林(同步早退=false),SpecPanel 套用失敗**保留 edits** 供
    重試(附件上傳中/唯讀升級失敗不再靜默蒸發修正)。
  - specs 空的 clarify(單步精靈)待答時聊天 spec 卡的指路熄滅(右側沒有規格面)。
  - CSS:`.canvas-spec` 有 max-height+內捲(chips 多時套用鈕不被 `.canvas`
    overflow:hidden 裁掉);`.canvas-offer` bottom:88px(不與 `.sel-nameplate`
    同位直疊)。
- 煙測:`smoke_spec_panel.py`(聊天卡靜態化/面板修改套用契約/同鍵 remount/收合/
  雙面板 clarify 讓位/草稿轉交精靈/單步 clarify 指路熄滅/草模模式共用)+
  `smoke_lesson_offer.py` UI 段改打視圖面板(佇列輪答/防雙擊/record 失敗回滾)。

## 元件 / 組合件檔案類型 + 開檔 / 匯入 / 結合(2026-07-03)

- **檔案類型**:validate 後伺服端從權威 parts 清單決定性寫 `<name>.asm.json` manifest
  (partCount≥2 寫、單件刪殘留;`imports` 由產生器原始碼掃描)。三事件
  (`artifact/version/present`)帶 `type/partCount/source`,版本卡/產物卡/Header/
  畫布 model-info 顯示「元件/組合件」badge(type 未知誠實藏)。
- **開檔看圖(免 LLM)**:Header「開啟檔案」→ models/ 檔案瀏覽器(`/api/files`)→
  `/api/open` 回 JSON,前端走 `?glb=` 同款 dispatch。裸 STEP 首次開啟要選
  part/assembly(`scripts/step <f.step> --kind … --force` 產隱藏 GLB;此路徑的
  cadpy `_generate_step_outputs` imported 分支為本 fork 補上,已同步 8 份複本)。
  opened 版本標「檢視」,不出驗證卡,屬性抽屜 provenance 標「未經生成驗證」。
  **重複開同一檔去重**(2026-07-10):openFile 以 `file` 對既有檢視版去重沿用
  id(時間軸不長 o1/o2/o3 分身),序號由現有版本 id 推導(RESTORE 後不撞號);
  `/api/open` 的 glbUrl 帶 `&v=<mtime>` buster——檔案沒變=同 URL 不重載,外部
  重生過=新 URL 真重載。STEP 比隱藏 GLB 新超過 10s 偏斜窗 → 判 stale 重轉
  (只看 GLB 缺席會靜默呈現舊幾何;偏斜窗擋 git/LFS checkout 的毫秒級順序差,
  stale 且無 manifest 時回 `kind_required` 再問一次類型)。配套 reducer 硬規則:
  `SELECT_VERSION`/`PRESENT` 遇**同 glbUrl 保留現有 status**(useCadViewport 只
  依賴 glbUrl,URL 沒變不重跑 effect,無條件設 loading 會讓「載入 3D 模型…」
  永遠卡死);viewport 初始化整段設防(WebGL context 建立失敗 → status=error,
  不卡 loading)。
- **匯入元件(雙軌)**:UI「匯入場景」與 agent 工具 `cad_import(file)` 收斂到
  `importStepIntoSession`——複製進 session `imported/`(撞名附序號、同內容冪等重用),
  回 rel + bbox facts。UI 軌匯入後**預填** composer(不自動送出,使用者決定何時請
  AI 組裝)。組裝寫法(prompt 已教):`asm.add(import_step(str(Path(__file__).parent
  / "imported/x.step")), "x")` 或 envelope instances。
- **開既有專案(rehydrate)**:檔案瀏覽器對含 `gen_step` 產生器的目錄出「開啟專案」→
  `/api/open-project` 複製樹到**新 session** + 同步 runStep/runValidate 重建 →
  回 version/present/params/motion 給前端還原;SDK 對話歷史不還原(.py 是唯一真相,
  prompt 條件段引導 agent 先 Read 再 edits)。重建失敗 session 保留,可用對話修。
  對話中途開專案=**換 session 即清舊工作區**(`CLEAR_WORKSPACE`:版本/運動/參數
  歸零,對話保留)——舊 session 的 v* chip 對新 sessionId 是死引用(精算會標錯版、
  匯出/回退 404、新 v1 與舊 v1 撞號互蓋),不能殘留在時間軸上。
- **開檔智慧路由 + 自動帶入編輯(2026-07-11)**:修「唯讀檢視死路」——唯讀檢視
  (`/api/open`)無 session/無參數滑桿/agent 零語境,使用者容易誤入而看不到攤平、
  或聊天時 AI 說「沒收到圖檔」。兩層修:
  - **開檔 option C(2026-07-11 二版簡化)**:`/api/files` 每個目錄 entry 標 `project`
    旗標(有 gen_step)。FileBrowser 中**可編輯專案目錄整列點擊 = 一鍵開啟可編輯專案**
    (`open-project` → v1 session + 滑桿),不進資料夾、無獨立按鈕(專案目錄是葉節點,
    裡面只有一個 .step,導航無意義);非專案容器(`.cadchat/`)維持導航進去,其裸檔
    才走唯讀「開啟」。`/api/open` 仍回 `projectDir`(下方自動帶入編輯的安全網用)。
  - **自動帶入編輯**:唯讀檢視某可編輯專案(`canvas.source==="opened" &&
    canvas.projectDir`)時聊天,`submitText` 先 `await openProject(projectDir)` 升級成
    session 再 `send`(guard `!sessionId` 不重複升級;`setSessionId` 同步設
    `sessionIdRef` 故無 race;唯讀工作區本來只有那個檢視版,`CLEAR_WORKSPACE` 換上
    同模型可編輯 v1 幾乎無縫)。升級後 agent 靠 `_rehydrateNote`/續接段已知模型。
  - **canvas 語境安全網**:`send` 帶 `canvas`(name/file/source/projectDir),
    `buildUserText` 在 `source==="opened" && !_rehydrateNote` 時注入「使用者正在
    檢視 X」一行——覆蓋 escalation 兜不到的殘餘(裸檔、session-A-檢視-B)。
  驗證:`smoke_open_project.py`(智慧路由→滑桿、唯讀聊天→open-project 先於 chat)、
  `smoke_versions.py` §9(旗標)、`smoke_canvas_context_live.py`(L4:agent 認得畫布
  模型不再回「沒收到」)。`smoke_open_dedupe.py` 的 fixture 都是專案,其唯讀去重測試
  改點「僅檢視」。
- **多選 AI 結合**:雙擊多選 → 帶入對話成多 chips(`pickRefs[]`,伺服端上限 6)→
  `buildUserText` 逐行列 `#o1.2「label」` token(可直接餵工具)。新 read-only 工具
  `cad_measure(from,to,axis?)`(有號距離)與 `cad_align(moving,target,mode,axis?,offset?)`
  (flush/center 平移 delta)包 `scripts/inspect`;prompt 的多件結合流程:先討論
  →align 取 delta 落定位常數(edits)→INTENDED_CONTACT/MOTION 宣告→重建+掃掠驗證。
  無 constraint solver,結合=相對定位+接觸宣告+掃掠驗證。

## 教訓系統(自我遞迴演化,2026-07-07)

驗證出紅色 → 記案例 → 決定性分類 → 達門檻自動蒸餾 → 注入系統提示,讓未來生成避開
同錯。是 `skills/cad/references/lessons.md`(L-1~L-5 人工帳本)的執行時期動態版。

- **記錄**:build 失敗 / validate 非 skip 的 FAIL(收斂單一快路徑後=缺 sidecar fallback
  的紅;**精算/匯出閘跑在 turn 外接不到 recorder,那邊的紅綠不進教訓迴圈**,已知限制)/
  回合錯誤 / 參數重生失敗全記
  (per-turn 記憶體 buffer,turn 尾一次落盤;錄製層 no-throw,絕不擋 turn)。
  同 turn 後續成功會把前面的失敗連結成**失敗→修法配對**(附 `emit_retry` 自診與
  edits 摘要,蒸餾的最高價值原料)。刻意不記:open-project/revert 重建的紅
  (歷史產物非生成教訓)、measure/align 等工具使用錯誤、**使用者中斷/斷線殺掉的
  子程序**(`signal.aborted` 守衛,人為中止不是生成失敗;漏網的 killed 子程序另分型
  `build:killed`)。interrupt 後新舊 turn 交錯時,flush 以 buffer 身份比對,只刷自己的。
- **人工記教訓(是/否卡,2026-07-13)**:上面全靠**紅色**觸發,但有一整類缺陷是
  「驗證全綠、只有看渲染才發現」(如鏡射對稱破壞的肋錯位——`assert_valid_solid` 過、
  所有 validate 檢查 SKIP,agent 一次 `cad_build(edits)` 修好、零失敗案例 → 迴圈對它是
  瞎的)。補法:agent 修正這類「假綠」缺陷後呼叫 `emit_lesson_offer(symptom, rootCause,
  fix, tag)`,對話流出一張「要把這件事加入教訓嗎?」**是/否卡**(2026-07-14 起
  聊天卡為被動紀錄,作答面在視圖 `LessonOfferPanel`,見「視圖作答面」章);按「是」→ 前端
  `POST /api/lessons/record` → `recordManualLesson` **直寫**一筆 `source:"manual"` 的未蒸餾
  pending case(不經 per-turn buffer——提交是按鈕點擊的獨立請求;寫入失敗故意 throw 由
  middleware 回 500,不吞成假✓),按「否」→ 純前端 dismiss。signature=`manual:<slug(tag)>`,
  命中既有教訓即連結+計數。**刻意不自動蒸餾**(定案「留 pending 手動蒸餾」):`maybeDistill`
  非 force 排除 `manual:` 前綴,由使用者在面板按「立即蒸餾」升級。何時該發卡的紀律在
  `agent/prompt.mjs`(只限使用者回饋的視覺/幾何缺陷且通過驗證;RED 自修已自動記錄,不發)。
- **分類(signature)**:`build:<Exc>[:subtype]` / `validate:<checkId>[:subtype]` /
  `turn:*`——例外類+穩定訊息前綴,AssertionError 依 geometry_checks 訊息分
  interference / invalid-solid / motion-clear(不分型會蒸成一鍋糊)。
- **蒸餾**:同 signature 未蒸餾案例 ≥3(`CADCHAT_LESSON_THRESHOLD`)→ turn 結束後
  fire-and-forget 一次 LLM call(`CADCHAT_LESSONS_MODEL` 可指定便宜模型,未設跟
  CADCHAT_MODEL)→ 教訓{標題/根因一句話/預防規則}。single-flight;輸出不合法
  (bad_output)**連敗 2 次即退避**——自動蒸餾放棄該叢集不再重燒,面板標
  「自動已停,可手動」,手動 force 不受限、成功清計數。自動蒸餾**只建新條**且有
  同 signature 去重防線(不只靠 LLM 自覺 duplicateOf);改寫既有條文僅限面板
  「重新蒸餾」(人工)。`duplicateOfStatic` → 建成 disabled;`duplicateOf` →
  併入既有教訓(altSignatures)。
- **注入**:active 教訓 top-10(依 caseCount)組成「# 累積教訓」段(~1000 字上限、
  依 id 排序、**行內不放活計數**——digest 字串只在教訓集合真的變動時才變,系統提示
  前綴 cache 不因命中計數遞增而失效;附「與上方規則衝突以上方為準」從屬聲明),
  每 turn 重算進系統提示。已有教訓的 signature 再犯 → 直接連結+計數(**計數仍漲=
  教訓沒用=停用它**,免費的有效性訊號,面板可見)。
- **儲存**:單一 `models/.cadchat/lessons.json`(gitignored、GC 只刪目錄所以平面檔
  永存、tmp+rename 原子寫、損毀改名 `.corrupt-*` 留證重建、案例 200 筆有界修剪)。
- **UI**:Header「📚 教訓」面板——列教訓(狀態/案例數/修復數/★ 畢業候選)、
  停用/啟用/刪除(**刪除=連結案例一併移除**,要再累積新紅才會重蒸;否則下一 turn
  就從舊案例把同文教訓原樣蒸回來)、單條「重新蒸餾」、「立即蒸餾」(門檻 1,
  結果誠實回報含 skipped)。**待蒸餾案例區**按 signature 分組列出每筆未蒸餾案例
  (id/note/來源),可**逐筆刪除**(二段確認)剔除雜訊/誤記的紅——只刪 pending,
  已連結教訓的案例由「刪除教訓」連帶處理(單刪會讓 caseCount 失真)。★ 畢業候選=
  值得**人工**升級進 lessons.md 或決定性檢查——系統永不自動改 skill 檔。dev 鉤
  `window.__cadLessons`。
- **API**:`GET /api/lessons`(pending 分組帶逐筆 `cases[]`)、`GET /api/lessons/digest`
  (與注入 prompt 完全相同的字串,驗證用)、`POST /api/lessons/{distill,redistill,
  update,delete,delete-case,record}`(`delete-case` 刪單筆未蒸餾案例,壞/已連結 id → 404;
  `record` 人工記教訓,缺內容 → ok:false empty、寫入失敗 → 500)。
- **開關**:`CADCHAT_LESSONS=0` 整個子系統停用(錄製/蒸餾/注入全 no-op)。

## 煙測(Playwright,`tests/smoke/`)

對著**跑中的 dev server** 驗證 UI 互動與免 LLM 的 API 鏈路(90+ 斷言)。前置:
`npm run dev`(8788,`CADCHAT_BASE` 可覆蓋)、fixture 為實體檔
(`git lfs checkout models/motorized_linear_stage models/xyz_pickplace_gantry`)。

```bash
# repo 根執行(Windows 記得 PYTHONUTF8=1,否則 cp950 會炸)
PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/smoke/run_all.py
```

server 不可達預設跳過(exit 0);`CADCHAT_SMOKE=1` 改為視為失敗。
LLM-gated(`CADCHAT_SMOKE_LLM=1` 才跑,消耗訂閱回合):`smoke_queue_live.py`(佇列/併發;
也覆蓋 runner streaming-input + resume 併用)、`smoke_revolute_live.py`(一輪鉸鏈驗 prompt 的
revolute 契約——agent 產出 revolute dof;掃掠由精算端點斷真跑)、`smoke_gear_rackpinion_live.py`(一輪
齒輪齒條迴轉機構驗齒輪原子概念——agent 用 gear family + couple 宣告;精算掃掠 note 標
「耦合群」、全綠到呈現)、`smoke_image_clarify_live.py`(附圖型號表
→ 讀圖 → 多型號 clarify → 跨回合圖面記憶,一條對話兩回合)。
免 LLM 已在 `ORDER`:`smoke_verify_gate.py`(單一快路徑契約 + 匯出閘:自動精算放行/
memo 冪等/打滑 fixture 擋下 + toggle 拆除迴歸 + STEP 鈕依 verified 分流 + flip
revolute 動畫 + steering_box 耦合動畫:斷 couple 從動借主動相位、純滾動 y=-R·θ 不打滑)、
`smoke_clarify_wizard.py`(兩步精靈:步驟閘門/inline 修改/合成回覆——
`/api/chat` 以 page.route stub 截 POST body)、`smoke_spec_panel.py`(視圖「解析規格」
面板:聊天卡靜態化/inline 修改套用「規格修正:」契約/新 spec remount/收合/
clarify 讓位/草模模式共用)、`smoke_upload.py`(上傳端點正負案例 +
磁碟落地 + 附件 UI + 破圖降級)、`smoke_part_visibility.py`(眼睛三態循環 +
ghost×運動示意組成 + 樹選件連動 toggle)、`smoke_open_project.py`(專案目錄
整列一鍵開 → v1 session + 滑桿、換專案清舊工作區、唯讀聊天自動升級先
open-project 再送;`smoke_open_dedupe.py` 已隨開檔 option C 退場,不在 ORDER——
同 glbUrl 保留 status 由 chatStore.test.js 單元測覆蓋)。
截圖與 handoff 檔寫 `tests/smoke/.out/`(gitignored)。單支可獨立跑
(versions 先於 restore)。不接 `scripts/test/test.sh`(CI 面不動)。

給 AI 的完整驗證流程(分層金字塔、新需求擴充決策樹、失敗分流)見
`.claude/skills/cad-chat-verify/SKILL.md`;通用 Playwright 自我驗證機制
(dev 鉤模式、反 flake 規則)見其 `references/playwright-self-verify.md`。

## 面標記顯示控制(2026-07-04)

- **候選不設限 + 預設 6 + 手動面板**:面菱形候選=全部可選面(組合件為被圈選件
  在屬性樹列出的面,12/件),預設仍只顯示 6 顆/件(總 12)——但這 6 顆改用
  **最遠點取樣**挑「空間上散得開」的面:同軸疊在中心的外圓柱/頂底面只入選一兩個,
  名額讓給孔壁等散佈特徵(修掉「法蘭 7 面取前 6,第 4 個孔沒菱形」)。
- **「◇ 面標記 n/N」chip** 開啟面板:預設/全部/隱藏三段快切 + 逐面 checkbox
  (一動即 custom 模式);列 hover = 3D 面填色預覽(認面不用猜),已帶入的面
  標 amber「已帶入」。換模型或改圈選即重置回預設。dev 鉤 `__cadMarkers.state()`。

## 面高亮 / GROUP 預覽 / 下載(2026-07-04)

- **點菱形 → 對應面填色**:面標記 hover 時該面亮 emit 青(預覽)、帶入對話後持續亮
  amber,chips 移除即熄。機制與 cad-viewer 同款(selector bundle 的 faceRuns →
  `mesh.userData.faceIds` → 抽該面三角形建半透明 overlay mesh);舊 GLB 無 faceRuns
  時靜默降級(只亮菱形)。
- **屬性樹 GROUP → 3D 高亮全後代**:點中繼節點(如馬達)3D 同步亮其所有子件——
  occurrenceId 是點分前綴,`applyPartVisualState` 前綴感知,直接餵群組 id;
  預覽不佔 4 件圈選名額。
- **下載**:VERSIONS 時間軸 active 版旁「⤓ STEP / STL / 3MF」。STEP 直接下載
  (`/api/asset?…&download=<檔名>` 加 Content-Disposition);STL/3MF 走
  `POST /api/export {sessionId, ver?, format}`——用**該版快照的 STEP** 直接 mesh
  (免 LLM、不重跑產生器)。轉檔在 `.exports/<ver|current>/` 工作區跑(輸入 STEP
  複製進去、輸出也落在那裡再經 asset 下載):step CLI 的 `--force` 會重生隱藏
  GLB/topology sidecar,直接在 `versions/vK/` 裡跑會改寫凍結快照。
- **拆件匯出(2026-07-04)**:`POST /api/export-parts {sessionId, ver?, occs?,
  format: step|stl}` → `export_parts.py`(cadpy scene API 讀既有 STEP:occurrence
  id 對定位後形狀,GROUP=子樹 Compound、保留世界定位)。1 件=單檔、多件=zip
  (entry 用零件 label,撞名加序號)。兩個入口:①3D 圈選零件 → nameplate
  「⤓ STEP / ⤓ STL」匯出**選中那幾件**(?glb= 預覽無 session 時藏鈕);
  ②VERSIONS 的「⤓ 零件包」= 整機每零件一檔打包 zip(組合件才出現,STEP 格式,
  子組合件如馬達=一個 compound 檔不炸葉)。
- **鈑金展開圖 DXF(2026-07-11)**:`/api/export` 的 `format:"dxf"` 分支——對該版
  快照的**產生器 .py** spawn `skills/dxf` CLI 現跑 `gen_dxf()`(展開從 PARAMS 導出,
  不從 STEP 反推;快照裡的 .py 即該版真相源),輸出落 `.exports/<ver>/` 再經 asset
  下載。「⤓ DXF 展開圖」鈕只在 `version.hasDxf`(server 決定性 regex 掃產生器頂層
  `def gen_dxf`)時出現;fmt-badge 同步亮 DXF。**語意注意**:DXF 是以**當前 cadpy**
  重演該版 .py 的展開,與 STEP 不是同一條幾何路徑——攤平自交等錯圖由
  `cadpy.parts.SheetMetal` 的 builder 內建閘(`_flat_gate`)在生成時擋下。已知限制:
  gen_dxf 若倚賴 session `imported/`,export scratch 內會炸(鈑金 gen_dxf 只讀
  PARAMS,實務不觸發)。agent 側 `cad_export(format:"dxf")` 同閘同語意;
  `save-project` **排除頂層 .dxf**(按需匯出產物不隨滑桿重生更新,帶出去會是過期
  展開圖——要圖用匯出鈕現算)。
- **鈑金摺疊/攤平 3D 即時切換(2026-07-11 二版)**:folded 不再是 PARAMS 滑桿(拉一下
  整支重算)——改成 3D 視圖的「摺疊/攤平」chip,**點一下瞬間換視角、零重算**。機制:
  獨立鈑金件產生器寫三出口(`gen_step` 恆 `folded()`、`gen_flat` 回 `flat()`、`gen_dxf`
  回 `dxf()`);`runStep` build 摺疊 STEP/GLB 時**併行** spawn `flat_glb.py`(cad-chat 端
  小 Python:`build_build123d_step_scene`+`mesh_step_scene`+`export_part_glb_from_scene`,
  從 `gen_flat()` 產 `.<name>.flat.step.glb`,不寫 STEP、零改 cadpy)產攤平預覽 GLB。
  兩個 GLB 都進快照;`emitPresent` 發 `flatGlbUrl`(產生器有 `gen_flat` 且攤平 GLB 落盤
  才給),Canvas3D 據此出切換 chip,切換=換 `canvas.glbUrl`(cadjs `glbCache` 命中、
  零 Python;攤平態藏運動鈕)。偵測用 `generatorHasFlat`(`/^def gen_flat/m`)——精準
  命中獨立鈑金件,**自動排除組合件**(如 sheet_stepper_mount 有 gen_dxf 但無 gen_flat,
  攤平組合件無意義)。改尺寸滑桿才重算(攤平 GLB 隨之重建)。
- **攤平態折彎虛線 overlay(2026-07-11 三版)**:攤平 3D 視圖的板面上疊折彎中心線
  (虛線),**藍=上折 / 紅=下折**(對齊 DXF BEND_UP/BEND_DOWN),看得出往哪折。資料源
  =`SheetMetal.flat_bend_lines()`(公開方法,包 `_flat_geo()` 的 bend_lines);`flat_glb.py`
  併寫 `.<name>.flat.lines.json` sidecar(`{t, lines:[{a,b,up}]}`,2D flat 座標),沿
  `flatGlbUrl` 同路(快照/emitPresent `flatLinesUrl`/version·present/events/store)下到
  Canvas3D;攤平態 fetch 後傳 `bendLines` 給 `useCadViewport`,仿 axes chrome 直接
  `viewport.scene.add` 藍/紅兩組 `LineSegments`(`LineDashedMaterial`+`computeLineDistances`,
  疊頂面 z=t+ε)。座標直接對位(攤平 GLB 無 recenter、Z-up,世界座標==builder flat XY)。
  摺疊/攤平切換是整場景重建 → overlay 天然只在攤平態存在。dev 鉤 `__cadChrome.bendLines()`。

## 跨重整續聊 + 版本快照真回退(2026-07-04)

- **跨重整/重啟續聊**:前端把工作狀態(對話/版本/畫布/參數)throttle 落
  `localStorage["cadchat.session.v1"]`,開機經 `/api/session-info` 驗證後回灌;
  server 端 `session.json`(workdir 內)持久化 `sdkSessionId/version/lastName/imports`,
  同 id 重掛(`getOrCreateSession`)自動 hydrate → SDK `resume` 跨伺服器重啟有效
  (transcript 在 `~/.claude/projects/` 落盤,實測重啟後 AI 記得對話內容)。
  產物被 GC/刪除時誠實降級:hydrate 驗 `<lastName>.py` 存在才還原 sdkSessionId;
  resume 失敗轉 `_rehydrateNote` 接續產物模式(丟對話記憶、保工作成果)。
  「＋ 新對話」清 localStorage 快照。
- **版本快照真回退**:`emitPresent` 每版把產物凍結到 `versions/v{N}/`(py/step/glb/
  asm.json + meta.json),`glbUrl` 指快照 → VERSIONS 切舊版看到**真舊檔**(此前檔名
  覆蓋,切舊版其實看到最新幾何)。切到舊版出現「⟲ 回到 vK 繼續」→
  `/api/revert-version` 把快照複回工作基準、重建驗證、以新版收尾——「看的版」與
  「改的基準」從此一致。`save-project`/`open-project` 複製時排除 `versions/`、
  `.exports/` 與 `session.json`(存的是成品不是歷史;session.json 是 session 私有
  中繼資料,不得進 git 追蹤的 models/<name>/)。每版快照 ~80KB(小件)~2.7MB
  (大組合件);數量上限 `CADCHAT_MAX_SNAPSHOTS`(預設 30,設 0 不設限)超過刪最舊
  ——參數滑桿每次套用都是一版,不設限長 session 會吃到 GB 級;被剪掉的舊版同
  「較舊的 session 產物」:縮圖/下載 404、revert 誠實回「沒有快照可回退」。
  快照建立失敗(磁碟滿等)會 emit error 卡明講「此版無法回退」,不再靜默退回頂層檔。
  其餘隨 session GC 回收。

## 視圖體驗 + 檔案概念(2026-07-04)

- **網格 + 座標系**:3D 視圖預設顯示地板網格(複用 viewer 的 shader grid:有限圓盤、
  貼齊模型中心;格距 patch 成 1/2/5 nice 刻度 ≈ 半徑/6)與世界原點 `AxesHelper`
  (X 紅 / Y 綠 / Z 藍)。畫布工具 chips「⊞ 網格」「⤱ 座標軸」可各自開關。
- **ViewCube + 正視於**:右下放大 ViewCube 把 6 個面、12 條稜、8 個角映成 26 個標準
  相機方向,六面另有 X/-X/Y/-Y/Z/-Z 直達鍵,`ISO` 重新完整取景;可收合成迷你方塊入口
  並以 localStorage 記住狀態,旋轉模型時方塊同步相機姿態與 active 視角。
  STEP topology 的面可直接右鍵(或右鍵面菱形)開 `正視於`:
  僅平面可用,依目前相機所在側選法向正負、投影既有 up 防止翻面,以面 bbox 自動取景,
  全程純前端且不改投影模式。dev 鉤 `window.__cadView`
  (`presetIds/active/camera/focus/home/faceRows/availability/normalToFace`);
  L1 `viewOrientations.test.js` + L3 `smoke_view_orientation.py`。
  **方位數學單一真相源在 `packages/cadjs/src/lib/viewer/`**(`viewOrientations.js`
  preset 工廠/projectedUp 守衛/正視於側向 + `viewCubeMath.js` 立方投影):
  `src/lib/viewOrientations.js` 只是注入繁中命名的薄轉接層(**相對路徑 import**
  ——node --test 不解析 cadjs alias);viewer 端同名檔是英文命名轉接層。改幾何
  規則一律改 cadjs 正本 + 跑 `npm --prefix packages/cadjs test`,並手動同步
  `viewer/packages/cadjs`(vendored 複本;sync-vendored.sh 不管 JS)。
  方位 state 不在 Canvas3D useState——`ViewCubeDock` 經 useSyncExternalStore
  訂閱小 store,orbit 期間只重繪 ViewCube 不 reconcile 整棵樹。
- **進度進視圖**:產圖中空畫布顯示五階段直列 + live 活動文字 + 最近工具卡
  (`.canvas-progress`);已有模型的改版重建顯示頂部細條;GLB 載入中有 loading 提示。
- **選擇題 = 視圖聚光燈焦點模式**(2026-07-10 起聚光燈卡內容為**兩步精靈**,見上方專章):
  `emit_clarify` 除左欄對話卡(`ADD_ITEM`)外同步掛 `state.clarify`(`SET_CLARIFY`)。
  待答時 `state.clarify != null`(唯一真相,只由 `ADD_USER` 清)驅動兩側:①右欄 `.canvas`
  疊區塊級 scrim(`.canvas-clarify-scrim`,z10,`rgba(18,26,44,.42)` 壓暗進度面板/「3D」
  佔位圖/模型)+ 置中聚光燈卡(`.canvas-clarify`,z11,青邊 glow + 一次性入場動畫)
  =**唯一作答面**;②左欄 `.conv-col[data-frozen="true"]` 把 `.conv`/`.composer`
  `opacity:0.5` **反灰凍結**為上下文(不用 `pointer-events:none`,`.conv-scroll` 仍可上捲;
  左欄澄清卡是被動紀錄、選項 `.static` 不可點;`:focus-within` 一點輸入框即恢復全亮——
  輸入框刻意不 disable,composer 打字是精靈的逃生口)。凍結期抑制 `Conversation` 的
  auto-scroll。任何送出(`ADD_USER`)清 clarify → 焦點卡卸載、左欄淡回,平滑退場。
  空畫布也顯示焦點卡(左欄那張已被降級反灰,視圖才是 active 焦點,非重複)。
- **搶答不再報錯(409 修復)**:`useChatStream` 加 in-flight 佇列——回合進行中再
  send(點選項/任何路徑)一律入佇列,回合結束自動依序送出;不會再打出並發
  `/api/chat` 撞 409「session busy」,也不會讓第二個 send 的 END_RUN 收掉第一回合
  還在串流的氣泡。interrupt 會清空佇列。(使用者當時回報為「408」,實為 409。)
- **另存專案 / 新對話**:Header「⤓ 另存專案」(有 session 產物時出現)→
  `/api/save-project` 存成 `models/<name>/`,之後可從「開啟檔案」載回續改;
  「＋ 新對話」一鍵清空對話/畫布/版本並斷開 session(不必重新整理頁面)。
  對話文字紀錄不落盤(跨重整續聊為後續項目)。

## 組合件互動補完(2026-07-04)

- **面標記閘門**:組合件先雙擊圈選零件,才顯示**該零件**的面菱形(預設每件 6、
  總 12;可由「◇ 面標記」面板改,見上節);單件模型維持直接顯示。點菱形帶入對話。
- **已帶入高亮**:composer 的 chips(`pickRefs`)= 單一真相——token 還掛著就高亮
  (菱形 amber 脈衝、樹節點 ⊹、名牌/抽屜按鈕轉「✓ 已帶入」),移除 chip 或送出即熄。
- **occurrence 巢狀樹**:屬性抽屜由 `runtime.occurrences`(parentId)建樹,複合件
  (馬達=body+shaft)以 **GROUP** 中繼母節點呈現、可折疊;root occurrence 名字併入
  根節點;雙擊圈選自動展開祖先鏈;GROUP 的「帶入對話」用母 token(`#o1.9`,可直接
  餵 measure/align)。舊 bundle 無 occurrences 自動降級為扁平樹。
- **旋轉對齊**:`cad_align(mode="axis")` 回 axis-angle+pivot+`eulerXYZDeg`
  (euler 慣例與 build123d `Rotation(rx,ry,rz)` 一致,測試鎖定)+徑向對心平移;
  沿軸位置用既有 flush 補。退化案確定性:平行=identity、反平行=180°+確定軸、
  bbox-only selector=明確錯誤。CLI 為 `scripts/inspect align --mode axis`,詳見
  `skills/cad/references/positioning.md`。

## 大型組合件流程優化(2026-07-02)

- **干涉 AABB broad-phase**(cadpy `enumerate_interferences`):box 分離對直接判
  clear 不進 kernel(仍列入 pairs 完整回報)。gantry 61 件實測 153.8s → **1.75s**;
  build gate 的 `check_geometry` 與 validate 同函式,兩處一起受益。
- **`cad_build(edits=[{find,replace}])` 最小段精修**:retry 修復不再重送整份原始碼
  (逐字唯一比對;找不到/不唯一回明確錯誤)。prompt 已把自修迴圈導向 edits 模式。
- **規模分級**:agent 在規劃階段宣告(小 ≤3 / 中 4–7 / 大型 ≥8 件),validate 回報
  `partCount`,`session.lastPartCount` 決定性記錄;大型組合件有產生器結構鐵則
  (per-axis builder、定位常數集中、INTENDED_CONTACT 分組)。
- **耗時遙測**:工具卡與驗證卡顯示耗時(runStep/runValidate wall-clock),驗證卡
  另顯示件數。

## 授權

本 app 隨 text-to-cad 儲存庫以 **MIT** 授權(根目錄 `LICENSE`)。散布/產品化時
的第三方元件授權彙整見 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md);
認證模式的條款界線(訂閱=本人自用、產品=API key)見上方「一次性設定」。
