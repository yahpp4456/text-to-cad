# -*- coding: utf-8 -*-
"""穩定名稱(藍圖 C1)在真的範例模型上的閘:

1. **留存率**:改一個參數重建,原本有名稱的面至少 90% 還找得到同一個名稱(藍圖訂的門檻)。
2. **對得上點選**:sidecar 裡第 k 個名稱,就是使用者在畫面上點到的 `#o….fk` 那個面
   (GLB 內嵌拓撲的面序號 == 零件形狀的面序號;用面的包絡箱核對)。
3. **真 build 的 sidecar 帶得出來**:走正式的建置入口,不是直接呼叫命名函式。

直跑:PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_stable_names.py
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PY = sys.executable
WORKDIR = REPO / "models" / ".cadchat" / "tmp_smoke_stable_names"

SURVIVAL_GATE = 0.90
# (範例模型, 要改的參數, 改成原值的幾倍)
CASES = [
    ("linear_stage", "travel", 1.1),
    ("cylinder_tilt_platform", "theta_max", 1.1),
    ("steering_box_rack_pinion", "module", 1.1),   # 齒形整個重算,面序號大搬風
    ("sheet_control_box", "box_w", 1.1),
    ("flip_gripper", "flange_d", 1.1),
]


def _names_for(model: str, overrides: dict | None = None):
    from cadpy.generation import _load_generator_module
    from cadpy.geometry_checks import _as_named_parts
    from cadpy.kernel import naming

    naming.ensure_installed()
    with naming.recording() as records:
        module = _load_generator_module(REPO / "models" / model / f"{model}.py")
        if overrides:
            module.PARAMS.update(overrides)
        named = list(_as_named_parts(module.gen_step()))
        return module, named, naming.name_parts(named, records, budget_s=None)


class SurvivalGate(unittest.TestCase):
    def test_names_survive_a_parameter_change(self):
        for model, key, factor in CASES:
            with self.subTest(model=model, param=key):
                module, _named, before = _names_for(model)
                self.assertIsNotNone(before, "這個範例應該算得出名稱")
                value = module.PARAMS[key]
                _m, _n, after = _names_for(model, {key: type(value)(value * factor)})
                self.assertIsNotNone(after)
                total = kept = 0
                for part, table in before["parts"].items():
                    later = set(after["parts"].get(part, {}).get("f", []))
                    mine = [name for name in table["f"] if name]
                    total += len(mine)
                    kept += sum(1 for name in mine if name in later)
                self.assertGreater(total, 0)
                self.assertGreaterEqual(kept / total, SURVIVAL_GATE, f"{model}: {kept}/{total}")

    def test_every_face_of_the_examples_has_a_unique_name_and_a_line(self):
        for model in ("linear_stage", "cylinder_tilt_platform", "flip_gripper"):
            with self.subTest(model=model):
                _module, _named, names = _names_for(model)
                faces = [name for table in names["parts"].values() for name in table["f"]]
                made = [entry for table in names["lines"].values() for entry in table["f"]]
                self.assertTrue(all(faces), f"{sum(1 for x in faces if not x)} 個面沒有唯一名稱")
                self.assertTrue(all(made), f"{sum(1 for x in made if not x)} 個面沒有建立行號")


def _glb_tables(glb: Path):
    """GLB 內嵌拓撲 → (索引 JSON, selector JSON)。"""
    data = glb.read_bytes()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len])
    start = 20 + json_len + 8
    ext = gltf["extensions"]["STEP_topology"]

    def view(index):
        bv = gltf["bufferViews"][index]
        at = start + bv.get("byteOffset", 0)
        return json.loads(data[at:at + bv["byteLength"]])

    return view(ext["indexView"]), view(ext["selectorView"])


class PickedFaceMatchesItsName(unittest.TestCase):
    """真 build:sidecar 的名稱表與畫面上可點的面,序號一一對應。"""

    @classmethod
    def setUpClass(cls):
        shutil.rmtree(WORKDIR, ignore_errors=True)
        WORKDIR.mkdir(parents=True)
        src = REPO / "models" / "flip_gripper" / "flip_gripper.py"
        shutil.copyfile(src, WORKDIR / "flip_gripper.py")
        env = {**os.environ, "PYTHONUTF8": "1"}
        rel = WORKDIR.relative_to(REPO).as_posix()
        run = subprocess.run([PY, "skills/cad/scripts/step", f"{rel}/flip_gripper.py"],
                             cwd=REPO, env=env, capture_output=True, text=True, encoding="utf-8")
        if run.returncode != 0:
            raise RuntimeError(run.stderr[-800:])
        cls.meta = json.loads((WORKDIR / ".flip_gripper.step.meta.json").read_text(encoding="utf-8"))
        cls.index, cls.selectors = _glb_tables(WORKDIR / ".flip_gripper.step.glb")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(WORKDIR, ignore_errors=True)

    def test_sidecar_carries_names_for_every_part(self):
        names = self.meta["names"]
        self.assertEqual(names["schemaVersion"], 1)
        self.assertEqual(sorted(names["parts"]), sorted(self.meta["parts"]))
        self.assertEqual(names["files"], ["flip_gripper.py"])
        for part, table in names["parts"].items():
            self.assertEqual(len(table["f"]), len(names["lines"][part]["f"]))
            self.assertTrue(all(table["f"]), part)

    def test_face_counts_match_the_topology_the_viewer_picks_from(self):
        cols = self.index["tables"]["occurrenceColumns"]
        name_at, count_at = cols.index("name"), cols.index("faceCount")
        counted = {row[name_at]: row[count_at] for row in self.index["occurrences"]}
        for part, table in self.meta["names"]["parts"].items():
            self.assertEqual(counted.get(part), len(table["f"]), part)

    def test_the_kth_name_is_the_kth_pickable_face(self):
        """用面的包絡箱核對:sidecar 第 k 個名稱對到的形狀面,與拓撲裡該零件的第 k 個面是同一個。"""
        from cadpy.generation import _load_generator_module
        from cadpy.geometry_checks import _as_named_parts

        module = _load_generator_module(WORKDIR / "flip_gripper.py")
        shapes = dict(_as_named_parts(module.gen_step()))
        cols = self.index["tables"]["occurrenceColumns"]
        occ = {row[cols.index("name")]: row for row in self.index["occurrences"]}
        face_cols = self.selectors["tables"]["faceColumns"]
        bbox_at = face_cols.index("bbox")
        checked = 0
        for part, shape in shapes.items():
            start = occ[part][cols.index("faceStart")]
            for k, face in enumerate(shape.faces()):
                row = self.selectors["faces"][start + k]
                box = face.bounding_box()
                mine = [box.min.X, box.min.Y, box.min.Z, box.max.X, box.max.Y, box.max.Z]
                theirs = [*row[bbox_at]["min"], *row[bbox_at]["max"]]
                for a, b in zip(mine, theirs):
                    self.assertAlmostEqual(a, b, delta=0.05, msg=f"{part} 第 {k + 1} 個面")
                checked += 1
        self.assertGreater(checked, 40)


if __name__ == "__main__":
    unittest.main(verbosity=2)
