# -*- coding: utf-8 -*-
"""occurrence 巢狀樹煙測(gantry 複合件)+ 扁平模型不回歸(linear stage)
+ GROUP 節點 3D 預覽高亮(不佔圈選名額)。"""
from playwright.sync_api import sync_playwright

from _util import Checker, glb_page_url, out_path

c = Checker()

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── 場景 1:gantry(61 件,含複合件) ──
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(glb_page_url("xyz_pickplace_gantry/.xyz_pickplace_gantry.step.glb", "gantry"))
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(3000)
    page.locator(".props-toggle").click()
    page.wait_for_selector(".tree-node")

    kinds = page.locator(".tree-node .tree-kind").all_inner_texts()
    n_group = sum(1 for k in kinds if k == "GROUP")
    n_part = sum(1 for k in kinds if k == "PART")
    n_face = sum(1 for k in kinds if k == "FACE")
    print(f"  [gantry 頂層] GROUP={n_group} PART={n_part} FACE={n_face} total={len(kinds)}")
    c.check("gantry 樹頂層無 FACE(預設收合)", n_face == 0, f"FACE={n_face}")
    c.check("gantry 樹有節點", n_part + n_group > 0)

    if n_group:
        g = page.locator(".tree-node", has=page.locator(".tree-kind", has_text="GROUP")).first
        g_label = g.locator(".tree-label").inner_text()
        g_pad = g.evaluate("el => parseInt(getComputedStyle(el).paddingLeft)")
        g.click()
        page.wait_for_timeout(300)
        kinds2 = page.locator(".tree-node .tree-kind").all_inner_texts()
        c.check("展開 GROUP 後子節點出現", len(kinds2) > len(kinds), f"{len(kinds)}→{len(kinds2)}")
        sel_name = page.locator(".props-sel-name").inner_text()
        c.check("GROUP 選取連動屬性面板", sel_name.strip() == g_label.strip(), f"{sel_name} vs {g_label}")
        rows = page.locator(".prop-k").all_inner_texts()
        c.check("GROUP 顯示聚合欄位", any("後代" in r for r in rows), "; ".join(rows[:6]))

        # ── GROUP → 3D 預覽高亮:群組前綴進 setSelection,不佔圈選名額 ──
        grp = page.evaluate("() => window.__cadPreview?.group()")
        c.check("點 GROUP → 3D 預覽高亮啟動", isinstance(grp, str) and len(grp) > 0, f"group={grp}")
        c.check("GROUP 預覽不佔圈選(無名牌)", page.locator(".sel-nameplate").count() == 0)

        # GROUP 帶入對話 → chip 出現(母 token)
        bring = page.locator(".props-bring")
        if bring.count():
            bring.click()
            page.wait_for_timeout(200)
            c.check("GROUP 帶入對話 → chip", page.locator(".pick-chip").count() >= 1)
            c.check("GROUP 帶入後轉已帶入", page.locator('.props-bring[data-cited="true"]').count() == 1)
        else:
            c.check("GROUP 有帶入對話按鈕", False, "props-bring 不存在")

        # 點 PART 葉節點 → 預覽還原
        pn = page.locator(".tree-node", has=page.locator(".tree-kind", has_text="PART")).first
        pn.click()
        page.wait_for_timeout(300)
        grp2 = page.evaluate("() => window.__cadPreview?.group()")
        c.check("點 PART 葉節點 → GROUP 預覽還原", grp2 is None, f"group={grp2}")
    else:
        print("  [i] gantry bundle 無中繼節點(扁平)——巢狀/預覽斷言跳過")
        c.check("扁平 gantry:全 PART depth1", n_part >= 50, f"PART={n_part}")

    # 雙擊圈選深葉件 → 樹自動展開祖先鏈(selNode 可見)
    box = page.locator("canvas.cad-canvas").bounding_box()
    for dx, dy in [(0, 0), (0.15, 0), (-0.15, 0.1), (0.1, -0.15)]:
        page.mouse.dblclick(box["x"] + box["width"] * (0.5 + dx), box["y"] + box["height"] * (0.5 + dy))
        page.wait_for_timeout(400)
        if page.locator(".sel-nameplate").count():
            break
    if page.locator(".sel-nameplate").count():
        c.check("雙擊圈選 → 樹節點可見且高亮(祖先自動展開)", page.locator('.tree-node[data-active="true"]').count() == 1)
    else:
        c.check("雙擊圈選到零件", False, "raycast 沒中")
    c.check("gantry 無 JS 錯誤", not errors, "; ".join(errors[:2]))
    page.screenshot(path=out_path("smoke_occ_gantry.png"))
    page.close()

    # ── 場景 2:motorized_linear_stage(扁平組合件)不回歸 ──
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors2 = []
    page.on("pageerror", lambda e: errors2.append(str(e)))
    page.goto(glb_page_url("motorized_linear_stage/.motorized_linear_stage.step.glb", "motorized_linear_stage"))
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(2500)
    c.check("stage 組合件初始無面標記", page.locator(".pick-marker").count() == 0)
    page.locator(".props-toggle").click()
    page.wait_for_selector(".tree-node")
    kinds = page.locator(".tree-node .tree-kind").all_inner_texts()
    parts = sum(1 for k in kinds if k == "PART")
    groups = sum(1 for k in kinds if k == "GROUP")
    faces = sum(1 for k in kinds if k == "FACE")
    print(f"  [stage 頂層] GROUP={groups} PART={parts} FACE={faces}")
    c.check("stage 面層預設收合", faces == 0)
    c.check("stage 零件層存在", parts + groups >= 2, f"PART={parts} GROUP={groups}")
    pn = page.locator(".tree-node", has=page.locator(".tree-kind", has_text="PART")).first
    pn.click()
    page.wait_for_timeout(250)
    kinds2 = page.locator(".tree-node .tree-kind").all_inner_texts()
    c.check("stage 點零件展開面層", sum(1 for k in kinds2 if k == "FACE") > 0)
    c.check("stage 無 JS 錯誤", not errors2, "; ".join(errors2[:2]))
    page.screenshot(path=out_path("smoke_occ_stage.png"))
    browser.close()

c.finish()
