"""Selection-math tests for cadpy.parts.select_* (pure, offline -- no OCP).

Each family gets known-good (a requirement -> the expected smallest standard row)
and known-bad (no row fits -> NoFittingPart, or a contradictory input -> raise)
cases, so a wrong force/torque/sizing formula cannot pass silently. These pin the
selection REASONING the catalog (step.parts) does not do.
"""

from __future__ import annotations

import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.parts.select import (  # noqa: E402
    NoFittingPart,
    _force,
    select_ball_screw,
    select_bearing,
    select_cylinder,
    select_gripper,
    select_linear_guide,
    select_stepper,
)
from cadpy.parts.specs_io import load_specs  # noqa: E402


class SpecHonestyTests(unittest.TestCase):
    """Every shipped row must declare a non-empty source, and the confidence label
    must honestly track certainty: a row may claim 'high' only if its source
    asserts the dimensions are exact/standard. (load_specs already rejects a
    missing source key or an out-of-range confidence, so those are not re-tested
    here -- this locks the contract load_specs does NOT enforce.)"""

    FAMILIES = ("cylinders", "bearings", "motors", "linear_guides", "ball_screws", "grippers")

    def test_every_row_has_a_nonempty_source(self) -> None:
        for family in self.FAMILIES:
            rows = load_specs(family)
            self.assertGreaterEqual(len(rows), 4, family)
            for row in rows:
                self.assertTrue(str(row.get("source", "")).strip(), f"{family}: empty source")

    def test_high_confidence_requires_exact_or_standard_dims(self) -> None:
        # The honesty rule a reconstructed dim must not break: 'high' is allowed
        # only when the source declares the dims exact/standard (a high row MAY
        # still note an approximate secondary rating, e.g. a bearing's C). A
        # reconstructed dim mislabeled 'high' with no such claim fails here.
        for family in self.FAMILIES:
            for row in load_specs(family):
                if row["confidence"] == "high":
                    src = str(row["source"]).lower()
                    self.assertTrue(
                        any(k in src for k in ("exact", "standard")),
                        f"{family}/{row.get('model')}: 'high' without exact/standard dims",
                    )


class CylinderSelectTests(unittest.TestCase):
    def test_force_model_push_vs_pull(self) -> None:
        sc40 = next(r for r in load_specs("cylinders") if r["model"] == "SC40")
        # push = full bore area; 1 bar = 0.1 N/mm^2 -> 40 mm bore at 6 bar ~ 754 N
        self.assertAlmostEqual(_force(sc40, 6.0, "push"), 753.98, places=1)
        # pull steals the rod area, so it is strictly weaker than push
        self.assertLess(_force(sc40, 6.0, "pull"), _force(sc40, 6.0, "push"))
        with self.assertRaises(ValueError):
            _force(sc40, 6.0, "sideways")

    def test_known_good_picks_smallest_adequate_bore(self) -> None:
        # light load, short stroke -> the smallest bore in the table
        pick = select_cylinder(load_N=150, stroke_mm=18.85)
        self.assertEqual(pick["model"], "SC32")
        self.assertGreater(pick["selected_for"]["margin"], 1.0)
        # heavier load forces a larger bore
        self.assertEqual(select_cylinder(load_N=600, stroke_mm=100)["model"], "SC50")

    def test_pull_action_demands_a_larger_bore_than_push(self) -> None:
        # the locked case: same load, push fits SC40 but pull (smaller effective
        # area) needs SC50 -- proves the action drives the bore, not bore>=req.
        self.assertEqual(select_cylinder(load_N=490, stroke_mm=100)["model"], "SC40")
        self.assertEqual(
            select_cylinder(load_N=490, stroke_mm=100, action="pull")["model"], "SC50"
        )

    def test_double_acting_is_sized_by_its_weaker_pull_stroke(self) -> None:
        # double-acting must cover the load both ways, so it sizes by pull (the
        # rod steals area) -- identical force and pick to an explicit pull.
        sc40 = next(r for r in load_specs("cylinders") if r["model"] == "SC40")
        self.assertEqual(_force(sc40, 6.0, "double"), _force(sc40, 6.0, "pull"))
        pick = select_cylinder(load_N=490, stroke_mm=100, action="double")
        self.assertEqual(pick["model"], "SC50")
        self.assertEqual(pick["selected_for"]["action"], "double")

    def test_action_phrasings_normalize(self) -> None:
        # the reported bug: 'double' (and its phrasings) must not raise; common
        # synonyms fold onto the canonical push/pull/double.
        for phrasing in ("Double", "double-acting", "double_acting", "both"):
            self.assertEqual(
                select_cylinder(load_N=490, stroke_mm=100, action=phrasing)["model"],
                "SC50",
                msg=phrasing,
            )
        # 'retract' -> pull (SC50), 'extend' -> push (SC40)
        self.assertEqual(
            select_cylinder(load_N=490, stroke_mm=100, action="retract")["model"], "SC50"
        )
        self.assertEqual(
            select_cylinder(load_N=490, stroke_mm=100, action="extend")["model"], "SC40"
        )

    def test_margin_is_reported_consistently_with_the_force_model(self) -> None:
        pick = select_cylinder(load_N=300, stroke_mm=100, action="pull")
        expected = _force(pick, 6.0, "pull") / 300
        self.assertAlmostEqual(pick["selected_for"]["margin"], expected, places=6)

    def test_no_fit_when_load_exceeds_every_bore(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_cylinder(load_N=99999, stroke_mm=100)

    def test_no_fit_when_stroke_below_every_offered_range(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_cylinder(load_N=100, stroke_mm=5)  # below stroke_min for all

    def test_no_fit_when_stroke_above_every_offered_range(self) -> None:
        # locks the upper `stroke_mm <= stroke_max` clause (max offered is 800)
        with self.assertRaises(NoFittingPart):
            select_cylinder(load_N=100, stroke_mm=900)

    def test_force_N_is_reported_and_consistent_with_margin(self) -> None:
        pick = select_cylinder(load_N=150, stroke_mm=18.85)
        self.assertAlmostEqual(
            pick["selected_for"]["margin"],
            pick["selected_for"]["force_N"] / 150,
            places=9,
        )

    def test_bad_inputs_raise(self) -> None:
        for kw in (
            dict(load_N=-1, stroke_mm=100),
            dict(load_N=100, stroke_mm=100, load_ratio=2.0),
            dict(load_N=100, stroke_mm=100, pressure_bar=0),
            dict(load_N=100, stroke_mm=-5),
        ):
            with self.assertRaises(ValueError):
                select_cylinder(**kw)


class BearingSelectTests(unittest.TestCase):
    def test_known_good_smallest_bore_that_fits_shaft(self) -> None:
        self.assertEqual(select_bearing(shaft_dia=8)["model"], "608")
        # shaft 10 -> bore 10; min OD picks 6000 over 6200
        self.assertEqual(select_bearing(shaft_dia=10)["model"], "6000")

    def test_radial_load_can_force_a_higher_rated_ring(self) -> None:
        # 6000 (C=4750) covers 4000 N at bore 10...
        self.assertEqual(
            select_bearing(shaft_dia=10, radial_load_N=4000)["model"], "6000"
        )
        # ...but 5000 N exceeds 6000's rating -> the next bore-10 ring, 6200
        self.assertEqual(
            select_bearing(shaft_dia=10, radial_load_N=5000)["model"], "6200"
        )

    def test_margin_uses_dynamic_rating(self) -> None:
        pick = select_bearing(shaft_dia=20, radial_load_N=2540)
        self.assertEqual(pick["model"], "6204")
        self.assertAlmostEqual(pick["selected_for"]["margin"], 12700 / 2540, places=6)

    def test_no_fit_when_shaft_exceeds_every_bore(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_bearing(shaft_dia=25)  # max bore is 20

    def test_no_fit_when_load_exceeds_every_rating(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_bearing(shaft_dia=8, radial_load_N=99999)

    def test_no_load_reports_fit_clearance_not_margin(self) -> None:
        pick = select_bearing(shaft_dia=8)  # -> 608, bore 8
        self.assertEqual(pick["model"], "608")
        self.assertEqual(pick["selected_for"]["fit_clearance"], 0)  # bore - shaft
        self.assertNotIn("margin", pick["selected_for"])

    def test_bad_inputs_raise(self) -> None:
        with self.assertRaises(ValueError):
            select_bearing(shaft_dia=0)
        # a non-None but non-positive load is a caller error, not "no load"
        with self.assertRaises(ValueError):
            select_bearing(shaft_dia=8, radial_load_N=-5)
        with self.assertRaises(ValueError):
            select_bearing(shaft_dia=8, radial_load_N=0)


class StepperSelectTests(unittest.TestCase):
    def test_known_good_smallest_frame_that_meets_torque(self) -> None:
        self.assertEqual(select_stepper(torque_Nm=0.05)["model"], "NEMA11")
        # 0.15 exceeds NEMA11 (0.1) -> smallest 42.3 frame / shortest stack
        self.assertEqual(select_stepper(torque_Nm=0.15)["model"], "NEMA17-34")

    def test_torque_climbs_the_stack_then_the_frame(self) -> None:
        # 0.4 exceeds the 34 & 40 stacks -> NEMA17-48 (same frame, longer stack)
        self.assertEqual(select_stepper(torque_Nm=0.4)["model"], "NEMA17-48")
        # beyond every NEMA17 -> NEMA23
        self.assertEqual(select_stepper(torque_Nm=0.8)["model"], "NEMA23-56")

    def test_margin_uses_holding_torque(self) -> None:
        pick = select_stepper(torque_Nm=0.2)
        self.assertAlmostEqual(
            pick["selected_for"]["margin"], pick["holding_torque_Nm"] / 0.2, places=6
        )

    def test_no_fit_beyond_every_motor(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_stepper(torque_Nm=2.0)  # max is ~1.26 Nm

    def test_bad_input_raises(self) -> None:
        with self.assertRaises(ValueError):
            select_stepper(torque_Nm=0)


class LinearGuideSelectTests(unittest.TestCase):
    def test_known_good_smallest_rail_that_meets_load(self) -> None:
        self.assertEqual(
            select_linear_guide(500, rail_len=200)["model"], "MGN9C"
        )
        # a load past MGN9C (1370) and MGN12C (2650) climbs to MGN15C (4900)
        self.assertEqual(
            select_linear_guide(4000, rail_len=200)["model"], "MGN15C"
        )

    def test_margin_and_rail_len_carried(self) -> None:
        pick = select_linear_guide(1000, rail_len=300)
        self.assertAlmostEqual(pick["selected_for"]["margin"], pick["C_dynamic_N"] / 1000)
        self.assertEqual(pick["selected_for"]["rail_len"], 300)

    def test_no_fit_when_load_exceeds_every_rail(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_linear_guide(99999, rail_len=200)

    def test_bad_inputs_raise(self) -> None:
        with self.assertRaises(ValueError):
            select_linear_guide(0, rail_len=200)
        with self.assertRaises(ValueError):
            select_linear_guide(500, rail_len=0)


class BallScrewSelectTests(unittest.TestCase):
    def test_known_good_lead_from_speed_identity(self) -> None:
        # 200 mm/s at 3000 rpm -> lead_req 4 mm/rev; smallest screw/finest lead = 1605
        pick = select_ball_screw(500, travel=100, target_speed_mm_s=200)
        self.assertEqual(pick["model"], "1605")
        self.assertAlmostEqual(pick["selected_for"]["lead_req_mm"], 4.0, places=6)

    def test_higher_speed_demands_a_coarser_lead(self) -> None:
        # 400 mm/s -> lead_req 8 -> needs a 10 mm lead; smallest such screw = 1610
        self.assertEqual(
            select_ball_screw(500, travel=100, target_speed_mm_s=400)["model"], "1610"
        )

    def test_load_drives_a_larger_screw_at_the_same_speed(self) -> None:
        # at 200 mm/s (lead_req 4) a light load picks 1605 (C=6000); a load past
        # 6000 N drops 1605 and climbs to the next screw whose C covers it.
        light = select_ball_screw(500, travel=100, target_speed_mm_s=200)
        self.assertEqual(light["model"], "1605")
        heavy = select_ball_screw(6500, travel=100, target_speed_mm_s=200)
        self.assertNotEqual(heavy["model"], "1605")  # 1605 C=6000 < 6500
        self.assertGreaterEqual(heavy["C_dynamic_N"], 6500)

    def test_margins_are_reported(self) -> None:
        pick = select_ball_screw(500, travel=100, target_speed_mm_s=200)
        self.assertAlmostEqual(pick["selected_for"]["margin"], pick["C_dynamic_N"] / 500)
        self.assertAlmostEqual(
            pick["selected_for"]["speed_margin"], pick["lead"] / 4.0, places=6
        )

    def test_bad_inputs_raise(self) -> None:
        with self.assertRaises(ValueError):
            select_ball_screw(0, travel=100, target_speed_mm_s=200)
        with self.assertRaises(ValueError):
            select_ball_screw(500, travel=0, target_speed_mm_s=200)
        with self.assertRaises(ValueError):
            select_ball_screw(500, travel=100, target_speed_mm_s=0)

    def test_no_fit_when_speed_needs_lead_beyond_table(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_ball_screw(500, travel=100, target_speed_mm_s=800)  # lead_req 16

    def test_no_fit_when_load_exceeds_every_rating(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_ball_screw(99999, travel=100, target_speed_mm_s=200)

    def test_no_fit_for_unavailable_accuracy_grade(self) -> None:
        # the catalog ships rolled C7 screws only; a C5 request must not fit
        with self.assertRaises(NoFittingPart):
            select_ball_screw(500, travel=100, target_speed_mm_s=200, accuracy="C5")


class GripperSelectTests(unittest.TestCase):
    def test_known_good_smallest_that_meets_force_and_opening(self) -> None:
        # force >= 10 N and opens >= 3 mm -> HFZ6 (3.3 N) is too weak, HFZ10 fits
        self.assertEqual(
            select_gripper(10, opening_mm=3)["model"], "HFZ10"
        )
        # 30 N climbs to HFZ16 (34 N); HFZ10 (11 N) is too weak
        self.assertEqual(select_gripper(30, opening_mm=5)["model"], "HFZ16")

    def test_opening_drives_a_larger_body_than_force_alone(self) -> None:
        # 10 N alone would pick HFZ10, but needing an 8 mm opening drops HFZ10
        # (stroke 4) and HFZ16 (stroke 6) and climbs to HFZ20 (stroke 10).
        self.assertEqual(select_gripper(10, opening_mm=8)["model"], "HFZ20")

    def test_higher_pressure_lets_a_smaller_gripper_qualify(self) -> None:
        # at the rated 0.5 MPa, 40 N needs HFZ20 (45 N); HFZ16 is 34 N
        self.assertEqual(select_gripper(40, opening_mm=5)["model"], "HFZ20")
        # at 0.7 MPa the force scales ~linearly: HFZ16 -> 34*1.4 = 47.6 N >= 40,
        # so the smaller HFZ16 now qualifies (proves pressure drives the pick).
        pick = select_gripper(40, opening_mm=5, pressure_MPa=0.7)
        self.assertEqual(pick["model"], "HFZ16")
        self.assertAlmostEqual(pick["selected_for"]["force_N"], 34 * 0.7 / 0.5, places=6)
        self.assertEqual(pick["selected_for"]["pressure_MPa"], 0.7)

    def test_margins_are_reported_at_the_sizing_pressure(self) -> None:
        pick = select_gripper(30, opening_mm=5)  # HFZ16, 34 N at rated 0.5 MPa
        self.assertEqual(pick["model"], "HFZ16")
        self.assertEqual(pick["selected_for"]["pressure_MPa"], 0.5)
        self.assertAlmostEqual(pick["selected_for"]["margin"], 34 / 30, places=6)
        self.assertAlmostEqual(pick["selected_for"]["opening_margin"], 6 / 5, places=6)

    def test_no_fit_when_force_exceeds_every_row(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_gripper(99999, opening_mm=5)

    def test_no_fit_when_opening_exceeds_every_stroke(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_gripper(10, opening_mm=999)  # max stroke is 30

    def test_no_fit_for_unavailable_type(self) -> None:
        # the catalog ships parallel grippers only; an angular request must not fit
        with self.assertRaises(NoFittingPart):
            select_gripper(10, opening_mm=3, gripper_type="angular")

    def test_bad_inputs_raise(self) -> None:
        for kw in (
            dict(grip_force_N=0, opening_mm=5),
            dict(grip_force_N=10, opening_mm=0),
            dict(grip_force_N=10, opening_mm=5, pressure_MPa=0),
        ):
            with self.assertRaises(ValueError):
                select_gripper(**kw)


if __name__ == "__main__":
    unittest.main()
