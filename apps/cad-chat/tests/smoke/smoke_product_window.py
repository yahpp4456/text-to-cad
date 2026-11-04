# -*- coding: utf-8 -*-
"""曲面草稿工作窗煙測(產品設計;免 LLM)。

A. API:POST /api/surface-draft(無 sessionId,mouse_shell 範例)mint product session →
   POST /api/surface-build → v1(glbUrl/surfaceUrl)。
B. UI:注入 SET_MODE product + SET_SESSION + PRESENT + SET_SURFACE_DRAFT(source ai)→ 窗自動開
   (.surface-window、__cadSurfaceWin.open)、曲線列數=草稿曲線數、GLB 載入後 3D 把手 count>0。
C. 數值編輯:選第一條曲線 → 改第 1 點 x(fill+Tab)→ dirty → 自動保存 → GET 草稿 revision+1
   且點已改;零 /api/chat。
D. 3D 拖曳(__cadSurfaceWin.drag 走與 pointer 相同路)→ 點改、歷史 +1、自動保存 revision+1。
E. 復原/重做:undo → 點回原值;redo → 再改;各自自動保存。
F. 驗證:選第一個曲面 → sections 填不存在的 id → .surfwin-err 出現、確認鈕 data-disabled;
   undo 清掉。
G. 確認生成:.surfwin-build → v2、present.surfaceUrl 跟版、窗仍開、把手仍在。
H. 409:用 API 對同草稿 patch(模擬對話改草稿)→ UI 再改值 → 自動保存撞 409 → 窗重載伺服端
   草稿(revision 對齊、.surfwin-notice 出現、本地改動消失)。
I. 重整回灌:reload → 「✎ 草稿」chip 開窗 → 草稿仍在(localStorage)。
J. 捨棄:兩段式 .surfwin-discard → 窗關、GET 草稿 draft=null;chip 變「✎ 草稿 +」。
用法:CADCHAT_BASE=http://127.0.0.1:8788 python smoke_product_window.py
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from _util import BASE, REPO, Checker, post, server_alive  # noqa: E402

EX = os.path.join(REPO, "apps", "cad-chat", "src", "lib", "surface", "examples")


def get_json(path):
    import urllib.request
    with urllib.request.urlopen(f"{BASE}{path}", timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    if not server_alive():
        print(f"[skip] server 不可達 {BASE}")
        sys.exit(1 if os.environ.get("CADCHAT_SMOKE") else 0)
    c = Checker()
    with open(os.path.join(EX, "mouse_shell.json"), encoding="utf-8") as f:
        mouse = json.load(f)
    name = "mousewin"

    # ── A ──
    j = json.loads(post("/api/surface-draft", {"name": name, "draft": mouse}))
    sid = j.get("sessionId")
    c.check("A: 草稿 mint product session", j.get("ok") is True and bool(sid) and j.get("revision") == 1, str(j)[:160])
    b = json.loads(post("/api/surface-build", {"sessionId": sid, "name": name}, timeout=600))
    c.check("A: 零 LLM 生成 v1 帶 surfaceUrl", b.get("ok") is True and (b.get("present") or {}).get("ver") == "v1" and bool(b["present"].get("surfaceUrl")), str(b)[:200])
    present = b["present"]
    rev = j["revision"]
    draft = j["draft"]
    first_curve = draft["curves"][0]["id"]
    first_surface = draft["surfaces"][0]["id"]

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 950})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        chats = []
        page.on("request", lambda r: chats.append(r.url) if "/api/chat" in r.url else None)
        page.goto(BASE)
        page.wait_for_selector(".hdr-btn")
        page.evaluate("() => window.__cadDispatch({ type: 'SET_MODE', mode: 'product' })")
        page.evaluate("sid => window.__cadDispatch({ type: 'SET_SESSION', sessionId: sid })", sid)
        page.evaluate("v => window.__cadDispatch({ type: 'ADD_VERSION', version: v })", b["version"])
        page.evaluate(
            "pr => window.__cadDispatch({ type: 'PRESENT', glbUrl: pr.glbUrl, name: pr.name, code: pr.code, ver: pr.ver, fileType: pr.type || '', surfaceUrl: pr.surfaceUrl })",
            present)
        page.evaluate(
            "sd => window.__cadDispatch({ type: 'SET_SURFACE_DRAFT', surfaceDraft: sd })",
            {"name": name, "revision": rev, "draft": draft, "source": "ai"})
        # ── B ──
        page.wait_for_selector(".surface-window", timeout=15000)
        c.check("B: AI 草稿到達 → 窗自動開", page.evaluate("() => window.__cadSurfaceWin.open()") is True)
        c.check("B: 曲線列數=草稿曲線數",
                page.locator(".surfwin-row[data-kind='curve']").count() == len(draft["curves"]),
                str(page.locator(".surfwin-row[data-kind='curve']").count()))
        c.check("B: 曲面列數=草稿曲面數", page.locator(".surfwin-row[data-kind='surface']").count() == len(draft["surfaces"]))
        page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=60000)
        page.wait_for_function("() => (window.__cadSurfaceWin.handles() || {}).count > 0", timeout=20000)
        h0 = page.evaluate("() => window.__cadSurfaceWin.handles()")
        c.check("B: GLB 載入後 3D live 層有把手與曲線", h0 and h0["visible"] and h0["count"] > len(draft["curves"]), str(h0))
        c.check("B: 無 JS 錯誤", not errs, "; ".join(errs)[:200])

        # ── C ──
        page.locator(f".surfwin-row[data-kind='curve'][data-id='{first_curve}']").click()
        page.wait_for_selector(".surfwin-edit[data-edit='curve']")
        c.check("C: 選曲線 → 3D 選取同步", page.evaluate("() => window.__cadSurfaceWin.selected()") == first_curve)
        inp = page.locator(".surfwin-edit[data-edit='curve'] input[data-key='p0.x']")
        orig_x = float(inp.input_value())
        new_x = round(orig_x + 3.5, 3)
        inp.fill(str(new_x))
        inp.press("Tab")
        page.wait_for_function("() => window.__cadSurfaceWin.dirty() === true", timeout=5000)
        page.wait_for_function("() => window.__cadSurfaceWin.dirty() === false && !window.__cadSurfaceWin.saving()", timeout=10000)
        g = get_json(f"/api/surface-draft?sessionId={sid}&name={name}")
        pt = next(cv for cv in g["draft"]["curves"] if cv["id"] == first_curve)
        pts = pt.get("points") or pt.get("poles")
        c.check("C: 自動保存 → revision+1 且點 x 已改", g.get("revision") == rev + 1 and abs(pts[0][0] - new_x) < 1e-6, f"rev={g.get('revision')} x={pts[0][0]}")
        c.check("C: 本地 revision 對齊伺服端", page.evaluate("() => window.__cadSurfaceWin.revision()") == rev + 1)
        c.check("C: 零 /api/chat", not chats)
        rev = g["revision"]

        # ── D ──
        drag_p = [new_x + 2, pts[0][1] - 1.5, pts[0][2] + 1]
        ok = page.evaluate("([cid, p]) => window.__cadSurfaceWin.drag(cid, 0, p)", [first_curve, drag_p])
        c.check("D: 模擬 3D 拖曳被接受(窗開且未鎖定)", ok is True)
        d_after = page.evaluate("() => window.__cadSurfaceWin.draft()")
        cv = next(x for x in d_after["curves"] if x["id"] == first_curve)
        p0 = (cv.get("points") or cv.get("poles"))[0]
        c.check("D: 拖曳後點即改、歷史 +1", all(abs(p0[i] - drag_p[i]) < 1e-6 for i in range(3)) and page.evaluate("() => window.__cadSurfaceWin.history().past") >= 2, f"{p0} hist={page.evaluate('() => window.__cadSurfaceWin.history()')}")
        page.wait_for_function("() => window.__cadSurfaceWin.dirty() === false && !window.__cadSurfaceWin.saving()", timeout=10000)
        g = get_json(f"/api/surface-draft?sessionId={sid}&name={name}")
        c.check("D: 拖曳自動保存 revision+1", g.get("revision") == rev + 1, str(g.get("revision")))
        rev = g["revision"]
        h1 = page.evaluate("() => window.__cadSurfaceWin.handles()")
        c.check("D: 把手重建後數量不變", h1 and h1["count"] == h0["count"], f"{h0} → {h1}")

        # ── E ──
        page.locator(".surfwin-undo").click()
        d_u = page.evaluate("() => window.__cadSurfaceWin.draft()")
        pu = next(x for x in d_u["curves"] if x["id"] == first_curve)
        pu0 = (pu.get("points") or pu.get("poles"))[0]
        c.check("E: 復原 → 點回拖曳前", abs(pu0[0] - new_x) < 1e-6, str(pu0))
        page.wait_for_function("() => window.__cadSurfaceWin.dirty() === false && !window.__cadSurfaceWin.saving()", timeout=10000)
        page.locator(".surfwin-redo").click()
        d_r = page.evaluate("() => window.__cadSurfaceWin.draft()")
        pr = next(x for x in d_r["curves"] if x["id"] == first_curve)
        pr0 = (pr.get("points") or pr.get("poles"))[0]
        c.check("E: 重做 → 再回拖曳後", abs(pr0[0] - drag_p[0]) < 1e-6, str(pr0))
        page.wait_for_function("() => window.__cadSurfaceWin.dirty() === false && !window.__cadSurfaceWin.saving()", timeout=10000)
        g = get_json(f"/api/surface-draft?sessionId={sid}&name={name}")
        c.check("E: 復原/重做各自動保存(revision+2)", g.get("revision") == rev + 2, str(g.get("revision")))
        rev = g["revision"]

        # ── F ──
        page.locator(f".surfwin-row[data-kind='surface'][data-id='{first_surface}']").click()
        page.wait_for_selector(".surfwin-edit[data-edit='surface']")
        ids_inp = page.locator(".surfwin-edit[data-edit='surface'] input.surfwin-ids").first
        ids_key = ids_inp.get_attribute("data-key")
        ids_inp.fill("nope_zz")
        ids_inp.press("Tab")
        page.wait_for_selector(".surfwin-err", timeout=5000)
        c.check("F: 參照不存在曲線 → 驗證錯誤 + 確認鈕停用",
                page.locator(".surfwin-build").get_attribute("data-disabled") == "true",
                f"key={ids_key} errs={page.evaluate('() => window.__cadSurfaceWin.errors()')}"[:200])
        page.locator(".surfwin-undo").click()
        page.wait_for_function("() => window.__cadSurfaceWin.errors().length === 0", timeout=5000)
        c.check("F: 復原後錯誤清除、確認鈕恢復", page.locator(".surfwin-build").get_attribute("data-disabled") is None)
        page.wait_for_function("() => window.__cadSurfaceWin.dirty() === false && !window.__cadSurfaceWin.saving()", timeout=10000)
        rev = get_json(f"/api/surface-draft?sessionId={sid}&name={name}")["revision"]

        # ── G ──
        n_chat0 = len(chats)
        page.locator(".surfwin-build").click()
        page.wait_for_function("() => window.__cadSurfaceWin.building() === true", timeout=5000)
        page.wait_for_function(
            "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v2'))", timeout=600000)
        page.wait_for_function("() => window.__cadSurfaceWin.building() === false", timeout=10000)
        page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=60000)
        c.check("G: 確認生成 → v2、窗仍開", page.evaluate("() => window.__cadSurfaceWin.open()") is True)
        c.check("G: 零 /api/chat", len(chats) == n_chat0)
        page.wait_for_function("() => (window.__cadSurfaceWin.handles() || {}).count > 0", timeout=20000)
        c.check("G: 換版重建場景後把手回灌", (page.evaluate("() => window.__cadSurfaceWin.handles()") or {}).get("count", 0) > 0)
        c.check("G: 生成後 revision 不變(草稿未動)", page.evaluate("() => window.__cadSurfaceWin.revision()") == rev)

        # ── H ──
        pj = json.loads(post("/api/surface-draft", {"sessionId": sid, "name": name, "patch": {"analysis": {"minContinuity": "G2"}}}))
        c.check("H: API patch(模擬對話)→ revision+1", pj.get("ok") is True and pj.get("revision") == rev + 1, str(pj)[:120])
        page.locator(f".surfwin-row[data-kind='curve'][data-id='{first_curve}']").click()
        inp = page.locator(".surfwin-edit[data-edit='curve'] input[data-key='p0.y']")
        inp.fill(str(round(float(inp.input_value()) + 1, 3)))
        inp.press("Tab")
        page.wait_for_function(f"() => window.__cadSurfaceWin.revision() === {rev + 1}", timeout=10000)
        page.wait_for_selector(".surfwin-notice", timeout=5000)
        d_h = page.evaluate("() => window.__cadSurfaceWin.draft()")
        c.check("H: 自動保存撞 409 → 重載伺服端草稿(G2 生效、本地 y 改動消失)",
                d_h["analysis"]["minContinuity"] == "G2"
                and abs((next(x for x in d_h["curves"] if x["id"] == first_curve).get("points") or next(x for x in d_h["curves"] if x["id"] == first_curve).get("poles"))[0][1] - pr0[1]) < 1e-6,
                str(d_h["analysis"]))
        rev = rev + 1

        # ── I ──
        page.evaluate("() => window.__cadDispatch({ type: 'SET_PROJECT', project: null })")
        page.on("dialog", lambda d: d.accept())
        page.wait_for_timeout(700)  # localStorage 500ms throttle
        page.reload()
        page.wait_for_selector(".hdr-btn")
        page.wait_for_selector(".draft-switch .fold-seg", timeout=15000)
        if page.evaluate("() => window.__cadSurfaceWin && window.__cadSurfaceWin.open()") is not True:
            page.locator(".draft-switch .fold-seg").click()
        page.wait_for_selector(".surface-window", timeout=10000)
        d_i = page.evaluate("() => window.__cadSurfaceWin.draft()")
        c.check("I: 重整回灌 → 草稿仍在且 revision 對齊", d_i and len(d_i["curves"]) == len(draft["curves"]) and page.evaluate("() => window.__cadSurfaceWin.revision()") == rev,
                f"rev={page.evaluate('() => window.__cadSurfaceWin.revision()')}")

        # ── J ──
        page.locator(".surfwin-discard").click()
        c.check("J: 捨棄兩段式(第一下只武裝)", page.locator(".surfwin-discard").get_attribute("data-arm") == "true")
        page.locator(".surfwin-discard").click()
        page.wait_for_function("() => !document.querySelector('.surface-window')", timeout=5000)
        page.wait_for_function("() => document.querySelector('.draft-switch .fold-seg')?.textContent.includes('+')", timeout=5000)
        g = get_json(f"/api/surface-draft?sessionId={sid}&name={name}")
        c.check("J: 捨棄 → 窗關、伺服端草稿刪除、chip 變「+」", g.get("draft") is None)
        c.check("J: 全程無 JS 錯誤", not errs, "; ".join(errs)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
