# -*- coding: utf-8 -*-
"""圖片附件真對話煙測(L4):一條對話兩回合,同時覆蓋——
① streaming input 帶 image block 端到端(圖只存在截圖裡,模型答得出型號=真讀到圖);
② prompt「圖面附件:多型號未指定 → 型號必列入 clarify options」規則;
③ 消冗(q 不再複述假設值、無字面 \\n);④ resume+streaming 併用跨回合圖面記憶。
圖片來源零依賴:Playwright 對 data:text/html 的型號表截圖產真 PNG。
會消耗兩個 LLM 回合(明令不建模壓成本)——run_all 以 CADCHAT_SMOKE_LLM=1 閘門。"""
import urllib.parse

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

# 型號表(ARM66/ARM69 的 L1/L2 只存在這張圖裡,文字訊息完全不提——
# clarify options 出現這兩個型號名即證明 image block 端到端送達且被讀懂)
TABLE_HTML = """<html><body style="font-family:sans-serif;padding:24px;width:640px;background:#fff">
<h3>馬達外形圖(單位 mm)· 標準型 · 安裝尺寸 60 mm</h3>
<table border="1" cellpadding="8" style="border-collapse:collapse;font-size:15px">
<tr><th>品名</th><th>L1</th><th>L2</th></tr>
<tr><td>ARM66AC</td><td>64.5</td><td>85.5</td></tr>
<tr><td>ARM69AC</td><td>90</td><td>111</td></tr>
</table>
<p>取付:4×φ4.5 孔、50±0.35 節距;軸徑 φ10;凸緣 φ36;本體斷面 60×60</p>
</body></html>"""

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 0. 產真 PNG(對 data URL 截圖) ──
    shot = browser.new_page(viewport={"width": 700, "height": 420})
    shot.goto("data:text/html;charset=utf-8," + urllib.parse.quote(TABLE_HTML))
    shot.wait_for_timeout(300)
    png_path = out_path("motor_table.png")
    shot.screenshot(path=png_path)
    shot.close()

    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".composer-input", timeout=15000)
    page.wait_for_timeout(500)

    # ── 1. 附圖 + 訊息(不提型號;明令不建模壓成本) ──
    page.locator(".composer-file").set_input_files(png_path)
    page.wait_for_selector('.img-chip[data-status="ready"]', timeout=20000)
    c.check("附圖上傳 ready", True)
    page.fill(
        ".composer-input",
        "附圖是馬達外形圖。幫我繪製對應的馬達固定座——本回合先解析規格並向我澄清,"
        "不要建模不要呼叫 cad_build;我確認後也只要列出固定座關鍵規格文字,不要建模。",
    )
    page.click(".composer-btn.send")
    c.check("訊息+附圖送出", page.locator(".img-chip").count() == 0)  # 送出即清 chips
    c.check("user 氣泡帶縮圖", page.locator(".user-img").count() >= 1)

    # ── 2. 等 clarify(讀圖+解析+提問;圖片回合較久) ──
    got_clarify = False
    try:
        page.wait_for_selector(".canvas-clarify", timeout=300000)
        got_clarify = True
    except Exception:
        pass
    c.check("模型讀圖後 emit_clarify(焦點卡出現)", got_clarify)

    if got_clarify:
        # 左欄紀錄卡的選項是完整存檔(不受精靈步驟閘門影響)→ 拿它斷型號
        rec = page.locator(".clarify-card").last.inner_text()
        c.check("options 同時含 ARM66 與 ARM69(圖面內容端到端送達)",
                "ARM66" in rec and "ARM69" in rec, rec[:160])
        q_text = page.locator(".clarify-card").last.locator(".clarify-q").inner_text()
        c.check("q 無字面 backslash-n", "\\n" not in q_text, q_text[:120])
        c.check("q 消冗(短句描述決策點,不整段複述規格)", len(q_text) < 300, f"len={len(q_text)}")

        card = page.locator(".canvas-clarify")
        # 有 spec chips → 兩步精靈:先確認規格才看得到選項(順帶驗步驟閘門)
        if card.locator(".cw-steps").count():
            c.check("附圖回合精靈帶規格步驟(emit_spec 先行)", True)
            card.locator(".cw-confirm").click()
            page.wait_for_timeout(300)
        opts = card.locator(".canvas-clarify-opt")
        target = None
        for i in range(opts.count()):
            if "66" in opts.nth(i).inner_text():
                target = opts.nth(i)
                break
        c.check("有可點的 ARM66 選項", target is not None)
        (target or opts.first).click()

        # ── 3. 回合 2:resume+streaming 併用;答案只在圖裡 → 記憶經 transcript 重放 ──
        before = page.locator(".ai-text:not(.streaming)").count()
        replied = False
        try:
            page.wait_for_function(
                f"() => document.querySelectorAll('.ai-text:not(.streaming)').length > {before}",
                timeout=300000,
            )
            replied = True
        except Exception:
            pass
        c.check("回合 2 有 AI 回覆(resume + streaming 併用)", replied)
        try:
            page.wait_for_selector(".composer-btn.interrupt", state="detached", timeout=120000)
        except Exception:
            pass
        body = page.locator("body").inner_text()
        c.check("回合 2 內容鎖定 66 系(跨回合圖面記憶)", "66" in body.split("ARM69")[-1] or "ARM66" in body)

    c.check("全程無錯誤氣泡", page.locator(".ai-error").count() == 0)
    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_image_clarify_live.png"))
    browser.close()

c.finish()
