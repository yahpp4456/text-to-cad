# cad-chat → Electron 桌面 app 最終版計畫(方案 B:build 時注入 Sam 自備 API key + 模型/effort 設定)

> 定稿版:經 7-agent workflow 設計 + 對抗式審查 + 兩路實碼逐項複驗(2026-07-14)。
> 全部檔案/行號錨點已對照實碼校正;「審查修正清單」記錄相對前版的變更。

## Context

把 `apps/cad-chat`(node:http server + React/Vite 前端 + Python CAD pipeline + Claude Agent SDK
0.3.195)包成**獨立 Windows x64 桌面 app**,發給**內部可信同事**測試(已與使用者確認對象)。

**認證與設定注入(使用者三項最終決定):**
1. 走 **Sam 自備的 `ANTHROPIC_API_KEY`**(API key 按量計費、Commercial Terms,消解訂閱 OAuth
   ToS 灰帶;燒 Sam 額度 → 用專屬 key + Console 花費上限封爆炸半徑)。
2. **單一貼入點**:build 機上一個 gitignored 檔 `apps/cad-chat/.env.bake`,Sam 貼
   `ANTHROPIC_API_KEY` + `CADCHAT_MODEL` + `CADCHAT_EFFORT`(可選 `CADCHAT_THINKING` 等任何
   `CADCHAT_*`);bake script 讀它寫進打包產物。模型/effort 用**既有** `resolveModel`/
   `resolveEffort`(config.mjs),零新解析碼。
3. **重要認知修正(已向使用者說明):**「寫死在程式碼再 build」**不會**讓 key 抽不出來——
   asar 非加密,`npx asar extract` 即攤開全部源碼;寫死源碼反而多了誤 commit 進 git 的風險。
   baked 檔與寫死源碼的「同事看不到、不用輸入」效果完全相同,但 key 永不碰 git 追蹤檔。
   真防線 = 可信同事 + 專屬 key + Console 花費上限;「挖不到」只有後端代理做得到(另案)。

**關鍵前置認知(對實碼複驗全部屬實):**
- SDK 0.3.195 直接 spawn 自包含原生 `claude.exe`(實測 224MB,platform optional dep
  `@anthropic-ai/claude-agent-sdk-win32-x64`,本機存在),不走 `node cli.js` → 目標機沒 node
  不是問題;只需 `asarUnpack` 那顆 exe 並釘死 `pathToClaudeCodeExecutable`(sdk.d.ts:1655 確認
  此 option 存在;實碼兩處 `query()` 目前**都沒傳**,是打包後最大風險點)。
- 系統性風險:3 種原生程序(claude.exe / python.exe / 被 spawn 的 .py)都讀不到 asar 內檔;
  `config.mjs:6-9` 全部路徑由 `import.meta.url` 硬推導,打包後全壞。
- cadpy 是 editable 安裝:`.venv/Lib/site-packages/__editable__.cadpy-0.3.7.pth` 內容 =
  `C:\Users\Sam\Desktop\VS\text-to-cad\skills\cad\scripts\packages\cadpy\src`(絕對路徑),
  換機必 `ModuleNotFoundError`。另 `pyvenv.cfg home` 指 **Microsoft Store Python 3.13**
  (`WindowsApps\PythonSoftwareFoundation...`),venv 搬移性風險加倍 → P0-1 是生死線。

**假設:** 內部測試只出 Windows x64;mac/Linux 另案。

---

## 審查修正清單(相對前版的變更;錨點已全部對實碼校正)

| # | 修正 | 依據 |
|---|---|---|
| R1 | **新增 `.env.bake` 單一貼入點**(key+模型+effort),bake 產物改名 `.env.baked`(內容不只 auth) | 使用者需求 |
| R2 | **extraResources 補 `select_part.py`**——原計畫只列 validate/flat_glb/export_parts 三支,漏了被 `agent/tools.mjs:209` spawn 的第 4 支 | 實碼驗證 |
| R3 | 錨點校正:pipeline 常數是 `STEP_DIR`/`INSPECT_DIR`/`VALIDATE_PY`/`FLAT_GLB_PY`(pipeline.mjs:11-14)非「scriptDir」;匯入邏輯是 `resolveImportSource`(pipeline.mjs:138-157,基準 `MODELS_ROOT` 經 `resolveInside`)+`importStepIntoSession`(:159)非「importComponent」;lessons 第二處 query 在 **distill.mjs:106** 非 110 | 實碼驗證 |
| R4 | sessions.mjs **已有** `session.workdir`(絕對)+`workdirRel`(REPO_ROOT 相對,sessions.mjs:22-34)——不需新增 workdirAbs 欄位,改動縮小為「workdirRel 改基準 DATA_ROOT」 | 實碼驗證 |
| R5 | 雙根 resolver **擴充既有 `src/server/cad/paths.mjs`**(`pathIsInside`/`resolveInside` 已在此,middleware 三支都用它)——不新建 `src/server/paths.mjs` | 實碼驗證 |
| R6 | **打包前置補「LFS 實體化」**:few-shot 6 個 models 參考專案走 git-lfs,打包前 `git lfs checkout` 否則進包的是指標檔 | 實碼驗證 |
| R7 | **`settingSources:["project"]`(runner.mjs:87)打包行為要處置**:packaged RUNTIME_ROOT 不 ship `.claude/` → 讀不到即空,dev/packaged 行為一致化寫進 P0-6 驗證項 | 實碼驗證 |
| R8 | venv 瘦身「安全刪」清單按實測校正:playwright 107MB、sympy 65MB、pymupdf 53MB、sklearn 40MB、matplotlib 30MB(皆非 pipeline 依賴,白名單重裝自然排除);vtk.libs 264MB+vtkmodules 49MB 列「驗證後刪」 | 實測目錄大小 |
| R9 | `loadBakedEnv` fallback-only guard 維持(apikey 對 oauth 的 tie-break 在 config.mjs:130,防 dev 機殘留 baked key 靜默改計費)——guard 涵蓋整個 `.env.baked`(含模型/effort;dev 機本就有自己的 .env.local,不需要 baked 值) | 前輪分析+實碼 |

其餘裁決(resources 佈局、非-editable venv、extraResources dist、utilityProcess.fork、CJS main、
spawnPython 基準、asarUnpack claude.exe)**維持原計畫,經實碼複驗無誤**。

---

## 全域決策(定稿)

| 項 | 裁決 |
|---|---|
| **resources 佈局名** | 單一 `runtime/`。`CADCHAT_RUNTIME_ROOT = <resources>/runtime`,其餘常數全由它衍生 |
| **cadpy 安裝法** | **非-editable 重裝**(`pip install packages/cadpy`,去 `-e`)→ 落 site-packages,`.pth` 消失、路徑無關;此後不需單獨 ship cadpy 複本(來源用 `packages/cadpy` 主複本,AGENTS 定義的 source of truth) |
| **設定注入 owner** | **config-owned**:`.env.baked`(KEY=value)由 `config.loadBakedEnv()` 讀進 `process.env`,**fallback-only**(真 env/.env.local 已有任一認證 → 整檔略過)。Electron main 只餵路徑 env、不碰 key |
| **貼入點/格式** | build 機 `apps/cad-chat/.env.bake`(gitignored),KEY=value:`ANTHROPIC_API_KEY`(必填,`sk-ant-` 形狀檢查)+ `CADCHAT_MODEL`/`CADCHAT_EFFORT`/其他 `CADCHAT_*`(選填,白名單過濾)。bake script 讀 `.env.bake`(env `CADCHAT_BAKE_API_KEY` 可覆寫 key)→ 寫 `APP_ROOT/.env.baked` → extraResources 帶進 packaged APP_ROOT |
| **dist 位置** | extraResources(`runtime/dist`),不進 asar |
| **Python 打包策略** | 整包 slim venv(白名單 requirements 重裝,自然排除 playwright/sympy/pymupdf/sklearn/matplotlib ≈ 300MB)+ pip/pycache/tests 安全刪;VTK(~313MB)列「驗證後刪」。**用 python.org 安裝的 CPython 當 base 重建**(現 venv 綁 Store Python,搬移性差),失敗退路 embeddable Python |
| **spawnPython 基準** | cwd=DATA_ROOT + 絕對腳本路徑 + 產物 arg 相對 DATA_ROOT + 輸入 STEP 目標可絕對 |
| **Electron main 語言** | 先 CJS(`electron/main.cjs`)+ 動態 `import()` 載 ESM |
| **server 起法** | `utilityProcess.fork` 子進程(崩潰隔離;退出 `taskkill /T /F` 連根清 claude.exe/python.exe 孫程序) |

---

## 實作(三階段;Phase 0 全程免 Electron,用 `CADCHAT_*` env 模擬打包佈局)

> **✅ Phase 0 已完成並全數驗證(2026-07-14)**,工作留在 working tree 未 commit:
> - **P0-1**:本機無 python.org/py launcher(只有 Store Python)→ 直接走 embeddable 退路
>   (可搬移性反而最好)。`apps/cad-chat/build-runtime/python/`(gitignored):python.org
>   **embeddable 3.13.14** + `pip install --target`(constraints 釘現 venv 版)+ **cadpy 非
>   -editable wheel**。白名單只需 `build123d==0.11.0`+`ezdxf==1.4.4`+`cadpy --no-deps`——
>   **build123d 0.11 依賴的是 cadquery-ocp-novtk,vtk 是 cadpy 宣告的 cadquery-ocp 拉進來的**,
>   `--no-deps` 裝 cadpy 後 vtk 從頭不進來(比「驗證後刪」更乾淨)。556MB;import+scripts/step
>   出圖+validate.py 幾何檢查全綠。重建腳本:scratchpad `build-runtime-python.ps1`(邏輯已文件化於此)。
> - **P0-2~P0-6**:全部落地(檔案清單見下表);dev 恆等式零回歸實證 = L0 綠 + **L1 155/155**
>   + 煙測全套綠。實作與計畫的差異:雙根 resolver 落在既有 `cad/paths.mjs`(R5);
>   `resolveClaudeCliExe` dev 回 null(不傳 option,SDK 內建解析,零回歸);
>   `CLAUDE_CONFIG_DIR` 只在 `PACKAGED`(=設了 CADCHAT_RUNTIME_ROOT)注入;
>   煙測 `_util.REPO` 尊重 `CADCHAT_DATA_ROOT`(gate 下磁碟斷言對位)。
> - **出口閘(過)**:gate 樹 `C:\cadchat-gate\runtime`(452.9MB,鏡射 extraResources 佈局)
>   + **跨碟** `DATA_ROOT=D:\cadchat-gate-data` + dummy `sk-ant-` key → `/api/health` 回
>   `authMode:"apikey"`;**煙測全套 14 支全數通過**;session/快照/匯出產物實證全落 D:、
>   repo 零污染。gate 樹已清,原 runtime 保留於 build-runtime/。
> - 過程中修一筆煙測世界模型 bug:`smoke_verify_gate.py` 的 `(ms or 9e9)<1500` falsy-0
>   把「ms=0=零 spawn 最強證明」當缺值 → 改 `is not None`。
> - **Phase 1/2(Electron 殼+打包)未動**,依下文執行。

### Phase 0 — 純 node 去風險(先做,擋八成打包破口)

**P0-1(生死線)重建 slim、非-editable、可搬移 venv**
- base 換 python.org CPython(非 Store);白名單 requirements(`build123d`+`cadquery-ocp-novtk`+
  `ezdxf`+`numpy`/`scipy` 等真依賴)重建,`pip install packages/cadpy`(**非 `-e`**)。
- 驗:`python -c "import OCP, cadpy.geometry_checks, cadpy.glb, cadpy.parts, cadpy.motion_decl"`
  + 一輪 `geometry_checks` dogfood 出圖。**沒過,後面全白改。**

**P0-2 config.mjs 常數改「env 優先 + `import.meta.url` fallback」**(`src/server/config.mjs:6-19`)
- `envPath(key)`;定義 `RUNTIME_ROOT`(取代 REPO_ROOT 唯讀角色)、`DATA_ROOT`(可寫,dev 不設
  → =RUNTIME_ROOT)、`PYTHON_EXE`(`CADCHAT_PYTHON_EXE` 覆寫)、`DIST_ROOT`、
  `MODELS_FIXTURES_ROOT`。相容匯出 `REPO_ROOT=RUNTIME_ROOT`、`SESSIONS_ROOT=DATA_ROOT/models/.cadchat`
  (MODELS_ROOT/SESSIONS_ROOT 皆定義於 config.mjs:17-19,一處改)。
- **dev 恆等式保底零回歸**:未設任何 `CADCHAT_*` 路徑 env 時 `RUNTIME_ROOT===DATA_ROOT`=現行推導。

**P0-3 spawnPython 重定基準**(`src/server/cad/python.mjs:91-98` + 呼叫點)
- `spawn(PYTHON_EXE, [absScriptPath, ...args], { cwd: DATA_ROOT, env:{...sandboxEnv(), PYTHONUTF8:"1", PYTHONIOENCODING:"utf-8"}, windowsHide:true })`。
- 腳本改**絕對路徑**(RUNTIME_ROOT 下):`STEP_DIR`/`INSPECT_DIR`/`VALIDATE_PY`/`FLAT_GLB_PY`
  (pipeline.mjs:11-14)、dxf CLI(project.mjs:518/645)、**`SELECT_PART_PY`(tools.mjs:209,R2 新列)**;
  產物 arg 改**相對 DATA_ROOT**。
- 連帶:sessions.mjs `workdirRel` 基準 REPO_ROOT→DATA_ROOT(:26);files.mjs 開檔轉相對處(:181-184)、
  project.mjs 匯出 scratch、`resolveImportSource`(pipeline.mjs:138-157)改雙根 resolver。
- `scrubPaths`(python.mjs:27-34)改**雙根+HOME**;更新 `python.scrub.test.js` 斷言。

**P0-4 雙根 models resolver**(擴充**既有** `src/server/cad/paths.mjs`,R5)
- 新增 `resolveModelRead(rel)`:可寫層(`DATA_ROOT/models`)優先、唯讀 fixtures 層
  (`MODELS_FIXTURES_ROOT`)fallback;`pathIsInside` 沿用,命中任一根即合法。
- 接線:asset.mjs:42-47 逃逸檢查、files.mjs listDir(:61,merge 兩層去重、保留 project 旗標)、
  開檔相對基準。dev 下兩層同目錄 → 行為與現行完全相同(零回歸)。

**P0-5 API key + 模型/effort 注入(方案 B 本體;R1/R9)**
- `apps/cad-chat/.env.bake`(**Sam 的單一貼入點**,gitignored,不進包):
  ```
  ANTHROPIC_API_KEY=sk-ant-xxxx        # 必填
  CADCHAT_MODEL=claude-sonnet-5        # 選填
  CADCHAT_EFFORT=high                  # 選填(CADCHAT_THINKING 等 CADCHAT_* 皆可)
  ```
- `scripts/bake-auth.mjs`(新):讀 `.env.bake`(key 可被 env `CADCHAT_BAKE_API_KEY` 覆寫);
  驗證:key 缺/非 `sk-ant-` 開頭 → fail loud;非 `ANTHROPIC_API_KEY|CADCHAT_*` 的鍵 → 拒絕
  (防手滑貼進 OAuth token 或雜訊);寫 `APP_ROOT/.env.baked`(mode 0o600,印遮罩+鍵清單)。
- `config.mjs`:`loadDotEnvLocal` 一般化成 `loadEnvFile(file, env)`(重用 :24-47 的 parser);
  新增 `loadBakedEnv()` 讀 `APP_ROOT/.env.baked`,**開頭 `if (resolveAuth(process.env).agentReady) return;`
  → fallback-only**。
- **為何 fallback-only:** `resolveAuth` 的 tie-break 是 apikey 一律勝 oauth(config.mjs:130),
  與 `loadEnvFile`「不覆寫已存在」是兩套正交規則。dev 機 `.env.local` 只有 OAuth + 殘留
  `.env.baked` → 兩把都進 env → apikey 勝 → **靜默改用 baked key 計費**。guard 讓「已有任一
  認證就整檔不載(含模型/effort)」,徹底消掉跨型別優先序陷阱。
- `server.mjs:29`:`loadDotEnvLocal(); loadBakedEnv();`(優先序穩定為真 env / .env.local > .env.baked)。
- `.gitignore`(apps/cad-chat,現 4 行)加 `.env.bake`、`.env.baked`。
- `package.json`:`"bake-auth"`、`"build:packaged": "node scripts/bake-auth.mjs && vite build"`。
- L1 測試(config.test.js,現只測 resolveEffort/resolveThinking,擴):`loadEnvFile` 優先序、
  `loadBakedEnv` fallback-only(env 已有 oauth 時 baked 的 apikey+model **都不生效**)、bake 白名單
  拒絕非法鍵;dummy `sk-ant-…` → `mv .env.local` → serve → `GET /api/health` 期望 `authMode:"apikey"`。

**P0-6 兩條 SDK query + transcript 隔離**(runner.mjs + lessons.distill.mjs + config.mjs)
- **兩處** query 都加 `pathToClaudeCodeExecutable: resolveClaudeCliExe()`(config 新增,含
  `app.asar`→`.unpacked` 改寫 + `CADCHAT_CLAUDE_CLI` 覆寫)、`cwd: RUNTIME_ROOT`、`env: agentEnv()`:
  `runner.mjs:79`(主 agent,現有 options 保留)與 **`lessons.distill.mjs:106`**(蒸餾,第二顆
  claude.exe,易漏)。
- `agentEnv()` 收尾 `delete env.ELECTRON_RUN_AS_NODE`;設 `CLAUDE_CONFIG_DIR`(和/或 HOME)指
  `DATA_ROOT/.claude`,隔離 transcript/憑證。
- **R7**:確認 `settingSources:["project"]`(runner.mjs:87)在 packaged RUNTIME_ROOT(不 ship
  `.claude/`)下的行為 = 讀不到即空、與 dev 一致;若 SDK 對缺目錄報錯則改傳 `[]`。

> **Phase 0 出口閘(價值最高):** 重建的 runtime 樹複製到**另一磁碟機(D:\)**,
> `CADCHAT_RUNTIME_ROOT/DATA_ROOT/PYTHON_EXE/DIST_ROOT` 指過去,對 dev server 跑既有 smoke 全套
> (tests/smoke/run_all.py,`CADCHAT_SMOKE=1`)+ `smoke_verify_gate` + 開檔/匯入/匯出。
> 免 Electron 一次逮到:跨碟 `path.relative` 失效、匯入斷鏈、匯出被 cadpy 拒、可寫性、
> **新 venv 可搬移性(Store Python 問題在此現形)**。
> 認證面:dummy `sk-ant-…` → `/api/health` 期望 `authMode:"apikey"`。

> **✅ Phase 1 已完成並全數驗證(2026-07-14)**,未 commit:
> - `src/server/start.mjs`:`startServer({dev, port})` 工廠(env 載入/GC/middleware/Vite/
>   listen 全收進來,回 `{port,url,close}`;**port=0 = OS 配臨時埠**,消掉「先挑埠再綁」
>   競態,launch.mjs 因此不需要 pickFreePort);`server.mjs` 降薄 CLI wrapper(`--dev` 或
>   `CADCHAT_DEV=1`);`entry.child.mjs` fork 目標(`ready`/`error` IPC 回實際 port/url)。
> - `electron/main.cjs` + `electron/launch.mjs`:依計畫(single-instance、sandbox 視窗無
>   preload、computeRuntimeEnv 只餵路徑、before-quit+will-quit 雙保險 taskkill /T /F、
>   server 意外死亡 → 錯誤框收攤不留白畫面殭屍殼)。devDeps:electron ^43.1.0、
>   electron-builder ^26.15.3(Phase 2 用)已裝;`npm run electron:dev`。
> - **驗證**:L1 156/156(新 start.test.js:port=0/health/壞 Host 403/close 釋放;注意
>   undici fetch 禁改 Host header,壞 Host 要用 node:http 原生打)+ L0 綠 +
>   `npm run dev` 迴歸煙測全套 14 支全數通過 + **electron:dev 實測**:視窗載入
>   (`window loaded http://127.0.0.1:59499/` 臨時埠)、health oauth、Python 全鏈
>   (open-project → build+攤平+折彎線+verified:true)、SDK query 真回合(SSE
>   session→ai_start→ai_delta 串流)、**CDP 關窗 → 優雅退出鏈 → Electron exit 0 +
>   埠釋放 + 孤兒 node/python=0**。
> - 誠實註記:第二條 query(lessons 蒸餾)未在 Electron 下真跑(觸發需同 signature
>   pending≥3,昂貴);其與主 query 的 Electron 差異面(agentEnv 清 ELECTRON_RUN_AS_NODE、
>   resolveClaudeCliExe)完全同 plumbing 且 L1 已蓋。列入 Phase 2 實機驗證項之一。

### Phase 1 — Electron 殼、dev 模式(仍不打包)

- `src/server/start.mjs`:抽 `export async function startServer({dev})` → `{port,url,close}`。
  **注意實碼現況:server.mjs 是頂層直跑 + top-level await(:31 argv `--dev`、:47-60 vite 動態
  import、:110-135 listen 全在模組頂層)**,重構把副作用全部收進 factory;`server.mjs` 降為薄
  CLI wrapper(`npm run dev/serve` 不變);新增 `src/server/entry.child.mjs`(fork 目標,`ready`
  IPC 回報實際 port/url)。dev 旗標統一走 `CADCHAT_DEV` env,factory 收 `{dev}`。
- `electron/main.cjs` + `electron/launch.mjs`:`pickFreePort` → `computeRuntimeEnv(port)`(依
  `app.isPackaged` 算 `CADCHAT_*` 路徑塞 env,**不碰 key**)→ `utilityProcess.fork` → 等 `ready`
  → `BrowserWindow.loadURL`(`contextIsolation:true, nodeIntegration:false, sandbox:true`,無
  preload);single-instance lock;`before-quit` → `killServerTree`(`taskkill /pid /T /F`)。
- `package.json` 加 `"main": "electron/main.cjs"` + electron/electron-builder/cross-env devDeps
  (現況零 electron 依賴)+ `"electron:dev"`。跑通 dev(loopback + Python + **兩條** SDK query)。

> **✅ Phase 2 已完成(2026-07-14;本機驗證全過,乾淨機器驗證留給同事機)**,未 commit:
> - 產物:`dist-electron/cad-chat-0.0.0-setup.exe`(**293MB** NSIS,per-user 免管理員)
>   + `cad-chat-0.0.0-portable.exe`(292MB)——7z 壓縮遠優於 1.3–1.5GB 預估(win-unpacked 1.2GB)。
> - `electron-builder.yml` 依計畫;唯一打包 bug:asar files 漏 `src/lib/**`(server 端
>   tools.mjs import clarifyText.js 的 unescapeNewlines)→ 第一次啟動 ERR_MODULE_NOT_FOUND,
>   補一行修復。**教訓:asar files 白名單要跟著 server 的 import 圖走,不能只收 src/server。**
> - **無 key 第一版驗證(win-unpacked)**:啟動→health `authMode:"missing"`+指引 ✓;
>   open-project 用 packaged embeddable python 出圖(fixtures 讀唯讀 runtime 層、session
>   寫 `%APPDATA%\cad-chat`)✓;匯出閘 STL(memo 命中 gate.ran=false)✓;asset 串流 ✓;
>   CDP 關窗優雅退出:埠釋放、cad-chat 程序 0、孤兒 python 0 ✓。
> - **baked 版驗證**:`npm run bake-auth`(Sam 貼的 key,`sk-ant-api…hQAA` 遮罩;
>   CADCHAT_MODEL=claude-opus-4-8+EFFORT=xhigh 為 Sam 自選)→ health
>   `authMode:"apikey"` ✓;**L4 真回合:SDK init 回報 `authSource:"ANTHROPIC_API_KEY"`**
>   (計費來源權威證明)、claude.exe 從 app.asar.unpacked spawn、SSE 串流、範圍防護
>   prompt 在打包版仍生效(把「連線測試」導回 CAD)✓;**transcript 隔離:對話紀錄進
>   `%APPDATA%\cad-chat\.claude`,個人 `~/.claude` 零污染** ✓;退出清樹 ✓。
> - 留給乾淨機器(同事機)的驗證項:無 node 環境首啟、NSIS 安裝路徑/捷徑、SmartScreen
>   (未簽章必出警告,「其他資訊→仍要執行」)、首回合 Defender 掃 claude.exe 的延遲、
>   自動蒸餾(第二顆 claude.exe)真跑。

### Phase 2 — 打包

- **前置:`git lfs checkout models skills`(R6)**——few-shot 6 個參考專案
  (prompt.mjs:29-31 硬寫的 `models/xyz_pickplace_gantry` 等)走 LFS,沒實體化進包的是指標檔。
- `electron-builder.yml`:
  - `asar: true` + `asarUnpack`: `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**`
    (224MB claude.exe)+ `@anthropic-ai/claude-agent-sdk/**`。**別 prune 掉 platform optional dep。**
  - `extraResources`(全部 `to: runtime/…`):slim `.venv`、`skills/cad/scripts/{step,inspect}`
    (皆為目錄,`python <dir>` 執行)、`skills/dxf/scripts/dxf`、
    `apps/cad-chat/src/server/cad/{validate,flat_glb,export_parts,select_part}.py`(**4 支**,R2)、
    `dist`、`.env.baked`、few-shot 6 個 `models/*` 參考專案 + `skills/cad/SKILL.md`+`references/`
    (agent 執行期 Read,品質必需;含 lessons.distill.mjs:25 引用的 `references/lessons.md`)。
    cadpy 不單獨 ship(已在 venv);不 ship `.claude/`。
  - `win: [nsis, portable]`;`nsis.perMachine:false`(裝 `%LOCALAPPDATA%\Programs`,免管理員+
    短路徑規避 OCP 260 字元上限)。
- **先不 baked 打第一版**:靠 `/api/health` 指引驗 loopback + 一條 Python 工具 + 開檔/匯入/匯出。
- **實機逐項驗**:asar.unpacked claude.exe 首啟解壓延遲、venv launcher(失敗改 embeddable
  Python)、VTK 砍除後 import+出圖、**turn 進行中關 app 確認 claude.exe/python.exe 不殘留**、
  transcript/HOME 隔離、settingSources 行為(R7)。
- **最後接 baked**:`build:packaged` 串 `bake-auth → vite build → electron-builder`;**無 node
  乾淨機器**跑一輪真對話(L4,`/api/health` 報 `authMode:"apikey"`,燒 API 額度)+ 自動蒸餾
  (distill.mjs:106 的第二顆 claude.exe)。跑前確認:專屬 key + Console 花費上限已設。

---

## 關鍵改動檔案(錨點已校正)

| 檔案 | 改動 |
|---|---|
| `src/server/config.mjs` | 核心:常數 env 覆寫+fallback(:6-19)、`loadEnvFile`/`loadBakedEnv`(fallback-only)、`resolveClaudeCliExe`、`agentEnv` 清 env+`CLAUDE_CONFIG_DIR`、雙根 |
| `src/server/cad/python.mjs` | spawnPython(:91-98)cwd=DATA_ROOT+絕對腳本+相對產物;scrubPaths(:27-34)雙根 |
| `src/server/cad/pipeline.mjs` | `STEP_DIR`/`INSPECT_DIR`/`VALIDATE_PY`/`FLAT_GLB_PY`(:11-14)絕對化;`resolveImportSource`(:138-157)雙根 |
| `src/server/agent/tools.mjs` | `select_part.py` spawn(:209)同步絕對化(R2) |
| `src/server/sessions.mjs` | `workdirRel` 基準改 DATA_ROOT(:26);SESSIONS_ROOT 隨 config |
| `src/server/cad/paths.mjs` | **擴充既有檔**(R5):`resolveModelRead` 雙根;`pathIsInside` 多根 |
| `src/server/middleware/{asset,files,project}.mjs` | 接雙根 resolver;開檔/匯出路徑基準 |
| `src/server/agent/runner.mjs`(:79)、`src/server/lessons.distill.mjs`(:106) | 兩處 query 加 `pathToClaudeCodeExecutable`+`cwd:RUNTIME_ROOT`+env;settingSources 驗證(R7) |
| `src/server/{start,entry.child}.mjs`(新)、`server.mjs` | 頂層直跑重構成 factory + fork 入口 |
| `scripts/bake-auth.mjs`(新)、`.env.bake`(範本註解進 .env.example)、`.gitignore`、`package.json` | 注入本體(R1):`.env.bake` → 驗證/白名單 → `.env.baked`;scripts + electron devDeps + `main` |
| `electron/main.cjs`、`electron/launch.mjs`、`electron-builder.yml`(新) | Electron 殼 + 打包設定 |
| 打包前置 | 重建 slim 非-editable venv(python.org base,消 `.pth` 絕對路徑+Store Python 雙風險);`git lfs checkout`(R6) |

## 驗證(對照 cad-chat-verify L0–L4)

- **純 node 免打包(先做):** L1 單元(`loadEnvFile` 優先序 / `loadBakedEnv` fallback-only /
  bake 白名單 / 雙根 resolver / scrub 雙根 / 絕對-腳本-相對-產物 arg);**Phase 0 出口閘 =
  runtime 樹複製 D:\ + env 指過去,smoke 全套(run_all.py)+ verify_gate + 開檔/匯入/匯出全綠**;
  dummy `sk-ant-…` → `/api/health` 期望 `authMode:"apikey"`。
- **實機打包後(排最後,逐項):** claude.exe asarUnpack spawn+首啟延遲、venv launcher、VTK 砍後
  出圖、退出清子程序樹、transcript 隔離、settingSources、**乾淨機器真對話+自動蒸餾(L4)**。

## 誠實風險(高→低)

1. **cadpy `.pth` 斷鏈 + venv 綁 Store Python,不可搬移(P0,高)** — 非-editable+python.org base 重建消解;退路 embeddable Python。D:\ 出口閘早期現形。
2. **API key 按量計費、燒 Sam 額度(中)** — 專屬 key(可獨立輪替/撤銷)+ Console 花費上限。換 key = 重 bake 重發安裝檔(挑一把整個測試期都能用的 key)。
3. **cadpy 對絕對輸入目標的接受度未實測(中)** — 若拒,spawnPython 退路已備(cwd/腳本對調)。
4. **claude.exe(224MB)+venv → 安裝檔 ~1.3–1.5GB(中)** — 內測可接受;縮體積走「驗證後刪 VTK(~313MB)」。
5. **退出殘留 claude.exe/python.exe(中)** — `taskkill /T /F` + 打包後實測最易漏。
6. **API key 明文躺安裝目錄(已知並接受)** — 僅發可信同事;技術上必可被抽出(asar 非加密、寫死源碼亦同),防線=信任+花費上限+可即時撤銷。對外散布需 per-user key/後端代理/safeStorage(另案)。
