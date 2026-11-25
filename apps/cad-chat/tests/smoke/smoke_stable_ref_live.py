# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):使用者點了一個面、agent 改了模型之後,再量「同一個面」用的是穩定參照(藍圖 C1)。

兩輪,同一個對話:
1. 建一個兩件的組合件:底板(帶凸柱與四個孔)+ 墊塊。
2. 帶入「凸柱頂面」這個點選參照(pickRefs,與畫面上點面送出的 payload 同形),要求把孔從四個改成六個、
   再量這個面到底板底面的高度。孔數一變,面的序號會位移——用原本的位置 token 會量到別的面。

斷:
(a) 第一輪的 sidecar 有這個面的穩定名稱(點選括註的資料來源);
(b) 第二輪真的重建了(有新版本),而且那個穩定名稱在新版仍然存在、仍然是凸柱頂面(z = 25、朝上);
(c) **agent 在重建之後的量測用了穩定參照 `@base#~名稱`**,那次量測成功;
(d) 回覆裡的高度是 25。
另外記錄(不算失敗):序號有沒有真的位移——位移了才代表這一題考到東西。
CADCHAT_SMOKE_LLM=1 才由 run_all 執行。
"""
import json
import os
import re
import struct

from _util import Checker, REPO, chat_until_version, post, sse_events

BUILD = (
    "做一個兩件的組合件,不要運動:零件 base 是 100×60×10 mm 的底板,底面在 z=0,頂面中央有一個直徑 20、高 15 的"
    "圓凸柱(和底板是同一個零件),四個角落各一個直徑 5 的通孔,孔中心離邊 8;零件 pad 是 30×30×5 的墊塊,"
    "放在底板旁邊(不接觸,x 方向離底板邊 10)。零件名稱就用 base 與 pad。尺寸都給了,不要澄清,直接做完到呈現。"
)
EDIT = (
    "把 base 四個角落的孔改成六個:沿兩條長邊各三個(兩端的位置不變,中間各加一個)。其他都不要動。"
    "改完之後,量我點的這個面到 base 底面的高度差,把數字告訴我。"
)


def glb_tables(glb):
    data = open(glb, "rb").read()
    n = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + n])
    start = 20 + n + 8
    ext = gltf["extensions"]["STEP_topology"]

    def view(i):
        bv = gltf["bufferViews"][i]
        at = start + bv.get("byteOffset", 0)
        return json.loads(data[at:at + bv["byteLength"]])

    return view(ext["indexView"]), view(ext["selectorView"])


def boss_top(work, name, part="base"):
    """(occurrence id, 面序號 k, 該零件的面數) —— 凸柱頂面:朝 +Z、中心 z≈25 的平面。找不到回 None。"""
    index, sel = glb_tables(os.path.join(work, f".{name}.step.glb"))
    oc = index["tables"]["occurrenceColumns"]
    row = next((r for r in index["occurrences"] if r[oc.index("name")] == part), None)
    if row is None:
        return None
    start, count = row[oc.index("faceStart")], row[oc.index("faceCount")]
    fc = sel["tables"]["faceColumns"]
    for k in range(count):
        face = sel["faces"][start + k]
        centre, normal = face[fc.index("center")], face[fc.index("normal")]
        if face[fc.index("surfaceType")] == "plane" and normal and normal[2] > 0.99 and abs(centre[2] - 25.0) < 0.01:
            return row[oc.index("id")], k + 1, count
    return None


def meta_of(work, name):
    path = os.path.join(work, f".{name}.step.meta.json")
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}


c = Checker()
first = chat_until_version(BUILD, timeout=900)
c.check("第一輪走到呈現", bool(first.sid) and bool(first.versions), f"kinds={first.kinds}")
if not first.versions:
    c.finish()
sid, name = first.sid, first.versions[-1].get("name")
work = os.path.join(REPO, "models", ".cadchat", sid)

found = boss_top(work, name)
c.check("模型裡找得到凸柱頂面(base 零件、z=25、朝上)", found is not None, f"parts={meta_of(work, name).get('parts')}")
if found is None:
    c.finish()
occ, k, _count = found
names = (meta_of(work, name).get("names") or {}).get("parts", {}).get("base", {})
stable = (names.get("f") or [""] * k)[k - 1] if len(names.get("f") or []) >= k else ""
c.check("第一輪的 sidecar 有這個面的穩定名稱", bool(re.fullmatch(r"[0-9a-f]{10}", stable or "")), f"f{k} → {stable!r}")
if not stable:
    c.finish()

token = f"#{occ}.f{k}"
events = sse_events(post("/api/chat", {
    "sessionId": sid, "message": EDIT,
    "pickRefs": [{"token": token, "label": "凸柱頂面", "part": "base"}],
}, timeout=900))
versions = [d for e, d in events if e == "version"]
c.check("第二輪重建並呈現了新版本", bool(versions), f"kinds={sorted({e for e, _ in events})}")

after = boss_top(work, name)
names_after = (meta_of(work, name).get("names") or {}).get("parts", {}).get("base", {}).get("f") or []
still = stable in names_after
c.check("同一個穩定名稱在新版仍然存在", still, f"faces {len(names.get('f') or [])} → {len(names_after)}")
if still and after:
    c.check("而且它仍然是凸柱頂面", names_after.index(stable) + 1 == after[1],
            f"名稱指向 f{names_after.index(stable) + 1},凸柱頂面是 f{after[1]}")
    moved = after[1] != k
    print(f"  · 序號{'位移了' if moved else '沒有位移'}:f{k} → f{after[1]}"
          + ("" if moved else "(這次的改法沒有動到這個面的序號,穩定參照與位置 token 剛好指向同一個面)"))

# agent 的量測:重建之後、用穩定參照、成功
tools, order = {}, []
for e, d in events:
    if e != "tool":
        continue
    tid = d.get("id")
    if tid not in tools:
        tools[tid] = {"name": "", "status": ""}
        order.append(tid)
    if d.get("name"):
        tools[tid]["name"] = d["name"]
    if d.get("status"):
        tools[tid]["status"] = d["status"]
    if d.get("note"):
        tools[tid]["note"] = d["note"]
seq = [tools[t] for t in order]
last_build = max((i for i, t in enumerate(seq) if t["name"].startswith("cad.build")), default=-1)
measures = [t for t in seq[last_build + 1:] if t["name"].startswith("cad.measure")]
with_stable = [t for t in measures if f"#~{stable}" in t["name"]]
c.check("重建之後有量測", bool(measures), str([t["name"] for t in seq])[:300])
c.check("那次量測用的是穩定參照 @base#~…(不是重建前的位置 token)", bool(with_stable),
        str([t["name"] for t in measures])[:300])
c.check("用穩定參照的量測成功", any(t["status"] == "done" for t in with_stable),
        str([(t["name"], t["status"], t.get("note")) for t in with_stable])[:300])

reply = "\n".join(d.get("text", "") for e, d in events if e == "ai")
c.check("回覆的高度是 25", bool(re.search(r"(?<![\d.])25(?:\.0+)?(?![\d])", reply)), reply[-260:].replace("\n", " "))

c.finish()
