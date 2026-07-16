@AGENTS.md

# Fork-local overrides (Windows self-use fork — these win over AGENTS.md)

This is a self-use fork (origin=yahpp4456, upstream=earthtojake), not PR'd upstream.

**This fork's primary work is `apps/cad-chat`** — a local web "conversational
CAD" app: browser chat → Claude Agent SDK (subscription OAuth or API key) drives
the repo's existing text-to-cad pipeline → real STEP/GLB + geometry validation,
iterated by text / geometry picks / parameter sliders. The rest of the repo
(`skills/`, `packages/cadpy*`, `packages/cadjs`, `models/`) is the CAD pipeline
and viewer runtime that cad-chat *drives* — it is not the day-to-day deliverable
here (that framing in AGENTS.md describes upstream). `apps/` is fork-local and
absent upstream, so keep cad-chat guidance in this file, not in AGENTS.md.

- Deep docs for the app live in `apps/cad-chat/README.md` (architecture,
  endpoints, MOTION contract, file-type/import/merge flows, view chrome). There
  is a nested `apps/cad-chat/CLAUDE.md` that Claude Code auto-loads inside that
  subtree.
- **Before editing cad-chat, load the `cad-chat-verify` skill**
  (`.claude/skills/cad-chat-verify/SKILL.md`) — it owns the layered verify
  pyramid (L0 build → L4 LLM), the "changed area → must-run layer" table, and
  the "new feature → which test" decision tree. Every layer runs LLM-free to the
  end; a real LLM turn is the last, most expensive, gated layer.

- **NEVER commit unless the user explicitly asks for it.** Do all work in the
  working tree and leave it uncommitted; the user decides when to commit. This
  overrides the "Commit directly to it" note below — that describes *where* to
  commit (the `開發` branch) once the user has asked, not permission to commit
  on your own. Auto-commit, "commit when done", and committing as a convenience
  are all forbidden without an explicit request.
- Work branch is `開發` (main-derived). Commit directly to it (only when the user
  asks — see the rule above); no PR, no feature branch. Never push (Sam pushes),
  never touch `main` (kept as a clean upstream mirror; pull updates via
  `git fetch upstream main` then merge into `開發`).
- No symlinks here (core.symlinks=false); every vendored path is an independent
  copy. Sync shared Python packages with `scripts/dev/sync-vendored.sh`, NOT
  `bundle.sh` (Git Bash has no rsync) and NOT `setup-symlinks.sh`. Never hand-roll
  a broad `find|cp` — it clobbers the tracked `tests/python/packages/` unit tests.
- The `Release` / `Deploy` / `Upload Models` workflows are N/A (they target the
  original author's hosted resources). "Releasing" here is just a commit.
- Python interpreter is `.venv/Scripts/python.exe` (Windows; venv in `Scripts/`,
  not `bin/`). Run repo `*.sh` scripts under Git Bash, not PowerShell.

## Codex 委派流程(Claude 規劃/審查 → Codex 實作)

**定位:Codex 是純執行助手,不具任何判斷權。** 所有判斷——要不要做、
怎麼做、結果可不可信——都在 Claude;Codex 只依明確指示執行並回報。
spec 要把 Codex 的裁量空間壓到最小(目標/檔案/驗收/禁區寫死),
Codex 的任何回報一律當原始素材,由 Claude 驗證後才採用。

**Claude 自主判斷**每個任務(實作/調查/驗證)要不要委派給 Codex,
不必等使用者點名。使用者明說「給 Codex」/「自己寫」時無條件照辦,
覆寫下列判斷。

- 判斷準則 — **委派 Codex**(符合越多越該委派):
  - 任務能寫成一份自足 spec(目標/檔案/驗收/禁區都能事先講清楚),
    不需要邊做邊挖大量 repo 脈絡;
  - 機械性或大量樣板:新獨立模組、測試骨架、批量改寫、格式轉換、
    照既有 pattern 複製的新 fixture/端點;
  - 與本 repo 隱性慣例耦合低(不踩教訓庫、驗證層特例)。
- 判斷準則 — **Claude 自己做**:
  - 需要深層 repo 脈絡或記憶中教訓的工作(cad-chat 驗證金字塔、
    INTENDED_CONTACT、PARAMS 重生、vendored 同步等 gotcha 區);
  - 小改動(幾行內、typo、對 Codex 產物的收尾)— 開一輪 Codex 比自己改貴;
  - 需要邊改邊跑驗證緊密迭代、或除錯性質(先要理解才知道改哪)的工作;
  - git/bundle/sync 等敏感操作(這些永遠不假手 Codex)。
- 決策要透明:委派前用一句話告知「這件交給 Codex:<理由>」再執行;
  拿不準時自己做(委派吃 ChatGPT 額度,錯委派比不委派貴)。
- 分工:Claude Code 負責 plan mode 擬計畫、拆解任務、寫 spec、審查 diff、跑
  `cad-chat-verify` 驗證層;委派出去的程式碼撰寫透過 `codex exec` 執行
  (本機已裝 codex-cli,ChatGPT 訂閱登入)。
- 委派方式:先把核准的計畫寫成 spec 檔 `tmp/codex-task-<slug>.md`
  (spec 一律放 `tmp/`,不進版控、不放 `scripts/`),spec 內必須重申
  「不要 commit、不要 push」。然後用 **Git Bash**:

  ```bash
  codex exec -c 'windows.sandbox="unelevated"' -s workspace-write \
    -C "C:/Users/Sam/Desktop/VS/text-to-cad" \
    -o "tmp/codex-out-<slug>.txt" \
    "讀取本 repo 的 tmp/codex-task-<slug>.md,完全依它實作。遵守 AGENTS.md 與 CLAUDE.md。不要 commit、不要 push。" \
    </dev/null
  ```

  `-o` 檔名帶 slug,別用固定名(迭代時會蓋掉上一輪回報)。長任務用
  Bash 工具 `run_in_background` 或 timeout 給 5–10 分鐘(煙霧測試實測
  約 1–2 分/38k tokens,實作型任務會更久)。

- 實測 gotcha(缺一就掛):
  - **`</dev/null` 必加**:Claude Code 的 shell stdin 是非 TTY 管線,codex 會
    停在 `Reading additional input from stdin...` 永久等待。PowerShell 無
    `<` 重導,所以用 Bash 工具跑。
  - **`-c 'windows.sandbox="unelevated"'` 必加**:config.toml 全域是
    `elevated`,但本機缺 `codex-windows-sandbox-setup.exe`,elevated 下所有
    本地指令起不來(codex doctor 卻回全綠,別信)。合法值只有
    `elevated`/`unelevated`。
  - 本機 `codex exec`(0.144.x)**沒有 `--full-auto`**(舊版旗標),自動改檔
    用 `-s workspace-write`。禁用 `--dangerously-bypass-approvals-and-sandbox`。
  - **state DB 卡死要停損**:同 session 第二次 `codex exec` 可能撞自己的
    `~/.codex/state_5.sqlite`(log 出現「attempt to write a readonly
    database」)後空轉不退出,只留半成品殘檔(如 `// placeholder`)。
    症狀出現或 **~10 分鐘無檔案落地即 TaskStop 停損**,改自己寫或
    `codex exec resume --last` 重試;殺掉後必 `git status` 清點殘檔。
    spec 反正先落檔在 tmp/,停損改自寫的成本很低——這也是「spec 先寫死」
    除了品質外的第二個理由。
  - **unelevated 沙箱禁 Node 子程序**:`node --test <files>`(每檔 spawn
    子程序)在 Codex 沙箱內直接 `spawn EPERM`。委派含 JS 測試自驗的任務要
    接受它「同程序直跑測試檔」的替代回報;**驗證跑腿委派不要點名
    `node --test`**(它跑不了),node 系驗證由 Claude 自跑,Codex 跑腿留給
    python -m unittest / 單檔腳本這類不 spawn 的。
- 模型:預設吃 `~/.codex/config.toml`(目前 `gpt-5.6-sol` +
  `model_reasoning_effort="max"`);單次覆寫用 `-m <model>`、
  `-c model_reasoning_effort="<low|medium|high|max>"`。
  逐事件輸出可加 `--json`。
- **唯讀跑腿調查也可委派(`-s read-only`)**:
  - 只做「照單蒐集」——依 Claude 明列的問題清單讀碼/摘要/列清單,
    回報**事實**(檔案路徑、行號、引用內容、呼叫關係),不要結論、
    不要建議、不要評價。判斷與採用全在 Claude。
  - 不叫 Codex 做 code review 或給第二意見——審查是判斷,判斷不外包。
  - 調查指令 = 委派指令改 `-s read-only`(unelevated 與 `</dev/null`
    照樣必加);長問題一樣落檔 `tmp/codex-question-<slug>.md` 讓它自己讀。
  - 例行的搜尋/定位用 Claude 自有 subagent(Explore 等)就好;Codex
    跑腿調查保留給「量大到值得外包 context」的整理型任務。
- **驗證跑腿也可委派**(跑 py 測試/smoke,Claude 只看結果,省 Claude
  context 不被長 log 灌爆):
  - 給 Codex 的指令要**明列要跑的確切指令**(哪個 python、哪個測試路徑、
    哪支 smoke 腳本),不准它自行發明驗證方式;並明令「只跑不改」——
    禁止修任何源碼,失敗就如實回報。
  - 要求回報格式:每項 `PASS`/`FAIL` + 失敗摘要(測試名/檔案/關鍵斷言或
    traceback 最後幾行)。Claude 綠了就信、FAIL 才親自下場看完整 log 重跑。
  - 沙箱限制:unelevated 沙箱**網路受限**——需要開埠、起 dev server、
    打 LLM API 的層(cad-chat L2 伺服器類、L4 LLM 回合)**不能**丟給
    Codex,仍由 Claude 直接跑。**也禁 Node 子程序**(`node --test`/
    vite build 會 spawn EPERM)——會 spawn 的跑腿別委派,由 Claude 自跑。
    適合委派的只剩真純本地單程序層:python -m unittest、幾何煙霧腳本、
    單檔 node 腳本這類。
  - 網路其實有開關(`-c sandbox_workspace_write.network_access=true`,
    實測 key 存在)——**禁用**:等於把外網+repo 內 `.env` 憑證交給零判斷
    執行者;且 L4 判讀(假綠要看圖)本來就是 Claude 的活。L4 省 context
    的正解:Claude 自跑、輸出導檔只 tail 摘要、Playwright 看 UI。
  - 用 `-s workspace-write`(測試會寫 artifacts/暫存);「只跑不改」不靠
    信任,跑完後 Claude 以 `git status`/`git diff` 查核源碼零改動落實。
- Codex 跑完後 Claude 必做:讀 `-o` 回報檔 + `git diff`——實作委派審 diff
  內容;調查/驗證委派確認**源碼零改動**。實作委派再依 `cad-chat-verify`
  挑最小驗證層執行(純本地層可依上述規則委派 Codex 跑腿)。不滿意就
  `codex exec resume --last "<更精確的修正指令>"` 迭代(sandbox 覆寫與
  `</dev/null` 照帶),或由 Claude 直接補修。
- Codex 與 Claude 共用同一工作樹:串行接力(Codex 寫 → Claude 審),
  絕不兩邊並行改檔;要並行才用 git worktree 隔離。
- 所有既有 fork 規則對 Codex 一體適用:只在 `開發` 分支工作、絕不 commit/push、
  不碰 `main`、產物寫 `models/`。
