# cad-chat 打包手冊(Windows 內測版)

> 給「下次要打包 / 換 key / 換模型」的自己。機制與設計原理見 README「打包散布」章;
> 完整計畫與三個 Phase 的驗證紀錄見 repo 根 `b-calm-swing.md`。
> ⚠ 條款與安全前提:key 以明文烙進安裝檔(asar 非加密,必可被抽出)——**只發可信同事**;
> 防線 = 專屬 API key(可獨立撤銷)+ Anthropic Console 花費上限。

## TL;DR 日常打包(三步)

```bash
cd apps/cad-chat
# 1) 編輯 .env.bake(gitignored):貼 ANTHROPIC_API_KEY、選填 CADCHAT_MODEL/CADCHAT_EFFORT
# 2) 一鍵出貨(bake 驗證 → vite build → electron-builder):
npm run dist
# 3) 發 dist-electron/cad-chat-<版本>-setup.exe 給同事(portable.exe 是免安裝備用)
```

`npm run dist` 任何一步失敗都會中止(bake 對 key 做 `sk-ant-` 形狀檢查與鍵白名單,
貼錯成訂閱 OAuth token 或夾帶其他祕密會直接擋下,不會烙出壞產物)。

## 個人自用版(烙訂閱 OAuth,不散布)

**只給自己用、燒自己訂閱額度**時,改烙 `CLAUDE_CODE_OAUTH_TOKEN`(非 API key):

```bash
npm run dist:personal        # bake 帶 --allow-oauth
```

- token **自動沿用 `.env.local` 的 `CLAUDE_CODE_OAUTH_TOKEN`**(你不用再貼一次);
  要指定別把 token 就填進 `.env.bake` 的 `CLAUDE_CODE_OAUTH_TOKEN=`(它勝過 .env.local),
  或設 env `CADCHAT_BAKE_OAUTH_TOKEN`。模型/effort 仍讀 `.env.bake`。
- `.env.bake` 若還留著散布版的 `ANTHROPIC_API_KEY`,個人 build **自動忽略它**、改烙訂閱
  token(不必去清那個檔;兩版切換零摩擦)。
- **護欄**:一般 `npm run dist` 偵測到 OAuth token 會 **fail loud**(訂閱憑證只能本人自用,
  ToS 禁散布第三方)——OAuth 只能經 `dist:personal` 的 `--allow-oauth` 明確開。
- 啟動 log / `/api/health` 會顯示 `authMode:"oauth"`(散布版是 `"apikey"`)。
- ⚠ 訂閱版**別發給別人**:一來 ToS,二來對方會用到你的訂閱身分。散布一律走 `npm run dist`
  的 API key 版。

## 換 key / 換模型 / 收回

| 情境 | 動作 |
|---|---|
| **換 key**(外流、輪替) | 改 `.env.bake` 的 `ANTHROPIC_API_KEY` → `npm run dist` → 重發安裝檔;舊 key 到 [Console](https://platform.claude.com) 撤銷(**撤銷立即讓所有舊安裝失效**,這是唯一的遠端開關) |
| **換模型/effort** | 改 `.env.bake` 的 `CADCHAT_MODEL` / `CADCHAT_EFFORT` → `npm run dist` → 重發。省錢建議 `claude-sonnet-5`;`claude-opus-4-8`+`xhigh` 最強也最燒 |
| **全面收回** | Console 撤銷 key 即可(不必追回安裝檔) |

key 烙在產物內 → **任何 .env.bake 的變更都要重打包+重發**,沒有熱更新。

## 打包前檢查清單

- [ ] `.env.bake` 的 key 是**專屬 key**(不是主 key),Console **花費上限已設**
- [ ] `git lfs checkout models skills` 過(few-shot fixtures 必須是實體檔,
      STEP 開頭 `ISO-10303-21`;pointer 檔=agent few-shot 全斷)
- [ ] 改過 server 程式?先跑驗證(`cad-chat-verify` skill:L1 + 煙測)再打包
- [ ] 改過 cadpy / Python 依賴?先重建 runtime(見下節)

## Python runtime 重建(只在依賴變更時需要)

打包用的可搬移 Python 在 `build-runtime/python/`(gitignored,~556MB)。
**cadpy 是非-editable wheel 複本**——改了 `packages/cadpy` 之後不重建 = 打包版跑舊碼。

```powershell
# 從 apps/cad-chat 執行;重建後自動跑 import 煙測
powershell -ExecutionPolicy Bypass -File scripts\build-python-runtime.ps1
```

原理(踩坑紀錄):base 用 python.org **embeddable**(Store Python venv 不可搬移);
白名單只裝 `build123d`+`ezdxf`(novtk 鏈),cadpy 用 `--no-deps`(它宣告的
`cadquery-ocp` 會拉 vtk ~300MB,`--no-deps` 讓 vtk 從頭不進來);constraints 釘
dev venv 現版防漂移。

## 快速迭代(不出安裝檔)

```bash
npx electron-builder --win --dir --config electron-builder.yml
# 產 dist-electron/win-unpacked/cad-chat.exe,免壓縮直接跑,驗證快很多
```

打包後最小驗證:跑起來 → 瀏覽器開不了沒關係,看視窗;或
`curl http://127.0.0.1:<啟動log印的埠>/api/health` 期望 `"authMode":"apikey"`。

## 同事機安裝須知(轉告)

- 安裝檔**未簽章**:SmartScreen 會跳藍窗 →「其他資訊」→「仍要執行」。
- 免管理員,裝到 `%LOCALAPPDATA%\Programs\cad-chat`。
- 首個 AI 回合可能較慢(Defender 首掃內附的 claude.exe)。
- 產物/對話紀錄在 `%APPDATA%\cad-chat\`(models/.cadchat sessions + .claude transcripts;
  解除安裝不會清,要重置就刪這個資料夾)。

## Troubleshooting

| 症狀 | 原因/解法 |
|---|---|
| 啟動即錯誤框 `ERR_MODULE_NOT_FOUND ...app.asar...` | asar files 白名單漏了 server 的 import(教訓:server 不只 `src/server/**`,還 import `src/lib/**`)→ 補 `electron-builder.yml` 的 `files` 再打包 |
| health 回 `authMode:"missing"` | 產物裡沒有 `.env.baked` → 忘了跑 bake(用 `npm run dist` 就不會漏) |
| dev 機跑打包版卻走了訂閱 | 不會——`loadBakedEnv` 是 fallback-only,已有任何認證(如 dev 的 `.env.local`)整檔不生效;反過來 packaged app 讀不到你的 `.env.local`(沒打進去) |
| AI 回合報 spawn/enoent | claude.exe 沒被 asarUnpack(檢查 yml `asarUnpack` 兩個 `@anthropic-ai/*` 條目)|
| 幾何全失敗 | runtime python 壞/舊 → 重建(上節);或 `runtime/skills` 腳本缺(檢查 extraResources)|

## 檔案地圖

| 檔 | 角色 | 進 git? |
|---|---|---|
| `.env.bake` | **你貼 key 的地方**(唯一手動編輯點) | ✗(gitignored) |
| `.env.baked` | bake 產物,被打進 asar | ✗ |
| `scripts/bake-auth.mjs` | bake 驗證器(形狀檢查+鍵白名單) | ✓ |
| `scripts/build-python-runtime.ps1` | Python runtime 重建 | ✓ |
| `electron-builder.yml` | 打包設定(asarUnpack/extraResources 佈局) | ✓ |
| `electron/main.cjs`、`electron/launch.mjs` | Electron 殼 | ✓ |
| `build-runtime/python/` | 可搬移 Python(重建產物) | ✗ |
| `dist-electron/` | 打包輸出(setup.exe / portable.exe / win-unpacked) | ✗ |
