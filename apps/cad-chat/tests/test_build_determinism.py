#!/usr/bin/env python
"""建置可重現(藍圖 A8)的端到端整合測:同一個產生器用真正的建置指令在全新行程各建一次,
產出的 STEP 實體資料(DATA 區:每個面、邊、頂點的定義與順序)必須逐字相同。點選用的面號、邊號
就是照這個順序編的。檔頭有時間戳、GLB 裡記了每次的耗時統計,所以比的是 DATA 區,不是整個檔案。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_build_determinism.py

用的模型刻意走 build123d 裡「形狀集合去重」的路徑(多段線倒圓角、邊清單相交)。沒有
cadpy.kernel.determinism 時,這個模型 6 次建置量到 5 種不同的面/邊/頂點順序(2026-11-25,
build123d 0.13);幾何本身相同,但「第 12 號面」每次指到不同的面。
需 build123d;工作目錄用 models/.cadchat/(gitignored)。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
STEP_CLI = REPO / "skills" / "cad" / "scripts" / "step"
WORKDIR = REPO / "models" / ".cadchat" / f"_test_build_determinism_{os.getpid()}"

CASE = textwrap.dedent(
    '''
    from build123d import *

    PARAMS = {"radius": 2.5}


    def gen_step():
        pts = [(0, 0), (40, 0), (40, 25), (22, 25), (22, 12), (8, 12), (8, 30), (0, 30)]
        with BuildPart() as p:
            with BuildSketch():
                with BuildLine():
                    FilletPolyline(*pts, radius=PARAMS["radius"], close=True)
                make_face()
            extrude(amount=10)
            top = p.faces().sort_by(Axis.Z)[-1]
            fillet((p.edges() & top.edges())[:6], radius=0.8)
            with Locations((12, 5, 10), (30, 6, 10), (30, 18, 10)):
                Hole(radius=1.6)
        return p.part
    '''
)


def _build(tag, env_extra=None):
    """在同一個目錄建一次(路徑會寫進產物,所以每次都用同一個),回 (STEP DATA 區雜湊, GLB 位元組數, sidecar)。"""
    out = WORKDIR / "w"
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*dcase*"):
        stale.unlink()
    gen = out / "dcase.py"
    gen.write_text(CASE, encoding="utf-8")
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONHASHSEED": "random", **(env_extra or {})}
    r = subprocess.run(
        [sys.executable, str(STEP_CLI), str(gen), "--force"],
        capture_output=True, text=True, timeout=300, env=env, cwd=str(REPO),
    )
    assert r.returncode == 0, f"build 失敗:\n{r.stdout[-400:]}\n{r.stderr[-1200:]}"
    glb = (out / ".dcase.step.glb").read_bytes()
    step = (out / "dcase.step").read_text(encoding="utf-8", errors="replace")
    assert "DATA;" in step, "STEP 沒有 DATA 區"
    body = step[step.index("DATA;"):]
    meta = json.loads((out / ".dcase.step.meta.json").read_text(encoding="utf-8"))
    return hashlib.sha1(body.encode("utf-8")).hexdigest(), len(glb), meta


class BuildDeterminismE2E(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(WORKDIR, ignore_errors=True)

    def test_three_cold_builds_write_the_same_step_entities(self):
        first = _build("a")
        second = _build("b")
        third = _build("c")
        self.assertEqual(first[1], second[1])
        self.assertEqual({first[0], second[0], third[0]}, {first[0]}, "三次冷建置的 STEP 實體資料應逐字相同")
        # 量測摘要(幾何鍵)本來就與順序無關:當作「幾何沒變」的對照
        self.assertEqual(first[2]["summary"]["parts"][0]["key"], third[2]["summary"]["parts"][0]["key"])

    def test_switched_off_the_geometry_is_still_the_same(self):
        """關掉只影響順序,不影響做出來的形狀(所以它是安全的開關,不是另一種建法)。"""
        on = _build("on")
        off = _build("off", {"CADPY_DETERMINISM": "0"})
        self.assertEqual(on[2]["summary"]["parts"][0]["key"], off[2]["summary"]["parts"][0]["key"])
        self.assertEqual(on[2]["summary"]["bbox"], off[2]["summary"]["bbox"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
