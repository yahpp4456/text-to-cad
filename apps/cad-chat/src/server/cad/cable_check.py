"""無塵電纜規格表單的即時檢核 CLI(cad-chat 的 /api/cable/check spawn 這支)。

用法:cable_check.py '<json>'   或   cable_check.py --stdin
輸入 {"spec": {...CABLE_SPEC...}, "params": {...}};輸出到 stdout:
    {"ok": true, "issues": [...], "derived": {...}}

為什麼是獨立 CLI 而不是 import 產生器:產生器頂部 `from build123d import *`
冷啟 ~16 秒,表單邊打字邊檢核不可能等它;`cadpy.parts.cable_spec` 是
OCP-free(stdlib only),import ~0.08 秒。閉式與護欄訊息因此與 build 時的
`_check_params` **同一份實作**,不會出現「表單綠、build 紅」。
"""

from __future__ import annotations

import json
import sys

from cadpy.parts.cable_spec import derive, issues


def main() -> int:
    args = sys.argv[1:]
    raw = sys.stdin.read() if (not args or args[0] == "--stdin") else args[0]
    try:
        body = json.loads(raw)
        spec = body["spec"]
        params = body["params"]
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "error": f"bad input: {exc}"}, sys.stdout)
        return 2
    try:
        found = issues(params, spec)
        d = derive(params, spec)
    except Exception as exc:  # noqa: BLE001
        # 缺鍵/型別錯之類:回 ok:false 讓前端顯示原因,不要 traceback 到 UI
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        return 1
    json.dump(
        {
            "ok": True,
            "issues": found,
            # 派生數字只回表單顯示得到的那幾項(整份 layers 給欄位提示用)
            "derived": {
                "height": round(d["height"], 4),
                "envelopeLength": round(d["l_bb"], 4),
                "tipOffset": round(d["tip_offset"], 4),
                "moduleHeights": [round(h, 4) for h in d["module_hs"]],
                "layers": [
                    {
                        "key": ly["key"],
                        "level": ly["level"],
                        "bendR": round(ly["r"], 4),
                        "straightA": round(ly["straight_a"], 4),
                        "straightB": round(ly["straight_b"], 4),
                    }
                    for ly in d["layers"]
                ],
            },
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
