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

    def test_sidecar_summary(self):
        """每個零件的量測摘要(建置差異摘要的資料來源):與 parts 逐一對應,全部量得到。"""
        summary = self.meta["summary"]
        self.assertEqual(summary["partCount"], self.meta["partCount"])
        self.assertEqual([p["name"] for p in summary["parts"]], self.meta["parts"])
        self.assertEqual([p for p in summary["parts"] if "error" in p], [])
        for part in summary["parts"]:
            self.assertRegex(part["key"], r"^[0-9a-f]{12}$")
            self.assertGreater(part["volume"], 0)
            lo, hi = part["bbox"]
            self.assertTrue(all(a < b for a, b in zip(lo, hi)), part)
        lo, hi = summary["bbox"]
        self.assertTrue(all(lo[k] <= p["bbox"][0][k] and hi[k] >= p["bbox"][1][k]
                            for p in summary["parts"] for k in range(3)))

    def test_sidecar_made_by(self):
        """每個零件是產生器哪一行建的(點選參照時告訴 agent 該改哪裡):對得上零件表、行號落在產生器檔內。"""
        made = self.meta["madeBy"]
        self.assertTrue(made, "這個範例用 label_shape 標零件,應該收得到建立位置")
        self.assertLessEqual(set(made), set(self.meta["parts"]))
        for name, site in made.items():
            self.assertTrue(site["file"].endswith(".py"), (name, site))
            self.assertGreater(site["line"], 0)
            self.assertNotIn("cadpy", site["file"])

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



SHEET_WITH_ADVISORIES = '''from cadpy.parts import SheetMetal

PARAMS = {"t": 2.0}


def _build():
    sm = SheetMetal(thickness=PARAMS["t"], bend_radius=1.0, label="bracket")   # 內半徑 0.5t:做得出來,但有建議
    base = sm.base_rect(80.0, 40.0)
    base.hole(20.0, 20.0, d=5.0)
    base.hole(27.0, 20.0, d=5.0)                                               # 兩孔邊到邊 2 mm < 2t
    base.flange("x+", length=30.0, label="leg")
    return sm


def gen_step():
    return _build().folded()
'''


class SheetAdvisoriesE2E(unittest.TestCase):
    """鈑金可製造性建議(藍圖 F1):build 時寫進 sidecar;完整驗證多一列,不擋。"""

    @classmethod
    def setUpClass(cls):
        cls.dir = WORKDIR.with_name(WORKDIR.name + "_sheet")
        cls.dir.mkdir(parents=True, exist_ok=True)
        cls.gen = cls.dir / "sb.py"
        cls.gen.write_text(SHEET_WITH_ADVISORIES, encoding="utf-8")
        r = _spawn(STEP_CLI, cls.gen, "--force")
        assert r.returncode == 0, f"build 失敗:\n{r.stdout}\n{r.stderr}"
        cls.meta = json.loads((cls.dir / ".sb.step.meta.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_sidecar_lists_the_advisories_as_warning_findings(self):
        found = self.meta["advisories"]
        self.assertEqual(sorted(f["rule"] for f in found), ["sheet.bend_radius", "sheet.hole_spacing"])
        for f in found:
            self.assertEqual(f["status"], "warning")
            self.assertTrue(f["message"] and f["refs"])

    def test_full_validation_adds_an_advisory_row_that_does_not_fail(self):
        r = _spawn(VALIDATE, self.gen)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        row = {c["id"]: c for c in out["checks"]}["sheet_dfm"]
        self.assertEqual((row["status"], row["ok"], bool(row.get("skipped"))), ("advisory", True, False))
        self.assertEqual(row["note"], "2 項建議")
        self.assertEqual(row["findings"], self.meta["advisories"])   # 與 build sidecar 同一份資料
        self.assertIs(out["ok"], True)
        self.assertIs(out["complete"], True)

    def test_a_part_without_advisories_has_no_such_row(self):
        clean = self.dir / "clean.py"
        clean.write_text(SHEET_WITH_ADVISORIES.replace("bend_radius=1.0", "bend_radius=2.0").replace("27.0, 20.0", "40.0, 20.0"),
                         encoding="utf-8")
        out = json.loads(_spawn(VALIDATE, clean).stdout.strip().splitlines()[-1])
        self.assertNotIn("sheet_dfm", [c["id"] for c in out["checks"]])


MACHINED_WITH_ADVISORIES = '''
from build123d import Box, Compound, Cylinder, Pos
from cadpy.assembly import label_shape

MACHINED = ["plate"]


def gen_step():
    plate = Box(80, 60, 30) - Pos(0, 0, 5) * Box(40, 30, 20)          # 封閉口袋,四個直立尖角
    cover = Pos(0, 0, 40) * (Box(80, 60, 10) - Pos(0, 0, 0) * Box(40, 30, 10))   # 同樣有尖角,但沒宣告是切削件
    return Compound(children=[label_shape(plate, "plate"), label_shape(cover, "cover")])
'''


class MachinedAdvisoriesE2E(unittest.TestCase):
    """切削可製造性建議(藍圖 F3):產生器宣告 MACHINED 的零件才量;build 寫進 sidecar,完整驗證多一列,不擋。"""

    @classmethod
    def setUpClass(cls):
        cls.dir = WORKDIR.with_name(WORKDIR.name + "_cnc")
        cls.dir.mkdir(parents=True, exist_ok=True)
        cls.gen = cls.dir / "mp.py"
        cls.gen.write_text(MACHINED_WITH_ADVISORIES, encoding="utf-8")
        r = _spawn(STEP_CLI, cls.gen, "--force")
        assert r.returncode == 0, f"build 失敗:\n{r.stdout}\n{r.stderr}"
        cls.meta = json.loads((cls.dir / ".mp.step.meta.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_only_the_declared_part_is_measured(self):
        found = self.meta["advisories"]
        self.assertEqual([(f["rule"], f["status"], f["refs"]) for f in found],
                         [("cnc.sharp_internal_corner", "warning", ["plate"])])
        self.assertEqual(found[0]["value"], 4)

    def test_full_validation_row_is_titled_for_machining_and_does_not_fail(self):
        out = json.loads(_spawn(VALIDATE, self.gen).stdout.strip().splitlines()[-1])
        row = {c["id"]: c for c in out["checks"]}["sheet_dfm"]
        self.assertEqual((row["label"], row["status"], row["ok"]), ("切削可製造性(建議)", "advisory", True))
        self.assertEqual(row["findings"], self.meta["advisories"])
        self.assertIs(out["ok"], True)

    def test_an_assembly_whose_root_has_no_label_builds(self):
        """根沒有 label 的組合件(這個範例就是)以前在讀回模型樹時原生當掉、沒有任何訊息。"""
        self.assertEqual(self.meta["parts"], ["plate", "cover"])
        self.assertTrue((self.dir / "mp.step").stat().st_size > 1000)

    def test_without_the_declaration_nothing_is_reported(self):
        plain = self.dir / "plain.py"
        plain.write_text(MACHINED_WITH_ADVISORIES.replace('MACHINED = ["plate"]', ""), encoding="utf-8")
        r = _spawn(STEP_CLI, plain, "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        meta = json.loads((self.dir / ".plain.step.meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["advisories"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
