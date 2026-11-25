"""Tests for cadpy.geometry_checks — shape-level validity + interference.

Includes injected-defect "must FAIL" cases (an open-shell pseudo-solid; an
undeclared assembly overlap; an injected interpenetrating part; a duplicate-
label instance that must not be masked by the allow-list), mirroring the
sandbox discipline where every gate is locked by a known-bad fixture.
"""

from __future__ import annotations

import importlib.util
import unittest

from tests.python.support.paths import add_repo_path, repo_path

add_repo_path("packages/cadpy/src")

from cadpy.geometry_checks import (  # noqa: E402
    assert_all_valid,
    assert_motion_clear,
    assert_no_interference,
    assert_valid_solid,
    enumerate_interferences,
    is_valid_solid,
    min_gap,
    overlap_volume,
    sweep_interference,
)


def _open_shell_solid():
    """Injected defect: a 'solid' built from 5 of a box's 6 faces (not closed)."""
    from build123d import Box
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.TopoDS import TopoDS_Shell

    faces = list(Box(10, 10, 10).faces())[:5]
    shell = TopoDS_Shell()
    builder = BRep_Builder()
    builder.MakeShell(shell)
    for face in faces:
        builder.Add(shell, face.wrapped)
    return BRepBuilderAPI_MakeSolid(shell).Solid()


def _load_rack_pinion():
    """Build the repo's one real assembly fixture from its generator source."""
    gen_path = repo_path(
        "models", "rack_pinion_rotary_actuator", "rack_pinion_rotary_actuator.py"
    )
    spec = importlib.util.spec_from_file_location("rack_pinion_fixture", str(gen_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.gen_step()


# rack_pinion's intended VOLUME overlaps at the seated pose, all pin-mediated or
# shaft-in-bore (no glued blocks): rod-in-barrel; the clevis pin through the rod end
# and the rack's clevis socket (rod->pin->rack); the gear mesh; and the hub dowel
# through the pinion shaft and the platform hub (pinion->pin->platform). The rod and
# rack do NOT interpenetrate (rod in a clearance socket bore), and the gear and
# platform do NOT interpenetrate (platform rides the shaft in a clearance bore).
RACK_PINION_INTENDED = [
    ("cylinder_body", "piston_rod"),
    ("piston_rod", "clevis_pin"),
    ("clevis_pin", "rack"),
    ("rack", "pinion"),
    ("pinion", "hub_pin"),
    ("hub_pin", "platform"),
]


class ValidityTests(unittest.TestCase):
    def test_box_is_valid(self) -> None:
        from build123d import Box

        self.assertTrue(is_valid_solid(Box(10, 10, 10)))

    def test_assert_valid_returns_the_shape(self) -> None:
        from build123d import Box

        box = Box(5, 5, 5)
        self.assertIs(assert_valid_solid(box), box)

    def test_open_shell_is_invalid(self) -> None:
        # The injected-defect lock for validity: BRepCheck must reject it.
        self.assertFalse(is_valid_solid(_open_shell_solid()))

    def test_assert_valid_solid_raises_on_defect(self) -> None:
        with self.assertRaisesRegex(AssertionError, "invalid solid"):
            assert_valid_solid(_open_shell_solid(), label="lid")

    def test_null_topods_shape_is_invalid_without_crashing(self) -> None:
        from OCP.TopoDS import TopoDS_Solid

        # A null TopoDS shape would make the kernel raise; we report False.
        self.assertFalse(is_valid_solid(TopoDS_Solid()))

    def test_wrapped_assertion_does_not_leak(self) -> None:
        # build123d's .wrapped raises AssertionError (not AttributeError) for a
        # null/empty shape. That must be swallowed to False — otherwise the
        # acceptance hook reads the bare AssertionError as a deliberate refusal.
        class _NullWrapped:
            @property
            def wrapped(self):
                raise AssertionError("build123d null shape")

        self.assertFalse(is_valid_solid(_NullWrapped()))

    def test_assert_all_valid_names_the_bad_part(self) -> None:
        from build123d import Box

        parts = [("good", Box(10, 10, 10)), ("bad", _open_shell_solid())]
        with self.assertRaisesRegex(AssertionError, "bad"):
            assert_all_valid(parts)

    def test_assert_all_valid_passes_clean_assembly(self) -> None:
        from build123d import Box

        # Pass-path must return None without raising (regression guard).
        self.assertIsNone(assert_all_valid([("a", Box(10, 10, 10)), ("b", Box(5, 5, 5))]))

    def test_single_solid_is_validated_not_skipped(self) -> None:
        from build123d import Box

        # A single solid has .children == () ; it must be validated as one part,
        # not silently skipped (vacuous pass).
        assert_all_valid(Box(10, 10, 10))  # bare single shape -> no raise
        with self.assertRaisesRegex(AssertionError, "invalid"):
            assert_all_valid(_open_shell_solid())  # single defective solid -> FAIL


class MetricTests(unittest.TestCase):
    def test_min_gap_separated_and_touching(self) -> None:
        from build123d import Box, Pos

        a = Box(10, 10, 10)  # x in [-5, 5] (build123d boxes are origin-centered)
        separated = Pos(20, 0, 0) * Box(10, 10, 10)  # x in [15, 25] -> gap 10
        overlapping = Pos(5, 0, 0) * Box(10, 10, 10)  # x in [0, 10] -> touching
        self.assertAlmostEqual(min_gap(a, separated), 10.0, places=4)
        self.assertAlmostEqual(min_gap(a, overlapping), 0.0, places=6)

    def test_overlap_volume(self) -> None:
        from build123d import Box, Pos

        a = Box(10, 10, 10)
        overlapping = Pos(5, 0, 0) * Box(10, 10, 10)  # 5 x 10 x 10 = 500
        separated = Pos(20, 0, 0) * Box(10, 10, 10)
        self.assertAlmostEqual(overlap_volume(a, overlapping), 500.0, places=2)
        self.assertAlmostEqual(overlap_volume(a, separated), 0.0, places=6)


class InterferenceTests(unittest.TestCase):
    def test_real_assembly_overlaps_are_enumerated(self) -> None:
        asm = _load_rack_pinion()
        n = len(asm.children)
        report = enumerate_interferences(asm)
        self.assertEqual(len(report.pairs), n * (n - 1) // 2)
        # every enumerated overlap is one of the declared intended contacts
        self.assertEqual(len(report.overlaps), len(RACK_PINION_INTENDED))

    def test_real_assembly_passes_with_declared_contacts(self) -> None:
        report = assert_no_interference(_load_rack_pinion(), allow=RACK_PINION_INTENDED)
        self.assertEqual(len(report.overlaps), 0)  # all overlaps were declared

    def test_undeclared_overlap_fails(self) -> None:
        # Without the allow-list, the six intended overlaps must FAIL the gate.
        with self.assertRaisesRegex(AssertionError, "undeclared"):
            assert_no_interference(_load_rack_pinion())

    def test_injected_penetrator_fails_despite_allowlist(self) -> None:
        from build123d import Box, Pos

        # Every real contact declared, but a NEW interpenetrating part is not —
        # it must still FAIL (the injected-defect lock for interference).
        asm = _load_rack_pinion()
        parts = [(child.label, child) for child in asm.children]
        parts.append(("intruder", Pos(-22, 22, 78) * Box(40, 40, 40)))
        with self.assertRaisesRegex(AssertionError, "intruder"):
            assert_no_interference(parts, allow=RACK_PINION_INTENDED)

    def test_duplicate_labels_do_not_overmatch_allowlist(self) -> None:
        from build123d import Box, Pos

        # Two parts share label 'bolt'. One is an intended press-fit into 'nut';
        # the other is a DISTINCT instance also overlapping 'nut'. Declaring
        # ('bolt','nut') must whitelist only the first instance — the duplicate
        # (disambiguated to 'bolt#1') must still be caught.
        nut = ("nut", Box(10, 10, 10))
        bolt1 = ("bolt", Pos(8, 0, 0) * Box(10, 10, 10))
        bolt2 = ("bolt", Pos(0, 8, 0) * Box(10, 10, 10))
        with self.assertRaisesRegex(AssertionError, r"bolt#1"):
            assert_no_interference([nut, bolt1, bolt2], allow=[("bolt", "nut")])

    def test_allowlist_symmetry_and_bogus_entry(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(5, 0, 0) * Box(10, 10, 10))  # overlap
        # symmetry: declaring ('b','a') matches the ('a','b') pair
        assert_no_interference([a, b], allow=[("b", "a")])  # no raise
        # a bogus allow entry must NOT mask the real overlap
        with self.assertRaisesRegex(AssertionError, "undeclared"):
            assert_no_interference([a, b], allow=[("x", "y")])

    def test_dict_envelope_payload_is_normalized(self) -> None:
        from build123d import Box, Pos

        # gen_step's envelope dict form: a 'children' list of named shapes must
        # be normalized to parts, not iterated as dict keys.
        nut = Box(10, 10, 10)
        nut.label = "nut"
        bolt = Pos(5, 0, 0) * Box(10, 10, 10)
        bolt.label = "bolt"
        payload = {"children": [nut, bolt]}
        with self.assertRaisesRegex(AssertionError, "undeclared"):
            assert_no_interference(payload)
        assert_no_interference(payload, allow=[("bolt", "nut")])  # declared -> ok

    def test_declared_overlap_is_reported_as_allowed_not_hidden(self) -> None:
        # Lesson L-5: a declared (allow-listed) overlap must NOT be silently
        # skipped -- its volume is measured and surfaced so a gross "glued blocks"
        # whitelist is visible for review, even though it does not block the gate.
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(5, 0, 0) * Box(10, 10, 10))  # 5x10x10 = 500 mm^3 overlap
        report = enumerate_interferences([a, b], allow=[("a", "b")])
        self.assertEqual(len(report.overlaps), 0)            # declared -> does not block
        self.assertEqual(len(report.allowed), 1)             # but IS recorded
        self.assertAlmostEqual(report.allowed[0].overlap_volume, 500.0, places=1)
        self.assertIn("allowed:", report.summary())          # and surfaced in the summary
        assert_no_interference([a, b], allow=[("a", "b")])   # still passes (no raise)

    def test_near_miss_is_reported_not_blocking(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))  # x in [-5, 5]
        b = ("b", Pos(11, 0, 0) * Box(10, 10, 10))  # x in [6, 16] -> gap 1
        report = assert_no_interference([a, b], clearance=2.0)  # 1 < 2 -> near
        self.assertEqual(len(report.overlaps), 0)
        self.assertEqual(len(report.near), 1)

    def test_near_miss_blocks_when_requested(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(11, 0, 0) * Box(10, 10, 10))  # gap 1
        with self.assertRaisesRegex(AssertionError, "interference:"):
            assert_no_interference([a, b], clearance=2.0, block_near=True)

    def test_coincident_face_is_near_with_clearance(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))  # x in [-5, 5]
        b = ("b", Pos(10, 0, 0) * Box(10, 10, 10))  # x in [5, 15] -> gap 0, no volume
        report = enumerate_interferences([a, b], clearance=1.0)
        self.assertEqual(len(report.overlaps), 0)
        self.assertEqual(len(report.near), 1)  # touching face + clearance>0 -> near

    def test_summary_reports_overlaps(self) -> None:
        from build123d import Box, Pos

        report = enumerate_interferences(
            [("a", Box(10, 10, 10)), ("b", Pos(5, 0, 0) * Box(10, 10, 10))]
        )
        self.assertIn("overlap:", report.summary())


class ContainmentTests(unittest.TestCase):
    """一個零件整顆埋在另一個零件的實心裡:表面沒碰到,但這是干涉。

    精確距離量的是表面到表面,所以埋在裡面的零件會讀到一個正的間隙;以前這種配對被判為沒事。
    """

    def test_part_buried_in_solid_material_is_an_overlap(self) -> None:
        from build123d import Box

        block, pin = ("block", Box(30, 30, 30)), ("pin", Box(4, 4, 4))
        self.assertGreater(min_gap(block[1], pin[1]), 10.0)  # 表面相距 13 mm:距離查詢看不出來
        report = enumerate_interferences([block, pin])
        self.assertEqual([(p.a, p.b, p.kind) for p in report.pairs], [("block", "pin", "overlap")])
        self.assertAlmostEqual(report.pairs[0].overlap_volume, 64.0, places=3)
        with self.assertRaises(AssertionError):
            assert_no_interference([block, pin])
        # 順序反過來也一樣
        self.assertEqual(enumerate_interferences([pin, block]).pairs[0].kind, "overlap")

    def test_part_in_a_bore_or_cavity_is_air_not_material(self) -> None:
        from build123d import Box, Cylinder, Sphere

        tube = Cylinder(10, 40) - Cylinder(8, 40)
        self.assertEqual(enumerate_interferences([("tube", tube), ("ball", Sphere(3))]).pairs[0].kind, "clear")
        shell = Box(30, 30, 30) - Box(20, 20, 20)  # 封閉空腔
        self.assertEqual(enumerate_interferences([("shell", shell), ("core", Box(6, 6, 6))]).pairs[0].kind, "clear")

    def test_declared_contact_reports_the_buried_volume(self) -> None:
        from build123d import Box

        report = enumerate_interferences([("block", Box(30, 30, 30)), ("pin", Box(4, 4, 4))], allow=[("block", "pin")])
        self.assertEqual(report.overlaps, ())
        self.assertAlmostEqual(report.allowed[0].overlap_volume, 64.0, places=3)

    def test_separate_parts_with_nested_boxes_stay_clear(self) -> None:
        from build123d import Box, Pos

        # L 形件的包絡箱包住小方塊,但小方塊在 L 的缺角(空氣)裡
        ell = Box(30, 30, 10) - (Pos(7.5, 7.5, 0) * Box(15, 15, 10))
        report = enumerate_interferences([("ell", ell), ("cube", Pos(8, 8, 0) * Box(6, 6, 6))])
        self.assertEqual(report.pairs[0].kind, "clear")


class MeshPrefilterTests(unittest.TestCase):
    """網格鄰近度快篩只能省時間:判定必須與精確查詢相同(支援的 kernel 上才會真的跳過)。"""

    def _cases(self):
        from build123d import Axis, Box, Cylinder, Pos, Sphere

        tube = Cylinder(10, 40) - Cylinder(5, 40)
        return {
            "重疊 5 mm": [("a", Box(10, 10, 10)), ("b", Pos(5, 0, 0) * Box(10, 10, 10))],
            "面貼面": [("a", Box(10, 10, 10)), ("b", Pos(10, 0, 0) * Box(10, 10, 10))],
            "相距 0.05(小於快篩容差)": [("a", Box(10, 10, 10)), ("b", Pos(10.05, 0, 0) * Box(10, 10, 10))],
            "相距 0.3": [("a", Box(40, 40, 2)), ("b", Pos(0, 0, 2.3) * Box(10, 10, 2))],
            "孔內留 0.5 間隙的軸": [("tube", tube), ("rod", Cylinder(4.5, 40))],
            "過盈 0.1 的軸": [("tube", tube), ("rod", Cylinder(5.1, 40))],
            "十字交叉的圓柱": [("a", Cylinder(3, 40)), ("b", Cylinder(3, 40).rotate(Axis.X, 90))],
            "管內的球(四周是空氣)": [("tube", Cylinder(10, 40) - Cylinder(8, 40)), ("ball", Sphere(3))],
            "整顆埋在實心裡": [("block", Box(30, 30, 30)), ("pin", Box(4, 4, 4))],
            "巢套的槽形件(相隔 3 mm)": [
                ("outer", Box(40, 20, 100) - (Pos(0, 3, 0) * Box(34, 20, 100))),
                ("inner", Pos(0, 3, 0) * (Box(28, 12, 100) - (Pos(0, 3, 0) * Box(22, 12, 100)))),
            ],
        }

    def test_verdicts_match_the_exact_query(self) -> None:
        for label, parts in self._cases().items():
            with self.subTest(case=label):
                exact = enumerate_interferences(parts)
                fast = enumerate_interferences(parts, mesh_prefilter=True)
                self.assertEqual([(p.a, p.b, p.kind) for p in fast.pairs], [(p.a, p.b, p.kind) for p in exact.pairs])
                for f, e in zip(fast.pairs, exact.pairs):
                    self.assertAlmostEqual(f.overlap_volume, e.overlap_volume, places=3)

    def test_prefilter_is_ignored_when_a_clearance_is_required(self) -> None:
        from build123d import Box, Pos

        parts = [("a", Box(10, 10, 10)), ("b", Pos(11, 0, 0) * Box(10, 10, 10))]  # 間隙 1 < 要求 2
        report = enumerate_interferences(parts, clearance=2.0, mesh_prefilter=True)
        self.assertEqual(len(report.near), 1)
        self.assertAlmostEqual(report.near[0].gap, 1.0, places=6)  # 走的是精確查詢

    def test_a_part_that_cannot_be_meshed_falls_back_to_the_exact_query(self) -> None:
        from unittest import mock

        from build123d import Box, Pos

        from cadpy import geometry_checks

        parts = [("a", Box(10, 10, 10)), ("b", Pos(5, 0, 0) * Box(10, 10, 10))]
        refuse = mock.patch.object(geometry_checks, "_mesh_for_prefilter", return_value=False)
        trap = mock.patch.object(geometry_checks, "_surfaces_apart", side_effect=AssertionError("不該被呼叫"))
        with refuse, trap:
            report = enumerate_interferences(parts, mesh_prefilter=True)
        self.assertEqual(report.pairs[0].kind, "overlap")

    def test_unproven_means_exact(self) -> None:
        """快篩答不出來(kernel 不支援、例外、沒載入三角面)一律當成「沒證明分開」。"""
        from unittest import mock

        from build123d import Cylinder, Sphere

        from cadpy import geometry_checks

        # 包絡箱相交(球在管子的孔裡),所以過得了包絡箱那一關、輪到快篩
        far = [("tube", Cylinder(10, 40) - Cylinder(8, 40)), ("ball", Sphere(3))]
        calls = []
        real = geometry_checks.min_gap

        def counting(a, b):
            calls.append(1)
            return real(a, b)

        unproven = mock.patch.object(geometry_checks, "_surfaces_apart", return_value=False)
        counted = mock.patch.object(geometry_checks, "min_gap", side_effect=counting)
        with unproven, counted:
            report = enumerate_interferences(far, mesh_prefilter=True)
        self.assertEqual(report.pairs[0].kind, "clear")
        self.assertEqual(len(calls), 1)  # 沒被證明分開 → 走了精確查詢


class InterferenceTimeBudgetTests(unittest.TestCase):
    """時間預算用完時,沒量到的配對逐一標 unmeasured——不是通過,也不是失敗。"""

    def _parts(self):
        from build123d import Box, Pos

        return [
            ("a", Box(10, 10, 10)),
            ("b", Pos(5, 0, 0) * Box(10, 10, 10)),    # a~b 重疊 500 mm^3
            ("c", Pos(30, 0, 0) * Box(10, 10, 10)),   # 遠:包絡箱就分得開
            ("pin", Pos(-3, 0, 4) * Box(2, 2, 10)),   # 與 a 重疊(宣告為接觸),碰不到 b
        ]

    def test_no_budget_is_the_old_behaviour(self) -> None:
        report = enumerate_interferences(self._parts(), allow=[("a", "pin")])
        self.assertEqual(report.unmeasured, ())
        self.assertEqual([(p.a, p.b) for p in report.overlaps], [("a", "b")])
        self.assertEqual(len(report.allowed), 1)
        self.assertGreater(report.allowed[0].overlap_volume, 0)

    def test_spent_budget_marks_touching_pairs_unmeasured_and_keeps_far_pairs_clear(self) -> None:
        import math

        full = enumerate_interferences(self._parts(), allow=[("a", "pin")])
        spent = enumerate_interferences(self._parts(), allow=[("a", "pin")], time_budget_s=0)
        # 配對的順序與數量不變(下游以位置對照)
        self.assertEqual([(p.a, p.b) for p in spent.pairs], [(p.a, p.b) for p in full.pairs])
        kinds = {frozenset((p.a, p.b)): p.kind for p in spent.pairs}
        self.assertEqual(kinds[frozenset(("a", "b"))], "unmeasured")   # 箱相交、沒時間量
        self.assertEqual(kinds[frozenset(("a", "c"))], "clear")        # 箱分得開:不花時間,照樣判定
        self.assertEqual(kinds[frozenset(("b", "pin"))], "clear")
        # 沒量到的那幾對不可被當成重疊,也不可被當成沒事
        self.assertEqual(spent.overlaps, ())
        self.assertEqual({(p.a, p.b) for p in spent.unmeasured}, {("a", "b")})
        self.assertIn("unmeasured: a~b", spent.summary())
        # 宣告接觸的那一對沒量到:仍是 allowed,但重疊量是 NaN(未知),不是 0
        allowed = spent.allowed[0]
        self.assertEqual((allowed.a, allowed.b), ("a", "pin"))
        self.assertTrue(math.isnan(allowed.overlap_volume))

    def test_generous_budget_changes_nothing(self) -> None:
        full = enumerate_interferences(self._parts(), allow=[("a", "pin")])
        timed = enumerate_interferences(self._parts(), allow=[("a", "pin")], time_budget_s=600)
        self.assertEqual([(p.a, p.b, p.kind) for p in timed.pairs], [(p.a, p.b, p.kind) for p in full.pairs])
        for x, y in zip(timed.pairs, full.pairs):
            self.assertAlmostEqual(x.overlap_volume, y.overlap_volume, places=6)

    def test_gate_does_not_raise_on_unmeasured_alone(self) -> None:
        # 產生器自己的閘不帶預算,行為不變;這裡只鎖「unmeasured 不是 overlap」這件事
        from build123d import Box, Pos

        report = enumerate_interferences(
            [("a", Box(10, 10, 10)), ("b", Pos(5, 0, 0) * Box(10, 10, 10))], time_budget_s=0
        )
        self.assertEqual(len(report.unmeasured), 1)
        self.assertEqual(report.overlaps, ())


class BroadPhaseTests(unittest.TestCase):
    """AABB broad-phase 必須是純提速:配對數、判定、allowed 量測全不變。"""

    def test_pair_enumeration_complete_and_far_pair_clear(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(5, 0, 0) * Box(10, 10, 10))  # 500 mm^3 overlap
        c = ("c", Pos(30, 0, 0) * Box(10, 10, 10))  # far -> broad-phase skip
        report = enumerate_interferences([a, b, c])
        self.assertEqual(len(report.pairs), 3)  # skipped pairs are still reported
        by_pair = {frozenset((p.a, p.b)): p for p in report.pairs}
        self.assertEqual(by_pair[frozenset(("a", "b"))].kind, "overlap")
        far = by_pair[frozenset(("a", "c"))]
        self.assertEqual(far.kind, "clear")
        # 跳過對的 gap = box 間距,對軸對齊 box 恰為精確值(誠實下界)
        self.assertAlmostEqual(far.gap, 20.0, places=3)

    def test_clearance_grows_the_broad_phase_margin(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))  # x in [-5, 5]
        b = ("b", Pos(11, 0, 0) * Box(10, 10, 10))  # gap 1 < clearance 2
        report = enumerate_interferences([a, b], clearance=2.0)
        self.assertEqual(len(report.near), 1)  # 必須進 kernel 而非被預過濾掉

    def test_beyond_clearance_pair_is_clear_without_kernel(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(20, 0, 0) * Box(10, 10, 10))  # gap 10 > clearance 2
        report = enumerate_interferences([a, b], clearance=2.0)
        self.assertEqual([p.kind for p in report.pairs], ["clear"])
        self.assertGreaterEqual(report.pairs[0].gap, 10.0 - 1e-6)

    def test_diagonal_separation_lower_bound(self) -> None:
        import math

        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(15, 15, 15) * Box(10, 10, 10))  # 角對角間距 5*sqrt(3)
        report = enumerate_interferences([a, b])
        p = report.pairs[0]
        self.assertEqual(p.kind, "clear")
        self.assertGreater(p.gap, 0.0)
        self.assertLessEqual(p.gap, 5.0 * math.sqrt(3.0) + 1e-6)  # 下界不得超過精確值

    def test_allowed_pairs_still_measured_with_far_parts_present(self) -> None:
        from build123d import Box, Pos

        a = ("a", Box(10, 10, 10))
        b = ("b", Pos(5, 0, 0) * Box(10, 10, 10))  # 宣告接觸 500 mm^3
        c = ("c", Pos(40, 0, 0) * Box(10, 10, 10))  # 被 broad-phase 跳過
        report = enumerate_interferences([a, b, c], allow=[("a", "b")])
        self.assertEqual(len(report.overlaps), 0)
        self.assertEqual(len(report.allowed), 1)  # allowed 永遠照常量測
        self.assertAlmostEqual(report.allowed[0].overlap_volume, 500.0, places=1)


class MotionSweepTests(unittest.TestCase):
    """The motion sweep extends interference from one pose to a whole travel.
    Locked by the injected defect that started it: a part that is clear at BOTH
    endpoints yet drives THROUGH another mid-travel -- a static gate passes it,
    only the sweep sees it."""

    @staticmethod
    def _frame(bx):
        from build123d import Box, Pos

        return [("A", Box(10, 10, 10)), ("B", Pos(bx, 0, 0) * Box(10, 10, 10))]

    def test_clear_motion_does_not_raise(self) -> None:
        poses = [(x, self._frame(x)) for x in (40, 30, 20, 15)]  # B sweeps in, never reaches A
        self.assertEqual(sweep_interference(poses, [("A", "B")]), [])
        assert_motion_clear(poses, [("A", "B")])  # no raise

    def test_mid_travel_penetration_caught_though_endpoints_clear(self) -> None:
        # the injected-defect lock: endpoints clear, mid-travel a clash.
        assert_no_interference(self._frame(-20))   # static endpoints are clean...
        assert_no_interference(self._frame(20))
        poses = [(x, self._frame(x)) for x in (-20, -10, 0, 10, 20)]  # x=0 -> full overlap
        with self.assertRaisesRegex(AssertionError, r"A~B"):
            assert_motion_clear(poses, [("A", "B")])

    def test_constant_contact_baseline_not_flagged_but_excess_is(self) -> None:
        # a steady intended grip (B overlaps A by 1 mm all along) must ride the
        # reference baseline without flagging; only EXTRA overlap is a hit.
        grip = self._frame(9)                       # 1 mm overlap = 100 mm^3
        steady = [(i, self._frame(9)) for i in range(3)]
        self.assertEqual(sweep_interference(steady, [("A", "B")], baseline=grip), [])
        deeper = [(0, self._frame(9)), (1, self._frame(8))]   # 8 -> 2 mm = 200 mm^3
        hits = sweep_interference(deeper, [("A", "B")], baseline=grip)
        self.assertEqual(len(hits), 1)
        self.assertAlmostEqual(hits[0].excess, 100.0, delta=1.0)

    def test_per_pair_tolerance(self) -> None:
        # a small overlap below a pair's tolerance is not a hit; above it is.
        small = [(0, self._frame(9.6))]             # 0.4 mm overlap = 40 mm^3
        self.assertEqual(sweep_interference(small, [("A", "B")], tol={("A", "B"): 60.0}), [])
        self.assertEqual(len(sweep_interference(small, [("A", "B")], tol={("A", "B"): 20.0})), 1)


class MotionSweepBroadPhaseTests(unittest.TestCase):
    """The sweep's AABB broad phase must be pure speed-up: it spares the exact
    distance query for pair-frames whose boxes are apart and changes no verdict.
    Found by measurement: a 61-part gantry spent 22 of its 36 s gate on exact
    distances for pairs that never came near each other."""

    @staticmethod
    def _frame(bx, cz=100.0):
        from build123d import Box, Pos

        return [
            ("A", Box(10, 10, 10)),
            ("B", Pos(bx, 0, 0) * Box(10, 10, 10)),
            ("C", Pos(0, 0, cz) * Box(10, 10, 10)),  # tracked against A, always far away
        ]

    @staticmethod
    def _counting(module):
        """Patch the exact kernel queries with counting pass-throughs."""
        from unittest import mock

        calls = {"min_gap": 0, "overlap_volume": 0}

        def wrap(name):
            original = getattr(module, name)

            def counted(a, b):
                calls[name] += 1
                return original(a, b)

            return mock.patch.object(module, name, counted)

        return calls, wrap("min_gap"), wrap("overlap_volume")

    def test_separated_pair_frames_skip_the_exact_distance(self) -> None:
        from cadpy import geometry_checks

        poses = [(x, self._frame(x)) for x in (60, 40, 20, 5, 20, 40)]  # only x=5 meets A
        calls, gap_patch, volume_patch = self._counting(geometry_checks)
        with gap_patch, volume_patch:
            hits = sweep_interference(poses, [("A", "B"), ("A", "C")])
        self.assertEqual([(h.where, h.a, h.b) for h in hits], [(5, "A", "B")])
        self.assertAlmostEqual(hits[0].overlap, 500.0, places=1)
        # 12 pair-frames, one whose boxes meet: one distance query, one boolean.
        self.assertEqual(calls, {"min_gap": 1, "overlap_volume": 1})

    def test_boxes_that_meet_still_get_the_exact_distance(self) -> None:
        # Boxes overlap but the shapes do not: a sphere beside a box corner. The broad
        # phase cannot decide this one, so the exact distance must still be asked.
        from build123d import Box, Pos, Sphere

        from cadpy import geometry_checks

        frame = [("A", Box(10, 10, 10)), ("S", Pos(9, 9, 9) * Sphere(5))]
        self.assertGreater(min_gap(frame[0][1], frame[1][1]), 1.0)
        calls, gap_patch, volume_patch = self._counting(geometry_checks)
        with gap_patch, volume_patch:
            self.assertEqual(sweep_interference([(0, frame)], [("A", "S")]), [])
        self.assertEqual(calls, {"min_gap": 1, "overlap_volume": 0})

    def test_coincident_faces_are_not_filtered_out(self) -> None:
        # Face-on-face contact has box separation 0: it must reach the boolean and
        # come back as zero volume, exactly as before -- never be skipped as "apart".
        from cadpy import geometry_checks

        calls, gap_patch, volume_patch = self._counting(geometry_checks)
        with gap_patch, volume_patch:
            self.assertEqual(sweep_interference([(0, self._frame(10))], [("A", "B")]), [])
        self.assertEqual(calls, {"min_gap": 1, "overlap_volume": 1})

    def test_reference_pose_baseline_uses_the_broad_phase_too(self) -> None:
        from cadpy import geometry_checks

        seated = self._frame(40)
        calls, gap_patch, volume_patch = self._counting(geometry_checks)
        with gap_patch, volume_patch:
            hits = sweep_interference([(0, self._frame(40))], [("A", "B"), ("A", "C")], baseline=seated)
        self.assertEqual(hits, [])
        self.assertEqual(calls, {"min_gap": 0, "overlap_volume": 0})

    def test_verdicts_match_the_exact_only_path(self) -> None:
        # Same sweep with the broad phase disabled (every box "meets"): identical hits.
        from unittest import mock

        from cadpy import geometry_checks

        poses = lambda: [(x, self._frame(x, cz=cz)) for x, cz in ((30, 100), (9, 100), (0, 12), (9.5, 8), (30, 100))]  # noqa: E731
        pairs = [("A", "B"), ("A", "C"), ("B", "C")]
        fast = sweep_interference(poses(), pairs, baseline=self._frame(9))
        with mock.patch.object(geometry_checks, "_aabb_separation", return_value=0.0):
            exact = sweep_interference(poses(), pairs, baseline=self._frame(9))
        self.assertTrue(exact)  # the scenario really has hits to compare
        self.assertEqual(
            [(h.where, h.a, h.b, round(h.overlap, 3), round(h.excess, 3)) for h in fast],
            [(h.where, h.a, h.b, round(h.overlap, 3), round(h.excess, 3)) for h in exact],
        )


if __name__ == "__main__":
    unittest.main()
