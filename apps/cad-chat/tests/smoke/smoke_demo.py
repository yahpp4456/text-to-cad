# -*- coding: utf-8 -*-
"""DEMO 帳號(展示身分)煙測(免 LLM)。

UX 契約(2026-07-21 二版):demo 下受限入口**照常渲染但禁用**(data-disabled +
hover 出 DEMO_TIP),不是藏起來——藏會讓展示者以為產品沒有這些功能。三個例外:
  · 「＋ 新對話」對 demo 開放(不受限);
  · 零件庫「預覽」開放(純唯讀,/api/asset 對 demo 本就放行);
  · 教訓是/否面板**直接不出**(它是「要求使用者作答」的面板,出現卻不能答=死路)。

demo 身分靠反代注入的 X-Remote-User 判定,瀏覽器直連沒有這個 header → 本煙測用
Playwright context 的 extra_http_headers 模擬(對照組用另一個 user 名證明禁用不是
全域行為)。前置:dev server 8788。

seed:demo 的 per-user 庫(REPO/users/demo/models/parts-library/<slug>)必須有件才
看得到卡片動作。永遠只建自己的 slug;users/demo 若非本測建立則保留(可能是真的
展示帳號資料),finally 只刪自己種的那件。
"""
import json
import os
import shutil

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, server_alive

# 與前端 src/lib/demo.js 的 DEMO_TIP、server demoGuard 的 403 訊息逐字一致。
# 三處措辭必須同步(使用者可能先看 tooltip 後看 403)。
DEMO_TIP = "DEMO 帳號僅供展示,這個功能未開放"

DEMO_USER = "demo"  # CADCHAT_DEMO_USERS 未設時的預設值
CTRL_USER = "u_demo_ctrl"  # 對照組:非 demo 身分
SEED_SLUG = "smoke_demo_part"

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


def _open_library(page):
    """切到零件庫模式(切換=開新 session;空白狀態不會跳確認)。"""
    page.click(".mode-seg:has-text('零件庫')")
    page.wait_for_selector(".lib-shelf-track", timeout=15000)


def seed_library():
    """種一件到 demo 的 per-user 庫。回 (是否本測建立 users/demo, seed 目錄)。"""
    user_root = os.path.join(REPO, "users", DEMO_USER)
    created_root = not os.path.isdir(user_root)
    seed_dir = os.path.join(user_root, "models", "parts-library", SEED_SLUG)
    os.makedirs(seed_dir, exist_ok=True)
    # listLibraryParts 只讀 meta.json(GLB 缺席時 readOnly 不補轉,卡片維持 ⬡ 占位)
    with open(os.path.join(seed_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "label": "SMOKE DEMO PART",
                "family": "cylinder",
                "bboxMm": [40, 20, 20],
                "notes": "smoke fixture",
            },
            f,
            ensure_ascii=False,
        )
    with open(os.path.join(seed_dir, f"{SEED_SLUG}.step"), "w", encoding="utf-8") as f:
        f.write("ISO-10303-21;\nEND-ISO-10303-21;\n")
    return created_root, seed_dir


def main():
    if not server_alive():
        msg = "server 8788 不可達;先 `cd apps/cad-chat && npm run dev`"
        if os.environ.get("CADCHAT_SMOKE") == "1":
            print("✗ " + msg)
            raise SystemExit(1)
        print("[skip] " + msg)
        return

    created_root, seed_dir = seed_library()
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

            # ── C. 零件庫:貨架動作 ──
            _open_library(page)
            page.wait_for_selector(".lib-card", timeout=15000)
            shelf = _attrs(page, ".lib-shelf-head .fb-action, .lib-card-actions .fb-action")
            for label in ("管理", "⇪ 設計"):
                row = _find(shelf, label)
                C.check(f"貨架「{label}」仍渲染", row is not None, str(shelf))
                if row:
                    C.check(f"貨架「{label}」data-disabled", row["disabled"] == "true", str(row))
                    C.check(f"貨架「{label}」title=DEMO_TIP", row["title"] == DEMO_TIP, str(row))
            prev = _find(shelf, "預覽")
            C.check("貨架「預覽」開放(唯讀不擋)", prev and prev["disabled"] is None, str(prev))

            # ── D. 空狀態上傳區:整區禁用 + 副標換成原因 ──
            dz = _attrs(page, ".lib-dropzone")
            C.check("上傳區仍渲染", len(dz) == 1, str(dz))
            if dz:
                C.check("上傳區 data-disabled", dz[0]["disabled"] == "true", str(dz[0]))
                C.check("上傳區 title=DEMO_TIP", dz[0]["title"] == DEMO_TIP, str(dz[0]))
            C.check(
                "上傳區副標說明原因",
                DEMO_TIP in page.locator(".lib-dz-sub").inner_text(),
                page.locator(".lib-dz-sub").inner_text()[:60],
            )

            # ── E. Composer:附件鈕禁用 + 輸入框鎖定文案 ──
            attach = _attrs(page, ".composer-btn.attach")
            C.check("附件鈕仍渲染", len(attach) == 1, str(attach))
            if attach:
                C.check("附件鈕 data-disabled", attach[0]["disabled"] == "true", str(attach[0]))
                C.check("附件鈕 title=DEMO_TIP", attach[0]["title"] == DEMO_TIP, str(attach[0]))
            ph = page.get_attribute(".composer-input", "placeholder") or ""
            C.check("輸入框 placeholder 說明原因", DEMO_TIP in ph, ph[:60])
            C.check("輸入框鎖定", page.locator(".composer-input").is_disabled())

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
            hdr2 = _attrs(page2, ".hdr-btn")
            for label in ("開啟檔案", "教訓"):
                row = _find(hdr2, label)
                C.check(f"對照組「{label}」不禁用", row and row["disabled"] is None, str(row))
            ctx2.close()
            browser.close()
    finally:
        shutil.rmtree(seed_dir, ignore_errors=True)
        if created_root:
            shutil.rmtree(os.path.join(REPO, "users", DEMO_USER), ignore_errors=True)
        shutil.rmtree(os.path.join(REPO, "users", CTRL_USER), ignore_errors=True)

    C.finish()


if __name__ == "__main__":
    main()
