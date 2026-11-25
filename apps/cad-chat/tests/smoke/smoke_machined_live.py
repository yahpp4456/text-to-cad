# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):使用者說零件是銑削件時,agent 會宣告 MACHINED,切削建議真的出現(藍圖 F3)。

一輪:一個 CNC 銑削的鋁底座,帶一個**直角(尖角)**的封閉口袋。斷:
(a) 產生器在模組層宣告 MACHINED,而且列的是這個零件;
(b) build 的 sidecar 有 cnc.sharp_internal_corner(四個直立內角銑刀做不出來)——或者 agent 看到建議後
    已經把角改成圓角(那樣就沒有這一項;兩種都是對的行為,分開報);
(c) 沒有為了這個建議把回合耗在重試上(建議不擋);
(d) 收尾有把這件事告訴使用者(提到尖角/圓角/刀具其中之一)。
CADCHAT_SMOKE_LLM=1 才由 run_all 執行。
"""
import json
import os
import re

from _util import Checker, REPO, chat_until_version

PROMPT = (
    "做一個 CNC 銑削加工的鋁底座,單一零件:外形 80×60×30 mm;上面中央往下挖一個封閉口袋,"
    "長 40、寬 30、深 20,口袋四個角是直角(不要倒圓角);四個角落各一個直徑 6.6 的通孔,孔中心離邊 8。"
    "這是銑削件。尺寸都給了,不要澄清,直接做完到呈現。"
)

c = Checker()
run = chat_until_version(PROMPT, timeout=900)
vers = run.versions
c.check("turn 走到呈現(version)", bool(run.sid) and bool(vers), f"kinds={run.kinds}")
if not vers:
    c.finish()

name = vers[-1].get("name")
work = os.path.join(REPO, "models", ".cadchat", run.sid)
py = os.path.join(work, f"{name}.py")
src = open(py, encoding="utf-8").read() if os.path.exists(py) else ""
declared = re.search(r"^MACHINED\s*=\s*(.+)$", src, re.M)
c.check("產生器在模組層宣告 MACHINED", bool(declared), (declared.group(0) if declared else "(沒有)")[:120])

meta_path = os.path.join(work, f".{name}.step.meta.json")
meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
rules = [a.get("rule") for a in meta.get("advisories") or []]
has_round = bool(re.search(r"fillet\(", src))
if "cnc.sharp_internal_corner" in rules:
    c.check("sidecar 有內側尖角的切削建議(口袋照使用者說的保留直角)", True, str(rules))
    rows = [ch for e, d in run.events if e == "validate" for ch in d.get("checks", [])]
    advisory = [r for r in rows if r.get("status") == "advisory"]
    c.check("驗證卡有「切削可製造性(建議)」這一列", any("切削" in (r.get("label") or "") for r in advisory),
            str([r.get("label") for r in advisory])[:160])
else:
    c.check("沒有尖角建議 = agent 已把口袋角改成圓角(違反使用者指定的直角,但建議確實被處理)", has_round,
            f"rules={rules} fillet={has_round}")

builds = [d for e, d in run.events if e == "tool" and str(d.get("name", "")).startswith("cad.build") and d.get("status") == "running"]
c.check("沒有為了建議反覆重建(build 不超過 4 次)", len(builds) <= 4, f"builds={len(builds)}")

closing = run.ai_text(last_only=True)
c.check("收尾有把加工上的事告訴使用者(尖角/圓角/刀)", bool(re.search(r"尖角|圓角|刀具|銑刀|線切割|放電", closing)),
        closing[-240:].replace("\n", " "))

c.finish()
