# -*- coding: utf-8 -*-
"""AI 氣泡 markdown 渲染煙測(免 LLM;用 __cadDispatch 注入,不需 /api/chat)。
  A. finalized 非錯誤訊息 → react-markdown 真渲染(粗體/斜體/inline code/清單/GFM 表格/連結)。
  B. 串流中(streaming:true)→ 維持純文字(保留打字游標、避免半截表格/未閉合 fence 破圖)。
  C. 錯誤訊息(isError)→ 純文字(含 * _ ` 的 scrubbed 字串不被誤解析)。
"""
from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

MD = "\n".join(
    [
        "**粗體** 與 *斜體* 與 `行內碼`",
        "",
        "- 項目一",
        "- 項目二",
        "",
        "| 型號 | 缸徑 |",
        "| --- | --- |",
        "| CG1BN20 | 20 |",
        "| CG1BN25 | 25 |",
        "",
        "見 [連結](https://example.com)",
    ]
)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".canvas-empty", timeout=15000)
    page.evaluate("() => localStorage.clear()")

    # ── A. finalized markdown → 真 DOM ──
    page.evaluate(
        "(text) => window.__cadDispatch({ type: 'ADD_ITEM', item: { type: 'ai', text } })", MD
    )
    page.wait_for_selector(".ai-text.ai-md", timeout=5000)
    md = page.locator(".ai-text.ai-md").last
    c.check("粗體 → <strong>", md.locator("strong").count() >= 1)
    c.check("斜體 → <em>", md.locator("em").count() >= 1)
    c.check("行內碼 → <code>", md.locator("code").count() >= 1)
    c.check("清單 → 2 個 <li>", md.locator("li").count() == 2)
    c.check("GFM 表格包在可橫捲盒", md.locator(".ai-md-tablewrap table").count() == 1)
    c.check(
        "表格有 2 表頭 + ≥4 儲存格",
        md.locator("th").count() == 2 and md.locator("td").count() >= 4,
    )
    link = md.locator("a[href='https://example.com']")
    c.check(
        "連結 → 新分頁",
        link.count() == 1 and link.get_attribute("target") == "_blank",
    )
    c.check("連結 rel 含 noopener", "noopener" in (link.get_attribute("rel") or ""))
    c.check("字面無殘留 **", "**" not in md.inner_text())

    # ── B. 串流中 → 純文字(游標路徑不破) ──
    page.evaluate(
        "() => window.__cadDispatch({ type: 'ADD_ITEM', item: "
        "{ type: 'ai', text: '**still streaming**', streaming: true } })"
    )
    page.wait_for_timeout(150)
    stream = page.locator(".ai-text.streaming").last
    c.check("串流泡有 streaming class", stream.count() == 1)
    c.check("串流泡維持字面 **(未 markdown)", "**still streaming**" in stream.inner_text())
    c.check("串流泡零 <strong>", stream.locator("strong").count() == 0)
    c.check("串流泡非 ai-md", "ai-md" not in (stream.get_attribute("class") or ""))

    # ── C. 錯誤訊息 → 純文字(scrubbed 字串不被解析) ──
    page.evaluate(
        "() => window.__cadDispatch({ type: 'ADD_ITEM', item: "
        "{ type: 'ai', text: '⚠ *not italic* 失敗', isError: true } })"
    )
    page.wait_for_selector(".ai-error", timeout=5000)
    err = page.locator(".ai-error").last
    c.check("錯誤泡有 ai-error", err.count() == 1)
    c.check(
        "錯誤泡字面(無 <em>)",
        err.locator("em").count() == 0 and "*not italic*" in err.inner_text(),
    )

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_chat_markdown.png"))
    browser.close()

c.finish()
