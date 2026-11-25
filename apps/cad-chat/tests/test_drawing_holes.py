#!/usr/bin/env python
"""工程圖的孔標註(drawing_pdf.py + cadpy.holes;藍圖 F5)整合測:真的出一張 PDF。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_drawing_holes.py

孔辨識本身的單元測在 tests/python/packages/cadpy/test_holes.py;這裡驗的是接到圖面之後:
哪些孔標在視圖上、哪些列在清單、沒有孔的零件不受影響。圖面長相另存 PNG 供人看
(``tests/smoke/.out/drawing_holes.png``)。
"""
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DRAW = REPO / "apps" / "cad-chat" / "src" / "server" / "cad" / "drawing_pdf.py"
WORKDIR = REPO / "models" / ".cadchat" / f"tmp_smoke_drawing_holes_{os.getpid()}"
OUT = REPO / "apps" / "cad-chat" / "tests" / "smoke" / ".out"


def _draw(step: Path, *extra):
    env = {**os.environ, "PYTHONUTF8": "1"}
    run = subprocess.run([sys.executable, str(DRAW), str(step), "--out", str(step.with_suffix(".pdf")), *map(str, extra)],
                         cwd=REPO, env=env, capture_output=True, text=True, encoding="utf-8", timeout=300)
    return run


def _holes_line(stdout: str):
    m = re.search(r"holes: (\d+) called out, (\d+) listed, (\d+) omitted", stdout)
    return tuple(int(x) for x in m.groups()) if m else None


class DrawingHoleCallouts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from build123d import Box, Cylinder, Pos, Rot, export_step

        shutil.rmtree(WORKDIR, ignore_errors=True)
        WORKDIR.mkdir(parents=True)
        OUT.mkdir(parents=True, exist_ok=True)
        plate = Box(100, 60, 12)
        for x, y in ((-40, -20), (40, -20), (-40, 20), (40, 20)):
            plate -= Pos(x, y, 0) * Cylinder(3.3, 12)                 # 4× ⌀6.6 THRU → 俯視
        plate -= Pos(0, 0, 2) * Cylinder(2.5, 8)                      # ⌀5 ↧8,開口在上 → 俯視
        plate -= Pos(20, 0, 0) * Cylinder(3.3, 12)
        plate -= Pos(20, 0, 6 - 3.25) * Cylinder(5.5, 6.5)            # 沉頭在上 → 俯視
        plate -= Pos(-20, 0, 0) * Rot(90, 0, 0) * Cylinder(2, 60)     # 沿 Y 的通孔 → 前視
        plate -= Pos(-32, 12, -4) * Cylinder(2, 4)                    # 開口在底面的盲孔 → 三個視圖都看不到孔口
        cls.plate = WORKDIR / "plate.step"
        export_step(plate, str(cls.plate))
        cls.plain = WORKDIR / "plain.step"
        export_step(Box(40, 30, 10), str(cls.plain))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(WORKDIR, ignore_errors=True)

    def test_holes_are_called_out_on_the_view_that_faces_them(self):
        run = _draw(self.plate, "--png", OUT / "drawing_holes.png")
        self.assertEqual(run.returncode, 0, run.stderr[-600:])
        self.assertGreater(self.plate.with_suffix(".pdf").stat().st_size, 2000)
        # 俯視三則(通孔陣列、盲孔、沉頭孔)+ 前視一則(橫向通孔);底面盲孔列在清單
        self.assertEqual(_holes_line(run.stdout), (4, 1, 0), run.stdout)
        self.assertGreater((OUT / "drawing_holes.png").stat().st_size, 5000)

    def test_fallback_projection_gets_the_same_callouts(self):
        run = _draw(self.plate, "--force-poly")
        self.assertEqual(run.returncode, 0, run.stderr[-600:])
        self.assertEqual(_holes_line(run.stdout), (4, 1, 0), run.stdout)

    def test_a_part_without_holes_draws_as_before(self):
        run = _draw(self.plain)
        self.assertEqual(run.returncode, 0, run.stderr[-600:])
        self.assertIsNone(_holes_line(run.stdout))
        self.assertIn("wrote", run.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
