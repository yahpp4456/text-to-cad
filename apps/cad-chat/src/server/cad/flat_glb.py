#!/usr/bin/env python
"""鈑金攤平預覽 GLB:import 產生器、跑 gen_flat() 取攤平實體、mesh 成 topology GLB。

用法: python flat_glb.py <產生器.py 路徑> <輸出 .glb 路徑>
- 從 build123d shape 直接建 scene(不寫任何 STEP);GLB 帶 STEP_topology(selector
  bundle 由攤平實體現抽),讓攤平態也有面標記/物件樹/量測(2026-10-01 前是純預覽
  GLB,切攤平後這些全部消失)。抽拓撲失敗退回純預覽(前端優雅降級)。
- 產生器須有 def gen_flat()(獨立鈑金件才有;組合件無攤平)。
- stdout 印單行 JSON:{ok, file} 或 {ok:false, error}。

3D 視圖的「摺疊/攤平」即時切換靠此檔在 build 時預先產出的攤平 GLB;切換零重算。
"""
import importlib.util
import json
import os
import sys
from pathlib import Path, PurePosixPath

# 網格化參數對齊 cadpy metadata.DEFAULT_MESH_*(與摺疊 topology GLB 同精度)
_LINEAR_DEFLECTION = 0.02
_ANGULAR_DEFLECTION = 0.6


def _fail(msg: str) -> int:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    return 0


def main() -> int:
    if len(sys.argv) < 3:
        return _fail("用法: flat_glb.py <gen.py> <out.glb>")
    gen_path = Path(sys.argv[1])
    out_glb = Path(sys.argv[2])
    if not gen_path.is_file():
        return _fail(f"找不到產生器:{gen_path}")

    # 載入產生器模組(cwd=REPO_ROOT,cadpy 走 .venv editable;同 export_parts 慣例)
    spec = importlib.util.spec_from_file_location("_sheet_gen", str(gen_path))
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001
        return _fail(f"產生器載入失敗:{type(exc).__name__}: {exc}")
    if not hasattr(mod, "gen_flat"):
        return _fail("產生器沒有 gen_flat()(非獨立鈑金件,無攤平預覽)")

    from cadpy.parts import SheetMetal

    # 取 SheetMetal(鈑金產生器的 _build() 慣例)→ 一次 build 拿攤平實體 + 折彎線;
    # 拿不到(非慣例產生器)就退回 gen_flat() 只出 GLB、無折彎線(best-effort)。
    sm = None
    if hasattr(mod, "_build"):
        try:
            cand = mod._build()
            if isinstance(cand, SheetMetal):
                sm = cand
        except Exception:  # noqa: BLE001
            sm = None
    try:
        shape = sm.flat() if sm is not None else mod.gen_flat()
    except Exception as exc:  # noqa: BLE001
        return _fail(f"gen_flat() 執行失敗:{type(exc).__name__}: {exc}")

    from cadpy.glb import export_part_glb_from_scene
    from cadpy.selector_types import SelectorProfile
    from cadpy.source_hash import python_source_hash
    from cadpy.step_export import build_build123d_step_scene
    from cadpy.step_scene import (
        SelectorOptions,
        extract_selectors_from_scene,
        mesh_step_scene,
        scene_export_shape,
    )

    # GLB 路徑由「虛擬 STEP 檔名」決定(part_glb_path 取檔名);用輸出 GLB 反推同目錄同基名
    # 的虛擬 .step,讓 export_part_glb_from_scene 寫到我們要的 out_glb。
    # out_glb 形如 .<name>.flat.step.glb → 虛擬 step = <name>.flat.step(同目錄,不寫檔)。
    stem = out_glb.name
    if stem.startswith(".") and stem.endswith(".glb"):
        stem = stem[1:-4]  # 去前導 dot 與 .glb → <name>.flat.step
    virtual_step = out_glb.parent / stem
    try:
        # 標記 python 來源(selector 抽取的 STEP_topology manifest 要 sourcePath;
        # 與 cadpy.generation._mark_scene_python_backed 同義:相對虛擬 step 所在目錄)
        src_identity = python_source_hash(gen_path)
        scene = build_build123d_step_scene(
            shape, virtual_step, source_kind="python", source_hash=src_identity.source_hash
        )
        scene.source_path = PurePosixPath(
            os.path.relpath(gen_path.resolve(), virtual_step.parent.resolve()).replace("\\", "/")
        ).as_posix()
        mesh_step_scene(
            scene,
            linear_deflection=_LINEAR_DEFLECTION,
            angular_deflection=_ANGULAR_DEFLECTION,
            relative=False,
        )
        scene_export_shape(scene)
        # 攤平實體的 selector bundle(面/邊拓撲)→ 前端 loadRenderSelectorBundle 才有
        # 面標記、物件屬性樹、量測與圈選。失敗不擋 GLB(退回純預覽)。
        bundle = None
        try:
            bundle = extract_selectors_from_scene(
                scene,
                profile=SelectorProfile.ARTIFACT,
                options=SelectorOptions(
                    linear_deflection=_LINEAR_DEFLECTION,
                    angular_deflection=_ANGULAR_DEFLECTION,
                    relative=False,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[flat_glb] selector bundle 抽取失敗,退回純預覽 GLB:{type(exc).__name__}: {exc}", file=sys.stderr)
            bundle = None
        written = export_part_glb_from_scene(
            virtual_step,
            scene,
            linear_deflection=_LINEAR_DEFLECTION,
            angular_deflection=_ANGULAR_DEFLECTION,
            selector_bundle=bundle,
            include_selector_topology=bundle is not None,
        )
    except Exception as exc:  # noqa: BLE001
        return _fail(f"攤平 GLB 產生失敗:{type(exc).__name__}: {exc}")

    written = Path(written)
    if not written.is_file() or written.stat().st_size == 0:
        return _fail("攤平 GLB 未落地")

    # 折彎線 sidecar(有 SheetMetal 才寫):與攤平 GLB 同目錄同基名 .flat.lines.json,
    # 前端疊虛線 overlay 用({t=厚度,lines=[{a,b,up}]},2D flat 座標 + up/down)。
    lines_file = None
    if sm is not None:
        try:
            # .<name>.flat.step.glb → .<name>.flat.lines.json(與 pipeline 快照命名一致)
            nm = written.name
            base = nm[:-len(".step.glb")] if nm.endswith(".step.glb") else nm[:-4]
            lp = written.parent / (base + ".lines.json")
            with open(lp, "w", encoding="utf-8") as f:
                json.dump({"t": sm.thickness, "lines": sm.flat_bend_lines()}, f, ensure_ascii=False)
            lines_file = str(lp)
        except Exception:  # noqa: BLE001
            lines_file = None  # best-effort:折彎線失敗不擋攤平 GLB

    print(json.dumps({"ok": True, "file": str(written), "lines_file": lines_file, "topology": bundle is not None}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
