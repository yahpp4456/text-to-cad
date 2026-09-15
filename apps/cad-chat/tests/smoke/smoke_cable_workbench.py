# -*- coding: utf-8 -*-
"""無塵電纜工作台煙測(免 LLM):範本貨架 → 規格表單 → 直接生成 → 另存案件 → 複製成新案。

A. API:GET /api/templates(範本欄位齊、family 過濾、壞宣告不列)。
B. UI:貨架兩頁籤與卡片、規格表單(可改欄位/固定結構/派生數字)、canSkipAi 降級。
C. 零 LLM 生成:表單改值 →「直接生成」→ v1 + 滑桿值 = 表單值(一次 build)。
D. 另存案件 → case.json → 工作台「案件」頁籤 →「複製成新案」以該案值預填表單。
用輕量 fixture 範本(TEMPLATE_META family=cable + 一顆盒子):走的是與真電纜件
完全相同的路徑,但 build 幾十秒而非兩分鐘。fixture 目錄 finally 全清。
"""
import json
import os
import shutil
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, post

c = Checker()
TAG = str(int(time.time()))[-6:]
TPL = f"smoke_wb_tpl_{TAG}"
CASE_DIR = f"smoke_wb_case_{TAG}"
CADCHAT = os.path.join(REPO, "models", ".cadchat")
cleanup_dirs = []

TPL_SRC = """\
TEMPLATE_META = {"family": "cable", "form": "per_layer", "label": "煙測範本", "summary": "smoke fixture", "unit": "mm", "self_contained": 1}
PARAM_LABELS = {"L1": "第1層(內層)電纜長", "L2": "第2層(外層)電纜長", "head_h": "固定頭高", "mount_h": "固定頭安裝高度"}
PARAM_NOTES = {"L1": "端到端,含兩端夾持段 32.4", "mount_h": "上固定頭底面 → 下固定頭底面"}
CABLE_SPEC = {
  "layers": 2,
  "riser_module": 0,
  "bands": [
    {"key": "inner", "level": 1, "n": 6, "bore": 14.0, "web": 2.5, "edge": 4.25, "x": 0.0},
    {"key": "outer", "level": 0, "n": 7, "bore": 11.4, "web": 2.8, "edge": 4.2, "x": 0.0}
  ]
}
PARAMS = {"L1": 790.0, "L2": 830.0, "width": 118.2, "head_h": 28.0, "mount_h": 190.0, "bottom_leg": 70.0}
PARAM_RANGES = {"L1": [200, 2500, 5], "L2": [200, 2500, 5], "width": [50, 250, 2], "head_h": [23, 80, 0.5], "mount_h": [50, 500, 1], "bottom_leg": [10, 600, 1]}
INTENDED_CONTACT = []

from build123d import *  # noqa: E402,F401,F403


def gen_step():
    return Box(PARAMS["head_h"], PARAMS["L1"] / 10.0, PARAMS["mount_h"] / 10.0)
"""


def write_tpl(dirname, src=TPL_SRC, case_json=None):
    abs_dir = os.path.join(REPO, "models", dirname)
    os.makedirs(abs_dir, exist_ok=True)
    cleanup_dirs.append(abs_dir)
    with open(os.path.join(abs_dir, f"{dirname}.py"), "w", encoding="utf-8") as f:
        f.write(src)
    if case_json is not None:
        with open(os.path.join(abs_dir, "case.json"), "w", encoding="utf-8") as f:
            json.dump(case_json, f, ensure_ascii=False)
    return abs_dir


def get_json(path, timeout=60):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


try:
    # ================= A. API =================
    print("== A. /api/templates ==")
    write_tpl(TPL)
    write_tpl(
        CASE_DIR,
        case_json={
            "kind": "case",
            "family": "cable",
            "label": f"案件-{TAG}",
            "customer": "客戶甲",
            "created": "2026-08-25",
            "source_template": TPL,
            "note": "煙測案件",
        },
    )
    j = get_json("/api/templates?family=cable")
    tpl = next((t for t in j["templates"] if t["dir"] == TPL), None)
    case = next((t for t in j["cases"] if t["dir"] == CASE_DIR), None)
    c.check("A: 範本清單含 fixture 且欄位齊", bool(tpl) and tpl["layers"] == 2
            and len(tpl["bands"]) == 2 and len(tpl["params"]) == 6
            and tpl["labels"]["L1"].startswith("第1層")
            and tpl["values"]["L1"] == 790.0, str(tpl)[:200])
    c.check("A: 有 case.json 的目錄歸案件(不在範本清單)",
            bool(case) and case["case"]["customer"] == "客戶甲"
            and all(t["dir"] != CASE_DIR for t in j["templates"]), str(case)[:200])
    j2 = get_json("/api/templates?family=nosuchfamily")
    c.check("A: family 過濾生效", all(t["dir"] != TPL for t in j2["templates"]), str(j2)[:120])

    # ================= B/C/D. UI =================
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1500, "height": 940})
        errs = []
        page.on("pageerror", lambda e: "WebSocket" not in str(e) and errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_selector(".mode-switch")
        page.locator('.mode-seg[data-mode="cable"]').click()
        page.wait_for_selector(".cable-shelf", timeout=15000)
        page.wait_for_function(
            "() => window.__cadCableShelf && window.__cadCableShelf.counts().templates > 0",
            timeout=15000)

        print("== B. 貨架 + 規格表單 ==")
        counts = page.evaluate("() => window.__cadCableShelf.counts()")
        c.check("B: 貨架同時有範本與案件", counts["templates"] >= 1 and counts["cases"] >= 1, str(counts))
        c.check("B: cable 專屬 stepper(選範本/填規格)",
                page.locator(".step-cn").all_inner_texts()[:2] == ["選範本", "填規格"],
                str(page.locator(".step-cn").all_inner_texts()))
        # 案件頁籤
        page.locator(".cable-tab", has_text="案件").click()
        c.check("B: 案件頁籤列出案件卡",
                page.locator(f'.cable-card[data-dir="{CASE_DIR}"]').count() == 1)
        page.locator(".cable-tab", has_text="範本").click()

        page.locator(f'.cable-card[data-dir="{TPL}"] .fb-action', has_text="填規格").click()
        page.wait_for_selector(".cable-window", timeout=5000)
        labels = page.locator(".cable-field .cable-field-label").all_inner_texts()
        c.check("B: 表單欄位用中文標籤(PARAM_LABELS)", "第1層(內層)電纜長" in labels, str(labels))
        c.check("B: 欄位附量法說明(PARAM_NOTES)",
                any("32.4" in t for t in page.locator(".cable-field-note").all_inner_texts()))
        c.check("B: 右欄顯示層數與帶表(CABLE_SPEC;單條層可編)",
                page.locator(".cable-layers b").inner_text() == "2"
                and page.locator('.cable-fixed-row[data-level="1"] .cable-band-n').input_value() == "6"
                and page.locator('.cable-fixed-row[data-level="1"] .cable-band-bore').input_value() == "14",
                str(page.locator(".cable-fixed-row").all_inner_texts())[:160])
        # 固定座螺向(2026-08-25 客戶抓過 X 的 OEM STEP 螺絲建反 → 升格表單欄位;
        # fixture 的 CABLE_SPEC 無 measured → 預設=實裝標準 1。翻轉純函數在 L1
        # cableSpec.test.js 驗,這裡只驗渲染與預設不歪)
        c.check("B: 固定座螺向列(預設=實裝標準:六角袋朝下)+翻轉鈕",
                page.locator('.cable-fixed-row[data-screw="1"]').count() == 1
                and "六角袋朝下" in page.locator('.cable-fixed-row[data-screw="1"]').inner_text()
                and page.locator(".cable-screw-flip").count() == 1)
        c.check("B: 派生數字(總高=mount_h+head_h)",
                any("總高 218" in t for t in page.locator(".cable-derived-chip").all_inner_texts()),
                str(page.locator(".cable-derived-chip").all_inner_texts()))
        c.check("B: 值都在範圍 → 直接生成可按",
                page.locator(".cable-btn-primary").get_attribute("data-disabled") is None)
        # 即時閉式檢核(/api/cable/check;與 build 時的 _check_params 同一份實作)
        page.wait_for_function(
            "() => [...document.querySelectorAll('.cable-derived-chip')].some(e => e.textContent.includes('彎徑'))",
            timeout=15000)
        c.check("B: 派生數字改用閉式(彎徑/包絡長來自 /api/cable/check)",
                any("彎徑" in t for t in page.locator(".cable-derived-chip").all_inner_texts()),
                str(page.locator(".cable-derived-chip").all_inner_texts()))
        # 跨參數耦合違規(單欄範圍看不出來):L1 拉到與 L2 幾乎等長 → 巢套餘隙不足
        l1 = page.locator('.cable-field[data-key="L1"] input')
        l1.fill("2400")
        l1.press("Enter")
        page.wait_for_selector('.cable-field[data-key="L1"][data-bad]', timeout=15000)
        c.check("B: 閉式違規 → 欄位標紅 + 主鈕禁用(不必等 1–2 分鐘 build 才知道)",
                page.locator(".cable-btn-primary").get_attribute("data-disabled") == "true"
                and page.locator(".cable-field-bad").count() >= 1,
                page.locator(".cable-field-bad").first.inner_text()[:70])
        c.check("B: 訊息帶可套用的上/下限鈕", page.locator(".cable-fix").count() >= 1)
        page.locator(".cable-fix").first.click()
        page.wait_for_function(
            "() => !document.querySelector('.cable-field[data-key=\"L1\"][data-bad]')", timeout=15000)
        c.check("B: 套用回報的界限 → 檢核轉綠、主鈕恢復",
                page.locator(".cable-btn-primary").get_attribute("data-disabled") is None,
                l1.input_value())
        # 勾「不確定量法」→ 主鈕降級(禁用但仍渲染 + 有理由)
        page.locator(".cable-unsure input").check()
        c.check("B: 勾不確定 → 直接生成禁用並說明理由",
                page.locator(".cable-btn-primary").get_attribute("data-disabled") == "true"
                and "量法" in (page.locator(".cable-foot-hint").inner_text() or ""),
                page.locator(".cable-foot-hint").inner_text()[:60])
        # 給 AI 確認 → 契約文字預填 composer(不送出、不 build)
        page.locator(".cable-btn", has_text="給 AI 確認").click()
        page.wait_for_function(
            "() => (document.querySelector('.composer textarea')||{}).value?.startsWith('電纜規格:')",
            timeout=5000)
        draft = page.locator(".composer textarea").input_value()
        c.check("B: 給 AI 確認 → composer 預填「電纜規格:」契約(含不確定段)",
                "電纜規格:" in draft and TPL in draft and "不確定:" in draft, draft[:120])
        c.check("B: 預填後表單收起(焦點回輸入框)", page.locator(".cable-window").count() == 0)
        page.locator(".composer textarea").fill("")

        print("== C. 直接生成(零 LLM)==")
        page.locator(f'.cable-card[data-dir="{TPL}"] .fb-action', has_text="填規格").click()
        page.wait_for_selector(".cable-window", timeout=5000)
        box = page.locator('.cable-field[data-key="L1"] input')
        box.fill("780")
        box.press("Enter")
        t0 = time.time()
        page.locator(".cable-btn-primary").click()
        page.wait_for_selector(".live-row[data-pending]", timeout=8000)
        c.check("C: 生成中有 pending 活動列,主鈕鎖住(連點守衛)",
                page.locator(".cable-btn-primary").get_attribute("data-disabled") == "true")
        page.wait_for_function(
            "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
            timeout=300000)
        print(f"   (build {round(time.time() - t0)}s)")
        c.check("C: 生成後表單自動收起", page.locator(".cable-window").count() == 0)
        c.check("C: 切換器仍在 cable(session mode 校正)",
                page.locator('.mode-seg[data-on="true"]').get_attribute("data-mode") == "cable")
        page.wait_for_selector(".param .numfield input", timeout=20000)
        vals = dict(zip(page.locator(".param-label").all_inner_texts(),
                        page.locator(".param .numfield input").evaluate_all("els => els.map(e => e.value)")))
        c.check("C: 滑桿值 = 表單送出的值(一次 build,不是先建範本再重生)",
                vals.get("L1") == "780" and vals.get("mount_h") == "190", str(vals))
        # sessionId 取自續聊快照(有 debounce → 等它落盤,別在生成完當下就讀)
        page.wait_for_function(
            "() => (JSON.parse(localStorage.getItem('cadchat.session.v1')||'{}').sessionId||'').startsWith('s_')",
            timeout=20000)
        sid = page.evaluate("() => JSON.parse(localStorage.getItem('cadchat.session.v1')||'{}').sessionId")
        if sid:
            cleanup_dirs.append(os.path.join(CADCHAT, sid))
        gen_src = ""
        if sid:
            gen_py = os.path.join(CADCHAT, sid, f"{TPL}.py")
            gen_src = open(gen_py, encoding="utf-8").read() if os.path.isfile(gen_py) else ""
        c.check("C: 磁碟產生器 PARAMS 已是表單值(rewriteParams 於 build 前套用)",
                '"L1": 780' in gen_src, f"sid={sid} len={len(gen_src)}")

        print("== D. 另存案件 → 複製成新案 ==")
        saved = f"smoke_wb_saved_{TAG}"
        cleanup_dirs.append(os.path.join(REPO, "models", saved))
        page.locator(".hdr-btn", has_text="另存案件").click()
        page.wait_for_selector(".save-dialog", timeout=5000)
        inputs = page.locator(".save-dialog .save-input")
        c.check("D: cable 另存對話框多出客戶/備註欄", inputs.count() == 3, str(inputs.count()))
        inputs.nth(0).fill(saved)
        inputs.nth(1).fill("客戶乙")
        inputs.nth(2).fill("煙測另存")
        page.locator(".save-dialog .save-btn", has_text="儲存").first.click()
        page.wait_for_function(
            "(d) => !document.querySelector('.save-dialog')", arg=saved, timeout=20000)
        case_path = os.path.join(REPO, "models", saved, "case.json")
        meta = json.load(open(case_path, encoding="utf-8")) if os.path.isfile(case_path) else {}
        c.check("D: 另存寫出 case.json(客戶/日期/來源範本)",
                meta.get("kind") == "case" and meta.get("customer") == "客戶乙"
                and meta.get("created", "").count("-") == 2, str(meta)[:160])
        page.wait_for_function(
            "(d) => window.__cadCableShelf && window.__cadCableShelf.counts().cases >= 2",
            arg=saved, timeout=15000)
        page.locator(".lib-shelf-toggle", has_text="展開").click()
        page.locator(".cable-tab", has_text="案件").click()
        page.locator(f'.cable-card[data-dir="{saved}"] .fb-action', has_text="複製成新案").click()
        page.wait_for_selector(".cable-window", timeout=5000)
        c.check("D: 複製成新案 → 表單以該案現值預填(780 而非範本 790)",
                page.locator('.cable-field[data-key="L1"] input').input_value() == "780")
        c.check("D: 表單標題標示複製成新案",
                "複製成新案" in page.locator(".sweepwin-title").inner_text())
        print("== E. 改層數(結構重生)==")
        # 從 2 層 fixture 加一層 → 3 層:CABLE_SPEC/PARAMS/PARAM_RANGES 一起改寫
        page.locator(".cable-window .sweepwin-close").click()
        page.locator(".cable-tab", has_text="範本").click()
        page.locator(f'.cable-card[data-dir="{TPL}"] .fb-action', has_text="填規格").click()
        page.wait_for_selector(".cable-window", timeout=5000)
        before_fields = page.locator(".cable-field").count()
        page.locator(".cable-step", has_text="＋").click()
        page.wait_for_function(
            "(n) => document.querySelectorAll('.cable-field').length === n + 1",
            arg=before_fields, timeout=5000)
        c.check("E: 加層 → 新 L 欄位長出來(defs 跟著層數,不只是 values)",
                page.locator('.cable-field[data-key="L3"]').count() == 1
                and page.locator(".cable-layers b").inner_text() == "3",
                f"fields {before_fields}→{page.locator('.cable-field').count()}")
        c.check("E: 既有層的 L 編號不動(加在最外側)",
                page.locator('.cable-field[data-key="L1"] input').input_value() == "790")
        c.check("E: head_h 自動抬到新層數的下限(保住原加高量)",
                page.locator('.cable-field[data-key="head_h"] input').input_value() == "39.5",
                page.locator('.cable-field[data-key="head_h"] input').input_value())
        c.check("E: 標示結構已改", page.locator(".cable-specdirty").count() == 1)
        page.wait_for_function(
            "() => [...document.querySelectorAll('.cable-derived-chip')].some(e => e.textContent.includes('彎徑'))",
            timeout=15000)
        c.check("E: 即時檢核對「改後的結構」算(spec 覆寫)",
                len(page.locator(".cable-derived-chip").all_inner_texts()) >= 3
                and page.locator(".cable-btn-primary").get_attribute("data-disabled") is None,
                str(page.locator(".cable-derived-chip").all_inner_texts()))
        t1 = time.time()
        prev_sid = page.evaluate("() => JSON.parse(localStorage.getItem('cadchat.session.v1')||'{}').sessionId || ''")
        page.locator(".cable-btn-primary").click()
        # C 段已經有 v1 了 → 不能等「出現 v1」(會立刻命中舊的);等 session 換成新的
        page.wait_for_function(
            "(prev) => { const s = JSON.parse(localStorage.getItem('cadchat.session.v1')||'{}');"
            " return (s.sessionId||'').startsWith('s_') && s.sessionId !== prev"
            " && (s.versions||[]).some(v => v.id === 'v1'); }",
            arg=prev_sid, timeout=400000)
        print(f"   (3 層 build {round(time.time() - t1)}s)")
        sid2 = page.evaluate("() => JSON.parse(localStorage.getItem('cadchat.session.v1')||'{}').sessionId")
        if sid2:
            cleanup_dirs.append(os.path.join(CADCHAT, sid2))
        src2 = ""
        if sid2:
            gen2 = os.path.join(CADCHAT, sid2, f"{TPL}.py")
            src2 = open(gen2, encoding="utf-8").read() if os.path.isfile(gen2) else ""
        c.check("E: 產生器的 CABLE_SPEC 已是 3 層",
                '"layers": 3' in src2 and src2.count('"level":') == 3, f"len={len(src2)}")
        c.check("E: PARAM_RANGES 一起重寫(新 L3 有固定範圍、head_h 下限跟著層數)",
                '"L3": [' in src2 and '"head_h": [34.5' in src2,
                src2[src2.find("PARAM_RANGES"):src2.find("PARAM_RANGES") + 160])
        page.wait_for_selector(".param .numfield input", timeout=20000)
        keys = page.locator(".param-label").all_inner_texts()
        c.check("E: 滑桿是 3 層的鍵集(沒有幽靈鍵)",
                "L3" in keys and "L4" not in keys, str(keys))
        c.check("E: 全程無 JS 錯誤", not errs, "; ".join(errs[:3]))
        browser.close()
finally:
    for d in cleanup_dirs:
        shutil.rmtree(d, ignore_errors=True)

c.finish()
