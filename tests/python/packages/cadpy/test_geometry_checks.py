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


if __name__ == "__main__":
    unittest.main()
