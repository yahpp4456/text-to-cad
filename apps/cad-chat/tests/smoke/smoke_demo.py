# -*- coding: utf-8 -*-
"""DEMO 帳號(展示身分)煙測(免 LLM)。

UX 契約(2026-07-21 二版):demo 下受限入口**照常渲染但禁用**(data-disabled +
hover 出 DEMO_TIP),不是藏起來——藏會讓展示者以為產品沒有這些功能。三個例外:
  · 「＋ 新對話」對 demo 開放(不受限);
  · 教訓是/否面板**直接不出**(它是「要求使用者作答」的面板,出現卻不能答=死路);
  · 模式切換器:demo 只看「設計」一段(2026-10-09 起;lib/chatModes DEMO_HIDDEN_MODES),
    草模/無塵電纜/零件庫分段整段**藏**,server 端 /api/chat 對這些 mode 回 403
    demo_mode_forbidden——展示身分只走設計一條線。
  · 進場介紹影片(2026-10-09):/api/health 回 introVideo:true(docs/demo 影片真的在、
    不是 LFS pointer)時,demo 進場出「要不要看 30 秒介紹」對話框,**每次載入都問**
    (不記 localStorage);略過/觀看/Escape 只關本次;團隊身分不出。影片沒拉下來(introVideo:false)則整段不出,
    本煙測據旗分支斷言。

demo 身分靠反代注入的 X-Remote-User 判定,瀏覽器直連沒有這個 header → 本煙測用
Playwright context 的 extra_http_headers 模擬(對照組用另一個 user 名證明禁用不是
全域行為)。前置:dev server 8788。
"""
import os
import shutil

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, server_alive

# 與前端 src/lib/demo.js 的 DEMO_TIP、server demoGuard 的 403 訊息逐字一致。
# 三處措辭必須同步(使用者可能先看 tooltip 後看 403)。
DEMO_TIP = "DEMO 帳號僅供展示,這個功能未開放"

DEMO_USER = "demo"  # CADCHAT_DEMO_USERS 未設時的預設值
CTRL_USER = "u_demo_ctrl"  # 對照組:非 demo 身分

C = Checker()


def _attrs(page, selector):
    """回 [{text,disabled,title}];找不到就回空陣列(讓斷言講清楚是 0 個)。"""
    return page.eval_on_selector_all(
        selector,
        """els => els.map(e => ({
            text: (e.textContent || '').trim(),
            disabled: e.getAttribute('data-disabled'),
            title: e.getAttribute('title'),
        }))""",
    )


def _find(rows, needle):
    for r in rows:
        if needle in r["text"]:
            return r
    return None


def main():
    if not server_alive():
        msg = "server 8788 不可達;先 `cd apps/cad-chat && npm run dev`"
        if os.environ.get("CADCHAT_SMOKE") == "1":
            print("✗ " + msg)
            raise SystemExit(1)
        print("[skip] " + msg)
        return

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ── DEMO 身分 ──
            ctx = browser.new_context(
                viewport={"width": 1480, "height": 920},
                extra_http_headers={"x-remote-user": DEMO_USER},
            )
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(BASE)
            page.wait_for_selector(".hdr", timeout=30000)
            # health 未回前 demo=false(入口短暫可用)→ 等旗到位再斷言
            page.wait_for_function(
                "() => document.querySelector('.hdr-btn[data-disabled]') !== null",
                timeout=10000,
            )

            # ── 0. 進場介紹影片對話框(覆蓋層會攔點擊,必須先處理) ──
            intro_flag = bool(page.request.get(f"{BASE}/api/health").json().get("introVideo"))
            page.wait_for_timeout(300)
            if intro_flag:
                C.check("introVideo:true → demo 首次進場出介紹對話框", page.locator(".intro-dialog").count() == 1)
                C.check("對話框停在詢問階段", page.locator(".intro-dialog[data-stage='ask']").count() == 1)
                # 影片端點:HEAD 200 + Range 206(<video> 拖進度條靠它)
                head = page.request.head(f"{BASE}/api/demo-intro.mp4")
                C.check("/api/demo-intro.mp4 HEAD 200 video/mp4",
                        head.status == 200 and head.headers.get("content-type") == "video/mp4", str(head.status))
                part = page.request.get(f"{BASE}/api/demo-intro.mp4", headers={"Range": "bytes=0-99"})
                C.check("/api/demo-intro.mp4 Range → 206", part.status == 206 and len(part.body()) == 100,
                        f"{part.status} {len(part.body())}")
                page.click(".intro-dialog .save-btn:has-text('略過')")
                page.wait_for_timeout(200)
                C.check("略過後對話框關閉", page.locator(".intro-dialog").count() == 0)
                C.check("不寫 localStorage(每次都問)",
                        page.evaluate("() => localStorage.getItem('cadchat.demoIntroSeen.v1')") is None)
                page.reload()
                page.wait_for_selector(".hdr", timeout=30000)
                page.wait_for_function(
                    "() => document.querySelector('.hdr-btn[data-disabled]') !== null",
                    timeout=10000,
                )
                page.wait_for_timeout(300)
                C.check("重整後再問一次", page.locator(".intro-dialog").count() == 1)
                page.keyboard.press("Escape")
                page.wait_for_timeout(200)
                C.check("Escape 關閉對話框", page.locator(".intro-dialog").count() == 0)
            else:
                print("[skip] introVideo:false(docs/demo 影片未 LFS pull)→ 只驗不出對話框")
                C.check("introVideo:false → 不出介紹對話框", page.locator(".intro-dialog").count() == 0)
                C.check("/api/demo-intro.mp4 無檔 → 404", page.request.get(f"{BASE}/api/demo-intro.mp4").status == 404)

            # ── A. Header:禁用但在場 ──
            hdr = _attrs(page, ".hdr-btn")
            for label in ("開啟檔案", "教訓"):
                row = _find(hdr, label)
                C.check(f"Header「{label}」仍渲染(不是藏)", row is not None)
                if row:
                    C.check(f"Header「{label}」data-disabled", row["disabled"] == "true", str(row))
                    C.check(f"Header「{label}」title=DEMO_TIP", row["title"] == DEMO_TIP, str(row))
            new_chat = _find(hdr, "新對話")
            C.check("「＋ 新對話」對 demo 不禁用", new_chat and new_chat["disabled"] is None, str(new_chat))

            # 模式切換器:demo 只看「設計」——草模/無塵電纜/零件庫分段整段**藏**(不是禁用),
            # 分隔線跟零件庫一起不出
            for m in ("sketch", "cable", "library"):
                C.check(f"ModeSwitch 無 {m} 分段(藏)", page.locator(f".mode-seg[data-mode='{m}']").count() == 0)
            C.check("ModeSwitch 僅剩「設計」一段且亮著",
                    page.locator(".mode-seg").count() == 1
                    and page.locator(".mode-seg[data-mode='design'][data-on='true']").count() == 1)
            C.check("ModeSwitch 無分隔線", page.locator(".mode-switch .mode-divider").count() == 0)

            # 「儲存」(專案綁定)鈕:demo 一樣渲染但禁用;Ctrl+S 不打 /api/save-project。
            # 注入綁定+產物讓鈕出現;斷言完解除綁定,免得之後 reload 被 beforeunload 攔住。
            page.evaluate(
                """() => {
                    window.__cadDispatch({ type: 'SET_SESSION', sessionId: 's_demo_save' });
                    window.__cadDispatch({ type: 'ADD_VERSION', version: {
                        id: 'v1', name: 'demo_proj', glbUrl: '/api/asset?file=nope.glb', source: 'generated' } });
                    window.__cadDispatch({ type: 'PRESENT', glbUrl: '/api/asset?file=nope.glb',
                        name: 'demo_proj', ver: 'v1', source: 'generated' });
                    window.__cadDispatch({ type: 'SET_PROJECT', project: { dir: 'demo_proj', ver: 0, origin: 'saved' } });
                }"""
            )
            page.wait_for_selector(".hdr-save", timeout=5000)
            save_btn = _find(_attrs(page, ".hdr-save"), "儲存")
            C.check("Header「儲存」仍渲染(不是藏)", save_btn is not None)
            if save_btn:
                C.check("Header「儲存」data-disabled", save_btn["disabled"] == "true", str(save_btn))
                C.check("Header「儲存」title=DEMO_TIP", save_btn["title"] == DEMO_TIP, str(save_btn))
            save_reqs = []
            page.on("request", lambda r: save_reqs.append(r.url) if "/api/save-project" in r.url else None)
            page.keyboard.press("Control+s")
            page.wait_for_timeout(500)
            C.check("demo Ctrl+S 不打 /api/save-project、不開對話框",
                    not save_reqs and page.locator(".save-dialog").count() == 0, str(save_reqs))
            # 整個清掉(不只解綁):注入的 v1 若留在快照,B 段 reload 會被判「有生成版但 session
            # 不存在」→ 吐「已過期」訊息 → 之後切零件庫改跳確認框,貨架永不出現
            page.evaluate("() => window.__cadDispatch({ type: 'RESET' })")

            # 點禁用鈕 → overlay 不開(onClick 守衛,不是只靠 CSS)
            page.click(".hdr-btn:has-text('開啟檔案')")
            page.wait_for_timeout(400)
            C.check("點「開啟檔案」不開 FileBrowser", page.locator(".fb-overlay").count() == 0)
            page.click(".hdr-btn:has-text('教訓')")
            page.wait_for_timeout(400)
            C.check("點「教訓」不開 LessonsPanel", page.locator(".lessons-panel").count() == 0)

            # ── B. 教訓是/否面板:demo 直接不出(唯一「藏」的例外)──
            page.evaluate(
                """() => {
                    window.__cadDispatch({ type: 'SET_SESSION', sessionId: 's_demo_offer' });
                    window.__cadDispatch({ type: 'ADD_ITEM', item: {
                        type: 'lesson_offer',
                        symptom: 'demo 不該看到這張',
                        rootCause: 'x',
                        fix: 'y',
                        tag: 'demo-offer',
                    }});
                }"""
            )
            page.wait_for_timeout(500)
            C.check("demo 不出教訓作答面板", page.locator(".canvas-offer").count() == 0)

            # 注入讓 session 有內容 → 切模式會跳「開新對話」確認框;重整清場再繼續
            # (注入是純前端 dispatch,沒進 server session,reload 後不會回來)
            page.reload()
            page.wait_for_selector(".hdr", timeout=30000)
            page.wait_for_function(
                "() => document.querySelector('.hdr-btn[data-disabled]') !== null",
                timeout=10000,
            )

            # ── C. server 底線:直呼 /api/chat 帶 demo 不開放的 mode → 403(不留 session 落盤)──
            # 用 page.request 讓請求帶同一組 x-remote-user header。agent 未就緒(無 token 的
            # 開發機)會先 503 agent_not_ready,那是環境限制不是回歸 → 記 skip。
            for m in ("sketch", "cable", "library"):
                r = page.request.post(f"{BASE}/api/chat", data={"mode": m, "message": "smoke"})
                if r.status == 503:
                    print(f"[skip] /api/chat mode={m}:agent 未就緒(503),無法驗 403 底線")
                    continue
                body = r.json() if r.status == 403 else {}
                C.check(f"demo 直呼 /api/chat mode={m} → 403 demo_mode_forbidden",
                        r.status == 403 and body.get("error") == "demo_mode_forbidden",
                        f"HTTP {r.status} {r.text()[:80]}")

            # ── D. 設計模式下 Composer 對 demo 正常可用(附件/輸入不因 demo 鎖)──
            attach = _attrs(page, ".composer-btn.attach")
            C.check("設計模式附件鈕不禁用", len(attach) == 1 and attach[0]["disabled"] is None, str(attach))
            C.check("設計模式輸入框可用", not page.locator(".composer-input").is_disabled())

            C.check("demo 頁面無 JS 錯誤", not errors, "; ".join(errors[:2]))
            ctx.close()

            # ── F. 對照組:非 demo 身分同樣三鈕不禁用(證明不是全域行為)──
            ctx2 = browser.new_context(
                viewport={"width": 1480, "height": 920},
                extra_http_headers={"x-remote-user": CTRL_USER},
            )
            page2 = ctx2.new_page()
            page2.goto(BASE)
            page2.wait_for_selector(".hdr", timeout=30000)
            page2.wait_for_timeout(800)  # 等 health 回,避免搶在 demo 旗到位前就斷言
            C.check("對照組不出介紹對話框", page2.locator(".intro-dialog").count() == 0)
            hdr2 = _attrs(page2, ".hdr-btn")
            for label in ("開啟檔案", "教訓"):
                row = _find(hdr2, label)
                C.check(f"對照組「{label}」不禁用", row and row["disabled"] is None, str(row))
            ctx2.close()
            browser.close()
    finally:
        shutil.rmtree(os.path.join(REPO, "users", CTRL_USER), ignore_errors=True)

    C.finish()


if __name__ == "__main__":
    main()
