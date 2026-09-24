"""Closed-form tests for cadpy.parts.cable_spec (逐層定長 form; OCP-free).

This module is the single source of truth shared by the cable generators
(``models/cable_*_per_layer``) and by cad-chat's live spec check
(``/api/cable/check``) -- if it drifts, the form goes green while the build
goes red (or vice versa).  Locked here:

* the OEM equivalence goldens for BOTH customer parts (Cable X three-layer and
  Cable Y four-layer, incl. Y's riser module sitting in the 3rd slot);
* every guard with an input that must FAIL, and the reported floor/ceiling
  actually being usable (feed it back -> passes);
* the analytic adjacent-layer clearance (the polyline version under-estimated
  the bend-crown gap by ~(ds)^2/8r and rejected the customer's real Y spec).
"""

from __future__ import annotations

import math
import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.parts.cable_spec import (  # noqa: E402
    check,
    derive,
    issues,
    layer_key,
    module_heights,
    u_gap,
    window_centers,
)

# 兩個客戶件共用的量測常數(= 產生器的 _M 相關欄位)
M = {
    "ref_width": 118.2,
    "outer_h": 6.7,
    "wall_t": 1.0,
    "module_h": 11.5,
    "rack_depth": 32.4,
    "layer_clear": 0.3,
}

SPEC_X = {
    "layers": 3,
    "riser_module": 0,
    "bands": [
        {"key": "sleeve_inner", "level": 2, "n": 6, "bore": 14.0},
        {"key": "sleeve_middle", "level": 1, "n": 7, "bore": 11.4},
        {"key": "strip_a", "level": 0, "n": 1, "bore": 32.0},
        {"key": "strip_c", "level": 0, "n": 1, "bore": 11.6},
    ],
}
SPEC_Y = {
    "layers": 4,
    "riser_module": 2,  # Y 的加高模組在第 3 格(X 在最底格)
    "bands": [
        {"key": "sleeve_outer", "level": 0, "n": 7, "bore": 11.4},
        {"key": "strip_a", "level": 1, "n": 1, "bore": 11.6},
        {"key": "sleeve_middle", "level": 2, "n": 7, "bore": 11.4},
        {"key": "sleeve_inner", "level": 3, "n": 6, "bore": 14.0},
    ],
}
# 客戶手繪值
P_X = {"L1": 805.0, "L2": 840.0, "L3": 870.0, "width": 118.2,
       "head_h": 39.5, "mount_h": 190.0, "bottom_leg": 70.0}
P_Y = {"L1": 1305.0, "L2": 1340.0, "L3": 1370.0, "L4": 1405.0, "width": 118.2,
       "head_h": 51.0, "mount_h": 200.0, "bottom_leg": 70.0}


class LayerNumberingTests(unittest.TestCase):
    def test_client_numbering_is_inverted(self):
        # level 0 = 外層 = LN;level N-1 = 內層 = L1
        self.assertEqual(layer_key(0, 3), "L3")
        self.assertEqual(layer_key(2, 3), "L1")
        self.assertEqual(layer_key(0, 4), "L4")
        self.assertEqual(layer_key(3, 4), "L1")

    def test_riser_module_index(self):
        # X:加高全給最底格 → 16.5/11.5/11.5;Y:第 3 格 → 11.5/11.5/16.5/11.5
        self.assertEqual(module_heights(P_X, SPEC_X, M), [16.5, 11.5, 11.5])
        self.assertEqual(module_heights(P_Y, SPEC_Y, M), [11.5, 11.5, 16.5, 11.5])
        self.assertEqual(
            [round(z, 4) for z in window_centers(P_Y, SPEC_Y, M)],
            [5.75, 17.25, 31.25, 45.25],
        )


class OemEquivalenceTests(unittest.TestCase):
    """把 OEM 量到的配置餵回閉式,必須逐位重現原廠 STEP 的彎徑/直段/包絡。"""

    def test_cable_x_v4_pose(self):
        # v4 閉式:層 k 的 sa=124.65-11.125k、sb=311.125-11.125k、r=82.75-12.75k
        oem = {"width": 118.2, "head_h": 39.5, "mount_h": 140.0,
               "bottom_leg": 124.65 - 32.4}
        for k in range(3):
            sa, sb, r = 124.65 - 11.125 * k, 311.125 - 11.125 * k, 82.75 - 12.75 * k
            oem[layer_key(k, 3)] = sa + sb + math.pi * r
        d = check(oem, SPEC_X, M)
        self.assertAlmostEqual(d["tip_offset"], 186.475, places=9)
        for k, ly in enumerate(d["layers"]):
            self.assertAlmostEqual(ly["r"], 82.75 - 12.75 * k, places=9)
            self.assertAlmostEqual(ly["straight_a"], 124.65 - 11.125 * k, places=6)
            self.assertAlmostEqual(ly["straight_b"], 311.125 - 11.125 * k, places=6)
        self.assertAlmostEqual(d["l_bb"], 397.225, places=6)  # 圖面 394.38 + 2.845
        self.assertAlmostEqual(d["height"], 179.5, places=9)

    def test_cable_y_v4_pose(self):
        oem_sa = [135.15, 124.047, 113.529, 102.404]
        oem_tip = 788.725
        oem_r = [112.25, 99.5, 85.5, 72.75]
        oem = {"width": 118.2, "head_h": 51.0, "mount_h": 185.0,
               "bottom_leg": 135.15 - 32.4}
        for k in range(4):
            oem[layer_key(k, 4)] = 2.0 * oem_sa[k] + oem_tip + math.pi * oem_r[k]
        d = check(oem, SPEC_Y, M)
        self.assertAlmostEqual(d["tip_offset"], oem_tip, places=6)
        for k, ly in enumerate(d["layers"]):
            self.assertAlmostEqual(ly["r"], oem_r[k], places=9)
            self.assertAlmostEqual(ly["straight_a"], oem_sa[k], places=6)
        self.assertAlmostEqual(d["l_bb"], 1039.475, places=3)  # census bbox Y
        self.assertAlmostEqual(d["height"], 236.0, places=9)


class HandSketchTests(unittest.TestCase):
    def test_customer_sketch_values_pass(self):
        dx = check(P_X, SPEC_X, M)
        self.assertEqual([round(l["r"], 3) for l in dx["layers"]], [107.75, 95.0, 82.25])
        self.assertAlmostEqual(dx["height"], 229.5, places=9)
        self.assertAlmostEqual(dx["layers"][0]["straight_a"], 70.0 + 32.4, places=9)
        dy = check(P_Y, SPEC_Y, M)
        self.assertEqual([round(l["r"], 3) for l in dy["layers"]], [119.75, 107.0, 93.0, 80.25])
        self.assertAlmostEqual(dy["height"], 251.0, places=9)

    def test_length_identity(self):
        # L = 下直段 + pi*r + 上直段(閉式的定義式,任何重構都不許動它)
        for p, spec in ((P_X, SPEC_X), (P_Y, SPEC_Y)):
            for ly in derive(p, spec, M)["layers"]:
                self.assertAlmostEqual(
                    ly["straight_a"] + math.pi * ly["r"] + ly["straight_b"], ly["L"], places=9
                )


class ClearanceTests(unittest.TestCase):
    def test_analytic_gap_beats_polyline_understimate(self):
        """Y 的客戶值 L2/L3 差 30 剛好卡在幾何下限(彎冠餘隙 ~0.3)——折線版會低估
        而誤擋。解析版必須算出 >= 7.0 並放行(這條就是那個 bug 的回歸鎖)。"""
        d = derive(P_Y, SPEC_Y, M)
        gaps = [
            u_gap(d["layers"][i], d["layers"][i + 1], d["tip_offset"])
            for i in range(len(d["layers"]) - 1)
        ]
        self.assertEqual([round(g, 3) for g in gaps], [9.93, 7.009, 9.93])
        self.assertEqual(issues(P_Y, SPEC_Y, M), [])

    def test_too_close_layers_rejected_with_usable_ceiling(self):
        bad = dict(P_X, L1=865.0)  # 內層太長 → 頂到中層
        found = [i for i in issues(bad, SPEC_X, M) if i["key"] == "L1"]
        self.assertTrue(found, "巢套餘隙未擋下")
        self.assertIn("巢套餘隙不足", found[0]["message"])
        # 回報的上限必須真的可用(餵回去就過)
        self.assertEqual(issues(dict(P_X, L1=found[0]["max"]), SPEC_X, M), [])


class GuardTests(unittest.TestCase):
    def test_each_guard_fires_and_floor_is_usable(self):
        cases = [
            ("head_h", dict(P_X, head_h=30.0)),
            ("mount_h", dict(P_X, mount_h=40.0)),
            ("bottom_leg", dict(P_X, bottom_leg=2.0)),
            ("width", dict(P_X, width=30.0)),
            ("L2", dict(P_X, L2=700.0)),  # 直段容不下固定架板深
        ]
        for key, params in cases:
            with self.subTest(key=key):
                found = [i for i in issues(params, SPEC_X, M) if i["key"] == key]
                self.assertTrue(found, f"{key} 沒被擋下")
                self.assertIn(key, found[0]["message"])
                if "min" in found[0]:
                    fixed = dict(params)
                    fixed[key] = found[0]["min"]
                    self.assertEqual(
                        [i for i in issues(fixed, SPEC_X, M) if i["key"] == key],
                        [],
                        f"{key} 回報的下限 {found[0]['min']} 餵回去仍不過",
                    )

    def test_check_raises_first_issue_message(self):
        with self.assertRaises(ValueError) as ctx:
            check(dict(P_X, head_h=30.0), SPEC_X, M)
        self.assertIn("head_h(30)過低", str(ctx.exception))

    def test_clean_params_produce_no_issues(self):
        self.assertEqual(issues(P_X, SPEC_X, M), [])
        self.assertEqual(issues(P_Y, SPEC_Y, M), [])


if __name__ == "__main__":
    unittest.main()
