# -*- coding: utf-8 -*-
"""跨重整續聊煙測(免 LLM):localStorage 種子 → 還原 → 切 v1 看真舊檔 →
「⟲ 回到 v1 繼續」→ v3;過期 session → 誠實文案+清 key;新對話 → 清 key。
先跑 smoke_versions.py 產生 .out/versions_session.json。"""
import json

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, out_path

KEY = "cadchat.session.v1"
hand = json.load(open(out_path("versions_session.json"), encoding="utf-8"))
c = Checker()

snap = {
    "sessionId": hand["sessionId"],
    "_seq": 2,
    "items": [
        {"type": "user", "id": "m1", "text": "造一個電動線性滑台"},
        {"type": "ai", "id": "m2", "text": "已完成 v1;之後回退產生 v2。"},
    ],
    "versions": [hand["v1"], hand["v2"]],
    "activeVer": "v2",
    "canvas": {
        "glbUrl": hand["present2"]["glbUrl"],
        "name": hand["name"],
        "code": hand["name"],
        "ver": "v2",
        "status": "ready",
        "type": hand["present2"].get("type", ""),
        "source": "generated",
    },
    "params": {"defs": hand.get("params") or [], "values": {}, "dirty": False},
    "motion": None,
    # 專案綁定(前端形;smoke_versions 已就地儲存到 ver 2 → 還原時應是「✓ 已儲存」)
    "project": {
        "dir": hand["project"]["dir"],
        "savedVer": hand["project"]["ver"],
        "origin": hand["project"]["origin"],
        "sessionId": hand["sessionId"],
    },
    "savedAt": 0,
}
PROJ_DIR = hand["project"]["dir"]

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── A. 還原 + 切版看真檔 + 回退 ──
    ctx = browser.new_context(viewport={"width": 1480, "height": 920})
    page = ctx.new_page()
    errors, reqs = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: reqs.append(r.url))
    page.add_init_script(f"localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(snap, ensure_ascii=False))})")
    page.goto(BASE)

    page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    body = page.locator("body").inner_text()
    c.check("還原通知出現", "已接續上次對話" in body)
    c.check("對話 transcript 還原", "造一個電動線性滑台" in body)
    c.check("版本時間軸還原(2 chips)", page.locator(".version-chip").count() == 2)
    c.check("畫布載入 v2 快照", any("versions%2Fv2" in u for u in reqs))
    chip = page.locator(".proj-chip")
    c.check(f"專案 chip 還原:models/{PROJ_DIR} · ✓ 已儲存",
            chip.count() == 1 and f"models/{PROJ_DIR}" in chip.inner_text() and "✓ 已儲存" in chip.inner_text(),
            chip.inner_text() if chip.count() else "(no chip)")
    c.check("「⤓ 儲存」鈕在場(綁定+可儲存)", page.locator(".hdr-save").count() == 1)

    # 切 v1 → 載入 v1 快照真檔;回退鈕與下載鈕出現
    # (2026-08-25:時間軸多了「✎ 記教訓」——零 LLM 主線不會出現 agent 的教訓
    #  是/否卡,那顆是唯一入口,所以 .version-dl 從 5 顆變 6 顆。)
    page.locator(".version-chip").first.click()
    page.wait_for_timeout(2500)
    c.check("切 v1 → 畫布請求 v1 快照(真舊檔)", any("versions%2Fv1" in u for u in reqs))
    revert_btn = page.locator(".version-revert")
    c.check("非最新版 → 回退鈕出現", revert_btn.count() == 1 and "v1" in revert_btn.inner_text())
    dls = page.locator(".version-dl").all_inner_texts()
    c.check(
        "下載鈕(STEP/STL/3MF/PDF 工程圖/零件包)+ 記教訓出現",
        len(dls) == 6
        and any("記教訓" in t for t in dls)
        and any("STEP" in t for t in dls)
        and any("PDF" in t for t in dls)
        and any("零件包" in t for t in dls),
        str(dls),
    )

    # 回退(server 重建 15 件組合件,約 1-2 分鐘)
    revert_btn.click()
    page.wait_for_function("() => document.querySelectorAll('.version-chip').length >= 3", timeout=300000)
    c.check("回退 → v3 chip 出現", page.locator(".version-chip").count() == 3)
    c.check("回退完成通知", "已回到 v1" in page.locator("body").inner_text())
    page.wait_for_timeout(2500)
    c.check("畫布載入 v3 快照", any("versions%2Fv3" in u for u in reqs))
    saved = page.evaluate(f"() => JSON.parse(localStorage.getItem({json.dumps(KEY)}) || 'null')")
    c.check("持久化快照跟進(含 v3)", bool(saved) and len(saved.get("versions", [])) == 3)
    c.check("回退(版本 +1)→ chip 轉「● 未儲存」", "● 未儲存" in page.locator(".proj-chip").inner_text())
    c.check("持久化快照含綁定", (saved.get("project") or {}).get("dir") == PROJ_DIR, str(saved.get("project")))

    # ── D. chip 三態(注入)+ Ctrl+S 就地儲存(page.route 攔 save-project,不真寫 models/)──
    page.evaluate(f"() => window.__cadDispatch({{type:'SET_PROJECT', project:{{dir:{json.dumps(PROJ_DIR)}, ver:3, origin:'saved'}}}})")
    page.wait_for_timeout(200)
    c.check("注入 savedVer=3(= 最新版)→ ✓ 已儲存", "✓ 已儲存" in page.locator(".proj-chip").inner_text())
    page.evaluate("() => window.__cadDispatch({type:'SET_PROJECT', project:null})")
    page.wait_for_timeout(200)
    c.check("解除綁定 → chip 與儲存鈕消失、另存仍在",
            page.locator(".proj-chip").count() == 0 and page.locator(".hdr-save").count() == 0
            and page.locator(".hdr-btn", has_text="另存").count() == 1)
    page.evaluate(f"() => window.__cadDispatch({{type:'SET_PROJECT', project:{{dir:{json.dumps(PROJ_DIR)}, ver:1, origin:'saved'}}}})")
    page.wait_for_timeout(200)
    c.check("重綁 savedVer=1 → ● 未儲存", "● 未儲存" in page.locator(".proj-chip").inner_text())
    saves = []

    def stub_save(route):
        saves.append(json.loads(route.request.post_data or "{}"))
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"ok": True, "dir": PROJ_DIR, "inPlace": True,
                                       "project": {"dir": PROJ_DIR, "ver": 3, "origin": "saved"}}))

    page.route("**/api/save-project", stub_save)
    page.keyboard.press("Control+s")
    page.wait_for_function(
        "() => (document.querySelector('.proj-chip')?.textContent || '').includes('已儲存')", timeout=5000)
    c.check("Ctrl+S → POST /api/save-project inPlace:true(免對話框、不送 name)",
            len(saves) == 1 and saves[0].get("inPlace") is True and "name" not in saves[0], str(saves))
    c.check("Ctrl+S 後 chip 轉 ✓ 已儲存(savedVer 取伺服端回應)", "✓ 已儲存" in page.locator(".proj-chip").inner_text())
    c.check("Ctrl+S 沒開另存對話框", page.locator(".save-dialog").count() == 0)
    page.unroute("**/api/save-project")

    # ── C. 新對話:未儲存 → 先出確認框(取消留、確認清);清 key、狀態全清 ──
    page.evaluate(f"() => window.__cadDispatch({{type:'SET_PROJECT', project:{{dir:{json.dumps(PROJ_DIR)}, ver:1, origin:'saved'}}}})")
    page.wait_for_timeout(200)
    page.locator(".hdr-btn", has_text="新對話").click()
    page.wait_for_selector(".confirm-dialog", timeout=5000)
    c.check("有未儲存變更 → 新對話先出確認框(含目錄名)",
            PROJ_DIR in page.locator(".confirm-dialog").inner_text() and "未儲存" in page.locator(".confirm-dialog").inner_text())
    page.locator(".confirm-dialog .save-cancel").click()
    page.wait_for_timeout(300)
    c.check("取消 → 版本與快照都還在",
            page.locator(".version-chip").count() == 3
            and page.evaluate(f"() => localStorage.getItem({json.dumps(KEY)})") is not None)
    page.locator(".hdr-btn", has_text="新對話").click()
    page.wait_for_selector(".confirm-dialog", timeout=5000)
    page.locator(".confirm-dialog .save-btn", has_text="捨棄").click()
    page.wait_for_timeout(800)
    c.check("新對話 → 續聊快照清除", page.evaluate(f"() => localStorage.getItem({json.dumps(KEY)})") is None)
    c.check("新對話 → 版本清空", page.locator(".version-chip").count() == 0)
    c.check("新對話 → chip 消失", page.locator(".proj-chip").count() == 0)
    c.check("A 頁無 JS 錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_restore.png"))

    # ── E. 關頁:綁定+未儲存 → beforeunload 攔截(page.on dialog 接受後才真的關)──
    page.evaluate("""() => {
        window.__cadDispatch({type:'SET_SESSION', sessionId:'s_bu_test'});
        window.__cadDispatch({type:'ADD_VERSION', version:{id:'v1', name:'x', glbUrl:'/api/asset?file=x.glb', source:'generated'}});
        window.__cadDispatch({type:'ADD_VERSION', version:{id:'v2', name:'x', glbUrl:'/api/asset?file=y.glb', source:'generated'}});
        window.__cadDispatch({type:'SET_PROJECT', project:{dir:'bu_dir', ver:1, origin:'saved'}});
    }""")
    page.wait_for_timeout(300)
    c.check("注入未儲存狀態 → chip ● 未儲存",
            page.locator(".proj-chip").count() == 1 and "● 未儲存" in page.locator(".proj-chip").inner_text())
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.type), d.accept()))
    page.mouse.click(5, 5)  # user activation:Chromium 沒互動過不出 beforeunload
    with page.expect_event("close", timeout=15000):
        page.close(run_before_unload=True)
    c.check("關頁觸發 beforeunload 攔截", "beforeunload" in dialogs, str(dialogs))
    ctx.close()

    # ── B. 過期 session → 誠實文案 + 清 key ──
    ctx2 = browser.new_context(viewport={"width": 1480, "height": 920})
    page2 = ctx2.new_page()
    errors2 = []
    page2.on("pageerror", lambda e: errors2.append(str(e)))
    gone = dict(snap, sessionId="s_gone_xxxxxx")
    page2.add_init_script(f"localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(gone, ensure_ascii=False))})")
    page2.goto(BASE)
    page2.wait_for_timeout(2000)
    body3 = page2.locator("body").inner_text()
    c.check("過期 session → 誠實文案", "已過期" in body3, body3[:120])
    c.check("過期 session → key 已清", page2.evaluate(f"() => localStorage.getItem({json.dumps(KEY)})") is None)
    c.check("過期 → 不殘留版本", page2.locator(".version-chip").count() == 0)
    c.check("B 頁無 JS 錯誤", not errors2, "; ".join(errors2[:3]))
    ctx2.close()
    browser.close()

c.finish()
