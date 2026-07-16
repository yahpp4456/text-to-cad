# -*- coding: utf-8 -*-
"""掃出路徑預覽 overlay 煙測(免 LLM)。

A. API:open-project 開 cleanroom_sleeve_x(護套 dogfood)→ present/version 帶
   sweepPathsUrl(指向 versions/v1 快照)→ sidecar JSON 可取(96 點)+ 磁碟斷言。
B. 滑桿決定性重生(**只送 bend_r 子集**——同時驗 rewriteParams 磁碟墊底 merge
   不蒸發其餘鍵)→ v2 的 sweepPathsUrl 跟版,路徑終點 y == 2×新 bend_r
   (SWEEP_PATHS 與掃出共用同一路徑 spec 的 lockstep 證明)。
C. UI(真 FileBrowser 流):開專案 → 「⌒ 路徑」chip 出現且 data-on →
   __cadChrome.sweepPaths() count>0/visible → 點 chip → visible:false → 再點回。
D. 負案:__cadDispatch 注入無 sweepPathsUrl 的 PRESENT → chip 消失;
   API 開 sheet_u_bracket(無 SWEEP_PATHS)→ present.sweepPathsUrl 為 null。
"""
import json
import os
import re

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, get_with_headers, out_path, post, sse_events

c = Checker()
DIRP = "cleanroom_sleeve_x"

# ── A. API 鏈:open-project → sweepPathsUrl → sidecar 內容/磁碟 ──
j = json.loads(post("/api/open-project", {"dir": DIRP}, timeout=600))
c.check("A: open-project ok + 驗證過", j.get("ok") is True and j.get("validateOk") is True, str(j)[:200])
sid = j.get("sessionId") or ""
sweep_url = (j.get("present") or {}).get("sweepPathsUrl")
c.check("A: present 帶 sweepPathsUrl 且指向 v1 快照",
        bool(sweep_url) and "versions%2Fv1" in sweep_url, str(sweep_url))
c.check("A: version 事件同 URL", (j.get("version") or {}).get("sweepPathsUrl") == sweep_url)
status, _h, body = get_with_headers(sweep_url)
side = json.loads(body.decode("utf-8"))
pts = side["paths"][0]["points"]
c.check("A: sidecar JSON 可取(schemaVersion 1、96 點)",
        status == 200 and side.get("schemaVersion") == 1 and len(pts) == 96,
        f"status={status} pts={len(pts)}")
disk = os.path.join(REPO, "models", ".cadchat", sid, "versions", "v1", f".{DIRP}.sweep.json")
c.check("A: 磁碟快照 sidecar 存在且非空", os.path.isfile(disk) and os.path.getsize(disk) > 0, disk)
c.check("A: 滑桿六鍵齊(pockets/pocket_w/wall_t/straight_a/straight_b/bend_r)",
        {p["key"] for p in (j.get("params") or [])} ==
        {"pockets", "pocket_w", "wall_t", "straight_a", "straight_b", "bend_r"})

# ── B. 只送 bend_r 子集的決定性重生:merge 不蒸發 + overlay 跟版 lockstep ──
raw = post("/api/chat", {"sessionId": sid, "params": {"bend_r": 100.0}}, timeout=600)
evs = sse_events(raw)
pres_list = [d for e, d in evs if e == "present"]
pres2 = pres_list[-1] if pres_list else None
c.check("B: 子集參數重生成功產生 v2 present", bool(pres2) and pres2.get("ver") == "v2", str(pres2)[:200])
sweep_url2 = (pres2 or {}).get("sweepPathsUrl") or ""
c.check("B: v2 sweepPathsUrl 跟版(versions/v2)", "versions%2Fv2" in sweep_url2, sweep_url2)
_s2, _h2, body2 = get_with_headers(sweep_url2)
pts2 = json.loads(body2.decode("utf-8"))["paths"][0]["points"]
c.check("B: overlay 與掃出 lockstep——路徑終點 z == 2×新 bend_r(200,拖鏈平放姿態上層)",
        abs(pts2[-1][2] - 200.0) < 1e-6, str(pts2[-1]))

# ── C+D. UI:真 FileBrowser 開專案 → chip/探針/toggle → 注入負案 ──
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".hdr-btn")
    page.locator(".hdr-btn", has_text="開啟檔案").click()
    page.wait_for_selector(".fb-list")
    page.locator(".fb-crumb", has_text=re.compile(r"^models$")).click()
    page.wait_for_selector(".fb-projrow")
    page.locator(".fb-projrow", has_text=DIRP).click()
    page.wait_for_function(
        "() => [...document.querySelectorAll('.version-id')].some(e => e.textContent.includes('v1'))",
        timeout=300000)
    page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=60000)
    page.wait_for_timeout(500)

    chip = page.locator(".sweep-toggle")
    c.check("C: 「⌒ 路徑」chip 出現且預設開", chip.count() == 1 and chip.get_attribute("data-on") == "true")
    probe = page.evaluate("() => window.__cadChrome && window.__cadChrome.sweepPaths()")
    c.check("C: overlay 探針 visible + children>0(1 線 + 2 端點球)",
            bool(probe) and probe.get("visible") and probe.get("count", 0) >= 3, str(probe))
    chip.click()
    page.wait_for_timeout(150)
    probe_off = page.evaluate("() => window.__cadChrome.sweepPaths()")
    c.check("C: 點 chip → overlay 隱藏(場景不重建,visible:false)",
            bool(probe_off) and probe_off.get("visible") is False, str(probe_off))
    c.check("C: chip 轉非 active", chip.get_attribute("data-on") == "false")
    chip.click()
    page.wait_for_timeout(150)
    c.check("C: 再點回 → 恢復顯示", page.evaluate("() => window.__cadChrome.sweepPaths().visible") is True)
    page.screenshot(path=out_path("smoke_sweep_overlay.png"))

    # D(UI). 注入無 sweepPathsUrl 的 PRESENT → chip 消失(純前端,零 API;
    # 等 React 重渲染完成,固定 sleep 會 flake)
    page.evaluate(
        "() => window.__cadDispatch({ type: 'PRESENT', glbUrl: '/api/asset?file=nonexist.glb&v=9', name: 'x', code: 'x', ver: 'v9' })")
    try:
        page.wait_for_function(
            "() => document.querySelectorAll('.sweep-toggle').length === 0", timeout=8000)
        chip_gone = True
    except Exception:
        chip_gone = False
    c.check("D: 無 sweepPathsUrl 的 present → chip 消失", chip_gone)
    # Vite HMR websocket 在多 dev 實例並行(CADCHAT_PORT 第二實例)下會拋
    # 「WebSocket closed without opened.」——dev-chrome 雜訊,非產品面;過濾。
    real_errs = [e for e in errs if "WebSocket closed without opened" not in e]
    c.check("C/D: 全程無 JS 錯誤(HMR ws 雜訊除外)", not real_errs, "; ".join(real_errs[:3]))
    browser.close()

# D(API). 非掃出專案 → sweepPathsUrl null
j2 = json.loads(post("/api/open-project", {"dir": "sheet_u_bracket"}, timeout=600))
c.check("D: sheet_u_bracket(無 SWEEP_PATHS)present.sweepPathsUrl 為 null",
        j2.get("ok") is True and (j2.get("present") or {}).get("sweepPathsUrl") is None,
        str((j2.get("present") or {}).get("sweepPathsUrl")))

c.finish()
