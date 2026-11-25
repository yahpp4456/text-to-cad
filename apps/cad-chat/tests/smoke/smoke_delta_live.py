# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):建置差異摘要(藍圖 B3)在真回合裡說的是實話。

同一對話兩輪:先做一塊平板,再請它在中心加一個通孔、其他不變。斷第二版的差異摘要說
「改了那塊板、體積變小」,而且**沒有**說它移動了或包絡變了——只改一個孔,外形不該動。
也斷第一版只列現況(沒有上一版可比)。CADCHAT_SMOKE_LLM=1 才由 run_all 執行。

差異摘要是伺服器依兩次建置的量測算出來的,不是模型寫的;這支驗的是整條鏈在真回合裡接得上
(build 收割 → 版本快照 → version 事件),以及模型做「小改動」時幾何真的只動了該動的地方。
"""
import re

from _util import Checker, chat_until_version

FIRST = "做一塊平板:長 80mm、寬 50mm、厚 6mm,單一零件。尺寸都給了,不要澄清,直接做完到呈現。"
SECOND = "在板子正中心加一個直徑 10mm 的通孔,其他都不變。不要澄清,直接做完到呈現。"

c = Checker()
run1 = chat_until_version(FIRST, timeout=900)
c.check("第一輪走到呈現(version)", bool(run1.sid) and bool(run1.versions), f"kinds={run1.kinds}")
if not run1.versions:
    c.finish()
d1 = run1.versions[-1].get("delta") or ""
print(f"  [info] v1 delta: {d1!r}")
c.check("第一版只列現況:1 件、包絡 80×50×6", bool(re.match(r"^1 件,包絡 ", d1)) and all(n in d1 for n in ("80", "50", "6")), d1)

run2 = chat_until_version(SECOND, session_id=run1.sid, timeout=900)
c.check("第二輪走到呈現(version)", bool(run2.versions), f"kinds={run2.kinds}")
if not run2.versions:
    c.finish()
d2 = run2.versions[-1].get("delta") or ""
print(f"  [info] v2 delta: {d2!r}")
c.check("第二版的摘要是與上一版的比較", d2.startswith("與上一版比:"), d2)
m = re.search(r"改了 [^;]*?\(體積 ([\d,]+)→([\d,]+) mm³\)", d2)
c.check("說那塊板改了,附前後體積", bool(m), d2)
if m:
    before, after = (int(x.replace(",", "")) for x in m.groups())
    # 80×50×6 = 24000;挖掉 π·5²·6 ≈ 471
    c.check("體積變小,幅度就是那個孔(約 471 mm³)", 400 <= before - after <= 550, f"{before} → {after}")
c.check("沒有說零件移動了(只加一個孔,位置不該動)", "移動" not in d2, d2)
c.check("沒有說包絡變了(通孔不改外形)", "包絡" not in d2, d2)
c.check("沒有多出或少掉零件", "新增" not in d2 and "移除" not in d2 and "零件 " not in d2, d2)

c.finish()
