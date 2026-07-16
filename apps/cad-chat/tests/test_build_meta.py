#!/usr/bin/env python
"""build 收割 sidecar(`.{name}.step.meta.json`)端到端整合測。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_build_meta.py

驗「build 順帶輸出 MOTION+parts」鏈路:scripts/step 子程序 build 複製的
flip_gripper 產生器 → sidecar 落地、內容正確、與 validate.py --motion-only 的
motion 逐位一致(單一真相源不漂移)、build 失敗不殘留 stale sidecar。
需 build123d;工作目錄用 models/.cadchat/(gitignored)。
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FLIP = REPO / "models" / "flip_gripper" / "flip_gripper.py"
STEP_CLI = REPO / "skills" / "cad" / "scripts" / "step"
VALIDATE = REPO / "apps" / "cad-chat" / "src" / "server" / "cad" / "validate.py"
WORKDIR = REPO / "models" / ".cadchat" / f"_test_build_meta_{os.getpid()}"


def _spawn(*argv):
    env = {**os.environ, "PYTHONUTF8": "1"}
    return subprocess.run(
        [sys.executable, *map(str, argv)],
        capture_output=True, text=True, timeout=300, env=env, cwd=str(REPO),
    )


@unittest.skipUnless(FLIP.exists(), "flip_gripper fixture 不存在")
class BuildMetaSidecarE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        WORKDIR.mkdir(parents=True, exist_ok=True)
        cls.gen = WORKDIR / "bm.py"
        shutil.copyfile(FLIP, cls.gen)
        cls.sidecar = WORKDIR / ".bm.step.meta.json"
        r = _spawn(STEP_CLI, cls.gen, "--force")
        assert r.returncode == 0, f"build 失敗:\n{r.stdout}\n{r.stderr}"
        cls.meta = json.loads(cls.sidecar.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(WORKDIR, ignore_errors=True)

    def test_sidecar_content(self):
        self.assertEqual(self.meta["schemaVersion"], 1)
        self.assertEqual(self.meta["partCount"], len(self.meta["parts"]))
        self.assertGreaterEqual(self.meta["partCount"], 7)
        self.assertEqual(self.meta["motionErrs"], [])
        dofs = {d["id"]: d for d in self.meta["motion"]["dofs"]}
        self.assertEqual(dofs["flip"]["type"], "revolute")
        self.assertEqual(dofs["flip"]["angle_deg"], 90.0)
        # 播放子集不外洩掃掠欄位
        self.assertNotIn("pairs", dofs["flip"])
        # 無 SWEEP_PATHS/SWEEP_VIEW 宣告的 generator:overlay 與工作窗都不誤亮
        self.assertEqual(self.meta["sweepPaths"], [])
        self.assertIsNone(self.meta["sweepView"])

    def test_sidecar_matches_validate_motion_only(self):
        """sidecar 與 validate.py --motion-only 同源(cadpy.motion_decl)不漂移。"""
        r = _spawn(VALIDATE, self.gen, "--motion-only")
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(out["motion"], self.meta["motion"])
        self.assertEqual(out["parts"], self.meta["parts"])
        self.assertEqual(out["partCount"], self.meta["partCount"])

    def test_failed_build_leaves_no_stale_sidecar(self):
        """gen_step 執行期炸掉 → 舊 sidecar 已被 unlink(anti-stale 的 Python 層)。

        注入的失敗必須是「執行期」raise:覆寫的 gen_step 仍要有單一 return
        (cadpy metadata 的 AST 閘要求 gen_step() must return one value,在
        _run_script_generator_inner 之前跑;在那層失敗 unlink 不會執行——該情境
        由 node 側 name 綁定 + 只在 build 成功後讀 sidecar 雙保險涵蓋)。
        """
        bad = WORKDIR / "bad.py"
        bad.write_text(
            FLIP.read_text(encoding="utf-8")
            + "\n_ORIG_GEN_STEP = gen_step\n"
            + "def gen_step():\n"
            + "    raise RuntimeError('boom')\n"
            + "    return _ORIG_GEN_STEP()\n",
            encoding="utf-8",
        )
        bad_sidecar = WORKDIR / ".bad.step.meta.json"
        # 先種一個假的舊 sidecar,驗證失敗 build 會把它清掉而不是留著誤導
        bad_sidecar.write_text('{"schemaVersion": 1, "parts": ["stale"]}', encoding="utf-8")
        r = _spawn(STEP_CLI, bad, "--force")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(bad_sidecar.exists(), "失敗 build 不得殘留 stale sidecar")


if __name__ == "__main__":
    unittest.main(verbosity=2)
