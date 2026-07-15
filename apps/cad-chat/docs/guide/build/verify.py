# -*- coding: utf-8 -*-
"""用 Playwright 開 file://index.html 自我驗證手冊:斷言章節/圖/框數、零 JS 錯誤,
並截幾張圖供人工複核框線是否對齊元件。"""
import os
import sys

from playwright.sync_api import sync_playwright

from guidelib import GUIDE, IMG

FNAME = sys.argv[1] if len(sys.argv) > 1 else "index.html"
URL = "file:///" + os.path.join(GUIDE, FNAME).replace("\\", "/")
OUT = os.path.join(IMG, ".verify")
os.makedirs(OUT, exist_ok=True)


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1280, "height": 1600}, device_scale_factor=1)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append("console.error:" + m.text) if m.type == "error" else None)
        pg.goto(URL)
        pg.wait_for_load_state("networkidle")
        # 強制 eager 並等所有圖載入完成(避開 loading=lazy 的離屏誤判)
        pg.evaluate("() => document.querySelectorAll('img').forEach(i => { i.loading='eager'; })")
        try:
            pg.wait_for_function(
                "() => [...document.images].every(i => i.complete && i.naturalWidth > 0)",
                timeout=20000,
            )
        except Exception:
            pass

        chaps = pg.locator(".chap").count()
        figs = pg.locator(".fig").count()
        boxes = pg.locator(".cap").count()
        missing = pg.locator(".fig-missing").count()
        broken = pg.evaluate(
            "() => [...document.images].filter(i => !i.complete || i.naturalWidth===0).length"
        )
        print(f"chapters={chaps}  figures={figs}  boxes={boxes}  missing-figs={missing}  broken-imgs={broken}")
        print(f"pageerrors={errs[:3] if errs else 'none'}")

        # 頂部(hero + 側欄 TOC)
        pg.screenshot(path=os.path.join(OUT, "top.png"))
        # 幾個關鍵章節的整段(檢查框線對齊)
        for cid in ["ch0", "ch3", "ch7"]:
            el = pg.locator(f"#{cid}")
            if el.count():
                el.first.scroll_into_view_if_needed()
                pg.wait_for_timeout(200)
                el.first.screenshot(path=os.path.join(OUT, f"{cid}.png"))
        b.close()

    ok = chaps >= 10 and figs >= 15 and boxes >= 20 and missing == 0 and broken == 0 and not errs
    print("== VERIFY " + ("PASS" if ok else "FAIL") + " ==")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
