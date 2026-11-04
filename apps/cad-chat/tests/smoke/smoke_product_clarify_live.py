# -*- coding: utf-8 -*-
"""LLM-gated:產品設計模式的拓撲級澄清——未說殼或實體、未說對稱、未給尺寸級別 → 必 emit_clarify
且零 version(不先建模);推薦選項帶「(建議)」。對照組 smoke_product_live(明說實體/對稱/尺寸 → 不問)。
CADCHAT_SMOKE_LLM=1 才跑。"""
from _util import Checker, post, sse_events

PROMPT = "幫我做一個流線型的電競滑鼠外殼。"

c = Checker()
evs = sse_events(post("/api/chat", {"message": PROMPT, "mode": "product"}, timeout=600))
kinds = sorted({e for e, _ in evs})
print(f"  [info] kinds={kinds}")
sess = next((d for e, d in evs if e == "session"), {})
c.check("session 是 product 模式", sess.get("mode") == "product", str(sess))
clar = [d for e, d in evs if e == "clarify"]
c.check("未指明殼/實體/對稱/尺寸 → emit_clarify", bool(clar), str(kinds))
c.check("零 version(不先建模)", "version" not in kinds)
c.check("零 surface_draft(不先出草稿)", "surface_draft" not in kinds)
if clar:
    opts = clar[-1].get("opts") or []
    c.check("options ≥2 且有推薦標記「(建議)」", len(opts) >= 2 and any("建議" in (o.get("label") or "") for o in opts), str([o.get("label") for o in opts]))
    q = (clar[-1].get("q") or "")
    c.check("問題觸及殼/實體或對稱或尺寸級別", any(k in q + " ".join(o.get("value", "") for o in opts) for k in ("實體", "殼", "對稱", "尺寸", "mm")), q)
c.finish()
