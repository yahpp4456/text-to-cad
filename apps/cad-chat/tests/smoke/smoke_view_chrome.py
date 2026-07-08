# -*- coding: utf-8 -*-
"""視圖 chrome 煙測:網格/座標軸 + chips toggle + 進度面板/細條 + clarify 卡(dev 鉤注入)。"""
from playwright.sync_api import sync_playwright

from _util import BASE, Checker, glb_page_url, out_path

URL = glb_page_url("motorized_linear_stage/.motorized_linear_stage.step.glb", "stage")
c = Checker()

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── A. 有模型頁:網格/座標軸 + chips + 重建細條 + clarify 卡 ──
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(2000)

    c.check("網格預設存在且可見", page.evaluate("() => window.__cadChrome?.grid()") is True)
    c.check("座標軸預設存在且可見", page.evaluate("() => window.__cadChrome?.axes()") is True)

    grid_chip = page.locator(".tool-chip", has_text="網格")
    axes_chip = page.locator(".tool-chip", has_text="座標軸")
    c.check("網格 chip 預設 on", grid_chip.get_attribute("data-on") == "true")
    c.check("座標軸 chip 預設 on", axes_chip.get_attribute("data-on") == "true")

    grid_chip.click()
    page.wait_for_timeout(150)
    c.check("點網格 chip → 網格隱藏", page.evaluate("() => window.__cadChrome.grid()") is False)
    grid_chip.click()
    page.wait_for_timeout(150)
    c.check("再點 → 網格恢復", page.evaluate("() => window.__cadChrome.grid()") is True)
    axes_chip.click()
    page.wait_for_timeout(150)
    c.check("點座標軸 chip → 座標軸隱藏", page.evaluate("() => window.__cadChrome.axes()") is False)
    axes_chip.click()
    page.wait_for_timeout(150)
    c.check("再點 → 座標軸恢復", page.evaluate("() => window.__cadChrome.axes()") is True)

    # 重建細條:模擬 running(dev 鉤 dispatch,不打 LLM)
    page.evaluate("() => window.__cadDispatch({ type: 'START_RUN' })")
    page.evaluate("() => window.__cadDispatch({ type: 'SET_LIVE', live: { text: '幾何驗證中…' } })")
    page.wait_for_timeout(200)
    strip = page.locator(".canvas-progress-strip")
    c.check("running → 視圖頂部進度細條", strip.count() == 1)
    if strip.count():
        c.check("細條顯示 live 文字", "幾何驗證中" in strip.inner_text())
    page.evaluate("() => window.__cadDispatch({ type: 'END_RUN' })")
    page.wait_for_timeout(200)
    c.check("回合結束 → 細條消失", page.locator(".canvas-progress-strip").count() == 0)

    # clarify 焦點模式(注入 → 置中卡 + scrim + 左欄凍結 → 清除)
    page.evaluate(
        """() => window.__cadDispatch({ type: 'SET_CLARIFY', clarify: {
             q: '軸徑要用哪一種?', opts: [{label: '8mm'}, {label: '12mm', value: '用 12mm 軸'}],
             suggested: '8mm + 行程 100mm' } })"""
    )
    page.wait_for_timeout(200)
    card = page.locator(".canvas-clarify")
    c.check("clarify 卡出現在視圖區", card.count() == 1)
    if card.count():
        c.check("問題文字正確", "軸徑" in card.locator(".canvas-clarify-q").inner_text())
        c.check("兩顆選項按鈕", card.locator(".canvas-clarify-opt").count() == 2)
        c.check("建議按鈕存在", card.locator(".canvas-clarify-suggest").count() == 1)
    # 焦點模式:scrim 壓暗背景 + 左欄反灰凍結
    c.check("視圖 scrim 出現", page.locator(".canvas-clarify-scrim").count() == 1)
    c.check("左欄反灰凍結", page.locator('.conv-col[data-frozen="true"]').count() == 1)
    page.evaluate("() => window.__cadDispatch({ type: 'ADD_USER', text: '8mm' })")
    page.wait_for_timeout(200)
    c.check("ADD_USER → clarify 卡消失", page.locator(".canvas-clarify").count() == 0)
    c.check("ADD_USER → scrim 消失", page.locator(".canvas-clarify-scrim").count() == 0)
    c.check("ADD_USER → 左欄解除凍結", page.locator('.conv-col[data-frozen="true"]').count() == 0)

    c.check("A頁無 JS 錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_view_chrome_model.png"))
    page.close()

    # ── B. 空畫布頁:產圖進度面板(五階段+live+工具卡) ──
    page2 = browser.new_page(viewport={"width": 1480, "height": 920})
    errors2 = []
    page2.on("pageerror", lambda e: errors2.append(str(e)))
    page2.goto(BASE)
    page2.wait_for_selector(".canvas-empty", timeout=15000)

    page2.evaluate("() => window.__cadDispatch({ type: 'START_RUN' })")
    page2.evaluate("() => window.__cadDispatch({ type: 'SET_STAGE', index: 2 })")
    page2.evaluate(
        "() => window.__cadDispatch({ type: 'SET_LIVE', live: { text: '撰寫產生器原始碼…已寫 2.3k 字元' } })"
    )
    page2.evaluate(
        """() => window.__cadDispatch({ type: 'UPSERT_TOOL', id: 't1',
             patch: { name: 'cad_build', label: '建構模型', status: 'running' } })"""
    )
    page2.wait_for_timeout(250)

    prog = page2.locator(".canvas-progress")
    c.check("空畫布+running → 進度面板", prog.count() == 1)
    if prog.count():
        c.check("五階段直列", prog.locator(".prog-stage").count() == 5)
        cur = prog.locator('.prog-stage[data-state="cur"]')
        c.check("目前階段=生成", cur.count() == 1 and "生成" in cur.inner_text())
        c.check("前兩階段標記完成", prog.locator('.prog-stage[data-state="done"]').count() == 2)
        c.check("live 文字顯示", "撰寫產生器" in prog.locator(".prog-live").inner_text())
        tool = prog.locator(".prog-tool")
        c.check("工具卡出現", tool.count() == 1 and "建構模型" in tool.first.inner_text())
    page2.evaluate("() => window.__cadDispatch({ type: 'END_RUN' })")
    page2.wait_for_timeout(200)
    c.check("END_RUN → 回到靜態空狀態", page2.locator(".canvas-empty").count() == 1)

    # clarify 焦點模式:空畫布下也顯示置中焦點卡 + scrim + 左欄凍結。
    # 佔位圖(.canvas-empty)仍在 DOM,只是被 scrim(z10)壓在其下,未卸載。
    page2.evaluate(
        """() => window.__cadDispatch({ type: 'SET_CLARIFY', clarify: {
             q: '空畫布焦點問題', opts: [{label: 'x'}], suggested: '' } })"""
    )
    page2.wait_for_timeout(150)
    c.check("空畫布 SET_CLARIFY → 視圖焦點卡出現", page2.locator(".canvas-clarify").count() == 1)
    c.check("空畫布 → scrim 出現", page2.locator(".canvas-clarify-scrim").count() == 1)
    c.check("空畫布 → 左欄反灰凍結", page2.locator('.conv-col[data-frozen="true"]').count() == 1)
    c.check("佔位圖仍在(被 scrim 壓於其下)", page2.locator(".canvas-empty").count() == 1)
    # 答完(ADD_USER)→ 焦點模式退場
    page2.evaluate("() => window.__cadDispatch({ type: 'ADD_USER', text: 'x' })")
    page2.wait_for_timeout(150)
    c.check("答完 → 焦點卡消失", page2.locator(".canvas-clarify").count() == 0)
    c.check("答完 → scrim 消失", page2.locator(".canvas-clarify-scrim").count() == 0)
    c.check("答完 → 左欄解除凍結", page2.locator('.conv-col[data-frozen="true"]').count() == 0)
    c.check("答完 → 佔位圖仍在", page2.locator(".canvas-empty").count() == 1)

    c.check("B頁無 JS 錯誤", not errors2, "; ".join(errors2[:3]))
    page2.screenshot(path=out_path("smoke_view_chrome_empty.png"))
    browser.close()

c.finish()
