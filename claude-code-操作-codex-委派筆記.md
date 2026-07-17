# Claude Code 操作 Codex 寫程式 — 可攜設定筆記

> 2026-07-16 在 text-to-cad repo 端對端實測通過(Codex 讀 spec → 自動建檔 →
> 內容一字不差 → 未偷 commit)。本機:Windows 11、codex-cli 0.144.5
> (standalone 安裝於 `C:\Users\"根據使用者"\AppData\Local\Programs\OpenAI\Codex`)、
> ChatGPT 訂閱登入。適用於任何專案,照抄「三、可直接貼的 CLAUDE.md 規則」即可。

## 一、分工概念

| 角色 | 負責 |
|------|------|
| Claude Code | plan mode 擬計畫、拆任務、寫 spec 檔、審查 diff、跑驗證 |
| Codex(`codex exec`) | 讀 spec、實際撰寫/修改程式碼 |

Claude 用它的 shell 工具呼叫 `codex exec`(headless 非互動模式),把 Codex
當成一個會寫程式的子代理。兩者共用同一工作樹 → **串行接力**(Codex 寫 →
Claude 審),絕不並行改檔;要並行才用 git worktree 隔離。

## 二、實測可用的呼叫指令(核心)

**一定要用 Git Bash(Claude 的 Bash 工具),不要用 PowerShell:**

```bash
codex exec -c 'windows.sandbox="unelevated"' -s workspace-write \
  -C "<repo 絕對路徑>" \
  -o "tmp/codex-out-<slug>.txt" \
  "讀取本 repo 的 tmp/codex-task-<slug>.md,完全依它實作。遵守 AGENTS.md 與 CLAUDE.md。不要 commit、不要 push。" \
  </dev/null
```

`-o` 檔名帶 slug,別用固定名 — 迭代時會蓋掉上一輪回報。

### 六個缺一就掛的 gotcha(全部實測踩過)

1. **`</dev/null` 必加** — Claude Code 的 shell stdin 是非 TTY 管線,codex
   會停在 `Reading additional input from stdin...` 永久掛住。PowerShell 沒有
   `<` 輸入重導,所以整條指令要走 Git Bash。
2. **`-c 'windows.sandbox="unelevated"'` 必加**(本機情況)— config.toml
   全域設 `elevated`,但缺 `codex-windows-sandbox-setup.exe` 時 elevated
   模式下所有本地指令啟動即失敗,錯誤長相是
   `本機沙箱缺少 codex-windows-sandbox-setup.exe`。**`codex doctor` 會回
   全綠,不可信**。合法值只有 `elevated`/`unelevated`。若日後 Codex Desktop
   修好 elevated,此覆寫可拿掉(無害,留著也行)。
3. **`--full-auto` 不存在**(0.144.x)— 那是舊版旗標,網路教學常見。
   自動改檔用 `-s workspace-write`(sandbox 三值:`read-only` /
   `workspace-write` / `danger-full-access`)。
   **永遠別用 `--dangerously-bypass-approvals-and-sandbox`**。
4. **state DB 卡死要停損** — 同 session 第二次 `codex exec` 可能撞自己的
   `~/.codex/state_5.sqlite`,log 出現 `attempt to write a readonly
   database` 後**空轉不退出**,只留半成品殘檔(如 `// placeholder`)。
   規則:見此錯誤或 **~10 分鐘無檔案落地 → 殺掉停損**,改自己寫或
   `codex exec resume --last` 重試;殺掉後必 `git status` 清點殘檔。
   spec 反正先落檔在 tmp/,停損改自寫的成本很低——這是「spec 先寫死」
   除品質外的第二個理由。
5. **unelevated 沙箱禁 Node 子程序** — `node --test <files>`(每檔 spawn
   子程序)在沙箱內直接 `spawn EPERM`;vite build 同理。委派含 JS 測試
   自驗的任務,要接受 Codex「同程序直跑測試檔」的替代回報(它會自己繞,
   回報有註明就採信);**驗證跑腿不要點名 `node --test`/build 類**,
   由 Claude 自跑。
6. **spec 檔必須 UTF-8 with BOM(Windows)** — Codex 用 PowerShell 5.1
   `Get-Content` 讀 spec,無 BOM 的 UTF-8 被當 ANSI(cp950)讀成亂碼:中文
   行為規格全花、只剩 ASCII 程式碼區塊可讀,Codex 會照殘缺規格亂做。
   Claude 的 Write 工具寫檔無 BOM——落 spec 後補
   `printf '\xef\xbb\xbf' > tmp/.bom && cat spec.md >> tmp/.bom && mv tmp/.bom spec.md`,
   委派指令再註明「(UTF-8 with BOM)」保險(它會改用 `-Encoding utf8` 讀)。
   委派後看一眼它的第一個 exec 輸出,發現亂碼立即停損重派。

### 常用旗標速查

| 旗標 | 作用 |
|------|------|
| `-s workspace-write` | 允許自動改工作區檔案(委派實作的標準值) |
| `-s read-only` | 唯讀,適合跑腿式調查(照單蒐集事實,不下判斷) |
| `-C <dir>` | 指定工作根目錄 |
| `-o <file>` | 把 Codex 最終回報寫進檔案,方便 Claude 讀回 |
| `-m <model>` | 單次指定模型(預設吃 `~/.codex/config.toml` 的 `model`) |
| `-c model_reasoning_effort="high"` | 單次覆寫推理力度(low/medium/high/max) |
| `--json` | 逐事件 JSONL 輸出(要程式化解析時用) |
| `--add-dir <dir>` | 額外可寫目錄 |
| `codex exec resume --last "<指令>"` | 接續上一輪 session 繼續修(迭代回饋用) |

模型/力度的全域預設在 `~/.codex/config.toml`(`model = "..."`、
`model_reasoning_effort = "..."`);單次覆寫用上表旗標即可,不必改檔。

## 三、可直接貼的 CLAUDE.md 規則(貼進任何專案)

```markdown
## Codex 委派流程(Claude 規劃/審查 → Codex 實作)

**定位:Codex 是純執行助手,不具任何判斷權。** 所有判斷——要不要做、
怎麼做、結果可不可信——都在 Claude;Codex 只依明確指示執行並回報。
spec 要把裁量空間壓到最小,Codex 的回報一律當原始素材,Claude 驗證
後才採用。

**Claude 自主判斷**每個任務(實作/調查/驗證)要不要委派給 Codex;
使用者明說「給 Codex」/「自己寫」時無條件照辦,覆寫判斷。

- **委派 Codex**(符合越多越該委派):任務能寫成一份自足 spec
  (目標/檔案/驗收/禁區事先講得清楚)、機械性或大量樣板(新獨立模組、
  測試骨架、批量改寫、照 pattern 複製)、與本 repo 隱性慣例耦合低。
- **Claude 自己做**:需要深層 repo 脈絡或專案 gotcha 的工作、小改動
  (幾行內、typo、收尾)、需要邊改邊跑驗證緊密迭代或除錯性質的工作、
  git 等敏感操作(永遠不假手 Codex)。
- 決策要透明:委派前一句話告知「這件交給 Codex:<理由>」再執行;
  拿不準時自己做(委派吃 ChatGPT 額度,錯委派比不委派貴)。
- 分工:Claude 負責擬計畫、拆任務、寫 spec、審查 diff、跑驗證;
  委派出去的程式碼撰寫透過 `codex exec` 執行。
- **唯讀跑腿調查也可委派(`-s read-only`)**:只做照單蒐集——依 Claude
  明列的問題清單讀碼/摘要/列清單,回報事實(檔案、行號、引用內容),
  不要結論、不要建議、不要評價。不叫 Codex 做 code review 或給第二
  意見——審查是判斷,判斷不外包。例行搜尋/定位用 Claude 自有 subagent;
  Codex 跑腿調查保留給量大到值得外包 context 的整理型任務。
- **驗證跑腿也可委派**(跑測試/smoke,Claude 只看結果省 context):
  指令要明列要跑的確切命令、明令「只跑不改」;回報格式=每項 PASS/FAIL
  +失敗摘要(測試名/關鍵斷言/traceback 尾行);綠了就信、FAIL 才親自
  下場。「只跑不改」不靠信任——跑完後 Claude 以 `git status`/`git diff`
  查核源碼零改動。注意:unelevated 沙箱網路受限——需要開埠/起 server/
  打 API 的驗證不能委派;**也禁 Node 子程序**(`node --test`/vite build
  會 spawn EPERM)——適合委派的只剩真純本地單程序層(python -m unittest、
  單檔腳本);node 系驗證由 Claude 自跑。
  網路其實有開關(`-c sandbox_workspace_write.network_access=true`)——
  **禁用**:等於把外網+repo 內 `.env` 憑證交給零判斷執行者;真回合/
  E2E 類驗證(需 server 活著、需判讀結果)由 Claude 自跑:輸出導檔
  只 tail 摘要、UI 用 Playwright 親自看。
- 委派方式:先把核准的計畫寫成 spec 檔 `tmp/codex-task-<slug>.md`,
  spec 內必須重申「不要 commit、不要 push」。然後用 Git Bash:

  codex exec -c 'windows.sandbox="unelevated"' -s workspace-write \
    -C "<本 repo 絕對路徑>" -o "tmp/codex-out-<slug>.txt" \
    "讀取本 repo 的 tmp/codex-task-<slug>.md,完全依它實作。不要 commit、不要 push。" \
    </dev/null

- 必守 gotcha:`</dev/null` 必加(否則 stdin 掛住);Windows 沙箱用
  `-c 'windows.sandbox="unelevated"'`;沒有 `--full-auto`,用
  `-s workspace-write`;禁用 `--dangerously-bypass-approvals-and-sandbox`;
  **停損規則**:log 見「attempt to write a readonly database」(state DB
  卡死)或 ~10 分鐘無檔案落地 → 殺掉改自寫或 resume 重試,並 `git status`
  清點半成品殘檔。
- Codex 跑完後 Claude 必做:讀 `-o` 回報檔 + `git diff`——實作委派審
  diff 內容;調查/驗證委派確認源碼零改動。再跑本專案驗證;不滿意就
  `codex exec resume --last "<更精確修正指令>"` 迭代(sandbox 覆寫與
  `</dev/null` 照帶),或由 Claude 直接補修。
- 串行接力,不並行改檔。本專案的分支/commit 規則對 Codex 一體適用。
```

## 四、標準工作循環

1. **擬計畫**:Claude plan mode 討論 → 使用者核准。
2. **落 spec**:Claude 寫 `tmp/codex-task-<slug>.md` — 要寫清楚:目標、
   要動的檔案、驗收標準、**禁止事項(不 commit/push、不碰哪些目錄)**。
   讓 Codex 自己讀 spec 檔而不是把長文塞命令列(避開引號地獄)。
3. **委派**:上面的 `codex exec` 指令(長任務建議 timeout 給 5–10 分鐘,
   或 `run_in_background` 跑背景)。
4. **審查**:Claude 讀 `-o` 輸出 + `git diff` — 實作委派審 diff 內容,
   調查/驗證委派確認源碼零改動;再跑專案驗證(測試/build)。
5. **迭代**:沒過 → `codex exec resume --last "<修正指令>"`(同樣要
   `</dev/null` 和 sandbox 覆寫),或 Claude 直接補修。
6. **收尾**:綠了交還使用者;commit 由使用者決定。

## 五、前置檢查(換新機器/新專案時跑一次)

```bash
codex --version                # 確認已安裝
codex login status             # 確認已登入(ChatGPT 訂閱或 API key)
codex doctor                   # 環境診斷(注意:elevated 沙箱壞掉它照樣回綠)
```

新專案第一次用,建議先跑一個唯讀煙霧測試確認管線:

```bash
codex exec -c 'windows.sandbox="unelevated"' -s read-only \
  -C "<repo>" "列出這個 repo 根目錄的檔案並總結專案用途" </dev/null
```

## 六、注意事項

- 每次 `codex exec` 吃 ChatGPT/Codex 額度(本次煙霧測試 ~38k tokens)。
- **spec 品質決定成敗**(實戰結論):把行為規格、DOM 結構、測試斷言值
  全部寫死的案子,Codex 的產出可直接過審(實戰案例:純函數+React 元件+
  測試三檔一次到位、自驗全綠、審 diff 零修改採用);留裁量空間的描述性
  spec 才會來回。反面案例:第二案撞 state DB 卡死 → 因 spec 已落檔,
  停損自寫只花十幾分鐘。
- Codex 對 repo 的信任狀態記在 `~/.codex/config.toml` 的 `[projects.'<path>']`
  `trust_level = "trusted"`;新 repo 第一次跑若卡信任,先用互動式 `codex`
  開一次該目錄核准。
- spec 檔與輸出檔放專案的 `tmp/`(或等效的不進版控目錄)。
- Codex 走 `git apply` 改檔,產物直接落在工作樹 — Claude 審查用 `git diff`
  一目了然。
