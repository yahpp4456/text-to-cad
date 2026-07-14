# -*- coding: utf-8 -*-
"""草模模式 L4 煙測(消耗真 LLM 回合;CADCHAT_SMOKE_LLM=1 才由 run_all 執行)。

一回合草模對話:POST /api/chat {mode:"sketch"} → 斷言
① session 事件 mode:"sketch"(runner 選路生效);
② 全程零 cad_* 工具事件(工具面隔離實證——sketch agent 拿不到 CAD 工具);
③ version 事件 type:"sketch" 帶 sceneUrl;
④ GET sceneUrl → 場景 JSON 結構最低限(bodies 非空、drives 1~2 且綁 joint);
⑤ 回合 ok。
prompt 壓成本:極短需求、明令不澄清直接搭完(pattern 同 smoke_revolute_live)。
"""
import json

from _util import Checker, get_with_headers, post, sse_events

c = Checker()

# 驅動/傳動明說(馬達直驅)——prompt 的「未指明必問」規則(2026-07-14)不該對
# 已指明的需求觸發;再疊「明示免問」讓本測試穩定走 present 快路徑。
raw = post(
    "/api/chat",
    {
        "mode": "sketch",
        "message": "最簡單的草模:一支旋轉臂繞固定底座擺動 0~45 度,單一旋轉驅動,"
        "馬達直驅(驅動與傳動都已指定)。不要澄清、不要提問,直接 sketch_present 搭完呈現。",
    },
    timeout=600,
)
events = sse_events(raw)
kinds = [e for e, _ in events]

session_evs = [d for e, d in events if e == "session"]
c.check(
    "session 事件帶 mode:'sketch'(runner 選路)",
    any(d.get("mode") == "sketch" for d in session_evs),
    str(session_evs)[:160],
)

tool_names = [d.get("name", "") for e, d in events if e == "tool"]
c.check(
    "全程零 cad_* 工具事件(草模工具面隔離)",
    not any(n.startswith("cad.") for n in tool_names),
    str(tool_names)[:200],
)

# tool 事件是 patch 語意:running 事件帶 name,done/error 是同 id 的補丁「不帶 name」
# (前端 UPSERT_TOOL 按 id 合併)——斷言要按 id 配對,不能要求單一事件同時有兩者。
sk_ids = {
    d.get("id")
    for e, d in events
    if e == "tool" and str(d.get("name", "")).startswith("sketch.present")
}
c.check(
    "有 sketch.present 工具事件且(同 id)done",
    any(
        d.get("status") == "done"
        for e, d in events
        if e == "tool" and d.get("id") in sk_ids
    ),
    str([d for e, d in events if e == "tool"])[:200],
)

versions = [d for e, d in events if e == "version"]
sk = next((v for v in versions if v.get("type") == "sketch"), None)
c.check("version 事件 type:'sketch' 帶 sceneUrl", bool(sk and sk.get("sceneUrl")), str(versions)[:200])
c.check("version 事件不帶 glbUrl/verified/mode(草模契約)",
        bool(sk) and all(k not in sk for k in ("glbUrl", "verified", "mode")), str(sk)[:200])

if sk:
    status, _, body = get_with_headers(sk["sceneUrl"])
    ok_doc = False
    detail = f"HTTP {status}"
    try:
        doc = json.loads(body.decode("utf-8"))
        drives = doc.get("drives") or []
        bound = set()
        for b in doc.get("bodies") or []:
            j = (b or {}).get("joint") or {}
            if j.get("drive"):
                bound.add(j["drive"])
        ok_doc = (
            len(doc.get("bodies") or []) > 0
            and 1 <= len(drives) <= 2
            and all(d.get("id") in bound for d in drives)
        )
        detail = f"bodies={len(doc.get('bodies') or [])} drives={[d.get('id') for d in drives]} bound={sorted(bound)}"
    except Exception as err:
        detail = f"{detail} parse:{err}"
    c.check("sceneUrl 場景 JSON 結構最低限(bodies>0、DOF 1~2 全綁 joint)", status == 200 and ok_doc, detail)

done = next((d for e, d in events if e == "done"), None)
c.check("回合 ok:true", bool(done and done.get("ok") is True), str(done))

c.finish()
