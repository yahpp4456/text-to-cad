#!/usr/bin/env python
"""拆件匯出:從組合件 STEP 按 occurrence id 抽出零件,各自另存 STEP/STL。

用法: python export_parts.py <step路徑> <out_base(無副檔名)> <format: step|stl> [occ1 occ2 ...]
- occs 給定 → 匯出那幾個 occurrence(葉=單 shape;GROUP=子樹 Compound,保留層級)。
- occs 省略 → 整機零件包(root 的每個直接子件一檔;子組合件=一個 compound 檔)。
- 1 個目標 → <out_base>.<fmt> 單檔;≥2 → <out_base>.zip(內含 <label>.<fmt> 各檔)。
- 形狀帶世界定位(多件重新匯入時相對位置不變)。
- stdout 印單行 JSON:{ok, file, parts:[{occ,label,entry}]} 或 {ok:false, error}。
"""
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

OCC_RE = re.compile(r"^o\d+(\.\d+)*$")


def _fail(msg: str) -> int:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    return 0


def _safe_name(raw: str) -> str:
    out = re.sub(r"[^A-Za-z0-9._-]", "_", raw.strip())[:80].strip("._")
    return out or "part"


def main() -> int:
    if len(sys.argv) < 4:
        return _fail("用法: export_parts.py <step> <out_base> <format> [occ...]")
    step_path = Path(sys.argv[1])
    out_base = Path(sys.argv[2])
    fmt = sys.argv[3].lower()
    occs = sys.argv[4:]
    if fmt not in ("step", "stl"):
        return _fail(f"format 僅支援 step / stl(收到 {fmt})")
    if not step_path.is_file():
        return _fail(f"找不到 STEP:{step_path}")
    for occ in occs:
        if not OCC_RE.match(occ):
            return _fail(f"occurrence id 格式不對:{occ}")

    import build123d
    from build123d import export_step, export_stl

    from cadpy.step_scene import (
        load_step_scene_cached,
        occurrence_selector_id,
        scene_occurrence_shape,
    )

    scene = load_step_scene_cached(step_path)

    def node_label(node) -> str:
        return str(
            getattr(node, "name", None)
            or getattr(node, "source_name", None)
            or occurrence_selector_id(node)
        ).strip()

    # 目標 occurrence → build123d 形狀(葉=Shape、GROUP=Compound 保留層級;世界定位)
    def build_node(node):
        children = list(getattr(node, "children", []) or [])
        if children:
            return build123d.Compound(
                children=[build_node(c) for c in children],
                label=node_label(node),
            )
        shape = build123d.Shape(obj=scene_occurrence_shape(scene, node))
        shape.label = node_label(node)
        return shape

    def find_node(target_id):
        stack = list(scene.roots)
        while stack:
            node = stack.pop()
            if occurrence_selector_id(node) == target_id:
                return node
            stack.extend(getattr(node, "children", []) or [])
        return None

    if occs:
        targets = []
        for occ in occs:
            node = find_node(occ)
            if node is None:
                return _fail(f"組合件裡沒有 {occ} 這個零件(可能是舊版模型的 id)")
            targets.append(node)
    else:
        # 整機零件包:root 的直接子件;root 本身是葉(單件模型)就退回 root
        targets = [c for r in scene.roots for c in (getattr(r, "children", None) or [])]
        if not targets:
            targets = list(scene.roots)
    if not targets:
        return _fail("STEP 裡沒有可匯出的零件")

    def write_shape(node, path: Path) -> None:
        shape = build_node(node)
        ok = export_step(shape, str(path)) if fmt == "step" else export_stl(shape, str(path))
        if not ok or not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"{node_label(node)} 匯出失敗")

    out_base.parent.mkdir(parents=True, exist_ok=True)
    parts = []
    try:
        if len(targets) == 1:
            out = out_base.with_suffix(f".{fmt}")
            write_shape(targets[0], out)
            parts.append({
                "occ": occurrence_selector_id(targets[0]),
                "label": node_label(targets[0]),
                "entry": out.name,
            })
        else:
            out = out_base.with_suffix(".zip")
            tmp = Path(tempfile.mkdtemp(dir=out_base.parent))
            try:
                used = {}
                entries = []
                for node in targets:
                    base = _safe_name(node_label(node))
                    used[base] = used.get(base, 0) + 1
                    name = f"{base}_{used[base]}.{fmt}" if used[base] > 1 else f"{base}.{fmt}"
                    fp = tmp / name
                    write_shape(node, fp)
                    entries.append((fp, name))
                    parts.append({
                        "occ": occurrence_selector_id(node),
                        "label": node_label(node),
                        "entry": name,
                    })
                with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
                    for fp, name in entries:
                        zf.write(fp, name)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"{type(exc).__name__}: {exc}")

    print(json.dumps({"ok": True, "file": str(out), "parts": parts}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
