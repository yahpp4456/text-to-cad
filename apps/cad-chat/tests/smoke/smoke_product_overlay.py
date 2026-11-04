# -*- coding: utf-8 -*-
"""產品設計分析 overlay(免 LLM):API 成形一份滑鼠殼 → 注入 PRESENT(帶 surfaceUrl)→ 3D 視圖
出五個曲面 chips;__cadSurface 探針斷 overlay 群組 count/visible 與 chip 切換同步;斑馬紋開關
切 mode;注入無 surfaceUrl 的 PRESENT 後 chips 消失、群組歸零。
用法:CADCHAT_BASE=http://127.0.0.1:8899 python smoke_product_overlay.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from _util import BASE, REPO, Checker, out_path, server_alive  # noqa: E402

EX = os.path.join(REPO, "apps", "cad-chat", "src", "lib", "surface", "examples", "mouse_shell.json")


def post_json(path, body):
    req = urllib.request.Request(f"{BASE}{path}", data=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def main() -> int:
    if not server_alive():
        print("server 未啟動,跳過")
        return 1 if os.environ.get("CADCHAT_SMOKE") == "1" else 0
    c = Checker()
    mouse = json.load(open(EX, encoding="utf-8"))
    st, j = post_json("/api/surface-draft", {"name": "mouse", "draft": mouse})
    sid = j.get("sessionId")
    st, b = post_json("/api/surface-build", {"sessionId": sid, "name": "mouse"})
    c.check("A 零 LLM 成形 200", st == 200 and b.get("ok") is True, f"{st} {str(b)[:200]}")
    pres = b.get("present") or {}
    c.check("A present 帶 glbUrl + surfaceUrl", bool(pres.get("glbUrl")) and bool(pres.get("surfaceUrl")))

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_function("() => typeof window.__cadDispatch === 'function'", timeout=30000)
        page.evaluate("d => window.__cadDispatch(d)", {"type": "SET_MODE", "mode": "product"})
        page.evaluate("d => window.__cadDispatch(d)", {
            "type": "PRESENT", "glbUrl": pres["glbUrl"], "name": "mouse", "code": "mouse", "ver": "v1",
            "fileType": "part", "surfaceUrl": pres["surfaceUrl"],
        })
        page.wait_for_selector(".canvas-loading", state="detached", timeout=120000)
        page.wait_for_selector(".tool-chip.surface-toggle[data-key='zebra']", timeout=30000)
        chips = page.locator(".tool-chip.surface-toggle")
        c.check("B 五個曲面 chips 出現", chips.count() == 5, str(chips.count()))
        page.wait_for_function("() => window.__cadSurface && window.__cadSurface.continuity() && window.__cadSurface.continuity().count > 0", timeout=30000)
        cont = page.evaluate("() => window.__cadSurface.continuity()")
        free = page.evaluate("() => window.__cadSurface.freeEdges()")
        cages = page.evaluate("() => window.__cadSurface.cages()")
        combs = page.evaluate("() => window.__cadSurface.combs()")
        c.check("B 連續性 overlay 有線段且預設可見", cont and cont["count"] >= 1 and cont["visible"] is True, str(cont))
        c.check("B 開放邊 overlay 有線段且預設可見(滑鼠殼前後/底 6 條)", free and free["count"] >= 1 and free["visible"] is True, str(free))
        c.check("B 控制點籠/曲率梳 有內容但預設關", cages and cages["count"] >= 1 and cages["visible"] is False and combs and combs["count"] >= 1 and combs["visible"] is False, f"{cages} {combs}")
        summ = page.evaluate("() => window.__cadSurface.summary()")
        c.check("B summary 可讀(G2 接縫)", summ and summ.get("g2", 0) >= 1, str(summ))
        # chips 切換
        page.click(".tool-chip.surface-toggle[data-key='cages']")
        page.wait_for_function("() => window.__cadSurface.cages().visible === true", timeout=5000)
        c.check("C 控制點 chip 開 → 籠可見", page.get_attribute(".tool-chip.surface-toggle[data-key='cages']", "data-on") == "true")
        page.click(".tool-chip.surface-toggle[data-key='continuity']")
        page.wait_for_function("() => window.__cadSurface.continuity().visible === false", timeout=5000)
        c.check("C 連續性 chip 關 → overlay 隱藏", page.get_attribute(".tool-chip.surface-toggle[data-key='continuity']", "data-on") == "false")
        page.click(".tool-chip.surface-toggle[data-key='zebra']")
        page.wait_for_function("() => window.__cadSurface.mode() === 'zebra'", timeout=5000)
        c.check("C 斑馬 chip 開 → mode zebra", page.get_attribute(".tool-chip.surface-toggle[data-key='zebra']", "data-on") == "true")
        page.screenshot(path=out_path("product_overlay_zebra.png"))
        page.click(".tool-chip.surface-toggle[data-key='zebra']")
        page.wait_for_function("() => window.__cadSurface.mode() === 'none'", timeout=5000)
        # 注入無 surfaceUrl 的 PRESENT → chips 消失
        page.evaluate("d => window.__cadDispatch(d)", {"type": "PRESENT", "glbUrl": pres["glbUrl"] + "&x=1", "name": "mouse", "code": "mouse", "ver": "v2", "fileType": "part"})
        page.wait_for_function("() => document.querySelectorAll('.tool-chip.surface-toggle').length === 0", timeout=30000)
        c.check("D 無 surfaceUrl 的版本 → 曲面 chips 消失", True)
        page.wait_for_function("() => !window.__cadSurface.continuity() || window.__cadSurface.continuity().count === 0", timeout=60000)
        c.check("D overlay 群組歸零", True)
        fatal = [e for e in errors if "WebSocket closed without opened" not in e]
        c.check("E 無 JS 錯誤", not fatal, str(fatal)[:300])
        browser.close()
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
