# -*- coding: utf-8 -*-
"""零件庫(library)聊天模式煙測(免 LLM)。

A. API 護欄(純 HTTP):bogus mode 400、library session 收 design turn →
   mode_mismatch 帶真相 mode、六端點(import/export/export-parts/validate/
   validate-ver/save-project)顯式 400 且訊息含「零件庫」。
B. /api/upload-step:正案(磁碟落檔+檔頭 ISO-10303-21)、content-type 415、
   假內容 415、26MB 超限 413 且拿得到 JSON(排水沒斷線)。
C. UI:ModeSwitch 三段+分隔線、點零件庫 → 綠色選中+localStorage+
   選檔/訪談/收庫 stepper+專屬 placeholder/空狀態、無 ParamsBar。
D. Composer STEP 附件:library 模式 set_input_files → step chip(ready)+
   磁碟落檔;移除 chip;design 模式同檔不產生 chip(模式邊界)。
E. 跨重整:seed 磁碟 library session + localStorage 快照 → reload →
   切換器停零件庫、對話/畫布回灌。
seed 直接寫 models/.cadchat/(gitignored、隨 GC),finally 全清。
"""
import glob
import json
import os
import re
import shutil
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, post

c = Checker()
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = str(int(time.time()))[-6:]
SID_API = f"s_smoke_lib_api_{TAG}"
SID_RE = f"s_smoke_lib_re_{TAG}"
CADCHAT = os.path.join(REPO, "models", ".cadchat")
STEP_SRC = os.path.join(REPO, "models", "ref-cdq2", "cdq2a12_30dmz.stp")

cleanup_dirs = []


def seed_library_session(sid, sdk="uuid-smoke-lib"):
    """磁碟 seed 一個零件庫 session(無建模產物——library 的常態)。"""
    d = os.path.join(CADCHAT, sid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "session.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "mode": "library",
                "sdkSessionId": sdk,
                "version": 0,
                "lastName": None,
                "lastPartCount": 0,
                "rehydratedFrom": None,
                "imports": [],
                "savedAt": 1,
            },
            f,
        )
    cleanup_dirs.append(d)
    return d


def post_raw(path, data, ctype="application/octet-stream", timeout=180):
    """位元組直傳(upload-step 用;_util.post 是 JSON 專用)。回 (status, body_json)。"""
    req = urllib.request.Request(BASE + path, data=data, method="POST")
    req.add_header("content-type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


try:
    # ================= A. API 護欄(純 HTTP,先跑) =================
    print("== A. mode 護欄 ==")
    r = json.loads(post("/api/chat", {"mode": "bogus", "message": "x"}))
    c.check("A: bogus mode → 400 bad mode(迴歸)", r.get("error") == "bad mode", str(r))

    seed_library_session(SID_API)
    r = json.loads(post("/api/chat", {"sessionId": SID_API, "mode": "design", "message": "x"}))
    c.check(
        "A: library session 收 design turn → mode_mismatch 帶真相 mode",
        r.get("error") == "mode_mismatch" and r.get("mode") == "library",
        str(r),
    )
    guards = [
        ("/api/import", {"sessionId": SID_API, "file": "ref-cdq2/cdq2a12_30dmz.stp"}, "匯入"),
        ("/api/export", {"sessionId": SID_API, "format": "stl"}, "匯出"),
        ("/api/export-parts", {"sessionId": SID_API, "format": "step", "occs": ["o1.1"]}, "拆件"),
        ("/api/validate", {"sessionId": SID_API}, "精算"),
        ("/api/validate-ver", {"sessionId": SID_API}, "匯出前驗證"),
        ("/api/save-project", {"sessionId": SID_API, "name": f"x_{TAG}"}, "另存"),
    ]
    for path, body, tag in guards:
        rr = json.loads(post(path, body))
        c.check(
            f"A: library session {path} → 顯式 400(訊息含「零件庫」)",
            rr.get("ok") is False and "零件庫" in str(rr.get("error", "")),
            str(rr)[:120],
        )

    # ================= B. /api/upload-step =================
    print("== B. upload-step ==")
    with open(STEP_SRC, "rb") as f:
        step_bytes = f.read()
    st, j = post_raw(f"/api/upload-step?name=smoke_{TAG}.stp", step_bytes)
    c.check(
        "B: 正案 200 + rel=uploads/*.step",
        st == 200 and j.get("ok") is True and str(j.get("rel", "")).startswith("uploads/")
        and str(j.get("rel", "")).endswith(".step"),
        f"{st} {str(j)[:150]}",
    )
    up_sid = j.get("sessionId", "")
    if up_sid:
        cleanup_dirs.append(os.path.join(CADCHAT, up_sid))
    up_abs = os.path.join(CADCHAT, up_sid, *str(j.get("rel", "")).split("/"))
    head = open(up_abs, "rb").read(16) if os.path.isfile(up_abs) else b""
    c.check("B: 磁碟落檔且檔頭 ISO-10303-21", head.startswith(b"ISO-10303-21"), up_abs)

    st, j = post_raw("/api/upload-step", b"hello", ctype="image/png")
    c.check("B: content-type 非 octet-stream → 415", st == 415, f"{st} {str(j)[:100]}")
    st, j = post_raw("/api/upload-step", b"not a step file at all")
    c.check("B: 假內容(非 STEP 檔頭)→ 415", st == 415 and "ISO-10303-21" in str(j.get("error", "")), f"{st} {str(j)[:120]}")
    # 超限 100 bytes(smoke_upload 同款):尾巴極小 → 排水瞬間完成,urllib 才讀得到
    # 413 而非 connection reset(整 MB 級尾巴會撞上回應後的連線收尾)。
    st, j = post_raw("/api/upload-step", b"ISO-10303-21;" + b"\x00" * 25_000_100, timeout=300)
    c.check("B: 超過 25MB → 413 且拿得到 JSON(排水沒斷線)", st == 413 and j.get("ok") is False, f"{st} {str(j)[:120]}")

    # ================= C+D+E. UI(真瀏覽器) =================
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        errs = []
        # HMR ws 雜訊(雙實例開發時)不算 JS 錯誤
        page.on("pageerror", lambda e: "WebSocket" not in str(e) and errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".mode-switch")

        # ---- C. ModeSwitch / 世界切換 ----
        print("== C. ModeSwitch ==")
        c.check("C: 切換器三段", page.locator(".mode-seg").count() == 3)
        c.check("C: 分隔線存在(創作組|管理組)", page.locator(".mode-divider").count() == 1)
        page.locator('.mode-seg[data-mode="library"]').click()
        page.wait_for_selector('.mode-seg[data-mode="library"][data-on="true"]')
        # 選中底色 = --part 綠(等 0.12s transition 收斂)
        page.wait_for_function(
            "() => getComputedStyle(document.querySelector('.mode-seg[data-mode=\"library\"]')).backgroundColor === 'rgb(52, 171, 134)'",
            timeout=3000,
        )
        c.check("C: 零件庫段綠色選中", True)
        c.check(
            "C: localStorage cadchat.mode=library",
            page.evaluate("() => localStorage.getItem('cadchat.mode')") == "library",
        )
        c.check(
            "C: stepper 三段=選檔/訪談/收庫",
            page.locator(".step-cn").all_inner_texts() == ["選檔", "訪談", "收庫"],
        )
        c.check(
            "C: 空狀態=上傳區(硬閘,範例列讓位)",
            page.locator(".lib-dropzone").count() == 1 and page.locator(".example").count() == 0,
        )
        c.check(
            "C: 硬閘=輸入框鎖定且 placeholder 提示先上傳",
            page.locator(".composer-input").is_disabled()
            and "先上傳 STP" in (page.locator(".composer-input").get_attribute("placeholder") or ""),
        )
        c.check("C: 無 ParamsBar(零件庫用純 Canvas3D 世界)", page.locator(".paramsbar").count() == 0)
        c.check("C: Canvas3D 世界存在", page.locator(".canvas").count() >= 1)

        # ---- D. Composer STEP 附件流 ----
        print("== D. STEP 附件 ==")
        before = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        page.locator("input.composer-file").set_input_files(STEP_SRC)
        page.wait_for_selector('.img-chip[data-kind="step"][data-status="ready"]', timeout=30000)
        c.check("D: step chip 出現且 ready", True)
        c.check("D: 附上 STP 後硬閘解鎖", not page.locator(".composer-input").is_disabled())
        c.check(
            "D: 解鎖後 placeholder=收庫訪談文案",
            "收庫訪談" in (page.locator(".composer-input").get_attribute("placeholder") or ""),
        )
        after = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        new_files = sorted(after - before)
        c.check("D: 磁碟落檔(session uploads/)", len(new_files) == 1, str(new_files)[-160:])
        for f_new in new_files:
            d = os.path.dirname(os.path.dirname(f_new))
            if d not in cleanup_dirs:
                cleanup_dirs.append(d)
        page.locator('.img-chip[data-kind="step"] .pick-clear').click()
        page.wait_for_function("() => document.querySelectorAll('.img-chip').length === 0")
        c.check("D: 移除 chip → 硬閘回鎖", page.locator(".composer-input").is_disabled())
        # 切回設計模式(無內容直接切)→ 同檔不產生 chip(App 端模式邊界雙保險)
        page.locator('.mode-seg[data-mode="design"]').click()
        page.wait_for_selector('.mode-seg[data-mode="design"][data-on="true"]')
        before_d = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        page.locator("input.composer-file").set_input_files(STEP_SRC)
        page.wait_for_timeout(800)
        after_d = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        c.check(
            "D: design 模式丟 STEP → 無 chip、零上傳(模式邊界)",
            page.locator(".img-chip").count() == 0 and after_d == before_d,
            f"chips={page.locator('.img-chip').count()}",
        )

        # ---- F. LibraryShelf(直接展開看庫+縮圖,不走 AI) ----
        print("== F. LibraryShelf ==")
        # seed 一件可丟棄庫件(CDM2 fixture;shelf 會對它跑補轉+縮圖)
        sj = json.loads(
            post(
                "/api/library-add",
                {"file": "ref-cdm2/cdm2b20_50z.stp", "label": "smoke shelf victim", "family": "cylinder"},
                timeout=120,
            )
        )
        victim = sj.get("slug") or "smoke_shelf_victim"
        c.check("F: seed 庫件 ok", sj.get("ok") is True, str(sj)[:120])
        page.locator('.mode-seg[data-mode="library"]').click()
        page.wait_for_selector(".lib-shelf")
        page.wait_for_function("() => window.__cadLibShelf && window.__cadLibShelf.count() >= 2", timeout=15000)
        c.check("F: 貨架列出庫件(含剛 seed 的)", page.locator(f'.lib-card[data-slug="{victim}"]').count() == 1)
        # 縮圖鏈:GLB(順產或補轉)→ 離屏渲染 dataURL(首跑含 spawn 轉檔,放寬 timeout)
        page.wait_for_function(
            f"() => document.querySelector('.lib-card[data-slug=\"{victim}\"] .lib-card-thumb img')?.src.startsWith('data:image/png')",
            timeout=120000,
        )
        c.check("F: 縮圖=離屏渲染 dataURL", True)
        # 預覽:載進畫布(canvas 換名),不進時間軸(versions 仍空)
        page.locator(f'.lib-card[data-slug="{victim}"] .fb-action', has_text="預覽").click()
        page.wait_for_function(
            "() => document.querySelector('.canvas')?.innerText.toLowerCase().includes('victim')",
            timeout=30000,
        )
        c.check("F: 預覽載進畫布", True)
        c.check("F: 預覽不進時間軸", "尚無版本" in page.locator(".right-col").inner_text())
        # 刪除:標頭「管理」進批次選取模式(卡上已無「刪」chip)→ 點卡選取 →
        # 「刪除 N 件」二段確認 → 磁碟移除 → 卡片消失、自動退出模式
        c.check(
            "F: 卡上無刪 chip(刪除收進管理模式)",
            page.locator(".lib-card .fb-action", has_text=re.compile(r"^刪$")).count() == 0,
        )
        page.locator(".lib-shelf-head .fb-action", has_text=re.compile(r"^管理$")).click()
        page.locator(f'.lib-card[data-slug="{victim}"] .lib-card-thumb').click()
        c.check(
            "F: 管理模式點卡=選取",
            page.locator(f'.lib-card[data-slug="{victim}"][data-selected="true"]').count() == 1,
        )
        c.check(
            "F: 管理模式動作列讓位",
            page.locator(f'.lib-card[data-slug="{victim}"] .lib-card-actions').count() == 0,
        )
        page.locator(".lib-shelf-head .fb-action", has_text="刪除 1 件").click()
        page.locator(".lib-shelf-head .fb-action", has_text="確定刪 1 件").click()
        page.wait_for_function(
            f"() => !document.querySelector('.lib-card[data-slug=\"{victim}\"]')",
            timeout=15000,
        )
        c.check("F: 刪除後卡片消失", True)
        page.wait_for_selector('.lib-shelf-head .fb-action:has-text("管理")', timeout=5000)
        c.check(
            "F: 刪除完成自動退出管理模式",
            page.locator(".lib-shelf-head .fb-action", has_text="取消").count() == 0,
        )
        c.check(
            "F: 刪除後磁碟移除",
            not os.path.isdir(os.path.join(REPO, "models", "parts-library", victim)),
        )
        # 貨架只屬於零件庫模式
        page.locator('.mode-seg[data-mode="design"]').click()
        page.wait_for_selector('.mode-seg[data-mode="design"][data-on="true"]')
        c.check("F: 設計模式無貨架", page.locator(".lib-shelf").count() == 0)

        # ---- E. 跨重整還原 ----
        print("== E. 跨重整 ==")
        seed_library_session(SID_RE, sdk=None)
        glb_url = "/api/asset?file=" + urllib.parse.quote("ref-cdq2/.cdq2a12_30dmz.stp.glb", safe="")
        snap = {
            "sessionId": SID_RE,
            "mode": "library",
            "_seq": 2,
            "items": [{"type": "user", "id": "m1", "text": "把這顆收進零件庫"}],
            "versions": [],
            "activeVer": None,
            "canvas": {
                "glbUrl": glb_url,
                "name": "cdq2a12_30dmz",
                "code": "cdq2a12_30dmz",
                "ver": "",
                "status": "ready",
                "type": "part",
                "source": "opened",
            },
            "params": {"defs": [], "values": {}},
            "motion": None,
            "savedAt": 1,
        }
        page.evaluate(
            "(s) => { localStorage.setItem('cadchat.session.v1', JSON.stringify(s)); localStorage.setItem('cadchat.mode', 'library'); }",
            snap,
        )
        page.reload()
        page.wait_for_selector('.mode-seg[data-mode="library"][data-on="true"]', timeout=20000)
        c.check("E: reload 後切換器停零件庫", True)
        page.wait_for_selector(".msg-wrap", timeout=20000)
        c.check(
            "E: 對話回灌(RESTORE 走 library 產物守衛)",
            "收進零件庫" in page.locator(".conv-scroll").inner_text(),
        )
        c.check(
            "E: 畫布 glbUrl 回灌(nameplate 顯示模型名)",
            "cdq2" in page.locator(".canvas").inner_text().lower(),
        )
        c.check(
            "E: 已有對話 → 硬閘不鎖(訪談要能接著打字)",
            not page.locator(".composer-input").is_disabled(),
        )
        c.check("E: 全程無 JS 錯誤(HMR ws 雜訊除外)", not errs, "; ".join(errs[:3]))
        page.evaluate("() => localStorage.clear()")
        browser.close()
finally:
    for d in cleanup_dirs:
        shutil.rmtree(d, ignore_errors=True)
    # F 段 seed 的庫件(正常已被刪除流程清掉;此為硬中止保險)
    shutil.rmtree(os.path.join(REPO, "models", "parts-library", "smoke_shelf_victim"), ignore_errors=True)

c.finish()
