# -*- coding: utf-8 -*-
"""AI 回覆文字系統煙測(燒真 LLM 回合;CADCHAT_SMOKE_LLM=1 才跑)。

契約(2026-10-13):body.locale=zh-Hans + 使用者打簡中 → agent 面向使用者的文字是簡體;
locale 缺席/zh-Hant + 繁中 → 仍繁體(回歸)。判定法:用 opencc-js twp→cn 把 AI 文字轉一次,
轉前後相同 = 已是簡體;另以常見繁體專用字(的/這/個/設/產/檔/體)抽樣確認繁體路徑。
前置:dev server 8788、agent 認證就緒、node 可 import opencc-js(apps/cad-chat 已裝)。
"""
import json
import os
import subprocess

from _util import BASE, Checker, post, server_alive, sse_events

C = Checker()
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", ".."))


def to_hans(text):
    """以 apps/cad-chat 的 opencc-js 轉一次(與前端同字典、同術語表)。"""
    script = (
        "import('./src/lib/zhConvert.js').then(async m => { await m.loadConverter();"
        " let s=''; process.stdin.on('data', d => s += d).on('end', () => process.stdout.write(m.convertText(s))); });"
    )
    r = subprocess.run(["node", "-e", script], cwd=APP, input=text.encode("utf-8"), capture_output=True, timeout=60)
    return r.stdout.decode("utf-8")


def ai_text(raw):
    out = []
    for ev, data in sse_events(raw):
        if ev == "ai" and isinstance(data, dict) and data.get("text"):
            out.append(str(data["text"]))
        elif ev == "text" and isinstance(data, dict) and data.get("delta"):
            out.append(str(data["delta"]))
    return "".join(out)


TRAD_ONLY = "的這個設產檔體圖請參數"  # 粗略:這些在簡體裡多半會變(這→这、設→设、產→产、檔→档、體→体、圖→图、請→请、參數→参数)


def main():
    if os.environ.get("CADCHAT_SMOKE_LLM") != "1":
        print("[skip] CADCHAT_SMOKE_LLM!=1(本煙測燒真 LLM 回合)")
        return
    if not server_alive():
        print("[skip] server 8788 不可達")
        return

    # A. 簡中使用者 + locale=zh-Hans → 回簡中
    raw = post(
        "/api/chat",
        {
            "sessionId": "smoke_locale_hans",
            "mode": "design",
            "locale": "zh-Hans",
            "message": "做一个法兰:外径 100mm、内径 40mm、厚度 10mm、4 个 M8 孔。不要澄清,直接做完并简短说明。",
        },
    )
    text = ai_text(raw)
    C.check("A: 有 AI 文字", len(text) > 20, text[:80])
    if text:
        conv = to_hans(text)
        C.check("A: AI 文字已是簡體(twp→cn 轉換冪等)", conv == text, f"差異示例:{next((a+'→'+b for a,b in zip(text,conv) if a!=b), '')}")
        C.check("A: 無繁體專用字殘留(抽樣)", not any(ch in text for ch in "這設產檔體圖請"), [ch for ch in "這設產檔體圖請" if ch in text])

    # B. 繁中使用者 + 無 locale → 仍繁中(回歸)
    raw2 = post(
        "/api/chat",
        {
            "sessionId": "smoke_locale_hant",
            "mode": "design",
            "message": "做一個法蘭:外徑 100mm、內徑 40mm、厚度 10mm、4 個 M8 孔。不要澄清,直接做完並簡短說明。",
        },
    )
    text2 = ai_text(raw2)
    C.check("B: 有 AI 文字", len(text2) > 20, text2[:80])
    if text2:
        C.check("B: 繁體路徑仍是繁體(含繁體專用字)", any(ch in text2 for ch in TRAD_ONLY) and to_hans(text2) != text2, text2[:80])

    C.finish()


if __name__ == "__main__":
    main()
