# -*- coding: utf-8 -*-
"""物件樹眼睛三態(透視)+ 樹選件連動煙測(steering_box 真 GLB,免 LLM)。
① 每個 PART 列有 .tree-eye;housing:solid→ghost(opacity≈0.16、琥珀、點擊穿透)
   →hidden(mesh.visible=false、標籤刪除線)→solid 循環(__cadVisual 探針斷言)。
② ghost 與運動示意組成:殼半透明時 applyAt 照常轉 pinion(矩陣非 identity、殼保持 ghost)。
③ 樹點列(非眼睛)→ 3D 圈選連動(nameplate 出現;再點同列 toggle 取消)——
   殼擋 raycast 點不到內部件時的逃生口。"""
import json
import re
import urllib.parse

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "stroke", "type": "linear", "axis": [0, 1, 0], "travel": -7.6969,
         "period_s": 4, "moving": ["rack"]},
        {"id": "swing", "type": "revolute", "axis": [0, 0, 1], "pivot": [0, 0, 67.5],
         "angle_deg": 90, "period_s": 4, "couple": "stroke", "moving": ["pinion"]},
    ],
}
_glb = "/api/asset?file=" + urllib.parse.quote(
    "steering_box_rack_pinion/.steering_box_rack_pinion.step.glb", safe="")
URL = (
    BASE + "/?glb=" + urllib.parse.quote(_glb, safe="")
    + "&name=steering_box&motion=" + urllib.parse.quote(json.dumps(MOTION), safe="")
)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(2500)
    page.locator(".props-toggle").click()
    page.wait_for_selector(".tree-node")

    # ── ① 眼睛三態循環(housing) ──
    eyes = page.locator(".tree-eye")
    c.check("每個 PART 列都有眼睛(5 件)", eyes.count() == 5, f"n={eyes.count()}")

    row = page.locator(".tree-node", has=page.locator(".tree-label", has_text="housing")).first
    eye = row.locator(".tree-eye")
    st0 = page.evaluate("() => window.__cadVisual?.stateFor('housing')")
    c.check("初始 solid(opacity 1、visible)",
            st0 and abs(st0["opacity"] - 1) < 0.01 and st0["visible"] is True, str(st0))

    eye.click()
    page.wait_for_timeout(250)
    st1 = page.evaluate("() => window.__cadVisual?.stateFor('housing')")
    c.check("點 1 下 → ghost(opacity≈0.16 半透明)",
            st1 and abs(st1["opacity"] - 0.16) < 0.02 and st1["visible"] is True, str(st1))
    c.check("眼睛轉琥珀 ghost 態", eye.get_attribute("data-state") == "ghost")
    c.check("列標 data-display=ghost", row.get_attribute("data-display") == "ghost")

    # ── ② ghost × 運動示意組成:殼半透明時內部照常動 ──
    page.evaluate("() => window.__cadMotion.applyAt(1)")
    mp = page.evaluate("() => window.__cadMotion.matrixFor('pinion')")
    c.check("殼 ghost 下 pinion 照常旋轉(m00≠1)",
            isinstance(mp, list) and abs(mp[0] - 1) > 0.2, str(mp[:2] if mp else mp))
    st1b = page.evaluate("() => window.__cadVisual?.stateFor('housing')")
    c.check("動畫套用後殼仍保持 ghost(材質與矩陣正交)",
            st1b and abs(st1b["opacity"] - 0.16) < 0.02, str(st1b))

    eye.click()
    page.wait_for_timeout(250)
    st2 = page.evaluate("() => window.__cadVisual?.stateFor('housing')")
    c.check("點 2 下 → hidden(mesh.visible=false)", st2 and st2["visible"] is False, str(st2))
    c.check("hidden 列標籤刪除線態", row.get_attribute("data-display") == "hidden")

    eye.click()
    page.wait_for_timeout(250)
    st3 = page.evaluate("() => window.__cadVisual?.stateFor('housing')")
    c.check("點 3 下 → 還原 solid",
            st3 and abs(st3["opacity"] - 1) < 0.01 and st3["visible"] is True, str(st3))
    c.check("__cadVisual.display 空(無殘留)",
            page.evaluate("() => Object.keys(window.__cadVisual.display()).length") == 0)

    # ── ③ 樹點列 → 3D 圈選連動(toggle) ──
    # label 必須「全等」比對:has_text 是子字串,"pinion" 會先鎖到根 ASSEMBLY 列
    # 「steering_box_rack_pinion」(無 occurrenceId,本來就不觸發圈選)。
    prow = page.locator(
        ".tree-node", has=page.locator(".tree-label", has_text=re.compile(r"^pinion$"))
    ).first
    prow.locator(".tree-label").click()
    page.wait_for_timeout(300)
    c.check("樹點 pinion → 3D 圈選(nameplate 出現)",
            page.locator(".sel-nameplate").count() == 1,
            f"n={page.locator('.sel-nameplate').count()}")
    c.check("屬性面板連動 pinion",
            page.locator(".props-sel-name").inner_text().strip() == "pinion")
    prow.locator(".tree-label").click()
    page.wait_for_timeout(300)
    c.check("再點同列 → toggle 取消圈選",
            page.locator(".sel-nameplate").count() == 0,
            f"n={page.locator('.sel-nameplate').count()}")

    c.check("全程無 JS 錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_part_visibility.png"))
    browser.close()

c.finish()
