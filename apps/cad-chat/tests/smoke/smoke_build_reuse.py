# -*- coding: utf-8 -*-
"""建置憑證煙測(免 LLM,純 API + 磁碟):輸入與環境沒變就沿用產物,有任何變動就重建。

open-project(fixture,沒有憑證 → 重建)→ save-project → 再開(憑證命中 → 沿用,GLB 逐位
相同)→ 改產生器(→ 重建)→ 換掉產物(→ 重建)→ revert(快照帶憑證 → 沿用)。

憑證只有常駐 worker 路徑寫得出來。伺服器以 CADCHAT_WORKER=0 啟動時不會有憑證,本支改斷
「一律重建、結果正確」——兩種設定下都要綠。暫存專案以 tmp_smoke 開頭(教訓庫雜訊過濾)。
"""
import hashlib
import json
import os
import shutil
import time

from _util import Checker, REPO, post

c = Checker()
FIXTURE = "sheet_u_bracket"
NAME = "sheet_u_bracket"
SAVED = f"tmp_smoke_reuse_{os.getpid()}"
SAVED_B = f"tmp_smoke_reuse_b_{os.getpid()}"
MODELS = os.path.join(REPO, "models")


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def open_project(directory):
    t0 = time.time()
    j = json.loads(post("/api/open-project", {"dir": directory}, timeout=600))
    return j, time.time() - t0


def workdir(sid):
    return os.path.join(MODELS, ".cadchat", sid)


def glb_of(sid):
    return os.path.join(workdir(sid), f".{NAME}.step.glb")


try:
    # ── A. fixture 沒有憑證:第一次開一定重建 ──
    a, ta = open_project(FIXTURE)
    c.check("A: open-project ok", a.get("ok") is True, str(a)[:200])
    sid_a = a.get("sessionId")
    c.check("A: fixture 沒有憑證 → 重建(reused.build=false)", a.get("reused", {}).get("build") is False, str(a.get("reused")))
    stamp_a = os.path.join(workdir(sid_a), f".{NAME}.build.json")
    has_stamp = os.path.exists(stamp_a)
    print(f"  [info] 第一次開(重建+驗證){ta:.1f}s;憑證{'已寫入' if has_stamp else '未寫入(伺服器未啟用 worker)'}")
    if has_stamp:
        st = json.load(open(stamp_a, encoding="utf-8"))
        paths = [f"{i['base']}:{i['path']}" for i in st.get("inputs", [])]
        c.check("A: 憑證的輸入含產生器本身", f"gen:{NAME}.py" in paths, str(paths)[:200])
        c.check("A: 憑證不把產物當輸入", not any(p.endswith(".step") or p.endswith(".glb") for p in paths), str(paths)[:200])
        c.check("A: 憑證記了產物雜湊(step/glb/meta)", len(st.get("outputs", [])) >= 3, str(st.get("outputs"))[:200])
        c.check("A: 憑證記了環境(kernel 版本 + cadpy 摘要 + 腳本摘要)",
                all(st.get("env", {}).get(k) for k in ("python", "build123d", "ocp", "cadpy", "scripts")), str(st.get("env")))
        c.check("A: 完整驗證結果已快取", os.path.exists(os.path.join(workdir(sid_a), f".{NAME}.validate.json")))

    # ── B. 存成專案:憑證跟著走 ──
    sj = json.loads(post("/api/save-project", {"sessionId": sid_a, "name": SAVED, "overwrite": True}))
    c.check("B: save-project ok", sj.get("ok") is True, str(sj)[:160])
    saved_dir = os.path.join(MODELS, SAVED)
    if has_stamp:
        c.check("B: 存檔帶著憑證與驗證快取",
                os.path.exists(os.path.join(saved_dir, f".{NAME}.build.json"))
                and os.path.exists(os.path.join(saved_dir, f".{NAME}.validate.json")))

    # ── C. 再開同一個專案:沒有任何變動 ──
    r, tr = open_project(SAVED)
    c.check("C: 再開 ok", r.get("ok") is True, str(r)[:200])
    sid_c = r.get("sessionId")
    c.check("C: 結果與第一次相同(validateOk / partCount / type)",
            (r.get("validateOk"), (r.get("version") or {}).get("partCount"), r.get("type"))
            == (a.get("validateOk"), (a.get("version") or {}).get("partCount"), a.get("type")),
            f"{r.get('validateOk')} {(r.get('version') or {}).get('partCount')} vs {a.get('validateOk')} {(a.get('version') or {}).get('partCount')}")
    c.check("C: 參數定義照常回傳", isinstance(r.get("params"), list) and len(r["params"]) > 0)
    if has_stamp:
        c.check("C: 沿用產物(reused.build=true)", r.get("reused", {}).get("build") is True, str(r.get("reused")))
        c.check("C: 沿用驗證結果(reused.validate=true)", r.get("reused", {}).get("validate") is True, str(r.get("reused")))
        c.check("C: session 的 GLB 與存檔逐位相同(沒有重新產生)",
                sha(glb_of(sid_c)) == sha(os.path.join(saved_dir, f".{NAME}.step.glb")))
        c.check("C: 版本快照也帶著憑證(回退用)",
                os.path.exists(os.path.join(workdir(sid_c), "versions", "v1", f".{NAME}.build.json")))
        print(f"  [info] 再開(沿用){tr:.1f}s(第一次 {ta:.1f}s)")
        c.check("C: 沿用比重建快", tr < ta, f"{tr:.1f}s vs {ta:.1f}s")
    else:
        c.check("C: 沒有憑證 → 一律重建(reused.build=false)", r.get("reused", {}).get("build") is False, str(r.get("reused")))

    # ── D. 回退到 v1:快照帶憑證 → 沿用;產生新版 v2 ──
    rv = json.loads(post("/api/revert-version", {"sessionId": sid_c, "ver": "v1"}, timeout=600))
    c.check("D: revert ok,產生 v2", rv.get("ok") is True and (rv.get("version") or {}).get("id") == "v2", str(rv)[:200])
    if has_stamp:
        c.check("D: 回退沿用快照的產物與驗證(reused 兩項皆 true)",
                rv.get("reused") == {"build": True, "validate": True}, str(rv.get("reused")))
    c.check("D: 回退後 validateOk 不變", rv.get("validateOk") == a.get("validateOk"), str(rv.get("validateOk")))

    # ── E. 改了產生器:一定重建 ──
    gen_saved = os.path.join(saved_dir, f"{NAME}.py")
    src = open(gen_saved, encoding="utf-8").read()
    with open(gen_saved, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(src + "\n# touched by smoke_build_reuse\n")
    e, te = open_project(SAVED)
    c.check("E: 改過產生器 → ok 且重建(reused.build=false)",
            e.get("ok") is True and e.get("reused", {}).get("build") is False, str(e.get("reused")))
    c.check("E: 重建後驗證也重跑(reused.validate=false)", e.get("reused", {}).get("validate") is False, str(e.get("reused")))
    sid_e = e.get("sessionId")
    if has_stamp:
        c.check("E: 重建後寫了新憑證(key 與舊的不同)",
                json.load(open(os.path.join(workdir(sid_e), f".{NAME}.build.json"), encoding="utf-8"))["key"]
                != json.load(open(stamp_a, encoding="utf-8"))["key"])

    # ── F. 輸入沒變、但產物被換掉:不可沿用 ──
    sj2 = json.loads(post("/api/save-project", {"sessionId": sid_e, "name": SAVED_B, "overwrite": True}))
    c.check("F: 第二份存檔 ok", sj2.get("ok") is True, str(sj2)[:160])
    saved_b = os.path.join(MODELS, SAVED_B)
    with open(os.path.join(saved_b, f".{NAME}.step.glb"), "wb") as fh:
        fh.write(b"not the glb this stamp was written for")
    f, _tf = open_project(SAVED_B)
    c.check("F: 產物對不上 → ok 且重建(reused.build=false)",
            f.get("ok") is True and f.get("reused", {}).get("build") is False, str(f.get("reused")))
    c.check("F: session 的 GLB 是重新產生的真檔",
            os.path.getsize(glb_of(f.get("sessionId"))) > 10_000, str(os.path.getsize(glb_of(f.get("sessionId")))))
finally:
    for d in (SAVED, SAVED_B):
        shutil.rmtree(os.path.join(MODELS, d), ignore_errors=True)

c.finish()
