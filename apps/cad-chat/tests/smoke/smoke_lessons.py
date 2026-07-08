# -*- coding: utf-8 -*-
"""教訓系統煙測:API(list/digest/update/delete 持久化)+ 教訓面板 UI(渲染/停用/刪除/
pending 統計/空蒸餾)。seed 直接寫 models/.cadchat/lessons.json(server 每請求重讀,
免重啟);先備份、finally 還原,絕不污染真資料。不點任何會觸發真 LLM 的路徑
(有 pending 時不按「立即蒸餾」;「重新蒸餾」只驗存在)。"""
import json
import os
import shutil

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, get_with_headers, post

LESSONS_FILE = os.path.join(REPO, "models", ".cadchat", "lessons.json")
BACKUP = LESSONS_FILE + ".smoke-bak"

SEED = {
    "schemaVersion": 1,
    "updatedAt": "2026-07-07T00:00:00.000Z",
    "seq": 6,
    "lessonSeq": 3,
    "cases": [
        {
            "id": "c_5", "at": "2026-07-06T00:00:00Z", "sessionId": "s_smoke", "turnId": "t_1",
            "source": "validate", "signature": "validate:interference", "userText": "煙測需求",
            "note": "2 處未宣告干涉", "stderrTail": None, "partName": "x", "partCount": 3,
            "attempt": 1, "retry": None, "resolved": False, "resolvedBy": None,
            "fixEdits": None, "lessonId": None,
        },
        {
            "id": "c_6", "at": "2026-07-06T01:00:00Z", "sessionId": "s_smoke", "turnId": "t_2",
            "source": "validate", "signature": "validate:interference", "userText": "煙測需求2",
            "note": "1 處未宣告干涉", "stderrTail": None, "partName": "x", "partCount": 3,
            "attempt": 1, "retry": None, "resolved": False, "resolvedBy": None,
            "fixEdits": None, "lessonId": None,
        },
    ],
    "lessons": [
        {
            "id": "LS-1", "signature": "build:AssertionError:interference", "status": "active",
            "title": "疊層定位魔數", "rootCause": "多層 Z 定位用目測常數而非逐層累加",
            "rule": "疊層定位常數必須以下層頂面高度逐層推導,寫進頂部定位表。",
            "caseCount": 5, "resolvedCount": 4, "graduationCandidate": True,
            "createdAt": "2026-07-01T00:00:00Z", "lastHitAt": "2026-07-06T00:00:00Z",
            "distilledAt": "2026-07-05T00:00:00Z", "model": "test",
        },
        {
            "id": "LS-2", "signature": "validate:motion_sweep:penetration", "status": "active",
            "title": "行程中撞緊鄰件", "rootCause": "MOTION 只掃了滑塊×導軌,漏了鄰近結構",
            "rule": "MOTION pairs 必含動件×所有緊鄰結構件,不只滑動介面。",
            "caseCount": 2, "resolvedCount": 2, "graduationCandidate": False,
            "createdAt": "2026-07-02T00:00:00Z", "lastHitAt": "2026-07-04T00:00:00Z",
            "distilledAt": "2026-07-04T00:00:00Z", "model": "test",
        },
        {
            "id": "LS-3", "signature": "build:SyntaxError", "status": "disabled",
            "title": "已停用示例", "rootCause": "rc", "rule": "已停用的規則不進 digest。",
            "caseCount": 1, "resolvedCount": 0, "graduationCandidate": False,
            "createdAt": "2026-07-03T00:00:00Z", "lastHitAt": None,
            "distilledAt": "2026-07-03T00:00:00Z", "model": "test",
        },
    ],
}


def seed(store):
    os.makedirs(os.path.dirname(LESSONS_FILE), exist_ok=True)
    with open(LESSONS_FILE, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


c = Checker()
# 前次執行若在 seed 後被硬殺(finally 沒跑),磁碟上 lessons.json=假資料、BACKUP=真資料;
# 此時無條件 copy2 會用假資料蓋掉唯一的真備份 → 先把殘留備份還原再照常備份。
if os.path.exists(BACKUP):
    print("[smoke_lessons] 偵測到前次殘留備份,先還原真資料再開始")
    shutil.move(BACKUP, LESSONS_FILE)
had_backup = os.path.exists(LESSONS_FILE)
if had_backup:
    shutil.copy2(LESSONS_FILE, BACKUP)
try:
    seed(SEED)

    # ── A. API 面 ──
    st, _, body = get_with_headers("/api/lessons")
    j = json.loads(body)
    c.check("GET /api/lessons 200 ok", st == 200 and j.get("ok") is True)
    c.check("回 3 條教訓", len(j.get("lessons", [])) == 3)
    c.check(
        "pending 統計含 validate:interference ×2",
        any(g["signature"] == "validate:interference" and g["count"] == 2 for g in j.get("pending", [])),
    )

    st, _, body = get_with_headers("/api/lessons/digest")
    dig = json.loads(body).get("digest", "")
    c.check("digest 含從屬聲明", "以上方規則為準" in dig)
    c.check("digest 含 active 教訓(LS-1/LS-2)", "[LS-1]" in dig and "[LS-2]" in dig)
    c.check("digest 排除 disabled(LS-3)", "[LS-3]" not in dig)
    i1, i2 = dig.find("[LS-1]"), dig.find("[LS-2]")
    c.check("digest 依 id 排序", -1 < i1 < i2)

    # ── B. 面板 UI ──
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1480, "height": 920})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".hdr", timeout=30000)

        page.locator(".hdr-btn", has_text="教訓").click()
        page.wait_for_selector(".lessons-panel", timeout=5000)
        rows = page.locator(".lessons-row")
        c.check("面板列出 3 條教訓", rows.count() == 3)
        c.check(
            "disabled 列有降透明樣式",
            page.locator(".lessons-row[data-status='disabled']").count() == 1,
        )
        c.check("畢業候選 ★ 顯示(LS-1)", page.locator(".lessons-grad").count() == 1)
        c.check("每列有「重新蒸餾」鈕", page.locator(".fb-action", has_text="重新蒸餾").count() == 3)
        foot = page.locator(".lessons-foot").inner_text()
        c.check("footer 顯示待蒸餾統計", "validate:interference ×2" in foot)

        # 停用 LS-1 → API 持久化 → UI 反映
        row1 = page.locator(".lessons-row", has_text="LS-1")
        row1.locator(".fb-action", has_text="停用").click()
        page.wait_for_timeout(400)
        j2 = json.loads(get_with_headers("/api/lessons")[2])
        ls1 = next(l for l in j2["lessons"] if l["id"] == "LS-1")
        c.check("停用後 API 狀態=disabled", ls1["status"] == "disabled")
        c.check(
            "停用後 UI 標 disabled",
            page.locator(".lessons-row[data-status='disabled']").count() == 2,
        )
        dig2 = json.loads(get_with_headers("/api/lessons/digest")[2])["digest"]
        c.check("停用後 digest 剔除 LS-1", "[LS-1]" not in dig2)
        # 啟用回來
        row1.locator(".fb-action", has_text="啟用").click()
        page.wait_for_timeout(400)
        j3 = json.loads(get_with_headers("/api/lessons")[2])
        c.check(
            "啟用後 API 狀態=active",
            next(l for l in j3["lessons"] if l["id"] == "LS-1")["status"] == "active",
        )

        # 刪除 LS-3(二段確認)
        row3 = page.locator(".lessons-row", has_text="LS-3")
        row3.locator(".fb-action", has_text="刪除").click()
        c.check("刪除需二段確認", row3.locator(".fb-action", has_text="確認刪除").count() == 1)
        row3.locator(".fb-action", has_text="確認刪除").click()
        page.wait_for_timeout(400)
        c.check("確認後列消失", page.locator(".lessons-row").count() == 2)
        j4 = json.loads(get_with_headers("/api/lessons")[2])
        c.check("刪除已持久化", all(l["id"] != "LS-3" for l in j4["lessons"]))

        # 待蒸餾案例逐筆刪除(seed 的 c_5/c_6,signature=validate:interference)
        c.check("待蒸餾區渲染", page.locator(".lessons-pending").count() == 1)
        c.check("列出 2 筆未蒸餾案例", page.locator(".pending-case").count() == 2)
        case5 = page.locator(".pending-case", has_text="c_5")
        case5.locator(".fb-action", has_text="刪除").click()
        c.check("案例刪除需二段確認", case5.locator(".fb-action", has_text="確認刪除").count() == 1)
        case5.locator(".fb-action", has_text="確認刪除").click()
        page.wait_for_timeout(400)
        c.check("確認後剩 1 筆案例", page.locator(".pending-case").count() == 1)
        j_pc = json.loads(get_with_headers("/api/lessons")[2])
        pc_ids = [cs["id"] for g in j_pc.get("pending", []) for cs in g.get("cases", [])]
        c.check("案例刪除已持久化(c_5 移除、c_6 保留)", pc_ids == ["c_6"])

        # 清空 pending 後,「立即蒸餾」安全可點(零 LLM:無待蒸餾直接回空)
        empty = {**SEED, "cases": [], "lessons": SEED["lessons"][:1]}
        seed(empty)
        page.locator(".fb-close").click()
        page.locator(".hdr-btn", has_text="教訓").click()  # 重開 = 重新 fetch
        page.wait_for_selector(".lessons-panel", timeout=5000)
        # 元件常駐 mount:重開瞬間先渲染舊 data,refetch 非同步 → 等條件而非等時間
        page.wait_for_function(
            "() => document.querySelector('.lessons-foot')?.innerText.includes('無待蒸餾')",
            timeout=5000,
        )
        c.check("無 pending 時 footer 顯示無待蒸餾", "無待蒸餾" in page.locator(".lessons-foot").inner_text())
        page.locator(".fb-action", has_text="立即蒸餾").click()
        page.wait_for_timeout(600)
        c.check("空蒸餾回報「沒有可蒸餾」", "沒有可蒸餾" in page.locator(".lessons-toast").inner_text())

        c.check("全程零 pageerror", not errors, "; ".join(errors[:3]))
        browser.close()

    # ── C. API 負案例 ──
    c.check("update 壞 id → not_found", '"not_found"' in post("/api/lessons/update", {"id": "LS-99", "status": "disabled"}))
    c.check("redistill 壞 id → not_found", '"not_found"' in post("/api/lessons/redistill", {"id": "LS-99"}))
    c.check("delete-case 壞 id → not_found", '"not_found"' in post("/api/lessons/delete-case", {"id": "c_999"}))
finally:
    if had_backup:
        shutil.move(BACKUP, LESSONS_FILE)
    elif os.path.exists(LESSONS_FILE):
        os.remove(LESSONS_FILE)

c.finish()
