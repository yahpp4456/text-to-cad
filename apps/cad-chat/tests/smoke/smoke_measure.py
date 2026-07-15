# -*- coding: utf-8 -*-
"""量測(前端 facts 即時算:選兩面 → 微秒出距離 + 3D 尺寸線,免 round-trip)煙測。免 LLM/session。

前端 facts 精算不需 session(用 runtime 已載的 pickData 即時算),故 ?glb= 直開 motorized_linear_stage
→ 進量測模式 → 注入兩面 pick(__cadMeasure.pickFace 繞過 raycast)→ 即時 result + 3D 尺寸線 + HUD +
中點標籤 + 無「量測中」。距離對照後端 golden(row 0/1 = #o1.1.f1/f2 = 320 沿 x;數學逐位對齊由
src/lib/measureFacts.test.js 鎖住)。動 cadpy.analysis positioning 數學 → 該單元測 golden 一起更新。
"""
from playwright.sync_api import sync_playwright

from _util import Checker, glb_page_url, out_path

c = Checker()
URL = glb_page_url("motorized_linear_stage/.motorized_linear_stage.step.glb", "stage")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(2500)  # runtime + syncDisplayMeshFaceIds

    chip = page.locator(".tool-chip", has_text="量測")
    c.check("量測 tool-chip 出現", chip.count() == 1)
    chip.click()
    page.wait_for_timeout(200)
    c.check("點 chip → 進量測模式", page.evaluate("() => window.__cadMeasure.mode()") is True)
    c.check("量測 HUD 出現", page.locator(".measure-hud").count() == 1)

    rows = page.evaluate("() => window.__cadMeasure.faceRows().slice(0, 2)")
    c.check("runtime 有可量測面(≥2)", isinstance(rows, list) and len(rows) >= 2, str(rows)[:80])

    if isinstance(rows, list) and len(rows) >= 2:
        page.evaluate("(r) => window.__cadMeasure.pickFace(r)", rows[0])
        page.wait_for_timeout(120)
        c.check("選第一面 → picks=1", page.evaluate("() => window.__cadMeasure.picks()") == 1)

        page.evaluate("(r) => window.__cadMeasure.pickFace(r)", rows[1])
        page.wait_for_timeout(200)  # 前端即時算,無 round-trip
        c.check("選第二面 → picks=2", page.evaluate("() => window.__cadMeasure.picks()") == 2)
        c.check(
            "3D 尺寸線 overlay 畫出(measureGroup children≥2)",
            page.evaluate("() => window.__cadMeasure.groupCount()") >= 2,
        )

        # 即時出結果(前端 facts,無「量測中」等待)。row 0/1 = f1/f2 = 320 沿 x(對後端 golden)
        res = page.evaluate("() => window.__cadMeasure.result()")
        c.check("即時出量測結果(前端 facts,無 round-trip)", res is not None and res.get("value") is not None, str(res)[:120])
        c.check("距離 = 後端 golden 320", bool(res) and abs(abs(res["value"]) - 320) < 1e-6, str(res.get("value") if res else None))
        c.check("軸 = x", bool(res) and res.get("axis") == "x", str(res.get("axis") if res else None))
        c.check("向量關係 = opposed(兩相對面)", bool(res) and (res.get("rel") or {}).get("relation") == "opposed", str(res.get("rel") if res else None))

        hud = page.locator(".measure-hud").inner_text()
        c.check("HUD 顯示 320 mm", "mm" in hud and "320" in hud, hud[:80])
        c.check("HUD 無「量測中」殘留(前端即時)", "量測中" not in hud, hud[:80])
        c.check("3D 中點數值標籤出現", page.locator(".measure-label").count() == 1)

        page.locator(".measure-clear").click()
        page.wait_for_timeout(150)
        c.check(
            "清除 → picks 歸零 + 尺寸線消失",
            page.evaluate("() => window.__cadMeasure.picks()") == 0
            and page.evaluate("() => window.__cadMeasure.groupCount()") == 0,
        )

    chip.click()
    page.wait_for_timeout(120)
    c.check("再點 chip → 退出量測模式", page.evaluate("() => window.__cadMeasure.mode()") is False)
    c.check("退出 → HUD 消失", page.locator(".measure-hud").count() == 0)

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:2]))
    page.screenshot(path=out_path("smoke_measure.png"))
    browser.close()

c.finish()
