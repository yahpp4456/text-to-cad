# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗 prompt.mjs 的鈑金契約可被 agent 正確採用。
一輪 U 型鈑金支架,斷:(a) 產生器用 cadpy SheetMetal + 三出口 gen_step/gen_flat/
gen_dxf(禁手疊方塊/手繪 ezdxf;folded 不進 PARAMS);(b) version 事件 hasDxf=true
+ flatGlbUrl(摺疊/攤平切換);(c) 無 folded 滑桿;(d) /api/export dxf 成功且 ezdxf
讀回 BEND 層線數;(e) 尺寸重生新版仍帶 flatGlbUrl。CADCHAT_SMOKE_LLM=1 才跑。"""
import json
import os

from _util import Checker, REPO, post, sse_events

PROMPT = (
    "做一個鈑金 U 型支架:板厚 2mm、內折彎半徑 3mm,底板 60×40mm,"
    "兩側 90 度立邊外高 30mm,底板兩個 M5 安裝孔。附展開圖。"
    "不要澄清、用合理假設直接做完到呈現。"
)

c = Checker()
raw = post("/api/chat", {"message": PROMPT}, timeout=600)
evs = sse_events(raw)
kinds = [e for e, _ in evs]
print(f"  [info] SSE events: {len(evs)}  kinds={sorted(set(kinds))}")

sid = next((d.get("sessionId") for e, d in evs if e == "session"), None)
vers = [d for e, d in evs if e == "version"]
c.check("turn 走到呈現(version)", bool(sid) and bool(vers), f"sid={sid}")
name = vers[-1].get("name") if vers else None

# (a) 產生器契約:SheetMetal + gen_dxf,禁手疊/手繪
py = os.path.join(REPO, "models", ".cadchat", sid or "_", f"{name or '_'}.py")
src = open(py, encoding="utf-8").read() if os.path.exists(py) else ""
c.check("產生器 import cadpy SheetMetal(不手疊方塊)", "SheetMetal" in src, py)
c.check("產生器有三出口 gen_step/gen_flat/gen_dxf",
        "def gen_step" in src and "def gen_flat" in src and "def gen_dxf" in src, py)
c.check("gen_dxf 用 .dxf()(不自行 ezdxf 手繪)", "import ezdxf" not in src)
c.check("folded 不進 PARAMS(攤平改視圖切換)",
        '"folded"' not in (src.split("PARAMS")[1][:400] if "PARAMS" in src else ""), py)

# (b) hasDxf + flatGlbUrl 旗標
c.check("version 事件 hasDxf=true(DXF 鈕依據)", vers[-1].get("hasDxf") is True, str(vers[-1])[:160])
c.check("version 事件帶 flatGlbUrl(摺疊/攤平切換)", bool(vers[-1].get("flatGlbUrl")), str(vers[-1])[:200])

# (c) 無 folded 滑桿
pdefs = next((d.get("defs") for e, d in evs if e == "params"), None) or []
c.check("無 folded 滑桿", next((d for d in pdefs if d.get("key") == "folded"), None) is None,
        str([d.get("key") for d in pdefs]))

# (d) DXF 匯出 + 讀回層契約(2 道 90° 折彎 → BEND 層 2 條線)
ver_id = vers[-1].get("id")
de = json.loads(post("/api/export", {"sessionId": sid, "ver": ver_id, "format": "dxf"}, timeout=300))
c.check("export dxf ok(經匯出閘)", de.get("ok") is True, str(de)[:250])
if de.get("ok"):
    import ezdxf

    msp = ezdxf.readfile(os.path.join(REPO, de["file"].replace("/", os.sep))).modelspace()
    bend = [e for e in msp.query("LINE") if "bend" in e.dxf.layer.lower()]
    c.check("DXF BEND 層 2 條折彎線(U 型雙折)", len(bend) == 2,
            f"n={len(bend)} layers={sorted({e.dxf.layer for e in msp})}")

# (e) 尺寸重生 → 新版仍帶 flatGlbUrl(攤平 GLB 隨尺寸重建;送全部參數值)
vals = {d["key"]: d["value"] for d in pdefs}
if vals:
    k = next((kk for kk in vals if "leg" in kk or "h" in kk), next(iter(vals)))
    vals[k] = vals[k] + 3.0
    evs2 = sse_events(post("/api/chat", {"sessionId": sid, "params": vals}, timeout=300))
    vers2 = [d for e, d in evs2 if e == "version"]
    c.check("尺寸重生出新版", bool(vers2), str(vers2)[:160])
    if vers2:
        c.check("重生版仍帶 flatGlbUrl(攤平隨尺寸重建)", bool(vers2[-1].get("flatGlbUrl")))
else:
    c.check("尺寸重生(無滑桿值可送,跳過)", False, str(pdefs)[:200])

c.finish()
