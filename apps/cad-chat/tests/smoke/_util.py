# -*- coding: utf-8 -*-
"""cad-chat 煙測共用件:base URL、檢查器、HTTP/SSE helper、輸出目錄(.out/,gitignored)。
前置:dev server 跑在 8788(CADCHAT_BASE 可覆蓋)、models/motorized_linear_stage 與
models/xyz_pickplace_gantry 為實體檔(git lfs checkout)。跑法見 apps/cad-chat/README.md。"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("CADCHAT_BASE", "http://127.0.0.1:8788")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".out")
os.makedirs(OUT, exist_ok=True)
# apps/cad-chat/tests/smoke → repo 根
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def out_path(name):
    return os.path.join(OUT, name)


class Checker:
    def __init__(self):
        self.passed = []
        self.failed = []

    def check(self, name, cond, detail=""):
        (self.passed if cond else self.failed).append(name)
        print(("  ✓ " if cond else "  ✗ ") + name + (f"  ({detail})" if detail else ""))

    def finish(self):
        print(f"\n== {len(self.passed)} passed, {len(self.failed)} failed ==")
        if self.failed:
            print("FAILED:", *self.failed, sep="\n  - ")
            sys.exit(1)


def glb_page_url(rel_glb, name):
    """?glb= 開發預覽捷徑(免 LLM 直開模型頁)。rel_glb 相對 models/。"""
    glb = "/api/asset?file=" + urllib.parse.quote(rel_glb, safe="")
    return BASE + "/?glb=" + urllib.parse.quote(glb, safe="") + f"&name={name}"


def post(path, body, timeout=360):
    """POST JSON,回 body 文字;4xx/5xx 也讀 body(負案例斷言用)。"""
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.read().decode("utf-8", "replace")


def get_with_headers(path, timeout=60):
    """GET,回 (status, headers dict, body bytes);4xx 也回。"""
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def sse_events(raw):
    """把 SSE 全文切成 [(event, data), ...]。"""
    out = []
    for frame in raw.split("\n\n"):
        ev, data = "message", []
        for line in frame.split("\n"):
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if data:
            try:
                out.append((ev, json.loads("\n".join(data))))
            except Exception:
                pass
    return out


def server_alive():
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False
