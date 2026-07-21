# -*- coding: utf-8 -*-
"""零件庫「上傳 STP 後空文字送出」回歸煙測(免 LLM)。

守的 bug:Composer.submit() 的空文字守衛誤用未定義變數 `hasImg`(應為
`hasFile`)。JS && 短路下,有打字時 `!text` 為 false 短路避開、正常送出;但
「上傳完什麼都不打就送出」時求值 `!hasImg` 拋 ReferenceError,submit() 中止、
onSubmit 從不執行——送出鍵看似亮(canSend 用對的 hasFile),按下去卻靜默失敗,
使用者被迫隨便打字才能繞過。客戶正是在零件庫模式回報此症狀。

作法:page.route stub 掉 /api/chat(空 SSE),在乾淨處女 library session 走
「切庫 → 上傳 → 硬閘解鎖 → 空文字送出」,截 POST body 證明送出真的成立。
回歸偵測點=送出成立的即時副作用「pendingFiles 清空 → chip 消失」;bug 未修時
submit() 拋錯、chip 不清、POST 不發 → 對應 wait_for_function 逾時即抓到。

A. 硬閘(對照):剛切庫、無對話、無附件 → 輸入框 disabled、送出鍵非 active。
B. 空文字 + 藍箭頭:上傳 → 空文字點送出鍵 → chip 清空 + POST 帶 stepRefs/mode。
C. 空文字 + Enter:再上傳 → 空文字 Enter(同一 submit(),另一觸發器)→ 成立。
D. 有文字 + 附件(對照):打字送出 → message 帶文字 + stepRefs(短路路徑未破壞)。
"""
import glob
import json
import os
import shutil

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, out_path

c = Checker()
CADCHAT = os.path.join(REPO, "models", ".cadchat")
STEP_SRC = os.path.join(REPO, "models", "ref-cdq2", "cdq2a12_30dmz.stp")

STEP_READY = '.img-chip[data-kind="step"][data-status="ready"]'
NO_CHIP = "() => document.querySelectorAll('.img-chip').length === 0"
SEND_ACTIVE = ".composer-btn.send[data-active='true']"


def upload_one(page):
    """附一顆 STP、等 chip ready。回傳:無(副作用在 DOM)。"""
    page.locator("input.composer-file").set_input_files(STEP_SRC)
    page.wait_for_selector(STEP_READY, timeout=30000)


new_dirs_before = set(glob.glob(os.path.join(CADCHAT, "*")))

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1480, "height": 920})
        errs = []
        page.on("pageerror", lambda e: "WebSocket" not in str(e) and errs.append(str(e)))

        # stub /api/chat:截 body、回最小 SSE(reader 立即 done → END_RUN)。全程掛著;
        # 這支不驗真 LLM 回合(那是 smoke_library_live 的事),只驗「送出動作是否成立」。
        posted = []

        def stub_chat(route):
            posted.append(json.loads(route.request.post_data or "{}"))
            route.fulfill(
                status=200,
                headers={"content-type": "text/event-stream"},
                body='event: ai\ndata: {"text": "(stub)"}\n\n',
            )

        page.route("**/api/chat", stub_chat)
        page.goto(BASE)
        page.wait_for_selector(".mode-switch")
        # 清 localStorage 保證處女狀態:否則殘留 session 被還原 → items 非空 →
        # 切 library 會撞 switchMode 的「已有內容」確認框而非直接切。
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_selector(".mode-switch")
        page.locator('.mode-seg[data-mode="library"]').click()
        page.wait_for_selector('.mode-seg[data-mode="library"][data-on="true"]')

        # ── A. 硬閘(對照組):無對話、無附件時鎖定,不可送 ──
        print("== A. 硬閘鎖定 ==")
        c.check("A: 剛切庫 → 輸入框 disabled", page.locator(".composer-input").is_disabled())
        c.check("A: 無附件 → 送出鍵非 active", page.locator(SEND_ACTIVE).count() == 0)

        # ── B. 空文字 + 藍色送出鍵 ──
        print("== B. 空文字點藍箭頭 ==")
        upload_one(page)
        c.check("B: 附上 STP → 硬閘解鎖", not page.locator(".composer-input").is_disabled())
        c.check("B: 空文字時送出鍵 active(canSend 用 hasFile)", page.locator(SEND_ACTIVE).count() == 1)
        n0 = len(posted)
        page.locator(".composer-btn.send").click()  # 不打任何字,直接點藍箭頭
        # 送出成立的即時副作用=submitText 先 setPendingFiles([]) 再 send → chip 消失。
        # bug 未修時 submit() 拋 ReferenceError、onSubmit 不執行 → chip 不清 → 此處逾時。
        page.wait_for_function(NO_CHIP, timeout=8000)
        c.check("B: 空文字點藍箭頭 → 送出成立(chip 清空)", True)
        c.check("B: 截到一筆 POST /api/chat", len(posted) == n0 + 1)
        if len(posted) > n0:
            b = posted[-1]
            c.check(
                "B: body 帶 stepRefs(單顆 uploads/*.step)",
                isinstance(b.get("stepRefs"), list)
                and len(b["stepRefs"]) == 1
                and str(b["stepRefs"][0]).endswith(".step"),
                str(b)[:170],
            )
            c.check("B: 送出 message 為空(未打字)", b.get("message") == "", repr(b.get("message")))
            c.check("B: 送出帶 mode=library", b.get("mode") == "library", repr(b.get("mode")))

        # ── C. 空文字 + Enter(同一 submit(),另一觸發器)──
        print("== C. 空文字按 Enter ==")
        page.wait_for_selector(".composer-btn.send", timeout=5000)  # 非 running(送出鍵回來)
        upload_one(page)  # 送出後 items 非空、composer 已解鎖,再附一顆
        c.check("C: 空文字時送出鍵 active", page.locator(SEND_ACTIVE).count() == 1)
        n1 = len(posted)
        page.locator(".composer-input").press("Enter")  # 焦點入框、空文字 Enter
        page.wait_for_function(NO_CHIP, timeout=8000)
        c.check("C: 空文字 Enter → 送出成立(chip 清空)", True)
        c.check("C: Enter 也截到一筆 POST", len(posted) == n1 + 1)

        # ── D. 有文字 + 附件(對照組):短路路徑未被破壞,文字如實帶上 ──
        print("== D. 有文字送出 ==")
        page.wait_for_selector(".composer-btn.send", timeout=5000)
        upload_one(page)
        typed = "型號補充 CDQ2A12"
        page.locator(".composer-input").fill(typed)
        n2 = len(posted)
        page.locator(".composer-btn.send").click()
        page.wait_for_function(NO_CHIP, timeout=8000)
        c.check("D: 有文字送出成立", len(posted) == n2 + 1)
        if len(posted) > n2:
            d = posted[-1]
            c.check("D: message 帶使用者文字", d.get("message") == typed, repr(d.get("message")))
            c.check(
                "D: 文字 + 附件並存(stepRefs 仍在)",
                isinstance(d.get("stepRefs"), list) and len(d["stepRefs"]) == 1,
                str(d)[:170],
            )

        c.check("全程無 JS 錯誤(HMR ws 雜訊除外)", not errs, "; ".join(errs[:3]))
        page.screenshot(path=out_path("smoke_library_submit.png"))
        browser.close()
finally:
    # 上傳建立的暫存 session(models/.cadchat/<sid>/uploads/*.step)——只清本測新建的,
    # 不碰既有(使用者常駐 8788 可能有活躍 session)。
    for d in set(glob.glob(os.path.join(CADCHAT, "*"))) - new_dirs_before:
        shutil.rmtree(d, ignore_errors=True)

c.finish()
