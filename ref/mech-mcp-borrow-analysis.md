# mech-mcp → text-to-cad 借鏡分析報告

> **分析對象**:`ref/mechanism_engineering_suite/mech-mcp`(對話式機構設計 MCP server)
> **借鏡目標**:`text-to-cad`(CAD / 機器人描述的 Claude Code skill 庫)
> **日期**:2026-06-27

---

## TL;DR

`mech-mcp` 是一個**狹義但縱深極深**的系統:用對話設計「氣缸驅動的低自由度機構」,核心價值不在它能做的機構種類(只有 tilt/grip),而在它把**「正確性」做成了程式化、不可繞過的閘門**。

text-to-cad 與它是**互補的兩種正確性哲學**:text-to-cad 把正確性託付給「LLM 看 snapshot + 確定性量測」,mech-mcp 託付給「kernel 級自動閘門 + 沙盒唯一出圖授權」。**最值得借鏡的不是它的機構功能,而是它那套「驗證即架構」的紀律**——而且其中一大半(知識資產類)因為 text-to-cad 本就是 skill/prompt 驅動,幾乎可以即插即用。

---

## 一、根本差異:兩種「正確性」哲學

| 面向 | text-to-cad(現況) | mech-mcp(ref) |
|---|---|---|
| 幾何核心 | build123d / OCP(OCCT),STEP-first | occt-wasm,經 `KernelPort` 抽象 |
| 交付形態 | Claude Code **skills**(無 MCP server) | **MCP server**(19 工具) |
| 正確性來源 | **LLM 視覺 snapshot + 確定性量測**(`inspect/measure/align/diff`) | **9 道程式化閘門 + 沙盒唯一出圖授權** |
| B-rep 有效性 | 假設 OCP 內部保證,**無硬性檢查**;non-manifold 僅當 metadata 暴露 | `buildabilityGate` 強制 watertight + `isValid` |
| 干涉/碰撞 | **無引擎**,靠 LLM 看透明/wireframe snapshot | 全行程 ≥60 幀 kernel 精密干涉掃掠 |
| 自由度/運動學 | **無**自動 DOF;`.step.js` 手算正向運動學 | 閉式運動學(圓交點/餘弦)+ DOF 閘門 |
| 互動模式 | 一次性生成 + 顯式假設(最多問 1 個阻塞問題) | **先問再設計**:缺必填即提問,不得用預設帶過 |
| 2D 工程圖 | **無**(只有 3D snapshot 風格) | multiview + HLR 藏線 + 尺寸 + 標題欄 |

**一句話**:text-to-cad 的正確性責任壓在 LLM 身上(「看得見才信」);mech-mcp 把它壓進程式(「算得出才信」)。前者通用、靈活、範圍廣;後者狹窄,但在它的領域裡**幾乎不可能產出錯誤幾何而不被擋下**。

借鏡的核心問題因此是:**能否在不犧牲 text-to-cad 通用性的前提下,把 mech-mcp 那套「程式化閘門」的紀律,選擇性地注入到 text-to-cad?**

---

## 二、最高槓桿:三個可跨領域遷移的「機制」

### 1. 沙盒即唯一出圖授權 → 升級 text-to-cad 的 repair-loop

**mech-mcp 怎麼做**:`verifyBundle`(`gates/bundle.ts`)是「THE only emit authority」——9 道閘按序執行,第一個 FAIL 就 short-circuit 並回傳**結構化定位**(哪道閘、最小間隙、穿模對);`go=false` 時 generator **拒寫任何檔案**。每道閘都用「注入缺陷必 FAIL」的 known-bad fixture 上鎖。

**text-to-cad 現況**:`skills/cad` 有 `references/repair-loop.md`(生成→檢查→修復→重跑),但檢查是「建議步驟」,**不是不可繞過的閘門**——LLM 可以宣稱「看起來對了」就結束。

**建議落點**:把 `cad` skill 的 repair-loop 從「流程指引」升級成「**驗收契約**」:定義一組確定性檢查(bbox 斷言、selector 數量、`is_valid`、組合件最小間隙),**全綠才算 `gen_step` 完成**,任一 FAIL 就回結構化定位而非含糊重試。`packages/cadpy/validators.py` 已有 `assert_bbox_*`/`assert_selector_count` 雛形——缺的是「把它變成強制門、且作者**必須**為每個產物宣告預期值」這條紀律。

**難度**:中(機制 text-to-cad 已有八成,差「強制 + 結構化定位」的收斂)。**ROI:高**。

---

### 2. 「生成即納管」+ 碰撞幾何=render 幾何單一真相

**mech-mcp 怎麼做**:兩個結構性不變量根除了幾何管線最致命的兩類 bug:

- **Single Body Registry**(`model/bodyRegistry.ts`):目錄件、生成件、客製件全部登記進**同一份清單**;`register()` 缺 collision proxy 就 `throw`。位姿、干涉、算繪只迭代這份清單——「生成幾何漏出碰撞檢查」在**構造上不可能**。
- **buildability gate 的 `proxy ⊇ display` 不變量**(`gates/buildability.ts`):碰撞用的 proxy 必須**實體包覆** render 用的 display solid(`volume(display ∖ proxy) ≈ 0`,比 AABB 強)。這把「閘門全綠但 mesh 浮空/突出」(碰撞幾何與顯示幾何漂移)變成**可執行的硬不變量**。

**text-to-cad 現況**:組合件碰撞**完全靠 LLM 看 snapshot**(`snapshot-review.md` 用透明/wireframe 找重疊)。沒有「所有零件統一登記、強制都進檢查」的結構保證——LLM 可能只檢查它「想到」的那幾對。

**建議落點**:對**組合件**(`AssemblyHelper` / labeled compound)引入一個輕量「registry 完備性」原則:`packages/cadpy` 在量測組合件時,**枚舉所有 occurrence 兩兩配對**做最小距離,而不是讓 LLM 挑對子。這正好補上 text-to-cad 的 `align` 只量「使用者指定的配合」、沒有「全枚舉反面」(該分開卻穿模、漏檢的對子)的空缺。

**難度**:中。**ROI:高**(組合件正確性是 LLM 視覺最容易漏的地方)。

---

### 3. 用 OCP 既有 API 補上「確定性幾何閘門」

mech-mcp 的閘門能力,OCP(text-to-cad 已依賴)**幾乎都有對應 API,只是沒被用**:

| mech-mcp 閘門 | OCP 對應(text-to-cad 可直接調用) | text-to-cad 現況 |
|---|---|---|
| `isValid` / watertight | `BRepCheck_Analyzer`、`ShapeFix` | 未使用 |
| 全行程精密干涉 | `BRepExtrema_DistShapeShape`(精確最小距離)、`BOPAlgo` common 體積 | 未使用(靠 LLM 看) |
| 穿透體積 | `common` + `GProp_GProps`(質心/體積) | 未使用 |

**建議落點**:在 `packages/cadpy` 新增一個 `validators` 的幾何層伴生物——`assert_valid_solid()`(包 `BRepCheck_Analyzer`)、`assert_no_interference(parts, clearance)`(包 `BRepExtrema_DistShapeShape`)。`cad` skill 的 inspection reference 把這兩個列為**組合件/承力件的選用硬檢查**。text-to-cad 現在「沒有 BRepCheck/ShapeFix/watertight 硬檢查」——這是**用既有依賴就能補的最便宜縱深**。

**難度**:低–中(API 都在,是「接上 + 寫斷言」)。**ROI:高**。

> ⚠️ 但要尊重 text-to-cad 的**誠實邊界**(`inspection-and-validation.md` 明說不宣稱 FEA/公差/認證)。建議把這些定位成「幾何有效性」檢查,**不要**滑向結構安全宣稱。

---

## 三、最低成本:可直接移植的「知識資產」

這是借鏡 ROI 最高的一塊——因為 text-to-cad 本就是 **prompt/skill 驅動**,而 `ref/kb_and_prompts/` 整個就是「把機構工程知識編碼成 LLM 可用提示詞」的成品。**這些是 markdown,不是程式,移植幾乎零工程成本**,差別只在「改寫成 text-to-cad skill references 的語氣與落點」。

### 4. 教訓制度化飛輪(出包 → 升級成規則條文)

**mech-mcp 怎麼做**:`0_master_core.md` 的「教訓索引」是一套**元方法**:每次出包 → 當回合把根因**升級成規則條文**(掛 `⟦教訓⟧` 標籤)→ 更新索引表。例如 3D-21「ExtrudeGeometry 厚度疊兩次→件浮空,閘門全綠卻浮空」直接催生了「斷言建模世界座標=公式世界座標」這條規則。這讓知識庫**單調增長、不退步**。

**為何對 text-to-cad 特別契合**:text-to-cad 有 `benchmarks/`(人工評測標準)和 repair-loop,但**沒有把單次失敗固化成 skill reference 規則的制度**。這個飛輪正是 skill 庫長期質量的元能力。

**建議落點**:在 `cad` skill 加一份 `references/lessons.md`(或 benchmark 失敗 → reference 規則的回填約定)。**這是把 mech-mcp 維護方法論搬過來,不是搬內容**。

### 5. 機構合成七節點互動決策 → 補上 text-to-cad 完全缺失的「先問再設計」

**mech-mcp 怎麼做**:`6_mechanism_synthesis_decision.md` + `design/clarify.ts`。當需求是「我要一個能做 X 的機構」(目錄查無),走七節點:需求解析 → 功能分解(驅動/導引/傳動/支撐/末端)→ 選規格 → 接口決策 → DOF 檢查 → 佈局閘門 → 出圖回填。**每個決策節點列 2–4 個互斥選項請使用者拍板,且選項附「量化後果」而非只列型號**(教訓 SYN-2:「使用者選後果,不選規格」)。`clarify.ts` 的 `OpenQuestion` 結構(`prompt`/`why`/`options`/`default`/`required`)是個乾淨的範本。

**text-to-cad 現況**:`cad` skill 明說「最多問一個阻塞性問題,否則用顯式假設往下做」——**刻意避免互動**。這對「畫一個墊片」是對的,但對「設計一個能做 X 的東西」就太貧弱。

**建議落點**:這對 text-to-cad 是**新能力**,不是替換。可作為 `cad` skill 的一個進階模式(或獨立 skill):當任務是**功能性設計**(非「照圖建模」),啟用「功能分解 → 列選項附後果 → 使用者拍板」流程。`AskUserQuestion` 工具天然契合 `OpenQuestion` 結構。

**難度**:中(主要是 prompt 工程 + 流程設計)。**ROI:高**(填補一整類「我要一個能…的零件/治具」需求)。

### 6. C1–C10 工程鐵則 + 失效模式表

`0_master_core.md` 的 C1–C10(座標單位、骨架先行=桿長即中心距、計算先行強制閘門、DOF 鐵律、運動掃掠、汽缸可建造性、Z 分層、側負載、公差速查 H7/g6…)+「失效模式→標註重點」表,是一份**濃縮的機械設計 review checklist**。其中與 text-to-cad 直接相關的(座標慣例、公差配合、承力結構連續性、Z 分層避碰)可萃取進 `cad` skill 的組合件/機構類 reference,作為 LLM 自我 review 的依據。

**建議落點**:`cad/references/` 新增機構/承力件專章(萃取,非照搬;text-to-cad 不是只做氣缸機構,要去領域特化)。**ROI:中–高**。

### 7. 原子件查證卡 + 型態學 KB → 強化 step-parts 與機構建模

`5_atomic_part_verification_kb.md`(原子件查證卡:氣缸/軸承/線性滑軌/滾珠螺桿的真實尺寸 + 孔位 + 選型公式)和 `4_planar_linkage_morphology_kb.md`(Grashof 型態判別)。text-to-cad 的 `step-parts` 是**遠端 REST 目錄**(schema/attributes/standards),擅長「找現成件」,但**沒有「選型推理」**(這顆缸夠力嗎?孔位配得上嗎?)。mech-mcp 的查證卡把「選型公式 + ✓級孔位」編碼進知識——可作為 step-parts 下載件後的「選型/介接合理性」reference。

**建議落點**:`step-parts/references/` 補「選型後果與標準孔位」知識。**ROI:中**。

---

## 四、範圍內可補的具體技術缺口

### 8. 2D 工程圖(multiview + HLR 藏線)

mech-mcp 的 `KernelPort.multiviewSVG`(`generators/svg2d/`)用 occt **內建 HLR** 出三視+等角、虛線藏線、尺寸 footer、標題欄,單檔 SVG。**OCP 有 `HLRBRep_Algo` / `HLRAlgo`**——text-to-cad 完全可做但**現在沒有**。`dxf` skill 目前只做平面排版,不做投影出圖。

**建議落點**:`dxf` 或新 skill,用 OCP HLR 從 STEP 出多視工程圖。**ROI:中**(看使用者是否需要正式工程圖;若需要,這是明確的能力空白)。

### 9. 閉式運動學系統化(取代 `.step.js` 手算)

mech-mcp 的 `design/kinematics.ts` 把四連桿/滑塊曲柄/傾斜/夾爪的閉式解(圓交點/餘弦定理,**分支穩定不 mid-sweep flip**)做成函式庫,還有**逆解交叉檢查**(`extForTilt` vs `solveTiltPlatform` 不能默默不一致)。text-to-cad 的 `models/rack_pinion_rotary_actuator/.step.js` 是**手算 + 手寫 sign-check 註解**——能動,但每個機構重造、無驗證。

**建議落點**:若 text-to-cad 要認真做「會動的組合件」,`packages/cadjs/common/stepParameters.js` 旁可加一個小型閉式運動學工具庫(四連桿/滑塊曲柄),取代逐案手算。**ROI:中–低**(取決於動畫機構的需求量)。

### 10. 驗證雙軌 + 交接注記

mech-mcp 的 `C3.1 驗證雙軌`:**設計軌**(margin 0.3mm,傳動角等「報而不擋」)vs **出圖軌**(硬擋);設計軌**必附交接注記**(列出實際 margin、僅報未擋項、未驗項、緊配合清單),讓下游工程師「一眼看到開放項,不把 Demo 精度誤當設計意圖」。這比 text-to-cad「我不宣稱 FEA」的單句免責更**結構化**。

**建議落點**:repair-loop / inspection reference 收尾時,輸出一份「驗證了什麼、沒驗什麼、用了什麼容差」的結構化交接註記。**ROI:中**(低成本提升交付誠實度)。

---

## 五、**不**建議照搬的(避免水土不服)

1. **領域特化的閘門/運動學**:`cylinderGate`、`solveTiltPlatform`、tilt/grip 模板——這些是 mech-mcp 對「氣缸機構」這個窄域的硬編碼。text-to-cad 是通用 CAD,**要萃取原則(全行程掃掠、proxy⊇display、DOF=驅動數),不要搬實作**。

2. **`KernelPort` 抽象層**:它的價值是隔離 occt-wasm 改版震盪。text-to-cad 用 **build123d 本身就是 OCP 之上的抽象層**,再加一層收益遞減。直接擴充 `packages/cadpy` 即可。

3. **整套 MCP 化**:text-to-cad 選擇 skill 模式是**刻意的**(plugin manifest 只宣告 skills,無 `.mcp.json`)。skill 比 MCP 更輕、更易組合進 Claude Code/Codex。**不需要為了像 mech-mcp 而 MCP 化**——借的是「沙盒紀律」,不是「MCP 形態」。

4. **`occt-wasm` / Three.js + Playwright 那套 JS 幾何棧**:text-to-cad 的 viewer 已有等價物(`packages/cadjs` + three.js + GLB sidecar 管線),且 Python 主線更適合它的 STEP-first 定位。

> 必須注意 text-to-cad 的 repo 鐵律(`AGENTS.md`):**skills 須自含、不得互相依賴,共用程式碼一律住 `packages/` 再 vendored 進 skill**。任何借鏡的「程式」都要落在 `packages/cadpy`(Python 幾何)或 `packages/cadjs`(viewer),**不能**在 skill 之間直接共用。

---

## 六、優先級建議(投入 × 產出)

| 優先 | 借鏡項 | 落點 | 成本 | 槓桿 |
|---|---|---|---|---|
| **P0** | ③ 用 OCP 補幾何有效性 + 干涉硬檢查 | `packages/cadpy` 新斷言 | 低 | 高 |
| **P0** | ④ 教訓制度化飛輪 | `cad/references/lessons.md` | 極低 | 高(複利) |
| **P1** | ① 沙盒即出圖授權(repair-loop 升級成驗收契約) | `cad` skill | 中 | 高 |
| **P1** | ② 組合件「全枚舉」干涉(生成即納管精神) | `packages/cadpy` | 中 | 高 |
| **P1** | ⑤ 機構合成互動決策(先問再設計) | `cad` 進階模式 / 新 skill | 中 | 高(新能力) |
| **P2** | ⑥⑦ C1–C10 + 查證卡/型態學 KB | `cad` / `step-parts` references | 低 | 中 |
| **P2** | ⑩ 驗證雙軌 + 交接注記 | inspection reference | 低 | 中 |
| **P3** | ⑧ 2D 工程圖 HLR | `dxf` / 新 skill | 中–高 | 視需求 |
| **P3** | ⑨ 閉式運動學庫 | `packages/cadjs` | 中 | 視需求 |

**如果只做一件事**:P0 的 ③——用 text-to-cad **已經依賴的 OCP**,把 `BRepCheck_Analyzer` 和 `BRepExtrema_DistShapeShape` 接成兩個確定性斷言。這是把 mech-mcp 最核心的「算得出才信」精神,用最低成本注入 text-to-cad 最大的空缺(幾何有效性 + 自動干涉),且完全在現有架構與依賴內。

**一句收尾**:mech-mcp 教給 text-to-cad 的不是「怎麼做機構」,而是**「把不可繞過的正確性閘門做進架構,而不是託付給 LLM 的眼睛」**——而 text-to-cad 因為底層同是 OCCT、上層是 prompt 驅動,接收這套紀律的成本比想像中低得多。

---

## 附錄:本報告的證據基礎

**mech-mcp 已讀核心檔案**:
- `mech-mcp/README.md`、`ROADMAP.md`、`AI_DESIGN_GUIDE.md`、`CLAUDE.md`(設計哲學、三鐵則、架構)
- `src/gates/bundle.ts`(沙盒主控,9 道閘短路鏈)、`gates/buildability.ts`(proxy⊇display)、`gates/collision.ts`(全行程干涉)
- `src/model/bodyRegistry.ts`(單一登記、強制 proxy)
- `src/design/kinematics.ts`(閉式運動學)、`design/clarify.ts`(澄清前門)
- `src/kernel/KernelPort.ts`(kernel 抽象 + HLR 2D 介面)、`knowledge/synthesis.ts`(型別合成)
- `ref/kb_and_prompts/0_master_core.md`(C1–C10 鐵則 + 教訓索引)、`6_mechanism_synthesis_decision.md`(七節點互動合成)、`FILENAME_MAP.md`

**text-to-cad 已查證能力**(逐項確認「有/沒有」,證據見各 SKILL.md 與 `packages/cadpy`):
- 底層 = build123d / OCP(OCCT),STEP-first;交付 = skills,**無 MCP server**
- 正確性 = LLM snapshot + 確定性量測(`inspect/measure/align/diff`、`validators.py` bbox/selector 斷言)
- **無**:自動干涉/碰撞引擎、自動 DOF、機構合成、運動學求解器、B-rep 有效性硬 gate、2D 工程圖(multiview/HLR)、多輪需求澄清
