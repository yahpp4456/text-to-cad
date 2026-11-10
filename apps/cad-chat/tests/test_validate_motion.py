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


class ClosedChainProfileIntegration(unittest.TestCase):
    """profile 掃掠語意(需 build123d/OCP):滑塊-曲柄(缸推擺臂)閉鏈——擺臂銷
    繞支點轉、連桿一端跟滑塊平移一端套在擺臂銷上。從動件對擺角是非線性關係:

    - 帶 profile(閉式解取樣)→ 連桿孔全程套住擺臂銷,把 link×crank_pin 列入
      pairs 掃掠全程無穿透(= 鉸點閉合被真的驗到);
    - 線性 couple(無 profile)→ 兩端點閉合但行程中段銷心偏出孔隙,掃掠必抓;
    - 連桿只跟滑塊平移(審查 F7 的實際產物寫法)→ 行程末端銷脫開,掃掠必抓。
    """

    R, L, TH, N = 35.0, 120.0, 30.0, 32  # 擺臂半徑 / 桿長 / 擺角(度) / profile 段數

    @classmethod
    def setUpClass(cls):
        from build123d import Axis, Box, Cylinder, Pos

        from cadpy.assembly import label_shape

        R, L = cls.R, cls.L

        def ycyl(x, z, r, length):
            return Pos(x, 0, z) * Cylinder(r, length).rotate(Axis.X, 90)

        # 擺臂銷:home 在支點正下方 R;連桿:中心線 z=-R,兩端孔比銷大 0.4(單邊 0.2)
        pin = ycyl(0.0, -R, 4.0, 20.0)
        slider_pin = ycyl(-L, -R, 4.0, 20.0)
        bar = Pos(-L / 2, 0, -R) * Box(L + 16.0, 6.0, 16.0)
        bar -= ycyl(0.0, -R, 4.2, 10.0)
        bar -= ycyl(-L, -R, 4.2, 10.0)
        for shape, name in ((pin, "crank_pin"), (slider_pin, "slider_pin"), (bar, "link")):
            label_shape(shape, name)
        cls.named = [("crank_pin", pin), ("slider_pin", slider_pin), ("link", bar)]

    def _closed_form(self):
        import math

        R, L = self.R, self.L

        def at(deg):
            t = math.radians(deg)
            dz = R * (1.0 - math.cos(t))
            return R * math.sin(t) + L - math.sqrt(L * L - dz * dz), math.degrees(math.asin(dz / L))

        s_end, phi_end = at(self.TH)
        knots = [at(self.TH * i / self.N) for i in range(self.N + 1)]
        return s_end, phi_end, [k[0] / s_end for k in knots], [k[1] / phi_end for k in knots]

    def _motion(self, *, profile=True, swing=True):
        s_end, phi_end, s_prof, phi_prof = self._closed_form()
        pairs = [["link", "crank_pin"]]
        dofs = [{"id": "theta", "type": "revolute", "axis": [0, -1, 0], "pivot": [0, 0, 0],
                 "angle_deg": self.TH, "moving": ["crank_pin"], "pairs": pairs, "samples": 16}]
        if swing:  # 內層:連桿繞滑塊銷(home 位置)擺;宣告在承載它的 linear 之前
            dofs.append({"id": "link_swing", "type": "revolute", "axis": [0, -1, 0],
                         "pivot": [-self.L, 0, -self.R], "angle_deg": phi_end,
                         "moving": ["link"], "pairs": pairs, "couple": "theta", "samples": 16,
                         **({"profile": phi_prof} if profile else {})})
        dofs.append({"id": "slide", "axis": [1, 0, 0], "travel": s_end,
                     "moving": ["slider_pin", "link"], "pairs": pairs, "couple": "theta",
                     "samples": 16, **({"profile": s_prof} if profile else {})})
        m, errs = validate._read_motion(SimpleNamespace(MOTION={"dofs": dofs}), self.named)
        self.assertEqual(errs, [])
        return m

    def test_profile_keeps_joint_closed(self):
        check = validate._run_motion_sweep(self.named, self._motion())
        self.assertTrue(check["ok"], check)
        self.assertFalse(check.get("skipped"))
        self.assertIn("耦合群 theta+link_swing+slide", check["note"])

    def test_linear_couple_opens_joint_mid_stroke(self):
        check = validate._run_motion_sweep(self.named, self._motion(profile=False))
        self.assertFalse(check["ok"], check)
        self.assertIn("link~crank_pin", check["note"])

    def test_translate_only_link_opens_joint(self):
        check = validate._run_motion_sweep(self.named, self._motion(profile=False, swing=False))
        self.assertFalse(check["ok"], check)
        self.assertIn("link~crank_pin", check["note"])


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


TILT = REPO / "models" / "cylinder_tilt_platform" / "cylinder_tilt_platform.py"


@unittest.skipUnless(TILT.exists(), "cylinder_tilt_platform fixture 不存在")
class CylinderTiltReferenceIntegration(unittest.TestCase):
    """閉鏈連桿參考模型(design prompt 指名「先 Read」的那份)端到端:profile 宣告
    經 validate.py 全掃掠——鉸點(連桿×兩支銷)與兩個叉槽都列在 pairs 裡仍全程無穿透。
    這顆紅了 = 參考模型教 agent 的寫法本身驗不過,prompt 指引同步失效。"""

    @classmethod
    def setUpClass(cls):
        env = {**os.environ, "PYTHONUTF8": "1"}
        r = subprocess.run(
            [sys.executable, str(CAD_DIR / "validate.py"), str(TILT)],
            capture_output=True, text=True, timeout=180, env=env,
        )
        cls.out = json.loads(r.stdout.strip().splitlines()[-1])

    def test_full_validation_clean_with_joint_pairs(self):
        self.assertTrue(self.out["ok"], self.out)
        sweep = next(c for c in self.out["checks"] if c["id"] == "motion_sweep")
        self.assertTrue(sweep["ok"], sweep)
        self.assertFalse(sweep.get("skipped"))
        self.assertIn("耦合群 theta+link_swing+rod", sweep["note"])
        self.assertIn("7 對", sweep["note"])

    def test_playback_carries_profiles_on_coupled_dofs(self):
        dofs = {d["id"]: d for d in self.out["motion"]["dofs"]}
        self.assertNotIn("profile", dofs["theta"])
        for did in ("link_swing", "rod"):
            prof = dofs[did]["profile"]
            self.assertEqual(len(prof), 33)
            self.assertEqual((prof[0], prof[-1]), (0.0, 1.0))
        # 非線性的證據:中點位移比偏離 0.5(連桿擺角 ∝ 1−cosθ,中點約 0.25)
        self.assertLess(dofs["link_swing"]["profile"][16], 0.3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
