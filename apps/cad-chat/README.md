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

## 架構

- **單一埠 `node:http` 伺服器**(`src/server/`):dev 委派 Vite middlewareMode,prod serve `dist/`。
  - `POST /api/chat`(SSE):起/續一個 agent turn,串流 `stage/ai/spec/plan/tool/validate/retry/artifact/present/version/params` 事件。
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
- 驗證只報「真的有跑」的檢查(有效實體 BRepCheck / 干涉 / 拓撲);pipeline 沒有的
  自交、壁厚會標 SKIP,不假裝通過。運動掃掠在產生器宣告 `MOTION` 時**真跑**
  (`cadpy.geometry_checks.sweep_interference`),未宣告誠實標 SKIP。
- 開發預覽:`?glb=/api/asset?file=<models 內的 .glb 相對路徑>&name=<n>[&motion=<json>]`
  可不經對話直接把既有 GLB 載入畫布(驗 3D / 運動播放用)。
- 對話 scratch(`models/.cadchat/`)已被 `.gitignore` 忽略。**啟動時 GC** 會刪掉
  超過 `CADCHAT_GC_DAYS`(預設 7)天沒動過的 session 目錄;設 0 停用。中斷留下的
  半成品在期限內保留 —— rehydrate 與 edits 修復靠它們。

## MOTION 運動宣告(v1,linear)

產生器模組層宣告(與 `INTENDED_CONTACT` 同慣例),**一份真相三個消費者**:
(a) validate.py 據此建 poses 跑真運動掃掠(per-DOF 獨立掃、baseline=seated、
預算 600 pair-frames / 每 DOF 12 對 / 75s 深水閘,降級誠實寫進 note);
(b) `cad_validate` / 滑桿重生後一律 `emit("motion")`,前端畫布出現「▶ 運動示意」
(三角波往復、多 DOF 疊加=ride-along 平移相加、非物理模擬);
(c) travel 引用 `PARAMS` → 滑桿重生後 import 重解析,播放與掃掠自動跟新值。

```python
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "x", "label": "X 行程", "type": "linear", "axis": [1, 0, 0],
         "travel": PARAMS["x_stroke"],        # 必引用 PARAMS
         "moving": ["x_carriage", "bridge"],  # AssemblyHelper label(在組合件內必須唯一)
         "pairs": [["x_carriage", "x_rail"]], # 省略 → 掃掠 AABB 預過濾自動配對
         "samples": 8},
    ],
}
```

畫布互動:拖曳旋轉、`⟳ 環繞`(turntable)、**單擊圈選零件(多選 toggle,上限 4)**
(選中高亮+其餘 ghost+屬性抽屜連動最後選件+「帶入對話 (N)」;再擊同件移除、
擊空白清空;位移 >5px 視為旋轉不觸發)、**雙擊=確保選中+鏡頭推近**、
點菱形標記帶入幾何參考。

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
- **匯入元件(雙軌)**:UI「匯入場景」與 agent 工具 `cad_import(file)` 收斂到
  `importStepIntoSession`——複製進 session `imported/`(撞名附序號、同內容冪等重用),
  回 rel + bbox facts。UI 軌匯入後**預填** composer(不自動送出,使用者決定何時請
  AI 組裝)。組裝寫法(prompt 已教):`asm.add(import_step(str(Path(__file__).parent
  / "imported/x.step")), "x")` 或 envelope instances。
- **開既有專案(rehydrate)**:檔案瀏覽器對含 `gen_step` 產生器的目錄出「開啟專案」→
  `/api/open-project` 複製樹到**新 session** + 同步 runStep/runValidate 重建 →
  回 version/present/params/motion 給前端還原;SDK 對話歷史不還原(.py 是唯一真相,
  prompt 條件段引導 agent 先 Read 再 edits)。重建失敗 session 保留,可用對話修。
- **多選 AI 結合**:雙擊多選 → 帶入對話成多 chips(`pickRefs[]`,伺服端上限 6)→
  `buildUserText` 逐行列 `#o1.2「label」` token(可直接餵工具)。新 read-only 工具
  `cad_measure(from,to,axis?)`(有號距離)與 `cad_align(moving,target,mode,axis?,offset?)`
  (flush/center 平移 delta)包 `scripts/inspect`;prompt 的多件結合流程:先討論
  →align 取 delta 落定位常數(edits)→INTENDED_CONTACT/MOTION 宣告→重建+掃掠驗證。
  無 constraint solver,結合=相對定位+接觸宣告+掃掠驗證。

## 教訓系統(自我遞迴演化,2026-07-07)

驗證出紅色 → 記案例 → 決定性分類 → 達門檻自動蒸餾 → 注入系統提示,讓未來生成避開
同錯。是 `skills/cad/references/lessons.md`(L-1~L-5 人工帳本)的執行時期動態版。

- **記錄**:build 失敗 / validate 非 skip 的 FAIL / 回合錯誤 / 參數重生失敗全記
  (per-turn 記憶體 buffer,turn 尾一次落盤;錄製層 no-throw,絕不擋 turn)。
  同 turn 後續成功會把前面的失敗連結成**失敗→修法配對**(附 `emit_retry` 自診與
  edits 摘要,蒸餾的最高價值原料)。刻意不記:open-project/revert 重建的紅
  (歷史產物非生成教訓)、measure/align 等工具使用錯誤、**使用者中斷/斷線殺掉的
  子程序**(`signal.aborted` 守衛,人為中止不是生成失敗;漏網的 killed 子程序另分型
  `build:killed`)。interrupt 後新舊 turn 交錯時,flush 以 buffer 身份比對,只刷自己的。
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
  update,delete,delete-case}`(`delete-case` 刪單筆未蒸餾案例,壞/已連結 id → 404)。
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
`smoke_queue_live.py` 消耗兩個真 LLM 回合,`CADCHAT_SMOKE_LLM=1` 才跑。
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
- **進度進視圖**:產圖中空畫布顯示五階段直列 + live 活動文字 + 最近工具卡
  (`.canvas-progress`);已有模型的改版重建顯示頂部細條;GLB 載入中有 loading 提示。
- **選擇題 = 視圖聚光燈焦點模式**:`emit_clarify` 除左欄對話卡(`ADD_ITEM`)外同步掛
  `state.clarify`(`SET_CLARIFY`)。待答時 `state.clarify != null`(唯一真相,只由 `ADD_USER`
  清)驅動兩側:①右欄 `.canvas` 疊區塊級 scrim(`.canvas-clarify-scrim`,z10,`rgba(18,26,44,.42)`
  壓暗進度面板/「3D」佔位圖/模型)+ 置中聚光燈卡(`.canvas-clarify`,z11,青邊 glow + 一次性
  入場動畫)=**作答焦點**;②左欄 `.conv-col[data-frozen="true"]` 把 `.conv`/`.composer`
  `opacity:0.5` **反灰凍結**為上下文(不用 `pointer-events:none`,`.conv-scroll` 仍可上捲、左欄
  inline 選項仍是備援作答;`:focus-within` 一點輸入框即恢復全亮——輸入框刻意不 disable,仍可
  自由打自訂答案)。凍結期抑制 `Conversation` 的 auto-scroll。任何送出(`ADD_USER`)清 clarify →
  焦點卡卸載、左欄淡回,平滑退場。空畫布也顯示焦點卡(左欄那張已被降級反灰,視圖才是 active
  焦點,非重複)。
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
