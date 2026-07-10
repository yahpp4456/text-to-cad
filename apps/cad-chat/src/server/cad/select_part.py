#!/usr/bin/env python
"""選用標準件(cadpy.parts.select_*),輸出 JSON。

用法: python select_part.py <family> <requirement-json>
family ∈ bearing|cylinder|stepper|linear_guide|ball_screw|gripper|gear
"""
import json
import sys

FN = {
    "bearing": "select_bearing",
    "cylinder": "select_cylinder",
    "stepper": "select_stepper",
    "linear_guide": "select_linear_guide",
    "ball_screw": "select_ball_screw",
    "gripper": "select_gripper",
    "gear": "select_gear",
}


def main() -> int:
    family = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        req = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    except Exception:
        req = {}
    from cadpy import parts

    name = FN.get(family)
    if not name:
        print(json.dumps({"ok": False, "reason": f"未知 family: {family}"}, ensure_ascii=False))
        return 0
    try:
        row = getattr(parts, name)(**req)
        print(json.dumps({"ok": True, "family": family, "row": row}, ensure_ascii=False, default=str))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps(
            {"ok": False, "reason": f"{type(exc).__name__}: {exc}"},
            ensure_ascii=False,
        ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
