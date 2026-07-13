# -*- coding: utf-8 -*-
"""鈑金 3D 視圖「摺疊/攤平」即時切換煙測(真 UI,免 LLM)。

開 sheet_u_bracket 專案(build 時預先產攤平 GLB)→ 視圖左上出明顯雙段切換 →
點「攤平」段載入 `.flat.step.glb`(攔 asset 請求證明真的換了攤平 GLB,零 Python 重算)
→ 點回「摺疊」段。切換靠換 glbUrl(cadjs glbCache 命中),不觸發任何 /api/chat。
"""
import re

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()
DIRP = "sheet_u_bracket"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    asset_reqs = []
    chat_reqs = []
    page.on("request", lambda r: (
        asset_reqs.append(r.url) if "/api/asset" in r.url else None,
        chat_reqs.append(r.url) if "/api/chat" in r.url else None,
    ))
    page.goto(BASE)
    page.wait_for_selector(".hdr-btn")

    # 開專案(一鍵;build 產摺疊+攤平雙 GLB)
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-projrow")
    page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
    page.locator(".fb-projrow", has_text=DIRP).click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
        timeout=300000)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)

    sw = page.locator(".fold-switch")
    fold_seg = page.locator(".fold-seg", has_text="摺疊")
    flat_seg = page.locator(".fold-seg", has_text="攤平")
    c.check("視圖左上出現摺疊/攤平雙段切換(鈑金件有 flatGlbUrl)", sw.count() == 1)
    c.check("在視圖左側(left < 半寬)", sw.bounding_box()["x"] < 700, str(sw.bounding_box()))
    c.check("預設摺疊段 active、攤平段非 active",
            fold_seg.get_attribute("data-on") == "true" and flat_seg.get_attribute("data-on") == "false")

    # 點「攤平」段 → 應載入 .flat.step.glb
    n_asset_before = len(asset_reqs)
    flat_seg.click()
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
    page.wait_for_timeout(400)
    new_assets = asset_reqs[n_asset_before:]
    c.check("點攤平段 → 載入 .flat.step.glb(真換攤平 GLB)",
            any(".flat.step.glb" in u for u in new_assets), str(new_assets)[:250])
    c.check("切換不觸發 /api/chat(零重算)", len(chat_reqs) == 0, str(chat_reqs)[:150])
    c.check("攤平段轉 active",
            page.locator(".fold-seg", has_text="攤平").get_attribute("data-on") == "true")

    # 折彎線 overlay:攤平態板面上疊虛線(u_bracket 2 條上折 → 藍線 1 組)
    bl = page.evaluate("() => window.__cadChrome && window.__cadChrome.bendLines()")
    c.check("攤平態出現折彎線 overlay(count>0、可見)",
            bl and bl.get("visible") and bl.get("count", 0) > 0, str(bl))

    # 點回「摺疊」段 → overlay 消失(場景重建、不含 bendLines)
    page.locator(".fold-seg", has_text="摺疊").click()
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
    page.wait_for_timeout(400)
    c.check("點回摺疊段 active",
            page.locator(".fold-seg", has_text="摺疊").get_attribute("data-on") == "true")
    # bendGroup 永遠建(供 setBendLines/chrome),但摺疊態不加線段 → count=0(重建後空)
    bl2 = page.evaluate("() => window.__cadChrome && window.__cadChrome.bendLines()")
    c.check("摺疊態無折彎線段(count=0,場景重建不加 bendLines)",
            bl2 and bl2.get("count") == 0, str(bl2))

    c.check("全程無 JS 錯誤", not errs, "; ".join(errs[:3]))
    page.screenshot(path=out_path("smoke_flat_toggle.png"))
    browser.close()

c.finish()
