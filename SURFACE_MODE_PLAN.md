# ChatCAD 第五聊天模式:「曲面」(Alias 式曲面產品設計)

狀態:計畫(未實作)。對應分支 `claude/add-surface-rendering-ot4rtz`;實作時照
根 `CLAUDE.md` 在 `開發` 分支進行。

## 摘要

- 在 Header 切換器新增「**曲面**」模式(`mode: "surface"`),與「設計 / 草模 /
  零件庫 / 無塵電纜」並列。定位:**Alias 式的曲面產品設計**——以曲線建曲面
  (放樣、掃掠、邊界補面、旋轉/拉伸)、把曲面縫成殼或加厚成實體,並提供
  A 級曲面的分析顯示(斑馬紋、曲率雲圖、G0/G1/G2 連續性著色、曲率梳、控制點籠)。
- 架構走本 fork 既有的「**AI 出草稿 → 使用者在視圖編輯 → 確認後決定性生成**」
  路線(同 `SWEEP_WORKBENCH_PLAN.md`):agent 只產 `surface-draft-v1` JSON,
  **不手寫 build123d**;後端把 JSON 編譯成固定格式的 build123d generator,沿用
  既有 STEP/GLB、版本、匯出閘流程。kernel 的坑(OCCT 補面退化、放樣扭轉、縫合
  公差)全部收在 `cadpy.surface` API 的建構保證裡,不交給 LLM 猜。
- 曲面模式是「設計鏈特化」(`isDesignLike("surface") === true`,同 cable):
  版本時間軸、匯出 STEP、就地儲存、精算全開;差別在工具集、prompt、驗證剖面
  (開放殼不做體積/干涉檢查,改做連續性報告)與視圖分析模式。

## 現況盤點(計畫依據)

| 已有 | 位置 | 對本計畫的意義 |
|---|---|---|
| 每面 `surfaceType`(含 `bsplinesurface`/`beziersurface`)與 `params` | `packages/cadpy/src/cadpy/step_scene.py:420-460`、`:1792-1807` | 面層級中繼已進 GLB topology,分析面板可直接讀 |
| 邊連續性已**量測**:宣告值 `BRep_Tool.Continuity_s` + 沿邊取樣法向二面角,分類成 `sampled_tangent`/`sampled_hard`/`c0`…(演算法標籤 `oc-brep-continuity-v1`);edge row 已帶 `continuity`、`dihedralDeg`,屬性抽屜已顯示「連續性」 | `step_scene.py:614-726`、`glb_topology.py:16`、`src/lib/cadTopology.js:333` | G1 判定已落地;只缺 G2(曲率跨邊跳變)取樣與等級化 |
| `BRepLProp_SLProps` 已 import(目前只取法向,階數 1) | `step_scene.py:22`、`:637` | 升階數到 2 即得主曲率/高斯/平均曲率 |
| GLB 自訂頂點屬性先例 `_CAD_EDGE_BARYCENTRIC`/`_CAD_EDGE_CLASS` | `glb_topology.py:20-21`、`cadScene.js:227-256` | 新增 `_CAD_CURVATURE` 有現成寫入/讀取路徑可照抄 |
| B-spline 面的 `params` 只記 `uClosed/vClosed` | `step_scene.py:447` | 要補 degree/極點數/有理與否 |
| 網格密度在 `mesh_step_scene` 決定(adaptive 剖面 extra-fine 0.006/0.2 … large-topology 0.025/0.75);GLB 匯出**忽略** deflection 參數、重用場景三角化 | `step_scene.py:1408-1424`、`:1593-1634`、`glb.py:60-73` | 曲面模式要細網格,得在 mesh 階段(`scripts/step` 的 mesh-tolerance 旗標)下手,不是 GLB 端 |
| `skills/cad/SKILL.md:34`:預設封閉實體,「除非使用者要求曲面或構造幾何」 | `skills/cad/SKILL.md` | 曲面產物在 skill 契約內本就允許,不違反既有規範 |
| GLB 邊分類著色 shader(feature/tangent/seam/degenerate) | `packages/cadjs/src/common/cadScene.js:67-70`、`:408-460` | 連續性著色只需擴充分類與 uniform,不必新寫 material |
| `MeshPhysicalMaterial` + `onBeforeCompile` 鉤 | `cadScene.js:408`、`stageTheme.js:516` | 斑馬紋/曲率雲圖以同一鉤注入 fragment 片段 |
| 幾何掃出家族 + 路徑 overlay sidecar 全鏈 | `cadpy/parts/sweep.py`、README「路徑掃出」節 | 曲面 sidecar(`.{name}.surface.json`)完全鏡射 `sweepPathsUrl` 的全鏈模式 |
| 掃出工作窗(live 2D 預覽鏡射 Python 取樣 + golden;**NumberField 輸入,無拖曳**) | `src/lib/sweepView.js`、`SweepWindow.jsx` | live/baked 雙層與 golden 測試模式照抄;控制點拖曳是新機制 |
| `SWEEP_WORKBENCH_PLAN.md` 的草稿/revision/拖曳工作台 | repo 根(**未實作**:無 `sweep-draft`、`sweep_present_draft`、`SweepWorkbench`) | 本計畫先把「草稿 revision 合併 + 3D 拖曳把手」做成共用基礎,掃出工作台日後重用 |
| 無塵電纜工作台(零 LLM:範本 → 填規格 → 直接生成) | README「無塵電纜工作台」節 | 「確認生成」零回合、`JSON 相容宣告` 嵌 generator 的做法沿用 |
| mode 白名單/選路三處(prompt、工具集、allowed) | `src/lib/chatModes.js`、`agent/runner.mjs:84-92`、`middleware/chat.mjs` | 新 mode 的撞面清單 |
| `BRepCheck_Analyzer` 對任意 shape 有效 | `cadpy/geometry_checks.py:97` | 開放殼也能過「有效性」檢查,不必硬湊實體 |
| 無 | `skills/cad/references/build123d-modeling.md` 零曲面段落 | 現有 prompt/教學完全沒有曲面建模知識,本模式不能靠 design prompt |

## 功能範圍

### v1 納入

- **曲線**:3D 多點插值樣條(可指定端點切線)、控制點 NURBS(度數 2/3,含權重)、
  Bézier、直線、三點圓弧;曲線可標 `plane` 讓工作窗在該平面上拖曳。
- **曲面**:
  - 放樣 `loft`(N 條截面曲線;`ruled` 或平滑;可選首尾切線約束)
  - 掃掠 `sweep`(單輪廓 + 單軌道;選配 1 條導引軌 auxiliary spine)
  - 旋轉 `revolve`、拉伸 `extrude`
  - 邊界補面 `patch`(2–4 條邊,逐邊指定對鄰面 G0/G1/G2 連續;內部可加通過點)
  - 直紋面 `ruled`(兩曲線)
- **操作**:鏡射 `mirror`(對稱產品的一半建模)、縫合 `sew`(面集合 → 殼)、
  加厚 `thicken`(殼 → 實體,指定方向與厚度)、定半徑圓角 `fillet`(實體邊)。
- **分析**(視圖內即時、免 LLM):
  - 斑馬紋(反射線)、曲率雲圖(高斯/平均/最大主曲率,色階可調範圍)
  - 邊連續性著色(G0 紅 / G1 黃 / G2 綠;量測值:法向夾角、曲率跳變)
  - 選取曲線的曲率梳
  - 控制點籠(曲線控制多邊形;曲面極點網,唯讀)、等參線
- **產物**:STEP(殼或實體)+ GLB + 曲面分析 sidecar;既有版本/回退/匯出/儲存。

### v1 刻意不做(排後續版)

- 曲面–曲面相交裁切、偏移曲面、變半徑圓角、雙導軌掃掠、G3。
- 曲面極點直接拖曳即時重算(kernel 冷啟 ~16 s,無法逐幀;v1 只拖曲線控制點,
  曲面重算在「確認」時發生)。
- 對掃描網格的偏差分析(Alias 的 deviation);2D 工程圖;草模/零件庫互轉。

## 主要實作

### 階段 0:kernel 能力探針(先於一切,Windows 機 `.venv` 上跑)

本 cloud 容器無 build123d/OCP,探針必須在本機跑。目的:釘死 build123d 0.11 /
OCP 7.8 下每個運算的**可用 API 與已知陷阱**,寫成 `cadpy.surface` 的建構保證。

- 新模組 `packages/cadpy/src/cadpy/surface/`(OCP 依賴,與 `parts/` 同層):
  - `curves.py`:`spline_through(points, tangents?)`、`nurbs(poles, degree, weights?, knots?)`
    (`Edge.make_spline` / `Geom_BSplineCurve`)、Bézier、圓弧。
  - `surfaces.py`:`loft(curves, ruled, continuity)`(`BRepOffsetAPI_ThruSections`
    + `SetContinuity`/`CheckCompatibility`)、`sweep(profile, rail, guide?)`
    (`BRepOffsetAPI_MakePipeShell`,導軌走 `SetMode(aux spine)`)、
    `patch(edges, constraints)`(`BRepOffsetAPI_MakeFilling.Add(edge, support_face, GeomAbs_C1/C2)`;
    這是 OCCT 唯一能給 G1/G2 邊界約束的補面器,v1 的「對鄰面相切/曲率連續」全靠它)、
    `ruled`、`revolve`、`extrude`。
  - `ops.py`:`sew(faces, tol)`(`BRepBuilderAPI_Sewing`,回殼 + 自由邊清單)、
    `thicken(shell, t, dir)`(`BRepOffsetAPI_MakeThickSolid` / build123d `thicken`)、
    `mirror`、`fillet`。
  - `analysis.py`:`face_curvature_at_nodes(face)`(三角化 UV 節點上 `BRepLProp_SLProps(…, 2, tol)`
    的 `GaussianCurvature/MeanCurvature/MinCurvature/MaxCurvature`,**與 GLB 頂點對齊**)、
    `edge_continuity(edge, faceA, faceB)`(沿邊 N 點取樣:法向夾角 → G1;邊法向方向的
    法曲率差 → G2;回 `{declared, measured: {g1_deg_max, g2_jump_max}, grade}`)、
    `curve_comb(edge, n)`(`BRepLProp_CLProps` 曲率 + 法向)、`control_cage(face|edge)`
    (`Geom_BSplineSurface.Poles()` 網格)。
- 每個運算配 **must-FAIL 負案例**(`tests/python/packages/cadpy/test_surface_*.py`):
  放樣截面方向不一致(扭轉)、補面邊不閉合、縫合公差過小留自由邊、加厚方向使面
  自交——API 必須在建構時 `ValueError`,不能交給 BRepCheck(與掃出家族教訓一致:
  BRepCheck 對這些垃圾判 valid)。
- 探針報告寫進 `skills/cad/references/surface-modeling.md`(新):每運算的 API、
  陷阱、公差建議;這份也是 prompt 的教學來源。
- 動 cadpy 正本 → `scripts/dev/sync-vendored.sh` 同步 8 份複本(fork 無 symlink)。

### 階段 1:schema、編譯器、mode 接線、端點、工具

**資料契約 `surface-draft-v1`**(單一真相源 `apps/cad-chat/src/lib/surface/surfaceSchema.js`,
零依賴、前後端共用、**禁 import three**,同草模 `sketchSchema.js` 規矩):

```json
{
  "schemaVersion": 1, "unit": "mm", "revision": 7,
  "curves":   [{ "id": "c1", "kind": "spline", "points": [[0,0,0],[40,10,0]], "tangents": {"start":[1,0,0]}, "plane": "XY" }],
  "surfaces": [{ "id": "s1", "op": "loft", "sections": ["c1","c2","c3"], "ruled": false },
               { "id": "s2", "op": "patch", "edges": ["s1#e3","c4","c5"], "continuity": {"s1#e3": "G2"} }],
  "ops":      [{ "op": "mirror", "of": ["s1","s2"], "plane": "XZ" },
               { "op": "sew", "tol": 0.01 }, { "op": "thicken", "t": 2.0, "dir": "inward" }],
  "analysis": { "zebra": true, "curvature": "gauss", "continuity": true }
}
```

- `normalize`/`validate` 回 `errors[{path,message}]`(供 agent 自修 ≤3 次,同 `sketch_present`);
  局部合併(`patch` 語意)+ `revision` 單調遞增 + base revision 衝突 409(同 sweep 草稿)。
- **編譯器** `src/server/cad/surfaceGen.mjs`:草稿 → 固定格式 build123d generator
  `.py`,頂部嵌 `SURFACE_SPEC = {…}`(JSON 相容宣告,`readFlatJsonDecl` 可讀,
  文法同 `CABLE_SPEC`:雙引號、無 True/False/None、收尾 `}` 頂 0 欄),主體只呼叫
  `cadpy.surface.*`,`gen_step()` 回殼或實體;模組層 `SURFACE_VIEW`(曲線取樣、
  控制點)供 sidecar 收割。`PARAMS` 只放純量(厚度、圓角半徑、旋轉角)——控制點
  不進滑桿。重開專案與回退靠嵌入的 spec 重現(同 sweep 的「generator 內嵌正規化 spec」)。
- **mode 撞面**(照零件庫模式落地時的清單逐項做):
  - `chatModes.js`:`MODES` 加 `surface`、`MODE_LABELS.surface="曲面"`、
    `isDesignLike` 納入 surface;grep 確認無 `=== "sketch" ? … : "design"` 三元式殘留。
  - `runner.mjs`:第四路 `buildSurfaceServer` / `SURFACE_ALLOWED` / `buildSurfaceSystemPrompt`;
    lessons digest **不注入**(現有教訓全是實體建模語彙)。
  - `chat.mjs` `resolveTurnMode`、`sessions.mjs` persist/hydrate(產物守衛認 `.py` +
    `SURFACE_SPEC`)、`project.mjs` `rejectNonDesignSession`(surface 屬 design-like,自然放行)、
    `ModeSwitch`/`StageStepper`(4 段:曲線 → 曲面 → 縫合/加厚 → 分析)、
    空狀態文案、`DEMO_HIDDEN_MODES` 不動(曲面對 demo 開放)。
- **端點**(`middleware/project.mjs` 或新 `middleware/surface.mjs`):
  - `GET /api/surface-draft?id=` 讀草稿;`POST /api/surface-draft` 保存/捨棄(revision 衝突 409)。
  - `POST /api/surface-build`:驗證完整草稿 → 編譯 → `buildOrRollback`(交易式,失敗
    不新增版本)→ 既有 `version`/`present` 事件。零 LLM。
  - `POST /api/surface-analyze {sessionId, ver?}`:對現版 STEP 跑分析 sidecar(建模時
    已順產;此端點供「只改分析設定」零重建)。
  - 既有 export/validate/save-project 對 surface session 放行;`/api/validate` 走
    **曲面驗證剖面**(見階段 2)。
- **agent 工具**(`agent/tools.surface.mjs`;白名單 = 共用 emit 4 工具 + 下列 +
  Read/Glob/Grep 受 `readScope` 閘):
  - `surface_get_draft`:讀目前草稿(含分析摘要,讓 agent 看得到連續性等級)。
  - `surface_present_draft`:建立/局部更新草稿,驗證後發 `surface_draft` SSE 事件
    (**不建模**);半完成(只有曲線)允許,分兩回合補曲面。
  - `surface_build`:等價 `/api/surface-build`(agent 在使用者明說「直接生成」時用)。
  - `surface_report`:讀最新分析 sidecar 回 `{faces:[{id,type,degree,kmax}], edges:[{id,grade,g1_deg,g2_jump}], freeEdges}`,
    讓 agent 以數字回答「哪條邊不相切」。
  - **無 `cad_build`/`cad_edit`**:agent 不能繞過編譯器手寫 build123d。
- **prompt** `agent/prompt.surface.mjs`:語言契約段照抄(英文思考、繁中輸出);對外
  措辭沿用 `wording.mjs`(禁內部詞);教學=`surface-modeling.md` 精簡版 + 契約範例
  (由 `prompt.surface.test.js` 以真 validator 鎖住防漂移);規則:拓撲級不確定
  (對稱與否、開放殼或實體、哪些邊要 G2)→ `emit_clarify` 一次問齊;尺寸類不問。

### 階段 2:分析 sidecar 與曲面驗證剖面(Python 端)

- 建模 sidecar `.{name}.surface.json`(`_harvest_build_meta` 收割 `SURFACE_VIEW` +
  `cadpy.surface.analysis` 現算),`surfaceUrl` **完全鏡射 `sweepPathsUrl` 全鏈**:
  快照凍結清單、project revert 複回清單、`emitPresent`、version/present 事件、
  events/chatStore、App.jsx openProject/revert 兩處手組 PRESENT——漏一處跨切版/重整即失效。
  內容:`curves`(取樣折線 + 控制多邊形)、`faces`(ordinal ↔ 草稿 id、type、degree、
  極點網、曲率統計)、`edges`(連續性量測與等級、自由邊)、`combs`(每曲線曲率梳向量)。
- **每頂點曲率**:走 GLB 自訂頂點屬性 `_CAD_CURVATURE`(vec4:gauss/mean/kmin/kmax),
  照 `_CAD_EDGE_BARYCENTRIC`/`_CAD_EDGE_CLASS` 的寫入/讀取路徑,**只在 `--curvature`
  旗標下寫**(`cadpy.glb_topology` 加選配;預設路徑零改動,其他模式/viewer 不受影響)。
  選此而非 sidecar 陣列:shader 要逐頂點取值,sidecar 對齊三角化節點順序脆弱。
  曲率在 `_extract_face_geometry` 取節點時以 UV 節點(`triangulation.UVNode`)現算。
- **邊等級化**:`_classify_edge` 在既有 `sampled_tangent` 之上加曲率跨邊取樣
  (邊法向方向的法曲率差,門檻由階段 0 golden 釘)→ 新類別 `sampled_curvature`
  (G2);`_CAD_EDGE_CLASS` 加一個值,cadjs 對未知類別退 `feature`(additive)。
- **網格密度**:曲面 build 以 `scripts/step` 的 mesh-tolerance 旗標指定 extra-fine
  以下(建議 0.004/0.15);GLB 端不改。
- **曲面驗證剖面**(`validate.py` 依 `SURFACE_SPEC` 存在分流):`valid_shape`
  (BRepCheck,殼/實體皆可)、`free_edges`(殼允許自由邊但列數量與長度;若草稿
  宣告 `thicken` 則必為 0)、`continuity`(每條內邊達到草稿宣告等級,未達列出)、
  `self_intersection` 誠實 skipped;**跳過**干涉/體積/MOTION 掃掠。快路徑文案與
  `designChecksFromMeta` 逐字同步(既有兩處同步規矩)。
- 曲面 STEP 匯出:`step_export` 對殼產物確認寫出 `SHELL_BASED_SURFACE_MODEL`
  (OCCT 預設可寫;探針階段驗證 Fusion/SolidWorks 可讀)。

### 階段 3:視圖分析模式(cadjs 正本 + cad-chat 接線)

- `packages/cadjs/src/common/cadScene.js`(非 React、可重用):
  - 顯示模式枚舉 `surfaceAnalysis: "none" | "zebra" | "curvature" | "continuity"`,
    透過既有 `onBeforeCompile` 鉤在 fragment 注入:
    - 斑馬紋:`reflect(viewDir, normal)` 在固定反射方向上的條紋(`sin` 條數/角度 uniform);
    - 曲率雲圖:讀 `_CAD_CURVATURE` 屬性,選通道 + `[min,max]` 色階(屬性缺省時退灰);
    - 連續性:擴充邊分類 `feature/tangent/seam/degenerate` → 加 `g2`(對應 python 的
      `sampled_curvature`),`tangent`=僅 G1;三色 uniform 走既有 class color 機制。
  - overlay 群組:`controlCage`(極點網 LineSegments)、`isoparms`、`combs`
    (`depthTest:false`,仿 `sweepGroup`)。
  - 改正本後**手動同步 `viewer/packages/cadjs`**(sync-vendored 刻意不管 JS)+
    `npm --prefix packages/cadjs test`。
- cad-chat:`useCadViewport` 新 opts(`surfaceAnalysis`、`surfaceOverlay`),Canvas3D
  上方 chips:斑馬 / 曲率 / 連續性 / 控制點 / 等參線 / 曲率梳;屬性抽屜面列
  `surfaceType`、degree、曲率範圍;邊列連續性等級與量測值;dev 鉤
  `window.__cadSurface`(`mode()/edgeGrades()/cageCount()/combCount()`)。
- 面/邊點選沿用 GLB 內嵌 STEP topology(零新機制);「帶入對話」送 `#f/#e` token,
  agent 用 `surface_report` 查該邊等級。

### 階段 4:曲面工作窗(SurfaceWindow)

- 收到 `surface_draft` 事件 → Canvas3D 疊 `SurfaceWindow`(浮動,仿 `SweepWindow`):
  - 左:特徵樹(曲線 → 曲面 → 操作),點選高亮對應 overlay;每曲線可切 spline/NURBS/
    Bézier、改點數、端點切線、所在平面;每曲面可改類型參數與逐邊連續性目標。
  - 右:3D 上拖曳曲線控制點(在曲線 `plane` 上拖,第三軸數值欄調;透視/XY/XZ/YZ
    視角切換)。拖曳把手是**新機制**(`src/lib/draft/dragHandles.js`:raycast 到工作
    平面、吸附格點、`__cadDraft` dev 鉤),草稿 revision 合併也抽成共用
    `src/lib/draft/revision.js`——兩者設計成 `SWEEP_WORKBENCH_PLAN.md` 日後可直接重用;
    NumberField 精確輸入;**live 層**=
    JS 現算曲線(de Boor 求值,`src/lib/surface/nurbsEval.js`,零 three)+ 放樣/直紋
    的粗略蒙皮預覽網格(僅示意;真曲面以 baked GLB 為準,UI 標示「預覽」);
    **baked 層**=最近一次 build 的 GLB。
  - 動作:新增/刪除、復原/重做、重設為 AI 草稿、捨棄、「確認生成」(零 LLM,
    `/api/surface-build`);即時驗證訊息(開放邊、截面數不足)停用確認鈕。
  - 草稿進 reducer / localStorage restore / session 檔;debounce 自動保存(base revision)。
- **golden 鎖**:`nurbsEval.js` 的曲線取樣 vs `cadpy.surface.curves` 取樣逐點重合
  (`nurbsEval.test.js`,值由 Python 現算寫入),否則「套用」瞬間 live/baked 跳動。
- 時間軸 chip 保留「編輯曲面」入口;再改再確認 = 下一版。

### 階段 5:prompt 收斂、文件、教訓

- L4 真回合調校 prompt(見測試);`apps/cad-chat/README.md` 新「曲面模式」節;
  `cad-chat-verify` skill 加曲面 gotcha 條目;`skills/cad/references/surface-modeling.md`
  定稿;`chatModes` 文件表更新。

## 測試與驗收(依 `cad-chat-verify` 金字塔)

- **Python 單元**(`tests/python/packages/cadpy/test_surface_*.py`,先 sync-vendored):
  - 曲線:插值樣條過點、NURBS 權重對圓弧的閉式(四分之一圓 w=√2/2 誤差 <1e-6)。
  - 曲面:放樣體積/面積閉式(圓→圓放樣=圓台 Pappus)、旋轉=球面面積、補面 G1/G2
    約束後 `edge_continuity` 量測達標;直紋面退化(兩曲線重合)must-FAIL。
  - 分析:球面每頂點高斯曲率=1/R²;平面 0;圓柱 kmax=1/R、gauss=0;兩半球 G2、
    半球接圓柱 G1、兩平面 G0——三組 golden 釘等級判定門檻。
  - 操作:縫合自由邊計數、加厚體積≈面積×t、鏡射對稱 bbox。
- **L1 node**:`surfaceSchema.test.js`(normalize/merge/revision/錯誤路徑)、
  `surfaceGen.test.js`(草稿 → generator 字串 golden;`SURFACE_SPEC` 可被
  `readFlatJsonDecl` 讀回)、`nurbsEval.test.js`(golden)、`prompt.surface.test.js`、
  `chatModes.test.js`/`chat.mode`/`sessions.persist`/`events`/`chatStore` 的 surface 案例、
  cadjs `cadScene` 的分析 uniform/屬性缺省退路測試。
- **L2 API**(`smoke_surface_mode.py` API 段,負案例必填):半完成草稿保存/讀回/捨棄、
  revision 衝突 409、busy 409、缺截面 400、補面邊不閉合 400、建模成功磁碟斷言
  (STEP 開頭 `ISO-10303-21`、GLB size>0、sidecar 存在且 `edges[].grade` 齊)、
  失敗時版號與產物不變、design session 打 surface 端點 400、surface session 打 export 200。
- **L3 UI**(`smoke_surface_mode.py` UI 段 + `smoke_surface_window.py`):切換器出現
  「曲面」;`__cadDispatch` 注入 `surface_draft` 免 LLM 驗工作窗(特徵樹/拖曳/數值/
  undo/驗證訊息);真確認建模後 GLB 載入;chips 切斑馬/曲率/連續性經 `__cadSurface`
  斷 mode 與 cage/comb 計數;跨重整草稿與 sidecar 回灌;回退到舊版 overlay 跟版。
- **L4 LLM**(`smoke_surface_live.py`,`LLM_GATED`):一回合描述「對稱的滑鼠上蓋,
  三條截面線放樣,前後端 G2」→ 斷 agent 走 `surface_present_draft` 不呼叫 cad_* 、草稿含
  mirror 與 G2 目標、零 version 事件;第二回合「直接生成」→ 一個 version。
  對照支 `smoke_surface_clarify_live.py`:未說明殼或實體 → 必 clarify。
- 收尾:新煙測掛 `run_all.py` `ORDER`/`LLM_GATED`;全套 run_all 綠;L0 build 綠;
  cadjs 測試綠;README/skill 同步。

## 分工建議(依根 `CLAUDE.md` 的 Codex 委派準則)

- **Claude 自做**:階段 0 探針(需邊跑邊判讀 kernel 行為)、mode 接線(撞面多、
  踩教訓庫)、驗證剖面、sidecar 全鏈鏡射、prompt 與 L4 調校、所有 git/sync 操作。
- **可委派 Codex**(spec 寫死後):`surfaceSchema.js` normalize/validate 與測試、
  `nurbsEval.js` de Boor 求值(golden 值由 Claude 先用 Python 算好放進 spec)、
  `surfaceGen.mjs` 的樣板輸出與 golden 測試、`SurfaceWindow.jsx` 的特徵樹/表單骨架、
  煙測骨架。Node 測試由 Claude 自跑(沙箱禁 spawn)。

## 風險與假設

- **OCCT 補面/G2 的真實能力**是最大不確定:`MakeFilling` 的 C2 約束對複雜邊界可能
  失敗或產出振盪面;階段 0 必先用 3–4 個代表案例(四邊補面、三邊補面、對半球補
  G2)量化成功率,失敗則 v1 把 G2 降為「量測與報告」而非「建構保證」。
- 曲率雲圖/斑馬紋品質受三角化密度影響:曲面模式 build 走較細的 deflection
  (`cadpy.glb` 的 `linear/angular_deflection` 選配),接受 GLB 變大。
- 分析 sidecar 與 `_CAD_CURVATURE` 屬性是 **additive** 變更(旗標才寫),其他模式與
  viewer 零回歸;新邊類別 `sampled_curvature` 會讓既有模型中原本判 `tangent` 的
  G2 邊改色——`smoke_view_chrome`/`smoke_click_select` 若紅,先確認是否只是顏色
  斷言,必要時 cadjs 預設主題讓 g2 與 tangent 同色、只在曲面分析模式分色。
- cadpy 正本改動波及 8 份 vendored 複本(`skills/*`、`plugins/*`、`viewer/`),每次
  動 Python 都要 `sync-vendored.sh`,且 `tests/python/packages/` 的既有 topology 測試
  (edge class 數量、schema 版本)要跟著更新。
- 第一版單位 mm;單一零件(不做組合件);曲面模式 session 與其他模式互不轉換
  (時間軸「⇪ 轉為正式設計」不提供,因為產物本身已是真 CAD)。
- 本 cloud 容器無 `.venv`/OCP,所有 Python 層驗證與階段 0 都在 Windows 本機執行。
