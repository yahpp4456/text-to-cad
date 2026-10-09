#!/usr/bin/env python
"""validate.py 載入產生器時,同目錄的零件模組(派工模式 <asm>_<part>.py)必須 import 得到。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_validate_sibling_import.py

背景:cadpy 的 build 路徑在 exec_module 期間把產生器目錄放進 sys.path(同目錄 import 成立),
但 validate.py 的 _load_gen_step 原本沒有 → 精算/匯出閘/open-project/revert 對 import 同目錄
模組的組合件一律 ModuleNotFoundError。本測試在 tmp 目錄放 asm.py(頂層 import asm_part)
跑 validate.py --motion-only,斷 exit 0 + JSON ok(需 build123d/OCP,整合級)。
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
VALIDATE = REPO / "apps" / "cad-chat" / "src" / "server" / "cad" / "validate.py"
PYTHON = REPO / ".venv" / "Scripts" / "python.exe"
if not PYTHON.exists():
    PYTHON = Path(sys.executable)

PART_SRC = '''from build123d import Box

PARAMS = {"size": 10.0}


def make(P=None):
    """Return {label: Shape} in the LOCAL frame (origin at cube center)."""
    P = {**PARAMS, **(P or {})}
    return {"cube": Box(P["size"], P["size"], P["size"])}


INTENDED_CONTACT = []


def gen_step():
    from cadpy.assembly import AssemblyHelper
    asm = AssemblyHelper("asm_part")
    for label, shape in make().items():
        asm.add(shape, label)
    return asm.build()
'''

ASM_SRC = '''from asm_part import make as part_make  # sibling module, top-level import

PARAMS = {"gap": 20.0}
INTENDED_CONTACT = []


def gen_step():
    from cadpy.assembly import AssemblyHelper
    asm = AssemblyHelper("asm")
    for label, shape in part_make().items():
        asm.add(shape, label)
    for label, shape in part_make({"size": 4.0}).items():
        asm.add(shape.translate((PARAMS["gap"], 0, 0)), label + "_b")
    return asm.build()
'''


class SiblingImportTests(unittest.TestCase):
    def test_validate_loads_sibling_part_module(self):
        with tempfile.TemporaryDirectory(prefix="cadchat-sibling-") as d:
            (Path(d) / "asm_part.py").write_text(PART_SRC, encoding="utf-8")
            (Path(d) / "asm.py").write_text(ASM_SRC, encoding="utf-8")
            env = dict(os.environ, PYTHONUTF8="1", PYTHON_COLORS="0")
            r = subprocess.run(
                [str(PYTHON), str(VALIDATE), str(Path(d) / "asm.py"), "--motion-only"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                env=env, timeout=240,
            )
            self.assertEqual(r.returncode, 0, f"validate.py 失敗:\n{r.stderr[-1500:]}")
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertIn("checks", out)
            self.assertTrue(out.get("ok"), out)
            # 兩顆方塊都被收成 parts(label 唯一)
            parts = out.get("parts") or []
            self.assertIn("cube", parts)
            self.assertIn("cube_b", parts)


if __name__ == "__main__":
    unittest.main(verbosity=2)
