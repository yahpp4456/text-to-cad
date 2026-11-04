# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):產品設計模式一回合——對稱滑鼠上蓋。
斷:(a) 回合在 product 模式、agent 走 surface_present_draft(surface_draft 事件)且零 cad_* 工具;
(b) 草稿含 symmetry 與放樣;(c) 同回合 surface_build → 恰一個 version 帶 surfaceUrl、sidecar
summary.ok 且 g2≥1;(d) 滑桿 thick 存在;(e) 收尾回覆不含內部詞(wording 契約);
(f) 第二回合 patch 迭代(加厚改 3)→ 新版本仍帶 surfaceUrl。
CADCHAT_SMOKE_LLM=1 才跑;CADCHAT_BASE 指向實例。"""
import json
import os
import sys

from _util import Checker, REPO, get_with_headers, post, sse_events

sys.path.insert(0, os.path.join(REPO, "apps", "cad-chat", "tests", "smoke"))

PROMPT = (
    "做一個左右對稱的滑鼠上蓋:長 110 mm、寬 72 mm、最高 27 mm,三條截面線放樣,"
    "殼厚 2 mm 向內加厚,要實體。不要澄清、用合理假設直接做完到呈現。"
)
INTERNAL = ["build123d", "python", "cadpy", "surface_present_draft", "surface_build", ".py", ".json", "產生器", "traceback"]

c = Checker()
raw = post("/api/chat", {"message": PROMPT, "mode": "product"}, timeout=900)
evs = sse_events(raw)
kinds = sorted({e for e, _ in evs})
print(f"  [info] SSE events: {len(evs)}  kinds={kinds}")
sess = next((d for e, d in evs if e == "session"), {})
sid = sess.get("sessionId")
c.check("session 是 product 模式", sess.get("mode") == "product", str(sess))

tools = [d.get("name", "") for e, d in evs if e == "tool" and d.get("name")]
c.check("agent 走 surface.draft(surface_draft 事件)", "surface_draft" in kinds and any(t.startswith("surface.draft") for t in tools), str(tools))
c.check("零 cad_* 工具卡(工具面隔離)", not any(t.startswith("cad.") for t in tools), str(tools))
drafts = [d for e, d in evs if e == "surface_draft"]
dr = (drafts[-1].get("draft") if drafts else None) or {}
c.check("草稿含對稱設定與放樣曲面", dr.get("symmetry") in ("YZ", "XZ") and any(s.get("op") == "loft" for s in dr.get("surfaces", [])), json.dumps({"symmetry": dr.get("symmetry"), "ops": [s.get("op") for s in dr.get("surfaces", [])]}, ensure_ascii=False))

vers = [d for e, d in evs if e == "version"]
c.check("同回合成形:恰一個 version", len(vers) == 1, str([v.get("id") for v in vers]))
if vers:
    url = vers[-1].get("surfaceUrl")
    c.check("version 帶 surfaceUrl", bool(url), str(vers[-1])[:200])
    if url:
        st, _h, body = get_with_headers(url)
        side = json.loads(body.decode("utf-8")) if st == 200 else {}
        summ = side.get("summary") or {}
        c.check("sidecar summary.ok 且有 G2 接縫", st == 200 and summ.get("ok") is True and summ.get("g2", 0) >= 1, str(summ))
        c.check("sidecar 有控制點籠與曲率梳", len(side.get("cages", [])) >= 1 and len(side.get("combs", [])) >= 1)
pdefs = next((d.get("defs") for e, d in evs if e == "params"), None) or []
c.check("滑桿含 thick", any(d.get("key") == "thick" for d in pdefs), str([d.get("key") for d in pdefs]))

vrows = {r.get("label"): r for d in [x for e, x in evs if e == "validate"] for r in d.get("checks", [])}
c.check("驗證卡有「邊連續性 continuity」列", "邊連續性 continuity" in vrows, str(list(vrows)))

ai_texts = [d.get("text", "") for e, d in evs if e == "ai"]
tail = (ai_texts[-1] if ai_texts else "").lower()
leaks = [w for w in INTERNAL if w in tail]
c.check("收尾回覆不洩內部詞", not leaks, str(leaks))
c.check("收尾回覆 ≤ 8 行", 0 < len([ln for ln in tail.splitlines() if ln.strip()]) <= 8, str(len(tail.splitlines())))

# (f) 第二回合:迭代
evs2 = sse_events(post("/api/chat", {"sessionId": sid, "message": "殼厚改成 3 mm,其他不變,直接重做到呈現。"}, timeout=900))
vers2 = [d for e, d in evs2 if e == "version"]
c.check("迭代回合出新版本且帶 surfaceUrl", bool(vers2) and bool(vers2[-1].get("surfaceUrl")), str([(v.get("id"), bool(v.get("surfaceUrl"))) for v in vers2]))
tools2 = [d.get("name", "") for e, d in evs2 if e == "tool" and d.get("name")]
c.check("迭代仍零 cad_* 工具", not any(t.startswith("cad.") for t in tools2), str(tools2))
py = os.path.join(REPO, "models", ".cadchat", sid or "_", f"{(vers2 or vers)[-1].get('name', '_')}.py") if (vers2 or vers) else ""
src = open(py, encoding="utf-8").read() if py and os.path.exists(py) else ""
c.check("產生器是編譯產物(嵌 SURFACE_SPEC、無手寫 build123d)", "SURFACE_SPEC = {" in src and "SurfaceBuilder(SURFACE_SPEC" in src and "import sweep" not in src, py)
c.finish()
