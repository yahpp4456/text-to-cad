# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗 prompt.mjs 的「使用者給的數字,在 check_geometry 裡對做出來的
形狀驗」會被 agent 採用。

一輪圓法蘭(外徑/厚度/中心孔/孔心圓/孔數都給定),然後**讀產生的 .py**:check_geometry 裡要有
量幾何的 assert(包絡、體積、圓邊、數量…),不是把常數再抄一遍互比;而且 build 沒有因為這些
assert 假失敗。也斷收尾有交代這回沒跑的檢查。CADCHAT_SMOKE_LLM=1 才由 run_all 執行。

模型若先提澄清(Codex provider 常這樣),就在同一對話回答後續跑,最多三輪。
"""
import os
import re

from _util import Checker, REPO, post, sse_events

PROMPT = (
    "做一個圓法蘭:外徑 40mm、厚 8mm,中心通孔直徑 12mm,孔心圓直徑 30mm 上均布 6 個直徑 5.5mm 的通孔。"
    "尺寸都給了,不要澄清,直接做完到呈現。"
)
FOLLOW = "尺寸照我給的,其餘你決定。不要再提問,現在直接建模並呈現。"
# 量的是做出來的幾何:包絡、體積/面積、面/邊/頂點的數量、圓邊的半徑或圓心。
MEASURES = re.compile(r"bounding_box|\bsize\.|\.volume|\.area|faces\(|edges\(|vertices\(|\.radius|arc_center|len\(")

c = Checker()
sid, vers, evs, message, retries = None, [], [], PROMPT, 0
for _turn in range(3):
    body = {"message": message}
    if sid:
        body["sessionId"] = sid
    evs = sse_events(post("/api/chat", body, timeout=1200))
    sid = next((d.get("sessionId") for e, d in evs if e == "session"), sid)
    retries += sum(1 for e, _ in evs if e == "retry")
    vers = [d for e, d in evs if e == "version"]
    if vers:
        break
    message = FOLLOW

c.check("turn 走到呈現(version)", bool(sid) and bool(vers), f"sid={sid}")
if not vers:
    c.finish()

name = vers[-1].get("name")
py = os.path.join(REPO, "models", ".cadchat", sid, f"{name}.py")
src = open(py, encoding="utf-8").read() if os.path.exists(py) else ""
match = re.search(r"^def check_geometry\(.*?(?=^\S|\Z)", src, re.S | re.M)
body_src = match.group(0) if match else ""
# 一條 assert 可能用反斜線續行:先接回一行再數
joined = re.sub(r"\\\n\s*", " ", body_src)
asserts = [line.strip() for line in joined.splitlines() if line.strip().startswith("assert ")]
measuring = [a for a in asserts if MEASURES.search(a)]
print("  [info] check_geometry 的 assert:")
for a in asserts:
    print("    " + a[:150])

c.check("產生器有 check_geometry", bool(body_src), py)
c.check("check_geometry 仍呼叫 assert_valid_solid", "assert_valid_solid" in body_src)
c.check("至少 3 條 assert 是量幾何的(包絡/體積/數量/圓邊…)", len(measuring) >= 3, f"{len(measuring)} / {len(asserts)}")
c.check("量到的值與 PARAMS 比,不是把字面常數互比", any("PARAMS" in a or re.search(r"\bp\[", a) for a in measuring),
        str(measuring[:2])[:200])
c.check("assert 訊息寫出量到多少(f-string 帶量測值)", any(re.search(r'f"[^"]*\{', a) for a in measuring))
c.check("build 沒有被這些 assert 假擋下(自修重試 ≤ 1 次)", retries <= 1, f"retries={retries}")
c.check("PARAMS 含使用者給的五個數字",
        all(re.search(rf"\b{v}(\.0)?\b", src.split("def ")[0]) for v in ("40", "8", "12", "30", "6")),
        src.split("def ")[0][:200])

final = "".join(d.get("text", "") for e, d in evs if e == "ai")
c.check("收尾交代這回沒跑的檢查(精算/匯出時才跑)", bool(re.search(r"精算|匯出", final)) and bool(re.search(r"沒跑|未跑|未驗|尚未|才會", final)),
        final[-160:])

c.finish()
