#!/usr/bin/env python
"""validate.py 的 revolute MOTION + --motion-only 單元/整合測(免瀏覽器)。

跑法(repo 根):
    PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_validate_motion.py

- 快測:直接 import validate._read_motion,驗 revolute schema 接受/拒絕 + linear 回歸。
- 整合:對 models/flip_gripper 跑 validate.py 全掃掠 vs --motion-only,驗
  「設計模式跳貴檢查但仍 emit revolute motion」端到端成立。整合段需 build123d。
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[3]
CAD_DIR = REPO / "apps" / "cad-chat" / "src" / "server" / "cad"
sys.path.insert(0, str(CAD_DIR))
import validate  # noqa: E402

NAMED = [(n, None) for n in ("a", "b", "body", "arm", "hub")]


def _read(motion):
    return validate._read_motion(SimpleNamespace(MOTION=motion), NAMED)


class ReadMotionRevolute(unittest.TestCase):
    def test_accepts_revolute(self):
        m, errs = _read({"dofs": [
            {"id": "flip", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, -31],
             "angle_deg": 90, "moving": ["arm", "hub"], "pairs": [["arm", "body"]]},
        ]})
        self.assertEqual(errs, [])
        d = m["dofs"][0]
        self.assertEqual(d["type"], "revolute")
        self.assertEqual(d["angle_deg"], 90.0)
        self.assertEqual(d["pivot"], [0.0, 0.0, -31.0])
        self.assertNotIn("travel", d)  # revolute 不帶 travel

    def test_rejects_missing_pivot(self):
        _, errs = _read({"dofs": [
            {"id": "f", "type": "revolute", "axis": [0, 1, 0], "angle_deg": 90,
             "moving": ["arm"], "pairs": [["arm", "body"]]},
        ]})
        self.assertTrue(errs)

    def test_rejects_missing_angle(self):
        _, errs = _read({"dofs": [
            {"id": "f", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, 0],
             "moving": ["arm"], "pairs": [["arm", "body"]]},
        ]})
        self.assertTrue(errs)

    def test_rejects_revolute_without_pairs(self):
        _, errs = _read({"dofs": [
            {"id": "f", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, 0],
             "angle_deg": 90, "moving": ["arm"]},  # 無 pairs → revolute 拒收
        ]})
        self.assertTrue(any("pairs" in e for e in errs), errs)

    def test_rejects_bad_angle(self):
        for ang in (0, 5000):
            _, errs = _read({"dofs": [
                {"id": "f", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, 0],
                 "angle_deg": ang, "moving": ["arm"], "pairs": [["arm", "body"]]},
            ]})
            self.assertTrue(errs, f"angle {ang} 應被拒")

    def test_linear_regression(self):
        m, errs = _read({"dofs": [
            {"id": "x", "type": "linear", "axis": [1, 0, 0], "travel": 8,
             "moving": ["arm"], "pairs": [["arm", "body"]]},
        ]})
        self.assertEqual(errs, [])
        self.assertEqual(m["dofs"][0]["type"], "linear")
        self.assertEqual(m["dofs"][0]["travel"], 8.0)

    def test_wrapper_delegates_to_motion_decl(self):
        """_read_motion 是 cadpy.motion_decl.normalize_motion 的薄 wrapper——
        兩者輸出全等(單一真相源防漂移;build sidecar 收割走同一份)。"""
        from cadpy.motion_decl import normalize_motion

        raw = {"dofs": [
            {"id": "flip", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, -31],
             "angle_deg": 90, "moving": ["arm", "hub"], "pairs": [["arm", "body"]]},
            {"id": "x", "axis": [1, 0, 0], "travel": 8, "moving": ["a"]},
        ]}
        self.assertEqual(
            _read(raw),
            normalize_motion(raw, [n for n, _ in NAMED]),
        )

    def test_accepts_couple_and_requires_pairs(self):
        """couple(嚙合耦合)經 wrapper 一樣成立:合法宣告透傳,缺 pairs 拒收。"""
        base = [
            {"id": "stroke", "axis": [0, 1, 0], "travel": -7.7,
             "moving": ["a"], "pairs": [["a", "body"]]},
            {"id": "swing", "type": "revolute", "axis": [0, 0, 1], "pivot": [0, 0, 0],
             "angle_deg": 90, "moving": ["hub"], "pairs": [["hub", "a"]],
             "couple": "stroke"},
        ]
        m, errs = _read({"dofs": base})
        self.assertEqual(errs, [])
        self.assertEqual(m["dofs"][1]["couple"], "stroke")
        bad = [dict(base[0], pairs=None), base[1]]
        _, errs = _read({"dofs": bad})
        self.assertTrue(any("必須明給 pairs" in e for e in errs), errs)


class CoupledSweepIntegration(unittest.TestCase):
    """couple 掃掠語意(需 build123d/OCP):齒輪齒條以正確齒比同步滾動 → 全程
    無穿透;齒比打滑(travel 縮 0.7 倍)→ 嚙合面必互咬,掃掠必抓。這是把
    「齒輪原子概念」鎖進驗證 harness 的那顆測試。"""

    @classmethod
    def setUpClass(cls):
        import math

        from cadpy.assembly import label_shape
        from cadpy.parts import gear, gear_rack, pitch_radius, rack_mesh_phase_deg

        cls.math = math
        m, z, w = 1.0, 12, 5.0
        rp = pitch_radius(m, z)
        g = gear(m, z, w, tooth_phase_deg=rack_mesh_phase_deg(m, z), label="pinion")
        r = gear_rack(m, 4, w, label="rack").translate((-rp, 0.0, 0.0))
        label_shape(r, "rack")
        cls.named = [("pinion", g), ("rack", r)]
        cls.rp, cls.angle = rp, 60.0

    def _motion(self, travel_scale=1.0):
        travel = -self.rp * self.math.radians(self.angle) * travel_scale
        m, errs = validate._read_motion(SimpleNamespace(MOTION={"dofs": [
            {"id": "stroke", "axis": [0, 1, 0], "travel": travel,
             "moving": ["rack"], "pairs": [["rack", "pinion"]], "samples": 8},
            {"id": "swing", "type": "revolute", "axis": [0, 0, 1], "pivot": [0, 0, 0],
             "angle_deg": self.angle, "moving": ["pinion"],
             "pairs": [["pinion", "rack"]], "couple": "stroke", "samples": 8},
        ]}), self.named)
        self.assertEqual(errs, [])
        return m

    def test_correct_ratio_rolls_clean(self):
        check = validate._run_motion_sweep(self.named, self._motion())
        self.assertTrue(check["ok"], check)
        self.assertFalse(check.get("skipped"))
        self.assertIn("耦合群 stroke+swing", check["note"])

    def test_slipping_ratio_is_caught(self):
        check = validate._run_motion_sweep(self.named, self._motion(travel_scale=0.7))
        self.assertFalse(check["ok"], check)
        self.assertIn("穿透", check["note"])


FLIP = REPO / "models" / "flip_gripper" / "flip_gripper.py"


def _run(*extra):
    env = {**os.environ, "PYTHONUTF8": "1"}
    r = subprocess.run(
        [sys.executable, str(CAD_DIR / "validate.py"), str(FLIP), *extra],
        capture_output=True, text=True, timeout=180, env=env,
    )
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(FLIP.exists(), "flip_gripper fixture 不存在")
class FlipGripperIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.full = _run()
        cls.mo = _run("--motion-only")

    @staticmethod
    def _by_id(out):
        return {c["id"]: c for c in out["checks"]}

    @staticmethod
    def _dofs(out):
        return {d["id"]: d for d in (out.get("motion") or {}).get("dofs", [])}

    def test_full_sweeps_revolute_clean(self):
        self.assertTrue(self.full["ok"], self.full)  # R1 已修 → 全綠
        ms = self._by_id(self.full)["motion_sweep"]
        self.assertFalse(ms.get("skipped"))  # full 真的掃
        self.assertEqual(self._dofs(self.full)["flip"]["type"], "revolute")
        self.assertEqual(self._dofs(self.full)["flip"]["angle_deg"], 90.0)

    def test_motion_only_skips_expensive_but_emits_motion(self):
        checks = self._by_id(self.mo)
        for cid in ("valid_solid", "interference", "motion_sweep"):
            self.assertTrue(checks[cid].get("skipped"), f"{cid} 設計模式應 skip")
        self.assertTrue(self.mo["ok"])  # 全 skip → ok
        self.assertEqual(self._dofs(self.mo)["flip"]["type"], "revolute")  # 仍 emit revolute

    def test_motion_only_matches_full_motion(self):
        self.assertEqual(
            [d["id"] for d in self.full["motion"]["dofs"]],
            [d["id"] for d in self.mo["motion"]["dofs"]],
        )
        self.assertEqual(self.full["partCount"], self.mo["partCount"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
