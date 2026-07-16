# -*- coding: utf-8 -*-
"""掃出工作窗 + 參數列 number 化煙測(免 LLM)。

A. API:open-project cleanroom_sleeve_x → sidecar `view` 齊(pathKind/loops==7/
   三路徑鍵)、defs 只有 pockets 掛 int:true。
B. UI:「⟜ 掃出」chip → 開窗(左 svg baked+live path d 非空、numfield==3、
   右 chips 含 pockets、輪廓 svg path 存在)。
C. 改 bend_r(fill+Tab)→ live d 改變且**零 /api/chat**;底部 ParamsBar 套用鈕
   同步亮(共享 dirty);窗內套用 → v2、窗仍開、live/baked 重合、view 跟版。
D. prefill:「用對話修改輪廓」→ composer 帶入「修改掃出輪廓」且不送出。
E. 參數列 number 行為:pockets 打 3.5 blur → 4(int);超界 clamp。
F. 負案:注入無 sweepPathsUrl 的 PRESENT → chip 消失;開 sheet_u_bracket
   (無 SWEEP_VIEW)→ 無 chip。
"""
import json
import re

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, get_with_headers, out_path, post

c = Checker()
DIRP = "cleanroom_sleeve_x"

# ── A. API ──
j = json.loads(post("/api/open-project", {"dir": DIRP}, timeout=600))
c.check("A: open-project ok", j.get("ok") is True, str(j)[:150])
sweep_url = (j.get("present") or {}).get("sweepPathsUrl") or ""
_st, _h, body = get_with_headers(sweep_url)
side = json.loads(body.decode("utf-8"))
view = side.get("view") or {}
c.check("A: sidecar view 齊(drag_chain、loops==7、三路徑鍵)",
        view.get("pathKind") == "drag_chain"
        and len(view.get("profileLoops") or []) == 7
        and view.get("pathParams") == ["straight_a", "bend_r", "straight_b"],
        str({k: (len(v) if k == "profileLoops" else v) for k, v in view.items()})[:200])
int_flags = {d["key"]: d.get("int") for d in (j.get("params") or [])}
c.check("A: 只有 pockets 掛 int:true",
        int_flags.get("pockets") is True
        and all(v is not True for k, v in int_flags.items() if k != "pockets"), str(int_flags))

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 950})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    chats = []
    page.on("request", lambda r: chats.append(r.url) if "/api/chat" in r.url else None)
    page.goto(BASE)
    page.wait_for_selector(".hdr-btn")
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-projrow")
    page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
    page.locator(".fb-projrow", has_text=DIRP).click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
        timeout=300000)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=60000)

    # ── B. 開窗 ──
    page.wait_for_selector(".sweep-switch", timeout=15000)
    page.locator(".sweep-switch .fold-seg").click()
    page.wait_for_selector(".sweep-window", timeout=10000)
    c.check("B: __cadSweepWin 探針開", page.evaluate("() => window.__cadSweepWin.open()") is True)
    baked_d = page.locator(".sweepwin-baked").get_attribute("d") or ""
    live_d = page.locator(".sweepwin-live").get_attribute("d") or ""
    c.check("B: 左 svg baked+live path d 非空", len(baked_d) > 20 and len(live_d) > 20)
    c.check("B: 路徑 numfield==3", page.locator(".sweep-window .numfield").count() == 3)
    chips = page.locator(".sweepwin-chip")
    c.check("B: 右輪廓唯讀 chips 含 pockets",
            chips.count() == 3 and "pockets=6" in chips.first.inner_text())
    c.check("B: 輪廓 svg path 存在", bool(page.locator(".sweepwin-prof").get_attribute("d")))

    # ── C. 改 bend_r → live 即時、零 chat;套用 → v2 跟版 ──
    n_chat0 = len(chats)
    field = page.locator(".sweep-window .numfield[data-key='bend_r'] input")
    field.fill("120")
    field.press("Tab")
    page.wait_for_function(
        "d => document.querySelector('.sweepwin-live')?.getAttribute('d') !== d",
        arg=live_d, timeout=8000)
    c.check("C: live path 即時改變且零 /api/chat", len(chats) == n_chat0)
    c.check("C: 底部 ParamsBar 套用鈕同步亮(共享 dirty)",
            page.locator(".paramsbar-apply").count() == 1)
    page.locator(".sweepwin-apply").click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v2'))",
        timeout=300000)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=60000)
    page.wait_for_selector(".sweep-window", timeout=10000)
    c.check("C: 套用後窗仍開", page.evaluate("() => window.__cadSweepWin.open()") is True)
    # live 與 baked 重合(同 96 點取樣;等新 sidecar fetch 完成)
    page.wait_for_function(
        "() => { const b=document.querySelector('.sweepwin-baked'), l=document.querySelector('.sweepwin-live');"
        " return b && l && b.getAttribute('d') === l.getAttribute('d'); }",
        timeout=15000)
    c.check("C: 套用後 live 與 baked 逐字重合(取樣鏡射無漂移)", True)
    v2 = page.evaluate("() => window.__cadSweepWin.view()")
    c.check("C: view 跟版(仍為 drag_chain、7 圈)",
            bool(v2) and v2.get("pathKind") == "drag_chain" and len(v2.get("profileLoops")) == 7)

    # ── D. prefill(注意:C 段的「套用」本來就發過一次 params-only /api/chat,
    # 基準取點擊捷徑前的當下計數)──
    n_chat_d = len(chats)
    page.locator(".sweepwin-chat").click()
    page.wait_for_function(
        "() => (document.querySelector('.composer textarea')?.value || '').includes('修改掃出輪廓')",
        timeout=8000)
    c.check("D: 對話捷徑 prefill 進 composer(不送出)", len(chats) == n_chat_d)

    # ── E. 參數列 number 行為(pockets int / clamp)──
    pk = page.locator(".paramsbar .numfield[data-key='pockets'] input")
    pk.fill("3.5")
    pk.press("Tab")
    page.wait_for_timeout(200)
    c.check("E: pockets 打 3.5 → 4(int 鎖整數)", pk.input_value() == "4")
    br = page.locator(".paramsbar .numfield[data-key='bend_r'] input")
    br.fill("99999")
    br.press("Tab")
    page.wait_for_timeout(200)
    c.check("E: 超界輸入被 clamp(值 < 99999)", float(br.input_value()) < 99999)

    # ── F. 負案 ──
    page.evaluate(
        "() => window.__cadDispatch({ type: 'PRESENT', glbUrl: '/api/asset?file=nonexist.glb&v=9', name: 'x', code: 'x', ver: 'v9' })")
    try:
        page.wait_for_function("() => document.querySelectorAll('.sweep-switch').length === 0", timeout=8000)
        gone = True
    except Exception:
        gone = False
    c.check("F: 無 sweepPathsUrl 的 present → chip 消失", gone)
    real_errs = [e for e in errs if "WebSocket closed without opened" not in e]
    c.check("全程無 JS 錯誤(HMR ws 雜訊除外)", not real_errs, "; ".join(real_errs[:3]))
    page.screenshot(path=out_path("smoke_sweep_window.png"))
    browser.close()

# F(API). 無 SWEEP_VIEW 的專案:sidecar 無 view(sheet 無 SWEEP_PATHS → 連 sidecar 都無)
j2 = json.loads(post("/api/open-project", {"dir": "sheet_u_bracket"}, timeout=600))
c.check("F: sheet_u_bracket 無 sweepPathsUrl(無窗可開)",
        j2.get("ok") is True and (j2.get("present") or {}).get("sweepPathsUrl") is None)

c.finish()
