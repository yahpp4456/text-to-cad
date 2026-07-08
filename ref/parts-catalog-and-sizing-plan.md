# 標準件:選型 + 參數化生成 + 規格庫 —— AI 自主執行規格（v2）

> **這份文件是給 AI 自主執行的施工規格**,不是給人「下次手動做」的筆記。照它從頭跑到尾:
> 先在「氣缸」上把樣板證到全綠 → **不要停** → 用同一套路把其餘 family(軸承/滑軌/螺桿/馬達)**全部做完** →
> 再做一個整合 capstone 證明它們能組起來 → 最後全域驗證收尾。
> **定位**:把 [`mech-mcp-borrow-analysis.md`](./mech-mcp-borrow-analysis.md) 第 **⑦** 項(查證卡選型公式 → 補 step-parts 缺的「選型推理」)
> 從 knowledge md **升級成可執行碼**;做完會**稀釋第 ⑤ 項(互動式合成)的必要性**。
> **環境**:Windows 自用 fork,主分支 `開發`(細節見 §0)。日期 2026-06-28。

---

## 0. 給執行 AI 的最高指令（先讀,全程遵守）

**任務**:讓機構設計時,功能/採購件(缸、軸承、滑軌、螺桿、馬達)不再憑空捏尺寸 ——
依需求**選型**(L1)→ 命中 step.parts 真實件就用真檔(L2,本輪暫不自動化)→ 沒命中就**參數化生成簡化代用件**(L3),
每筆帶 `source`/`confidence`。

**執行模式(autonomy)**:
1. **Phase 1**:在氣缸上跑完可重複樣板 A–E(§4 定義、§5 實作),**自我驗證所有 gate 全綠**。
2. **不要停** → **Phase 2**:對軸承、線性滑軌、滾珠螺桿、步進馬達**各跑一次同樣的 A–E**(§6),逐一自驗全綠。
3. **Phase 3**:做整合 capstone(§7),一次消費 ≥4 個 family,整機 gate 全綠。
4. **Phase 4**:全域驗證 + 同步複本 + 文件回填 + 分組 commit(§8)。
5. 全程**自主,不要問使用者**——決策已在本文件預先定好或給出規則。**唯一允許停下**的情況:某個會影響正確性的關鍵規格既無法取得、也無法安全估值;此時停下、說明、給選項。

**不可違反的鐵則(本 fork 實況 + 誠實邊界)**:
- **分支 `開發`**:直接 commit 到 `開發`(自用 fork、不回上游,**不需 PR / 不需開 feature 分支**);**不要 `push`**(Sam 自己 push)。**絕不碰 `main`**。
- **本 fork 無 symlink**,vendored 路徑是**獨立實體複本**。**不要**跑 `scripts/dev/setup-symlinks.sh`、`scripts/bundle/bundle.sh`、`Release`/`Deploy` 系列(本 fork N/A,且 git-bash 缺 rsync 跑不動)。複本同步**一律用已驗證的 `scripts/dev/sync-vendored.sh`**(2026-06-28 新增、已測;見 §3.3)——**不要自己手寫廣域 `find|cp`**(會誤中 `tests/python/packages/cadpy/` 測試目錄,見 §3.3 ⚠️)。
- **直譯器** `.venv/Scripts/python.exe`(Windows;venv 在 `Scripts/` 非 `bin/`)。Python 3.13 可用。
- **沒實際跑過測試,不准宣稱綠**。每個 gate 都要真的執行、看到 pass 才算過。這是本 repo 的核心紀律(確定性閘門,見 `skills/cad/references/lessons.md`)。
- **規格來源誠實**:每列標 `source` + `confidence`;**不得把臆測尺寸當成權威廠商值**。標準系列的公稱尺寸(608=8×22×7、NEMA17=42.3mm 等)可標 `high`;重建/推算標 `med`;沒把握標 `low` + `source:"self-estimate"`。每個 family 只放 **4–6 個代表規格**,不求窮舉。
- **LFS filter 永不關**(STEP/GLB 受 LFS 追蹤);所有產物寫 `models/`;**不宣稱** FEA/疲勞/公差/認證(選型 margin 一律「報而不擋」)。

**完成定義(全域停止條件)**:見 §9 的逐項 checklist,全綠才算做完。

---

## 1. 現況事實（grounding,別重查）

| 能力 | 現況 |
|---|---|
| 零件檢索 | `step.parts` 遠端 REST:關鍵字/facet 查 + 下載真實 STEP + SHA-256。**只檢索,不選型**。CLI:`skills/step-parts/scripts/download_step_part.py` |
| 參數化件家族 | **無**。模型都是一次性硬寫。雛形只在 ref TS:`ref/mechanism_engineering_suite/mech-mcp/src/parts/partBuilders.ts`(`buildCylinderBody/Rod/Bearing`) |
| 本地規格庫 | **無**。`cadpy/catalog.py` 是 **repo CAD 來源探索**,非零件庫 → 新模組避開 catalog 命名 |
| 選型推理 | **完全沒有**(borrow ⑦ 點名的空缺) |
| 幾何驗證閘(**已有,本輪要用**) | `cadpy.geometry_checks`:`assert_valid_solid` / `assert_all_valid` / `assert_no_interference` / `sweep_interference` / `assert_motion_clear`;lessons L-1~L-4 |

**與 step.parts 分工**:step.parts 給「真實廠商件精確幾何」(authoritative、要連網、覆蓋有限);本計畫給「選型推理 + 沒命中時的代用件」。兩者是 resolver 的兩層(= mech-mcp 的「無卡 fallback」)。

---

## 2. 目標架構:三層 resolver + 一條約束

```
需求(功能件 + 規格條件,例:推力/負載/行程/扭矩)
   ├─ L1  select_<family>(...)   選型推理 → 規格列(尺寸 + source + confidence + margin)
   ├─ L2  resolve(...)           先查 step.parts → 命中用真 STEP(本輪當 agent 決策點,不自動化、不進單元測試)
   └─ L3  <family>(**規格列)      參數化生成簡化代用件,check_geometry 上鎖
結構件(連桿/托架/平台/底座/夾爪) ── 不進此流程,bespoke 生成。
```

**約束規則(寫進 skill 指引,非 runtime 硬鎖)**:功能/驅動/傳動/支撐件**必須**走 `select → generate`,臨界尺寸不得 free-hand;結構件自由生成。靠「明文規則 + select+generate 是阻力最小路徑」落實,別假裝有硬鎖。

---

## 3. 程式落點（本 fork 版:全部收進 `cadpy.parts`,單一同步目標）

> **為何收進 cadpy(而非另開 `cadpy_parts` 輕量包)**:本 fork **無 symlink、複本是獨立實體**,另開新包要再接一整套跨 runtime 鏡像,自主執行極易出錯。`cadpy` 已有**已知的複本同步法**(§3.3),把選型+規格+幾何全放 `cadpy.parts` → **只有一個同步目標**。純選型(無 OCP)若日後出現非-OCP 消費端再抽 `cadpy_parts`(「第二個消費端才抽象」)。

### 3.1 新子模組 `packages/cadpy/src/cadpy/parts/`
```
packages/cadpy/src/cadpy/parts/
  __init__.py            # 匯出 select_* 與各 generator(可 lazy)
  specs_io.py            # load_specs(family) 用 importlib.resources 讀 specs/*.json,UTF-8
  specs/
    cylinders.json
    bearings.json
    linear_guides.json
    ball_screws.json
    motors.json
  select.py              # select_cylinder / select_bearing / select_linear_guide / select_ball_screw / select_stepper
                         #   + NoFittingPart(無解時 raise)、_force(row,pressure,action)(push=全缸徑/pull=環形)住這
  pneumatic_cylinder.py  # 幾何
  deep_groove_bearing.py
  linear_guide.py
  ball_screw.py
  stepper_motor.py
  _common.py             # (Phase 3 出現重複才建)共用幾何/孔位 primitive
```

### 3.2 pyproject 要含新套件 + json 資料
只改**正本** `packages/cadpy/pyproject.toml`(各複本的 pyproject 由 §3.3 的 `sync-vendored.sh` 一併同步,不需手改),確保:
- `tool.setuptools.packages.find` 會收到 `cadpy.parts`、`cadpy.parts.specs`(通常 `cadpy*` 萬用已涵蓋,確認即可)。
- `tool.setuptools.package-data` 含 `cadpy.parts = ["specs/*.json"]`(或 `cadpy = ["parts/specs/*.json"]`)。
- 改完做一次 import 煙霧測試確認 json 讀得到(editable 安裝下 `importlib.resources.files("cadpy.parts.specs")` 應可直接讀源樹)。

### 3.3 複本同步(本 fork 唯一正解:`scripts/dev/sync-vendored.sh`)
`import cadpy` 在本機解析到 pip -e 的 **`skills/cad/scripts/packages/cadpy/src`**(複本),不是 `packages/cadpy/src`(源)。`cadpy` 同檔共 **8 份不同 inode**。流程:
```bash
# 1) 一律先改「源」:packages/cadpy/src/cadpy/parts/...(含 specs/*.json、pyproject.toml)
# 2) 一鍵傳播到全部 7 份 runtime 複本
#    (已測:巢狀新目錄 + json + pyproject 都會傳;含 --delete 語意;
#     套 bundle 同款排除並保護 editable install 的 *.egg-info;白名單只進 skills/ viewer/ plugins/)
bash scripts/dev/sync-vendored.sh            # 寫入傳播
bash scripts/dev/sync-vendored.sh --check    # 只驗漂移(全同步=exit 0;有差列 DRIFT/STALE)
# 不要自己手寫 find|cp 廣域 glob;不要跑 setup-symlinks.sh / bundle.sh(本 fork N/A、缺 rsync)
```
- **⚠️ tests/ 陷阱(本 session 真的踩過)**:`tests/python/packages/cadpy/` 是 **git 追蹤的單元測試目錄**,路徑剛好以 `packages/cadpy` 結尾,**但它不是複本**。新測試檔(§3.4)放這裡是對的,但**絕不可**把套件檔 `cp`/傳播進去。naive 的 `find . -path '*/packages/cadpy/*'` 會誤中它並覆寫測試 → 一律用上面的工具(已白名單擋掉 tests/)。
- **跑測試對到源**:`PYTHONPATH="<repo>;<repo>/packages/cadpy/src" .venv/Scripts/python.exe -m unittest ...`,或「先 `sync-vendored.sh` 全複本再照常跑」(讓複本==源)。最終 gate 用後者,避免源/複本漂移。
- `cadpy` 本身已 `pip install -e`;新增 `cadpy.parts` 是其子模組,**不需**另外 pip 安裝。

### 3.4 消費端與測試落點
```
models/rack_pinion_rotary_actuator/      # Phase 1 接氣缸
models/motorized_linear_stage/           # Phase 3 整合 capstone(新)
tests/python/packages/cadpy/test_parts_select.py     # 各 select_*(純數學,離線)
tests/python/packages/cadpy/test_parts_geometry.py   # 各 generator 幾何 + 運動掃掠
```

---

## 4. 可重複樣板 A–E（定義一次,Phase 1 與 2 都套用）

對「某個 family `<f>`」執行(命名約定:選型用**短名** `select_{cylinder,bearing,linear_guide,ball_screw,stepper}`,
幾何 generator 用**描述名** `{pneumatic_cylinder,deep_groove_bearing,linear_guide,ball_screw,stepper_motor}`;
只有 linear_guide/ball_screw 兩者同名 —— 別把 `select_<f>` 一律展開成 generator 名):

- **A — 規格表 `specs/<f>.json`**:4–6 列代表規格;每列**必含** `source` + `confidence`。schema 見各 family。**驗收**:`json.load` 成功、每列有 source+confidence。
- **B — 選型 `select_<f>(...)`**:依需求算出最小可用標準規格,回傳整列 + 計算 `margin`(報而不擋);無解 `raise NoFittingPart("可讀訊息")`。**驗收**:見 E。
- **C — 幾何 `<f>(**規格列)`**:回傳 labeled build123d `Compound`(簡化代用件:外形包絡 + 安裝介面 + 行程/轉動,不複製廠商實體)。附 `check_geometry(shape)`:`assert_all_valid` + `assert_no_interference(allow=刻意接觸)`;**滑塊/螺帽會在自身軌/桿上行走的件**(滑軌、螺桿)再加 `assert_motion_clear(<f>_poses(...), pairs, baseline=收合pose)` —— 這類掃掠真能抓到「滑出軌/桿」。**氣缸不算**:rod 在 body 內單調伸縮,從收合 baseline 掃出來 excess≤0 恆過、抓不到東西 → 氣缸的運動驗證放在消費它的組合件(P1 rack_pinion 全行程掃掠),不在 standalone。
- **D — 消費**:Phase 1(氣缸)接進 `rack_pinion`;Phase 2 其餘 family **不各自做機構**,消費統一在 Phase 3 capstone 證明(避免無界擴張)。
- **E — 鎖測試**:`test_parts_select.py` 加 known-good(已知需求→預期規格)+ known-bad(無解 raise / pull 用環形面積之類);`test_parts_geometry.py` 加 valid solids + (有運動者)行程零超量穿模 + 一個 known-bad(如尺寸矛盾被擋)。**全部實跑到綠**。

**family gate**(每個 family 的完成判準)= B/C/E 對該 family 的測試全綠,且 `<f>()` 能產出 valid 的示範幾何。

---

## 5. Phase 1 — 樣板證明:氣缸（A–E worked example）+ 接進 rack_pinion

選氣缸打頭陣:兩個現有機構驅動件都是缸 → 馬上有消費端;選型公式最乾淨;ref 已有 `buildCylinder*` 可移植。

**A — `cylinders.json`** 每列 schema:
```jsonc
{ "series":"Airtac SC","model":"SC40","bore":40,"rod_dia":16,"body_dia":52,
  "stroke_min":25,"stroke_max":500,"port":"G1/4","mount":"foot",
  "source":"Airtac SC datasheet (URL)","confidence":"high" }
```
seeds:SC32 / SC40 / SC50 / SC63。查證卡僅供回標 datasheet;查不到的標 `low`+`self-estimate`。

**B — `select_cylinder`**:
```python
def select_cylinder(load_N, *, pressure_bar=6.0, stroke_mm, load_ratio=0.7, action="push"):
    F_req = load_N / load_ratio                              # 需要的「出力能力」
    # 直接用實際出力篩,push/pull 一致。別只用 bore>=bore_req:那對 pull 會選不足
    # (pull 有效面積較小,margin 可能 <1 卻照過,因為 margin 報而不擋)。
    rows = [r for r in load_specs("cylinders")
            if _force(r, pressure_bar, action) >= F_req
            and r["stroke_min"] <= stroke_mm <= r["stroke_max"]]
    if not rows: raise NoFittingPart(...)
    pick = min(rows, key=lambda r: r["bore"])               # 最小可用缸徑
    return {**pick, "selected_for": {"load_N": load_N,
            "margin": _force(pick, pressure_bar, action) / load_N}}
```
`_force(row, pressure, action)` 是**唯一**力模型:push 用全缸徑面積、pull 用環形有效面積(扣活塞桿);選型與 margin 都走它,push/pull 不會兩套面積打架。

**C — `pneumatic_cylinder(bore, stroke, *, extension=0.0, rod_dia=None, body_dia=None, label_prefix="cyl")`**:body 圓柱 + rod 圓柱(伸出 `extension∈[0,stroke]`),labeled `cyl_body`/`cyl_rod`。`check_geometry`:`assert_all_valid` + `assert_no_interference(allow=[("cyl_body","cyl_rod")])`(rod 在 bore 內=刻意接觸)。**standalone 不做 `assert_motion_clear`**:body~rod 只是單調伸縮,從收合 baseline 掃出來 excess≤0 恆過、抓不到東西;氣缸的運動驗證在 D 的 rack_pinion 全行程掃掠(Gate P1)落地。`.step.js` sidecar:`extend∈[0,1]→rod 伸出 = stroke*extend`(照現有模型 sidecar)。

**D — 接 `rack_pinion`**:在該 model 內 `req_stroke=<行程>` → `spec=select_cylinder(load_N=<估計推力>, stroke_mm=req_stroke)` → `cyl=pneumatic_cylinder(bore=spec["bore"], stroke=req_stroke, rod_dia=spec["rod_dia"])`,取代原本硬寫的 cylinder body box。**`stroke` 用實際需求行程,不是 `spec["stroke_max"]`**(stroke_min/max 只是該系列可選範圍、用來篩選型;做出來的件切到應用行程,否則 rod 會超伸破壞 Gate P1 掃掠)。註解記下 model/source/confidence/margin(交接注記)。

**E — 測試**:select known-good/no-fit/pull;geometry valid + `rod_dia≥bore` 被擋(氣缸 standalone **不**測行程穿模 —— 歸 P1 整機掃掠)。

**Gate P1(全綠才進 Phase 2)**:氣缸 family gate 綠 **且** rack_pinion 重生成、**整機 `check_geometry`(含原有 motion sweep)綠** ← 這是 motion-sweep 真正的 dogfood 場景(選出的缸在真機構裡掃掠驗證)。

---

## 6. Phase 2 — 用同一 A–E 補完其餘 family（逐一自驗全綠）

對下列每個 family 跑 §4 的 A–E（消費留到 Phase 3）:

| family | `select_<f>` 依據 | 幾何 `<f>(...)`(簡化代用件) | spec seeds(公稱) | 運動 gate? | known-bad |
|---|---|---|---|---|---|
| `deep_groove_bearing` | 軸徑 → 最小 bore≥軸;有給徑向負載則 C≥需求 | 內圈+外圈兩同心環(留滾道間隙,不畫滾珠) | 608(8/22/7)、6000(10/26/8)、6200(10/30/9)、6204(20/47/14) | 否(靜態) | 軸徑>最大 bore→raise;OD≤bore→擋 |
| `linear_guide` | 負載 → 最小 size 之 C≥需求 | 軌(長稜柱按 width/height 近似)+ 滑塊,滑塊沿軌 `block_pos` | MGN9/MGN12/MGN15/HGH20(rail_width/block 尺寸/C) | **是**:滑塊掃 `0→rail_len−block_len` vs 軌 | `block_pos` 出軌→擋;負載過大→raise |
| `ball_screw` | target_speed→導程需**假設額定轉速**(speed=lead·rpm,select 帶 `rated_rpm=3000` 類常數才確定)、grade(C7/C5)、負載 | 螺桿(簡化為 root/major 圓柱,免螺紋)+ 螺帽(帶孔圓柱),螺帽沿桿 `nut_pos` | 1605(16/5)、1610(16/10)、2005(20/5)、2010(20/10) | **是**:螺帽掃行程 vs 螺桿 | `nut_pos` 出桿→擋;需求速度導程無解→raise |
| `stepper_motor` | 保持扭矩 ≥ 需求 → 最小 NEMA 框/長 | 方形機身(NEMA face)+ 軸圓柱(+前凸緣) | NEMA11(28)、NEMA17(42.3,L34/40/48)、NEMA23(57) | 否(靜態) | 需求扭矩>最大→raise |

每個 family 的 `check_geometry`:`assert_all_valid` + `assert_no_interference`(靜態件);滑軌/螺桿再加 `assert_motion_clear`(掃掠,seated baseline=刻意滑動接觸)。每個 family 的 select + geometry 測試**實跑到綠**。

**Gate P2**:四個 family 的 family gate 全綠。

---

## 7. Phase 3 — 整合 capstone:`models/motorized_linear_stage/`

一次消費 ≥4 個 family,證明它們**能被選出來並組起來且運動不穿模**。拓樸:**馬達 → 聯軸 → 滾珠螺桿(兩端入軸承)→ 螺帽固定於滑座 → 滑座騎兩條線性滑軌**;框架/滑座為結構件(bespoke)。

```python
# 由「滑台需求」反推各件:
stroke, payload_N, target_speed = ...
screw = select_ball_screw(payload_N, travel=stroke, target_speed_mm_s=target_speed, accuracy="C7")
guide = select_linear_guide(payload_N, rail_len=stroke+carriage_len)        # ×2 條
brg   = select_bearing(shaft_dia=screw["root_dia"], radial_load_N=...)      # ×2 端
eff   = 0.9                                                                 # 滾珠螺桿傳動效率(估)
motor = select_stepper(torque_Nm=payload_N*(screw["lead"]/1000.0)/(2*math.pi*eff))  # T=F·lead/(2π·eff);lead mm→m,否則差 1000×
# 各自 generate,接進 AssemblyHelper;框架/滑座 bespoke。
```
- **整機 gate**:`assert_all_valid` + `assert_no_interference(allow=刻意接觸)` + `assert_motion_clear`(滑座 `0→stroke` 全行程,掃 滑座/螺帽 vs 軌/螺桿/軸承/框架,seated baseline)。`.step.js` sidecar:滑座行程參數。
- **重構時機**:若此時 ≥2 個 generator 重複同一 primitive(法蘭/螺栓孔位/凸緣圓柱),**現在**抽進 `cadpy/parts/_common.py`(正當的「第二個消費端」)。同步複本。
- **Gate P3**:capstone `gen_step` 出 STEP、整機 gate 全綠。

---

## 8. Phase 4 — 全域驗證 + 收尾

1. **同步全部 cadpy 複本**:`bash scripts/dev/sync-vendored.sh` 傳播,再 `--check` 驗全同步(§3.3;不要手寫 find|cp)。
2. **跑全套 Python 測試到綠**(實跑、看到 pass):
   `.venv/Scripts/python.exe -m unittest tests/python/packages/cadpy/test_parts_select.py tests/python/packages/cadpy/test_parts_geometry.py`
   + 既有 `tests/python/packages/cadpy/test_geometry_checks.py`;或跑 `scripts/test/test-python.sh`(若在本 fork 可跑)。
3. **runtime 煙霧測試**:用 skill runtime 那份複本 `import cadpy.parts` 並 `select_cylinder(...)`,確認複本也載得到。
4. **文件回填**:`mech-mcp-borrow-analysis.md` 標記 ⑦ 已從 knowledge 升級為可執行;若過程把某缺陷固化成檢查,於 `skills/cad/references/lessons.md` 加 L-5。
5. **分組 commit 到 `開發`**(訊息結尾附 `Co-Authored-By: Claude ...` trailer;**不要 push**):
   - cadpy.parts 骨架 + 氣缸(specs/select/generator/tests)
   - 其餘 family(specs/select/generators/tests)
   - 整合 capstone model + 整機驗證(+ 任何 `_common.py` 重構)
   - 文件回填
   STEP/GLB 走 LFS,確認 commit 後是 LFS pointer(`git show HEAD:<step> | head -1` 應見 `version https://git-lfs...`)。

---

## 9. Definition of Done（全域,逐項機器可檢）

```
[ ] cadpy.parts 子模組就位;pyproject 含 cadpy.parts + specs/*.json package-data;import 煙霧測試過
[ ] 五個 family {cylinder, deep_groove_bearing, linear_guide, ball_screw, stepper_motor} 各有:
      specs/<f>.json(每列 source+confidence)、select_<f>()、generator <f>()
[ ] tests/.../test_parts_select.py:每個 family 的 known-good + known-bad —— 實跑全綠
[ ] tests/.../test_parts_geometry.py:每個 generator valid solids、(滑軌/螺桿)行程零穿模(氣缸行程驗證歸 P1 整機掃掠)—— 實跑全綠
[ ] Phase 1:rack_pinion 改用 select+generate 的缸,整機 check_geometry(含 motion sweep)綠
[ ] Phase 3:models/motorized_linear_stage 消費 ≥4 family,整機 assert_all_valid + no_interference + motion_clear 綠
[ ] 全部改過的 cadpy 複本 cmp -s 一致;runtime 複本 import cadpy.parts 成功
[ ] 既有測試未被打破(test_geometry_checks 等仍綠)
[ ] mech-mcp-borrow-analysis.md ⑦ 標記升級;(如有)lessons L-5
[ ] 分組 commit 到 開發(LFS pointer 正確);未 push
[ ] 全程未碰 main、未跑 symlink/bundle/Release/Deploy、未關 LFS、未宣稱 FEA/公差/認證
```

---

## 10. 風險守則（autonomy-hardened）

1. **別逐型號畫固定 STEP** → 一律 generator + 規格表(每類 4–6 代表規格)。
2. **別複製廠商實體幾何** → 代用件只負責 fit/選型/運動;精確幾何交給 step.parts 真 STEP。
3. **來源誠實**(最易在自主跑時翻車)→ 不把臆測當權威;不確定標 `low`+`self-estimate`;查證卡≠規格卡。
4. **只約束功能/採購件**,結構件自由生成。
5. **沒跑過不准宣稱綠**;每個 gate 實跑看到 pass。
6. **L2 不進單元測試**(連網 flaky);自動 resolver 是後話。
7. **fork 流程**:`開發` 直接 commit、不 PR、不 push、不碰 main;**無 symlink**,複本用 `scripts/dev/sync-vendored.sh` 同步(**不要手寫廣域 find|cp**——會誤覆寫 `tests/python/packages/cadpy/` 測試目錄,見 §3.3 ⚠️),不跑 bundle/symlink/Release;LFS 永不關。
8. **誠實邊界**:選型=幾何/力學初選,margin 報而不擋,不宣稱 FEA/疲勞/公差/認證。

---

## 11. 後續擴充（超出原 5-family 計畫）

- **2026-07-08 — 第 6 個 family:`gripper`(平行氣爪)**。同一 L1/L3 兩層套路:
  - 規格來源:網路搜尋 **AirTAC 亞德克 HFZ** 平行氣爪開放資料(多路搜尋 + 跨來源核對;
    HFZ6…HFZ40 的 bore/總行程/夾持力@0.5 MPa 由 4 個獨立來源一致,標 `med`)。
    `specs/grippers.json` 只存**真實**的 bore/stroke/`gripping_force_N`/`force_pressure_MPa`;
    body 外形不進表,由生成器以 bore/stroke 比例代理(envelope proxy,誠實標註)。
  - `select_gripper(grip_force_N, *, opening_mm, gripper_type="parallel", pressure_MPa=None)`:
    夾持力用**表列值**(非由 bore 計算,因夾持力取決於內部楔/齒條比),氣壓可線性縮放;
    挑 (bore, stroke) 最小滿足者;報 `margin`/`opening_margin`;無解 `NoFittingPart`。
  - 幾何 `gripper(bore, stroke, *, opening, …)`:本體方塊 + 兩指對稱平移(各動 `opening/2`),
    指根座進本體頂面(`body~jaw` 為刻意接觸,兩指恆隔 `min_gap` 不相撞),全開時指不得跑出本體
    (off-body 範圍檢查,類比滑軌 off-rail)。`check_geometry` 上鎖 + 開爪掃掠(honest scope:
    平移不變,close 側靠 `min_gap`、open 側靠範圍檢查)。
  - 消費層(step.parts 真 STEP)仍是 agent 決策點,未自動化。
  - **capstone dogfood(比照其他 family)**:`models/linear_pick_station/linear_pick_station.py`
    ——`select_linear_guide` 選出的滑軌載 `select_gripper` 選出的夾爪,2 DOF(滑座平移 + 夾爪開閉);
    夾爪以微小 bracket 間隙騎在滑塊上(不 allow 結構互穿,守 L-5),`INTENDED_CONTACT` 只有兩對 body~jaw。
    `test_parts_models.py` 新增 `LinearPickStationGateTests`(消費 2 選型 family、整機 `check_geometry`
    含雙掃掠、反 vacuous 位移斷言)。
  - cad-chat 接線:`cad_source_part(family="gripper", {grip_force_N, opening_mm, pressure_MPa?})`
    → `apps/cad-chat/src/server/cad/select_part.py` FN 表 + `tools.mjs`/`prompt.mjs` family 清單。
  - 驗收:`test_parts_{select+8,geometry+5,models+3}` 全綠(80 parts tests);
    `sync-vendored.sh` 傳播 7 份複本;select_part.py 端到端 spawn 驗過;**L4 真互動**——以使用者身分
    Playwright 驅動 cad-chat 跑一輪,agent `cad_source_part`→**HFZ20**、複用 `cadpy.parts.gripper` 產生器
    建模、`cad_validate` 全綠、呈現到畫布(一次自修:把 `INTENDED_CONTACT` 提到模組層,見
    [[cadchat-intended-contact-gate]])。角度型(HFR/HFY)、三爪(HFCY)**刻意不收**(生成器只模平行爪)。
