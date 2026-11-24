"""worker 與 Node 伺服器之間的 frame 協定:一行 JSON 物件,物件帶 ``bytes`` 時其後緊接
恰好那麼多個位元組。只用標準函式庫。

``read`` 會略過 frame 之前不是 JSON 物件的行(不以 ``{`` 開頭),所以子行程在協定通道
上印出的 banner 不會中斷對話。

移植自 earthtojake/text-to-cad(MIT License, Copyright (c) 2026 Thompson Labs LLC)
``packages/cad/src/cad/engine/frames.py`` @ 2738524be。Node 端的對應實作在
``apps/cad-chat/src/server/cad/frames.mjs``,兩邊格式必須一致。
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["exactly", "failed_type", "read", "write"]


def failed_type(error: BaseException) -> dict[str, str]:
    """``{"type": ...}``:失敗時隨訊息一併回報的例外型別。內建例外回名稱
    (``PermissionError``),其餘回 ``module.Name``。"""
    kind = type(error)
    return {"type": kind.__qualname__ if kind.__module__ == "builtins" else f"{kind.__module__}.{kind.__qualname__}"}


def read(stream: Any) -> tuple[dict[str, Any], bytes] | None:
    """``stream``(二進位串流)上的下一個 frame:物件與其後的位元組(沒有則 ``b""``)。
    串流結束回 None;在 frame 中途結束拋 ``EOFError``;以 ``{`` 開頭但不是 JSON 的行
    拋 ``json`` 的 ``ValueError``。"""
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if line.startswith(b"{"):
            break
    message = json.loads(line)
    size = int(message.get("bytes") or 0)
    return message, exactly(stream, size) if size else b""


def exactly(stream: Any, size: int) -> bytes:
    """從 ``stream`` 讀滿 ``size`` 個位元組(不論分幾次讀);提前結束拋 ``EOFError``。"""
    chunks = []
    while size:
        chunk = stream.read(size)
        if not chunk:
            raise EOFError("the stream ended inside a frame")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def write(stream: Any, message: dict[str, Any], payload: bytes = b"") -> None:
    """把 ``message`` 寫成 ``stream`` 上的一行;有 ``payload`` 時補上 ``bytes`` 並緊接寫出,
    最後 flush。多執行緒同寫時由呼叫端保證 frame 完整。"""
    if payload:
        message = {**message, "bytes": len(payload)}
    stream.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
    if payload:
        stream.write(payload)
    stream.flush()
