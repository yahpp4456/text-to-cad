# -*- coding: utf-8 -*-
"""「量不到不算通過」端到端(免 LLM,純 API + 磁碟):掃掠逾時 → 未量測 → 匯出被擋。

要讓掃掠真的逾時,伺服器必須以 CADCHAT_SWEEP_DEADLINE_S=0 啟動,所以這支**自己起一個
伺服器**(獨立埠、非 dev 模式,只打 API),跑完關掉;不依賴、也不影響受測的主實例。

流程:開一個有 MOTION 的 fixture(完整驗證 → 掃掠逾時)→ 精算 → 匯出閘 → 匯出。斷:
掃掠列是 not_checked(不是通過、也不是失敗)、完整驗證總判定為未通過、匯出被擋、
這種「沒有定論」的結果不會被存成驗證快取。
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from _util import Checker, REPO

PORT = int(os.environ.get("CADCHAT_SMOKE_AUX_PORT", "8897"))
BASE = f"http://127.0.0.1:{PORT}"
APP = os.path.join(os.environ.get("CADCHAT_RUNTIME_ROOT") or REPO, "apps", "cad-chat")
FIXTURE = "steering_box_rack_pinion"  # 齒輪齒條:2 DOF、3 對,一定會進掃掠

c = Checker()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 不走系統代理


def post(path, body, timeout=600):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST"
    )
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.read().decode("utf-8")


def alive():
    try:
        with opener.open(BASE + "/api/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def kill(proc):
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.kill()
    try:
        proc.wait(timeout=10)
    except Exception:
        pass


if alive():
    print(f"[smoke] {BASE} 已有服務在跑——改用 CADCHAT_SMOKE_AUX_PORT 指定另一個空埠")
    sys.exit(1)

env = {
    **os.environ,
    "CADCHAT_PORT": str(PORT),
    "CADCHAT_SWEEP_DEADLINE_S": "0",
    "CADCHAT_DEV": "",  # serve 模式:不起 Vite,不佔 HMR 埠
}
env.pop("CADCHAT_LAUNCH_TOKEN", None)
log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".out", "gate_unmeasured_server.log")
os.makedirs(os.path.dirname(log_path), exist_ok=True)
log = open(log_path, "w", encoding="utf-8")
server = subprocess.Popen(
    ["node", os.path.join("src", "server", "server.mjs")], cwd=APP, env=env, stdout=log, stderr=subprocess.STDOUT
)
try:
    deadline = time.time() + 60
    while time.time() < deadline and not alive():
        if server.poll() is not None:
            break
        time.sleep(0.5)
    c.check("輔助伺服器(掃掠時限 0 秒)啟動", alive(), f"log: {log_path}")
    if not alive():
        c.finish()

    # ── 開專案:完整驗證的掃掠逾時 → 總判定未通過 ──
    o = json.loads(post("/api/open-project", {"dir": FIXTURE}))
    c.check("open-project ok(幾何建得出來)", o.get("ok") is True, str(o)[:200])
    sid = o.get("sessionId")
    c.check("完整驗證總判定:未通過(validateOk=false)", o.get("validateOk") is False, str(o.get("validateOk")))
    c.check("版本沒有被標成已驗證", (o.get("version") or {}).get("verified") is not True, str((o.get("version") or {}).get("verified")))

    # ── 精算:逐列看狀態 ──
    v = json.loads(post("/api/validate", {"sessionId": sid}))
    c.check("精算回應 ok、validateOk=false", v.get("ok") is True and v.get("validateOk") is False, str(v)[:160])
    rows = {r["label"]: r for r in v.get("checks", [])}
    sweep = next((r for label, r in rows.items() if "motion-sweep" in label), None)
    c.check("掃掠列存在", sweep is not None, str(list(rows)))
    if sweep:
        c.check("掃掠列 status=not_checked", sweep.get("status") == "not_checked", str(sweep))
        c.check("掃掠列仍標 skipped(agent 不把逾時當幾何錯誤)", sweep.get("skipped") is True, str(sweep))
        c.check("掃掠列圖示是問號,不是 ✓ 也不是 ✗", sweep.get("icon") == "?", str(sweep.get("icon")))
        c.check("掃掠列備註說明未量測與原因", "未量測" in sweep.get("note", "") and "逾時" in sweep.get("note", ""), sweep.get("note", "")[:80])
    others = [r for label, r in rows.items() if "motion-sweep" not in label]
    c.check("其餘檢查都有定論且通過", len(others) >= 3 and all(r.get("status") == "ok" for r in others),
            str([(r["label"][:8], r.get("status")) for r in others]))
    c.check("沒有任何一列是失敗(這不是幾何錯誤)", not any(r.get("status") == "failed" for r in rows.values()))
    c.check("已不列自交、壁厚兩列", not any("自交" in label or "壁厚" in label for label in rows), str(list(rows)))

    # ── 匯出閘與匯出:擋下 ──
    g = json.loads(post("/api/validate-ver", {"sessionId": sid, "ver": "v1"}))
    c.check("匯出閘:verified=false", g.get("ok") is True and g.get("verified") is False, str(g)[:200])
    gate_rows = (g.get("gate") or {}).get("checks") or []
    c.check("匯出閘的檢查列帶著 not_checked", any(r.get("status") == "not_checked" for r in gate_rows),
            str([(r.get("label", "")[:8], r.get("status")) for r in gate_rows]))
    e = json.loads(post("/api/export", {"sessionId": sid, "format": "stl", "ver": "v1"}))
    c.check("匯出被擋(沒有產出檔案)", e.get("ok") is not True and not e.get("file"), str(e)[:200])

    # ── 沒有定論的結果不存成快取 ──
    workdir = os.path.join(REPO, "models", ".cadchat", sid)
    c.check("驗證快取沒有寫入(.validate.json 不存在)",
            not os.path.exists(os.path.join(workdir, f".{FIXTURE}.validate.json")))
finally:
    kill(server)
    log.close()

c.finish()
