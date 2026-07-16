# -*- coding: utf-8 -*-
"""視圖「解析規格」面板煙測(免 LLM):需要使用者作答的規格/選項一律在視圖操作,
聊天卡=被動紀錄(2026-07-14 收斂;spec 卡點擊修正自聊天移到視圖 SpecPanel)。
  A. 注入 spec item → 聊天卡靜態化(chip 是 span、無 ✎、最新卡帶「右側操作」指路)
     + 視圖 .canvas-spec 面板出現(chips 齊)。
  B. 面板 inline 修改(全 chip 可改,不限 assumed)→ 套用 → page.route 截
     POST /api/chat 斷「規格修正:」合成契約(composeClarifyReply,零 LLM)。
  C. 新 spec 到達 → 面板 remount(edits 真歸零:新 spec 刻意帶同鍵,殘留必現形)、
     指路只在最新卡;收合/展開。
  D. clarify 讓位 + 草稿轉交:SpecPanel/LessonOfferPanel 都讓位給精靈;面板未套用
     的草稿由精靈步驟 1 接手(已修正 chip),答完合成「規格修正:」;
     specs 空的 clarify(單步精靈)→ 聊天 spec 卡指路熄滅(右側無規格面)。
  E. 草模模式同樣有面板(SketchCanvas3D 共用同元件)。
"""
import json

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

INJECT_SPEC = """(chips) => window.__cadDispatch({ type: 'ADD_ITEM', item: {
  type: 'spec', chips } })"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # stub /api/chat:截 body、回最小 SSE(前端 reader 立即 done → END_RUN)
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
    page.wait_for_selector(".canvas-empty", timeout=15000)
    page.evaluate("() => localStorage.clear()")

    # ── A. 聊天卡被動紀錄 + 視圖面板出現 ──
    page.evaluate(INJECT_SPEC, [{"k": "外徑", "v": "20mm"}, {"k": "孔徑", "v": "5mm", "assumed": True}])
    page.wait_for_selector(".spec-card", timeout=5000)
    c.check("聊天卡無 ✎(被動紀錄)", page.locator(".spec-card .chip-edit").count() == 0)
    c.check(
        "聊天 chip 是 span 不可點",
        page.evaluate("() => document.querySelector('.spec-card .spec-chip').tagName") == "SPAN",
    )
    c.check("最新卡帶「右側」指路", "右側" in page.locator(".spec-card .spec-live").inner_text())
    panel = page.locator(".canvas-spec")
    page.wait_for_selector(".canvas-spec", timeout=5000)
    c.check("視圖面板 chips 齊(2 顆)", panel.locator(".cw-chip").count() == 2)
    c.check("assumed chip 有標記", panel.locator(".cw-chip[data-assumed]").count() == 1)
    c.check(
        "全 chip 可改(非 assumed 也 editable,不同於精靈步驟 1)",
        panel.locator(".cw-chip[data-editable]").count() == 2,
    )

    # ── A2. 回合進行中(running)→ 面板唯讀(避免 AI 還在跑時改規格造成困惑)──
    # 直接派 START_RUN/END_RUN 繞開 stub /api/chat 的即時 done timing race。
    page.evaluate("() => window.__cadDispatch({ type: 'START_RUN' })")
    page.wait_for_timeout(120)
    c.check("回合進行中 → 面板標 data-readonly", page.locator(".canvas-spec[data-readonly]").count() == 1)
    c.check("唯讀 → 無可編輯 chip", panel.locator(".cw-chip[data-editable]").count() == 0)
    c.check("唯讀 → 隱藏套用/提示鈕(.cw-confirm)", panel.locator(".cw-confirm").count() == 0)
    c.check("唯讀 → footer 被動提示", "回合進行中" in panel.locator(".cw-foot").inner_text())
    # 唯讀 chip 靜態化的確定性斷言(不點擊:.cw-chips 是 pointer-events:none,點不到):
    # 無 ✎、無 inline 輸入框(inline 只由已移除的 onClick 開啟)。
    c.check("唯讀 → 無 ✎ 編輯提示", panel.locator(".cw-chip .chip-edit").count() == 0)
    c.check("唯讀 → 無 inline 輸入框", panel.locator(".cw-chip-input").count() == 0)
    page.evaluate("() => window.__cadDispatch({ type: 'END_RUN' })")
    page.wait_for_timeout(120)
    c.check("回合結束 → data-readonly 消失", page.locator(".canvas-spec[data-readonly]").count() == 0)
    c.check("回合結束 → chip 恢復可編輯(2 顆)", panel.locator(".cw-chip[data-editable]").count() == 2)

    # ── B. inline 修改非 assumed chip → 套用 → 「規格修正:」契約 ──
    panel.locator(".cw-chip", has_text="外徑").click()
    page.wait_for_timeout(120)
    inp = panel.locator(".cw-chip-input")
    c.check("點 chip → inline 輸入框", inp.count() == 1)
    inp.fill("25mm")
    inp.press("Enter")
    page.wait_for_timeout(120)
    c.check("修改後 chip 標「已修正」", "已修正" in panel.locator(".cw-chip[data-edited]").inner_text())
    panel.locator(".cw-confirm").click()
    page.wait_for_timeout(400)
    c.check("套用 → POST /api/chat 被截獲", len(posted) == 1)
    if posted:
        msg = posted[0].get("message", "")
        c.check(
            "合成訊息走「規格修正:」契約",
            msg == "規格修正:外徑 改為 25mm。其餘依你的建議值繼續,不必再確認。",
            msg,
        )
    c.check("套用後 edits 歸零(套用鈕退回提示)", panel.locator(".cw-confirm").count() == 0)

    # ── C. 新 spec 到達 → 面板 remount、指路只在最新卡;收合/展開 ──
    panel.locator(".cw-chip", has_text="孔徑").click()
    panel.locator(".cw-chip-input").fill("6mm")
    panel.locator(".cw-chip-input").press("Enter")
    page.wait_for_timeout(120)
    # 新 spec 刻意帶「同一個鍵」(孔徑):若 remount 失效(edits 殘留),
    # 「孔徑 in edits」→ data-edited=1 必現形;帶不同鍵的話斷言會巧合成立。
    page.evaluate(INJECT_SPEC, [{"k": "孔徑", "v": "9mm", "assumed": True}])
    page.wait_for_timeout(200)
    c.check("新 spec(同鍵)→ 面板 remount(edits 真歸零)", panel.locator(".cw-chip[data-edited]").count() == 0)
    c.check("面板呈現新 spec(1 顆)", panel.locator(".cw-chip").count() == 1)
    c.check("兩張聊天卡,指路只在最新", page.locator(".spec-card").count() == 2
            and page.locator(".spec-card .spec-live").count() == 1
            and page.locator(".spec-card").last.locator(".spec-live").count() == 1)
    panel.locator(".canvas-spec-head").click()
    page.wait_for_timeout(120)
    c.check("收合 → chips 隱藏", panel.locator(".cw-chip").count() == 0)
    panel.locator(".canvas-spec-head").click()
    page.wait_for_timeout(120)
    c.check("展開 → chips 回來", panel.locator(".cw-chip").count() == 1)

    # ── D. clarify 讓位(Spec+Offer 雙面板)+ 未套用草稿轉交精靈 ──
    page.evaluate("""() => window.__cadDispatch({ type: 'ADD_ITEM', item: {
      type: 'lesson_offer', symptom: '讓位測試症狀', fix: 'x', tag: 'spec-panel-d' } })""")
    page.wait_for_selector(".canvas-offer", timeout=5000)
    # 在面板改孔徑(Enter 確認)但「不套用」→ clarify 到達時草稿應轉交精靈
    panel.locator(".cw-chip", has_text="孔徑").click()
    panel.locator(".cw-chip-input").fill("7mm")
    panel.locator(".cw-chip-input").press("Enter")
    page.wait_for_timeout(120)
    page.evaluate("""() => window.__cadDispatch({ type: 'SET_CLARIFY', clarify: {
      q: '選配置?', opts: [{label: 'A', value: '採用 A'}],
      specs: [{k: '孔徑', v: '9mm', assumed: true}] } })""")
    page.wait_for_selector(".canvas-clarify", timeout=5000)
    c.check("clarify 待答 → SpecPanel 讓位", page.locator(".canvas-spec").count() == 0)
    c.check("clarify 待答 → LessonOfferPanel 也讓位", page.locator(".canvas-offer").count() == 0)
    wiz = page.locator(".canvas-clarify")
    c.check(
        "面板未套用草稿轉交精靈(chip 標已修正=7mm)",
        wiz.locator(".cw-chip[data-edited]").count() == 1
        and "7mm" in wiz.locator(".cw-chip[data-edited]").inner_text(),
    )
    wiz.locator(".cw-confirm").click()
    page.wait_for_timeout(150)
    wiz.locator(".canvas-clarify-opt").first.click()
    page.wait_for_timeout(400)
    c.check("答完 → 合成含轉交的修正(規格修正:孔徑 改為 7mm)", len(posted) >= 2
            and posted[-1].get("message", "").startswith("規格修正:孔徑 改為 7mm"),
            posted[-1].get("message", "") if posted else "no post")
    c.check("答完 clarify → SpecPanel 回來", page.locator(".canvas-spec").count() == 1)
    page.wait_for_selector(".canvas-offer", timeout=5000)
    c.check("答完 clarify → LessonOfferPanel 回來", page.locator(".canvas-offer").count() == 1)

    # specs 空的 clarify(單步精靈)→ 右側沒有規格面,聊天 spec 卡指路要熄
    page.evaluate("""() => window.__cadDispatch({ type: 'SET_CLARIFY', clarify: {
      q: '無規格的提問?', opts: [{label: 'B', value: '採用 B'}] } })""")
    page.wait_for_selector(".canvas-clarify", timeout=5000)
    c.check("specs 空的 clarify → 聊天 spec 卡指路熄滅", page.locator(".spec-card .spec-live").count() == 0)
    page.locator(".canvas-clarify-opt").first.click()
    page.wait_for_timeout(400)
    c.check("答完 → 指路回來(仍在最新卡)", page.locator(".spec-card .spec-live").count() == 1)
    # 清場:答掉 offer(否=零網路),E 段畫面乾淨
    page.locator(".canvas-offer .fb-action", has_text="否").click()
    page.wait_for_timeout(200)

    # ── E. 草模模式共用面板(SketchCanvas3D)──
    page.evaluate("() => window.__cadDispatch({ type: 'SET_MODE', mode: 'sketch' })")
    page.wait_for_timeout(200)
    c.check(
        "草模模式視圖同樣有面板",
        page.locator('.canvas[data-sketch] .canvas-spec').count() == 1,
    )
    page.evaluate("() => window.__cadDispatch({ type: 'SET_MODE', mode: 'design' })")

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_spec_panel.png"))
    browser.close()

c.finish()
