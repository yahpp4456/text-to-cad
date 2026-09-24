# -*- coding: utf-8 -*-
"""兩步澄清精靈煙測(免 LLM):__cadDispatch 注入含 specs 的 clarify → 步驟閘門/
inline 修改/合成回覆。/api/chat 用 page.route stub 掉(空 SSE),可安全點擊送出並
截 POST body 斷「規格修正:」合成格式(clarifyText.composeClarifyReply 的端到端驗證)。
G/H 段鎖 SpecChips 的提交語意:失焦即提交(直接點確認不丟草稿)、✓ 提交、Escape 取消。"""
import json

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

c = Checker()

# 注入用的兩步 clarify(specs 覆寫 turnSpec;導軌=assumed 可改,行程=已知不可改)
INJECT_TWO_STEP = """() => window.__cadDispatch({ type: 'SET_CLARIFY', clarify: {
  q: '尺寸級別未給,請選配置',
  opts: [{label: '中載標準', value: '採用中載標準:HGR15 雙軌'}, {label: '輕載桌上型', value: '採用輕載桌上型'}],
  suggested: 'HGR15 雙軌 + SFU1605 + NEMA23',
  specs: [{k: '導軌', v: 'HGR15', assumed: true}, {k: '行程', v: '100 mm'}] } })"""

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

    # ── A. 兩步閘門:步驟 1 只有規格,確認後才出現選項 ──
    page.evaluate(INJECT_TWO_STEP)
    page.wait_for_timeout(200)
    card = page.locator(".canvas-clarify")
    c.check("精靈卡出現", card.count() == 1)
    c.check("步驟列顯示 1/2", "1/2" in card.locator(".cw-steps").inner_text())
    c.check("步驟 1 不出選項(閘門)", card.locator(".canvas-clarify-opt").count() == 0)
    c.check("assumed chip 有標記", card.locator(".cw-chip[data-assumed]").count() == 1)
    c.check("已知值 chip 無標記(不可改)",
            card.locator(".cw-chip:not([data-assumed])").count() == 1)

    # ── B. inline 修改 assumed chip ──
    card.locator(".cw-chip[data-assumed]").click()
    page.wait_for_timeout(120)
    inp = card.locator(".cw-chip-input")
    c.check("點 assumed chip → inline 輸入框", inp.count() == 1)
    inp.fill("HGR20 雙軌")
    inp.press("Enter")
    page.wait_for_timeout(120)
    c.check("修改後 chip 標「已修正」", "已修正" in card.locator(".cw-chip[data-edited]").inner_text())

    # ── C. 確認規格 → 步驟 2;返回鈕可回步驟 1 ──
    card.locator(".cw-confirm").click()
    page.wait_for_timeout(150)
    c.check("確認後步驟列 2/2", "2/2" in card.locator(".cw-steps").inner_text())
    c.check("步驟 2 出現選項", card.locator(".canvas-clarify-opt").count() == 2)
    c.check("修正摘要顯示", "導軌 改為 HGR20 雙軌" in card.locator(".cw-edited").inner_text())
    c.check("「僅套用修正」鈕出現(有修改才有)", card.locator(".cw-fixes-only").count() == 1)
    card.locator(".cw-back").click()
    page.wait_for_timeout(120)
    c.check("返回 → 步驟 1(修改保留)",
            "1/2" in card.locator(".cw-steps").inner_text()
            and card.locator(".cw-chip[data-edited]").count() == 1)
    card.locator(".cw-confirm").click()
    page.wait_for_timeout(120)

    # ── D. 點選項送出 → 合成回覆(修改 + 選項)──
    card.locator(".canvas-clarify-opt").first.click()
    page.wait_for_timeout(400)
    c.check("送出後精靈消失", page.locator(".canvas-clarify").count() == 0)
    c.check("送出後左欄解凍", page.locator('.conv-col[data-frozen="true"]').count() == 0)
    c.check("POST /api/chat 被截獲", len(posted) == 1)
    if posted:
        msg = posted[0].get("message", "")
        c.check("合成回覆以「規格修正:」開頭", msg.startswith("規格修正:導軌 改為 HGR20 雙軌"), msg)
        c.check("合成回覆含「其餘採用:」+選項 value", "其餘採用:採用中載標準" in msg, msg)

    # ── E. 「僅套用修正」路徑(帶 suggested)──
    page.wait_for_timeout(300)  # END_RUN 後才可再注入
    page.evaluate(INJECT_TWO_STEP)
    page.wait_for_timeout(200)
    card = page.locator(".canvas-clarify")
    card.locator(".cw-chip[data-assumed]").click()
    card.locator(".cw-chip-input").fill("HGR25")
    card.locator(".cw-chip-input").press("Enter")
    card.locator(".cw-confirm").click()
    page.wait_for_timeout(120)
    card.locator(".cw-fixes-only").click()
    page.wait_for_timeout(400)
    c.check("僅套用修正:第二筆 POST", len(posted) == 2)
    if len(posted) >= 2:
        msg2 = posted[1].get("message", "")
        c.check("僅套用修正 → 帶建議組合",
                msg2.startswith("規格修正:導軌 改為 HGR25")
                and "其餘採用建議:HGR15 雙軌 + SFU1605 + NEMA23" in msg2, msg2)

    # ── F. 無修改點選項 → 原樣送 value(現狀回歸)──
    page.wait_for_timeout(300)
    page.evaluate(INJECT_TWO_STEP)
    page.wait_for_timeout(200)
    card = page.locator(".canvas-clarify")
    card.locator(".cw-confirm").click()
    page.wait_for_timeout(120)
    c.check("無修改 → 無「僅套用修正」鈕", card.locator(".cw-fixes-only").count() == 0)
    card.locator(".canvas-clarify-suggest").click()
    page.wait_for_timeout(400)
    if len(posted) >= 3:
        c.check("無修改點建議 → 原樣送 suggested",
                posted[2].get("message", "") == "HGR15 雙軌 + SFU1605 + NEMA23",
                posted[2].get("message", ""))
    else:
        c.check("無修改點建議 → 原樣送 suggested", False, f"posted={len(posted)}")

    # ── G. 失焦即提交:打字後直接點「確認規格 →」(不按 Enter、不點 ✓)——使用者最自然
    #   的操作。修前(2026-09-23 使用者回報「改 1500 仍建 1000」):換步卸載 SpecChips,
    #   草稿靜默丟棄 → 步驟 2 無「已修正」→ 送出只剩選項原文(內嵌 AI 原值)。
    page.wait_for_timeout(300)
    page.evaluate(INJECT_TWO_STEP)
    page.wait_for_timeout(200)
    card = page.locator(".canvas-clarify")
    card.locator(".cw-chip[data-assumed]").click()
    card.locator(".cw-chip-input").fill("HGR30")
    card.locator(".cw-confirm").click()
    page.wait_for_timeout(120)
    c.check("G: 直接點確認 → 步驟 2 仍顯示已修正(失焦提交)",
            card.locator(".cw-edited").count() == 1
            and "導軌 改為 HGR30" in card.locator(".cw-edited").inner_text())
    card.locator(".canvas-clarify-opt").first.click()
    page.wait_for_timeout(400)
    c.check("G: 送出帶「規格修正:導軌 改為 HGR30」",
            len(posted) >= 4 and posted[3].get("message", "").startswith("規格修正:導軌 改為 HGR30"),
            posted[3].get("message", "") if len(posted) >= 4 else f"posted={len(posted)}")

    # ── H. ✓ 鈕提交(mousedown 攔焦點轉移:不得先 blur 提交再被 ✓ 的空草稿刪掉)
    #   + Escape 取消(卸載期補的 blur 不得翻成提交)──
    page.wait_for_timeout(300)
    page.evaluate(INJECT_TWO_STEP)
    page.wait_for_timeout(200)
    card = page.locator(".canvas-clarify")
    card.locator(".cw-chip[data-assumed]").click()
    card.locator(".cw-chip-input").fill("HGR35")
    card.locator(".cw-chip-ok").click()
    page.wait_for_timeout(120)
    c.check("H: 點 ✓ → chip 標已修正 HGR35",
            card.locator(".cw-chip[data-edited]").count() == 1
            and "HGR35" in card.locator(".cw-chip[data-edited]").inner_text())
    card.locator(".cw-chip[data-edited]").click()
    card.locator(".cw-chip-input").fill("HGR40")
    card.locator(".cw-chip-input").press("Escape")
    page.wait_for_timeout(120)
    edited_txt = card.locator(".cw-chip[data-edited]").inner_text() if card.locator(".cw-chip[data-edited]").count() else ""
    c.check("H: Escape 取消 → 修正維持 HGR35、草稿 HGR40 丟棄",
            card.locator(".cw-chip-input").count() == 0 and "HGR35" in edited_txt and "HGR40" not in edited_txt,
            edited_txt)
    card.locator(".cw-confirm").click()
    page.wait_for_timeout(120)
    card.locator(".canvas-clarify-opt").first.click()
    page.wait_for_timeout(400)
    c.check("H: 送出帶 HGR35 而非 HGR40",
            len(posted) >= 5 and posted[4].get("message", "").startswith("規格修正:導軌 改為 HGR35"),
            posted[4].get("message", "") if len(posted) >= 5 else f"posted={len(posted)}")

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_clarify_wizard.png"))
    browser.close()

c.finish()
