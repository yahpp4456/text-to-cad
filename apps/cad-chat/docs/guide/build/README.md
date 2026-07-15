# ChatCAD 圖文使用手冊 — 產生工具

這個資料夾裝的是「一鍵重新生成手冊」的工具。手冊本身是
`../index.html`(+ `../img/`),UI 改版後重跑就能更新截圖與框選。

## 三段管線

```
shots.py   ── 截圖規格清單:每張圖如何佈置畫面 + 要框哪些元件(選擇器)
capture.py ── Playwright 擷取器:逐張截圖 → ../img/<id>.png + <id>.json(框選矩形)
content.py ── 手冊文案(10 章繁中);圖只引用 shot id,框選編號說明由 json 自帶
assemble.py── 讀 content + img/*.json → ../index.html(+ 自包含版 + Artifact 版)
verify.py  ── 開 file://index.html 自我驗證:斷言章節/圖/框數、零 JS 錯誤、截圖複核
guidelib.py── 共用常數與 helper(glb_page_url / asset_url / seed_file …)
```

框選**不烙圖**:capture 記錄元件的 bounding box,assemble 換成百分比疊上 CSS 框
+ 編號圖例。改文案不必重截圖;UI 位移了才要重跑 capture。

## 怎麼重新生成

1. 先在另一個視窗把 dev server 跑起來(擷取器不會自己起 server):

   ```bash
   cd apps/cad-chat && npm run dev        # http://127.0.0.1:8788/
   ```

2. 擷取 + 組裝 + 驗證(repo 根執行;`PYTHONUTF8=1` 避免 Windows cp950 炸繁中):

   ```bash
   PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/docs/guide/build/capture.py
   PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/docs/guide/build/assemble.py
   PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/docs/guide/build/verify.py
   ```

   常用旗標:`capture.py --list`(列出所有 shot)、`--only id1,id2`(只跑某幾張)、
   `--headed`(顯示瀏覽器除錯)、`--no-live`(跳過真回合)。

## 截圖來源:擺拍為主、真回合選用

- **擺拍(預設、免 LLM)**:用 `?glb=` 載入 `models/` 既有 GLB fixture、或
  `window.__cadDispatch` 注入 UI 狀態(payload 形狀沿用 `tests/smoke/` 既有煙測)。
  乾淨、繁中、模型都在、決定性可重現——手冊主幹用這個。
- **真回合(選用,需認證)**:`capture.py --only live_first_story` 會實際送一段對話、
  等模型建好,一次擷取多點(輸入/產圖中/模型出爐)。標了 `optional=True`,
  **預設批次不跑**(慢、燒 token,且代理中間會有英文推理串流,對繁中教材較雜)。

## 產出檔

| 檔案 | 用途 |
|---|---|
| `../index.html` | 主手冊(相對引 `../img/` 原始 PNG,最清晰;本機檢視/diff) |
| `../index.selfcontained.html` | 單一檔:圖內嵌 **WebP**(1600px 高解析,~2.5MB,一檔可傳) |
| `../artifact.html` | body-only + WebP(1400px,~2MB),發佈 claude.ai Artifact 用 |
| `../img/<id>.png` / `.json` | 乾淨截圖(2×)+ 框選中繼 |
| `../img/manifest.json` | 每次 capture 的 ok/error/缺框摘要 |

單檔版用 WebP 把 16MB PNG 壓到 ~2.5MB、文字仍清晰;要無損可在 `assemble.py`
的 `main()` 把該行 `fmt="webp"` 改回 `"png"`。

## 加一章 / 加一張圖

1. `shots.py` 加一筆 `shot(id=…, chapter=…, setup=…, callouts=[…])`;佈置手法照現有樣板
   (`?glb=` 或 `__cadDispatch`)。跑 `capture.py --only <新id>` 確認框選無缺失。
2. `content.py` 在對應章節加 `{"type":"figure","shot":"<新id>","caption":"…"}`。
3. `assemble.py` + `verify.py` 重跑。
