# -*- coding: utf-8 -*-
"""開檔 option C + 自動帶入編輯煙測(真 FileBrowser UI,免 LLM)。

A. option C:可編輯專案目錄「整列點擊」= 一鍵開啟可編輯專案(v1 session + 參數
   滑桿),不進資料夾、無獨立按鈕、無唯讀。
B. 對話中途開專案 → 換 session + CLEAR_WORKSPACE 清舊版(死引用不殘留)。
C. 自動帶入編輯:唯讀檢視某專案(注入 source opened + projectDir)聊天 → 前端先打
   /api/open-project 升級成 session 再打 /api/chat(page.route stub;免 LLM)。
"""
import json
import re

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()
DIRP = "sheet_u_bracket"   # 鈑金專案(有 gen_step + 滑桿)
DIRB = "flip_gripper"      # 另一專案(B 段換 session 用)


def open_project_row(page, dirname, timeout=300000):
    """FileBrowser → 專案目錄列整列點擊(fb-projrow)→ 一鍵開專案。
    等到版本 chip 出現該專案名稱(不能只等 'v1'——上一個專案的 v1 會立即滿足)。"""
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-list")
    page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
    page.wait_for_selector(".fb-projrow")
    page.locator(".fb-projrow", has_text=dirname).click()
    page.wait_for_function(
        "(nm) => [...document.querySelectorAll('.version-chip')].some(e => e.textContent.includes(nm))",
        arg=dirname, timeout=timeout)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── A. option C:目錄列一鍵開專案 → v1 + 滑桿 ──
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errs_a = []
    page.on("pageerror", lambda e: errs_a.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".hdr-btn")
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-list")
    c.check("A: 專案目錄列是整列可點(fb-projrow)", page.locator(".fb-projrow").count() >= 10)
    c.check("A: 專案列標「可編輯專案」", page.locator(".fb-projtag").first.inner_text().find("可編輯專案") >= 0)
    # sheet_u_bracket 列不再有獨立「開啟專案」按鈕(整列即開)
    row = page.locator(".fb-row", has=page.locator(".fb-projrow", has_text=DIRP)).first
    c.check("A: 專案列無獨立動作按鈕(整列即開)", row.locator(".fb-action").count() == 0)
    page.locator(".fb-projrow", has_text=DIRP).click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
        timeout=300000)
    c.check("A: 一鍵 → v1 session(非 o1 唯讀)",
            page.locator(".version-chip").count() == 1
            and "v1" in page.locator(".version-id").first.inner_text())
    # 2026-07-16 range→NumberField 改版:設計模式參數列是 number 輸入框
    # (range 只剩草模 DofBar,見 smoke_sketch.py)
    page.wait_for_selector(".param .numfield input", timeout=15000)
    c.check("A: PARAMS 出現數值輸入欄", page.locator(".param .numfield input").count() >= 3)
    labels = [page.locator(".param-label").nth(i).inner_text()
              for i in range(page.locator(".param-label").count())]
    c.check("A: 無 folded 滑桿(攤平改視圖切換)",
            not any("攤平" in l or "摺疊" in l for l in labels), str(labels))
    c.check("A 頁無 JS 錯誤", not errs_a, "; ".join(errs_a[:3]))
    page.screenshot(path=out_path("smoke_open_project_a.png"))

    # ── B. 對話中途開另一專案 → 換 session + 清舊版 ──
    open_project_row(page, DIRB)
    c.check("B: 開另一專案 → 只剩新 session 的 v1(舊版已清)",
            page.locator(".version-chip").count() == 1
            and DIRB in page.locator(".version-chip").first.inner_text(),
            page.locator(".version-chip").first.inner_text())
    page.close()

    # ── C. 自動帶入編輯:注入唯讀專案版 → 聊天先升級再送 ──
    page2 = browser.new_page(viewport={"width": 1480, "height": 920})
    errs_b = []
    page2.on("pageerror", lambda e: errs_b.append(str(e)))
    calls = []

    def stub_openproject(route):
        calls.append("open-project")
        route.continue_()  # 真開專案(要真 session 語境)

    def stub_chat(route):
        calls.append("chat")
        route.fulfill(status=200, headers={"content-type": "text/event-stream"},
                      body='event: ai\ndata: {"text": "(stub)"}\n\n')

    page2.route("**/api/open-project", stub_openproject)
    page2.route("**/api/chat", stub_chat)
    page2.goto(BASE)
    page2.wait_for_selector(".canvas-empty", timeout=15000)
    # 注入唯讀專案檢視版(source opened + projectDir)——option C 下正常 UI 不會產生此
    # 狀態,但 restore/?glb/bare 檔可能;escalation 是那些的安全網。
    page2.evaluate(
        "() => { window.__cadDispatch({ type:'ADD_VERSION', version:{ id:'o1', name:'sheet_u_bracket',"
        " glbUrl:'/api/asset?file=x.glb', file:'sheet_u_bracket/sheet_u_bracket.step',"
        " source:'opened', projectDir:'sheet_u_bracket' } });"
        " window.__cadDispatch({ type:'PRESENT', glbUrl:'/api/asset?file=x.glb', name:'sheet_u_bracket',"
        " code:'sheet_u_bracket', ver:'o1', source:'opened', projectDir:'sheet_u_bracket' }); }"
    )
    page2.wait_for_timeout(200)
    page2.locator(".composer-input, textarea").first.fill("幫我把孔改大")
    page2.keyboard.press("Enter")
    page2.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
        timeout=300000)
    page2.wait_for_timeout(1500)
    c.check("C: 唯讀專案聊天 → 自動升級(open-project 被呼叫)", "open-project" in calls, str(calls))
    c.check("C: chat 在 open-project 之後(先升級再送)",
            "chat" in calls and calls.index("open-project") < calls.index("chat"), str(calls))
    c.check("C 頁無 JS 錯誤", not errs_b, "; ".join(errs_b[:3]))
    page2.screenshot(path=out_path("smoke_open_project_c.png"))
    browser.close()

c.finish()
