# -*- coding: utf-8 -*-
"""單擊圈選互動煙測:單擊選/再擊消/拖曳不選/雙擊確保選中+推近/空白清空。"""
from playwright.sync_api import sync_playwright

from _util import Checker, glb_page_url, out_path

URL = glb_page_url("motorized_linear_stage/.motorized_linear_stage.step.glb", "stage")
c = Checker()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(2500)
    box = page.locator("canvas.cad-canvas").bounding_box()
    cx, cy = box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5

    # 找一個能命中零件的點(單擊後等 220ms 延遲 + buffer)
    hit_pt = None
    for dx, dy in [(0, 0), (0.12, 0), (-0.12, 0.08), (0.08, -0.12), (0.18, 0.1)]:
        px, py = cx + box["width"] * dx, cy + box["height"] * dy
        page.mouse.click(px, py)
        page.wait_for_timeout(450)
        if page.locator(".sel-nameplate").count():
            hit_pt = (px, py)
            break
    c.check("單擊零件 → 圈選(名牌出現)", hit_pt is not None)

    if hit_pt:
        page.mouse.click(*hit_pt)
        page.wait_for_timeout(450)
        c.check("再擊同件 → 取消圈選", page.locator(".sel-nameplate").count() == 0)

        # 拖曳(>5px)不觸發圈選
        page.mouse.move(*hit_pt)
        page.mouse.down()
        page.mouse.move(hit_pt[0] + 120, hit_pt[1] + 60, steps=6)
        page.mouse.up()
        page.wait_for_timeout(450)
        c.check("拖曳旋轉 → 不觸發圈選", page.locator(".sel-nameplate").count() == 0)

        # 拖曳後畫面已旋轉,重新找命中點
        dbl_pt = None
        for dx, dy in [(0, 0), (0.1, 0.05), (-0.1, 0), (0.15, -0.08), (-0.15, 0.1)]:
            px, py = cx + box["width"] * dx, cy + box["height"] * dy
            page.mouse.click(px, py)
            page.wait_for_timeout(450)
            if page.locator(".sel-nameplate").count():
                dbl_pt = (px, py)
                break
        c.check("旋轉後仍可單擊圈選", dbl_pt is not None)

        if dbl_pt:
            # 單擊空白 → 清空(避開角落的 canvas-tag/orbit-hint/model-info 覆蓋層)
            page.mouse.click(box["x"] + box["width"] * 0.06, box["y"] + box["height"] * 0.55)
            page.wait_for_timeout(450)
            c.check("單擊空白 → 清空圈選", page.locator(".sel-nameplate").count() == 0)

            page.mouse.click(*dbl_pt)
            page.wait_for_timeout(450)
            c.check("重新圈選成功", page.locator(".sel-nameplate").count() == 1)
            sel_name = page.locator(".sel-name").inner_text()
            page.mouse.dblclick(*dbl_pt)
            page.wait_for_timeout(600)
            c.check("雙擊已選件 → 仍選中(不 toggle 消)", page.locator(".sel-nameplate").count() == 1)
            c.check("雙擊後選取對象不變", page.locator(".sel-name").inner_text().startswith(sel_name.split(" + ")[0]))

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:2]))
    page.screenshot(path=out_path("smoke_click_select.png"))
    browser.close()

c.finish()
