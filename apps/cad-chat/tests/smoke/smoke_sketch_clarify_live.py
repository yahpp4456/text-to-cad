# -*- coding: utf-8 -*-
"""草模「驅動/傳動先問」L4 煙測(消耗真 LLM 回合;CADCHAT_SMOKE_LLM=1 才跑)。

需求刻意不指明驅動方式與傳動呈現 → 斷言模型判斷本身(prompt 2026-07-14 必問規則):
① 本回合出 clarify 事件,options ≥ 2(整機配置組合);
② clarify 文字含驅動關鍵詞(汽缸/馬達)且含傳動關鍵詞(皮帶/齒輪/直接耦合…);
③ 零 sketch.present 工具事件(提問後停,不先搭);
④ 零 cad_* 工具;⑤ 回合 ok。
這是本功能唯一「模型判斷」驗證點;UI 作答面(精靈/chips)由免 LLM 的
smoke_clarify_wizard / smoke_spec_panel 覆蓋。
"""
from _util import Checker, post, sse_events

c = Checker()

# 措辭只講「做什麼」,不講「用什麼驅動/怎麼傳動」——留給模型該問的空間。
# 「尺寸細節你自行假設」貼齊 prompt 的尺寸 assumed 紀律;別寫「你決定」——
# 太寬,可能被模型讀成「一切免問」而合理跳過 clarify(對抗審查指出的 flake 來源)。
raw = post(
    "/api/chat",
    {
        "mode": "sketch",
        "message": "做一個能左右平移約 100mm 的小載台草模,尺寸細節你自行假設。",
    },
    timeout=600,
)
events = sse_events(raw)

clarifies = [d for e, d in events if e == "clarify"]
c.check("本回合出 clarify(未指明驅動/傳動 → 必問)", len(clarifies) >= 1, str(len(clarifies)))

cl = clarifies[-1] if clarifies else {}
opts = cl.get("opts") or []
c.check("options ≥ 2(整機配置組合)", len(opts) >= 2, str(cl)[:200])

blob = " ".join(
    [cl.get("q", ""), cl.get("suggested", "")]
    + [f"{o.get('label', '')} {o.get('value', '')}" for o in opts]
)
c.check(
    "clarify 文字含驅動關鍵詞(汽缸/馬達)",
    any(k in blob for k in ("汽缸", "氣缸", "馬達", "電缸")),
    blob[:200],
)
# 注意:集合裡不可放裸「直接」——「我直接假設」這類無關句子就含它(實跑踩過的假綠)。
c.check(
    "clarify 文字含傳動關鍵詞(皮帶/齒輪/直接耦合…)",
    any(k in blob for k in ("皮帶", "同步帶", "齒輪", "齒條", "直驅", "直推", "直接耦合", "螺桿", "絲桿", "凸輪", "連桿")),
    blob[:200],
)

tool_names = [d.get("name", "") for e, d in events if e == "tool"]
c.check(
    "零 sketch.present 工具事件(提問後停在等回答)",
    not any(str(n).startswith("sketch.present") for n in tool_names),
    str(tool_names)[:200],
)
c.check(
    "零 cad_* 工具事件(草模工具面隔離)",
    not any(str(n).startswith("cad.") for n in tool_names),
    str(tool_names)[:200],
)

done = next((d for e, d in events if e == "done"), None)
c.check("回合 ok:true", bool(done and done.get("ok") is True), str(done))

c.finish()
