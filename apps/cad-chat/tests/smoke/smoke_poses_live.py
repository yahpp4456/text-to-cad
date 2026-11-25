# -*- coding: utf-8 -*-
"""LLM-gated(消耗訂閱回合):兩個獨立運動軸的機構,agent 會宣告具名姿態與動作序列(藍圖 D3)。

一輪:升降軸 + 平行夾爪的取放頭,使用者講了工作循環(張開 → 夾住 → 抬起)。斷:
(a) motion 事件帶 states 與 sequences,姿態的鍵是主動 dof、值在 0~1;
(b) 序列引用的姿態都存在,至少 3 步;
(c) 產生器原始碼裡真的寫了 states / sequences(不是伺服器補的);
(d) 精算(/api/validate)的掃掠列說明查了幾個姿態、幾條序列——也就是「同時到位」的組合真的被查到。
CADCHAT_SMOKE_LLM=1 才由 run_all 執行。
"""
import json
import os

from _util import Checker, REPO, chat_until_version, post

PROMPT = (
    "做一個簡單的取放頭:一根固定的立柱;一個沿立柱上下滑動的滑座,行程 60mm;滑座前面裝一個平行夾爪,"
    "左右兩指對稱開合,每指行程 8mm。工作循環是:夾爪張開 → 夾住工件 → 夾著抬起到頂。"
    "要有運動宣告。形狀越簡單越好(方塊即可),不要澄清,直接做完到呈現。"
)

c = Checker()
run = chat_until_version(PROMPT, timeout=1200)
c.check("turn 走到呈現(version)", bool(run.sid) and bool(run.versions), f"kinds={run.kinds}")
if not run.versions:
    c.finish()

motions = [d for e, d in run.events if e == "motion" and d.get("dofs")]
motion = motions[-1] if motions else {}
dofs = motion.get("dofs") or []
masters = [d["id"] for d in dofs if not d.get("couple")]
states = motion.get("states") or {}
sequences = motion.get("sequences") or {}
print(f"  [info] dofs={[(d['id'], d.get('couple')) for d in dofs]}")
print(f"  [info] states={json.dumps(states, ensure_ascii=False)}")
print(f"  [info] sequences={json.dumps(sequences, ensure_ascii=False)}")

c.check("至少兩個獨立運動軸(升降 + 夾爪)", len(masters) >= 2, str(masters))
c.check("夾爪兩指用 couple 同步(其中一指是從動)", any(d.get("couple") for d in dofs), str([(d["id"], d.get("couple")) for d in dofs]))
c.check("motion 事件帶具名姿態(至少 3 個)", len(states) >= 3, str(list(states)))
c.check("每個姿態都列出全部主動 dof,值在 0~1",
        bool(states) and all(sorted(st) == sorted(masters) and all(0 <= v <= 1 for v in st.values()) for st in states.values()),
        str(states)[:240])
c.check("至少有一個姿態是兩個軸同時不在原位(夾著抬起)",
        any(sum(1 for v in st.values() if v > 0) >= 2 for st in states.values()), str(states)[:240])
c.check("motion 事件帶動作序列,至少 3 步且引用的姿態都存在",
        any(len(seq) >= 3 and all(step in states for step in seq) for seq in sequences.values()), str(sequences))

name = run.versions[-1].get("name")
py = os.path.join(REPO, "models", ".cadchat", run.sid, f"{name}.py")
src = open(py, encoding="utf-8").read() if os.path.exists(py) else ""
c.check("產生器原始碼裡寫了 states 與 sequences", '"states"' in src and '"sequences"' in src, py)

vr = json.loads(post("/api/validate", {"sessionId": run.sid}, timeout=400))
sweep = next((ck for ck in vr.get("checks", []) if "運動掃掠" in (ck.get("label") or "")), None)
print(f"  [info] 精算掃掠列: {json.dumps(sweep, ensure_ascii=False)[:400]}")
c.check("精算 ok(端點可用)", vr.get("ok") is True, str(vr)[:200])
c.check("精算的掃掠列有跑(不是略過)", bool(sweep) and not sweep.get("skipped"), str(sweep)[:200])
c.check("掃掠列說明查了姿態與序列(同時到位的組合)", bool(sweep) and "個姿態" in (sweep.get("note") or "") and "條序列" in (sweep.get("note") or ""),
        (sweep or {}).get("note", "")[:240])

c.finish()
