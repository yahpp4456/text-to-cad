# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):組合件在呈現前,agent 會自己看圖(藍圖 E1 / E2)。

一輪:一個帶蓋的盒子,裡面有一根軸穿過兩個軸承座。斷:
(a) 回合裡有一次「看圖」的工具呼叫而且成功,帶著圖(工具卡的 images);
(b) 圖檔真的在磁碟上、是 PNG、不是空白;
(c) 看圖發生在呈現(version)之前,而且沒有反覆看(同一版最多兩次的紀律);
(d) 收尾的文字不把內部工具名稱講出來。
CADCHAT_SMOKE_LLM=1 才由 run_all 執行。這個環境若無法離屏渲染,工具會回報失敗——那時 (a)(b) 會紅,
這是如實反映:沒有圖可看。
"""
import os
import urllib.parse

from _util import Checker, REPO, chat_until_version

PROMPT = (
    "做一個簡單的軸承座組合件:一塊 120×60×10 的底板;底板上左右各一個軸承座(方塊,中間有通孔),"
    "兩個軸承座的孔同軸;一根直徑 12 的軸穿過兩個軸承座,兩端各露出 15mm。四件(底板、兩個座、軸)。"
    "形狀從簡,不要澄清,直接做完到呈現。"
)

c = Checker()
run = chat_until_version(PROMPT, timeout=1200)
c.check("turn 走到呈現(version)", bool(run.sid) and bool(run.versions), f"kinds={run.kinds}")
if not run.versions:
    c.finish()

# 工具卡是 UPSERT:同一個 id 先 running 後 done,取每個 id 的最後狀態
tools, order = {}, []
for index, (event, data) in enumerate(run.events):
    if event == "tool" and data.get("id"):
        if data["id"] not in tools:
            order.append(data["id"])
            tools[data["id"]] = {"first": index}
        tools[data["id"]].update(data)
snaps = [tools[i] for i in order if (tools[i].get("label") == "看圖" or "cad.snapshot" in str(tools[i].get("name")))]
print(f"  [info] 看圖呼叫 {len(snaps)} 次: {[(s.get('name'), s.get('status'), s.get('note')) for s in snaps]}")

c.check("回合裡有看圖的工具呼叫", len(snaps) >= 1, str([tools[i].get("name") for i in order])[:300])
done = [s for s in snaps if s.get("status") == "done"]
c.check("看圖成功,工具卡帶著圖", bool(done) and all(s.get("images") for s in done), str(snaps)[:300])
c.check("沒有反覆看圖(一輪最多 3 次)", len(snaps) <= 3, f"n={len(snaps)}")

first_version = next((i for i, (event, _) in enumerate(run.events) if event == "version"), None)
c.check("第一次看圖發生在呈現之前", bool(snaps) and first_version is not None and snaps[0]["first"] < first_version,
        f"snapshot@{snaps[0]['first'] if snaps else None} version@{first_version}")

for image in (done[0].get("images") if done else [])[:4]:
    rel = urllib.parse.parse_qs(urllib.parse.urlparse(image["url"]).query).get("file", [""])[0]
    path = os.path.join(REPO, rel.replace("/", os.sep))
    ok = os.path.exists(path) and open(path, "rb").read(8) == b"\x89PNG\r\n\x1a\n" and os.path.getsize(path) > 3000
    c.check(f"圖檔在磁碟上、是 PNG、不是空白(視角 {image.get('view')})", ok,
            f"{rel} size={os.path.getsize(path) if os.path.exists(path) else None}")

final = run.ai_text(last_only=True)
c.check("收尾不把內部工具名稱講出來", "cad_snapshot" not in final and "snapshot" not in final.lower(), final[-200:])
c.check("做出四件", run.versions[-1].get("partCount") == 4, str(run.versions[-1].get("partCount")))

c.finish()
