# -*- coding: utf-8 -*-
"""具名姿態與動作序列的畫布操作(藍圖 D3;免 LLM)。

用 ?glb=&motion= 預覽捷徑載入齒輪齒條模型,MOTION 帶兩個姿態與一條序列。驗:
- 姿態 chip 與序列 chip 出現在「運動示意」旁邊;
- 點姿態 chip → 零件真的擺到那個位置(讀 effectMatrix),從動的齒輪跟著主動的齒條轉;再點一次回到建成姿態;
- 序列的中間位置是兩個姿態之間的內插;點序列 chip 走完後停在最後一個姿態;
- 姿態與往復示意互斥。
fixture GLB 是 LFS pointer(數百 byte)時直接紅並提示重生,不假綠。
"""
import json
import math
import os
import urllib.parse

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, evidence_shot, out_path, REPO

c = Checker()
GLB_REL = "steering_box_rack_pinion/.steering_box_rack_pinion.step.glb"
glb_abs = os.path.join(REPO, "models", GLB_REL.replace("/", os.sep))
c.check("fixture GLB 是實體檔(不是 LFS pointer)", os.path.exists(glb_abs) and os.path.getsize(glb_abs) > 10_000,
        f"{glb_abs} size={os.path.getsize(glb_abs) if os.path.exists(glb_abs) else None}")

STROKE = 7.6969  # m0.7 z14:90° 的齒條行程 R·π/2
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "stroke", "type": "linear", "axis": [0, 1, 0], "travel": -STROKE, "period_s": 4, "moving": ["rack"]},
        {"id": "swing", "type": "revolute", "axis": [0, 0, 1], "pivot": [0, 0, 67.5], "angle_deg": 90,
         "period_s": 4, "couple": "stroke", "moving": ["pinion"]},
    ],
    "states": {"home": {"stroke": 0.0}, "half": {"stroke": 0.5}, "end": {"stroke": 1.0}},
    "sequences": {"turn": ["home", "end"]},
}
url = (
    BASE + "/?glb=" + urllib.parse.quote("/api/asset?file=" + urllib.parse.quote(GLB_REL, safe=""), safe="")
    + "&name=steering_box&motion=" + urllib.parse.quote(json.dumps(MOTION), safe="")
)


def rack_y(page):
    m = page.evaluate("() => window.__cadMotion.matrixFor('rack')")
    return None if m is None else m[13]


def pinion_cos(page):
    m = page.evaluate("() => window.__cadMotion.matrixFor('pinion')")
    return None if m is None else m[0]


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(url)
    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page.wait_for_function("() => window.__cadMotion && window.__cadMotion.coverage && window.__cadMotion.coverage() === 1",
                           timeout=30000)

    c.check("dev 鉤讀得到宣告的姿態與序列",
            page.evaluate("() => [window.__cadMotion.states(), window.__cadMotion.sequences()]") == [["home", "half", "end"], ["turn"]])
    chips = page.locator("[data-testid='pose-chips'] .pose-chip")
    c.check("姿態 chip 3 個 + 序列 chip 1 個,接在運動示意後面",
            page.locator(".pose-chip[data-pose]").count() == 3 and page.locator(".pose-chip[data-sequence]").count() == 1
            and page.locator(".motion-toggle").count() == 1, f"n={chips.count()}")
    c.check("序列 chip 的提示寫出它經過哪些姿態",
            "home → end" in (page.locator(".pose-chip[data-sequence='turn']").get_attribute("title") or ""))

    # 點「half」:齒條走一半,從動的齒輪轉 45°
    page.locator(".pose-chip[data-pose='half']").click()
    page.wait_for_function("() => window.__cadMotion.pose() && window.__cadMotion.matrixFor('rack') !== null", timeout=5000)
    page.wait_for_timeout(120)
    c.check("點姿態 chip → 定格在該姿態(chip 亮起)",
            page.evaluate("() => window.__cadMotion.pose()") == {"kind": "state", "name": "half"}
            and page.locator(".pose-chip[data-pose='half']").get_attribute("data-on") == "true")
    y_half, cos_half = rack_y(page), pinion_cos(page)
    c.check("half:齒條位移是行程的一半", y_half is not None and abs(y_half - (-STROKE / 2)) < 1e-3, f"y={y_half}")
    c.check("half:從動的齒輪跟著轉 45°(couple 生效)", cos_half is not None and abs(cos_half - math.cos(math.radians(45))) < 1e-3,
            f"cos={cos_half}")

    # 換到「end」
    page.locator(".pose-chip[data-pose='end']").click()
    page.wait_for_function(f"() => Math.abs((window.__cadMotion.matrixFor('rack') || [])[13] - ({-STROKE})) < 1e-3", timeout=5000)
    c.check("換到另一個姿態:齒條到底、齒輪轉 90°",
            abs(rack_y(page) - (-STROKE)) < 1e-3 and abs(pinion_cos(page)) < 1e-3, f"y={rack_y(page)} cos={pinion_cos(page)}")
    c.check("同一時間只有一個姿態 chip 亮", page.locator(".pose-chip[data-on='true']").count() == 1)

    # 再點一次 → 回到建成姿態
    page.locator(".pose-chip[data-pose='end']").click()
    page.wait_for_function("() => window.__cadMotion.pose() === null", timeout=5000)
    page.wait_for_timeout(120)
    c.check("再點一次同一個姿態 → 回到建成姿態(effectMatrix 清掉、chip 熄)",
            rack_y(page) is None and page.locator(".pose-chip[data-on='true']").count() == 0, f"y={rack_y(page)}")

    # 序列的中間位置 = 內插(用 dev 鉤直接擺,不靠時間)
    page.evaluate("() => window.__cadMotion.applySequenceAt('turn', 0.25)")
    c.check("序列走到 1/4:齒條位移是行程的 1/4", abs(rack_y(page) - (-STROKE / 4)) < 1e-3, f"y={rack_y(page)}")

    # 點序列 chip:走完停在最後一個姿態
    page.locator(".pose-chip[data-sequence='turn']").click()
    page.wait_for_function("() => { const p = window.__cadMotion.pose(); return p && p.kind === 'state' && p.name === 'end'; }",
                           timeout=8000)
    page.wait_for_timeout(120)
    c.check("點序列 chip → 走完後停在最後一個姿態(end chip 亮、齒條到底)",
            abs(rack_y(page) - (-STROKE)) < 1e-3 and page.locator(".pose-chip[data-pose='end']").get_attribute("data-on") == "true",
            f"y={rack_y(page)}")

    # 與往復示意互斥
    page.locator(".motion-toggle").click()
    page.wait_for_function("() => window.__cadMotion.pose() === null", timeout=5000)
    c.check("按運動示意 → 姿態 chip 全熄(兩者互斥)", page.locator(".pose-chip[data-on='true']").count() == 0)
    page.locator(".pose-chip[data-pose='home']").click()
    page.wait_for_function("() => window.__cadMotion.pose() !== null", timeout=5000)
    c.check("播放中點姿態 chip → 往復示意停下", page.locator(".motion-toggle").get_attribute("data-on") != "true")

    evidence_shot(page, "smoke_pose_chips.png")
    c.check("全程無 JS 錯誤", not errs, "; ".join(errs[:3]))
    browser.close()

c.finish()
