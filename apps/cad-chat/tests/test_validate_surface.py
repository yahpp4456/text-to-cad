#!/usr/bin/env python
"""validate.py 的產品設計(曲面)剖面整合測(免瀏覽器;需 build123d + node)。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_validate_surface.py

把 examples/mouse_shell.json 經 surfaceGen.mjs(node)編成產生器,對它跑 validate.py
--motion-only 與完整模式,釘:
- 曲面剖面八列 id 順序與標籤;
- --motion-only:有效幾何 skipped、開放邊/連續性仍出真值(「0 條開放邊」「G2 1 / G1 0 / G0 0 條,最低要求 G1」);
- 完整模式:有效幾何 BRepCheck valid;
- 文案與 pipeline.surfaceChecksFromMeta 逐字同源(pipeline.design.test.js 釘另一半)。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
APP = REPO / "apps" / "cad-chat"
VALIDATE = APP / "src" / "server" / "cad" / "validate.py"
EXAMPLE = APP / "src" / "lib" / "surface" / "examples" / "mouse_shell.json"
NODE = shutil.which("node")


def _compile_generator(dst: Path) -> None:
    script = (
        "import { compileSurfaceGenerator } from './src/server/cad/surfaceGen.mjs';"
        "import fs from 'node:fs';"
        f"const d = JSON.parse(fs.readFileSync({json.dumps(str(EXAMPLE))}, 'utf8'));"
        f"fs.writeFileSync({json.dumps(str(dst))}, compileSurfaceGenerator(d, {{ name: 'mouse' }}), 'utf8');"
    )
    subprocess.run([NODE, "--input-type=module", "-e", script], cwd=str(APP), check=True)


def _run_validate(py: Path, *flags: str) -> dict:
    env = {**os.environ, "PYTHONUTF8": "1"}
    r = subprocess.run(
        [sys.executable, str(VALIDATE), str(py), *flags],
        cwd=str(REPO), capture_output=True, text=True, encoding="utf-8", env=env, timeout=300,
    )
    lines = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
    assert lines, f"validate.py 無 JSON 輸出\nstdout={r.stdout[-800:]}\nstderr={r.stderr[-800:]}"
    return json.loads(lines[-1])


@unittest.skipUnless(NODE, "需要 node 編譯產生器")
class SurfaceProfileIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cadchat-validate-surface-"))
        cls.py = cls.tmp / "mouse.py"
        _compile_generator(cls.py)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_motion_only_profile(self):
        out = _run_validate(self.py, "--motion-only")
        self.assertTrue(out["ok"], out)
        ids = [c["id"] for c in out["checks"]]
        self.assertEqual(ids, ["valid_shape", "free_edges", "continuity", "self_intersection",
                               "interference", "motion_sweep", "wall_thickness"])
        by = {c["id"]: c for c in out["checks"]}
        self.assertEqual(by["valid_shape"]["label"], "有效幾何 (BRepCheck)")
        self.assertTrue(by["valid_shape"]["skipped"])
        self.assertEqual(by["valid_shape"]["note"], "設計模式:略過驗證(未驗證)")
        self.assertEqual(by["free_edges"]["label"], "開放邊 free-edges")
        self.assertNotIn("skipped", by["free_edges"])
        self.assertEqual(by["free_edges"]["note"], "0 條開放邊")
        self.assertEqual(by["continuity"]["label"], "邊連續性 continuity")
        self.assertTrue(by["continuity"]["ok"])
        self.assertEqual(by["continuity"]["note"], "G2 1 / G1 0 / G0 0 條,最低要求 G1")
        self.assertEqual(by["interference"]["note"], "單一零件,無需檢查")
        self.assertEqual(by["motion_sweep"]["note"], "未提供運動學")
        self.assertEqual(out["partCount"], 1)
        self.assertNotIn("motion", out)

    def test_full_profile(self):
        out = _run_validate(self.py)
        by = {c["id"]: c for c in out["checks"]}
        self.assertTrue(out["ok"], out)
        self.assertNotIn("skipped", by["valid_shape"])
        self.assertEqual(by["valid_shape"]["note"], "BRepCheck valid")
        self.assertEqual(by["free_edges"]["note"], "0 條開放邊")
        self.assertTrue(by["continuity"]["ok"])

    def test_violation_is_real_fail(self):
        # 把最低連續性拉到 G2 但移除對稱面切線 → 接縫摺線:成形閘先在 gen_step 擋(ValueError)
        src = self.py.read_text(encoding="utf-8").replace('"minContinuity": "G1"', '"minContinuity": "G2"')
        src = src.replace('"tangents": {\n    "end": [\n     -1,\n     0,\n     0\n    ]\n   }', '"tangents": {}')
        bad = self.tmp / "bad.py"
        bad.write_text(src, encoding="utf-8")
        env = {**os.environ, "PYTHONUTF8": "1"}
        r = subprocess.run([sys.executable, str(VALIDATE), str(bad), "--motion-only"], cwd=str(REPO),
                           capture_output=True, text=True, encoding="utf-8", env=env, timeout=300)
        out = json.loads([ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")][-1])
        self.assertFalse(out["ok"])
        self.assertIn("對稱接縫", out.get("error", ""))


if __name__ == "__main__":
    unittest.main()
