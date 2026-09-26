# 教訓庫交接筆記(sam 機 → VM)· 2026-09-26

給在 VM 上做整合判斷用。整合完可以刪掉這份檔。

## 進度(2026-09-26 晚,兩機各做了什麼)

- **VM 已完成 §4**:VM 活庫是三份快照的超集(12 條 / 101 案,含 VM 獨有 LS-10
  `manual:motion-phase-couple`、LS-11 `manual:planetary-motion-decompose`、LS-12
  `build:TypeError`),LS-1/LS-5 已在 VM 活庫與 `data/lessons.vm.json` disable。
  **VM 沒有 push 憑證**:更新後的 `data/lessons.vm.json` 與本機分支 `vm_debug`
  (merge commit 350567c = ce4fe94 + 9dd5db1)都還在 VM 上。
- **sam 已做**:用 7 月 16 日的舊 `lessons.vm.json` 跑了 `merge-lessons --machine sam`,
  LS-6~LS-9 進活庫、原 pending 5 筆自動連上;刪掉兩筆 ANSI 垃圾案例;`git rm` legacy
  `data/lessons.json`;disable LS-7、LS-9(VM 建議,與 sam 判斷一致)與 LS-4(為了讓
  LS-8 塞進 digest)。**LS-10~12 要等 VM 的新快照到這邊再 merge 一次才會進來**;
  pending 剩 1 筆 `manual:motion-phase-couple`(就是 LS-10 的原始案例,到時自動連上)。
- **digest 實際容量修正**:`buildDigest` 預算 1000 字元、每條約 200 字,**只塞得下 4~5 條**
  (不是 §5 寫的 9 條)。sam 現在 active = LS-2、LS-3、LS-6、LS-8,digest 全進。
  VM 那邊若 LS-4 仍 active,下次合併 union 會把它復活 → VM 也請 disable LS-4,或告訴我
  你要留 LS-4 捨 LS-8。
- **把 VM 快照弄過來的最省事做法**:VM 上 `git bundle create /tmp/vm.bundle 9dd5db1..vm_debug`
  再 scp 到 sam,或最少 scp `apps/cad-chat/data/lessons.vm.json` 一個檔;到 sam 後
  `merge-lessons --machine sam` 再跑一次(idempotent)。ce4fe94 是 VM 獨有的 commit,
  裡面有什麼要 VM 說明,不在本筆記範圍。

## 0. 一句話

sam 機在 2026-09-26 把兩條過期教訓(`build:KeyError`、MOTION 僅 linear)改成 `disabled`,
但 merge-lessons 是 **union、disable 不傳播**,所以 VM 合併後要**自己再 disable 一次**;
另外 VM 在 7 月 16 日蒸餾出的 LS-6~LS-9 **從來沒有回流到 sam 機**,sam 機那 7 筆
「待蒸餾」案例其實就是它們的原始案例,合併一跑就會自動連上,不用刪。

## 1. 三份 store 現況(2026-09-26,sam 機看到的)

| 檔 | 是什麼 | lessons | cases | 最新命中 |
|---|---|---|---|---|
| `models/.cadchat/lessons.json`(sam 活庫,不進版控) | 伺服器每回合真正讀的 | 5 | 94(7 筆 pending) | 2026-09-25 |
| `data/lessons.sam.json` | sam 機快照(7 月 16 日) | 5 | 72 | 2026-07-15 |
| `data/lessons.vm.json` | VM 機快照(7 月 16 日,commit f1d65c3) | **9** | 79 | 2026-07-16 |
| `data/lessons.json` | 7 月 16 日的 legacy 快照(3 條,id 對不上) | 3 | 27 | — |

自 7 月 16 日之後兩邊都沒再合併過。VM 活庫在 VM 上長成什麼樣我看不到,以下都以
`data/lessons.vm.json` 當 VM 的基準。

三份共有的五條(signature 相同、id 剛好也一樣):

| id | signature | 標題 | sam 判斷 |
|---|---|---|---|
| LS-1 | `build:KeyError` | 參數重生須合併非取代 | **已過期 → disabled**(見 §2) |
| LS-2 | `build:AssertionError:interference` | 定位須從貼合面起算並讓開同軸銷 | 保留(8 月仍命中) |
| LS-3 | `build:Standard_DomainError` | 參數須先驗域約束再建幾何 | 保留(9 月仍命中,41 案最多) |
| LS-4 | `build:edits-failed` | edit 錨點勿選含行內註解的整行 | 保留,價值偏低(6 案 4 解,7 月後沒再命中) |
| LS-5 | `turn:agent_error` | 迴轉/齒條/弧槽輸出勿硬塞線性 MOTION | **已過期 → disabled**(見 §2) |

只有 VM 快照有的四條(7 月 16 日在 VM 蒸餾):

| id | signature | 標題 | 備註 |
|---|---|---|---|
| LS-6 | `validate:motion_sweep:penetration` | 運動對貼合面法向須垂直行程並涵蓋全行程 | 2 案 |
| LS-7 | `validate:interference` | 預期貼合接觸須同步宣告於模組層 | 1 案;與 prompt 的 INTENDED_CONTACT 規則重疊 |
| LS-8 | `manual:revolute-swing-clearance` | 擺臂全弧包絡淨距須閉式先算 | 1 案,Sam 手動記的 |
| LS-9 | `build:Standard_ConstructionError` | 驅動缸須偏置出擺臂旋轉平面 | 1 案;規則很具體(氣缸 vs 翻轉臂),泛用性低 |

## 2. sam 機這次改了什麼、為什麼

只改 `status`,沒刪任何 lesson 或 case。改的檔:sam 活庫、`data/lessons.sam.json`、
`data/lessons.vm.json`(三檔都改是因為 union 規則,任一份 active 合併後就復活)。

- **LS-5 `turn:agent_error`「MOTION v1 僅 linear,旋轉輸出改靜態幾何」**:
  MOTION 早就支援 `revolute` 與 `couple`(README「MOTION 運動宣告」段),這條規則會把
  旋轉/齒輪齒條案例降級成靜態模型,和現行 prompt 直接衝突。它每回合都進 digest。
  「拆 builder、分段 emit」那半句 prompt 已有,不值得留一條殘規則。
- **LS-1 `build:KeyError`「參數重生須合併非取代」**:
  管線 7 月 16 日起 `rewriteParams` 內建磁碟現值墊底合併(README「單一快路徑」段、
  `pipeline.params.test.js`),子集重生不會再蒸發鍵;最後命中 7 月 10 日在修好之前。
  agent 端已無此失敗模式。

同日 sam 機還做了一件相關的事:review 報告指的 `data/lessons.json` LS-3 其實是舊快照
的 id,活庫裡同一條是 LS-5——**跨檔 id 不可信,一律用 signature 對**。

## 3. merge-lessons 的規則(決定你在 VM 上怎麼做)

`apps/cad-chat/scripts/merge-lessons.mjs`(`npm run merge-lessons`),在 `apps/cad-chat/` 下跑。

- lesson 以 **signature** 去重,case 以 (session, at, signature) 去重;**所有 id 重新分配**,
  合併後 LS-n / c_n 編號會變,別拿 id 當引用。
- **union-only**:刪除不傳播(A 刪了、B 快照還有 cases → 下次合併當 pending 帶回)。
- **status 是 union,任一 active → active**;來源不一致會印在報告的 `statusConflicts`,
  由人重新 disable。這就是 §2 兩條到 VM 後要再 disable 一次的原因。
- 措辭以最新 `distilledAt` 為準(不是 caseCount)。
- 預設輸入 = `data/lessons*.json` 全部 + 本機活庫;輸出 = 本機活庫 + `data/lessons.<machine>.json`。
  `<machine>` 預設 hostname,**VM 上請加 `--machine vm`**,否則會生第三份快照而不是更新
  `lessons.vm.json`。
- `--dry-run` 只印報告不寫檔。跑完要重啟 server 才吃到。

## 4. 建議在 VM 上的步驟

前提:sam 機先 commit 這次的快照改動(`data/lessons.sam.json`、`data/lessons.vm.json`、
本筆記),VM `git pull`。

```bash
cd /opt/cadchat/<repo>/apps/cad-chat        # 依 VM 實際路徑
# 0) 先看 VM 活庫現在長怎樣(合併前留個底)
cp "$CADCHAT_DATA_ROOT/models/.cadchat/lessons.json" /tmp/lessons.vm.before.json   # 路徑依 VM 的 DATA_ROOT
node -e 'const s=require("/tmp/lessons.vm.before.json");for(const l of s.lessons)console.log(l.id,l.status,l.signature,l.caseCount,(l.lastHitAt||"").slice(0,10),"|",l.title)'

# 1) 試跑看報告:重點看「來自快照、本機活檔沒有」與 statusConflicts 兩段
npm run merge-lessons -- --dry-run --machine vm

# 2) 真跑(寫 VM 活庫 + data/lessons.vm.json)
npm run merge-lessons -- --machine vm

# 3) 把 §2 那兩條再 disable(id 用步驟 1/2 報告印出的新 id;或用下面 signature 找)
node -e 'const s=require("<VM 活庫路徑>");for(const l of s.lessons)if(["build:KeyError","turn:agent_error"].includes(l.signature))console.log(l.id,l.status,l.title)'
curl -s -X POST http://127.0.0.1:<port>/api/lessons/update -H 'content-type: application/json' \
  -d '{"id":"LS-<n>","status":"disabled"}'         # 兩條各打一次;或在 UI 教訓面板點「生效中」切成「已停用」

# 4) 驗 digest 不再含那兩條、其餘照舊
curl -s http://127.0.0.1:<port>/api/lessons/digest

# 5) 重啟 server;commit 新的 data/lessons.vm.json,推回來
```

之後回到 sam 機再跑一次 `npm run merge-lessons -- --machine sam`,LS-6~LS-9 才會進 sam 活庫,
sam 那 7 筆 pending 裡的 5 筆會依 signature 自動連上;跑完同樣要看 statusConflicts 再
disable 一次(如果 VM 那邊沒 disable 成功)。

## 5. 要你在 VM 上判斷的事

1. **LS-6~LS-9 還要不要 active**。都是 7 月單一案例蒸餾的,之後沒再命中(至少 sam 機沒有)。
   LS-7 與 prompt 的 INTENDED_CONTACT 規則重疊;LS-9 太具體。digest 預算 1000 字元、
   最多 10 條,目前 9 條會全塞進去,每回合都在燒 context。我的傾向:LS-6、LS-8 留,
   LS-7、LS-9 停用。你看 VM 活庫的命中紀錄再決定。
2. **兩筆垃圾案例**:sam 機 pending 裡 `build:exit1` 兩筆(2026-07-14 12:27 與 12:37,
   session `s_mrkmlvoe_v97tvl` / `s_mrkmycg8_s8t4ig`),內容是彩色 traceback 的 ANSI 逃逸碼
   `[1;35m…`,那個 bug 當天修掉了(`python.mjs` 的 `PYTHON_COLORS=0`)。合併後會帶到 VM;
   用 `POST /api/lessons/delete-case {"id":"c_<n>"}` 刪,或面板刪。刪除不傳播,兩邊各刪一次。
3. **legacy `data/lessons.json`** 要不要從版控移除。它是 7 月 16 日的 3 條舊快照,資訊全被
   `lessons.sam.json` 涵蓋,留著只是每次合併多一份輸入。我建議刪。
4. **LS-4** 要不要一併停用。6 案 4 解、7 月 15 日後沒命中;edits 模式還在,規則沒錯,
   只是價值低。可留可停。

## 6. 對照用的一行指令

```bash
# 列出某份 store 的 lessons(id / status / signature / 案數 / 最後命中 / 標題)
node -e 'const s=require("<檔>");for(const l of s.lessons)console.log(l.id,l.status,l.signature,l.caseCount,(l.lastHitAt||"").slice(0,10),"|",l.title)'
# 列 pending(未連結)案例
node -e 'const s=require("<檔>");for(const c of s.cases.filter(c=>!c.lessonId))console.log(c.id,c.source,(c.at||"").slice(0,10),c.signature,"|",String(c.symptom||"").slice(0,100))'
# 活庫 digest 會注入哪些(不經 server)
node -e 'import("./src/server/lessons.mjs").then(m=>{const d=m.buildDigest(m.readStore());console.log([...d.matchAll(/\[(LS-\d+)\]/g)].map(x=>x[1]).join(", "),d.length,"chars")})'
```
