# -*- coding: utf-8 -*-
"""介面文字系統(繁/簡)煙測(免 LLM)。

契約(2026-10-13):UI 字串仍是繁中硬編,zh-Hans 靠執行期 OpenCC 在 DOM 層轉換
(lib/domConvert)。語言決定:localStorage cadchat.locale 優先,否則 navigator.language
(zh-CN/Hans/SG/MY → 簡體,其餘 → 繁體);Header 右端 .hdr-locale 切換 = 寫偏好 + reload。
  · 排除:使用者輸入(textarea 值)、使用者原話氣泡(.user-bubble)不轉;
  · AI 氣泡與伺服端送來的文案會轉(Phase 1 刻意;Phase 2 AI 改簡中後是冪等);
  · 繁中使用者零改變(轉換器 chunk 不載入)。
前置:dev server 8788。
"""
import json

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, server_alive

C = Checker()
SID = "s_smoke_locale"


def _seed(page):
    """種一則使用者原話進快照,驗「原話不轉」。"""
    snap = {
        "sessionId": SID,
        "mode": "design",
        "_seq": 2,
        "items": [{"type": "user", "id": "m1", "text": "繁體測試訊息:做一個法蘭"}],
        "versions": [],
        "activeVer": None,
        "canvas": {"glbUrl": None, "name": "", "code": "", "ver": "", "status": "idle", "type": "", "source": None},
        "params": {"defs": [], "values": {}},
        "motion": None,
        "savedAt": 1,
    }
    page.evaluate(
        "(s) => { localStorage.setItem('cadchat.session.v1', JSON.stringify(s)); localStorage.setItem('cadchat.mode', 'design'); }",
        snap,
    )


def _wait_app(page):
    page.wait_for_selector(".hdr", timeout=30000)
    page.wait_for_selector(".hdr-locale", timeout=10000)
    page.wait_for_timeout(600)  # 等 health 回 + 轉換器 chunk 載入 + 首批 rAF flush


def main():
    if not server_alive():
        print("[skip] server 8788 不可達;先 `cd apps/cad-chat && npm run dev`")
        return

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ── A. zh-CN 瀏覽器:自動簡體 ──
        ctx = browser.new_context(viewport={"width": 1480, "height": 920}, locale="zh-CN")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".hdr", timeout=30000)
        _seed(page)
        page.reload()
        _wait_app(page)
        page.wait_for_function("() => /产图/.test(document.title)", timeout=10000)

        C.check("A: html lang=zh-Hans", page.evaluate("() => document.documentElement.lang") == "zh-Hans")
        C.check("A: body[data-locale]=zh-Hans", page.evaluate("() => document.body.dataset.locale") == "zh-Hans")
        C.check("A: document.title 已轉簡體", "对话式 CAD 产图" in page.title(), page.title())
        hdr_title = page.locator(".hdr-title").inner_text() if page.locator(".hdr-title").count() else page.locator(".hdr").inner_text()
        C.check("A: Header 文案已轉簡體(产图)", "产图" in hdr_title and "產圖" not in hdr_title, hdr_title[:60])
        seg = page.locator(".mode-seg[data-mode='design'] .mode-cn").inner_text()
        C.check("A: 模式分段「設計」→「设计」", "设计" in seg, seg)
        C.check("A: 切換鈕顯示目標「繁」", page.locator(".hdr-locale").inner_text().strip() == "繁")
        # 快照回灌要 server 端 session 存在;這裡直接在 #root 下造同 class 的節點,驗排除規則本身
        page.evaluate(
            """() => { const w = document.createElement('div'); w.className = 'msg-wrap';
                 w.innerHTML = '<div class="user-bubble">繁體測試訊息:做一個法蘭</div><div class="msg-ai">伺服器回覆的檔案</div>';
                 document.getElementById('root').appendChild(w); }"""
        )
        page.wait_for_timeout(200)
        bubble = page.locator(".user-bubble").first.inner_text()
        C.check("A: 使用者原話氣泡不轉(保留繁體)", bubble == "繁體測試訊息:做一個法蘭", bubble)
        ai = page.locator(".msg-ai").first.inner_text()
        C.check("A: AI 氣泡會轉(Phase 1 刻意;Phase 2 後冪等)", ai == "服务器回复的文件", ai)
        page.evaluate(
            """() => { const d = document.createElement('div'); d.id = 'dyn'; d.textContent = '伺服器錯誤:運動掃掠干涉';
                 document.querySelector('.hdr').appendChild(d); }"""
        )
        page.wait_for_timeout(150)
        C.check("A: 動態新增節點(模擬 SSE 文案)即時轉", page.locator("#dyn").inner_text() == "服务器错误:运动扫掠干涉")
        page.fill(".composer-input", "繁體輸入不該被改")
        page.wait_for_timeout(200)
        C.check("A: textarea 值不轉", page.input_value(".composer-input") == "繁體輸入不該被改")
        btn = page.locator(".hdr-btn", has_text="文件").first
        C.check("A: Header「開啟檔案」→「打开文件」(詞彙級轉換)", btn.count() == 1 and "打开文件" in btn.inner_text(),
                page.locator(".hdr-right").inner_text()[:80])
        chunk_loaded = page.evaluate(
            "() => performance.getEntriesByType('resource').some(r => /t2cn/.test(r.name))"
        )
        C.check("A: 載入了 t2cn 轉換器 chunk", chunk_loaded)
        C.check("A: 無 JS 錯誤", not errors, "; ".join(errors[:2]))

        # ── B. 手動切回繁體:reload、偏好落 localStorage、偵測被偏好覆蓋 ──
        page.click(".hdr-locale")
        page.wait_for_load_state("load")
        _wait_app(page)
        C.check("B: 切回後 html lang=zh-Hant", page.evaluate("() => document.documentElement.lang") == "zh-Hant")
        C.check("B: localStorage cadchat.locale=zh-Hant", page.evaluate("() => localStorage.getItem('cadchat.locale')") == "zh-Hant")
        C.check("B: title 回繁體", "對話式 CAD 產圖" in page.title(), page.title())
        seg = page.locator(".mode-seg[data-mode='design'] .mode-cn").inner_text()
        C.check("B: 分段回「設計」", "設計" in seg, seg)
        C.check("B: 切換鈕顯示目標「简」", page.locator(".hdr-locale").inner_text().strip() == "简")
        page.reload()
        _wait_app(page)
        C.check("B: 再 reload 仍繁體(偏好勝過 zh-CN 偵測)", page.evaluate("() => document.documentElement.lang") == "zh-Hant")

        # ── C. 再切成簡體(偏好=zh-Hans)──
        page.click(".hdr-locale")
        page.wait_for_load_state("load")
        _wait_app(page)
        page.wait_for_function("() => /产图/.test(document.title)", timeout=10000)
        C.check("C: 切成簡體 localStorage=zh-Hans", page.evaluate("() => localStorage.getItem('cadchat.locale')") == "zh-Hans")
        C.check("C: 分段「设计」", "设计" in page.locator(".mode-seg[data-mode='design'] .mode-cn").inner_text())
        page.evaluate("() => localStorage.clear()")
        ctx.close()

        # ── D. zh-TW 瀏覽器:維持繁體,且不載轉換器 ──
        ctx2 = browser.new_context(viewport={"width": 1480, "height": 920}, locale="zh-TW")
        page2 = ctx2.new_page()
        errs2 = []
        page2.on("pageerror", lambda e: errs2.append(str(e)))
        page2.goto(BASE)
        _wait_app(page2)
        C.check("D: zh-TW → html lang=zh-Hant", page2.evaluate("() => document.documentElement.lang") == "zh-Hant")
        C.check("D: 分段「設計」", "設計" in page2.locator(".mode-seg[data-mode='design'] .mode-cn").inner_text())
        C.check(
            "D: 繁體不載 t2cn chunk(零改變)",
            not page2.evaluate("() => performance.getEntriesByType('resource').some(r => /t2cn/.test(r.name))"),
        )
        C.check("D: 無 JS 錯誤", not errs2, "; ".join(errs2[:2]))
        ctx2.close()

        # ── E. en-US 瀏覽器:預設繁體 ──
        ctx3 = browser.new_context(viewport={"width": 1480, "height": 920}, locale="en-US")
        page3 = ctx3.new_page()
        page3.goto(BASE)
        _wait_app(page3)
        C.check("E: en-US → 繁體預設", page3.evaluate("() => document.documentElement.lang") == "zh-Hant")
        ctx3.close()
        browser.close()

    C.finish()


if __name__ == "__main__":
    main()
