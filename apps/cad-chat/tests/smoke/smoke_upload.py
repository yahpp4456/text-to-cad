# -*- coding: utf-8 -*-
"""圖片上傳煙測(免 LLM):/api/upload-image 位元組直傳(正/負案例+磁碟落地)
→ /api/asset 取回(content-type 表)→ Composer 附件 UI(chips/移除/純圖可送)
→ UserMsg 縮圖渲染與 404 破圖降級。"""
import base64
import json
import os
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

from _util import BASE, Checker, REPO, out_path

c = Checker()

# 1x1 透明 PNG(真 magic bytes)
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
# 最小 WEBP 外殼(RIFF@0 + WEBP@8;嗅探只看這兩處)
WEBP_MIN = b"RIFF" + (32).to_bytes(4, "little") + b"WEBP" + b"\x00" * 20


def post_bytes(path, data, ctype="image/png", timeout=30):
    """POST 原始位元組,回 (status, json dict)。4xx 也讀 body。"""
    req = urllib.request.Request(
        BASE + path, data=data, headers={"content-type": ctype}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, {}


def get_status_ctype(url_path):
    try:
        with urllib.request.urlopen(BASE + url_path, timeout=30) as r:
            return r.status, r.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        return e.code, ""


# ── A. API 正案例:PNG 上傳(無 sessionId → 順手建)→ asset 取回 → 磁碟落地 ──
st, j = post_bytes("/api/upload-image?name=motor%20drawing.png", PNG_1PX)
c.check("PNG 上傳 200 ok", st == 200 and j.get("ok") is True, str(j))
c.check("無 sessionId → server 回新 session", bool(j.get("sessionId")))
c.check("rel 有 uploads/ 前綴", str(j.get("rel", "")).startswith("uploads/"), j.get("rel", ""))
c.check("mediaType 由嗅探判定", j.get("mediaType") == "image/png")
sid = j.get("sessionId", "")
if j.get("url"):
    st2, ctype2 = get_status_ctype(j["url"])
    c.check("asset 取回 200 + image/png", st2 == 200 and "image/png" in ctype2, f"{st2} {ctype2}")
disk = os.path.join(REPO, "models", ".cadchat", sid, str(j.get("rel", "")).replace("/", os.sep))
c.check("磁碟落地(存在且 size>0)", os.path.isfile(disk) and os.path.getsize(disk) > 0, disk)
c.check("落地檔名已清洗(空白→_)", "motor_drawing" in os.path.basename(disk), os.path.basename(disk))

# 帶 sessionId 再傳 → 同 session
st, j2 = post_bytes(f"/api/upload-image?sessionId={sid}&name=b.png", PNG_1PX)
c.check("帶 sessionId 上傳 → 同 session", st == 200 and j2.get("sessionId") == sid)

# ── B. webp:嗅探 + asset content-type 新表 ──
st, jw = post_bytes(f"/api/upload-image?sessionId={sid}&name=x.webp", WEBP_MIN, ctype="application/octet-stream")
c.check("WEBP 嗅探判定", st == 200 and jw.get("mediaType") == "image/webp", str(jw))
if jw.get("url"):
    st3, ctype3 = get_status_ctype(jw["url"])
    c.check("asset .webp content-type", st3 == 200 and "image/webp" in ctype3, f"{st3} {ctype3}")

# ── C. 負案例 ──
st, jn = post_bytes(f"/api/upload-image?sessionId={sid}&name=fake.png", b"this is not an image bytes!!")
c.check("亂 bytes → 415", st == 415, str(st))
st, jn = post_bytes(f"/api/upload-image?sessionId={sid}", PNG_1PX, ctype="text/plain")
c.check("content-type text/plain → 415(防跨站簡單請求)", st == 415, str(st))
st, jn = post_bytes(f"/api/upload-image?sessionId={sid}&name=big.png", b"\x89PNG" + b"\x00" * 3_500_100)
c.check("超過 3.5MB → 413", st == 413, str(st))
# 惡意檔名:清洗後仍落在 uploads/ 內
st, je = post_bytes(f"/api/upload-image?sessionId={sid}&name=..%2F..%2Fevil.png", PNG_1PX)
c.check("惡意檔名清洗後仍成功且無路徑逃逸",
        st == 200 and je.get("rel", "").startswith("uploads/") and ".." not in je.get("rel", ""),
        je.get("rel", ""))
try:
    with urllib.request.urlopen(BASE + "/api/upload-image", timeout=10) as r:
        c.check("GET → 405", False, str(r.status))
except urllib.error.HTTPError as e:
    c.check("GET → 405", e.code == 405, str(e.code))

# ── D. UI:附件 chips / 移除 / 純圖可送 / UserMsg 縮圖與破圖降級 ──
png_file = out_path("upload_ui_1px.png")
with open(png_file, "wb") as f:
    f.write(PNG_1PX)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1480, "height": 920})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".canvas-empty", timeout=15000)

    c.check("附件鈕存在", page.locator(".composer-btn.attach").count() == 1)
    page.locator(".composer-file").set_input_files(png_file)
    page.wait_for_selector('.img-chip[data-status="ready"]', timeout=15000)
    chip = page.locator(".img-chip")
    c.check("選檔即上傳 → ready chip", chip.get_attribute("data-status") == "ready")
    nw = chip.locator("img").evaluate("el => el.naturalWidth")
    c.check("縮圖真的載入(server URL)", nw and nw > 0, str(nw))
    c.check("純圖無文字 → 送出鈕亮起",
            page.locator('.composer-btn.send[data-active="true"]').count() == 1)
    chip.locator(".pick-clear").click()
    page.wait_for_timeout(150)
    c.check("✕ 移除 → chip 消失", page.locator(".img-chip").count() == 0)
    c.check("移除後送出鈕熄滅",
            page.locator('.composer-btn.send[data-active="true"]').count() == 0)

    # UserMsg 縮圖渲染(注入 ADD_USER;一好一壞 URL 驗降級)
    page.evaluate(
        """() => window.__cadDispatch({ type: 'ADD_USER', text: '幫我畫馬達座',
             images: [ { url: '%s', name: 'ok.png' },
                       { url: '/api/asset?file=models%%2F.cadchat%%2Fnope%%2Fuploads%%2Fgone.png', name: 'gone.png' } ] })"""
        % j.get("url", "").replace("'", "")
    )
    page.wait_for_timeout(600)
    c.check("user 訊息縮圖渲染", page.locator(".user-img").count() == 2)
    c.check("404 縮圖 → broken 降級", page.locator(".user-img.broken").count() == 1)
    c.check("文字氣泡仍在", "馬達座" in page.locator(".user-bubble").last.inner_text())

    c.check("無 JS 頁面錯誤", not errors, "; ".join(errors[:3]))
    page.screenshot(path=out_path("smoke_upload.png"))
    browser.close()

c.finish()
