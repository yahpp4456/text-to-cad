# cad-chat 商業化計劃書(同事版 → 付費封測 → credit 制服務)

> 撰於 2026-07-17。前置:`DEPLOY.md`(GCP VM 內部同事版,已含 per-user 資料隔離,
> commit `148446f2`)。本文件是**計畫**,尚未實作;工作照 fork 慣例留在 working
> tree,由 Sam 決定何時 commit。標 👤 = 只有 Sam 能決策/執行的事項。

## 0. 商業模式決策摘要(2026-07-17 對話結論)

**走「自營 VM + 自己的 API key + credit 計量制」**,理由:

1. **條款上這是唯一低門檻的路**(已查證 code.claude.com legal-and-compliance 與
   Agent SDK overview,2026 年中現行版):
   - 用開發者的**訂閱 OAuth** 服務他人:明確禁止,且 2026 初起有 server-side
     封鎖(第三方產品發出的訂閱 token 請求直接被拒)。
   - 讓使用者**自帶 Claude 訂閱**登入第三方 app:同樣不允許(例外需洽 sales)。
   - 商用正路 = **API key + Commercial Terms**。BYO 模式只能要求客戶自己去
     Console 申請 API key 綁卡——對非工程師客群門檻過高,故不採。
2. **授權無障礙**:upstream(earthtojake)是 MIT(LICENSE 在 `main`/`開發` 都在),
   閉源販售合法,唯一義務是產品內保留該版權聲明。`apps/` 為 fork 原創(upstream
   無此目錄),版權 100% 在 Sam,不受 MIT 拘束、可任意授權。
   - MIT 的反面:競爭者也能免費取用 upstream 管線 → 護城河 = 閉源的 cad-chat
     本體 + parts 選型庫 + **教訓庫(lessons.json,已在 DATA_ROOT、repo 外,
     天然私有)**。
3. **吃到飽訂閱不做**:CAD agent 回合 token 極重(掃掠驗證/失敗重試/L4),
   吃到飽 + agent 產品幾乎必虧(Cursor/Devin 前例);一律 credit 計量。
4. 並行的第二收入線(不在本文件範圍):family/教訓庫**訂閱制持續更新**(對抗
   資料外流:外流的只是舊快照)、B2B 導入服務(幫設備商建自家 family/蒸餾規範)。
5. **進場順序走「無認證試用漏斗」**(2026-07-17 追加,詳見 Phase T):
   零成本展示區 → 草模模式匿名試用(零 Python spawn,不必等沙箱)→ 設計模式
   匿名試用(Phase 1 後)→ 試用漏斗收的 email = 首批付費邀請名單。

## 1. 現況盤點(已有的資產)

| 面向 | 現況 | 錨點 |
|---|---|---|
| 部署 runbook | GCP VM 全套(systemd + 反代 + TLS + BasicAuth + 備份 + 更新流) | `DEPLOY.md` |
| RCE 圍堵 | 低權無 shell 使用者、systemd hardening(repo 唯讀/僅 data 可寫)、Python 子程序 env 剝除憑證、agent 工具白名單 | `DEPLOY.md` §3/§6;`config.mjs` `sandboxEnv`;README 白名單章節 |
| 多租戶資料 | per-user 資料根(X-Remote-User)、session registry 含 user 反劫持、`/api/asset` 跨租戶 403 | `users.mjs`、`middleware/userContext.mjs`、commit `148446f2` |
| 帳號 | BasicAuth 一人一組、可個別停用(溯源+精準撤銷) | `DEPLOY.md` §7 |
| 成本總閘 | 專屬 key(非主 key)+ Console 花費上限 | `DEPLOY.md` §5 |
| 併發 | per-session busy 鎖(同 session 不並發 turn) | `sessions.mjs` `acquireBusy` |

**誠實殘餘(`DEPLOY.md` §11,對同事可接受、對付費陌生人不可)**:
- §11-1 **同 uid**:LLM 生成的 Python 與 server 同 uid → 可讀
  `/proc/<server-pid>/environ` 偷 API key、可讀整個 DATA_ROOT(所有用戶資料
  + 教訓庫);且 Python 子程序**網路無限制**,偷到的東西送得出去。
- 無 per-user 用量計量/額度:一個用戶可燒光整月預算,只能事後對 log。
- 無自助註冊/金流(封測期可手動頂)。

## 2. 差距總表(同事版 → 收費版)

| # | 差距 | 嚴重度 | 對應 Phase |
|---|---|---|---|
| 1 | Python 沙箱(第二 uid/容器 + 斷網) | 必修——key 竊取 + 跨租戶讀取都在這;**匿名開放設計模式的絕對前置** | Phase 1 |
| 2 | 全域每日保險絲 + per-visitor 上限 + 機器人擋板 | 必修——匿名試用的命根子(比 per-user 計量更優先) | Phase 2A |
| 3 | per-user credit 計量 + 額度硬閘 | 必修——「敢收錢」的最低門檻 | Phase 2B |
| 4 | 試用漏斗(展示區/草模試用/匿名身分) | 獲客入口;草模層不依賴沙箱 | Phase T |
| 5 | 收款 + 帳號發放流程 | 手動可頂 | Phase 3 |
| 6 | 服務條款(教訓蒸餾揭露等) | 一頁文件 | Phase 3 |
| 7 | 自助儲值/金流整合、no-distill 選項、水平擴展 | 有付費用戶再說 | Phase 4 |

---

## Phase 1 — Python 沙箱化(工程量最大的一項)

### 1.0 前提認知

- **咽喉點唯一**:所有 Python 執行都走 `src/server/cad/python.mjs:100`
  `spawnPython()`(呼叫者:`agent/tools.mjs`、`cad/pipeline.mjs`、
  `cad/stepPreview.mjs`、`middleware/project.mjs`)。改一處,全鏈生效。
- **claude CLI(Agent SDK)不進沙箱**:它需要網路與 key,留在 server unit 內
  (它不執行使用者可控的程式碼;LLM 生成碼只經 spawnPython 跑)。
- 沙箱是 **VM-only 行為**:Windows dev 機照舊直 spawn。以 env 開關切換,
  dev 恆等式不變(同 `CADCHAT_RUNTIME_ROOT` 五根 env 的既有模式)。

### 1.1 步驟一:盤點 Python 的真實 I/O 面(🤖 實作前先做)

逐 spawn 呼叫點列出實際讀/寫路徑集合,預期結論(實作時驗證):
- 讀:`/opt/cadchat/repo`(skills 腳本、`packages/cadpy`、few-shot fixtures
  `models/**`、parts-library)、`/opt/cadchat/pyenv`。
- 寫:**僅該 session 的 workdir**(`users/<u>/models/.cadchat/<session>/`)
  + 專案目錄操作(`middleware/project.mjs` 對 `users/<u>/models/<proj>/`)。
- cwd 基準:`spawnPython` cwd=DATA_ROOT,args 是 DATA_ROOT 相對正斜線路徑
  (`sessions.mjs` workdirRel 不變量)→ 沙箱內必須讓**同一絕對路徑**存在。

### 1.2 沙箱技術選型(建議順序)

| 選項 | 機制 | 優點 | 風險/成本 |
|---|---|---|---|
| **A. bubblewrap(bwrap)— 首選** | unprivileged user namespace,per-spawn 包一層 | 啟動 ~10ms(spawn 頻繁也無感);`--unshare-net` 斷網;`--tmpfs` 蓋 DATA_ROOT 再只 bind 該 session 目錄 → **順帶解掉跨租戶讀取**;無 daemon | Ubuntu 24.04 預設 AppArmor 限制 unprivileged userns(22.04 無此問題);VM 上先驗 `bwrap --unshare-net true` |
| B. 第二 uid + nftables | `setpriv` 降到 `cadchat-py` uid;nftables `skuid` 規則丟棄該 uid egress | 零新依賴、機制樸素可審計 | 檔案層隔離要靠 mode/group 細調,跨租戶讀取要另外圍;sudoers 面要開一條 |
| C. podman rootless | 真容器 | 隔離最完整 | 每 spawn 300–800ms、映像維運、OCP 映像肥;殺雞用牛刀 |

決策:**A 為主**,VM 驗不過(userns 被禁)退 B。C 留給未來多 VM/多租戶規模。

### 1.3 實作(`python.mjs` 單點改)

```
CADCHAT_PY_SANDBOX=bwrap|none   # 預設 none(dev 恆等式);VM env 設 bwrap
```

`spawnPython()` 組指令時若 sandbox=bwrap,把 `[PYTHON_EXE, scriptAbs, ...args]`
包成(示意,實作時以 I/O 盤點結果為準):

```
bwrap --die-with-parent --unshare-all \
  --ro-bind /opt/cadchat/repo /opt/cadchat/repo \
  --ro-bind /opt/cadchat/pyenv /opt/cadchat/pyenv \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --tmpfs /srv/cadchat/data \
  --bind <該次呼叫的可寫目錄> <同路徑> \
  --chdir /srv/cadchat/data \
  --setenv … (沿用現有 sandboxEnv+PYTHONUTF8 組) \
  <PYTHON_EXE> <scriptAbs> …args
```

介面配套:
- `spawnPython` 的 opts 加 `writePaths`(呼叫點宣告本次可寫目錄;預設 =
  session workdir)。`project.mjs` 的專案目錄操作點自行帶入。
- `killTree`:bwrap `--die-with-parent` + 現有 SIGKILL 已足(Windows taskkill
  分支不受影響)。
- `scrubPaths` 不變(路徑照舊)。

### 1.4 驗證(對應 cad-chat-verify)

- **L1 單測(Windows 可跑)**:sandbox 指令組裝純函數化(輸入 opts → argv 陣列),
  測 bind 集合/寫目錄宣告/none 模式恆等(argv 與現況逐位相同)。
- **VM 端 E2E(照 `DEPLOY.md` §8 階梯)**:
  1. `PY-OK` 煙測改經沙箱跑;
  2. 負案例:沙箱內 Python 讀 `/proc/1/environ`、讀他人 `users/<other>/`、
     `urllib.request.urlopen` → 三者必須失敗;
  3. 免 LLM 全 pipeline(FileBrowser 開 flange)→ L4 真回合一輪;
  4. 併發抽查兩 session。
- 效能:記錄沙箱前後 build/validate 耗時差(預期 <5%)。

---

## Phase 2 — 計量與額度(2A 全域保險絲 → 2B per-user credit)

拆兩半,順序有意義:**2A 是匿名試用(Phase T)的前置**,先做;2B 是收費
(Phase 3)的前置,可後做。兩者共用同一個 `usage.mjs` 模組與 ledger 格式。

### 2.1 資料來源(掛鉤點已存在,2A/2B 共用)

- **回合用量**:`agent/runner.mjs:195` 的 `msg.type === "result"` 分支——SDK
  result 訊息帶 `usage`(input/output/cache tokens)與 `total_cost_usd`
  (實作時以當版 SDK 實際欄位為準;兩者都存,原始資料落盤)。
- **身分**:`req.cadchat.user`(`userContext.mjs`)已進 chat middleware →
  runner 需把 user 傳進去(或由 chat.mjs 在回合結束 callback 記帳)。

### 2.2 Phase 2A:全域每日保險絲 + per-visitor 上限

- **全域帳**:`DATA_ROOT/usage/_global.jsonl` 逐回合 append(與 per-user
  ledger 同格式、同一次寫入動作);記憶體維護「今日累計 USD」。
- **保險絲**:今日累計 ≥ `CADCHAT_DAILY_BUDGET_USD`(👤 金額待定,建議先
  US$10–20)→ `/api/chat` 一律拒收,SSE 回「今日試用額度已滿,明天再來」。
  這是 Console 花費上限之前的第一道熔斷——Console 上限是月粒度、觸發即全站
  死透,保險絲是日粒度、隔天自動復活。
- **per-visitor 回合數**:anon 身分(見 Phase T)每 id 固定回合數(建議 3–5),
  用完顯示「試用結束,留 email 換正式試用碼」;同 IP 每日可新發身分數上限
  (cookie 可清,IP 是第二道;NAT 誤傷屬可接受的試用期取捨)。
- 正式(非 anon)使用者不受 per-visitor 限制,只受 2B credit 與全域保險絲管。

### 2.3 Phase 2B:per-user credit 記帳與額度模組(新檔 `src/server/usage.mjs`)

- Ledger:`DATA_ROOT/usage/<user>.jsonl` 逐回合 append
  `{ts, session, model, usage, costUsd}`(append-only,壞損容忍:壞行跳過)。
- 額度:`DATA_ROOT/usage/<user>.quota.json` `{creditUsd, updatedAt}`;
  餘額 = creditUsd − Σledger costUsd(啟動時掃一次進記憶體,回合後增量更新;
  單機單程序,不需要 DB)。
- **硬閘**:chat.mjs 回合**開始前**查餘額 ≤0 → 拒收(SSE 回 `error` 事件
  + HTTP 402 語意),UI 顯示「額度已用完,聯絡 Sam 儲值」。回合中途超額
  不砍(粒度=一回合,可接受;Console 總上限仍是最終後盾)。
- **per-user 併發閘**:busy 鎖是 per-session 的,一個用戶開 N 個 session 可以
  N 路並發燒錢+搶 CPU → 加 per-user in-flight turn 上限(建議 1,超過回
  「請等待目前回合完成」)。
- 查詢:`GET /api/usage` 回本人餘額/近期用量;前端 Header 顯示餘額 chip。
- 管理:VM 上 CLI 小腳本(`node scripts/usage-admin.mjs <user> +10`)加額,
  封測期不做 admin UI。

### 2.4 驗證

- L1:usage.mjs 純函數(累計/餘額/保險絲/壞行容忍)單測;chat 閘門單測
  (mock 餘額;anon 回合數歸零、全域保險絲觸發兩條負案例)。
- L2:smoke 加 `smoke_usage.py`(無 header=legacy 不記帳零回歸;帶 user header
  記帳/402 路徑;帶 anon header 回合數遞減)。
- L4(VM):真回合一輪 → ledger 有一行、餘額扣減、Console 用量對得上數量級。

---

## Phase T — 無認證試用漏斗(與收費線並行;草模層不等沙箱)

### T.0 原則

「無認證」拆成三層,由零風險往上開;**每一層真 LLM 回合都必須先有 2A
(保險絲 + per-visitor 上限 + 機器人擋板)**,匿名代表事後連封鎖對象都沒有,
防護只能在事前。

### T.1 第 0 層:零成本展示區(無任何前置,可先上)

- 免登入展示頁:精選成品(齒輪齒條/無塵護套/鈑金)的預算 GLB + 3D viewer、
  參數變體預先算好幾組切換、真實對話過程回放或錄影。
- 零 API 成本、零 RCE 面;轉化目標 = 讓人想要往下一層走。
- 形式二選一(👤):獨立靜態頁掛公司網站(適合 Codex 產)、或 cad-chat 前端
  加免認證展示路由(重用 viewer,Claude 做)。

### T.2 第 1 層:草模模式匿名試用(沙箱完成前的甜蜜點)

- 草模鏈是宣告式場景 JSON → 前端播放,**零 Python spawn = RCE 面不存在**,
  token 也比設計模式輕;「對話 → 機構動起來」已足夠展示魔法。
- 試用時設計模式入口鎖住,顯示「完整設計功能需試用碼/儲值」。
- 前置:2A + T.4 匿名身分。**不依賴 Phase 1**——這是它存在的意義。

### T.3 第 2 層:設計模式匿名試用

- **絕對前置:Phase 1 沙箱**。匿名 + 執行 LLM 生成的 Python 是整個威脅模型
  最危險的組合,無例外。
- 開放後沿用同一套 2A 防護;上傳 STEP 對 anon 維持關閉(見 T.5)。

### T.4 匿名身分:借用既有 per-user 隔離(零後端改動起步)

- 反代(my-rest-api)首訪發簽名 cookie,注入 `X-Remote-User: anon-<隨機8碼>`
  ——格式過 `users.mjs` `USER_RE` 白名單,**資料隔離、session registry 反劫持、
  asset 租戶邊界全部直接生效**,後端起步零改動。
- 後端需要的增量只有:識別 `anon-` 前綴 → 套 per-visitor 回合數(2A)、
  套 T.5 的 anon 特例。
- **機器人擋板**:建第一個 session 前過 Cloudflare Turnstile(免費、免登入、
  真人近無感)。沒有這道,2A 的上限防不了腳本農場。👤 需 Cloudflare 帳號。

### T.5 anon 特例(便宜的削減,一起做)

- `CADCHAT_EFFORT` 對 anon 降到 medium(env/請求層擇一實作)。
- 上傳(STEP/圖面)對 anon 關閉——少一個攻擊面 + 存儲面。
- anon 資料 GC 降到 1–2 天(正式用戶維持 `CADCHAT_GC_DAYS=30`)。
- **教訓蒸餾對 anon session 關閉**:匿名輸入雜訊會污染教訓庫,且連條款
  揭露對象都沒有。
- 全域並發回合上限(超出顯示排隊訊息)保護 CPU——這條對正式用戶也適用。

### T.6 匿名匯出格式閘:只放網格,鎖製造級檔案(轉化閘,非防護閘)

定位:不取代 2A/沙箱,解的是「匿名者刷試用能撈走多少商業價值」。

- **STL 放行幾乎零成本**:檢視器本來就把 GLB(網格)送進瀏覽器,會轉檔的人
  已拿得到網格——開放 STL 只是把既成事實做成好體驗(印原型件 = 最打動人的
  試用出口),沒有多送任何東西。
- **商業價值在 STEP(B-rep 可編修)與 DXF(鈑金製造圖),鎖這兩個**。價值
  階梯:試用證明能力(看得到、印得出)→ 付費拿製造級檔案。
- 展示面誠實以保住說服力:UI 顯示「STEP 已生成 ✓(付費解鎖下載)」,檢視器
  的 B-rep 面選取照常——能力已證明,只是檔案帶不走;鎖住的按鈕即升級廣告位。
- 順帶削弱腳本農場批量收割 CAD 檔的動機(產出剩有損網格)。

**執行點(四個出口全在伺服器端擋,UI 藏按鈕不算數):**

| 出口 | 現況 | anon 規則 |
|---|---|---|
| `POST /api/export`(`project.mjs:341`) | stl / 3mf / dxf | 只准 stl、3mf(同為網格);dxf 拒 |
| 拆件匯出(`project.mjs:608`) | step / stl | 只准 stl |
| agent 工具 `cad_export`(`tools.mjs:380`) | stl / 3mf / glb / dxf | anon session 拒 dxf,agent 回覆升級提示 |
| `GET /api/asset` 原始檔 | session 目錄 `.step` 可直接抓 | anon 擋 `.step`/`.stp`/`.dxf` 副檔名 |

⚠ 第四條的額外紅利:anon 全面擋 `.step` 順帶蓋住 few-shot fixtures 與
**parts-library 的 STP(零件庫商品)**——否則匿名者不用對話、直接掃 asset
端點就能搬走庫件原檔。這個洞與試用無關,本來就該補;正式用戶可否下載庫件
原檔另議(庫件 STP 是 family 商品的一部分,見 §0-4 第二收入線)。

### T.7 漏斗出口

試用回合用完 / 保險絲觸發時的畫面就是轉化點:留 email 換正式試用碼 →
名單即 Phase 3 首批付費邀請對象。

---

## Phase 3 — 付費封測營運(以工代購,不寫金流程式)

1. **定價前先量成本**(依賴 Phase 2 落地):拿 Sam 自己 + 首批免費試用者的
   ledger,算「一個典型設計 session 的 USD 成本」分布(P50/P90),credit 定價
   = 成本 × 3–5 倍毛利,再折算台幣包裝(如「NT$X = Y credit ≈ Z 個零件設計」)。
   👤 定價由 Sam 拍板。
2. **收款**:👤 銀行轉帳/台灣金流(綠界/藍新)擇一,手動對帳 → 手動加額
   (`usage-admin.mjs`)→ 手動發 BasicAuth 帳密(`DEPLOY.md` §7 既有流程,
   帳號格式受 `users.mjs` `USER_RE` 白名單約束)。
3. **服務條款一頁**(👤 定稿,🤖 起草),必含:
   - **使用資料改進服務**:設計對話會蒸餾進教訓庫(= lessons 飛輪的法務面);
     對機構客戶敏感 → Phase 4 提供 no-distill 選項前,先靠條款揭露。
   - 資料保存與 GC(`CADCHAT_GC_DAYS`)、備份範圍、無 SLA/盡力而為、
     產出幾何自行驗證後才可用於製造(免責)、額度不退換的邊界。
4. **營運 runbook**(附在 DEPLOY.md 或本檔補章):發帳號、加額、停用、
   月度對帳(Console 帳單 vs Σledger)、磁碟水位。

## Phase 4 — 之後(有付費用戶再做,只列不展開)

自助儲值(金流 webhook → 自動加額)、no-distill 旗標(B2B)、家族/教訓庫
訂閱線、監控告警(`/api/health` 探測 + 磁碟水位)、多 VM/job queue、
真容器化(選項 C)。

---

## Codex 委派分工(逐項評估)

| 工作項 | 誰做 | 理由 |
|---|---|---|
| P1 I/O 面盤點 | Claude(或 Codex `-s read-only` 跑腿列清單,Claude 判讀) | 判斷在 Claude;量不大,傾向自做 |
| P1 `python.mjs` sandbox 改造 | **Claude** | 咽喉點 + 雙環境恆等式 + killTree/scrub 交互,典型 gotcha 區 |
| P1 argv 組裝純函數的單測骨架 | **Codex** | 自足 spec 可寫死(輸入輸出表);注意 Codex 沙箱跑不了 `node --test`,驗證由 Claude 自跑 |
| P1 VM 端執行 | 👤+🤖 VM 上的 Claude Code(照 DEPLOY.md 慣例) | 需 sudo 與環境判讀 |
| P2 `usage.mjs` 純函數模組 + 單測(含 2A 保險絲/回合數邏輯) | **Codex** | 新獨立模組、零 repo 隱性耦合,最典型的委派標的 |
| P2 chat/runner 接線 + SSE 402/熔斷路徑 | **Claude** | busy 鎖/interrupt/SSE 事件流是既有教訓密集區 |
| P2 `smoke_usage.py` | **Codex**(照 `smoke_users.py` pattern 複製) | 樣板複製;跑腿驗證也可委派(純本地 python) |
| PT 展示區(獨立靜態頁形式) | **Codex** | 自足 spec、無 repo 耦合;若選 cad-chat 路由形式則 Claude(viewer 重用) |
| PT 反代 anon cookie + Turnstile(my-rest-api 側) | **Claude**(VM 上) | repo 外的既有反代程式,需現場判讀 |
| PT anon 特例接線(effort 降級/上傳關閉/GC/蒸餾關閉) | **Claude** | 散在 chat/upload/GC/lessons 四處的既有 gotcha 區 |
| PT 匯出格式閘(T.6 四出口) | **Claude** | project/tools/asset 三檔的既有端點行為,含租戶邊界交互 |
| P3 條款草稿、營運 runbook | **Claude** 起草 → 👤 定稿 | 判斷性文字 |

## 開放決策(👤 Sam,不擋 Phase 1/2 開工)

1. 首批對象:先免費邀幾人蒐集成本數據?(建議 3–5 人、每人小額 credit)
2. 金流管道:轉帳 / 綠界 / 藍新?
3. 定價倍率與台幣包裝(等 Phase 2 數據)。
4. 教訓蒸餾揭露的文案口吻(直白 vs 低調)。
5. VM 發行版確認(22.04 或 24.04?決定 bwrap 是否要處理 AppArmor userns 限制)。
6. 試用漏斗(Phase T):每日保險絲金額(建議 US$10–20)、每訪客回合數
   (建議 3–5)、展示區形式(靜態頁 vs cad-chat 路由)與素材挑選、
   Cloudflare 帳號(Turnstile 用)。
7. 試用開放範圍:先只開草模層(T.2,不等沙箱)?或等 Phase 1 完成一次開到
   設計模式(T.3)?

## 風險與未解

- **沙箱不是零信任**:bwrap 擋住 key 竊取/跨租戶/外連三大路,但 kernel 級
  逃逸不在威脅模型內(接受;Console 花費上限 + 專屬 key 可撤銷仍是後盾)。
- **CPU 容量**:OCP 幾何 + claude 併發互搶,付費用戶變多先升機型再談 queue
  (`DEPLOY.md` §11-4 立場不變)。
- **API 價格變動**:credit 以 USD 成本記帳,售價與成本脫鉤時 margin 自動吸收,
  價格大變時調售價即可(ledger 有原始 token 數,可回溯重算)。
- **SDK usage 欄位版本漂移**:result 訊息欄位以實作當下 SDK 版本實測為準,
  ledger 存原始物件,計價邏輯獨立可重算。
