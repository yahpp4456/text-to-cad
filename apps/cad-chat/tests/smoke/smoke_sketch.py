# -*- coding: utf-8 -*-
"""草模模式煙測(免 LLM):
A. 模式切換器:預設設計、點切草模、localStorage 持久化、running 鎖、有內容時 confirm 開新對話。
B. 注入渲染:__cadDispatch 注入場景 → SketchCanvas 掛載 → __cadSketch 探針
   (scene 計數/自動播放/applyAt 矩陣變化/setDrive 暫停)+ chrome(播放叢集/DofBar/讀數/圖例)。
C. 混排時間軸守衛:sketch 版 active 時匯出/精算鈕不亮(type 守衛)、CAD 版恢復。
D. API 負案例:bad mode 400、mode_mismatch 400、草模 session 六端點顯式 400、
   revert v99 404、revert v1 逐位元組還原+零 spawn(<1500ms)+sceneUrl 可取。
E. 跨重整續聊:localStorage 快照(mode:sketch)+ 磁碟 session → reload → hasSketch 放行回灌。

seed 直接寫 models/.cadchat/(gitignored、隨 GC),finally 全清——無「真資料備份三段式」需求。
"""
import json
import os
import shutil
import time
import urllib.parse

from playwright.sync_api import sync_playwright

from _util import BASE, REPO, Checker, get_with_headers, out_path, post

c = Checker()
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.abspath(
    os.path.join(HERE, "..", "..", "src", "lib", "sketch", "fixtures", "cylinder_tilt.json")
)
STEERING = os.path.abspath(
    os.path.join(HERE, "..", "..", "src", "lib", "sketch", "fixtures", "steering_rack.json")
)
BELT = os.path.abspath(
    os.path.join(HERE, "..", "..", "src", "lib", "sketch", "fixtures", "belt_drive.json")
)
TAG = str(int(time.time()))[-6:]  # 唯一 id 後綴:server 記憶體 registry 不吃前次殘留
SID_API = f"s_smoke_sk_api_{TAG}"
SID_RESTORE = f"s_smoke_sk_re_{TAG}"
CADCHAT = os.path.join(REPO, "models", ".cadchat")


def seed_sketch_session(sid, sdk=None):
    """磁碟 seed 一個草模 session:mech.sketch.json + versions/v1,v2 + session.json。"""
    d = os.path.join(CADCHAT, sid)
    os.makedirs(os.path.join(d, "versions", "v1"), exist_ok=True)
    os.makedirs(os.path.join(d, "versions", "v2"), exist_ok=True)
    shutil.copy2(FIXTURE, os.path.join(d, "versions", "v1", "mech.sketch.json"))
    shutil.copy2(STEERING, os.path.join(d, "versions", "v2", "mech.sketch.json"))
    shutil.copy2(STEERING, os.path.join(d, "mech.sketch.json"))  # 頂層=v2 內容
    shutil.copy2(BELT, os.path.join(d, "belt.sketch.json"))  # B 段皮帶注入用(不進版本鏈)
    for v, ts in (("v1", 1), ("v2", 2)):
        with open(os.path.join(d, "versions", v, "meta.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "mech", "type": "sketch", "partCount": 3, "ts": ts}, f)
    with open(os.path.join(d, "session.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "mode": "sketch",
                "sdkSessionId": sdk,
                "version": 2,
                "lastName": "mech",
                "lastPartCount": 3,
                "rehydratedFrom": None,
                "imports": [],
                "savedAt": 1,
            },
            f,
        )
    return d


def scene_url_for(sid, rel="mech.sketch.json"):
    return "/api/asset?file=" + urllib.parse.quote(f"models/.cadchat/{sid}/{rel}", safe="")


seeded = []
try:
    # ================= D. API 負案例(純 HTTP,先跑,不依賴瀏覽器) =================
    print("== D. API 負案例 / 草模回退 ==")
    r = json.loads(post("/api/chat", {"mode": "bogus", "message": "x"}))
    c.check("bad mode → 400 {error:'bad mode'}", r.get("error") == "bad mode", str(r))

    seeded.append(seed_sketch_session(SID_API, sdk="uuid-smoke-x"))
    r = json.loads(post("/api/chat", {"sessionId": SID_API, "mode": "design", "message": "x"}))
    c.check(
        "有歷史的草模 session 收 design turn → mode_mismatch 400 帶真相 mode",
        r.get("error") == "mode_mismatch" and r.get("mode") == "sketch",
        str(r),
    )
    guards = [
        ("/api/export", {"sessionId": SID_API, "format": "stl"}, "匯出"),
        ("/api/export-parts", {"sessionId": SID_API, "format": "step", "occs": ["o1.1"]}, "拆件"),
        ("/api/validate", {"sessionId": SID_API}, "精算"),
        ("/api/validate-ver", {"sessionId": SID_API}, "匯出前驗證"),
        ("/api/save-project", {"sessionId": SID_API, "name": f"x_{TAG}"}, "另存"),
    ]
    for path, body, tag in guards:
        rr = json.loads(post(path, body))
        c.check(
            f"草模 session {path} → 顯式 400(訊息含「草模」)",
            rr.get("ok") is False and "草模" in str(rr.get("error", "")),
            str(rr)[:120],
        )
    # import 的來源檔檢查在 session 之前:用真實存在的 models 檔打到守衛
    step_files = []
    models_dir = os.path.join(REPO, "models")
    for name in os.listdir(models_dir):
        p = os.path.join(models_dir, name, f"{name}.step")
        if os.path.isfile(p):
            step_files.append(f"{name}/{name}.step")
            break
    if step_files:
        rr = json.loads(post("/api/import", {"sessionId": SID_API, "file": step_files[0]}))
        c.check(
            "草模 session /api/import → 顯式 400(訊息含「草模」)",
            rr.get("ok") is False and "草模" in str(rr.get("error", "")),
            str(rr)[:120],
        )
    rr = json.loads(post("/api/revert-version", {"sessionId": SID_API, "ver": "v99"}))
    c.check("revert 不存在的 v99 → 404 誠實錯誤", rr.get("ok") is False and "快照" in str(rr.get("error", "")), str(rr)[:120])

    t0 = time.time()
    rr = json.loads(post("/api/revert-version", {"sessionId": SID_API, "ver": "v1"}))
    ms = (time.time() - t0) * 1000
    c.check("草模 revert v1 → ok、新版 v3、type sketch", rr.get("ok") is True and rr.get("version", {}).get("id") == "v3" and rr["version"].get("type") == "sketch", str(rr)[:200])
    c.check("草模 revert 零 spawn(<1500ms 實證代理)", ms < 1500, f"{ms:.0f}ms")
    top = open(os.path.join(CADCHAT, SID_API, "mech.sketch.json"), "rb").read()
    v1 = open(os.path.join(CADCHAT, SID_API, "versions", "v1", "mech.sketch.json"), "rb").read()
    c.check("回退後頂層檔逐位元組 == v1 快照", top == v1)
    c.check("versions/v3 快照已凍結(scene+meta)", os.path.getsize(os.path.join(CADCHAT, SID_API, "versions", "v3", "mech.sketch.json")) > 0 and os.path.getsize(os.path.join(CADCHAT, SID_API, "versions", "v3", "meta.json")) > 0)
    status, _, body = get_with_headers(rr["version"]["sceneUrl"])
    ok_json = False
    try:
        doc = json.loads(body.decode("utf-8"))
        ok_json = isinstance(doc.get("bodies"), list) and len(doc["bodies"]) > 0
    except Exception:
        pass
    c.check("present.sceneUrl GET → 200 且是合法場景 JSON", status == 200 and ok_json, f"HTTP {status}")

    # ================= 瀏覽器段 =================
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 950})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        chat_reqs = []
        page.on("request", lambda r: chat_reqs.append(r.url) if "/api/chat" in r.url else None)

        # ---- A. 模式切換器 ----
        print("== A. 模式切換器 ==")
        page.goto(BASE)
        page.wait_for_selector(".mode-switch")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_selector(".mode-switch")
        c.check(
            "預設「設計」段 active",
            page.get_attribute(".mode-seg[data-mode=design]", "data-on") == "true",
        )
        page.locator(".mode-seg[data-mode=sketch]").click()
        page.wait_for_function("() => document.querySelector('.mode-seg[data-mode=sketch]').dataset.on === 'true'")
        c.check("點切草模段 → active(無內容不出 confirm)", True)
        c.check(
            "localStorage cadchat.mode 持久化",
            page.evaluate("() => localStorage.getItem('cadchat.mode')") == "sketch",
        )
        c.check(
            "草模空狀態(canvas-empty-box.sketch + 草模範例)",
            page.locator(".canvas-empty-box.sketch").count() == 1
            and page.locator(".example", has_text="汽缸").count() >= 1,
        )
        c.check(
            "composer placeholder 換草模文案",
            "草模" in (page.get_attribute(".composer textarea", "placeholder") or ""),
        )
        page.reload()
        page.wait_for_selector(".mode-switch")
        c.check(
            "reload 後切換器仍在草模",
            page.get_attribute(".mode-seg[data-mode=sketch]", "data-on") == "true",
        )
        # running 鎖
        page.evaluate("() => window.__cadDispatch({ type: 'START_RUN' })")
        c.check(
            "running 期間切換器 disabled",
            page.get_attribute(".mode-switch", "data-disabled") == "true",
        )
        page.evaluate("() => window.__cadDispatch({ type: 'END_RUN' })")
        # 有內容時切換 → app 內樣式化確認框(非原生 window.confirm)
        page.evaluate("() => window.__cadDispatch({ type: 'ADD_USER', text: '假訊息' })")
        page.locator(".mode-seg[data-mode=design]").click()
        page.wait_for_selector(".confirm-dialog")
        c.check("有內容時切換 → 出 app 內確認框(非原生 confirm)", True)
        page.locator(".confirm-dialog .save-cancel").click()
        page.wait_for_function("() => !document.querySelector('.confirm-dialog')")
        c.check(
            "確認框「取消」→ 仍在草模、訊息保留",
            page.get_attribute(".mode-seg[data-mode=sketch]", "data-on") == "true"
            and page.evaluate("() => document.querySelectorAll('.msg-user').length") == 1,
        )
        page.locator(".mode-seg[data-mode=design]").click()
        page.wait_for_selector(".confirm-dialog")
        page.locator(".confirm-dialog .save-btn").first.click()
        page.wait_for_function("() => document.querySelector('.mode-seg[data-mode=design]').dataset.on === 'true'")
        c.check(
            "確認框「切換」→ 開新對話(items 清空、mode=design)",
            page.evaluate("() => document.querySelectorAll('.msg-user').length") == 0,
        )

        # ---- B. 注入渲染 + __cadSketch 契約 ----
        print("== B. 注入渲染 ==")
        su = scene_url_for(SID_API, "versions/v1/mech.sketch.json")
        page.evaluate(
            """(su) => {
              window.__cadDispatch({ type: 'SET_MODE', mode: 'sketch' });
              window.__cadDispatch({ type: 'ADD_VERSION', version: {
                id: 'v1', name: 'mech', sceneUrl: su, type: 'sketch', source: 'generated',
                title: '汽缸驅動平台前傾',
                dofs: [{ id: 'theta', label: '前傾角 θ', unit: '°', min: 0, max: 30 }],
              }});
              window.__cadDispatch({ type: 'PRESENT', sceneUrl: su, name: 'mech', ver: 'v1', fileType: 'sketch' });
            }""",
            su,
        )
        page.wait_for_function("() => window.__cadSketch && window.__cadSketch.scene()", timeout=20000)
        page.wait_for_timeout(900)
        scene = page.evaluate("() => window.__cadSketch.scene()")
        c.check(
            "場景編譯:3 bodies、1 drive、3 derived、pingpong",
            scene == {"bodies": 3, "drives": ["theta"], "derived": 3, "program": "pingpong"},
            str(scene),
        )
        st = page.evaluate("() => window.__cadSketch.state()")
        c.check("新草模自動播放(t 前進)", st["playing"] is True and st["t"] > 0.3, str(st)[:120])
        # applyAt 回布林(定格成功),frame 另取(契約同 __cadMotion.applyAt 模式)
        moved = page.evaluate(
            """() => {
              window.__cadSketch.applyAt(0);
              const a = JSON.stringify(window.__cadSketch.frame().bodyWorld.platform);
              window.__cadSketch.applyAt(2.5);
              const b = JSON.stringify(window.__cadSketch.frame().bodyWorld.platform);
              return a !== b;
            }"""
        )
        c.check("applyAt 定格:t=0 與 t=2.5 平台矩陣不同(真的在動)", moved is True)
        v = page.evaluate("() => window.__cadSketch.setDrive('theta', 15)")
        st2 = page.evaluate("() => window.__cadSketch.state()")
        c.check("setDrive scrub:值套上且自動暫停", abs(v - 15) < 1e-6 and st2["playing"] is False, str((v, st2.get("playing"))))
        mu = page.evaluate("() => window.__cadSketch.readout('傳動角 μ')")
        c.check("傳動角 μ 讀數存在且有紅黃綠狀態", bool(mu) and mu.get("status") in ("ok", "warn", "bad"), str(mu)[:120])
        c.check(
            "chrome 齊備:播放叢集/讀數條/圖例/DofBar 滑桿/誠實標語",
            page.locator(".sketch-play").count() == 1
            and page.locator(".sketch-readouts").count() == 1
            and page.locator(".sketch-legend").count() == 1
            and page.locator(".paramsbar[data-sketch] input[type=range]").count() == 1
            and page.locator(".sketch-note").count() == 1,
        )
        c.check("面標記/物件屬性/運動示意 chip 不存在(草模視圖天然排除)",
                page.locator(".marker-toggle").count() == 0
                and page.locator(".props-toggle").count() == 0
                and page.locator(".motion-toggle").count() == 0)
        page.screenshot(path=out_path("smoke_sketch_render.png"))

        # ---- B2. 傳動呈現積木(motor/pulley/belt;2026-07-14)----
        # 以 RESET 換場注入 belt_drive fixture:三新 part type 編譯+渲染零錯、
        # 皮帶耦合(同 drive 雙 revolute)場景可播。RESET 讓 C 段的 S1/badge
        # 計數斷言不受第二版本干擾。
        print("== B2. 皮帶傳動積木 ==")
        su_belt = scene_url_for(SID_API, "belt.sketch.json")
        page.evaluate(
            """(su) => {
              window.__cadDispatch({ type: 'RESET' });
              window.__cadDispatch({ type: 'SET_MODE', mode: 'sketch' });
              window.__cadDispatch({ type: 'ADD_VERSION', version: {
                id: 'v1', name: 'belt_drive', sceneUrl: su, type: 'sketch', source: 'generated',
                title: '馬達+皮帶減速(3:1)',
                dofs: [{ id: 'theta', label: '馬達轉角 θ', unit: '°', min: 0, max: 360 }],
              }});
              window.__cadDispatch({ type: 'PRESENT', sceneUrl: su, name: 'belt_drive', ver: 'v1', fileType: 'sketch' });
            }""",
            su_belt,
        )
        page.wait_for_function(
            "() => window.__cadSketch && window.__cadSketch.scene() && window.__cadSketch.scene().derived === 0",
            timeout=20000,
        )
        scene_b = page.evaluate("() => window.__cadSketch.scene()")
        c.check(
            "皮帶場景編譯:3 bodies、1 drive、零 derived(帶體是靜態 part)",
            scene_b == {"bodies": 3, "drives": ["theta"], "derived": 0, "program": "pingpong"},
            str(scene_b),
        )
        legend_txt = page.locator(".sketch-legend").inner_text()
        c.check(
            "圖例含 馬達/主動輪/從動輪(label 彙整)",
            "馬達" in legend_txt and "主動輪" in legend_txt and "從動輪" in legend_txt,
            legend_txt[:120],
        )
        # 圖例/scene() 都只讀 doc,釘不住 buildPart 真的長出網格(未知 type 靜默
        # return null 不丟錯)——真 Mesh 數才是渲染鏈活著的證據(對抗審查確認的假綠):
        # frame= box×3 + motor(機身/法蘭/軸伸/尾蓋)4 + belt 1 = 8;
        # pulley_in= 輪面+凸緣×2+轂 = 4;pulley_out= 4 + 軸1 + 指針1 + 孔1 = 7。
        mesh_n = page.evaluate("() => window.__cadSketch.meshCount()")
        c.check("場景真 Mesh 數 = 19(motor/pulley/belt 分支真的長出幾何)", mesh_n == 19, str(mesh_n))
        # frame() 是 RAF 週期更新的快取(clock.lastFrame)——setDrive 後要等下一幀,
        # 同一 JS task 內讀必然是舊幀(產品行為正確,別改成同步斷言)。
        # 謂詞鎖 !playing && theta===270:若只驗 pulley_out≈90,自動播放掃過 θ=270±0.3
        # 的暫態幀也會誤 true(setDrive 壞掉照樣綠的假綠窗)。
        page.evaluate("() => window.__cadSketch.setDrive('theta', 270)")
        page.wait_for_function(
            """() => {
              const f = window.__cadSketch.frame() || {};
              const st = window.__cadSketch.state();
              return !st.playing && (f.drives || {}).theta === 270
                && Math.abs(((f.jointValues || {}).pulley_out ?? -1) - 90) < 0.1;
            }""",
            timeout=5000,
        )
        ratio = page.evaluate("() => window.__cadSketch.frame().jointValues.pulley_out")
        c.check("皮帶耦合活的:θ=270 → 從動輪 90(scale=rA/rB 同號)", abs(ratio - 90) < 0.1, str(ratio))
        page.screenshot(path=out_path("smoke_sketch_belt.png"))

        # ---- C. 時間軸:草模 chip 樣式 + 匯出/精算鈕 type 守衛 ----
        print("== C. 時間軸守衛 ==")
        c.check(
            "草模 chip:S 縮圖 + 草模 TypeBadge",
            page.locator(".version-chip[data-sketch] .version-thumb", has_text="S1").count() == 1
            and page.locator(".version-chip[data-sketch] .type-badge", has_text="草模").count() == 1,
        )
        c.check(
            "草模 active:⇪ 轉為正式設計亮、匯出/精算/STEP 全暗",
            page.locator(".version-promote").count() == 1
            and page.locator(".version-dl", has_text="STL").count() == 0
            and page.locator(".version-dl", has_text="精算").count() == 0
            and page.locator(".version-dl", has_text="STEP").count() == 0,
        )
        # 混排(防禦):design 模式注入 sketch 版 → type 守衛仍不亮匯出鈕
        page.evaluate(
            """(su) => {
              window.__cadDispatch({ type: 'RESET' });
              window.__cadDispatch({ type: 'SET_MODE', mode: 'design' });
              window.__cadDispatch({ type: 'SET_SESSION', sessionId: 's_fake_mix' });
              window.__cadDispatch({ type: 'ADD_VERSION', version: {
                id: 'v1', name: 'part', glbUrl: '/x.glb', file: 'w/.p.step.glb', type: 'part', source: 'generated' }});
              window.__cadDispatch({ type: 'ADD_VERSION', version: {
                id: 'v2', name: 'mech', sceneUrl: su, type: 'sketch', source: 'generated' }});
            }""",
            su,
        )
        page.wait_for_selector(".version-chip[data-sketch]")
        c.check(
            "混排時間軸:sketch 版 active(v2)→ 匯出/精算不亮(type 守衛,與 mode 無關)",
            page.locator(".version-dl", has_text="STL").count() == 0
            and page.locator(".version-dl", has_text="精算").count() == 0,
        )
        page.locator(".version-chip", has_text="part").click()
        page.wait_for_timeout(200)
        c.check(
            "切回 CAD 版(v1)→ STL 匯出鈕恢復",
            page.locator(".version-dl", has_text="STL").count() >= 1,
        )
        c.check("全程零 /api/chat(注入/切換不燒回合)", len(chat_reqs) == 0, str(chat_reqs)[:120])

        # ---- E. 跨重整續聊(mode:sketch 快照 + hasSketch 放行) ----
        print("== E. 跨重整續聊 ==")
        seeded.append(seed_sketch_session(SID_RESTORE))
        snap = {
            "sessionId": SID_RESTORE,
            "mode": "sketch",
            "_seq": 2,
            "items": [{"type": "user", "id": "m1", "text": "草模測試"}],
            "versions": [
                {"id": "v2", "name": "mech", "sceneUrl": scene_url_for(SID_RESTORE), "type": "sketch", "source": "generated"}
            ],
            "activeVer": "v2",
            "canvas": {"sceneUrl": scene_url_for(SID_RESTORE), "glbUrl": "", "name": "mech", "ver": "v2", "status": "ready", "type": "sketch", "source": "generated"},
            "params": {"defs": [], "values": {}},
            "motion": None,
            "savedAt": 1,
        }
        page.evaluate(
            "(s) => { localStorage.setItem('cadchat.session.v1', JSON.stringify(s)); localStorage.setItem('cadchat.mode', 'sketch'); }",
            snap,
        )
        page.reload()
        page.wait_for_function("() => window.__cadSketch && window.__cadSketch.scene()", timeout=20000)
        c.check(
            "reload 回灌:草模場景重載(hasSketch 放行 RESTORE)",
            page.evaluate("() => window.__cadSketch.scene()") is not None,
        )
        c.check(
            "reload 回灌:切換器在草模、S 版本 chip 在",
            page.get_attribute(".mode-seg[data-mode=sketch]", "data-on") == "true"
            and page.locator(".version-chip[data-sketch]").count() == 1,
        )
        c.check("全程無 JS 錯誤", not errs, "; ".join(errs[:3]))
        page.evaluate("() => localStorage.clear()")
        browser.close()
finally:
    for d in seeded:
        shutil.rmtree(d, ignore_errors=True)

c.finish()
