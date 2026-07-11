# -*- coding: utf-8 -*-
"""開檔看圖的去重與載入狀態煙測(真 FileBrowser UI,免 LLM)。

回歸鎖:重複開同一檔曾經每次長出新檢視版(o1/o2/o3…),且點任何同 glbUrl 的
版本 chip 會把 status 設回 loading——useCadViewport 只依賴 glbUrl,URL 沒變不
重載,「載入 3D 模型…」覆蓋層永遠卡死。修法=①openFile 以 file 去重沿用既有
版本 id;②reducer 同 glbUrl 保留 status;③/api/open 的 glbUrl 帶 mtime buster
(檔案外部重生過才換 URL 觸發真重載)。
"""
import re

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

DIR_A = "steering_box_rack_pinion"
DIR_B = "flip_gripper"
DIR_C = "motorized_linear_stage"  # 第三檔(⑥ 段;LFS fixture,run_all 前置已要求 hydrate)


def open_step(page, dirname):
    """Header 開啟檔案 → 進目錄 → 點 <dirname>.step 的「開啟」(隱藏 GLB 已存在,秒回)。
    FileBrowser 的 dir state 跨開闔保留 → 先點 breadcrumb「models」回根再導航。"""
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-list")
    page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
    page.wait_for_selector(".fb-name.fb-dir")
    page.locator(".fb-name.fb-dir", has_text=dirname).click()
    row = page.locator(
        ".fb-row", has=page.locator(".fb-name", has_text=f"{dirname}.step")
    ).first
    # 這些 fixture 都是可編輯專案(有 gen_step)→ 智慧路由下檔案列主鈕「開啟」會開成
    # 專案(v1 session);本測試驗的是「唯讀檢視版」的去重/載入,故點「僅檢視」逃生口。
    row.locator(".fb-action", has_text=re.compile(r"^僅檢視$")).click()
    # 同步點:FileBrowser 只在 onOpenFile(dispatch 完成)後才 onClose → overlay
    # 消失=ADD_VERSION/PRESENT 已提交。canvas.cad-canvas 在第二次開檔起「立即為真」
    # (舊 canvas 殘留),不能當同步點;/api/open 偶發變慢時會量到 dispatch 前的假象。
    page.wait_for_selector(".fb-overlay", state="detached", timeout=60000)
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".hdr-btn")

    # ── ① 首開:o1 出現、載入完成 ──
    open_step(page, DIR_A)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
    c.check("首開 → 1 個版本 chip", page.locator(".version-chip").count() == 1,
            f"n={page.locator('.version-chip').count()}")
    c.check("chip 是 o1 · 檢視", "o1" in page.locator(".version-id").first.inner_text())

    # ── ② 重複開同一檔:去重(不長 o2)+ 同 URL 不重載也不卡 loading ──
    open_step(page, DIR_A)
    page.wait_for_timeout(800)
    c.check("重開同檔 → 仍只有 1 個 chip(去重沿用 o1)",
            page.locator(".version-chip").count() == 1,
            f"n={page.locator('.version-chip').count()}")
    c.check("同 URL 不重載 → 無「載入 3D 模型…」殘留",
            page.locator(".canvas-loading").count() == 0)
    c.check("canvas 仍是單一實例(沒疊第二個)",
            page.locator("canvas.cad-canvas").count() == 1)

    # ── ③ 點已啟用的版本 chip:同 URL → status 保留,不得卡 loading ──
    page.locator(".version-chip").first.click()
    page.wait_for_timeout(500)
    c.check("點已啟用 chip → 不卡「載入 3D 模型…」",
            page.locator(".canvas-loading").count() == 0)

    # ── ④ 負對照:開「不同」檔要真的長新版 + 真重載 ──
    open_step(page, DIR_B)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
    c.check("開不同檔 → 2 個 chip(去重不過度)",
            page.locator(".version-chip").count() == 2,
            f"n={page.locator('.version-chip').count()}")
    # .model-code 有 text-transform: uppercase,inner_text 回傳渲染後大寫 → lower() 比對
    c.check("畫布切到 o2", "o2" in page.locator(".model-code").inner_text().lower())

    # ── ⑤ 跨版切換(URL 不同)照常重載回 ready ──
    page.locator(".version-chip").first.click()  # 回 o1(steering_box)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
    c.check("切回 o1 → 重載完成、無 loading 殘留",
            page.locator(".canvas-loading").count() == 0)
    c.check("畫布名稱切回 steering_box_rack_pinion",
            DIR_A in page.locator(".model-name").inner_text())

    # ── ⑥ 序號從「現有版本」推導,不靠 mount 期 ref ──
    # 真實情境是 RESTORE:重整後 ref 歸零、還原的 o1/o2 還在 → 舊實作再 mint o1
    # 撞號靜默取代別檔的檢視版。純開檔瀏覽無 sessionId 不寫 localStorage 快照
    # (persist 需 session),reload 無法驅動 → 用 __cadDispatch 注入高序號檢視版
    # 直接構造「versions 裡有 ref 不知道的 o-id」這個等價狀態。
    page.evaluate(
        "() => window.__cadDispatch({type:'ADD_VERSION', version:{id:'o7', name:'ghost',"
        " glbUrl:'/api/asset?file=ghost.glb', file:'ghost/ghost.step', source:'opened'}})"
    )
    open_step(page, DIR_C)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
    ids = [
        page.locator(".version-id").nth(i).inner_text()
        for i in range(page.locator(".version-id").count())
    ]
    c.check("注入 o7 後開第三檔 → 取號 o8(推導自版本,非 ref 下一號 o3)",
            any("o8" in t for t in ids), str(ids))
    c.check("o1 chip 名稱未被取代",
            DIR_A in page.locator(".version-chip").first.inner_text())

    # ── ⑦ 對話中途開專案 → 換 session,舊版本 chip 全清(死引用不殘留)──
    # 舊 chip 對新 sessionId 是死引用:精算會標錯版、匯出/回退 404、v1 撞號互蓋。
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-list")
    page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
    dir_row = page.locator(".fb-row", has=page.locator(".fb-dir", has_text=DIR_B)).first
    dir_row.locator(".fb-action", has_text="開啟專案").click()
    # open-project 同步重建+full 驗證(OCCT 冷啟+掃掠),給大 timeout
    page.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
        timeout=300000)
    c.check("開專案 → 只剩新 session 的 v1(舊 o1–o3 已清)",
            page.locator(".version-chip").count() == 1,
            f"n={page.locator('.version-chip').count()}")
    c.check("v1 是 flip_gripper", DIR_B in page.locator(".version-chip").first.inner_text())

    c.check("全程無 JS 錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_open_dedupe.png"))
    browser.close()

c.finish()
