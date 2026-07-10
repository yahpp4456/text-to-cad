# 計畫:MOTION 支援旋轉關節(URDF-revolute)+ flip_gripper 90° 前傾動畫

> 產出:僅計畫文件,**未執行任何程式**(依使用者指示)。要動手時再說一聲。

## Context

`models/flip_gripper` 的夾爪本應能「90° 前傾翻轉」(垂直取物 → 水平取物),但目前:
- MOTION 契約 v1 **只支援線性(平移)軸**,旋轉翻轉無法宣告成 dof;
- 所以翻轉只寫在 docstring 當「示意」,幾何上從沒 apply、視圖不會動、也沒被掃掠驗證(模型實際就是垂直那顆)。

使用者要**完整的旋轉動畫**,並希望用「機器人 URDF 那種關節方式」表達。結論:一個 URDF revolute joint 本質就是「軸 + pivot + 角度限制」,而 repo 已有原生 `asm.revolute_frame(part, name, axis, angular_range=…)`(rack_pinion 就是這樣記錄擺動軸)。所以本方案把 MOTION 從 v1-線性**加法式擴充**成也支援 `type:"revolute"`,並把前傾做成一個真正的旋轉關節:**視圖動畫 + 幾何掃掠驗證 + STEP 內嵌原生 revolute 關節基準**。角度用 `flip_deg` PARAMS 滑桿、預設 90°。

## 已鎖定決策(使用者確認)

- **範圍**:完整旋轉動畫(視圖真的轉 + 被掃掠),用 URDF-revolute 關節語義表達。
- **角度**:`flip_deg` 扁平 PARAMS 角度滑桿,**預設 90°**,可拉即時重生。
- **靜態建模姿態維持垂直(0°)**:幾何不動,靠 revolute dof 動畫 0→`flip_deg` 來「展現前傾」(比照 rack_pinion 靜態 bake 在 swing=0)。
- **URDF**:用 `revolute_frame` 把關節基準(軸+pivot+limit)嵌進 STEP = URDF-joint 語義;**不預設匯出 `.urdf` 檔**(列為需明確要求才做的後續)。

## 關鍵可行性結論(最大風險,已解掉)

**視圖旋轉可行,且前端只需改 `cadMotion.js` 一支;`packages/cadjs`、`packages/cadpy` 零改動。**

端到端追過:
- `record.effectMatrix` 已是完整 `THREE.Matrix4`(不是位置);`applyDisplayRecordTransform`(`packages/cadjs/src/common/displayRecordTransform.js`)以 `mesh.matrix = effectMatrix · baseMatrix` 同步驅動 mesh+邊線+silhouette。播放器現在只平移,**純粹是因為呼叫 `effectMatrix.makeTranslation(...)`**;換成 `T(+pivot)·R(axis,θ)·T(−pivot)` 即可旋轉。
- **座標系正確**:CAD 組合件 `partTransformsBaked:true` → 每個 record 的 baseMatrix=identity → `mesh.matrix = effectMatrix`,mesh 頂點烘在 STEP world 座標(mm、Z-up),effectMatrix 是該 mesh 的 local 矩陣、在任何 Y-up 顯示群組之下。所以用產生器/STEP 座標表達的 pivot/axis 直接就對。**既有線性 dof 就是用同一個 effectMatrix 幀、axis 用 mm 座標且動畫正常** → 經驗上證實同框。
- 不需 pivot 群組節點、不改 record 結構、不改 viewport;`sample()`/`coverage()`/`reset()` 照舊。

**退路(僅當經驗檢查推翻上述,機率低)**:revolute 降級為「靜態 rest 姿態 + 掃掠驗證、視圖不動畫」,只 gate `cadMotion.js`/`Canvas3D.jsx`,驗證器/產生器不受影響。

## 實作區塊

### A. revolute dof schema(契約)—— 加法式,linear 位元組不變
```
# linear(不變)
{id,label,type:"linear",   axis:[x,y,z], travel:<mm>,   moving:[...],pairs:[...],samples,period_s?}
# revolute(新,URDF 風格)
{id,label,type:"revolute", axis:[x,y,z], pivot:[x,y,z], angle_deg:<deg>, moving:[...],pairs:[...],samples,period_s?}
```
- `angle_deg` 必須引用 `PARAMS["flip_deg"]`(如同 linear `travel` 引用 PARAMS,滑桿重生自動跟上)。
- **schemaVersion 維持 `1`**、以新增 `type:"revolute"` 做向後相容擴充(全 codebase 無任何地方對 motion schemaVersion 分支;只當常數 `1` 寫出於 `validate.py:178,440`、`tools.mjs:286`、`chat.mjs:227`)。舊 linear dof 與舊存檔零改動即相容。

### B. `apps/cad-chat/src/server/cad/validate.py`(spawned Python,免重啟、非 vendored)
1. **型別閘(L106-107)**:改成允許 `type in ("linear","revolute")`;共用 axis parse+normalize;分支——linear 續走 `travel`;revolute 解析 **`pivot`**(3 floats,必填,鏡射既有 origin 解析但必填+驗有限)與 **`angle_deg`**(有限、`1e-3 < |angle| ≤ 3600`)。把 `type/pivot/angle_deg` 併入正規化 dof。
2. **pose 產生器(L269-280)**:依 `dof["type"]` 分支——linear 續走 `translate(dv)`;revolute 走 `base_map[n].rotate(Axis(pivot, axis), u*angle_deg)`(懶載 `from build123d import Axis`;shapes 本就是 build123d 物件,比照 rack_pinion)。合成的 poses 餵既有 `sweep_interference`/baseline(吃任意 poses,已支援)。
3. **hit 標註(L305-309)**:目前算 `u0*dof0['travel']`,revolute 無 `travel` 會 KeyError → 分支用 `angle_deg`、單位「°」。
4. **emit(L438-443)**:每 dof 帶 `type`;linear 帶 axis+travel;revolute 帶 axis+pivot+angle_deg。下游(`tools.mjs`/`chat.mjs`/`project.mjs`/`events.js`/`chatStore.js`)一律 verbatim 轉發 → **新欄位自動抵達 `cadMotion.js`,server `.mjs` 不用改**。
- 自動配對 `_auto_pairs`/`_swept_aabb`(L181-196,L51-58)是線性 AABB,**僅在 dof 未給 pairs 時觸發**;flip_gripper 明給 pairs,故不走此路(建議:revolute 要求明給 pairs)。

### C. `apps/cad-chat/src/lib/cadMotion.js`(前端 HMR)—— 核心改動
把 `apply()`(L47-72)從「每 record 累加 `[x,y,z]` 位移」改成「每 record 累加 `Matrix4`」:
- `offsets`(rec→[x,y,z])→ `recMats`(rec→Matrix4,每幀重置 identity)。
- 每 dof **每幀算一次** frame-matrix `Mi`:
  - linear:`Mi = makeTranslation(axis·u·travel)`。
  - revolute:θ=`u·angle_deg·π/180`;`Mi = T(+pivot)·makeRotationAxis(axisUnit,θ)·T(−pivot)`(defensively 正規化 axis;此式與 `stepModuleEffects.js:75-89` 的 `buildStepModuleRotateMatrix` 同型、已驗)。
  - 每個 moving label 的 records:`recMat.premultiply(Mi)`。
- 收尾:`rec.effectMatrix = recMat.clone(); applyDisplayRecordTransform(THREE, rec)`。
- **Ride-along/合成順序**:依宣告順序 `premultiply` → 後宣告者在外層。產生器**必須把 revolute flip dof 宣告在線性爪合 dof 之後** → 被爪合+翻轉共同影響的爪 record 得到 `R_flip·T_jaw`(先在 rest 幀爪合、再整組繞軸翻轉),物理正確。
- `coverage()`/`reset()` 不變;`sample()` 自動反映旋轉矩陣元素(測試用)。新增 `matrixFor(label)` 回傳具名 record 的 `effectMatrix.elements`(測試斷言用)。

### D. `models/flip_gripper/flip_gripper.py`(改後以 `scripts/step` 重生)
1. **加 `flip_deg` PARAM**(L29-50),預設 `90.0`(唯一非 mm 參數,註解標明)。
2. **靜態姿態維持垂直**——幾何 builder 不動,STEP bake 在 rest(比照 rack_pinion `pose(0.0)`)。
3. **加 revolute dof**(宣告在兩個線性爪合 dof **之後**)到 `MOTION.dofs`:
   `{id:"flip", label:"90° 前傾翻轉", type:"revolute", axis:[0,1,0], pivot:[0,0,_levels()["z_axis"]], angle_deg:PARAMS["flip_deg"], moving:["rotary_hub","swing_bracket","gripper_body","jaw_left","jaw_right","finger_left","finger_right"], pairs:[["swing_bracket","rotary_body"],["swing_bracket","arm_flange"],["gripper_body","rotary_body"],["gripper_body","arm_flange"],["finger_left","rotary_body"],["finger_right","rotary_body"],["jaw_left","rotary_body"],["jaw_right","rotary_body"]], samples:24}`
   - `pivot` 由 `_levels()["z_axis"]`(=−31.0)算,隨 `flange_t`/`rotary_h` 連動;`rotary_hub` 與軸同軸,旋轉為 no-op(無害,列入以符合關節成員完整性);`samples:24`(90° 弧需較密取樣抓中程最深穿透)。
4. **`gen_step()` 加原生關節基準**:`hub = asm.add(_rotary_hub(),"rotary_hub")` 後 `asm.revolute_frame(hub,"flip_axis",Axis((0,0,z_axis),(0,1,0)),angular_range=(0.0,PARAMS["flip_deg"]))`(`Axis` 已 import;`revolute_frame` 把 axis+pivot+limit 嵌進 STEP,= URDF joint 語義)。
5. **`check_geometry` 維持只做靜態**(**不加** `assert_motion_clear`)。這是與 rack_pinion 的刻意分歧且正確:rack_pinion 無 MOTION，其唯一掃掠家在 check_geometry;flip_gripper **有 MOTION** → flip 掃掠已由 cad-chat harness 的 `validate.py` 在 `cad_validate` 跑。`generation.py` 每次寫 STEP 前都跑 check_geometry,若在此加掃掠會讓每次重生的 build 時間翻倍(契約明文禁止)。可選:加 `if __name__=="__main__":` 自測跑 flip poses 的 `sweep_interference`(比照 rack_pinion),供隨需驗證而不拖累 `scripts/step`。

### E. `apps/cad-chat/src/server/agent/prompt.mjs`(server `.mjs`,**需重啟**)
MOTION 段(L65-82)精簡改:
- 規則「v1 僅 linear」→「支援 `linear` 與 `revolute`(URDF 關節:軸+pivot+角度限制);1–8 DOF」。
- 加一行 revolute 範例(`{id:"flip",type:"revolute",axis:[0,1,0],pivot:[0,0,-31.0],angle_deg:PARAMS["flip_deg"],moving:[...],pairs:[...],samples:24}`)。
- 加指引:旋轉/翻轉/鉸鏈用 `revolute`;`angle_deg` 必引用 PARAMS;**revolute dof 宣告在它所承載的線性 dof 之後**(ride-along 讓翻轉在外層);revolute 應明給 `pairs`。保留「check_geometry 不必自呼叫 assert_motion_clear」(現也涵蓋 revolute)。他處收斂字數以控長度。

### F.(可選)`pipeline.mjs` `paramDefsFromGenerator`(L343-378,server `.mjs`,重啟)
決定性滑桿會把 `flip_deg=90` 當 `mm`、step 1、min 36、max 225(到不了 0°)。小增強:角度鍵以字尾偵測(`/_(deg|ang|angle)$/`)→ `{unit:"°",min:0,max:180,step:1,value}`。可選;agent 的 `emit_params` 亦可覆寫。

## 變更面 / blast radius

| 檔 | 類型 | 生效 | vendored? |
|---|---|---|---|
| `src/lib/cadMotion.js` | 前端 | Vite HMR | — |
| `src/server/cad/validate.py` | spawned Python | 免重啟(每次 cad_validate 重 spawn) | 否(cad-chat 本地,非 cadpy) |
| `src/server/agent/prompt.mjs` | server `.mjs` | **重啟** | — |
| `models/flip_gripper/flip_gripper.py` | 模型產生器 | `scripts/step` 重生 | — |
| `src/components/canvas/Canvas3D.jsx`(僅 dev 鉤) | 前端 | Vite HMR | — |
| `pipeline.mjs`(可選 `_deg` 啟發式) | server `.mjs` | **重啟** | — |

**`packages/cadpy` 與 `packages/cadjs` 皆不動 → 不需 `sync-vendored.sh`。** 掃掠引擎、`revolute_frame`、effect-matrix 管線都已具備所需能力。

## 風險 / 邊界

| # | 風險 | 緩解 |
|---|---|---|
| **R1** | **翻轉中托架掃過 rotary_body/arm_flange(此幾何從沒被掃過)** | 這正是掃掠該抓的。**預期第一次會紅**:`swing_bracket` 的底 `plate`(L130)/垂直 `arm`(L128)繞 (0,·,−31) 掃出的環與 body 下外緣重疊。**先用 validate.py 預跑**、就地改托架(縮短/改形讓 90° 全程淨空,例如把載重路徑留在 pivot 的 +Y 側)再掃;或依 repo 誠實原則縮小範圍並如實回報。pivot 區既有接觸(`rotary_hub~rotary_body` 等,已在 INTENDED_CONTACT)當 baseline 隨行、不被 flag。 |
| R2 | 座標系(產生器 STEP vs GLB/three) | 已解:partTransformsBaked → effectMatrix 在 STEP mm/Z-up 幀作用,pivot/axis 同框;既有線性 dof 經驗證實。加一條 L1/L3 斷言(轉 finger_left,查矩陣≠純平移、已知角點落點正確)。 |
| R3 | ride-along 順序(爪合+翻轉) | 宣告序 `premultiply`、revolute 宣告在最後 → `R_flip·T_jaw`。由產生器 dof 順序 + prompt 文件強制。 |
| R4 | schemaVersion 相容 | 停在 `1`、加法式 `type`;linear 與舊存檔位元組不變。 |
| R5 | 舊 flip_gripper.step/GLB 重生 | `scripts/step --force` 決定性重生;靜態姿態不變 → topology/asm.json 穩定(爪 label 不動),只加 MOTION/關節基準。 |
| R6 | revolute 未給 pairs 會誤觸線性 auto-pair | flip_gripper 明給 pairs;建議 revolute 強制要 pairs。 |
| R7 | validate.py hit 標註對 revolute KeyError | L305-309 分支用 `angle_deg`/「°」。 |
| R8 | 每 dof 獨立掃(其餘 seated),前端才合成 | 可接受、與現有線性行為一致;記住「驗證逐 dof、動畫合成」的不對稱。 |
| R9 | `flip_deg` 滑桿顯示 mm、到不了 0° | 可選 `_deg` 啟發式(F),或 `emit_params` 覆寫。 |
| R10 | samples 太低漏中程最深穿透 | 90° revolute 用 `samples:24`(驗證器上限 24、Σpairs·samples≤600)。 |

## 測試(cad-chat-verify 分層)

- **L1 單元(免 LLM)**:
  - **新 JS `src/lib/cadMotion.test.js`**(進 `node --test src/lib/*.test.js`):載真 `three`;假 `model.displayRecords`;餵 revolute dof(axis[0,1,0]、pivot[0,0,−31]、angle_deg 90)於 u=1 相位;斷言 record 的 `effectMatrix` = `T·R·T`(rest 點映到解析旋轉點)且**非純平移**;加 ride-along(`[jl,flip]`)案例斷 `R_flip·T_jaw` 順序。
  - **新 Python 測 `validate.py`**:假模組帶 revolute MOTION 於兩個小 build123d 件;斷 `_read_motion` **接受**並正規化(type/pivot/angle_deg);斷**拒絕** revolute 缺 pivot/angle/壞 axis;跑 `_run_motion_sweep` 斷旋轉 poses 有跑(乾淨案例 ok、故意干涉案例被 flag);斷 linear 路徑未變(回歸)。
- **L3 煙測(真瀏覽器 + dev 鉤)**:載 flip_gripper(`?glb=…&name=flip_gripper&motion=<json>` 或開專案),按「▶ 運動示意」,以 `window.__cadMotion` 斷旋轉:`coverage()===1`(7 個 label 全對上)、`sample()` 含旋轉塊≠identity 的矩陣。**新 dev 鉤**(Canvas3D.jsx dev 區 L182-203):`__cadMotion.applyAt(tSec)`(定時套用去 flake)、`__cadMotion.matrixFor(label)`(斷 finger_left 峰值轉 ~90°)。重生後 stat 產物(`flip_gripper.step` 開頭 `ISO-10303-21`、`.flip_gripper.step.glb` size>0)、`cad_validate` JSON 顯示 `motion_sweep` 檢查在(pass 或 R1 的誠實 fail)。
- **L4(可選、gated)**:一輪讓 agent 依新契約寫 revolute dof,驗契約可讀;L1-L3 綠後才跑。

## 分層驗證 & 重生步驟(**先預跑模型,再碰 server**)

1. **預跑(免 server、最快、R1 在此現形)**——repo 根:
   - 重生:`PYTHONUTF8=1 .venv/Scripts/python.exe skills/cad/scripts/step models/flip_gripper/flip_gripper.py --force`(寫 STEP+隱藏 GLB+topology;寫前跑靜態 check_geometry)。
   - 掃掠:`PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/src/server/cad/validate.py models/flip_gripper/flip_gripper.py`(印 JSON 含 revolute `motion_sweep`)。**在此反覆改幾何直到 flip 淨空**,再動任何 server 檔。
2. **L0 build**:`npm --prefix apps/cad-chat run build`。
3. **L1 單元**:`cd apps/cad-chat && node --test src/server/*.test.js src/server/cad/*.test.js src/lib/*.test.js` + 新 Python 測。
4. **重啟 dev server**(prompt.mjs / 可選 pipeline.mjs 是 `.mjs`,零 HMR):`cd apps/cad-chat && npm run dev`。`cadMotion.js`/`Canvas3D.jsx` 前端 → Vite HMR 免重啟。
5. **L3 煙測**:`PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/smoke/run_all.py`(新 `smoke_*.py` 掛進 `ORDER`);dev 鉤斷旋轉;stat 重生產物。
6. **不需 sync-vendored**(cadpy/cadjs 未動)。
7. **L4(可選)**;完成後同步 `apps/cad-chat/README.md` MOTION 段與(若加 dev 鉤)cad-chat-verify skill。

## 待改/新增檔案
- `apps/cad-chat/src/lib/cadMotion.js` — 平移改 `T·R·T` 矩陣合成(核心旋轉)。
- `apps/cad-chat/src/server/cad/validate.py` — revolute schema 接受/驗證、旋轉 pose 分支、emit + hit 標註。
- `models/flip_gripper/flip_gripper.py` — `flip_deg` PARAM、revolute dof(宣告最後)、`revolute_frame` 基準;靜態姿態不變。
- `apps/cad-chat/src/server/agent/prompt.mjs` — MOTION 契約擴充 linear+revolute（含範例與宣告順序規則）。
- `apps/cad-chat/src/components/canvas/Canvas3D.jsx` — 新 dev 鉤（`__cadMotion.applyAt`/`matrixFor`）供 L3 確定性斷言。
- 新測:`apps/cad-chat/src/lib/cadMotion.test.js`、`validate.py` 的 Python 測、（可選）新 `smoke_*.py`。
- （可選）`pipeline.mjs` 角度滑桿啟發式；文件 `README.md`。

## 明確非目標
- 不預設匯出 `.urdf`(關節語義已嵌在 STEP 的 revolute_frame);要真 URDF 檔再走 repo 的 URDF skill,另議。
- 不改 `packages/cadpy` / `packages/cadjs`。
- 不 commit(fork 硬規則,除非明確要求)。

---
**狀態:計畫已完成、未執行。** 要動手就說一聲;實作會先做「預跑」抓 R1(托架掃掠很可能需要一次幾何微調),再依上述分層驗證推進。
