# -*- coding: utf-8 -*-
"""零件庫模式 L4 煙測(消耗真 LLM 回合;CADCHAT_SMOKE_LLM=1 才由 run_all 執行)。

前置:/api/upload-step 上傳小 STEP(CDQ2 fixture)拿 sessionId+rel。
回合 1(丟檔,零中繼資料):斷言 session 事件 mode:"library"、library.preview
  工具事件(同 id done)、present 事件帶 glbUrl+source:"opened"、clarify 事件
  (訪談必問)、**零 version 事件**(收庫不進時間軸)、零 cad_* 工具事件
  (工具面隔離)、parts-library 磁碟零寫入。
回合 2(答訪談,含明確 slug):斷言 library.add done、parts-library/<slug>/
  {<slug>.step, meta.json} 落盤、meta 的 family/label、slug 英數。
回合 3(查庫,便宜):回覆文字含剛收的型號(Glob/Read 查庫路通)。
回合 4(設計整合,使用者指定 E2E):庫件 /api/import 進新設計 session →
  設計回合「配上安裝底板組裝」→ 斷 version 事件、present glbUrl、
  產生器引用 imported/(庫件真的配上了設計幾何)。
finally 清 parts-library 新增目錄與兩個 session。
"""
import glob
import json
import os
import shutil
import urllib.request

from _util import BASE, Checker, REPO, post, sse_events

c = Checker()
STEP_SRC = os.path.join(REPO, "models", "ref-cdm2", "cdm2b20_50z.stp")
LIB_ROOT = os.path.join(REPO, "models", "parts-library")
SLUG = "smoke_cdm2_live"

lib_before = set(os.listdir(LIB_ROOT)) if os.path.isdir(LIB_ROOT) else set()
up_sid = None
design_sid = None

try:
    # ── 前置:上傳 STEP ──
    req = urllib.request.Request(
        BASE + "/api/upload-step?name=smoke_cdm2_live.stp",
        data=open(STEP_SRC, "rb").read(),
        method="POST",
    )
    req.add_header("content-type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=120) as r:
        up = json.loads(r.read().decode("utf-8"))
    c.check("前置:upload-step ok", up.get("ok") is True and up.get("rel", "").startswith("uploads/"), str(up)[:150])
    up_sid = up.get("sessionId")
    rel = up.get("rel")

    # ── 回合 1:丟檔,零中繼資料 → 必訪談 ──
    raw = post(
        "/api/chat",
        {"sessionId": up_sid, "mode": "library", "message": "把這個收進零件庫。", "stepRefs": [rel]},
        timeout=600,
    )
    events = sse_events(raw)
    kinds = [e for e, _ in events]

    c.check(
        "①session 事件 mode:'library'(runner 選路)",
        any(d.get("mode") == "library" for e, d in events if e == "session"),
    )
    pv_ids = {d.get("id") for e, d in events if e == "tool" and str(d.get("name", "")).startswith("library.preview")}
    c.check(
        "①library.preview 工具事件且(同 id)done",
        bool(pv_ids)
        and any(d.get("status") == "done" for e, d in events if e == "tool" and d.get("id") in pv_ids),
        str([d.get("name") for e, d in events if e == "tool"])[:200],
    )
    presents = [d for e, d in events if e == "present"]
    c.check(
        "①present 帶 glbUrl 且 source:'opened'(預覽不進時間軸)",
        any(d.get("glbUrl") and d.get("source") == "opened" for d in presents),
        str(presents)[:200],
    )
    c.check("①clarify 事件(訪談必問)", "clarify" in kinds, str(kinds)[:200])
    c.check("①零 version 事件(收庫不是建模迭代)", "version" not in kinds, str(kinds)[:200])
    tool_names = [str(d.get("name", "")) for e, d in events if e == "tool"]
    c.check("①零 cad_* 工具事件(工具面隔離)", not any(n.startswith("cad.") for n in tool_names), str(tool_names)[:200])
    c.check(
        "①parts-library 零寫入(訪談前不收庫)",
        (set(os.listdir(LIB_ROOT)) if os.path.isdir(LIB_ROOT) else set()) == lib_before,
    )

    # ── 回合 2:答訪談(明確 slug 讓清理決定性) ──
    raw = post(
        "/api/chat",
        {
            "sessionId": up_sid,
            "mode": "library",
            "message": f"名稱:SMC 圓形氣缸 CDM2B20-50Z;slug 用 {SLUG};family:cylinder;"
            "廠牌:SMC;備註:煙測收庫件,可刪。就用這些收庫,不用再問。",
        },
        timeout=600,
    )
    events2 = sse_events(raw)
    add_ids = {d.get("id") for e, d in events2 if e == "tool" and str(d.get("name", "")).startswith("library.add")}
    c.check(
        "②library.add 工具事件且(同 id)done",
        bool(add_ids)
        and any(d.get("status") == "done" for e, d in events2 if e == "tool" and d.get("id") in add_ids),
        str([d.get("name") for e, d in events2 if e == "tool"])[:200],
    )
    step_abs = os.path.join(LIB_ROOT, SLUG, f"{SLUG}.step")
    meta_abs = os.path.join(LIB_ROOT, SLUG, "meta.json")
    c.check("②磁碟落盤 <slug>.step(slug 英數且遵指示)", os.path.isfile(step_abs) and os.path.getsize(step_abs) > 1000, step_abs)
    meta = json.loads(open(meta_abs, encoding="utf-8").read()) if os.path.isfile(meta_abs) else {}
    c.check(
        "②meta.json:family=cylinder、label 含 CDM2、bboxMm 3 元",
        meta.get("family") == "cylinder" and "CDM2" in str(meta.get("label", "")).upper()
        and isinstance(meta.get("bboxMm"), list) and len(meta["bboxMm"]) == 3,
        str(meta)[:200],
    )

    # ── 回合 3:查庫(便宜) ──
    raw = post(
        "/api/chat",
        {"sessionId": up_sid, "mode": "library", "message": "零件庫裡有哪些氣缸?列 label 就好。"},
        timeout=600,
    )
    ai_text = " ".join(str(d.get("text", "")) for e, d in sse_events(raw) if e == "ai")
    c.check("③查庫回答含剛收的型號(Glob/Read 路通)", "CDM2" in ai_text.upper(), ai_text[:200])

    # ── 回合 4:設計模式用庫件配設計幾何(shelf「⇪ 設計」同一條 server 路)──
    imp = json.loads(post("/api/import", {"file": f"parts-library/{SLUG}/{SLUG}.step"}, timeout=120))
    c.check("④庫件匯入新設計 session ok", imp.get("ok") is True and imp.get("rel", "").startswith("imported/"), str(imp)[:150])
    design_sid = imp.get("sessionId")
    raw = post(
        "/api/chat",
        {
            "sessionId": design_sid,
            "mode": "design",
            "message": f"把已匯入的 {imp.get('rel')} 配上設計幾何:一塊長方形安裝底板"
            "(比氣缸投影每邊大 10mm、厚 8mm),氣缸立在底板正中央,組成組合件。"
            "快速產出即可,不用精算、不用問我。",
        },
        timeout=900,
    )
    ev4 = sse_events(raw)
    k4 = [e for e, _ in ev4]
    c.check("④設計回合產出版本(version 事件)", "version" in k4, str(k4)[:200])
    c.check(
        "④present 帶 glbUrl(組合結果上畫布)",
        any(d.get("glbUrl") for e, d in ev4 if e == "present"),
    )
    # 產生器真的引用了庫件複本(imported/)——「配上設計幾何」的磁碟證據
    pys = [
        p
        for p in glob.glob(os.path.join(REPO, "models", ".cadchat", design_sid or "_", "*.py"))
        if os.path.isfile(p)
    ]
    src4 = " ".join(open(p, encoding="utf-8", errors="ignore").read() for p in pys)
    c.check("④產生器引用 imported/ 庫件複本", "imported/" in src4, str(pys)[-120:])
finally:
    # 清理:明確 slug + 保險(diff 出的新目錄一併清)+ session
    lib_after = set(os.listdir(LIB_ROOT)) if os.path.isdir(LIB_ROOT) else set()
    for slug in (lib_after - lib_before) | {SLUG}:
        shutil.rmtree(os.path.join(LIB_ROOT, slug), ignore_errors=True)
    if up_sid:
        shutil.rmtree(os.path.join(REPO, "models", ".cadchat", up_sid), ignore_errors=True)
    if design_sid:
        shutil.rmtree(os.path.join(REPO, "models", ".cadchat", design_sid), ignore_errors=True)

c.finish()
