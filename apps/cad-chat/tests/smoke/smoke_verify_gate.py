# -*- coding: utf-8 -*-
"""單一快路徑 + 匯出閘煙測(取代雙模式時代的 smoke_output_mode.py):
A. 快路徑契約(免 LLM API):open-project flip_gripper → v1 verified=true(open 是
   full);滑桿重生一律零 spawn(checks 全 skipped、ms<1.5s、verified=false;body 帶
   已死欄位 outputMode:"actual" 也不改變行為=回歸鎖)、motion 供源自 build sidecar、
   version 事件不再帶 mode 欄位。
B. 匯出閘(免 LLM API):未驗證版 /api/export → gate 自動精算放行(gate.ran=true);
   同版重匯 memo 命中(ran=false);/api/validate-ver 單獨入口 + 重打 memo;壞版本
   id 404。
C. 壞幾何擋下(臨時 fixture):MOTION 打滑最小件(靜態乾淨、唯掃掠抓穿透——
   build 的 check_geometry 自檢擋不到的缺陷類)→ open-project full 驗證抓到、
   v1 verified=false、/api/export 擋下(ok=false + gate.checks 有紅)、
   /api/validate-ver verified=false。
D. UI(Playwright):模式 toggle 已拆(零殘留)、未驗證 badge/精算標記仍在、
   STEP 下載鈕依 verified 分流(未驗證=閘 onClick 鈕、已驗證=直連 href)、
   user 氣泡不再染模式色。
E. flip_gripper revolute 動畫(真 GLB + __cadMotion;模式無關,沿舊煙測)。
F. steering_box 齒輪齒條耦合動畫(couple 借主動相位;模式無關,沿舊煙測)。
G. regen 失敗回滾(臨時 fixture:w<h → 負長度 Box 必炸):滑桿套壞參數 →
   error 事件含「已還原」、tool note 是 condense 摘要(例外行+產生器行號)、
   params_values 事件把滑桿拉回、磁碟 .py PARAMS 還原;再套合法值成功出新版
   (自癒鏈路)。
前置:dev server 8788、models/flip_gripper 與 models/steering_box_rack_pinion
已重生(.step.glb 為實體檔)。
"""
import json
import os
import shutil
import urllib.parse

from playwright.sync_api import sync_playwright

from _util import BASE, REPO, Checker, out_path, post, sse_events

c = Checker()

# ── A. 快路徑契約(純 API,先跑:不佔瀏覽器) ──
dj = json.loads(post("/api/open-project", {"dir": "flip_gripper"}))
c.check("A: open-project flip_gripper ok", dj.get("ok") is True, str(dj)[:200])
a_sid, a_name = dj.get("sessionId"), dj.get("name")
a_v1 = dj.get("version") or {}
c.check("A: v1 verified=true(open-project full 驗證)", a_v1.get("verified") is True, str(a_v1)[:200])
c.check("A: version 事件不再帶 mode 欄位(雙模式已收斂)", "mode" not in a_v1, str(a_v1)[:200])
a_defs = dj.get("params") or []
c.check("A: flip_gripper 有參數滑桿(重生入口)", bool(a_defs))
a_values = {d["key"]: d["value"] for d in a_defs}

# 滑桿重生:唯一 spawn 是 build,驗證走 sidecar 零 spawn。body 故意帶已死的
# outputMode:"actual"——server 已無此欄位,行為必須仍是快路徑(回歸鎖)。
raw = post("/api/chat", {"sessionId": a_sid, "params": a_values, "outputMode": "actual"})
evs = sse_events(raw)
vals = [d for e, d in evs if e == "validate"]
c.check("A: 重生有 validate 事件", len(vals) == 1, f"n={len(vals)}")
if vals:
    v = vals[0]
    not_skipped = [ck for ck in v.get("checks", []) if not ck.get("skipped")]
    c.check("A: 快路徑 checks 全 skipped(outputMode 欄位已死,帶了也沒用)",
            not not_skipped, str(not_skipped)[:200])
    # ms=0 合法且是零 spawn 的最強證明(sidecar 路徑 <1ms 取整成 0);`or 9e9` 的
    # falsy-0 慣用法會把 0 誤判成缺值 → 改 is not None 區分「沒帶欄位」與「真 0」。
    _ms = v.get("ms")
    c.check("A: 零 spawn 驗證 <1.5s(spawn 路徑 ≥8s)", _ms is not None and _ms < 1500, f"ms={_ms}")
    c.check("A: partCount>0(sidecar 帶 parts)", (v.get("partCount") or 0) > 0, str(v.get("partCount")))
a_dofs = ([d for e, d in evs if e == "motion"][-1].get("dofs") if any(e == "motion" for e, _ in evs) else []) or []
c.check("A: motion 事件含 revolute flip(sidecar 供源)",
        any(x.get("id") == "flip" and x.get("type") == "revolute" for x in a_dofs), str(a_dofs)[:200])
a_vers = [d for e, d in evs if e == "version"]
c.check("A: 重生版 verified=false(快路徑=未驗證,badge 琥珀)",
        bool(a_vers) and a_vers[-1].get("verified") is False and "mode" not in a_vers[-1],
        str(a_vers[-1] if a_vers else None)[:200])
a_v2 = a_vers[-1].get("id") if a_vers else None

a_wd = os.path.join(REPO, "models", ".cadchat", a_sid)
c.check("A: build sidecar 落盤", os.path.exists(os.path.join(a_wd, f".{a_name}.step.meta.json")))
c.check("A: asm manifest 落盤(拆件匯出依賴)", os.path.exists(os.path.join(a_wd, f"{a_name}.asm.json")))

# ── B. 匯出閘(同一 session 續用) ──
if a_v2:
    ex1 = json.loads(post("/api/export", {"sessionId": a_sid, "ver": a_v2, "format": "stl"}, timeout=300))
    c.check("B: 未驗證版匯出 → 閘自動精算放行(ok+gate.ran)",
            ex1.get("ok") is True and (ex1.get("gate") or {}).get("ran") is True
            and (ex1.get("gate") or {}).get("ok") is True,
            str(ex1)[:250])
    stl_abs = os.path.join(REPO, "models", str(ex1.get("file") or "").replace("models/", "", 1))
    c.check("B: STL 真的落盤(size>0)",
            ex1.get("ok") is True and os.path.exists(stl_abs) and os.path.getsize(stl_abs) > 0,
            str(ex1.get("file")))
    ex2 = json.loads(post("/api/export", {"sessionId": a_sid, "ver": a_v2, "format": "stl"}, timeout=300))
    c.check("B: 同版重匯 → memo 命中免重驗(gate.ran=false)",
            ex2.get("ok") is True and (ex2.get("gate") or {}).get("ran") is False, str(ex2.get("gate")))

    # 再重生一版(未驗證)走 validate-ver 單獨入口(STEP 直下載把關用)
    raw3 = post("/api/chat", {"sessionId": a_sid, "params": a_values})
    v3 = ([d for e, d in sse_events(raw3) if e == "version"][-1] or {}).get("id")
    vv1 = json.loads(post("/api/validate-ver", {"sessionId": a_sid, "ver": v3}, timeout=300))
    c.check("B: validate-ver 對未驗證版 → 精算放行(verified+gate.ran)",
            vv1.get("ok") is True and vv1.get("verified") is True
            and (vv1.get("gate") or {}).get("ran") is True, str(vv1)[:250])
    vv2 = json.loads(post("/api/validate-ver", {"sessionId": a_sid, "ver": v3}, timeout=300))
    c.check("B: validate-ver 重打 → memo 命中(ran=false)",
            vv2.get("verified") is True and (vv2.get("gate") or {}).get("ran") is False, str(vv2.get("gate")))
    vv404 = json.loads(post("/api/validate-ver", {"sessionId": a_sid, "ver": "v99"}))
    c.check("B: validate-ver 對不存在的版本 → 誠實拒絕", vv404.get("ok") is not True, str(vv404)[:150])

# ── C. 壞幾何擋下(臨時 fixture:MOTION 打滑,唯掃掠可抓) ──
GATE_FIXTURE = os.path.join(REPO, "models", "tmp_smoke_gate")
GEN = '''from build123d import Box, Pos
from cadpy.assembly import AssemblyHelper

PARAMS = {"gap": 10.0}

INTENDED_CONTACT = []

# 靜態分離(gap 10),但 travel -15 會把 slider 掃進 base——build 的 check_geometry
# 自檢(靜態)擋不到,唯 full 掃掠可抓:匯出閘存在意義的最小重現。
MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "slide", "type": "linear", "axis": [1, 0, 0], "travel": -15.0,
         "moving": ["slider"], "pairs": [["slider", "base"]], "samples": 8},
    ],
}


def gen_step():
    asm = AssemblyHelper("tmp_smoke_gate")
    asm.add(Box(10, 10, 10), "base")
    asm.add(Pos(10 + PARAMS["gap"], 0, 0) * Box(10, 10, 10), "slider")
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid, assert_no_interference

    assert_all_valid(shape, label="part")
    assert_no_interference(shape, allow=INTENDED_CONTACT)
'''
os.makedirs(GATE_FIXTURE, exist_ok=True)
try:
    with open(os.path.join(GATE_FIXTURE, "tmp_smoke_gate.py"), "w", encoding="utf-8") as f:
        f.write(GEN)
    gj = json.loads(post("/api/open-project", {"dir": "tmp_smoke_gate"}, timeout=300))
    c.check("C: 打滑 fixture open ok(build 過:靜態自檢乾淨)", gj.get("ok") is True, str(gj)[:250])
    c.check("C: open 的 full 驗證抓到掃掠穿透(validateOk=false)", gj.get("validateOk") is False,
            str(gj.get("validateOk")))
    g_v1 = (gj.get("version") or {})
    c.check("C: v1 verified=false", g_v1.get("verified") is False, str(g_v1)[:150])
    g_sid = gj.get("sessionId")
    gex = json.loads(post("/api/export", {"sessionId": g_sid, "ver": "v1", "format": "stl"}, timeout=300))
    g_gate = gex.get("gate") or {}
    c.check("C: 壞幾何匯出被擋(ok=false + 訊息)",
            gex.get("ok") is not True and "擋下" in str(gex.get("error") or ""), str(gex)[:250])
    c.check("C: gate.checks 有紅(掃掠 ✗ 進驗證卡)",
            g_gate.get("ran") is True
            and any(ck.get("icon") == "✗" for ck in g_gate.get("checks") or []),
            str(g_gate)[:250])
    gvv = json.loads(post("/api/validate-ver", {"sessionId": g_sid, "ver": "v1"}, timeout=300))
    c.check("C: validate-ver 同樣擋(verified=false)",
            gvv.get("ok") is True and gvv.get("verified") is False, str(gvv)[:200])
finally:
    shutil.rmtree(GATE_FIXTURE, ignore_errors=True)
c.check("C: 臨時 fixture 已清", not os.path.exists(GATE_FIXTURE))

# ── G. regen 失敗回滾(臨時 fixture:壞參數 → 負長度 Box 必炸) ──
RB_FIXTURE = os.path.join(REPO, "models", "tmp_smoke_rollback")
RB_GEN = '''from build123d import Box
from cadpy.assembly import AssemblyHelper

PARAMS = {"w": 20.0, "h": 10.0}

INTENDED_CONTACT = []


def gen_step():
    asm = AssemblyHelper("tmp_smoke_rollback")
    asm.add(Box(PARAMS["w"] - PARAMS["h"], 10, 10), "block")
    return asm.build()


def check_geometry(shape):
    from cadpy.geometry_checks import assert_all_valid

    assert_all_valid(shape, label="part")
'''
os.makedirs(RB_FIXTURE, exist_ok=True)
try:
    with open(os.path.join(RB_FIXTURE, "tmp_smoke_rollback.py"), "w", encoding="utf-8") as f:
        f.write(RB_GEN)
    rj = json.loads(post("/api/open-project", {"dir": "tmp_smoke_rollback"}, timeout=300))
    c.check("G: 回滾 fixture open ok(w=20 合法)", rj.get("ok") is True, str(rj)[:250])
    r_sid = rj.get("sessionId")
    r_py = os.path.join(REPO, "models", ".cadchat", r_sid or "_", "tmp_smoke_rollback.py")

    # 壞參數(w-h=-5 → Box 負長度炸 OCP;必送全部鍵,rewriteParams 整塊替換)
    r_evs = sse_events(post("/api/chat", {"sessionId": r_sid, "params": {"w": 5, "h": 10}}, timeout=300))
    r_errs = [d for e, d in r_evs if e == "error"]
    c.check("G: 壞參數 → error 事件含「已還原」(回滾生效+告知)",
            any("已還原" in str(d.get("message") or "") for d in r_errs), str(r_errs)[:250])
    r_tools = [d for e, d in r_evs if e == "tool" and d.get("status") == "error"]
    r_note = str(r_tools[-1].get("note") or "") if r_tools else ""
    c.check("G: tool note 是 condense 摘要(例外行,非原始 traceback 尾)",
            "Standard_DomainError" in r_note and "Traceback" not in r_note, r_note[:200])
    c.check("G: note 帶產生器行號(於 <name>.py 第 N 行)",
            "於 tmp_smoke_rollback.py 第" in r_note, r_note[:200])
    r_pv = [d for e, d in r_evs if e == "params_values"]
    c.check("G: params_values 事件把滑桿拉回磁碟真相(w=20)",
            bool(r_pv) and (r_pv[-1].get("values") or {}).get("w") == 20, str(r_pv)[:200])
    with open(r_py, encoding="utf-8") as f:
        r_src = f.read()
    c.check("G: 磁碟 .py PARAMS 已還原(w 仍 20,無漂移)",
            '"w": 20.0' in r_src and '"w": 5' not in r_src, r_src[r_src.find("PARAMS"):][:80])

    # 自癒鏈路:再套合法值 → build 成功出新版
    r_evs2 = sse_events(post("/api/chat", {"sessionId": r_sid, "params": {"w": 30, "h": 10}}, timeout=300))
    r_vers2 = [d for e, d in r_evs2 if e == "version"]
    c.check("G: 回滾後套合法值 → 成功出新版(自癒)", bool(r_vers2), str(r_vers2)[:150])
    with open(r_py, encoding="utf-8") as f:
        c.check("G: 成功套用後磁碟 PARAMS = 新值", '"w": 30' in f.read())
finally:
    shutil.rmtree(RB_FIXTURE, ignore_errors=True)
c.check("G: 臨時 fixture 已清", not os.path.exists(RB_FIXTURE))

# ── E/F 段共用資料(沿舊 smoke_output_mode 的動畫驗證,模式無關) ──
FLIP_MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {
            "id": "flip", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, -31.0],
            "angle_deg": 90, "period_s": 4,
            "moving": ["rotary_hub", "swing_bracket", "gripper_body",
                       "jaw_left", "jaw_right", "finger_left", "finger_right"],
        },
    ],
}
_glb = "/api/asset?file=" + urllib.parse.quote("flip_gripper/.flip_gripper.step.glb", safe="")
FLIP_URL = (
    BASE + "/?glb=" + urllib.parse.quote(_glb, safe="")
    + "&name=flip_gripper&motion=" + urllib.parse.quote(json.dumps(FLIP_MOTION), safe="")
)

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ── D. UI:toggle 拆除 + badge/STEP 鈕分流 + 氣泡不染色 ──
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errs_d = []
    page.on("pageerror", lambda e: errs_d.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".canvas-empty", timeout=15000)

    c.check("D: 模式 toggle 已拆(.composer-mode 零殘留)", page.locator(".composer-mode").count() == 0)
    c.check("D: __cadOutputMode dev 鉤已拆",
            page.evaluate("() => typeof window.__cadOutputMode") == "undefined")

    # RESTORE 注入帶 sessionId 的快照(downloadStep 需要 sessionId 才掛閘鈕);
    # file 用快照隱藏 GLB 形狀讓 stepRelFor 推得出 STEP 路徑。
    page.evaluate(
        "() => window.__cadDispatch({ type: 'RESTORE', snapshot: { sessionId: 's_fake_ui',"
        " versions: [{ id: 'v1', name: 'x', source: 'generated', verified: false,"
        " file: 'models/.cadchat/s_fake_ui/versions/v1/.x.step.glb', glbUrl: '', formats: [] }],"
        " activeVer: 'v1' } })"
    )
    page.wait_for_timeout(250)
    c.check("D: 未驗證 badge 顯示(琥珀)",
            page.locator('.ver-verify[data-state="unverified"]').count() == 1)
    step_btns = page.locator(".version-dl", has_text="STEP")
    c.check("D: 未驗證版 STEP 鈕=閘 onClick 型(無 href,title 提示自動精算)",
            step_btns.count() == 1
            and step_btns.first.get_attribute("href") is None
            and "自動精算" in (step_btns.first.get_attribute("title") or ""),
            f"n={step_btns.count()} title={step_btns.first.get_attribute('title') if step_btns.count() else None}")
    page.evaluate("() => window.__cadDispatch({ type: 'MARK_VERSION_VERIFIED', id: 'v1' })")
    page.wait_for_timeout(200)
    c.check("D: 精算標記 → badge 轉已驗證(綠)",
            page.locator('.ver-verify[data-state="verified"]').count() == 1)
    c.check("D: 已驗證版 STEP 鈕=直連 href 型(免閘)",
            page.locator(".version-dl", has_text="STEP").first.get_attribute("href") is not None)

    # 鈑金 DXF 鈕:hasDxf 才亮;RESTORE 快照帶旗標 = 重整後仍在(M3 回歸鎖)
    c.check("D: 非鈑金版無 DXF 展開圖鈕", page.locator(".version-dl", has_text="DXF").count() == 0)
    page.evaluate(
        "() => window.__cadDispatch({ type: 'RESTORE', snapshot: { sessionId: 's_fake_ui',"
        " versions: [{ id: 'v1', name: 'x', source: 'generated', verified: false, hasDxf: true,"
        " file: 'models/.cadchat/s_fake_ui/versions/v1/.x.step.glb', glbUrl: '', formats: ['STEP','GLB','DXF'] }],"
        " activeVer: 'v1' } })"
    )
    page.wait_for_timeout(250)
    c.check("D: 鈑金版(hasDxf)重整還原後 DXF 展開圖鈕仍在",
            page.locator(".version-dl", has_text="DXF 展開圖").count() == 1)

    page.evaluate("() => window.__cadDispatch({ type: 'ADD_USER', text: '測試訊息' })")
    page.wait_for_timeout(150)
    c.check("D: user 氣泡不再染模式色(無 data-mode)",
            page.locator(".user-bubble").count() == 1
            and page.locator(".user-bubble[data-mode]").count() == 0)

    c.check("D 頁無 JS 錯誤", not errs_d, "; ".join(errs_d[:3]))
    page.screenshot(path=out_path("smoke_verify_gate_ui.png"))
    page.close()

    # ── E. flip_gripper revolute 前傾動畫(真 GLB + __cadMotion) ──
    page2 = browser.new_page(viewport={"width": 1480, "height": 920})
    errs_e = []
    page2.on("pageerror", lambda e: errs_e.append(str(e)))
    page2.goto(FLIP_URL)
    page2.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page2.wait_for_timeout(2500)

    cov = page2.evaluate("() => window.__cadMotion && window.__cadMotion.coverage && window.__cadMotion.coverage()")
    c.check("E: flip 運動 coverage>0(moving label 對得上 record)", bool(cov) and cov > 0, f"cov={cov}")

    ok0 = page2.evaluate("() => window.__cadMotion.applyAt(0)")
    m0 = page2.evaluate("() => window.__cadMotion.matrixFor('finger_left')")
    page2.evaluate("() => window.__cadMotion.applyAt(2)")
    m1 = page2.evaluate("() => window.__cadMotion.matrixFor('finger_left')")

    c.check("E: applyAt 生效", ok0 is True)
    c.check("E: finger_left 有 effectMatrix(16 元素)", isinstance(m1, list) and len(m1) == 16)
    if isinstance(m0, list) and isinstance(m1, list) and len(m0) == 16 and len(m1) == 16:
        c.check("E: u=0 近 identity(m00≈1)", abs(m0[0] - 1) < 0.05, f"m00={m0[0]:.3f}")
        c.check("E: u=1 明顯旋轉(m00 大幅偏離 1)", abs(m1[0] - 1) > 0.3, f"m00={m1[0]:.3f}")
        c.check("E: u=0 → u=1 矩陣改變(動畫真的動)", m0 != m1)

    c.check("E 頁無 JS 錯誤", not errs_e, "; ".join(errs_e[:3]))
    page2.screenshot(path=out_path("smoke_verify_gate_flip.png"))
    page2.close()

    # ── F. steering_box 齒輪齒條耦合動畫(真 GLB + __cadMotion couple 同相位) ──
    RP_GEAR, STROKE_GEAR = 4.9, 7.6969  # m0.7 z14:節圓半徑、90° 齒條行程 R·π/2
    GEAR_MOTION = {
        "schemaVersion": 1,
        "dofs": [
            {"id": "stroke", "type": "linear", "axis": [0, 1, 0],
             "travel": -STROKE_GEAR, "period_s": 4, "moving": ["rack"]},
            {"id": "swing", "type": "revolute", "axis": [0, 0, 1],
             "pivot": [0, 0, 67.5], "angle_deg": 90, "period_s": 4,
             "couple": "stroke", "moving": ["pinion"]},
        ],
    }
    _gglb = "/api/asset?file=" + urllib.parse.quote(
        "steering_box_rack_pinion/.steering_box_rack_pinion.step.glb", safe="")
    gear_url = (
        BASE + "/?glb=" + urllib.parse.quote(_gglb, safe="")
        + "&name=steering_box&motion=" + urllib.parse.quote(json.dumps(GEAR_MOTION), safe="")
    )
    page3 = browser.new_page(viewport={"width": 1480, "height": 920})
    errs_f = []
    page3.on("pageerror", lambda e: errs_f.append(str(e)))
    page3.goto(gear_url)
    page3.wait_for_selector("canvas.cad-canvas", timeout=30000)
    page3.wait_for_timeout(2500)

    cov_f = page3.evaluate("() => window.__cadMotion && window.__cadMotion.coverage && window.__cadMotion.coverage()")
    c.check("F: 耦合運動 coverage=1(rack/pinion 都對上 record)", cov_f == 1, f"cov={cov_f}")
    # t=1s → 主動 dof(index0)相位 0.25 → u=0.5:rack y=-3.848、pinion 轉 45°。
    # couple 若沒生效,swing 會用自己的 index1 相位(0.25+0.17→u=0.84→75.6°,
    # cos=0.249),與 cos45°=0.707 一翻兩瞪眼。
    page3.evaluate("() => window.__cadMotion.applyAt(1)")
    mr = page3.evaluate("() => window.__cadMotion.matrixFor('rack')")
    mp = page3.evaluate("() => window.__cadMotion.matrixFor('pinion')")
    ok_mats = isinstance(mr, list) and isinstance(mp, list) and len(mr) == 16 and len(mp) == 16
    c.check("F: rack/pinion 都有 effectMatrix", ok_mats)
    if ok_mats:
        import math as _math
        c.check("F: u=0.5 rack 位移 -3.85(主動 linear)",
                abs(mr[13] - (-STROKE_GEAR / 2)) < 0.05, f"y={mr[13]:.3f}")
        c.check("F: u=0.5 pinion 轉 45°(couple 借主動相位,非 0.17 錯開的 75.6°)",
                abs(mp[0] - _math.cos(_math.radians(45))) < 0.02, f"m00={mp[0]:.3f}")
        theta = _math.atan2(mp[1], mp[0])
        c.check("F: 純滾動關係 y = -R·θ(嚙合不打滑)",
                abs(mr[13] + RP_GEAR * theta) < 0.05,
                f"y={mr[13]:.3f} vs -R·θ={-RP_GEAR * theta:.3f}")

    c.check("F 頁無 JS 錯誤", not errs_f, "; ".join(errs_f[:3]))
    page3.screenshot(path=out_path("smoke_verify_gate_gear.png"))
    browser.close()

c.finish()
