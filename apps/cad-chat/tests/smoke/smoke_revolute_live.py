# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗 prompt.mjs 的 revolute 契約可被 agent 正確採用。
一輪極簡鉸鏈(門板繞世界 Y 軸轉 0~90°),斷 agent 產出 revolute MOTION dof、
turn 走到呈現;掃掠驗證(收斂單一快路徑後回合內一律 skip)改打精算端點
/api/validate 斷真跑。CADCHAT_SMOKE_LLM=1 才跑(見 run_all)。"""
import json

from _util import Checker, post, sse_events

PROMPT = (
    "做一個最簡單的鉸鏈組合件:一片固定底座板 + 一片門板,門板繞世界 Y 軸旋轉 0~90 度開闔。"
    "用 MOTION 的 revolute dof 宣告這個翻轉關節(angle_deg 引用 PARAMS)。"
    "只要兩片板、越簡單越好,不要澄清、直接做完到呈現。"
)

c = Checker()
raw = post("/api/chat", {"message": PROMPT}, timeout=600)
evs = sse_events(raw)
kinds = [e for e, _ in evs]
print(f"  [info] SSE events: {len(evs)}  kinds={sorted(set(kinds))}")

motions = [d for e, d in evs if e == "motion" and d.get("dofs")]
rev = [dof for m in motions for dof in m.get("dofs", []) if dof.get("type") == "revolute"]
c.check("agent 依新契約產出 revolute MOTION dof", len(rev) > 0,
        f"last motion={motions[-1] if motions else None}")
if rev:
    d = rev[-1]
    c.check("revolute dof 帶 pivot(3數)+angle_deg",
            isinstance(d.get("pivot"), list) and len(d.get("pivot", [])) == 3 and "angle_deg" in d,
            str(d))

c.check("turn 走到呈現(present/version)", any(k in ("present", "version") for k in kinds),
        f"kinds={sorted(set(kinds))}")

# 回合內一律快路徑(checks 全 skipped);掃掠真跑改由精算端點承擔
sid = next((d.get("sessionId") for e, d in evs if e == "session"), None)
c.check("SSE 有 session 事件(取 sessionId 精算)", bool(sid))
if sid:
    vr = json.loads(post("/api/validate", {"sessionId": sid}, timeout=300))
    c.check("精算 ok", vr.get("ok") is True, str(vr)[:200])
    sweep = [ch for ch in vr.get("checks", []) if "運動掃掠" in (ch.get("label") or "")]
    c.check("精算:revolute 運動掃掠真跑(非 skip)",
            bool(sweep) and not sweep[0].get("skipped"), str(sweep)[:200])
    c.check("精算全綠(鉸鏈掃掠零穿透)", vr.get("validateOk") is True, str(vr)[:200])

c.finish()
