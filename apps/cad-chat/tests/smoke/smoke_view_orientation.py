# -*- coding: utf-8 -*-
"""ViewCube 26 向視角 + 平面右鍵「正視於」煙測。免 LLM/session。"""
from playwright.sync_api import sync_playwright

from _util import Checker, glb_page_url, out_path

c = Checker()
URL = glb_page_url("motorized_linear_stage/.motorized_linear_stage.step.glb", "stage")


def near(a, b, eps=1e-3):
    return abs(float(a) - float(b)) <= eps


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_function("() => !!window.__cadView && window.__cadView.faceRows().length > 0")

    c.check("ViewCube 出現", page.locator(".view-cube").count() == 1)
    c.check("六面直達鍵完整", page.locator(".view-cube-axis-strip button").count() == 6)
    c.check("ViewCube 有收合控制", page.locator(".view-cube-collapse").count() == 1)
    page.locator(".view-cube-collapse").click()
    c.check(
        "ViewCube 可收合為迷你入口",
        page.locator(".view-cube").get_attribute("data-collapsed") == "true"
        and page.locator(".view-cube-expand").count() == 1
        and page.locator(".view-cube-axis-strip").count() == 0,
    )
    page.locator(".view-cube-expand").click()
    c.check(
        "迷你入口可重新展開",
        page.locator(".view-cube").get_attribute("data-collapsed") is None
        and page.locator(".view-cube-axis-strip button").count() == 6,
    )
    preset_ids = page.evaluate("() => window.__cadView.presetIds()")
    c.check("視角預設 = 26 向", len(preset_ids) == 26, str(preset_ids))
    # 開機/預設方向必須離所有 preset 夠遠:舊值 [1,-1,0.8] 與角落 [1,-1,1] 的
    # dot≈0.9949 過 0.985 閾值,載入當下 ViewCube 就誤亮 x-yNeg-z。
    c.check(
        "載入後不誤標任何 preset active",
        page.evaluate("() => window.__cadView.active()") == "",
        page.evaluate("() => window.__cadView.active()"),
    )

    # 真 UI 點擊上視鍵,再從 WebGL dev 鉤確認相機方向。
    page.locator(".view-cube-axis-strip button[title='上視圖']").click()
    page.wait_for_timeout(420)  # 產品相機 transition=280ms + buffer
    camera = page.evaluate("() => window.__cadView.camera()")
    c.check(
        "點上視鍵 → 相機沿 +Z",
        bool(camera)
        and near(camera["direction"][0], 0, 2e-3)
        and near(camera["direction"][1], 0, 2e-3)
        and near(camera["direction"][2], 1, 2e-3),
        str(camera),
    )
    c.check("上視 active 狀態同步", page.evaluate("() => window.__cadView.active()") == "z")

    # 上視/正視於會把 camera.up 帶離世界 Z(頂視= [0,1,0]),但 OrbitControls
    # 軌道軸在建構時已鎖 Z——up 不一致時 lookAt 滾轉基準與軌道軸打架,拖曳會
    # 扭轉(舊行為要按 ISO 才復原)。修法=任何互動開始瞬間收回世界 Z。
    # 必須在「尚無任何互動」的此刻測:雙擊圈選等後續步驟本身就是互動,
    # up 會提早被收回,前置斷言就咬不到了。
    c.check(
        "上視後 up 為 [0,1,0](前置,證明本測有咬到)",
        all(abs(camera["direction"][i] - e) < 2e-3 for i, e in enumerate([0, 0, 1]))
        and abs(camera["up"][2]) < 1e-3 and abs(camera["up"][1] - 1) < 1e-3,
        str(camera["up"]),
    )
    vp = page.locator(".viewport").bounding_box()
    cx, cy = vp["x"] + vp["width"] / 2, vp["y"] + vp["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 80, cy + 50, steps=6)
    page.mouse.up()
    page.wait_for_timeout(200)
    camera = page.evaluate("() => window.__cadView.camera()")
    c.check(
        "開始拖曳旋轉 → up 收回世界 Z(軌道軸一致)",
        all(abs(camera["up"][i] - e) < 1e-6 for i, e in enumerate([0, 0, 1])),
        str(camera["up"]),
    )
    # 拖曳把相機轉到隨機斜角,先 ISO 復位,後續面標記段才有確定視角
    # (斜角+推近後平面標記可能落在頂部工具列底下,right-click 會被攔)。
    page.locator(".view-cube-head button", has_text="ISO").click()
    page.wait_for_timeout(440)

    # stage 是組合件:面標記契約=「先圈選零件,候選只含被圈選件的面」
    # (Canvas3D markerCandidates;無圈選=零標記是產品刻意行為,smoke_asm_ui
    # 已釘死)。所以先雙擊圈選一件,再展開全部面標記找平面。
    box = page.locator("canvas.cad-canvas").bounding_box()
    got_sel = False
    for dx, dy in [(0, 0), (0.12, 0), (-0.12, 0), (0, 0.15), (0.2, 0.1), (-0.2, -0.1)]:
        page.mouse.dblclick(box["x"] + box["width"] * (0.5 + dx), box["y"] + box["height"] * (0.5 + dy))
        page.wait_for_timeout(400)
        if page.locator(".sel-nameplate").count():
            got_sel = True
            break
    c.check("雙擊圈選到零件(面標記前置)", got_sel)
    # 展開全部面標記,再找平面;避免抽樣標記剛好全是曲面。
    page.locator(".tool-chip.marker-toggle").click()
    page.locator(".marker-panel-acts a", has_text="全部").click()
    page.wait_for_function("() => window.__cadView.faceRows().length > 6")
    page.wait_for_selector(".pick-marker[data-face-row]", timeout=10000)

    # 用使用者實際入口:右鍵菱形 → 正視於。
    marker_rows = page.locator(".pick-marker[data-face-row]").evaluate_all(
        "(els) => els.map((el) => Number(el.dataset.faceRow))",
    )
    planar_row = page.evaluate(
        """(rows) => rows.find((row) => window.__cadView.availability(row).available) ?? null""",
        marker_rows,
    )
    c.check("可見面標記中有平面", planar_row is not None, str(marker_rows))
    if planar_row is not None:
        marker = page.locator(f".pick-marker[data-face-row='{planar_row}']")
        marker.click(button="right")
        menu = page.locator(".face-context-menu")
        c.check("右鍵面 → 面視角選單出現", menu.count() == 1)
        action = menu.locator("button", has_text="正視於")
        c.check("平面的正視於可用", action.count() == 1 and action.is_enabled())
        facts = page.evaluate("(row) => window.__cadMeasure.faceFactsOf(row)", planar_row)
        action.click()
        page.wait_for_timeout(460)  # 正視於 transition=320ms + buffer
        camera = page.evaluate("() => window.__cadView.camera()")
        direction = camera["direction"]
        normal = facts["normal"]
        normal_len = sum(value * value for value in normal) ** 0.5
        aligned = abs(sum(direction[i] * normal[i] / normal_len for i in range(3)))
        c.check("正視於 → 視線平行面法向", aligned > 0.999, f"dot={aligned} camera={camera}")
        c.check(
            "正視於 → 相機 target 為面中心",
            all(near(camera["target"][i], facts["center"][i], 2e-3) for i in range(3)),
            f"target={camera['target']} center={facts['center']}",
        )
        c.check("執行後選單關閉", page.locator(".face-context-menu").count() == 0)

    # 右鍵拖曳=OrbitControls 平移,Windows 在 mouseup 照發 contextmenu:
    # 拖曳守衛(位移>5px)必須吞掉事件,不得彈「正視於」選單。
    vp = page.locator(".viewport").bounding_box()
    cx, cy = vp["x"] + vp["width"] / 2, vp["y"] + vp["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down(button="right")
    page.mouse.move(cx + 60, cy + 40, steps=5)
    page.mouse.up(button="right")
    page.wait_for_timeout(150)
    c.check("右鍵拖曳平移不彈正視於選單", page.locator(".face-context-menu").count() == 0)

    # Home 必須是獨立按鈕,且不覆蓋 ViewCube 的面/稜/角熱區。
    page.locator(".view-cube-head button", has_text="ISO").click()
    page.wait_for_timeout(440)
    camera = page.evaluate("() => window.__cadView.camera()")
    c.check(
        "ISO Home 回到等角方向",
        bool(camera) and camera["direction"][0] > 0 and camera["direction"][1] < 0 and camera["direction"][2] > 0,
        str(camera),
    )

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_view_orientation.png"))
    browser.close()

c.finish()
