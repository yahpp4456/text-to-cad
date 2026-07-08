# AI 自我驗證機制:Playwright 通用守則

適用對象:任何「AI 改了 web 前端/全端 code,要自己閉環驗證」的專案。
cad-chat 只是實例;本文件的模式與規則不綁定它。

## 0. 核心理念

1. **改 UI 不能只讀 code 收工**——用真瀏覽器把「使用者會做的事」做一遍,斷言結果。
2. **斷言優先於截圖**。截圖是給人最後目視的,不是驗證;AI 的驗證要能 exit 0/1。
3. **每一層盡量免外部依賴**(LLM、雲端服務、真使用者)。付費/慢的依賴放最後一層並用
   環境變數 gate。
4. 測試是產品的一部分:住 repo、有 runner、有 README 跑法。躺在暫存目錄的測試等於沒有。

## 1. Dev 鉤模式(核心機制)

瀏覽器測試天生只看得到 DOM。三種東西 DOM 看不到:**canvas/WebGL 內容、框架內部
state、事件時序**。解法是在產品碼埋「僅開發模式」的鉤子:

```js
// 只在 dev build 暴露;打包後不存在
useEffect(() => {
  if (import.meta.env.DEV) {
    window.__appProbe = { ... };
  }
}, [deps]);
```

三類鉤子,各有用途:

**(a) 狀態探針(只讀)** —— 把不可見狀態變成可斷言的值:
```js
window.__appProbe = {
  gridVisible: () => sceneRefs.grid?.visible ?? null,
  overlayCount: () => overlayGroup?.children.length || 0,
};
```
測試端:`page.evaluate("() => window.__appProbe.overlayCount()")`。

**(b) 動作注入(冪等)** —— 暴露 store 的 dispatch,讓測試不經外部依賴就能模擬
任何事件序列:
```js
if (import.meta.env.DEV) window.__appDispatch = dispatch;
```
這是**免 LLM/免後端驗證的關鍵**:後端串流事件(進度、提問卡、工具狀態)在前端
都對應一個 action——測試直接注入 action,就能驗「事件到達後的渲染」,完全不需要
真的觸發昂貴的上游。上游到 action 的映射另用 API 級測試薄薄蓋一層即可。

**(c) 鏈路 debug 探針** —— 治「靜默失效」(斷言得到 0/null 但沒有任何錯誤)。
把多環節管線的每一環數字化:
```js
window.__appProbe.debug = () => ({
  refs: runtime?.referenceIndex?.size || 0,   // 環節1:資料載入了嗎
  synced: records.filter(r => r.mesh?.userData?.ids).length, // 環節2:映射建了嗎
  records: records.length,                     // 分母
});
```
斷在哪一環,一次 evaluate 就看穿。經驗:**JS 的 optional chaining(`?.`)會把
「介面沒接上」變成靜默 no-op**——props/解構漏接一個欄位,整條功能無聲消失;
debug 探針是唯一快速定位法。

鉤子紀律:只在 dev 模式、只讀或冪等、集中命名(`__app*` 前綴)、在產品碼註明
「Playwright/除錯鉤」。

## 2. 測試骨架(python + playwright sync;零框架依賴)

```python
# -*- coding: utf-8 -*-
"""一句話說明這支驗什麼。"""
from playwright.sync_api import sync_playwright
from _util import BASE, Checker, out_path   # 共用件:見 §5

c = Checker()
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))   # 必掛:JS 錯誤零容忍
    page.goto(BASE)
    ...
    c.check("斷言名(中文,人能讀)", cond, detail)
    ...
    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("this_test.png"))          # 最後目視用,非驗證
    browser.close()
c.finish()   # 印總結;有 fail 則 sys.exit(1)
```

Checker 就是 20 行:passed/failed 兩個 list、check() 印 ✓/✗、finish() 定 exit code。
不用 pytest 也行——**exit code 才是 AI 的介面**;要接 CI 再包一層即可。
Windows 注意:跑的時候帶 `PYTHONUTF8=1`,否則 cp950 對 ✓ 直接炸。

## 3. 反 flake 規則(全部來自真實踩坑)

**等待:**
- 等「條件」不等「時間」:`wait_for_selector` / `wait_for_function`,逾時給足
  (真後端操作可到分鐘級,給 240-300s)。
- 例外:產品有刻意的互動延遲(如單擊 220ms 防雙擊誤觸)→ sleep 必須**明確大於
  該時窗**並註明為什麼(`wait_for_timeout(450)  # 單擊 220ms 延遲 + buffer`)。

**滑鼠與座標:**
- 「點空白處」不存在——畫布角落常有覆蓋層(標籤/提示/浮鈕)。點之前想清楚那個
  百分比座標下面是什麼;寧可選偏中低的位置。
- 3D raycast 命中靠緣分:用**候選點清單掃描**,命中即 break,掃不到才算 fail。
- 視角旋轉後舊座標全部作廢,要重新掃描。
- **滑鼠會停在上一個動作的位置**:hover 態(tooltip、預覽高亮)可能已經被觸發,
  污染下一個「初始狀態」斷言 → 量初始值前先 `mouse.move()` 到中性角落。

**框架渲染時序:**
- React 批次合併:狀態 A→B→A 在同一同步 frame 內發生時,中間態**永不渲染**。
  別拿「元素消失又出現」當流程訊號;**斷最終產出**(訊息數、檔案存在、最終文案)。
- 串流中的 UI(打字機氣泡)在斷言文字前先等串流收斂(`:not(.streaming)`)。

**網路與下載:**
- `Content-Disposition` 只影響「導覽」下載,不影響 fetch/XHR——加 attachment
  header 不會弄壞前端的資源載入,可放心用 `?download=` 參數模式。
- 驗「載入了哪個資源」用 `page.on("request")` 收 URL 清單再斷片段,比等待特定
  request 穩(晚了就 miss)。

**測試間依賴:**
- 有順序依賴(B 吃 A 建的資料)→ A 落一個 handoff JSON 到輸出目錄,runner 定序;
  單支仍可獨立跑(A 先手動跑過即可)。
- 會弄髒共享狀態的測試(localStorage、session)各自用**新 browser context**。

## 4. 分層與成本 gate

```
免費快 ──────────────────────────────────────► 昂貴慢
建置 → 單元(純函數) → API 級(決定性後端) → UI 煙測(注入+斷言) → 真外部依賴(LLM/雲)
```

- 每層原則:**下層綠了才值得跑上層**;上層失敗先懷疑是不是下層就該抓到的問題。
- 真外部依賴層用環境變數 gate(如 `SMOKE_LLM=1` 才跑),預設跳過並印一行說明。
- runner 對「前置不滿足」(server 沒起、fixture 缺)的行為:**印指引 + exit 0 跳過**
  (不擋日常),另設嚴格變數(如 `SMOKE=1`)把跳過轉為失敗(給 CI/交付前用)。
- 需要真 LLM 時把成本壓到底:prompt 明令「只回一句話、不呼叫工具」,一支測試
  ≤ 2 個回合。

## 5. 檔案組織

```
tests/smoke/
  _util.py        # BASE(env 可覆蓋)、Checker、HTTP/SSE helper、輸出目錄
  run_all.py      # 定序 runner + 前置探測 + env-gate
  smoke_<a>.py    # 每支獨立可跑;一支 = 一條使用者流程
  .out/           # 截圖 + handoff(gitignored)
```

- 斷言名用人話寫(它就是失敗時的第一行診斷)。
- 每支結尾固定兩件事:「無 JS 頁面錯誤」斷言 + 截圖。

## 6. 失敗分流(修之前先分類)

1. **產品 bug** → 修產品。判據:手動重現得出來、或 debug 探針顯示鏈路某環為 0。
2. **測試的世界模型錯**(產品對,斷言的訊號假設錯)→ 修測試,**註解寫下錯在哪**
   (下一個 AI 才不會改回去)。常見:拿中間態當訊號、滑鼠殘留、座標假設。
3. **環境問題**(server 舊 code、fixture 是 LFS pointer、埠被孤兒佔)→ 修環境,
   並把該坑寫進專案的驗證 skill,讓下次是 5 秒而不是 1 小時。

黃金法則:**綠燈才可信,可疑的綠燈比紅燈危險**——改了斷言讓它變綠之前,先確認
你能解釋原本為什麼紅。
