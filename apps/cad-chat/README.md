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

## 組合件互動補完(2026-07-04)

- **面標記閘門**:組合件先雙擊圈選零件,才顯示**該零件**的面菱形(每件 6、總 12);
  單件模型維持直接顯示。點菱形帶入對話。
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
