# -*- coding: utf-8 -*-
"""版本快照+回退+下載煙測(免 LLM,純 API+磁碟):
open-project(v1)→ 弄髒頂層 → revert v1(v2,標記消失=真回退)→ save-project 不挾
versions/ → asset ?download= header → /api/export STL → /api/export-parts 拆件
(單件/多件 zip/整機零件包+負案例)。
產出 .out/versions_session.json 給 smoke_restore.py 當種子。"""
import hashlib
import json
import os
import shutil
import urllib.parse
import zipfile

from _util import Checker, REPO, get_with_headers, out_path, post

c = Checker()


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


# ── 1. open-project → v1(glbUrl 應指 versions/v1 快照) ──
j = json.loads(post("/api/open-project", {"dir": "motorized_linear_stage"}))
c.check("open-project ok", j.get("ok") is True, str(j)[:200])
sid = j.get("sessionId")
name = j.get("name")
v1 = j.get("version") or {}
c.check("v1 glbUrl 指快照路徑", "versions%2Fv1" in (v1.get("glbUrl") or ""), v1.get("glbUrl", ""))
wd = os.path.join(REPO, "models", ".cadchat", sid)
snap1 = os.path.join(wd, "versions", "v1")
need = [f".{name}.step.glb", f"{name}.py", f"{name}.step", "meta.json"]
c.check(
    "v1 快照檔齊",
    all(os.path.exists(os.path.join(snap1, f)) for f in need),
    str([f for f in need if not os.path.exists(os.path.join(snap1, f))]),
)
meta1 = json.load(open(os.path.join(snap1, "meta.json"), encoding="utf-8"))
c.check("meta.json name 正確", meta1.get("name") == name, str(meta1))
c.check("session.json 已落盤", os.path.exists(os.path.join(wd, "session.json")))

# ── 2. 弄髒工作基準(fixture 產生器無 PARAMS,免 LLM 的參數重生不可用;直接動頂層檔) ──
py1 = sha(os.path.join(snap1, f"{name}.py"))
top_py = os.path.join(wd, f"{name}.py")
with open(top_py, "a", encoding="utf-8") as f:
    f.write("\n# smoke marker: dirtied after v1\n")
c.check("頂層 py 已被弄髒(≠ v1 快照)", sha(top_py) != py1)

# ── 3. 回退 v1 → 產生 v2 = v1 複本(標記應消失) ──
rj = json.loads(post("/api/revert-version", {"sessionId": sid, "ver": "v1"}))
c.check("revert ok", rj.get("ok") is True, str(rj)[:200])
v2 = rj.get("version") or {}
c.check("revert 產生 v2", v2.get("id") == "v2", str(v2)[:120])
c.check("revert from=v1", rj.get("from") == "v1")
c.check("頂層 py == v1 快照(真回退,標記消失)", sha(top_py) == py1)
c.check("v2 glbUrl 指 versions/v2", "versions%2Fv2" in (v2.get("glbUrl") or ""), v2.get("glbUrl", ""))
c.check("v1/v2 glbUrl 路徑不同", (v1.get("glbUrl") or "").split("&")[0] != (v2.get("glbUrl") or "").split("&")[0])
c.check("v2 快照存在", os.path.exists(os.path.join(wd, "versions", "v2", "meta.json")))

# 退化案:沒有快照的版本 id
r404 = post("/api/revert-version", {"sessionId": sid, "ver": "v99"})
c.check("v99 無快照 → 誠實錯誤", "沒有快照" in r404, r404[:120])

# ── 4. save-project 不挾 versions/ ──
sj = json.loads(post("/api/save-project", {"sessionId": sid, "name": "cadchat_snap_test", "overwrite": True}))
c.check("save-project ok", sj.get("ok") is True, str(sj)[:120])
saved = os.path.join(REPO, "models", "cadchat_snap_test")
c.check("存出的專案無 versions/", not os.path.exists(os.path.join(saved, "versions")))
c.check("存出的專案有產生器", os.path.exists(os.path.join(saved, f"{name}.py")))
shutil.rmtree(saved, ignore_errors=True)

# ── 5. 下載:asset ?download= header ──
step_rel = f"models/.cadchat/{sid}/versions/v1/{name}.step"
st, hd, body = get_with_headers(
    "/api/asset?file=" + urllib.parse.quote(step_rel, safe="") + "&download=" + urllib.parse.quote(f"{name}_v1.step")
)
disp = hd.get("Content-Disposition") or hd.get("content-disposition") or ""
c.check("STEP 下載 200", st == 200 and len(body) > 1000, f"status={st} bytes={len(body)}")
c.check("Content-Disposition attachment+檔名", "attachment" in disp and f"{name}_v1.step" in disp, disp)
st2, hd2, _ = get_with_headers("/api/asset?file=" + urllib.parse.quote(step_rel, safe=""))
c.check("不帶 download → 無 Content-Disposition", not (hd2.get("Content-Disposition") or hd2.get("content-disposition")))

# ── 6. /api/export:v1 快照 STEP → STL;負案例 ──
ej = json.loads(post("/api/export", {"sessionId": sid, "ver": "v1", "format": "stl"}))
c.check("export stl ok", ej.get("ok") is True, str(ej)[:200])
stl_abs = os.path.join(REPO, ej.get("file", "").replace("/", os.sep))
c.check("STL 檔存在且非空", os.path.exists(stl_abs) and os.path.getsize(stl_abs) > 1000,
        f"{ej.get('file')} size={os.path.getsize(stl_abs) if os.path.exists(stl_abs) else 'N/A'}")
st3, hd3, body3 = get_with_headers(
    "/api/asset?file=" + urllib.parse.quote(ej.get("file", ""), safe="") + "&download=x.stl"
)
c.check("STL 可經 asset 下載", st3 == 200 and len(body3) > 1000)
bad = post("/api/export", {"sessionId": sid, "ver": "v1", "format": "exe"})
c.check("format 白名單擋掉 exe", "僅支援" in bad, bad[:120])
bad2 = post("/api/export", {"sessionId": sid, "ver": "v99", "format": "stl"})
c.check("v99 無快照 → 匯出誠實錯誤", "沒有快照" in bad2, bad2[:120])

# ── 7. /api/export-parts:拆件匯出(單件/多件 zip/整機零件包)+負案例 ──
# 單件 → 直接 .step 檔
p1 = json.loads(post("/api/export-parts", {"sessionId": sid, "ver": "v1", "format": "step", "occs": ["o1.7"]}))
c.check("拆件單件 ok", p1.get("ok") is True, str(p1)[:200])
p1_abs = os.path.join(REPO, p1.get("file", "").replace("/", os.sep))
c.check("單件輸出是 .step 且非空",
        p1.get("file", "").endswith(".step") and os.path.exists(p1_abs) and os.path.getsize(p1_abs) > 500,
        p1.get("file", ""))
c.check("單件 parts 帶 label", len(p1.get("parts") or []) == 1 and bool(p1["parts"][0].get("label")), str(p1.get("parts")))

# 多件 → zip,開驗 entries 數與非空
p2 = json.loads(post("/api/export-parts", {"sessionId": sid, "ver": "v1", "format": "stl", "occs": ["o1.7", "o1.10"]}))
c.check("拆件多件 ok", p2.get("ok") is True, str(p2)[:200])
p2_abs = os.path.join(REPO, p2.get("file", "").replace("/", os.sep))
zip_ok = p2.get("file", "").endswith(".zip") and os.path.exists(p2_abs)
c.check("多件輸出是 zip", zip_ok, p2.get("file", ""))
if zip_ok:
    with zipfile.ZipFile(p2_abs) as zf:
        infos = zf.infolist()
    c.check("zip 內 2 個非空 entry", len(infos) == 2 and all(i.file_size > 500 for i in infos),
            str([(i.filename, i.file_size) for i in infos]))
st4, hd4, body4 = get_with_headers(
    "/api/asset?file=" + urllib.parse.quote(p2.get("file", ""), safe="") + "&download=parts.zip"
)
disp4 = hd4.get("Content-Disposition") or hd4.get("content-disposition") or ""
c.check("zip 可經 asset 下載(attachment)", st4 == 200 and len(body4) > 1000 and "attachment" in disp4,
        f"status={st4} disp={disp4}")

# 整機零件包(occs 省略)→ zip,entry 數 = 零件數(stage 15 件)
p3 = json.loads(post("/api/export-parts", {"sessionId": sid, "ver": "v1", "format": "step"}))
c.check("整機零件包 ok", p3.get("ok") is True, str(p3)[:200])
p3_abs = os.path.join(REPO, p3.get("file", "").replace("/", os.sep))
if p3.get("ok") and os.path.exists(p3_abs):
    with zipfile.ZipFile(p3_abs) as zf:
        n_entries = len(zf.infolist())
    c.check("零件包 entry 數 = parts 數且 >2", n_entries == len(p3.get("parts") or []) and n_entries > 2,
            f"entries={n_entries} parts={len(p3.get('parts') or [])}")

# 負案例:occ 格式亂給 400、不存在的 occ 誠實錯誤、format 白名單
b1 = post("/api/export-parts", {"sessionId": sid, "ver": "v1", "format": "step", "occs": ["../etc"]})
c.check("occ 格式亂給 → 擋下", "格式不對" in b1, b1[:120])
b2 = json.loads(post("/api/export-parts", {"sessionId": sid, "ver": "v1", "format": "step", "occs": ["o9.9"]}))
c.check("不存在的 occ → 誠實錯誤", b2.get("ok") is False and "沒有" in (b2.get("error") or ""), str(b2)[:160])
b3 = post("/api/export-parts", {"sessionId": sid, "ver": "v1", "format": "exe", "occs": ["o1.1"]})
c.check("拆件 format 白名單擋 exe", "僅支援" in b3, b3[:120])

# ── handoff 給 smoke_restore.py ──
hand = {
    "sessionId": sid,
    "name": name,
    "v1": v1,
    "v2": v2,
    "present2": rj.get("present"),
    "params": rj.get("params") or [],
}
json.dump(hand, open(out_path("versions_session.json"), "w", encoding="utf-8"))

c.finish()
