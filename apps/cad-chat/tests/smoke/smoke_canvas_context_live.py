# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗 buildUserText 的「當前畫布」語境注入——
使用者在唯讀檢視某模型時聊天,agent 應知道畫布上開著什麼(而非像修復前回
「我這邊沒有收到任何圖檔」)。這是「自動帶入編輯」兜不到的安全網路徑(裸檔、
或 session-A-檢視-B 的邊角);此測試直接送 canvas 語境驗 server 端注入生效。
CADCHAT_SMOKE_LLM=1 才跑(見 run_all)。"""
from _util import Checker, post, sse_events

c = Checker()

# 唯讀檢視 sheet_u_bracket(source=opened、屬可編輯專案)+ 問「開著什麼」——
# 明令不建模不用工具,壓成本;只驗 agent 是否認得畫布模型。
body = {
    "sessionId": None,
    "message": "我目前畫布上開著的是什麼零件?用一兩句簡短回答就好,不要建模、不要呼叫任何工具。",
    "canvas": {
        "name": "sheet_u_bracket",
        "file": "sheet_u_bracket/sheet_u_bracket.step",
        "source": "opened",
        "type": "part",
        "projectDir": "sheet_u_bracket",
    },
}
evs = sse_events(post("/api/chat", body, timeout=600))
reply = "".join(
    d.get("text", "") for e, d in evs if e in ("ai", "ai_delta") and isinstance(d, dict)
).strip()
print(f"  [info] reply: {reply[:200]}")

c.check("agent 有回覆(非空)", len(reply) > 0, reply[:120])
# 修復前的症狀字串:agent 不知道畫布有東西 → 說「沒收到/沒有圖」
neg = any(s in reply for s in ("沒有收到", "沒收到", "沒有附上", "沒有任何圖", "無法看到"))
c.check("agent 不再回「沒收到圖檔」(語境注入生效)", not neg, reply[:150])
# 認得模型:提到名稱/鈑金/支架 任一
pos = any(s in reply.lower() for s in ("sheet_u_bracket", "u_bracket", "鈑金", "支架", "bracket", "折彎", "u 型", "u型"))
c.check("agent 認得畫布模型(提到名稱/鈑金/支架)", pos, reply[:150])

c.finish()
