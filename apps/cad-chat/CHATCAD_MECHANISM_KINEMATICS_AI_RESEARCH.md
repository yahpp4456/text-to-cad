# ChatCAD 機構與運動學 AI 理解提升研究報告

> 狀態：研究紀錄，尚未代表實作承諾  
> 建立日期：2026-07-17  
> 研究範圍：目前工作樹中的 ChatCAD agent、Design／Sketch 提示詞、運動宣告、
> 驗證流程、lesson 與 smoke tests  
> 變更範圍：本次僅新增本文件，未修改任何程式碼  
> 修訂：2026-07-17 依審查調整——所有「已證實」引用已逐處核實；評測縮減規模、
> preflight 與 observation packet 釘成本上限並分階段、IR 補記 upstream 合併成本、
> 兩項極低成本 quick win 提前為 P0 立即項

## 1. 目的與成功標準

本研究的目標是找出 ChatCAD 如何從「能產生、顯示與驅動 CAD」提升成「能理解並驗證
機構意圖」。建議將成功標準定義為：

> ChatCAD 不只產生可執行、可顯示的幾何，還能證明關節拓撲、傳動關係、運動範圍與
> 碰撞條件符合使用者意圖。

目前最可直接從架構證據確認、且預期投報率最高的缺口，是 AI 在同一回合內缺乏
「可驗證的機構狀態」。模型知識量與推理能力仍會影響結果，但若沒有決定性的機構表示、
模擬與診斷，即使換更大的模型或把更多公式塞進 system prompt，也很難穩定判斷機構是否
真的正確。

建議的核心閉環為：

```text
使用者意圖
  → 機構語義／Mechanism Intent
  → 決定性預檢
  → 產生 Design 或 Sketch 幾何
  → 關鍵幀模擬
  → 語義觀察與診斷
  → AI 局部修正
  → 完整運動掃掠與匯出
  → 評測與 lesson 回饋
```

## 2. 研究方法與界線

本報告採用以下方式：

- 唯讀檢查 Design／Sketch agent prompt、runner 與 MCP tools。
- 唯讀檢查 MOTION 正規化、AssemblyHelper mates、Sketch schema／evaluator。
- 唯讀檢查 quick validate、完整精算、匯出閘與 lesson recorder 路徑。
- 檢查既有機構 live smoke tests 與 drivetrain KB 計畫。
- 交叉參考機械推理、文字轉 CAD、視覺回饋與 simulation-guided generation 研究。

本報告區分：

- **已證實現況**：可直接由目前程式與提示詞確認。
- **潛在風險**：架構上可能發生，但本次沒有宣稱已經頻繁出錯。
- **建議方案**：尚未實作或驗證的改善方向。

## 3. 現有架構摘要

### 3.1 Design mode

Design agent 以 build123d Python 產生正式幾何，要求 `PARAMS`、參數檢查、零件標籤、
`INTENDED_CONTACT` 與 `MOTION`，並透過 `cad_build → cad_validate → cad_present`
完成每個版本。

正常 agent 回合使用 quick validate。提示詞明確說明干涉與運動掃掠等昂貴檢查會標為
SKIP，完整檢查由使用者「精算此版」或匯出閘執行：

- [`src/server/agent/prompt.mjs`](src/server/agent/prompt.mjs#L145)
- [`src/server/cad/pipeline.mjs`](src/server/cad/pipeline.mjs#L497)

完整驗證能執行實體有效性、干涉與運動 sweep，是目前重要的安全網；但它通常發生在
agent 回合之外。

### 3.2 Sketch mode

Sketch agent 產生宣告式 JSON scene，支援 fixed、revolute、prismatic tree joints，以及
gear、rack-pinion、belt、mirror、actuator、coupler、attach、`pin_on_line` 等衍生元素。
其目標是快速展示最多兩個驅動自由度的機構概念，而不是一般化多體動力學求解器。

Sketch 的優點是語義比直接產生幾何程式更集中；限制則是一般閉環、奇異位形、致動器
行程與碰撞等條件尚未形成完整的決定性驗證閉環。

### 3.3 現有長處

1. **澄清閘門完整**：會區分驅動方式與傳動方式，避免在關鍵拓撲不明時直接建模。
2. **輸出合約成熟**：具備參數、標籤、運動宣告、意圖接觸與局部 retry 規則。
3. **Design／Sketch 分工合理**：正式幾何與低成本機構草模各有適用場景。
4. **匯出前完整驗證**：已有實際運動 sweep 與干涉 gate。
5. **具備真實 smoke tests**：已有 revolute、rack-pinion 與 Sketch live 測試，而不只測
   schema 是否能解析。

## 4. 主要發現

| 發現 | 性質 | 影響 |
| --- | --- | --- |
| 正常回合不執行實體有效性、干涉與完整 motion sweep 等昂貴檢查 | 已證實 | quick validate 的 `ok` 不等於機構語義正確 |
| 精算／匯出在 agent 回合外執行，結果無法直接進入當回合自修與 lesson recorder | 已證實 | 最有價值的運動失敗診斷沒有形成完整學習閉環 |
| AssemblyHelper mates 與 MOTION 是兩套機構語義表示 | 已證實 | 軸、pivot、moving labels、limits 存在不一致風險 |
| `couple` 只共享正規化進度，沒有顯式傳動公式與階段語義 | 已證實 | 同步、傳動與先後動作容易被混為同一概念 |
| `pin_on_line` 無解時會產生 `degenerate` 狀態 | 已證實 | 旗標在 `src/` 內產生後零消費，無解構形會鉗到切點照常呈現 |
| lesson 中仍存在「MOTION v1 僅支援 linear」的舊能力假設 | 已證實的資料狀態 | 已是畢業候選（caseCount 6、graduationCandidate），回歸風險迫近且內容主動有害 |
| prompt 規則很多，但部分規則沒有對應程式驗證 | 已證實 | 模型可能記住文字規則，卻無法證明輸出符合規則 |
| 現有 live tests 集中於少數成功案例 | 已證實 | 尚不足以量化跨機構族群、提示改寫與重跑穩定性 |

### 4.1 Quick validate 的語義缺口

Design prompt 已誠實告知 SKIP 是正常現象：

- [`src/server/agent/prompt.mjs`](src/server/agent/prompt.mjs#L163)
- [`src/server/agent/prompt.mjs`](src/server/agent/prompt.mjs#L179)

而 design quick validate 會建立多個 skipped checks，並可能以 `ok: true` 回傳；程式也註明
這種「全 skipped 的空洞綠」不等於 verified：

- [`src/server/cad/pipeline.mjs`](src/server/cad/pipeline.mjs#L503)
- [`src/server/cad/pipeline.mjs`](src/server/cad/pipeline.mjs#L541)

因此問題不是「完全沒有驗證」，而是目前同回合驗證主要確認輸出結構與 MOTION 宣告可用，
並未證明幾何有效、無干涉、傳動正確或整段運動可行。

### 4.2 Agent 缺少機構觀察能力

目前工具能建模、快速驗證、選取參考與呈現，但 agent 本身沒有取得以下資訊的標準工具：

- link-joint graph 與 ground 狀態。
- 關鍵幀的每個零件 transform。
- 實際輸入／輸出量及傳動殘差。
- 閉環殘差、退化狀態與奇異位形。
- 各幀最小間隙、接觸與碰撞對。
- 多視角或關鍵幀渲染觀察。

這使得 agent 很難在使用者看到錯誤之前主動發現「假綠」。現有提示詞也把部分視覺缺陷的
發現依賴於使用者回饋：

- [`src/server/agent/prompt.mjs`](src/server/agent/prompt.mjs#L180)

### 4.3 Assembly mates 與 MOTION 的雙語義風險

`packages/cadpy` 已具備 named frames、revolute／linear mates 與 `assembly_mates` 輸出：

- [`../../packages/cadpy/src/cadpy/assembly.py`](../../packages/cadpy/src/cadpy/assembly.py#L144)
- [`../../packages/cadpy/src/cadpy/assembly.py`](../../packages/cadpy/src/cadpy/assembly.py#L252)

ChatCAD 動畫與 sweep 另使用 `MOTION` 宣告，並以 `couple` 連結從動 DOF：

- [`../../packages/cadpy/src/cadpy/motion_decl.py`](../../packages/cadpy/src/cadpy/motion_decl.py#L160)

本次檢查未找到兩者的自動一致性驗證。這不表示已經觀察到大量衝突，但例如同一轉軸在
mate 與 MOTION 中具有不同 axis、pivot、limit 或 moving labels 時，現有 quick path 可能
無法阻擋。

2026-07-17 補充核實：cad-chat `src/` 內完全沒有引用 `assembly_mates`——動畫、掃掠
與 UI 的操作性表示實際上只有 MOTION 一套。雙語義風險成立，但目前爆炸半徑有限；
先做 mates 與 MOTION 的 cross-check 即可拿走大半價值，不必等完整 IR。

### 4.4 MOTION 傳動語義有限

目前 Design MOTION 主要支援 linear、revolute，`couple` 代表兩個 DOF 共用同一正規化
進度。輸出比例依賴各自的 travel 或 angle amplitude 間接表達，而不是以可驗證方程描述。

這種表示對簡單動畫有效，但不足以清楚區分：

- 同步運動。
- 齒輪、齒條、皮帶與螺桿等物理傳動。
- mimic／mirror 關係。
- 先 A 後 B 的 sequential phase。
- 具有事件或接觸切換的任務流程。

### 4.5 Sketch 退化與語義驗證缺口

`pin_on_line` 在幾何無解時會把負判別式 clamp 後繼續計算，並設定
`degenerate: true`：

- [`src/lib/sketch/sketchEval.js`](src/lib/sketch/sketchEval.js#L259)

2026-07-17 補充核實：`degenerate` 在整個 `src/` 樹中僅出現於建立它的那一行，產生後
零消費。這不只是「未升級為 range validation error」的潛在風險，而是旗標確定被丟棄；
無解構形會以鉗到切點的姿態照常呈現、照常可動。反過來說，把它升級為 present 路徑的
警告或驗證錯誤只是幾行改動，不必等完整 semantic validator——已列為 P0 立即項。

此外，Sketch 現有 schema validation 主要驗證型別、ID、引用、範圍格式、cycle 與部分
皮帶平面條件，尚未完整驗證：

- ground／base 是否真正支撐關節。
- actuator stroke 與 rod extension。
- 整個 drive range 的閉環殘差。
- 最小傳動角與奇異位形。
- gear／belt 的空間對齊與實際傳動比。
- attach continuity、碰撞與最小間隙。

### 4.6 Lesson 的版本與回饋問題

目前 lesson 資料中仍可找到「MOTION v1 僅支援 linear」的規則：

- [`../../models/.cadchat/lessons.json`](../../models/.cadchat/lessons.json#L1646)
- [`data/lessons.json`](data/lessons.json#L630)

目前實際開發 digest 因預算與排序只納入其他 lesson，所以它尚未污染 agent 回合；但
2026-07-17 補充核實：這條 LS-5 帶有 caseCount: 6 且 graduationCandidate: true——
它是畢業候選，回歸風險比「潛在」更迫近。且其內容主動有害：它會教 agent 對旋轉輸出
不宣告 MOTION、改用靜態幾何呈現，直接壓制現已支援的 revolute 能力。因此不等版本
標記機制建成，應先手動改寫或停用這一條——已列為 P0 立即項。

另一方面，工具註解明確指出精算與匯出閘在 turn 外執行，接不到 recorder：

- [`src/server/agent/tools.mjs`](src/server/agent/tools.mjs#L247)

因此最有價值的完整 motion sweep 結果，尚未自然形成「失敗 → 診斷 → lesson → 下次避免」
的閉環。

## 5. 建議目標架構

### 5.1 Mechanism Intent IR

長期建議建立單一機構中介表示，至少包含：

- `bodies`、`ground`。
- `joints`、`frames`、`axis`、`origin`、`limits`。
- `drivers`。
- `transmissions`。
- `loops`／closure constraints。
- `intended_contacts`。
- `task_phases`。
- `acceptance_requirements`。

理想上由同一份 IR 產生或驗證：

- AssemblyHelper mates。
- Design `MOTION`。
- Sketch scene。
- UI 規格卡。
- quick preflight 與完整 motion sweep。

這是架構級改造。建議將「是否採用及 schema 設計」列為近期決策，但分階段實作，不把
完整 IR 當成第一個 quick win。

另需計入一項本 fork 特有成本：IR 若深改 `packages/cadpy`，會連動 8 份 vendored
複本，並顯著加重與 upstream 的後續 merge 負擔。結合 4.3 的核實——cad-chat 的
操作性表示實際上只有 MOTION 一套——合理路徑是 cross-check 先行，完整 IR 往後推，
等 cross-check 累積出足夠的不一致案例，再回頭決定 schema。

### 5.2 同回合機構 preflight

不需要每次都執行完整高成本 BRep sweep。建議先在以下位置取樣：

- 起點、終點、中點。
- 25%、75%。
- 幾何極值、關節極限與可能奇異點。

每個樣本的檢查分兩級，並先釘死成本上限。2026-07-10 已裁決把驗證收斂為「單一快
路徑 + 精算 + 匯出閘」，preflight 等於把驗證成本搬回回合內；若不設硬上限，就是
走回收斂前的老路。

**v1（硬上限：零 spawn、純運動學數學，禁任何 BRep 呼叫）：**

- graph、ground 與自由度。
- axis、pivot、frame 與單位一致性。
- joint limits 與 moving-label coverage。
- 齒輪比、齒條位移、皮帶比、螺桿 lead 方程殘差。
- 閉環位置殘差。
- actuator stroke、rod length 與伸出量。
- transmission angle。
- degenerate 與奇異位形旗標。
- 任務 phase 的順序與同步關係。

**v2（仍零 spawn，但允許讀既有 GLB 與 bbox 幾何）：**

- 關鍵幀 bbox 層級 broad-phase 碰撞與粗略最小間隙。

任何需要 BRep 的檢查——精確干涉、精確最小間隙、實體有效性——不進 preflight，
留在精算與匯出閘。關鍵機構錯誤應在 agent 當前回合被指出；完整精算則繼續作為
匯出前權威 gate。

### 5.3 Semantic Observation Packet

建議 build／simulate 後回傳一份穩定、結構化的機構觀察，並與 preflight 同步分階段：

**v1（純運動學，與 preflight v1 共用同一成本上限）：**

- part／joint graph。
- 每個關鍵幀的 link transforms。
- 實際輸入與輸出量。
- 預期與實際傳動比、closure residual。
- joint-limit、stroke、degenerate、singularity warnings。

**v2（之後再做）：**

- contacts、collision pairs、minimum clearance——bbox 層級，或由精算結果回填。
- 可選的多視角關鍵幀縮圖。

AI 應依據這份觀察做局部修正，而不是僅依賴 build 成功或等待使用者看圖指出問題。

### 5.4 顯式 Transmission 與 Phase 語義

建議將目前較泛用的 `couple` 拆成可驗證 relation，例如：

- gear：齒數比、方向、中心距。
- rack-pinion：`s = rθ`。
- belt：pulley ratio、open／crossed。
- lead screw：lead 與 rotation-to-translation。
- mimic／mirror。
- synchronized。
- sequential phase／timeline。

「一起動」與「先做 A、再做 B」不應再由同一共享參數隱式表示。

## 6. 優先順序

| 優先級 | 項目 | 預期影響 | 相對成本 |
| --- | --- | --- | --- |
| P0 立即 | Sketch `degenerate` 旗標升級為 present 路徑警告或錯誤 | 中高 | 極低 |
| P0 立即 | 手動改寫或停用 LS-5 過時教訓（畢業候選、主動有害） | 中高 | 極低 |
| P0 | 建立固定模型、prompt、lesson 與重跑基線（縮小規模，見第 8 節） | 高 | 低 |
| P0 | 清查過時 lesson，加入 capability／schema version | 中高 | 低 |
| P0 | semantic observation packet v1（純運動學） | 高 | 中 |
| P0 | 同回合關鍵幀 preflight v1（零 spawn、禁 BRep） | 很高 | 中 |
| P0 決策 | 定義 Mechanism Intent IR 邊界與 schema（僅決策，不實作） | 很高 | 中 |
| P1 | Cross-check assembly mates 與 MOTION | 高 | 中 |
| P1 | preflight／packet v2（bbox broad-phase 碰撞與粗略間隙） | 高 | 中 |
| P1 | 顯式 transmission／mimic／phase relation | 高 | 中高 |
| P1 | Sketch 全範圍 semantic validator | 高 | 中高 |
| P1 | Prompt 模組化與意圖路由 KB | 中高 | 中 |
| P2 | 分階段讓 IR 成為單一語義來源（等 cross-check 案例累積） | 很高 | 高 |
| P2 | 一般閉環機構求解器 | 高 | 高 |
| P2 | 以驗證軌跡建立 fine-tuning 資料 | 未定 | 高 |

## 7. Prompt 與知識機制優化

### 7.1 穩定核心與意圖路由

目前提示詞內容本身不差，主要問題是大量規則長期常駐。建議拆成：

1. **穩定核心**：工具合約、不可虛報驗證、座標系、單位、澄清規則、輸出格式。
2. **意圖路由模組**：齒輪、齒條、皮帶、四連桿、鈑金、sweep、gantry 等按需求載入。
3. **決定性驗證規則**：凡是程式可檢查的條件，不只寫在 prompt。

現有 [`DRIVETRAIN_KB_PLAN.md`](DRIVETRAIN_KB_PLAN.md) 方向值得延續，但 KB 主要改善選型、
公式召回與配置建議，不能取代運動學驗證。

### 7.2 澄清問題分級

建議將未知資訊分為：

- **硬性未知**：拓撲、驅動、傳動、行程、安全條件。必須詢問。
- **軟性預設**：外觀與非關鍵尺寸。可採預設並公開成可編輯規格。
- **可推導值**：齒比、中心距、行程換算。交由求解器計算，不詢問，也不要求模型心算。

這能保留目前優秀的澄清 gate，同時降低不必要的往返。

### 7.3 將成功條件寫得更明確

建議核心提示詞加入相同意義的規則：

> Build 成功或畫面合理，不代表機構正確；只有通過拓撲、傳動方程、運動範圍與碰撞
> 檢查，才能宣稱機構符合意圖。

### 7.4 少量正反範例

每個被路由進來的機構族群，可提供：

- 一個正確範例：包含 intent、方程、IR、驗證結果。
- 一個失敗範例：例如錯誤轉向、錯誤中心距、閉環無解或 actuator 超行程。

負面範例應附決定性診斷，而不只是告訴模型「這樣不對」。

## 8. 評測建議

本節原始矩陣——約 10 個族群 × 6 種 prompt 層級 × 至少 5 次重跑——按字面是每輪
300 次以上的真 LLM 回合，與本 repo 驗證金字塔「L4 最貴、被 gate」的原則衝突，也
超出自用 fork 的額度負擔。調整如下：

- 首輪基線縮為 3–4 個族群（建議 revolute 單軸、rack-pinion、four-bar、gripper）
  × 2 種 prompt 層級（完整工程規格、只描述功能）× 2–3 次重跑，以一次性快照執行，
  不進例行 CI。
- 下列 8.1 與 8.2 保留為長期完整矩陣，之後只在特定改動需要時抽子集跑。
- 指標先做決定性項——殘差、通過率、重跑一致性；intent／topology accuracy 需要
  人工標註 ground truth，首輪以人工抽查代替，不建自動化評分。

### 8.1 機構族群（完整矩陣，首輪只取子集）

- revolute／prismatic 單軸。
- gear pair／gear train／planetary。
- rack-pinion。
- belt／pulley。
- lead screw。
- crank-slider。
- four-bar。
- toggle／gripper。
- cam／Geneva。
- 多階段 pick-and-place。

### 8.2 Prompt 層級（完整矩陣，首輪只取子集）

每個機構至少測試：

- 完整工程規格。
- 缺少拓撲關鍵資訊。
- 只描述功能、不提供尺寸。
- 同義改寫與中英混合。
- 內含矛盾條件。
- 圖片／幾何參考加文字。

### 8.3 指標

- intent／topology accuracy。
- ground、joint type、DOF 正確性。
- transmission equation residual。
- closure residual。
- joint-limit／stroke 通過率。
- minimum clearance 與 collision。
- full motion sweep 通過率。
- 澄清問題的必要性與精準度。
- 局部修正次數。
- 至少五次重跑的一致性。
- latency、token 與驗證成本。

評測必須分開「語法／可執行」、「幾何有效」和「機構語義正確」，不能只用是否產出 GLB
或單一 `ok` 判斷。

## 9. 建議執行階段

### 第一階段：讓現況可量測（含 P0 立即項）

- 先做兩個極低成本修正：`degenerate` 旗標升級為警告、手動改寫或停用 LS-5。
- 固定模型、effort／thinking、prompt version 與 lesson digest。
- 建立縮小規模的跨機構 baseline——3–4 族群 × 2 prompt 層級 × 2–3 重跑，
  一次性快照，不進例行 CI。
- 清查過時 lesson，加入 capability／schema version。
- 定義 observation packet v1 與 preflight v1 的 acceptance criteria，明訂零 spawn、
  禁 BRep 的成本上限。

### 第二階段：補同回合閉環

- Design／Sketch 關鍵幀 preflight v1（零 spawn、純運動學）；穩定後再評估 v2 的
  bbox 碰撞。
- 退化、奇異位形、行程與方程檢查。
- 將診斷回傳 agent，執行局部修正。
- 將完整精算與匯出結果回流 lesson／eval。

### 第三階段：統一機構語義

- 先做 mates 與 MOTION 的 cross-check，累積實際不一致案例。
- 案例足以支撐 schema 設計後，再導入 Mechanism Intent IR，逐步整合 mates、
  MOTION、Sketch 與 UI specs；cadpy 深改連動 8 份 vendored 複本與 upstream merge
  負擔，一併納入決策。
- 擴充 transmission／phase relation。
- 將 prompt 拆成穩定核心與意圖路由 recipe／KB。

### 第四階段：進階能力

- 一般閉環求解器。
- 圖片、點雲或 6D pose 觀察。
- 在累積足夠 intent—IR—validation—repair 軌跡後，再評估 fine-tuning。

## 10. 不建議優先投入的方向

1. **單純換更大模型**：可作實驗變因，但不能取代求解與驗證。
2. **繼續加長單一 system prompt**：會增加注意力稀釋與過時規則風險。
3. **只增加成功範例**：若沒有負例、殘差與驗證結果，很難形成可泛化的機構理解。
4. **每回合都跑完整高解析 sweep**：成本與延遲過高，應採 cheap preflight 再升級完整驗證。
5. **立即 fine-tune**：目前更缺少的是可靠標註、機構 IR 與失敗診斷軌跡。

## 11. 最終建議

先做兩件不用排隊的事：把 `degenerate` 旗標升級為警告、改寫或停用 LS-5——兩者都是
極低成本，立即關掉已核實的風險。

之後若只能優先投入三件事，建議依序為：

1. **同回合關鍵幀運動學 preflight v1——零 spawn、純運動學、禁 BRep。**
2. **將關節、姿態、傳動殘差轉成 AI 可讀的 semantic observation v1；碰撞與間隙留給 v2。**
3. **建立可重現的縮小規模 benchmark——3–4 個機構族群——並讓完整驗證結果回流 lesson。**

完成這三項後，再增加知識庫、改 prompt、擴充 IR 或更換模型，效果才會真正可量測、
可比較與可累積。

## 12. 外部研究參考

以下資料於 2026-07-16 至 2026-07-17 查閱：

1. [Probing Mechanical Reasoning in Large Vision Language Models](https://arxiv.org/abs/2410.00318)  
   顯示多種大型視覺語言模型在齒輪等機械推理任務上仍不穩定，參數規模增加不一定能解決
   mental simulation 缺口。
2. [Text2CAD: Generating Sequential CAD Designs from Beginner-to-Expert Level Text Prompts](https://arxiv.org/abs/2409.17106)  
   支持使用結構化建構序列、多層級提示，以及分離幾何、參數與語義評測。
3. [Text-to-CAD Generation Through Infusing Visual Feedback in Large Language Models](https://www.microsoft.com/en-us/research/publication/text-to-cad-generation-through-infusing-visual-feedback-in-large-language-models/)  
   CADFusion 顯示視覺回饋與序列學習能互補改善文字轉 CAD。
4. [Simulation-Guided LLM Code Generation](https://arxiv.org/abs/2504.02141)  
   支持「生成—模擬—規則診斷—修正」的迭代閉環。
5. [CADBench: A Comprehensive Benchmark for Evaluating Text-to-CAD Models](https://arxiv.org/abs/2605.10873)  
   顯示可執行性、幾何忠實度、程式品質等指標不應合併成單一成功判定，且機構複雜度會
   顯著影響表現。
6. [AssemLM: A Large Language Model for 3D Mechanical Assembly](https://arxiv.org/abs/2604.08983)  
   支持向模型提供明確 3D pose 與幾何觀察，而不是只依賴文字描述。

