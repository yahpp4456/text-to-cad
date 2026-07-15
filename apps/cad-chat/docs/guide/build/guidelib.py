# -*- coding: utf-8 -*-
"""手冊擷取共用常數與 helper(capture.py 與 shots.py 都 import,避免循環)。"""
import json
import os
import shutil
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
GUIDE = os.path.dirname(HERE)                       # apps/cad-chat/docs/guide
IMG = os.path.join(GUIDE, "img")
REPO = os.path.abspath(os.path.join(GUIDE, "..", "..", "..", ".."))  # repo 根
MODELS = os.path.join(REPO, "models")
BASE = os.environ.get("CADCHAT_BASE", "http://127.0.0.1:8788")
VIEWPORT = {"width": 1480, "height": 920}

os.makedirs(IMG, exist_ok=True)


def asset_url(rel_under_models):
    """把 models/ 內相對路徑(可含或不含 models/ 前綴)包成 /api/asset URL。"""
    return "/api/asset?file=" + urllib.parse.quote(rel_under_models, safe="")


def glb_page_url(rel_glb, name, motion=None):
    """?glb= 開發預覽捷徑(免 LLM 直開模型頁)。rel_glb 相對 models/。"""
    glb = asset_url(rel_glb)
    url = BASE + "/?glb=" + urllib.parse.quote(glb, safe="") + "&name=" + urllib.parse.quote(name, safe="")
    if motion is not None:
        url += "&motion=" + urllib.parse.quote(json.dumps(motion, ensure_ascii=False), safe="")
    return url


def seed_file(src_abs, dst_rel_under_models):
    """把 fixture 複製到 models/<dst_rel>(讓 /api/asset 撈得到);回傳 asset URL。"""
    dst = os.path.join(MODELS, *dst_rel_under_models.split("/"))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src_abs, dst)
    return asset_url("models/" + dst_rel_under_models if not dst_rel_under_models.startswith("models/") else dst_rel_under_models)


def health():
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=4) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None
