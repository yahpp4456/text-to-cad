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
# apps/cad-chat/tests/smoke → repo 根。煙測用 REPO 做的都是「可寫資料」磁碟斷言/seed
# (models/.cadchat/… 產物、models/ 下臨時 fixture):打包模擬(Phase 0 出口閘)下
# server 的可寫資料根被 CADCHAT_DATA_ROOT 指走,煙測跟著同一個 env 對位;未設(dev)
# = repo 根,行為與舊版完全一致。
REPO = os.environ.get("CADCHAT_DATA_ROOT") or os.path.abspath(
    os.path.join(HERE, "..", "..", "..", "..")
)


def out_path(name):
    return os.path.join(OUT, name)


def evidence_shot(page, name, timeout=15000):
    """存證用的截圖(不是斷言):寫到 .out/<name>。截不到只印一行警告。

    無頭瀏覽器對 WebGL 畫布截圖偶爾會卡到逾時(與產品無關);以前這會讓一支斷言全過的煙測整支紅。
    需要「看圖判讀」的地方(capture_review_views)不走這裡——那種截圖拿不到就該失敗。
    """
    try:
        page.screenshot(path=out_path(name), timeout=timeout)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"  [warn] 存證截圖 {name} 沒拍到({type(exc).__name__});不影響斷言")
        return False


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


FOLLOW_UP = "尺寸與條件照我給的,其餘你決定。不要再提問,現在直接做完到呈現。"


class ChatRun:
    """chat_until_version 的結果:events = 各輪事件依序串接;last = 最後一輪的事件。"""

    def __init__(self, sid, events, last, turns):
        self.sid, self.events, self.last, self.turns = sid, events, last, turns

    @property
    def versions(self):
        return [d for e, d in self.events if e == "version"]

    @property
    def kinds(self):
        return sorted({e for e, _ in self.events})

    def ai_text(self, last_only=False):
        return "\n".join(d.get("text", "") for e, d in (self.last if last_only else self.events) if e == "ai")


def chat_until_version(message, *, session_id=None, follow=FOLLOW_UP, max_turns=3, timeout=900):
    """送一輪建模訊息;模型若先提問(該輪沒有 version 事件)就在同一對話回答後續跑。

    題目都已寫明「不要澄清」,但有的 provider(Codex)仍會先問一次。這不是這些煙測要驗的事,
    所以回答一次讓它繼續,最多 max_turns 輪;仍沒走到呈現就照實回傳(versions 為空,由呼叫端斷)。
    """
    sid, events, last, turns = session_id, [], [], 0
    text = message
    for _ in range(max_turns):
        body = {"message": text}
        if sid:
            body["sessionId"] = sid
        last = sse_events(post("/api/chat", body, timeout=timeout))
        turns += 1
        events.extend(last)
        sid = next((d.get("sessionId") for e, d in last if e == "session"), sid)
        if any(e == "version" for e, _ in last):
            break
        text = follow
    return ChatRun(sid, events, last, turns)


REVIEW_VIEWS = (("home", "iso"), ("yNeg", "front"), ("z", "top"), ("x", "right"))


def capture_review_views(page, prefix, motion_period_s=None, views=REVIEW_VIEWS, settle_ms=200, ghost=()):
    """L4 看圖固定機位協定:對已載入模型的頁面拍一組固定機位截圖,回傳檔案路徑清單。

    機位(依序):等角整體(home)→ 前視 → 上視 → 右視;若 motion_period_s 給定且
    __cadMotion 對得到 record,再補「行程起點 / 行程終點」兩張(home 機位,applyAt(0) 與
    applyAt(T/2),三角波 u=0/1);ghost=(label,…) 在拍行程兩張前把這些件(外殼)轉半透明、
    拍完還原——運動件藏在殼內時沒這步兩張一模一樣。檔名 <prefix>_review_<n>_<view>.png,寫 .out/。
    純截圖、不斷言(截圖給人/AI 最後目視,不是驗證)——呼叫端自行 c.check 檔案落地。
    視圖上的「解析規格」面板若展開會蓋住模型(真回合後常態),拍前收合、拍完還原。
    頁面沒有 __cadView(草模頁、空畫布)直接回 []。"""
    has_view = page.evaluate("() => !!(window.__cadView && window.__cadView.home)")
    if not has_view:
        return []
    paths = []
    spec_head = page.locator('.canvas-spec[data-open="true"] .canvas-spec-head')
    spec_was_open = spec_head.count() == 1
    if spec_was_open:
        spec_head.click()

    def shot(tag):
        p = out_path(f"{prefix}_review_{len(paths) + 1}_{tag}.png")
        page.wait_for_timeout(settle_ms)
        page.screenshot(path=p)
        paths.append(p)

    for preset_id, tag in views:
        if preset_id == "home":
            page.evaluate("() => window.__cadView.home()")
        else:
            page.evaluate("(id) => window.__cadView.focus(id)", preset_id)
        shot(tag)
    if motion_period_s:
        cov = page.evaluate("() => window.__cadMotion ? window.__cadMotion.coverage() : 0") or 0
        if cov > 0:
            page.evaluate("() => window.__cadView.home()")
            for label in ghost:
                page.evaluate("(l) => window.__cadVisual && window.__cadVisual.set(l, 'ghost')", label)
            half = max(1, min(20, float(motion_period_s))) / 2  # triangleU 的 T 夾 1..20
            for t, tag in ((0, "motion_start"), (half, "motion_end")):
                page.evaluate("(t) => window.__cadMotion.applyAt(t)", t)
                shot(tag)
            for label in ghost:
                page.evaluate("(l) => window.__cadVisual && window.__cadVisual.set(l, null)", label)
    if spec_was_open:
        page.locator(".canvas-spec .canvas-spec-head").click()
    for p in paths:
        print("  review view:", p)
    return paths


def server_alive():
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False
