"""Geometry tests for the cadpy.parts simplified generators (real OCP solids).

Each generator must produce valid solids whose only interference is the declared
intended contact, and each module's ``check_geometry`` must accept a good part
and a known-bad (a contradictory dimension, or -- for parts that travel -- a
motion that drives a slider off its rail/screw) must be rejected. Mirrors the
sandbox discipline: every gate is locked by a fixture that must FAIL.
"""

from __future__ import annotations

import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.geometry_checks import (  # noqa: E402
    assert_all_valid,
    assert_no_interference,
    enumerate_interferences,
)
from cadpy.parts import (  # noqa: E402
    ball_screw,
    deep_groove_bearing,
    gripper,
    linear_guide,
    pneumatic_cylinder,
    stepper_motor,
)
from cadpy.parts.ball_screw import check_geometry as check_ball_screw  # noqa: E402
from cadpy.parts.deep_groove_bearing import check_geometry as check_bearing  # noqa: E402
from cadpy.parts.gripper import check_geometry as check_gripper  # noqa: E402
from cadpy.parts.linear_guide import check_geometry as check_linear_guide  # noqa: E402
from cadpy.parts.pneumatic_cylinder import check_geometry as check_cylinder  # noqa: E402
from cadpy.parts.stepper_motor import check_geometry as check_stepper  # noqa: E402


class CylinderGeometryTests(unittest.TestCase):
    def _cyl(self, **kw):
        kw.setdefault("bore", 32)
        kw.setdefault("stroke", 18.85)
        kw.setdefault("rod_dia", 12)
        kw.setdefault("body_dia", 42)
        return pneumatic_cylinder(**kw)

    def test_produces_two_valid_labeled_solids(self) -> None:
        cyl = self._cyl()
        self.assertEqual([c.label for c in cyl.children], ["cyl_body", "cyl_rod"])
        assert_all_valid(cyl, label="cylinder part")

    def test_only_interference_is_the_intended_bore_contact(self) -> None:
        cyl = self._cyl()
        report = enumerate_interferences(cyl)
        # exactly one overlapping pair, and it is body~rod (rod seated in the bore)
        self.assertEqual(len(report.overlaps), 1)
        # undeclared -> the gate must FAIL; declared via check_geometry -> pass
        with self.assertRaises(AssertionError):
            assert_no_interference(cyl)
        check_cylinder(cyl)  # no raise

    def test_check_passes_retracted_and_fully_extended(self) -> None:
        check_cylinder(self._cyl(extension=0.0))
        check_cylinder(self._cyl(extension=18.85))

    def test_rod_stays_engaged_in_body_when_extended(self) -> None:
        # even fully extended, body~rod must remain the (single) intended overlap,
        # i.e. the rod has not separated from the barrel.
        cyl = self._cyl(extension=18.85)
        self.assertEqual(len(enumerate_interferences(cyl).overlaps), 1)
        check_cylinder(cyl)

    def test_rod_protrusion_exposes_a_rod_end_when_retracted(self) -> None:
        # a real cylinder's rod sticks out even retracted; rod_protrusion raises the
        # retracted rod top by exactly that amount (so a coupler has an end to grip).
        flush = self._cyl(extension=0.0)
        proud = self._cyl(extension=0.0, rod_protrusion=8.0)
        top_flush = max(c.bounding_box().max.Z for c in flush.children)
        top_proud = max(c.bounding_box().max.Z for c in proud.children)
        self.assertAlmostEqual(top_proud - top_flush, 8.0, places=3)
        check_cylinder(proud)  # still only the intended body~rod contact

    def test_known_bad_rod_not_smaller_than_bore_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pneumatic_cylinder(bore=32, stroke=20, rod_dia=32)  # rod == bore

    def test_known_bad_extension_beyond_stroke_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pneumatic_cylinder(bore=32, stroke=20, extension=25)


class BearingGeometryTests(unittest.TestCase):
    def test_rings_are_valid_and_separated_by_the_raceway(self) -> None:
        brg = deep_groove_bearing(bore=8, od=22, width=7)
        self.assertEqual([c.label for c in brg.children], ["brg_outer", "brg_inner"])
        assert_all_valid(brg, label="bearing ring")
        # the raceway gap means NO overlap between the rings
        self.assertEqual(len(enumerate_interferences(brg).overlaps), 0)
        check_bearing(brg)  # no raise

    def test_all_catalog_bearings_pass(self) -> None:
        from cadpy.parts.specs_io import load_specs

        for row in load_specs("bearings"):
            brg = deep_groove_bearing(row["bore"], row["od"], row["width"])
            check_bearing(brg)

    def test_known_bad_bore_not_smaller_than_od_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            deep_groove_bearing(bore=22, od=22, width=7)  # bore == od


class StepperGeometryTests(unittest.TestCase):
    def test_body_and_shaft_valid_with_only_intended_contact(self) -> None:
        m = stepper_motor(face=42.3, body_len=40, shaft_dia=5, shaft_len=24)
        self.assertEqual([c.label for c in m.children], ["motor_body", "motor_shaft"])
        assert_all_valid(m, label="motor part")
        # shaft root seated in the body is the only overlap; undeclared -> FAIL
        self.assertEqual(len(enumerate_interferences(m).overlaps), 1)
        with self.assertRaises(AssertionError):
            assert_no_interference(m)
        check_stepper(m)  # declared -> pass

    def test_all_catalog_motors_pass(self) -> None:
        from cadpy.parts.specs_io import load_specs

        for row in load_specs("motors"):
            m = stepper_motor(
                row["face"], row["body_len"], row["shaft_dia"], row["shaft_len"],
                pilot_dia=row["pilot_dia"], pilot_len=row["pilot_len"],
            )
            check_stepper(m)

    def test_known_bad_pilot_not_smaller_than_face_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            stepper_motor(face=42.3, body_len=40, shaft_dia=5, shaft_len=24, pilot_dia=50)


class LinearGuideGeometryTests(unittest.TestCase):
    DIMS = dict(
        rail_width=12, rail_height=8, rail_len=200,
        block_width=27, block_height=13, block_len=45,
    )

    def test_valid_carriage_clears_rail_and_sweeps_clean(self) -> None:
        guide = linear_guide(**self.DIMS, block_pos=50)
        self.assertEqual([c.label for c in guide.children], ["guide_rail", "guide_block"])
        assert_all_valid(guide, label="guide part")
        # running clearance -> no static overlap
        self.assertEqual(len(enumerate_interferences(guide).overlaps), 0)
        # full-rail sweep is penetration-free
        check_linear_guide(guide, sweep_args={**self.DIMS, "samples": 16})

    def test_known_bad_block_off_rail_is_rejected(self) -> None:
        # travel is rail_len - block_len = 155; 180 runs off the rail
        with self.assertRaises(ValueError):
            linear_guide(**self.DIMS, block_pos=180)


class BallScrewGeometryTests(unittest.TestCase):
    DIMS = dict(screw_dia=16, lead=5, screw_len=200, nut_dia=28, nut_len=40)

    def test_valid_nut_clears_screw_and_sweeps_clean(self) -> None:
        scr = ball_screw(**self.DIMS, nut_pos=60)
        self.assertEqual([c.label for c in scr.children], ["screw_shaft", "screw_nut"])
        assert_all_valid(scr, label="ball-screw part")
        self.assertEqual(len(enumerate_interferences(scr).overlaps), 0)
        check_ball_screw(scr, sweep_args={**self.DIMS, "samples": 16})

    def test_known_bad_nut_off_screw_is_rejected(self) -> None:
        # travel is screw_len - nut_len = 160; 180 runs off the screw
        with self.assertRaises(ValueError):
            ball_screw(**self.DIMS, nut_pos=180)


class GripperGeometryTests(unittest.TestCase):
    def test_body_and_two_jaws_valid_with_only_intended_contacts(self) -> None:
        g = gripper(bore=20, stroke=10, opening=4)
        self.assertEqual(
            [c.label for c in g.children],
            ["gripper_body", "gripper_jaw_a", "gripper_jaw_b"],
        )
        assert_all_valid(g, label="gripper part")
        # exactly the two seated fingers overlap the body; the fingers never touch
        report = enumerate_interferences(g)
        pairs = {frozenset((p.a, p.b)) for p in report.overlaps}
        self.assertEqual(
            pairs,
            {
                frozenset(("gripper_body", "gripper_jaw_a")),
                frozenset(("gripper_body", "gripper_jaw_b")),
            },
        )
        self.assertNotIn(
            frozenset(("gripper_jaw_a", "gripper_jaw_b")), pairs
        )  # the fingers must not collide
        # undeclared -> the gate must FAIL; declared via check_geometry -> pass
        with self.assertRaises(AssertionError):
            assert_no_interference(g)
        check_gripper(g)  # no raise

    def test_check_passes_closed_and_fully_open_with_sweep(self) -> None:
        sweep = dict(bore=20, stroke=10, samples=16)
        check_gripper(gripper(bore=20, stroke=10, opening=0), sweep_args=sweep)
        check_gripper(gripper(bore=20, stroke=10, opening=10), sweep_args=sweep)

    def test_all_catalog_grippers_pass(self) -> None:
        from cadpy.parts.specs_io import load_specs

        for row in load_specs("grippers"):
            g = gripper(bore=row["bore"], stroke=row["stroke"], opening=row["stroke"])
            check_gripper(
                g, sweep_args=dict(bore=row["bore"], stroke=row["stroke"], samples=8)
            )

    def test_known_bad_body_too_short_is_rejected(self) -> None:
        # a body_l that cannot host the fingers at full open must raise
        with self.assertRaises(ValueError):
            gripper(bore=20, stroke=10, body_l=20)

    def test_known_bad_opening_beyond_stroke_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            gripper(bore=20, stroke=10, opening=12)


if __name__ == "__main__":
    unittest.main()
