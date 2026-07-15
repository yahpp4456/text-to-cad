# -*- coding: utf-8 -*-
"""per-user 資料隔離煙測(免 LLM):X-Remote-User header → 各自空間;跨 user 讀取
必 403/exists:false。前置:dev server 8788。直打 :8788 模擬反代已注入 header
(prod 的 header 覆寫防偽由反代端驗,見部署 runbook)。"""
import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

from _util import BASE, REPO, Checker, server_alive

C = Checker()


def _req(method, path, user=None, body=None, timeout=60):
    """帶 X-Remote-User 的請求;回 (status, body_text)。4xx/5xx 也讀 body。"""
    headers = {}
    if user:
        headers["x-remote-user"] = user
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def main():
    if not server_alive():
        msg = "server 8788 不可達;先 `cd apps/cad-chat && npm run dev`"
        if os.environ.get("CADCHAT_SMOKE") == "1":
            print("✗ " + msg)
            raise SystemExit(1)
        print("[skip] " + msg)
        return

    tag = f"{int(time.time()):x}"
    user_a, user_b = f"u_smoke_a{tag}", f"u_smoke_b{tag}"
    seed_rel = f"smoke_users_seed_{tag}.step"
    seed_abs = os.path.join(REPO, "models", seed_rel)
    os.makedirs(os.path.dirname(seed_abs), exist_ok=True)
    with open(seed_abs, "w", encoding="utf-8") as f:
        f.write("ISO-10303-21;\nEND-ISO-10303-21;\n")  # import 只驗副檔名+存在
    try:
        # 1) A 匯入 → mint A 的 session(workdirRel 應帶 users/<A>/ 前綴)
        st, body = _req("POST", "/api/import", user=user_a, body={"file": seed_rel})
        j = json.loads(body)
        C.check("A import ok", st == 200 and j.get("ok") is True, body[:120])
        sid, rel = j.get("sessionId", ""), j.get("rel", "")
        C.check("A 拿到 sessionId+rel", bool(sid) and rel.startswith("imported/"))

        # 2) session-info:本人 true / 他人 false / 無 header false
        for who, expect in [(user_a, True), (user_b, False), (None, False)]:
            st, body = _req("GET", f"/api/session-info?id={sid}", user=who)
            got = json.loads(body).get("exists")
            C.check(f"session-info as {who or 'no-header'} → {expect}", got is expect, body[:80])

        # 3) asset 租戶邊界:A 的匯入檔(users/<A>/models/.cadchat/<sid>/imported/…)
        afile = urllib.parse.quote(f"users/{user_a}/models/.cadchat/{sid}/{rel}", safe="")
        st, _ = _req("GET", f"/api/asset?file={afile}", user=user_a)
        C.check("A 讀 A asset → 200", st == 200, f"got {st}")
        st, _ = _req("GET", f"/api/asset?file={afile}", user=user_b)
        C.check("B 讀 A asset → 403", st == 403, f"got {st}")
        st, _ = _req("GET", f"/api/asset?file={afile}")
        C.check("無 header 讀 users/ 形 → 403", st == 403, f"got {st}")

        # 4) 磁碟真相:A 的 session 目錄真的在 users/<A>/ 下(不信 ok:true)
        wd = os.path.join(REPO, "users", user_a, "models", ".cadchat", sid)
        C.check("A workdir 落 users/<A>/", os.path.isdir(wd), wd)
        imported = os.path.join(wd, *rel.split("/"))
        C.check("匯入檔真的落盤 size>0", os.path.isfile(imported) and os.path.getsize(imported) > 0)

        # 5) B interrupt A 的 sessionId → 204 no-op(拿不到 A 的 live session)
        st, _ = _req("POST", "/api/interrupt", user=user_b, body={"sessionId": sid})
        C.check("B interrupt A → 204 no-op", st == 204, f"got {st}")
        st, body = _req("GET", f"/api/session-info?id={sid}", user=user_a)
        C.check("A session 不受影響", json.loads(body).get("exists") is True)

        # 6) B open-project A 的 session 目錄(users/ 形繞道)→ 404/403,不得成功
        st, body = _req(
            "POST", "/api/open-project", user=user_b,
            body={"dir": f"users/{user_a}/models/.cadchat/{sid}"},
        )
        ok = json.loads(body).get("ok") if st == 200 else False
        C.check("B open-project A 目錄 → 不成功", ok is not True, body[:120])

        # 7) 壞使用者名 → 403;legacy(無 header)files 照舊 200(零回歸)
        st, _ = _req("GET", "/api/files?dir=", user="../evil")
        C.check("壞 user header → 403", st == 403, f"got {st}")
        st, body = _req("GET", "/api/files?dir=")
        C.check("legacy files 200 ok", st == 200 and json.loads(body).get("ok") is True)
    finally:
        try:
            os.remove(seed_abs)
        except OSError:
            pass
        for u in (user_a, user_b):
            shutil.rmtree(os.path.join(REPO, "users", u), ignore_errors=True)

    C.finish()


if __name__ == "__main__":
    main()
