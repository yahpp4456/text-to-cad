# -*- coding: utf-8 -*-
"""用 Playwright 開 file://index.html 自我驗證手冊,並截幾張圖供人工複核框線對齊。

斷言是**精確等式**,期望值從 content.GUIDE + img/*.json 現算,不是拍腦袋下限
(舊版 chaps>=10/figs>=15/boxes>=20 對實際 12/24/~60 緩衝過大,掉三分之二的框
仍 PASS——review 2026-07-16):
  - 章數 == len(GUIDE.chapters)、圖數 == figure 塊數(含 fig-missing,等式仍成立)
  - 框數 == 所有被引用 img/*.json 的 rect 非 None callout 總和,且**任何 rect=None
    都是硬失敗**(那是 capture 端 UI 漂移的訊號)
  - 零缺圖、零破圖、零 JS 錯誤

防線分工:本檔驗「組裝完整性 + 框完整性」;「截圖是否過期(UI 已改版沒重擷)」
不在此——那條防線在重跑 capture.py 的硬閘(selector 解析不到即失敗)。
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

from guidelib import GUIDE, IMG

from content import GUIDE as CONTENT_GUIDE

FNAME = sys.argv[1] if len(sys.argv) > 1 else "index.html"
URL = "file:///" + os.path.join(GUIDE, FNAME).replace("\\", "/")
OUT = os.path.join(IMG, ".verify")
os.makedirs(OUT, exist_ok=True)


def _load_shot_meta(shot_id):
    p = os.path.join(IMG, shot_id + ".json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def expected_from_content():
    """從文案 + 截圖中繼現算期望值:(章數, 圖數, 框數, problems)。

    與 assemble.render_figure 同一套 shot/fallback 解析:一個 figure 塊渲染出的
    .cap 數 = 其解析到的 json 中 rect 非 None 的 callout 數。rect=None / json 缺失
    記進 problems(硬失敗)。
    """
    chapters = CONTENT_GUIDE["chapters"]
    fig_blocks = [b for ch in chapters for b in ch["blocks"] if b["type"] == "figure"]
    boxes = 0
    problems = []
    for b in fig_blocks:
        sid = b["shot"]
        meta = _load_shot_meta(sid)
        if meta is None and b.get("fallback"):
            sid = b["fallback"]
            meta = _load_shot_meta(sid)
        if meta is None:
            problems.append(f"{b['shot']}: 缺 img/{b['shot']}.json(尚未擷取)")
            continue
        for c in meta.get("callouts", []):
            if c.get("rect"):
                boxes += 1
            else:
                problems.append(f"{sid}: callout {c.get('n')}「{c.get('label', '')}」rect=None(UI 漂移?重跑 capture)")
    return len(chapters), len(fig_blocks), boxes, problems


def main():
    exp_chaps, exp_figs, exp_boxes, problems = expected_from_content()

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
        print(f"chapters={chaps}/{exp_chaps}  figures={figs}/{exp_figs}  boxes={boxes}/{exp_boxes}"
              f"  missing-figs={missing}  broken-imgs={broken}")
        print(f"pageerrors={errs[:3] if errs else 'none'}")
        for pr in problems:
            print(f"  ✗ {pr}")

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

    ok = (
        chaps == exp_chaps
        and figs == exp_figs
        and boxes == exp_boxes
        and missing == 0
        and broken == 0
        and not errs
        and not problems
    )
    print("== VERIFY " + ("PASS" if ok else "FAIL") + " ==")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
