# -*- coding: utf-8 -*-
"""ChatCAD 圖文使用手冊 — Playwright 截圖擷取器。

需要 dev server 已在跑(`cd apps/cad-chat && npm run dev`,預設 8788)。本擷取器
**不會自己起 server**(比照 tests/smoke/run_all.py):server 不可達就印指引後結束。

每張圖的流程:佈置畫面(setup)→ 截圖到 img/<id>.png → 用 bounding_box 記錄要框選
的元件矩形(CSS px,1480×920 座標系)→ 寫 img/<id>.json。組裝端(assemble.py)把
矩形換成百分比、疊上 CSS 框與編號圖例,不烙圖。

擺拍圖(免 LLM)用 dev 鉤 window.__cadDispatch 注入 UI 狀態、或 ?glb= 直接載入既有
GLB fixture;真回合圖(需認證)實際送出對話等 AI 串流收斂。

用法:
  PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/docs/guide/build/capture.py \
      [--only id1,id2] [--headed] [--no-live] [--list]
"""
import argparse
import json
import os
import sys
import traceback

from playwright.sync_api import sync_playwright

from guidelib import BASE, IMG, VIEWPORT, glb_page_url, health  # noqa: F401


# ── Playwright 佈景助手:setup 函式收到一個 Cad 實例,封裝常用動作 ──
class Cad:
    def __init__(self, page, sink):
        self.page = page
        self.sink = sink  # storyboard 逐點擷取寫這裡

    # -- 逐點擷取(storyboard 用;一次真回合裡多點截圖)--
    def snap(self, sid, callouts=None, chapter=None, title=""):
        self.page.wait_for_timeout(250)
        png = os.path.join(IMG, sid + ".png")
        self.page.screenshot(path=png, full_page=False)
        cos = resolve_callouts(self.page, callouts or [])
        meta = {
            "id": sid,
            "chapter": chapter,
            "title": title,
            "viewport": VIEWPORT,
            "callouts": cos,
        }
        with open(os.path.join(IMG, sid + ".json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        missing = [c["n"] for c in cos if not c["rect"]]
        self.sink.append({"id": sid, "status": "ok", "missing_callouts": missing})
        return png

    # -- 導覽 --
    def goto(self, url=None, wait_networkidle=True):
        self.page.goto(url or BASE)
        if wait_networkidle:
            try:
                self.page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass

    def goto_glb(self, rel_glb, name, motion=None):
        self.page.goto(glb_page_url(rel_glb, name, motion))
        self.wait_canvas()

    # -- 等待 --
    def wait_canvas(self, timeout=30000, settle=2400):
        self.page.wait_for_selector("canvas.cad-canvas", timeout=timeout)
        self.page.wait_for_timeout(settle)

    def wait_empty(self, timeout=15000):
        self.page.wait_for_selector(".canvas-empty", timeout=timeout)

    def wait(self, sel, timeout=8000, **kw):
        return self.page.wait_for_selector(sel, timeout=timeout, **kw)

    def sleep(self, ms):
        self.page.wait_for_timeout(ms)

    # -- 狀態注入(dev 鉤,零 LLM)--
    def dispatch(self, action):
        self.page.evaluate("(a) => window.__cadDispatch(a)", action)

    def evaluate(self, expr, arg=None):
        return self.page.evaluate(expr, arg)

    def click(self, sel, **kw):
        self.page.click(sel, **kw)

    def click_text(self, sel, text, **kw):
        self.page.locator(sel, has_text=text).first.click(**kw)

    # -- /api/chat stub(擺拍時擋掉真網路,可安全點「送出」)--
    def stub_chat(self):
        posted = []

        def _h(route):
            try:
                posted.append(json.loads(route.request.post_data or "{}"))
            except Exception:
                posted.append({})
            route.fulfill(
                status=200,
                headers={"content-type": "text/event-stream"},
                body='event: ai\ndata: {"text": "(stub)"}\n\n',
            )

        self.page.route("**/api/chat", _h)
        return posted

    # -- 真回合:填輸入 → 送出 → 等 AI 串流收斂(中斷鈕 detach 判完成)--
    def run_turn(self, text, done_timeout=300000):
        self.page.fill(".composer-input", text)
        self.page.click(".composer-btn.send")
        # 回合開跑:送出鈕變中斷鈕
        self.page.wait_for_selector(".composer-btn.interrupt", timeout=45000)
        # 回合結束:中斷鈕 detach(同一顆按鈕換回 .send)
        self.page.wait_for_selector(".composer-btn.interrupt", state="detached", timeout=done_timeout)
        self.page.wait_for_timeout(2500)


# ── 框選矩形計算 ──
def _bbox(page, sel):
    try:
        b = page.locator(sel).first.bounding_box()
        if not b:
            return None
        return [round(b["x"], 1), round(b["y"], 1), round(b["width"], 1), round(b["height"], 1)]
    except Exception:
        return None


def _union(rects):
    rects = [r for r in rects if r]
    if not rects:
        return None
    x0 = min(r[0] for r in rects)
    y0 = min(r[1] for r in rects)
    x1 = max(r[0] + r[2] for r in rects)
    y1 = max(r[1] + r[3] for r in rects)
    return [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)]


def resolve_callouts(page, callouts):
    """把 shot 的 callouts 解析成 {n,label,rect,tone}。rect 缺失(元件不存在)→ 記 None。"""
    out = []
    for co in callouts:
        rect = None
        if "rect" in co:
            rect = co["rect"]
        elif "sels" in co:
            rect = _union([_bbox(page, s) for s in co["sels"]])
        elif "sel" in co:
            rect = _bbox(page, co["sel"])
        out.append(
            {
                "n": co["n"],
                "label": co["label"],
                "rect": rect,
                "tone": co.get("tone", "primary"),
                "pad": co.get("pad", 6),
                "note": None if rect else "元件未出現(rect=None)",
            }
        )
    return out


def run_shot(browser, shot, live_ok):
    is_live = shot.get("live", False)
    if is_live and not live_ok:
        return {"id": shot["id"], "status": "skipped-live", "callouts": [], "errors": [], "warnings": []}

    page = browser.new_page(viewport=VIEWPORT, device_scale_factor=2)
    # pageerror(未捕捉 JS 例外)= 畫面可能半掛 → 硬閘,計入失敗;
    # console.error 可能只是 React dev 警告 → 軟記錄(warnings),不擋 exit code。
    errors = []
    warnings = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: warnings.append("console.error: " + m.text) if m.type == "error" else None)
    sink = []
    cad = Cad(page, sink)
    status = "ok"
    try:
        shot["setup"](cad)
        # 一般單張圖:setup 未自行 snap → 這裡自動補一張(用 shot 本身的 id/callouts)
        if not shot.get("storyboard") and not sink:
            page.wait_for_timeout(shot.get("presettle", 300))
            cad.snap(shot["id"], shot.get("callouts", []), shot["chapter"], shot.get("title", ""))
    except Exception:
        status = "error"
        errors.append(traceback.format_exc().splitlines()[-1])
        traceback.print_exc()
    finally:
        page.close()

    missing = sorted({n for s in sink for n in s.get("missing_callouts", [])})
    # 硬閘:框選缺失(UI class 改名 → rect=None)與 JS 例外都算失敗。這條管線存在的
    # 目的就是抓「手冊 vs 實際 UI」漂移,軟警告會假綠——半渲染畫面或缺框的圖
    # 不得靜默入手冊(review 2026-07-16)。
    status = status if sink or status == "error" else "empty"
    if status == "ok" and (missing or errors):
        status = "error"
    return {
        "id": shot["id"],
        "status": status,
        "captured": [s["id"] for s in sink],
        "errors": errors,
        "warnings": warnings,
        "missing_callouts": missing,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="逗號分隔的 shot id;只跑這些")
    ap.add_argument("--headed", action="store_true", help="顯示瀏覽器(除錯用)")
    ap.add_argument("--no-live", action="store_true", help="跳過需認證的真回合圖")
    ap.add_argument("--list", action="store_true", help="只列出所有 shot id")
    args = ap.parse_args()

    from shots import SHOTS  # noqa: E402  (延後 import,讓 --list 也能在 server 沒起時用)

    if args.list:
        for s in SHOTS:
            print(f"  [{s['chapter']:>2}] {s['id']:<28} {'(live)' if s.get('live') else ''}  {s.get('title','')}")
        return

    h = health()
    if not h:
        print("✗ dev server 不可達(" + BASE + ")。請先在另一視窗執行:")
        print("    cd apps/cad-chat && npm run dev")
        sys.exit(2)
    live_ok = (not args.no_live) and h.get("agentReady") and h.get("authMode") in ("oauth", "apikey")
    print(f"server authMode={h.get('authMode')} agentReady={h.get('agentReady')} → 真回合圖 {'啟用' if live_ok else '跳過(退化擺拍)'}")

    only = set(x.strip() for x in args.only.split(",") if x.strip())
    # 預設批次跳過 optional 圖(如燒 LLM 的真回合 storyboard);要跑就用 --only 指名
    shots = [s for s in SHOTS if (s["id"] in only) or (not only and not s.get("optional"))]

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        for i, shot in enumerate(shots, 1):
            tag = "(live)" if shot.get("live") else ""
            print(f"[{i}/{len(shots)}] {shot['id']} {tag} …", flush=True)
            r = run_shot(browser, shot, live_ok)
            results.append(r)
            flag = {"ok": "✓", "error": "✗", "skipped-live": "·", "empty": "∅"}.get(r["status"], "?")
            if r.get("captured") and len(r["captured"]) > 1:
                extra_cap = "  ⟶ " + ",".join(r["captured"])
            else:
                extra_cap = ""
            extra = extra_cap
            if r.get("missing_callouts"):
                extra += f"  ✗ 框選缺失:{r['missing_callouts']}"
            if r.get("errors"):
                extra += f"  ✗ JS 例外:{r['errors'][0][:80]}"
            if r.get("warnings"):
                extra += f"  ⚠ console.error×{len(r['warnings'])}(僅記錄)"
            print(f"     {flag} {r['status']}{extra}")
        browser.close()

    with open(os.path.join(IMG, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"base": BASE, "authMode": h.get("authMode"), "results": results}, f, ensure_ascii=False, indent=2)

    n_ok = sum(1 for r in results if r["status"] == "ok")
    n_err = sum(1 for r in results if r["status"] == "error")
    n_skip = sum(1 for r in results if r["status"] == "skipped-live")
    print(f"\n== {n_ok} ok, {n_err} error, {n_skip} skipped-live ==")
    if n_err:
        sys.exit(1)


if __name__ == "__main__":
    main()
