# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗「齒輪原子概念」被 agent 端到端採用——
prompt.mjs 的 gear family 指引(cadpy.parts.gear/gear_rack + rack_mesh_phase_deg)
+ MOTION couple 契約(從動 dof 借主動相位、掃掠真滾動)。
一輪 ref sim(轉向機構 BOX)同款需求:m0.7 z14 齒輪齒條迴轉機構,斷:
① motion 事件同時有 linear + revolute dof 且其一帶 couple;
② 精算端點掃掠真跑(非 skip)且 note 標「耦合群」(嚙合被真滾動驗證;
   收斂單一快路徑後回合內一律 skip,掃掠移到 /api/validate);
③ turn 走到呈現。CADCHAT_SMOKE_LLM=1 才跑(見 run_all)。"""
import json

from _util import Checker, post, sse_events

PROMPT = (
    "做一個齒輪齒條式迴轉致動器的最簡內部機構:模數 0.7、14 齒的 pinion 正齒輪"
    "(節圓 Ø9.8)配一根齒條;齒條沿 Y 直線滑移驅動 pinion 繞 Z 軸輸出 0~90°"
    "(齒條行程 = 節圓半徑 × π/2 ≈ 7.70 mm)。只要齒條 + pinion 兩件"
    "(可加一塊簡單底板,不要外殼),越簡單越好,不要澄清、直接做完到呈現。"
    "MOTION 要宣告齒條 linear 與 pinion revolute 兩個 dof 並以 couple 耦合。"
)

c = Checker()
raw = post("/api/chat", {"message": PROMPT}, timeout=600)
evs = sse_events(raw)
kinds = [e for e, _ in evs]
print(f"  [info] SSE events: {len(evs)}  kinds={sorted(set(kinds))}")

motions = [d for e, d in evs if e == "motion" and d.get("dofs")]
dofs = motions[-1]["dofs"] if motions else []
lin = [d for d in dofs if d.get("type") == "linear"]
rev = [d for d in dofs if d.get("type") == "revolute"]
c.check("agent 產出 linear + revolute 雙 dof", bool(lin) and bool(rev), str(dofs)[:200])
ids = {d.get("id") for d in dofs}
coupled = [d for d in dofs if d.get("couple") in ids]
c.check("其一 dof 帶 couple(指向存在的主動 dof)", len(coupled) == 1,
        str([(d.get('id'), d.get('couple')) for d in dofs]))

c.check("turn 走到呈現(present/version)", any(k in ("present", "version") for k in kinds),
        f"kinds={sorted(set(kinds))}")

# 回合內一律快路徑;掃掠(couple 真滾動)改由精算端點承擔
sid = next((d.get("sessionId") for e, d in evs if e == "session"), None)
c.check("SSE 有 session 事件(取 sessionId 精算)", bool(sid))
if sid:
    vr = json.loads(post("/api/validate", {"sessionId": sid}, timeout=300))
    c.check("精算 ok", vr.get("ok") is True, str(vr)[:200])
    sweeps = [ch for ch in vr.get("checks", [])
              if "運動掃掠" in (ch.get("label") or "") and not ch.get("skipped")]
    c.check("精算:運動掃掠真跑(非 skip)", bool(sweeps), str(vr.get("checks"))[:200])
    c.check("掃掠 note 標「耦合群」(嚙合被真滾動驗證)",
            any("耦合群" in (ch.get("note") or "") for ch in sweeps),
            str([ch.get("note") for ch in sweeps])[:200])
    c.check("精算全綠(嚙合零穿透)", vr.get("validateOk") is True, str(vr)[:200])

c.finish()
