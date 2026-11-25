# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):不折彎的平板件也能出切割圖,而且圓角與長孔是真正的圓弧(藍圖 F2)。

一輪:一塊帶圓角、兩個圓孔、一個長孔的鋁板,要求能匯出雷射切割用的 DXF。斷:
(a) 產生器用 cadpy.flatten.plate_dxf(不手刻 ezdxf、不用鈑金產生器硬湊);
(b) version 事件 hasDxf=true(時間軸的 DXF 鈕會亮);
(c) /api/export dxf 成功,讀回 DXF:2 個 CIRCLE、外框與長孔各一條封閉 LWPOLYLINE,
    而且圓角與長孔端是 bulge(圓弧),不是一串短線。
CADCHAT_SMOKE_LLM=1 才由 run_all 執行。
"""
import json
import os

from _util import Checker, REPO, chat_until_version, post

PROMPT = (
    "做一塊鋁板:長 80mm、寬 50mm、厚 5mm,四個角倒 R6 圓角;兩個直徑 6.6mm 的通孔,中心距 56mm,沿長邊對稱;"
    "板子中間偏上一個長 24mm、寬 6mm 的長圓孔。單一零件。這塊板要送雷射切割,要能匯出切割用的 DXF。"
    "尺寸都給了,不要澄清,直接做完到呈現。"
)

c = Checker()
run = chat_until_version(PROMPT, timeout=900)
vers = run.versions
c.check("turn 走到呈現(version)", bool(run.sid) and bool(vers), f"kinds={run.kinds}")
if not vers:
    c.finish()

name = vers[-1].get("name")
py = os.path.join(REPO, "models", ".cadchat", run.sid, f"{name}.py")
src = open(py, encoding="utf-8").read() if os.path.exists(py) else ""
c.check("產生器有 gen_dxf,用 plate_dxf(不手刻 ezdxf)", "def gen_dxf" in src and "plate_dxf" in src and "import ezdxf" not in src, py)
c.check("沒有拿鈑金產生器硬湊(不折彎的板不是鈑金件)", "SheetMetal" not in src)
c.check("version 事件 hasDxf=true(DXF 鈕依據)", vers[-1].get("hasDxf") is True, str(vers[-1])[:160])

de = json.loads(post("/api/export", {"sessionId": run.sid, "ver": vers[-1].get("id"), "format": "dxf"}, timeout=300))
c.check("export dxf ok(經匯出閘)", de.get("ok") is True, str(de)[:250])
if de.get("ok"):
    import ezdxf

    msp = ezdxf.readfile(os.path.join(REPO, de["file"].replace("/", os.sep))).modelspace()
    circles = list(msp.query("CIRCLE"))
    polys = list(msp.query("LWPOLYLINE"))
    c.check("兩個圓孔是 CIRCLE,直徑 6.6", len(circles) == 2 and all(abs(e.dxf.radius - 3.3) < 1e-3 for e in circles),
            str([round(e.dxf.radius, 3) for e in circles]))
    c.check("外框與長孔各一條封閉多段線", len(polys) == 2 and all(p.closed for p in polys), f"n={len(polys)}")
    arcs = sorted(sum(1 for _, _, b in p.get_points("xyb") if abs(b) > 1e-9) for p in polys)
    verts = sorted(len(p.get_points("xyb")) for p in polys)
    c.check("圓角與長孔端是圓弧(bulge):長孔 2 段、外框 4 段", arcs == [2, 4], f"arcs={arcs} verts={verts}")
    c.check("沒有被打成一串短線(外框 8 個頂點、長孔 4 個)", verts == [4, 8], f"verts={verts}")
    if polys:
        outer = max(polys, key=lambda p: len(p.get_points("xyb")))
        xs = [x for x, _, _ in outer.get_points("xyb")]
        ys = [y for _, y, _ in outer.get_points("xyb")]
        size = sorted([round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)])
        c.check("外框尺寸 80×50", size == [50.0, 80.0], str(size))

c.finish()
