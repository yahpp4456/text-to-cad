# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗 prompt.mjs 的「看圖才發現 → 記教訓」紀律可被 agent 採用,
且 emit_lesson_offer 工具在白名單內(runner.mjs)、emit→SSE 鏈路通。單回合:描述一個
「驗證全綠卻看圖才發現」的假綠缺陷情境並明請記成教訓,斷 agent 發出 lesson_offer 事件。
CADCHAT_SMOKE_LLM=1 才跑(見 run_all)。deterministic 鏈路(卡→POST→store)已由
smoke_lesson_offer.py 免 LLM 覆蓋,此處只補「模型判斷」這一環。"""
from _util import Checker, post, sse_events

PROMPT = (
    "剛才你幫我產的那個 L 型托架,左右兩片三角肋做成一內一外(右肋內縮、鑽進中央圓孔),"
    "左右不對稱是錯的——但當時幾何驗證是全綠的,我是看渲染才發現。這種『驗證沒攔到、"
    "看圖才發現』的假綠問題,請你用 emit_lesson_offer 把它整理成一條教訓讓我確認是否加入:"
    "症狀=左右肋不對稱右肋內縮、根因=手繞 Polygon 的 extrude 方向由頂點繞向決定配單邊 Pos "
    "位移靜默破壞對稱、修法=對稱特徵用 extrude(..., both=True) 對稱擠出後再定位、"
    "tag=mirror-symmetry。不用重新建模,直接發卡就好。"
)

c = Checker()
raw = post("/api/chat", {"message": PROMPT}, timeout=600)
evs = sse_events(raw)
kinds = [e for e, _ in evs]
print(f"  [info] SSE events: {len(evs)}  kinds={sorted(set(kinds))}")

offers = [d for e, d in evs if e == "lesson_offer"]
c.check("agent 依紀律發出 lesson_offer 卡", len(offers) > 0, f"kinds={sorted(set(kinds))}")
if offers:
    o = offers[-1]
    c.check("卡帶 symptom(非空)", bool(str(o.get("symptom", "")).strip()), str(o)[:200])
    c.check("卡帶 fix(非空)", bool(str(o.get("fix", "")).strip()), str(o)[:200])
    c.check("卡帶 tag", bool(str(o.get("tag", "")).strip()), str(o)[:200])

c.check("turn 正常收尾(done)", "done" in kinds, f"kinds={sorted(set(kinds))}")
c.finish()
