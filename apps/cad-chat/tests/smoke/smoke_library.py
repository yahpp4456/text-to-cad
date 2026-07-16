# -*- coding: utf-8 -*-
"""STP 零件庫 MVP 煙測(免 LLM)。

A. API 收庫:POST /api/library-add(來源=models/ref-cable-sheath/cable_x.stp)
   → 磁碟斷言 parts-library/<slug>/{<slug>.step, meta.json}(size>0、meta 欄位)
   → /api/files 列得到 → POST /api/import 從庫匯入 session ok。
B. 負案:非 .step 檔 400、越界 403、重複 slug 回 exists、overwrite:true 放行。
C. UI(真 FileBrowser):step 列有「收入庫」→ inline 表單(名稱+family)→ 確定
   → fb-notice 成功;庫內檔案列不顯示「收入庫」。
finally 清理本測建立的 parts-library/<slug>。
"""
import json
import os
import re
import shutil

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, out_path, post

c = Checker()
SRC = "ref-cable-sheath/cable_x.stp"
LIB_ROOT = os.path.join(REPO, "models", "parts-library")
made = set()  # 本測建立的 slug(finally 清理)

try:
    # ── A. API 收庫 ──
    j = json.loads(post("/api/library-add", {"file": SRC, "label": "smoke lib api", "family": "other"}, timeout=120))
    c.check("A: library-add ok + slug 淨化", j.get("ok") is True and j.get("slug") == "smoke_lib_api", str(j)[:200])
    slug = j.get("slug") or "smoke_lib_api"
    made.add(slug)
    step_abs = os.path.join(LIB_ROOT, slug, f"{slug}.step")
    meta_abs = os.path.join(LIB_ROOT, slug, "meta.json")
    c.check("A: 磁碟 <slug>.step 存在且非空", os.path.isfile(step_abs) and os.path.getsize(step_abs) > 1000, step_abs)
    meta = json.loads(open(meta_abs, encoding="utf-8").read()) if os.path.isfile(meta_abs) else {}
    c.check("A: meta.json 欄位齊(label/family/addedAt)",
            meta.get("schemaVersion") == 1 and meta.get("label") == "smoke lib api"
            and meta.get("family") == "other" and bool(meta.get("addedAt")), str(meta)[:200])
    c.check("A: bboxMm 為 3 元陣列(inspect facts best-effort)",
            isinstance(meta.get("bboxMm"), list) and len(meta["bboxMm"]) == 3, str(meta.get("bboxMm")))
    from _util import get_with_headers  # noqa: E402
    st, _h, body = get_with_headers("/api/files?dir=parts-library")
    names = [e["name"] for e in json.loads(body.decode("utf-8")).get("entries", [])]
    c.check("A: /api/files 列得到庫目錄", st == 200 and slug in names, str(names)[:150])
    imp = json.loads(post("/api/import", {"file": f"parts-library/{slug}/{slug}.step"}, timeout=120))
    c.check("A: 從庫 cad_import 進 session ok", imp.get("ok") is True and imp.get("rel", "").startswith("imported/"), str(imp)[:200])

    # ── B. 負案 ──
    b1 = json.loads(post("/api/library-add", {"file": "ref-cable-sheath/.cable_x.stp.glb"}, timeout=60))
    c.check("B: 非 .step 拒絕", b1.get("ok") is False and "step" in str(b1.get("error", "")), str(b1)[:150])
    b2 = json.loads(post("/api/library-add", {"file": "../secrets.step"}, timeout=60))
    c.check("B: 越界拒絕(路徑超出 models/)", b2.get("ok") is False and "models" in str(b2.get("error", "")), str(b2)[:150])
    b3 = json.loads(post("/api/library-add", {"file": SRC, "label": "smoke lib api"}, timeout=120))
    c.check("B: 重複 slug 回 exists(不靜默覆蓋)", b3.get("ok") is False and b3.get("error") == "exists", str(b3)[:150])
    b4 = json.loads(post("/api/library-add", {"file": SRC, "label": "smoke lib api", "overwrite": True}, timeout=120))
    c.check("B: overwrite:true 放行", b4.get("ok") is True, str(b4)[:150])
    b5 = json.loads(post("/api/library-add", {"file": f"parts-library/{slug}/{slug}.step"}, timeout=60))
    c.check("B: 已在庫內的檔拒收(不套娃)", b5.get("ok") is False, str(b5)[:150])

    # ── C. UI:FileBrowser 收入庫 inline 表單 ──
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1480, "height": 920})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".hdr-btn")
        page.locator(".hdr-btn", has_text="開啟檔案").click()
        page.wait_for_selector(".fb-list")
        page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
        page.wait_for_selector(".fb-name.fb-dir")
        page.locator(".fb-name.fb-dir", has_text="ref-cable-sheath").click()
        # 目錄列表 fetch 非同步:先等目標列出現再斷言(否則量到舊 DOM)
        page.wait_for_selector(".fb-row >> text=cable_y.stp", timeout=15000)
        row = page.locator(".fb-row", has_text="cable_y.stp").first
        c.check("C: step 列有「收入庫」鈕", row.locator(".fb-action", has_text="收入庫").count() == 1)
        row.locator(".fb-action", has_text="收入庫").click()
        form = page.locator(".fb-lib-form")
        c.check("C: inline 表單出現(名稱輸入 + family 快選)",
                form.count() == 1 and form.locator("input.fb-lib-input").count() == 1
                and form.locator("select.fb-lib-input").count() == 1)
        form.locator("input.fb-lib-input").fill("smoke lib ui")
        form.locator("select.fb-lib-input").select_option("cylinder")
        made.add("smoke_lib_ui")
        form.locator(".fb-action", has_text=re.compile(r"^確定$")).click()
        page.wait_for_selector(".fb-notice", timeout=120000)
        note = page.locator(".fb-notice").inner_text()
        c.check("C: 成功訊息含庫路徑", "parts-library/smoke_lib_ui" in note, note)
        c.check("C: 磁碟落檔", os.path.isfile(os.path.join(LIB_ROOT, "smoke_lib_ui", "smoke_lib_ui.step")))
        # 庫內檔不顯示「收入庫」(不套娃)
        page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
        page.wait_for_selector(".fb-name.fb-dir")
        page.locator(".fb-name.fb-dir", has_text=re.compile(r"^▸ parts-library/$")).click()
        page.wait_for_selector(".fb-row >> text=smoke_lib_ui", timeout=15000)
        page.locator(".fb-name.fb-dir", has_text="smoke_lib_ui").click()
        page.wait_for_selector(".fb-row >> text=smoke_lib_ui.step", timeout=15000)
        lib_row = page.locator(".fb-row", has_text="smoke_lib_ui.step").first
        c.check("C: 庫內檔列無「收入庫」鈕(有開啟/匯入場景)",
                lib_row.locator(".fb-action", has_text="收入庫").count() == 0
                and lib_row.locator(".fb-action", has_text=re.compile(r"^開啟$")).count() == 1)
        real_errs = [e for e in errs if "WebSocket closed without opened" not in e]
        c.check("C: 全程無 JS 錯誤(HMR ws 雜訊除外)", not real_errs, "; ".join(real_errs[:3]))
        page.screenshot(path=out_path("smoke_library.png"))
        browser.close()
finally:
    for slug in made:
        shutil.rmtree(os.path.join(LIB_ROOT, slug), ignore_errors=True)
    # parts-library 空了就順手移除(不留空殼;有他人收藏則保留)
    try:
        if os.path.isdir(LIB_ROOT) and not os.listdir(LIB_ROOT):
            os.rmdir(LIB_ROOT)
    except OSError:
        pass

c.finish()
