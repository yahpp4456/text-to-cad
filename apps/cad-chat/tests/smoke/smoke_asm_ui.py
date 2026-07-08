# -*- coding: utf-8 -*-
"""組合件互動煙測:面標記閘門 / 已帶入高亮 / 巢狀樹 / 面級填色 / ◇ 面標記面板。"""
from playwright.sync_api import sync_playwright

from _util import Checker, glb_page_url, out_path

URL = glb_page_url("motorized_linear_stage/.motorized_linear_stage.step.glb", "motorized_linear_stage")
c = Checker()


def fill_count(page):
    return page.evaluate("() => window.__cadFaceFill?.count() ?? -1")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_timeout(2500)  # selector bundle 載入 + topo build

    # ── 1. 組合件:無圈選 → 不顯示面標記,提示文案是引導句 ──
    c.check("組合件初始無面標記", page.locator(".pick-marker").count() == 0)
    hint = page.locator(".model-pick-hint").inner_text()
    c.check("提示引導點擊圈選", "點擊圈選零件" in hint and "顯示面標記" in hint, hint)

    # ── 2. 屬性抽屜:巢狀樹,零件層可見、面層預設收合 ──
    page.locator(".props-toggle").click()
    page.wait_for_selector(".tree-node")
    labels = page.locator(".tree-node .tree-kind").all_inner_texts()
    parts0 = sum(1 for k in labels if k == "PART")
    faces0 = sum(1 for k in labels if k == "FACE")
    c.check("樹有零件層", parts0 >= 2, f"PART={parts0}")
    c.check("面層預設收合", faces0 == 0, f"FACE={faces0}")

    part_node = page.locator(".tree-node", has=page.locator(".tree-kind", has_text="PART")).first
    part_pad = part_node.evaluate("el => parseInt(getComputedStyle(el).paddingLeft)")
    part_node.click()
    page.wait_for_timeout(300)
    labels2 = page.locator(".tree-node .tree-kind").all_inner_texts()
    faces1 = sum(1 for k in labels2 if k == "FACE")
    c.check("點零件展開面層", faces1 > 0, f"FACE={faces1}")
    if faces1:
        face_node = page.locator(".tree-node", has=page.locator(".tree-kind", has_text="FACE")).first
        face_pad = face_node.evaluate("el => parseInt(getComputedStyle(el).paddingLeft)")
        c.check("面層縮排更深(兩層)", face_pad > part_pad, f"part={part_pad}px face={face_pad}px")
    c.check("零件節點有摺疊箭頭", part_node.locator(".tree-caret").count() == 1)

    # ── 3. 雙擊圈選 → 面標記出現(只屬被圈選件) ──
    box = page.locator("canvas.cad-canvas").bounding_box()
    got_sel = False
    for dx, dy in [(0, 0), (0.12, 0), (-0.12, 0), (0, 0.15), (0.2, 0.1), (-0.2, -0.1)]:
        page.mouse.dblclick(box["x"] + box["width"] * (0.5 + dx), box["y"] + box["height"] * (0.5 + dy))
        page.wait_for_timeout(400)
        if page.locator(".sel-nameplate").count():
            got_sel = True
            break
    c.check("雙擊圈選到零件", got_sel)
    if got_sel:
        page.wait_for_timeout(300)
        n1 = page.locator(".pick-marker").count()
        c.check("圈選後面標記出現", 0 < n1 <= 12, f"markers={n1}")
        # ?glb= 預覽沒有 session → 拆件匯出鈕(⤓ STEP/STL)必須藏(onExportParts=null)
        c.check("?glb= 預覽 nameplate 無拆件匯出鈕", page.locator(".sel-export").count() == 0)

        # ── 4. 面級填色:hover 菱形 → 面亮(預覽);點菱形 → chip + 面持續亮 ──
        # 雙擊後滑鼠可能正停在菱形上(hover 填色已觸發)→ 先移開再量初始值
        page.mouse.move(box["x"] + 4, box["y"] + box["height"] - 4)
        page.wait_for_timeout(250)
        c.check("初始無面填色", fill_count(page) == 0, f"count={fill_count(page)}")
        page.locator(".pick-marker").first.hover()
        page.wait_for_timeout(250)
        hover_n = fill_count(page)
        c.check("hover 菱形 → 面填色預覽", hover_n >= 1, f"count={hover_n}")

        page.locator(".pick-marker").first.click()
        page.wait_for_timeout(250)
        chips = page.locator(".pick-chip").count()
        c.check("點菱形 → composer chip", chips >= 1, f"chips={chips}")
        c.check("菱形高亮(已帶入)", page.locator('.pick-marker[data-cited="true"]').count() == 1)
        page.mouse.move(box["x"] + 4, box["y"] + box["height"] - 4)  # 移開 → hover 熄
        page.wait_for_timeout(250)
        cited_n = fill_count(page)
        c.check("已帶入的面持續填色(hover 已離開)", cited_n >= 1, f"count={cited_n}")

        # ── 5. 名牌「帶入對話」→ ✓ 已帶入;移除 chip → 高亮與填色全熄 ──
        page.locator(".sel-action:not(.sel-clear)").first.click()
        page.wait_for_timeout(200)
        c.check("名牌轉 ✓ 已帶入", page.locator('.sel-action[data-cited="true"]').count() == 1)

        while page.locator(".pick-chip .pick-clear").count():
            page.locator(".pick-chip .pick-clear").first.click()
            page.wait_for_timeout(120)
        c.check("移除 chips → 菱形高亮熄滅", page.locator('.pick-marker[data-cited="true"]').count() == 0)
        c.check("移除 chips → 名牌回可帶入", page.locator('.sel-action[data-cited="true"]').count() == 0)
        c.check("移除 chips → 面填色熄滅", fill_count(page) == 0, f"count={fill_count(page)}")

        # ── 6. ◇ 面標記面板:候選不設限、預設散佈 6、全部/隱藏/預設快切、逐面勾選 ──
        st = page.evaluate("() => window.__cadMarkers?.state?.() ?? null")
        c.check("__cadMarkers 探針存在", bool(st), str(st))
        if st:
            c.check("預設模式且候選 ≥ 可見", st["mode"] == "default" and st["total"] >= st["visible"], str(st))
            page.locator(".marker-toggle").click()
            page.wait_for_selector(".marker-panel", timeout=5000)
            c.check("面板列數 = 候選數", page.locator(".marker-row").count() == st["total"])

            page.locator(".marker-panel-acts a", has_text="全部").click()
            page.wait_for_timeout(250)
            c.check("全部 → 菱形數 = 候選數", page.locator(".pick-marker").count() == st["total"])
            page.locator(".marker-panel-acts a", has_text="隱藏").click()
            page.wait_for_timeout(250)
            c.check("隱藏 → 0 顆", page.locator(".pick-marker").count() == 0)
            page.locator(".marker-panel-acts a", has_text="預設").click()
            page.wait_for_timeout(250)
            c.check("預設 → 回原本可見數", page.locator(".pick-marker").count() == st["visible"])

            if st["visible"] >= 1:
                page.locator(".marker-row input:checked").first.click()
                page.wait_for_timeout(250)
                st2 = page.evaluate("() => window.__cadMarkers.state()")
                c.check(
                    "勾掉一面 → custom 且少一顆",
                    st2["mode"] == "custom" and st2["visible"] == st["visible"] - 1,
                    str(st2),
                )
            page.locator(".marker-toggle").click()  # 收面板,別擋後續截圖

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_asm_ui.png"))
    browser.close()

c.finish()
