# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):驗 prompt.mjs 的掃出/護套契約可被 agent 正確採用。
一輪無塵護套(3 袋 16mm、彎徑留白→型錄規則),斷:(a) 產生器用 cadpy
cleanroom_sleeve + 模組層 SWEEP_PATHS(path_polyline 共用路徑 spec,禁手刻
sweep);(b) version 事件帶 sweepPathsUrl 且 sidecar 可取;(c) pockets 滑桿
step==1、bend_r 預設落在型錄 7.5~10×(pocket_w/2) 帶;(d) STEP 實測總寬 ==
pockets×(pocket_w+1)+3;(e) 只送 pocket_w 子集重生 → 新版 overlay 跟版。
CADCHAT_SMOKE_LLM=1 才跑。"""
import json
import os

from _util import Checker, REPO, get_with_headers, post, sse_events

PROMPT = (
    "畫一條無塵護套(cleanroom cable sleeve,Elocab EHSL 型):3 個口袋、"
    "口袋寬 16mm、壁厚 1mm,兩直段各 250mm,彎曲半徑你按型錄規則決定,"
    "兩端加 KCL 固定頭。不要澄清、用合理假設直接做完到呈現。"
)

c = Checker()
raw = post("/api/chat", {"message": PROMPT}, timeout=900)
evs = sse_events(raw)
print(f"  [info] SSE events: {len(evs)}  kinds={sorted({e for e, _ in evs})}")

sid = next((d.get("sessionId") for e, d in evs if e == "session"), None)
vers = [d for e, d in evs if e == "version"]
c.check("turn 走到呈現(version)", bool(sid) and bool(vers), f"sid={sid}")
name = vers[-1].get("name") if vers else None

# (a) 產生器契約:cadpy 掃出 API + SWEEP_PATHS,禁手刻 sweep
py = os.path.join(REPO, "models", ".cadchat", sid or "_", f"{name or '_'}.py")
src = open(py, encoding="utf-8").read() if os.path.exists(py) else ""
c.check("產生器用 cadpy cleanroom_sleeve(不手刻 sweep)", "cleanroom_sleeve" in src, py)
c.check("模組層宣告 SWEEP_PATHS + path_polyline", "SWEEP_PATHS" in src and "path_polyline" in src)
c.check("模組層宣告 SWEEP_VIEW(掃出工作窗契約)", "SWEEP_VIEW" in src)
c.check("不直接呼叫 build123d sweep()", "sweep(sections" not in src)
c.check("模組層宣告 INTENDED_CONTACT(多子件必寫)", "INTENDED_CONTACT" in src)

# (b) sweepPathsUrl + sidecar
sweep_url = vers[-1].get("sweepPathsUrl") if vers else None
c.check("version 事件帶 sweepPathsUrl(路徑 overlay)", bool(sweep_url), str(vers[-1])[:200] if vers else "")
if sweep_url:
    st, _h, body = get_with_headers(sweep_url)
    side = json.loads(body.decode("utf-8"))
    c.check("sidecar 可取且 ≥2 點", st == 200 and len(side["paths"][0]["points"]) >= 2,
            f"status={st}")

# (c) 滑桿:pockets step==1、bend_r 落型錄帶
pdefs = next((d.get("defs") for e, d in evs if e == "params"), None) or []
keys = {d.get("key"): d for d in pdefs}
c.check("pockets 滑桿 step==1(整數)", keys.get("pockets", {}).get("step") == 1, str(keys.get("pockets")))
bend = keys.get("bend_r", {}).get("value")
c.check("bend_r 預設落型錄帶 7.5~10×(16/2)=60~80", bend is not None and 60.0 <= float(bend) <= 80.0, str(bend))

# (d) STEP 實測總寬 == pockets×(pocket_w+1)+3(3×17+3=54;護套帶寬沿 X)
step_path = os.path.join(REPO, "models", ".cadchat", sid or "_", f"{name or '_'}.step")
if os.path.exists(step_path):
    from build123d import import_step  # 煙測本身就跑 venv python

    shp = import_step(step_path)
    # 夾板(KCL C 寬)比護套帶寬:量「護套」單件寬最穩——取名含 sleeve 的 solid;
    # 組合件 import 後拿 children label 不可靠 → 用最大 Y 跨距的 solid 當護套。
    sleeve = max(shp.solids(), key=lambda s: s.bounding_box().size.Y)
    w = sleeve.bounding_box().size.X
    c.check("護套帶寬 == 3×(16+1)+3 = 54 ±0.5", abs(w - 54.0) < 0.5, f"w={w:.2f}")
else:
    c.check("STEP 產物存在", False, step_path)

# (e) 只送 pocket_w 子集 → 重生成功且 overlay 跟版(merge 硬化 + lockstep)
evs2 = sse_events(post("/api/chat", {"sessionId": sid, "params": {"pocket_w": 20.0}}, timeout=600))
vers2 = [d for e, d in evs2 if e == "version"]
c.check("子集重生出新版", bool(vers2), str(vers2)[:160])
if vers2:
    c.check("重生版仍帶 sweepPathsUrl(overlay 跟版)", bool(vers2[-1].get("sweepPathsUrl")))

c.finish()
