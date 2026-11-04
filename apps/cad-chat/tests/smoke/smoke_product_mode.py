"""產品設計模式 API 段(免 LLM):草稿端點 + 零 LLM 成形 + sidecar + 負案例。

流程:
  A. POST /api/surface-draft(無 sessionId)→ mint product session;GET 讀回;patch 合併 revision+1
  B. baseRevision 錯 → 409 revision_conflict;壞草稿 → 400 invalid_draft(errors 帶 path)
  C. POST /api/surface-build → version/present 帶 surfaceUrl;磁碟 STEP 開頭 ISO-10303-21、GLB>0、
     .surface.json 有 edges[].grade / summary;validate 列有「邊連續性 continuity」真值
  D. 半完成草稿 build → 400 errors;design session 打 surface-draft → 400 mode_mismatch;
     product session 打 /api/export(STEP)→ 200
  E. 滑桿 params-only 回合(/api/chat {params:{thick}})走決定性重生:新版本仍帶 surfaceUrl
用法:CADCHAT_BASE=http://127.0.0.1:8788 python smoke_product_mode.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from _util import BASE, REPO, Checker, get_with_headers, post, server_alive, sse_events  # noqa: E402

EX = os.path.join(REPO, "apps", "cad-chat", "src", "lib", "surface", "examples")


def post_status(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def get_json(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def main() -> int:
    if not server_alive():
        print("server 未啟動,跳過(CADCHAT_SMOKE=1 轉為失敗)")
        return 1 if os.environ.get("CADCHAT_SMOKE") == "1" else 0
    c = Checker()
    mouse = json.load(open(os.path.join(EX, "mouse_shell.json"), encoding="utf-8"))

    # ── A. mint + 讀回 + patch ──
    st, j = post_status("/api/surface-draft", {"name": "mouse", "draft": mouse})
    c.check("A1 無 sessionId 存草稿 → 200 mint product session", st == 200 and j.get("ok") and j.get("sessionId"), f"{st} {str(j)[:200]}")
    sid = j.get("sessionId")
    c.check("A2 revision 從 1 起算、summary 可生成", j.get("revision") == 1 and j.get("summary", {}).get("buildable") is True, str(j.get("summary")))
    st, g = get_json(f"/api/surface-draft?sessionId={sid}&name=mouse")
    c.check("A3 GET 讀回同 revision 與對稱設定", st == 200 and g.get("revision") == 1 and g["draft"]["symmetry"] == "YZ", str(g)[:200])
    st, p = post_status("/api/surface-draft", {"sessionId": sid, "name": "mouse", "baseRevision": 1, "patch": {"analysis": {"minContinuity": "G2"}}})
    c.check("A4 patch 合併 → revision 2、analysis 淺合併", st == 200 and p.get("revision") == 2 and p["draft"]["analysis"]["minContinuity"] == "G2" and p["draft"]["analysis"]["creases"] == 0, str(p)[:200])

    # ── B. 負案例 ──
    st, cf = post_status("/api/surface-draft", {"sessionId": sid, "name": "mouse", "baseRevision": 1, "patch": {"fuse": False}})
    c.check("B1 baseRevision 過期 → 409 revision_conflict 帶磁碟 revision", st == 409 and cf.get("error") == "revision_conflict" and cf.get("revision") == 2, f"{st} {str(cf)[:160]}")
    st, bad = post_status("/api/surface-draft", {"sessionId": sid, "name": "mouse", "patch": {"curves": [{"id": "sec_mid", "kind": "helix"}]}})
    c.check("B2 壞草稿 → 400 invalid_draft 帶 path", st == 400 and bad.get("error") == "invalid_draft" and any("kind" in e["path"] for e in bad.get("errors", [])), f"{st} {str(bad)[:200]}")

    # ── C. 零 LLM 成形 ──
    st, b = post_status("/api/surface-build", {"sessionId": sid, "name": "mouse"})
    c.check("C1 surface-build 200 ok", st == 200 and b.get("ok") is True, f"{st} {str(b)[:300]}")
    ver = b.get("version") or {}
    pres = b.get("present") or {}
    c.check("C2 version 帶 surfaceUrl 且版本化", bool(ver.get("surfaceUrl")) and "versions%2Fv1" in ver.get("surfaceUrl", ""), str(ver.get("surfaceUrl")))
    c.check("C3 present.surfaceUrl 與 version 同", pres.get("surfaceUrl") == ver.get("surfaceUrl"))
    c.check("C4 params 滑桿含 thick", any(d.get("key") == "thick" for d in b.get("params", [])), str(b.get("params")))
    wd = os.path.join(REPO, "models", ".cadchat", sid)
    step = os.path.join(wd, "mouse.step")
    glb = os.path.join(wd, ".mouse.step.glb")
    side = os.path.join(wd, ".mouse.surface.json")
    c.check("C5 STEP 落地且是 ISO-10303-21", os.path.isfile(step) and open(step, "rb").read(13) == b"ISO-10303-21;")
    c.check("C6 GLB 落地 > 0", os.path.isfile(glb) and os.path.getsize(glb) > 0)
    sj = json.load(open(side, encoding="utf-8")) if os.path.isfile(side) else {}
    c.check("C7 sidecar edges[].grade / summary / cages / combs 齊", sj.get("schemaVersion") == 1 and all("grade" in e for e in sj.get("edges", [])) and sj.get("summary", {}).get("ok") is True and len(sj.get("cages", [])) >= 1 and len(sj.get("combs", [])) == 3, str(sj.get("summary")))
    if ver.get("surfaceUrl"):
        st2, hdr, body = get_with_headers(ver["surfaceUrl"])
        c.check("C8 surfaceUrl 可取、內容同 sidecar", st2 == 200 and json.loads(body.decode("utf-8")).get("summary") == sj.get("summary"))
    vrows = {r["label"]: r for r in (b.get("validate") or {}).get("checks", [])}
    c.check("C9 validate 列有連續性真值、開放邊 0", vrows.get("邊連續性 continuity", {}).get("icon") == "✓" and vrows.get("開放邊 free-edges", {}).get("note") == "0 條開放邊", str(list(vrows)))
    c.check("C10 summary 回報 G2 接縫", (b.get("summary") or {}).get("g2", 0) >= 1 and (b.get("summary") or {}).get("finalFree") == 0, str(b.get("summary")))

    # ── D. 半完成 / 非產品 session / 匯出 ──
    st, j2 = post_status("/api/surface-draft", {"name": "half", "draft": {"schemaVersion": 1, "curves": [{"id": "a", "kind": "line", "points": [[0, 0, 0], [1, 0, 0]]}], "surfaces": []}})
    sid2 = j2.get("sessionId")
    c.check("D1 半完成草稿可存(buildable false)", st == 200 and j2.get("summary", {}).get("buildable") is False, str(j2)[:200])
    st, hb = post_status("/api/surface-build", {"sessionId": sid2, "name": "half"})
    c.check("D2 半完成 build → 400 errors", st == 400 and hb.get("errors"), f"{st} {str(hb)[:200]}")
    st, op = post_status("/api/open-project", {"dir": "linear_stage"})
    dsid = op.get("sessionId")
    c.check("D3 design 專案 session 打 surface-draft → 400 mode_mismatch", dsid and post_status("/api/surface-draft", {"sessionId": dsid, "name": "x", "draft": mouse})[0] == 400, str(op.get("mode")))
    st, hd, body = get_with_headers(f"/api/asset?file={urllib.request.quote(f'models/.cadchat/{sid}/versions/v1/mouse.step')}")
    c.check("D4 product session 的 STEP 可下載", st == 200 and body[:13] == b"ISO-10303-21;")

    # ── E. 滑桿 params-only 決定性重生 ──
    raw = post("/api/chat", {"sessionId": sid, "params": {"thick": 1.5}}, timeout=600)
    evs = sse_events(raw)
    vers = [d for e, d in evs if e == "version"]
    c.check("E1 params-only 重生出新版本且帶 surfaceUrl", len(vers) == 1 and vers[0].get("id") == "v2" and bool(vers[0].get("surfaceUrl")), str([(e, str(d)[:80]) for e, d in evs if e in ("version", "error")]))
    st, g2 = get_json(f"/api/surface-draft?sessionId={sid}&name=mouse")
    thick = next((o["t"] for o in g2["draft"]["ops"] if o["op"] == "thicken"), None)
    c.check("E2 草稿純量未被重生動到(下次 build 由磁碟 PARAMS 套回)", thick in (2.0, 1.5), str(thick))
    return c.finish()


if __name__ == "__main__":
    sys.exit(main())
