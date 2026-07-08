# -*- coding: utf-8 -*-
"""搶答佇列真對話煙測:回合進行中點 clarify 選項 → 不 409、不砍串流、回合結束自動送出。
會消耗兩個極短 LLM 回合(訂閱 OAuth / API key)——run_all 以 CADCHAT_SMOKE_LLM=1 閘門。"""
from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".composer-input", timeout=15000)
    page.wait_for_timeout(500)

    # 回合 1:極短、不建模
    page.fill(".composer-input", "請只回覆一句話:收到。不要呼叫任何工具、不要建模。")
    page.click(".composer-btn.send")
    page.wait_for_selector(".composer-btn.interrupt", timeout=20000)
    c.check("回合 1 開跑(running)", True)

    # 回合還在跑時注入 clarify 並「搶點」選項 → 走 submitText → send() 應入佇列。
    # 比照 events.js 真流程同時派兩路:左欄對話卡(ADD_ITEM)+ 視圖焦點卡(SET_CLARIFY)。
    # clarify 焦點模式:空畫布下也顯示視圖置中焦點卡(scrim z10 + 卡 z11),搶點的是
    # 視圖焦點卡的 .canvas-clarify-opt(在 scrim 之上仍可點)。
    opt = {"label": "搶答選項", "value": "第二回合:也請只回一句話,不要呼叫工具、不要建模。"}
    page.evaluate(
        """(opt) => {
             const clarify = { q: '測試搶答:選一個', opts: [opt], suggested: '' };
             window.__cadDispatch({ type: 'ADD_ITEM', item: { type: 'clarify', ...clarify } });
             window.__cadDispatch({ type: 'SET_CLARIFY', clarify });
           }""",
        opt,
    )
    page.wait_for_selector(".canvas-clarify-opt", timeout=5000)
    c.check("空畫布 clarify 焦點卡出現在視圖區", page.locator(".canvas-clarify").count() == 1)
    c.check("左欄同步反灰凍結", page.locator('.conv-col[data-frozen="true"]').count() == 1)
    page.click(".canvas-clarify-opt")
    page.wait_for_timeout(600)

    c.check("搶點後無 409/錯誤氣泡", page.locator(".ai-error").count() == 0)
    c.check("送出後焦點卡收掉(視為已答)", page.locator(".canvas-clarify").count() == 0)

    # 背靠背回合間 END_RUN 與佇列 flush 的 START_RUN 會被 React 批次合併,中斷鈕不會有
    # detach→attach 間隙 → 不能拿它當「回合2開跑」訊號;改斷言最終產出:AI 回覆 ≥ 2。
    two = False
    try:
        page.wait_for_function(
            "() => document.querySelectorAll('.ai-text:not(.streaming)').length >= 2",
            timeout=300000,
        )
        two = True
    except Exception:
        pass
    c.check("回合 1 + 佇列自動送出的回合 2 都有 AI 回覆", two)
    try:
        page.wait_for_selector(".composer-btn.interrupt", state="detached", timeout=120000)
        c.check("兩回合後回到待命", True)
    except Exception:
        c.check("兩回合後回到待命", False, "等待逾時")

    c.check("全程無錯誤氣泡", page.locator(".ai-error").count() == 0)
    c.check("搶答訊息已入 transcript", "第二回合" in page.locator("body").inner_text())
    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_queue_live.png"))
    browser.close()

c.finish()
