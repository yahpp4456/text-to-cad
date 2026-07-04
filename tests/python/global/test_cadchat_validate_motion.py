"""cad-chat validate.py 的 MOTION 運動掃掠 harness 測試(無 LLM)。

四案:clear / 中途穿透 / 無 MOTION 迴歸 / 壞宣告。每案把小型產生器寫進 tmp,
以子程序跑 apps/cad-chat/src/server/cad/validate.py,斷言 stdout JSON。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from tests.python.support.paths import REPO_ROOT
from tests.python.support.tmp_root import temporary_directory

VALIDATE = REPO_ROOT / "apps" / "cad-chat" / "src" / "server" / "cad" / "validate.py"

# rail:x[0,100] z[0,5];carriage:x[0,10] z[5.5,10.5](淨空 0.5,沿 +X 行程 40)
_RAIL_CARRIAGE = """\
from build123d import Box

from cadpy.assembly import AssemblyHelper

PARAMS = {{"stroke": 40.0}}

MOTION = {{
    "schemaVersion": 1,
    "dofs": [
        {{"id": "x", "label": "X 行程", "type": "linear", "axis": [1, 0, 0],
          "travel": PARAMS["stroke"], "moving": ["carriage"],
          "pairs": {pairs}, "samples": 8}},
    ],
}}


def gen_step():
    asm = AssemblyHelper("slide")
    asm.add(Box(100, 10, 5).translate((50, 0, 2.5)), "rail")
    asm.add(Box(10, 10, 5).translate((5, 0, 8.0)), "carriage")
    {extra}
    return asm.build()
"""

_STATIC_SINGLE = """\
from build123d import Box

PARAMS = {"size": 20.0}


def gen_step():
    return Box(PARAMS["size"], PARAMS["size"], 6.0)
"""

_BAD_MOTION = """\
from build123d import Box

from cadpy.assembly import AssemblyHelper

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "x", "type": "linear", "axis": [1, 0, 0], "travel": 40.0,
         "moving": ["ghost"]},
    ],
}


def gen_step():
    asm = AssemblyHelper("bad")
    asm.add(Box(100, 10, 5).translate((50, 0, 2.5)), "rail")
    asm.add(Box(10, 10, 5).translate((5, 0, 8.0)), "carriage")
    return asm.build()
"""


def _run_validate(tmp: Path, name: str, source: str) -> dict:
    gen = tmp / f"{name}.py"
    gen.write_text(source, encoding="utf-8")
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    proc = subprocess.run(
        [sys.executable, str(VALIDATE), str(gen)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=str(REPO_ROOT),
        timeout=300,
    )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise AssertionError(f"validate.py 無輸出;stderr: {proc.stderr[-800:]}")
    return json.loads(lines[-1])


def _check(out: dict, check_id: str) -> dict:
    for c in out["checks"]:
        if c["id"] == check_id:
            return c
    raise AssertionError(f"缺 {check_id} 檢查: {out}")


class CadChatValidateMotionTests(unittest.TestCase):
    maxDiff = None

    def test_clear_sweep_passes_and_reports_stats(self):
        with temporary_directory(prefix="cadchat-motion-clear-") as tmp:
            out = _run_validate(
                Path(tmp), "slide_clear",
                _RAIL_CARRIAGE.format(pairs='[["carriage", "rail"]]', extra=""),
            )
        ms = _check(out, "motion_sweep")
        self.assertTrue(ms["ok"], ms)
        self.assertFalse(ms.get("skipped", False), ms)
        self.assertIn("全程無穿透", ms["note"])
        self.assertIn("1 DOF", ms["note"])
        self.assertIn("幀", ms["note"])
        # 前端播放宣告:travel 已解析為 float(引用 PARAMS 的值)
        self.assertIn("motion", out)
        dof = out["motion"]["dofs"][0]
        self.assertEqual(dof["id"], "x")
        self.assertEqual(dof["travel"], 40.0)
        self.assertEqual(dof["moving"], ["carriage"])
        self.assertTrue(out["ok"], out)

    def test_mid_travel_penetration_caught_though_endpoints_clear(self):
        # post 佔 x[20,25] 同高度帶:seated 與行程終點皆淨,中途必穿
        extra = 'asm.add(Box(5, 10, 5).translate((22.5, 0, 8.0)), "post")'
        with temporary_directory(prefix="cadchat-motion-hit-") as tmp:
            out = _run_validate(
                Path(tmp), "slide_hit",
                _RAIL_CARRIAGE.format(
                    pairs='[["carriage", "post"], ["carriage", "rail"]]', extra=extra,
                ),
            )
        # 靜態干涉必須乾淨(失敗只能來自運動掃掠)
        self.assertTrue(_check(out, "interference")["ok"], out)
        ms = _check(out, "motion_sweep")
        self.assertFalse(ms["ok"], ms)
        self.assertIn("carriage~post", ms["note"])
        self.assertIn("@u=", ms["note"])
        self.assertIn("mm³", ms["note"])
        self.assertFalse(out["ok"], out)

    def test_no_motion_still_skips_honestly(self):
        with temporary_directory(prefix="cadchat-motion-none-") as tmp:
            out = _run_validate(Path(tmp), "flange_like", _STATIC_SINGLE)
        ms = _check(out, "motion_sweep")
        self.assertTrue(ms["ok"], ms)
        self.assertTrue(ms.get("skipped"), ms)
        self.assertEqual(ms["note"], "未提供運動學")
        self.assertNotIn("motion", out)
        self.assertTrue(out["ok"], out)

    def test_bad_declaration_fails_with_reason(self):
        with temporary_directory(prefix="cadchat-motion-bad-") as tmp:
            out = _run_validate(Path(tmp), "bad_motion", _BAD_MOTION)
        ms = _check(out, "motion_sweep")
        self.assertFalse(ms["ok"], ms)
        self.assertIn("MOTION 宣告無效", ms["note"])
        self.assertIn("ghost", ms["note"])
        self.assertNotIn("motion", out)
        self.assertFalse(out["ok"], out)


if __name__ == "__main__":
    unittest.main()
