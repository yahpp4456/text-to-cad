# -*- coding: utf-8 -*-
"""無塵電纜(cable)聊天模式煙測(免 LLM)。

A. API 護欄(純 HTTP):cable/design session 互斥、cable 放行設計端點、
   可匯入 STEP，並可上傳 STEP 至既有 cable session。
A2. open-project × mode 死路回歸鎖(mint 帶 mode / 參數 mint 前驗 / 滑桿重生 200)。
B. 切換器 UI:四段順序、cable 青色選中、localStorage、cable 專屬五段 stepper,
   以及 cable 空狀態(指向工作台)與 composer 不鎖。
C. Composer STEP 附件邊界:cable 接受 STEP 並顯示 ready chip；design 濾除 STEP。
D. 跨重整:seed cable session 加 localStorage 快照後，reload 保持 cable 且無 JS 錯誤。
seed 直接寫 models/.cadchat/(gitignored、隨 GC),finally 全清。
"""
import glob
import json
import os
import shutil
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, out_path, post

c = Checker()
TAG = str(int(time.time()))[-6:]
SID_API = f"s_smoke_cable_api_{TAG}"
SID_DESIGN = f"s_smoke_cable_design_{TAG}"
SID_RE = f"s_smoke_cable_re_{TAG}"
CADCHAT = os.path.join(REPO, "models", ".cadchat")
STEP_BYTES = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
STEP_TMP = out_path(f"smoke_cable_{TAG}.step")
# A2 用的輕量 fixture 範本(TEMPLATE_META 家族=cable,但幾何是一個盒子):
# 走的是真 open-project → runStep → runValidate → paramsOnly 重生同一條路徑,
# 但 build 幾秒而不是真電纜件的 1–2 分鐘。
TPL_SRC = """\
TEMPLATE_META = {"family": "cable", "form": "smoke", "layers": 1, "label": "smoke fixture"}
PARAMS = {"w": 20.0, "h": 10.0}
PARAM_RANGES = {"w": [5, 50, 1], "h": [5, 50, 1]}
INTENDED_CONTACT = []

from build123d import *  # noqa: E402,F401,F403


def gen_step():
    return Box(PARAMS["w"], PARAMS["w"], PARAMS["h"])
"""

cleanup_dirs = []


def seed_cable_session(sid, sdk="uuid-smoke-cable"):
    """磁碟 seed 一個無產物的 cable session。"""
    d = os.path.join(CADCHAT, sid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "session.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "mode": "cable",
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


def seed_design_session(sid, sdk="uuid-smoke-design"):
    """磁碟 seed 一個無產物的 design session，供 mode 反向互斥斷言。"""
    d = os.path.join(CADCHAT, sid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "session.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "mode": "design",
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
    seed_cable_session(SID_API)
    r = json.loads(post("/api/chat", {"sessionId": SID_API, "mode": "design", "message": "x"}))
    c.check(
        "A: cable session 收 design turn → mode_mismatch 帶真相 mode",
        r.get("error") == "mode_mismatch" and r.get("mode") == "cable",
        str(r),
    )

    guards = [
        ("/api/export", {"sessionId": SID_API, "format": "stl"}),
        ("/api/export-parts", {"sessionId": SID_API, "occs": ["o1.1"]}),
        ("/api/validate", {"sessionId": SID_API}),
        ("/api/validate-ver", {"sessionId": SID_API}),
        ("/api/save-project", {"sessionId": SID_API, "name": "x"}),
    ]
    for path, body in guards:
        rr = json.loads(post(path, body))
        c.check(
            f"A: cable session {path} 放行模式守衛",
            "模式沒有" not in str(rr.get("error", "")),
            str(rr)[:120],
        )

    imported = json.loads(
        post(
            "/api/import",
            {"sessionId": SID_API, "file": "cleanroom_sleeve_x/cleanroom_sleeve_x.step"},
        )
    )
    c.check(
        "A: cable session 可匯入 STEP → imported/",
        imported.get("ok") is True and str(imported.get("rel", "")).startswith("imported/"),
        str(imported)[:160],
    )

    seed_design_session(SID_DESIGN)
    r = json.loads(post("/api/chat", {"sessionId": SID_DESIGN, "mode": "cable", "message": "x"}))
    c.check(
        "A: design session 收 cable turn → mode_mismatch 帶真相 mode",
        r.get("error") == "mode_mismatch" and r.get("mode") == "design",
        str(r),
    )

    # ── A2. open-project × mode 死路回歸鎖(2026-08-25)──
    # 修前:cable 段一鍵開專案 → session 由 getOrCreateSession(null,{user}) mint 成
    # design、前端不校正 → 之後每次 /api/chat(含滑桿 paramsOnly)都 400
    # mode_mismatch(整條零 LLM 生成鏈斷在這)。修後:open-project 收 body.mode /
    # 退範本 TEMPLATE_META.family,回應帶 mode 讓前端校正切換器。
    # 用「輕量 fixture 範本」而非真電纜件:同一條路徑,但 build 幾秒不是兩分鐘。
    print("== A2. open-project × mode ==")
    tpl = f"smoke_cable_tpl_{TAG}"
    tpl_dir = os.path.join(REPO, "models", tpl)
    os.makedirs(tpl_dir, exist_ok=True)
    cleanup_dirs.append(tpl_dir)
    with open(os.path.join(tpl_dir, f"{tpl}.py"), "w", encoding="utf-8") as f:
        f.write(TPL_SRC)

    before = set(glob.glob(os.path.join(CADCHAT, "s_*")))
    bad = json.loads(post("/api/open-project", {"dir": tpl, "mode": "cable", "params": {"nope": 1}}))
    after = set(glob.glob(os.path.join(CADCHAT, "s_*")))
    c.check(
        "A2: 參數鍵不存在 → 擋下,且 mint 前擋(磁碟不留空 session)",
        bad.get("ok") is False and "nope" in str(bad.get("error", "")) and before == after,
        f"{str(bad)[:140]} newdirs={len(after - before)}",
    )
    bad2 = json.loads(post("/api/open-project", {"dir": tpl, "mode": "cable", "params": {"w": 999}}))
    c.check(
        "A2: 參數超出 PARAM_RANGES → 擋下並回報範圍",
        bad2.get("ok") is False and "50" in str(bad2.get("error", "")),
        str(bad2)[:140],
    )

    op = json.loads(post("/api/open-project", {"dir": tpl, "mode": "cable", "params": {"w": 24.0}}, timeout=600))
    sid_tpl = op.get("sessionId")
    if sid_tpl:
        cleanup_dirs.append(os.path.join(CADCHAT, sid_tpl))
    c.check(
        "A2: open-project 收 mode + params → session mode=cable、值已套用",
        op.get("ok") is True and op.get("mode") == "cable" and (op.get("values") or {}).get("w") == 24.0,
        str({k: op.get(k) for k in ("ok", "mode", "values", "error")})[:200],
    )
    sess_json = os.path.join(CADCHAT, sid_tpl or "_", "session.json")
    disk_mode = json.load(open(sess_json, encoding="utf-8")).get("mode") if os.path.isfile(sess_json) else None
    c.check("A2: session.json 落盤 mode=cable(跨重啟仍成立)", disk_mode == "cable", str(disk_mode))

    # 死路本體:cable 段對這個 session 拉滑桿(paramsOnly 免 LLM 重生)必須 200
    sse = post(
        "/api/chat",
        {"sessionId": sid_tpl, "mode": "cable", "message": "", "params": {"w": 26.0, "h": 12.0}},
        timeout=600,
    )
    c.check(
        "A2: cable 段滑桿重生 200(不再 mode_mismatch)",
        "mode_mismatch" not in sse and "event: present" in sse,
        sse[:160].replace("\n", " | "),
    )

    # 家族兜底:非設計鏈模式(sketch)開 cable 範本 → 仍 mint 成 cable(不 400、不 design)
    op2 = json.loads(post("/api/open-project", {"dir": tpl, "mode": "sketch"}, timeout=600))
    if op2.get("sessionId"):
        cleanup_dirs.append(os.path.join(CADCHAT, op2["sessionId"]))
    c.check(
        "A2: sketch 模式開 cable 範本 → 退 TEMPLATE_META.family=cable",
        op2.get("ok") is True and op2.get("mode") == "cable",
        str({k: op2.get(k) for k in ("ok", "mode", "error")})[:160],
    )

    st, uploaded = post_raw(f"/api/upload-step?sessionId={SID_API}&name=smoke_{TAG}.step", STEP_BYTES)
    uploaded_abs = os.path.join(CADCHAT, SID_API, *str(uploaded.get("rel", "")).split("/"))
    head = open(uploaded_abs, "rb").read(16) if os.path.isfile(uploaded_abs) else b""
    c.check(
        "A: cable session upload-step 正案+磁碟落 uploads/",
        st == 200
        and uploaded.get("ok") is True
        and uploaded.get("sessionId") == SID_API
        and str(uploaded.get("rel", "")).startswith("uploads/")
        and head.startswith(b"ISO-10303-21"),
        f"{st} {str(uploaded)[:120]}",
    )

    # ================= B. 切換器 UI =================
    with open(STEP_TMP, "wb") as f:
        f.write(STEP_BYTES)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        errs = []
        # HMR ws 雜訊(雙實例開發時)不算 JS 錯誤
        page.on("pageerror", lambda e: "WebSocket" not in str(e) and errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".mode-switch")

        print("== B. ModeSwitch ==")
        c.check("B: 切換器四段", page.locator(".mode-seg").count() == 4)
        c.check("B: 分隔線存在(創作組|管理組)", page.locator(".mode-divider").count() == 1)
        c.check(
            "B: 段順序=sketch/design/cable/library",
            page.locator(".mode-seg").evaluate_all("els => els.map(e => e.dataset.mode)")
            == ["sketch", "design", "cable", "library"],
        )
        page.locator('.mode-seg[data-mode="cable"]').click()
        page.wait_for_selector('.mode-seg[data-mode="cable"][data-on="true"]')
        page.wait_for_function(
            "() => getComputedStyle(document.querySelector('.mode-seg[data-mode=\"cable\"]')).backgroundColor === 'rgb(24, 160, 196)'",
            timeout=3000,
        )
        c.check("B: 無塵電纜段青色選中", True)
        c.check(
            "B: localStorage cadchat.mode=cable",
            page.evaluate("() => localStorage.getItem('cadchat.mode')") == "cable",
        )
        # 2026-08-25 工作台改版:cable 有自己的五段(主線是表單不是對話推進),
        # 空狀態的範例只留「表單涵蓋不到」的兩條(選範本/填規格移到右側工作台)。
        c.check(
            "B: cable 專屬 stepper=選範本/填規格/生成/驗證/呈現",
            page.locator(".step-cn").all_inner_texts() == ["選範本", "填規格", "生成", "驗證", "呈現"],
            str(page.locator(".step-cn").all_inner_texts()),
        )
        c.check(
            "B: 空狀態指向右側工作台、範例只留對話用的兩條、無零件庫上傳區",
            "無塵電纜" in page.locator(".empty-title").inner_text()
            and "工作台" in page.locator(".empty-sub").inner_text()
            and page.locator(".example").count() == 2
            and page.locator(".lib-dropzone").count() == 0,
            page.locator(".empty-title").inner_text()[:40],
        )
        c.check(
            "B: composer 不鎖且 placeholder 提示上傳客戶 STEP",
            not page.locator(".composer-input").is_disabled()
            and "上傳客戶 STEP" in (page.locator(".composer-input").get_attribute("placeholder") or ""),
        )

        # ================= C. Composer STEP 附件邊界 =================
        print("== C. STEP 附件 ==")
        before = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        page.locator("input.composer-file").set_input_files(STEP_TMP)
        page.wait_for_selector('.img-chip[data-kind="step"][data-status="ready"]', timeout=30000)
        c.check("C: cable 模式 STEP chip 出現且 ready", True)
        after = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        for f_new in after - before:
            d = os.path.dirname(os.path.dirname(f_new))
            if d not in cleanup_dirs:
                cleanup_dirs.append(d)

        # 新 context 避開已有附件/session 的切模式確認框，驗 design 邊界。
        design_context = browser.new_context(viewport={"width": 1600, "height": 900})
        design_page = design_context.new_page()
        design_page.goto(BASE)
        design_page.wait_for_selector('.mode-seg[data-mode="design"][data-on="true"]')
        before_d = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        design_page.locator("input.composer-file").set_input_files(STEP_TMP)
        design_page.wait_for_timeout(800)
        after_d = set(glob.glob(os.path.join(CADCHAT, "*", "uploads", "*.step")))
        c.check(
            "C: design 模式丟 STEP → 無 chip、零上傳(模式邊界)",
            design_page.locator(".img-chip").count() == 0 and after_d == before_d,
            f"chips={design_page.locator('.img-chip').count()}",
        )
        design_context.close()

        # ================= D. 跨重整 =================
        print("== D. 跨重整 ==")
        seed_cable_session(SID_RE, sdk=None)
        snap = {
            "sessionId": SID_RE,
            "mode": "cable",
            "_seq": 1,
            "items": [],
            "versions": [],
            "activeVer": None,
            "canvas": {},
            "params": {"defs": [], "values": {}},
            "motion": None,
            "savedAt": int(time.time()),
        }
        page.evaluate(
            "(s) => { localStorage.setItem('cadchat.session.v1', JSON.stringify(s)); localStorage.setItem('cadchat.mode', 'cable'); }",
            snap,
        )
        page.reload()
        page.wait_for_selector('.mode-seg[data-mode="cable"][data-on="true"]', timeout=20000)
        c.check("D: reload 後切換器停無塵電纜", True)
        c.check("D: 全程無 JS 錯誤(HMR ws 雜訊除外)", not errs, "; ".join(errs[:3]))
        page.evaluate("() => localStorage.clear()")
        browser.close()
finally:
    for d in cleanup_dirs:
        shutil.rmtree(d, ignore_errors=True)
    if os.path.isfile(STEP_TMP):
        os.remove(STEP_TMP)

c.finish()
