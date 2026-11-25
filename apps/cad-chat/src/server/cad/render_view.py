#!/usr/bin/env python
"""apps/cad-chat 看圖 harness:把產生器的模型離屏畫成 PNG(藍圖 E1)。

import 產生器 .py -> gen_step() ->(可選)擺到某個具名姿態 -> cadchat_ext.render.render_views。

用法:  python render_view.py <generator.py> <out_dir> [--views iso,front] [--stem NAME] [--size 900x640]
                              [--hide a,b] [--ghost a,b] [--clip x:12.5] [--pose NAME] [--mode shaded|wire]
輸出:  stdout 最後一行是 JSON:
        {"ok": true, "views": [{"view","file","width","height"}], "legend": [{"part","color"}], "pose": NAME|null}
        失敗:{"ok": false, "error": "..."}(exit 1)
這支腳本開 OpenGL 環境;顯示卡驅動出問題時行程可能直接死掉,所以一律在獨立的一次性行程裡跑,
不進常駐 worker(與 drawing_pdf.py 同樣的理由)。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# cadchat_ext(cad-chat 專用的 Python 套件)在 apps/cad-chat/py;內嵌直譯器會忽略 PYTHONPATH,所以自己加
sys.path.insert(0, str(HERE.parents[2] / "py"))
sys.path.insert(0, str(HERE))


def _fail(message: str) -> int:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return 1


def _csv(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _posed(named, motion, pose_name):
    """把零件擺到具名姿態:每個 dof 用它在該姿態的位置,照宣告序依次施加(與驗證、前端播放同一個合成順序)。"""
    import validate
    from cadpy.motion_states import expand_state

    positions = expand_state(motion["states"][pose_name], motion["dofs"])
    shapes = dict(named)
    for dof in motion["dofs"]:
        u = positions.get(dof["id"], 0.0)
        if not u:
            continue
        for name in dof["moving"]:
            if name in shapes:
                shapes[name] = validate._dof_frame_shape(shapes[name], dof, u)
    return [(name, shapes[name]) for name, _ in named]


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("generator")
    parser.add_argument("out_dir")
    parser.add_argument("--views", default="iso")
    parser.add_argument("--stem", default="view")
    parser.add_argument("--size", default="900x640")
    parser.add_argument("--hide", default="")
    parser.add_argument("--ghost", default="")
    parser.add_argument("--clip", default="")
    parser.add_argument("--pose", default="")
    parser.add_argument("--mode", default="shaded")
    try:
        args = parser.parse_args()
    except SystemExit:
        return _fail("參數無效")

    try:
        import validate

        gen_step, module = validate._load_gen_step(Path(args.generator).resolve())
        payload = gen_step()
        from cadpy.geometry_checks import _as_named_parts

        named = list(_as_named_parts(payload))
    except Exception as exc:  # noqa: BLE001
        return _fail(f"產生器執行失敗: {type(exc).__name__}: {exc}")

    names = [name for name, _ in named]
    unknown = [n for n in _csv(args.hide) + _csv(args.ghost) if n not in names]
    if unknown:
        return _fail(f"hide / ghost 引用不存在的零件: {', '.join(unknown[:4])}(現有: {', '.join(names[:12])})")

    pose = args.pose.strip() or None
    if pose:
        motion, errors = validate._read_motion(module, named)
        if errors or motion is None:
            return _fail("這個模型沒有可用的運動宣告,不能指定姿態")
        if pose not in (motion.get("states") or {}):
            known = ", ".join(motion.get("states") or {}) or "(沒有宣告任何姿態)"
            return _fail(f"未知的姿態 {pose!r};已宣告的姿態: {known}")
        named = _posed(named, motion, pose)

    clip = None
    if args.clip:
        try:
            axis, at = args.clip.split(":", 1)
            clip = {"axis": axis.strip().lower(), "at": float(at)}
        except ValueError:
            return _fail(f"clip 無效: {args.clip!r}(格式 軸:座標,例 x:12.5)")
    try:
        width, height = (int(v) for v in args.size.lower().split("x", 1))
    except ValueError:
        return _fail(f"size 無效: {args.size!r}(格式 寬x高)")

    try:
        from cadchat_ext import render

        views = render.render_views(
            named, args.out_dir, views=_csv(args.views) or ["iso"], stem=args.stem, size=(width, height),
            hide=_csv(args.hide), ghost=_csv(args.ghost), clip=clip, mode=args.mode,
        )
        legend = [row for row in render.legend_for(names) if row["part"] not in set(_csv(args.hide))]
    except ValueError as exc:
        return _fail(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _fail(f"渲染失敗: {type(exc).__name__}: {exc}")

    print(json.dumps({
        "ok": True,
        "views": [{"view": v.view, "file": v.path, "width": v.width, "height": v.height} for v in views],
        "legend": legend,
        "pose": pose,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
