# -*- coding: utf-8 -*-
"""人工記教訓「是/否」煙測(免 LLM):
  A. API 面 —— POST /api/lessons/record 直打:落一筆 source=manual pending case、
     signature=manual:<slug>、命中既有教訓則連結(不留 pending)、缺內容/壞 body 負案例。
  B. UI 面 —— 作答面一律在視圖(.canvas-offer 面板;聊天卡=被動紀錄無按鈕):
     注入 lesson_offer → 視圖面板按「是」→ POST 落 pending、聊天卡顯示「已加入」;
     按「否」→ 純前端標記零網路;多張未答=佇列語意(最舊先答,答完輪下一張)。
seed 直接寫 models/.cadchat/lessons.json(server 每請求重讀,免重啟);先備份、finally 還原,
絕不污染真資料。不點任何觸發真 LLM 的路徑。"""
import json
import os
import shutil

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, get_with_headers, post

LESSONS_FILE = os.path.join(REPO, "models", ".cadchat", "lessons.json")
BACKUP = LESSONS_FILE + ".offer-bak"

EMPTY = {
    "schemaVersion": 1,
    "updatedAt": "2026-07-13T00:00:00.000Z",
    "seq": 0,
    "lessonSeq": 0,
    "cases": [],
    "lessons": [],
    "distillAttempts": {},
}


def seed(store):
    os.makedirs(os.path.dirname(LESSONS_FILE), exist_ok=True)
    with open(LESSONS_FILE, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


def lessons_state():
    return json.loads(get_with_headers("/api/lessons")[2])


def pending_count(sig):
    for g in lessons_state().get("pending", []):
        if g["signature"] == sig:
            return g["count"]
    return 0


c = Checker()
# 前次執行若在 seed 後被硬殺(finally 沒跑):磁碟=假資料、BACKUP=真資料 → 先還原殘留備份。
if os.path.exists(BACKUP):
    print("[smoke_lesson_offer] 偵測到前次殘留備份,先還原真資料再開始")
    shutil.move(BACKUP, LESSONS_FILE)
had_backup = os.path.exists(LESSONS_FILE)
if had_backup:
    shutil.copy2(LESSONS_FILE, BACKUP)
try:
    seed(EMPTY)

    # ── A. API 直打 ──
    body = json.loads(
        post(
            "/api/lessons/record",
            {
                "sessionId": "s_offer",
                "symptom": "左右肋一內一外,右肋鑽進中央止口孔",
                "rootCause": "手繞 Polygon extrude 方向由繞向決定,配單邊 Pos 破壞對稱",
                "fix": "extrude(..., both=True) 對稱擠出後再定位",
                "tag": "Mirror Symmetry!",
            },
        )
    )
    c.check("record 回 ok", body.get("ok") is True)
    c.check("signature slug 正規化為 manual:mirror-symmetry", body.get("signature") == "manual:mirror-symmetry")
    c.check("未命中既有教訓 → linkedLessonId=null", body.get("linkedLessonId") is None)
    c.check("落成一筆 pending case(count=1)", pending_count("manual:mirror-symmetry") == 1)

    st = lessons_state()
    case = next(
        (cs for g in st.get("pending", []) if g["signature"] == "manual:mirror-symmetry" for cs in g.get("cases", [])),
        None,
    )
    c.check("pending case source=manual", case and case.get("source") == "manual")

    # 命中既有教訓 → 連結,不留 pending
    seed({**EMPTY, "lessonSeq": 1, "lessons": [{
        "id": "LS-1", "signature": "manual:linktest", "status": "active",
        "title": "t", "rootCause": "rc", "rule": "r", "caseCount": 1, "resolvedCount": 0,
    }]})
    linked = json.loads(post("/api/lessons/record", {"symptom": "x", "fix": "y", "tag": "linktest"}))
    c.check("命中既有教訓 → linkedLessonId=LS-1", linked.get("linkedLessonId") == "LS-1")
    c.check("已連結不落 pending(manual:linktest count=0)", pending_count("manual:linktest") == 0)
    c.check("既有教訓 caseCount++(1→2)", next(l for l in lessons_state()["lessons"] if l["id"] == "LS-1")["caseCount"] == 2)

    # 負案例
    c.check("缺內容 → ok:false empty", '"empty"' in post("/api/lessons/record", {"tag": "x"}))
    c.check("非物件 body → 400 bad body", '"bad body"' in post("/api/lessons/record", "not-json-object"))

    # ── B. UI 是/否(作答面在視圖 .canvas-offer;聊天卡=被動紀錄)──
    seed(EMPTY)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1480, "height": 920})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".hdr", timeout=30000)

        def inject(tag, symptom="肋錯位:右肋內縮"):
            page.evaluate(
                """([tag, symptom]) => {
                    window.__cadDispatch({ type: 'SET_SESSION', sessionId: 's_offer_ui' });
                    window.__cadDispatch({ type: 'ADD_ITEM', item: {
                        type: 'lesson_offer',
                        symptom,
                        rootCause: '繞向破壞對稱',
                        fix: 'extrude(..., both=True)',
                        tag,
                    }});
                }""",
                [tag, symptom],
            )

        panel = page.locator(".canvas-offer")

        # 「是」→ 視圖面板作答 → POST 落 pending + 聊天卡顯示已加入
        inject("ui-yes")
        page.wait_for_selector(".lesson-offer-card", timeout=5000)
        c.check("聊天卡渲染(症狀行)", "肋錯位" in page.locator(".lesson-offer-card").inner_text())
        c.check(
            "聊天卡無作答按鈕(被動紀錄)",
            page.locator(".conv-col .lesson-offer-actions").count() == 0,
        )
        c.check("聊天卡指路提示「右側」", "右側" in page.locator(".lesson-offer-hint").inner_text())
        page.wait_for_selector(".canvas-offer", timeout=5000)
        c.check("視圖面板渲染(症狀)", "肋錯位" in panel.inner_text())
        panel.locator(".fb-action.primary", has_text="加入教訓").click()
        page.wait_for_selector('.lesson-offer-card .lesson-offer-done[data-outcome="added"]', timeout=5000)
        c.check(
            "按是後聊天卡顯示「已加入」",
            "已加入" in page.locator(".lesson-offer-card .lesson-offer-done").inner_text(),
        )
        c.check("答完視圖面板收掉", panel.count() == 0)
        page.wait_for_timeout(400)
        c.check("按是 → API 落一筆 manual:ui-yes pending", pending_count("manual:ui-yes") == 1)

        # 「否」→ 純前端標記、零網路(pending 不變)
        inject("ui-no")
        page.wait_for_selector(".canvas-offer", timeout=5000)
        panel.locator(".fb-action", has_text="否").click()
        page.wait_for_timeout(400)
        card_no = page.locator(".lesson-offer-card").last
        c.check("按否後聊天卡顯示「已略過」", "已略過" in card_no.locator(".lesson-offer-done").inner_text())
        c.check("按否 → 零網路(manual:ui-no 無 case)", pending_count("manual:ui-no") == 0)
        c.check("按否後面板收掉", panel.count() == 0)

        # 佇列語意:一次兩張未答 → 面板先出最舊,答完自動輪下一張
        inject("ui-q1", symptom="第一張:掃掠打滑")
        inject("ui-q2", symptom="第二張:相位差半齒")
        page.wait_for_selector(".canvas-offer", timeout=5000)
        c.check("兩張未答 → 面板先出最舊(第一張)", "第一張" in panel.inner_text())
        panel.locator(".fb-action", has_text="否").click()
        page.wait_for_function(
            "() => (document.querySelector('.canvas-offer')?.innerText || '').includes('第二張')",
            timeout=5000,
        )
        c.check("答完自動輪下一張(第二張)", "第二張" in panel.inner_text())
        panel.locator(".fb-action", has_text="否").click()
        page.wait_for_function("() => !document.querySelector('.canvas-offer')", timeout=5000)
        c.check("佇列清空 → 面板消失", panel.count() == 0)

        # 失敗回滾:stub record 回 ok:false → 樂觀 pending 回滾(outcome:null)、
        # 按鈕恢復可重試、錯誤 notify 進對話、零 case 落盤
        page.route(
            "**/api/lessons/record",
            lambda r: r.fulfill(
                status=200,
                content_type="application/json",
                body='{"ok":false,"error":"stub-fail"}',
            ),
        )
        inject("ui-fail", symptom="回滾:stub 失敗")
        page.wait_for_selector(".canvas-offer", timeout=5000)
        panel.locator(".fb-action.primary", has_text="加入教訓").click()
        page.wait_for_function(
            "() => document.body.innerText.includes('加入教訓失敗')", timeout=5000
        )
        c.check("失敗 → 錯誤 notify 進對話", "加入教訓失敗" in page.locator(".conv-scroll").inner_text())
        c.check("失敗回滾 → 面板按鈕恢復可重試", panel.locator(".fb-action.primary").count() == 1)
        c.check("失敗 → 零 case 落盤", pending_count("manual:ui-fail") == 0)
        page.unroute("**/api/lessons/record")
        panel.locator(".fb-action", has_text="否").click()  # 清場
        page.wait_for_timeout(200)

        # 防雙擊:同步 in-flight 守衛 → 兩次點擊只落一筆(非冪等 POST 保護)
        inject("ui-dbl")
        page.wait_for_selector(".canvas-offer", timeout=5000)
        panel.locator(".fb-action.primary", has_text="加入教訓").dblclick()
        page.locator(".lesson-offer-card").last.locator(
            '.lesson-offer-done[data-outcome="added"]'
        ).wait_for(timeout=5000)
        page.wait_for_timeout(500)
        c.check("雙擊「是」只落一筆(in-flight 守衛,manual:ui-dbl count=1)", pending_count("manual:ui-dbl") == 1)

        c.check("全程零 pageerror", not errors, "; ".join(errors[:3]))
        browser.close()
finally:
    if had_backup:
        shutil.move(BACKUP, LESSONS_FILE)
    elif os.path.exists(LESSONS_FILE):
        os.remove(LESSONS_FILE)

c.finish()
