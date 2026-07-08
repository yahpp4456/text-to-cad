# -*- coding: utf-8 -*-
"""跨重整續聊煙測(免 LLM):localStorage 種子 → 還原 → 切 v1 看真舊檔 →
「⟲ 回到 v1 繼續」→ v3;過期 session → 誠實文案+清 key;新對話 → 清 key。
先跑 smoke_versions.py 產生 .out/versions_session.json。"""
import json

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

KEY = "cadchat.session.v1"
hand = json.load(open(out_path("versions_session.json"), encoding="utf-8"))
c = Checker()

snap = {
    "sessionId": hand["sessionId"],
    "_seq": 2,
    "items": [
        {"type": "user", "id": "m1", "text": "造一個電動線性滑台"},
        {"type": "ai", "id": "m2", "text": "已完成 v1;之後回退產生 v2。"},
    ],
    "versions": [hand["v1"], hand["v2"]],
    "activeVer": "v2",
    "canvas": {
        "glbUrl": hand["present2"]["glbUrl"],
        "name": hand["name"],
        "code": hand["name"],
        "ver": "v2",
        "status": "ready",
        "type": hand["present2"].get("type", ""),
        "source": "generated",
    },
    "params": {"defs": hand.get("params") or [], "values": {}, "dirty": False},
    "motion": None,
    "savedAt": 0,
}

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── A. 還原 + 切版看真檔 + 回退 ──
    ctx = browser.new_context(viewport={"width": 1480, "height": 920})
    page = ctx.new_page()
    errors, reqs = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: reqs.append(r.url))
    page.add_init_script(f"localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(snap, ensure_ascii=False))})")
    page.goto(BASE)

    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    body = page.locator("body").inner_text()
    c.check("還原通知出現", "已接續上次對話" in body)
    c.check("對話 transcript 還原", "造一個電動線性滑台" in body)
    c.check("版本時間軸還原(2 chips)", page.locator(".version-chip").count() == 2)
    c.check("畫布載入 v2 快照", any("versions%2Fv2" in u for u in reqs))

    # 切 v1 → 載入 v1 快照真檔;回退鈕與下載鈕出現
    page.locator(".version-chip").first.click()
    page.wait_for_timeout(2500)
    c.check("切 v1 → 畫布請求 v1 快照(真舊檔)", any("versions%2Fv1" in u for u in reqs))
    revert_btn = page.locator(".version-revert")
    c.check("非最新版 → 回退鈕出現", revert_btn.count() == 1 and "v1" in revert_btn.inner_text())
    dls = page.locator(".version-dl").all_inner_texts()
    c.check(
        "下載鈕(STEP/STL/3MF/零件包)出現",
        len(dls) == 4 and any("STEP" in t for t in dls) and any("零件包" in t for t in dls),
        str(dls),
    )

    # 回退(server 重建 15 件組合件,約 1-2 分鐘)
    revert_btn.click()
    page.wait_for_function("() => document.querySelectorAll('.version-chip').length >= 3", timeout=300000)
    c.check("回退 → v3 chip 出現", page.locator(".version-chip").count() == 3)
    c.check("回退完成通知", "已回到 v1" in page.locator("body").inner_text())
    page.wait_for_timeout(2500)
    c.check("畫布載入 v3 快照", any("versions%2Fv3" in u for u in reqs))
    saved = page.evaluate(f"() => JSON.parse(localStorage.getItem({json.dumps(KEY)}) || 'null')")
    c.check("持久化快照跟進(含 v3)", bool(saved) and len(saved.get("versions", [])) == 3)

    # ── C. 新對話 → 清 key、狀態全清 ──
    page.locator(".hdr-btn", has_text="新對話").click()
    page.wait_for_timeout(800)
    c.check("新對話 → 續聊快照清除", page.evaluate(f"() => localStorage.getItem({json.dumps(KEY)})") is None)
    c.check("新對話 → 版本清空", page.locator(".version-chip").count() == 0)
    c.check("A 頁無 JS 錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_restore.png"))
    ctx.close()

    # ── B. 過期 session → 誠實文案 + 清 key ──
    ctx2 = browser.new_context(viewport={"width": 1480, "height": 920})
    page2 = ctx2.new_page()
    errors2 = []
    page2.on("pageerror", lambda e: errors2.append(str(e)))
    gone = dict(snap, sessionId="s_gone_xxxxxx")
    page2.add_init_script(f"localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(gone, ensure_ascii=False))})")
    page2.goto(BASE)
    page2.wait_for_timeout(2000)
    body3 = page2.locator("body").inner_text()
    c.check("過期 session → 誠實文案", "已過期" in body3, body3[:120])
    c.check("過期 session → key 已清", page2.evaluate(f"() => localStorage.getItem({json.dumps(KEY)})") is None)
    c.check("過期 → 不殘留版本", page2.locator(".version-chip").count() == 0)
    c.check("B 頁無 JS 錯誤", not errors2, "; ".join(errors2[:3]))
    ctx2.close()
    browser.close()

c.finish()
