"""Model-level acceptance gates for the parts-catalog consumers.

These lock the integration gates from the parts plan -- the rack_pinion
(Phase 1 dogfood: a SELECTED cylinder drives a real mechanism), the
motorized_linear_stage (Phase 3 capstone: four selected families assemble and
travel) and the xyz_pickplace_gantry (a multi-axis machine: three selected
motorized screw axes + four selected pneumatic nozzles) -- by running each
model's own ``check_geometry``, which includes the whole-stroke MOTION sweep,
not just the seated pose. A static-only check would miss a mid-travel clash, so
the gate is the sweep.
"""

from __future__ import annotations

import importlib.util
import unittest

from tests.python.support.paths import add_repo_path, repo_path

add_repo_path("packages/cadpy/src")


def _load_model(folder: str, name: str):
    path = repo_path("models", folder, f"{name}.py")
    spec = importlib.util.spec_from_file_location(f"{name}_fixture", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RackPinionGateTests(unittest.TestCase):
    """Phase 1 Gate P1: the rack_pinion driven by a select+generate cylinder is
    valid, interference-free seated, AND penetration-free over the whole swing."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_model("rack_pinion_rotary_actuator", "rack_pinion_rotary_actuator")

    def test_cylinder_is_selected_not_hand_sized(self):
        spec = self.m.CYL_SPEC
        self.assertIn("model", spec)
        self.assertIn("margin", spec["selected_for"])
        self.assertGreater(spec["selected_for"]["margin"], 1.0)

    def test_joints_are_pin_mediated_without_interpenetration(self):
        # Both driven joints are pin-mediated, not glued blocks. The clevis pin must
        # overlap the rod end AND the rack while the rod and rack themselves do NOT
        # interpenetrate; the hub dowel must overlap the pinion (shaft) AND the
        # platform (hub) while the gear and platform do NOT interpenetrate.
        from cadpy.geometry_checks import enumerate_interferences

        overlaps = {
            frozenset((p.a, p.b)) for p in enumerate_interferences(self.m.gen_step()).overlaps
        }
        # rod -> clevis pin -> rack
        self.assertIn(frozenset(("piston_rod", "clevis_pin")), overlaps)
        self.assertIn(frozenset(("clevis_pin", "rack")), overlaps)
        self.assertNotIn(frozenset(("piston_rod", "rack")), overlaps)
        # pinion -> hub dowel -> platform
        self.assertIn(frozenset(("pinion", "hub_pin")), overlaps)
        self.assertIn(frozenset(("hub_pin", "platform")), overlaps)
        self.assertNotIn(frozenset(("pinion", "platform")), overlaps)

    def test_full_assembly_check_geometry_passes(self):
        self.m.check_geometry(self.m.gen_step())  # validity + interference + sweep

    def test_motion_sweep_wiring_is_not_vacuous(self):
        # The model tolerates a tiny block-tooth mesh sliver (~6 mm^3) via
        # _MESH_TOL=8. With a ZERO tolerance the SAME sweep must RAISE -- proving
        # the sweep really exercises motion (non-empty poses, the mesh pair is
        # tracked, the seated baseline does not swallow the mid-stroke excess).
        # If poses went empty or the baseline absorbed everything, this would stop
        # raising and the test fails: the gate is the sweep, not just the guards.
        from cadpy.geometry_checks import assert_motion_clear

        with self.assertRaises(AssertionError):
            assert_motion_clear(
                self.m._swing_poses(),
                [("rack", "pinion")],
                baseline=self.m.pose(0.0),
                tol=0.0,
            )


class MotorizedLinearStageGateTests(unittest.TestCase):
    """Phase 3 Gate P3: the capstone consumes >= 4 families and assembles AND
    travels penetration-free over the whole carriage stroke."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_model("motorized_linear_stage", "motorized_linear_stage")

    def test_consumes_at_least_four_families(self):
        models = {
            self.m.SCREW_SPEC["model"],
            self.m.GUIDE_SPEC["model"],
            self.m.BEARING_SPEC["model"],
            self.m.MOTOR_SPEC["model"],
        }
        self.assertEqual(len(models), 4)  # ball screw, guide, bearing, stepper

    def test_full_assembly_check_geometry_passes(self):
        self.m.check_geometry(self.m.gen_step())  # validity + interference + sweep

    def test_carriage_actually_travels_over_the_sweep(self):
        # Guard against a vacuous sweep: the carriage group must move by the full
        # stroke between the pose endpoints, so the swept poses really exercise
        # motion (a static scene swept N times would prove nothing).
        p0 = dict(self.m.pose(0.0))
        p1 = dict(self.m.pose(1.0))
        dx = p1["screw_nut"].bounding_box().min.X - p0["screw_nut"].bounding_box().min.X
        self.assertAlmostEqual(dx, self.m.STROKE, delta=1.0)


class XyzPickPlaceGantryGateTests(unittest.TestCase):
    """Multi-axis gate: three SELECTED motorized screw axes (X, Y, Z) plus four
    SELECTED pneumatic nozzles assemble AND travel penetration-free over every
    axis stroke and the cylinder down-stroke (four motion sweeps, not just seated)."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_model("xyz_pickplace_gantry", "xyz_pickplace_gantry")

    def test_each_axis_selects_four_families_and_nozzle_is_selected(self):
        for sel in (self.m.X_SEL, self.m.Y_SEL, self.m.Z_SEL):
            models = {
                sel["screw"]["model"], sel["guide"]["model"],
                sel["bearing"]["model"], sel["motor"]["model"],
            }
            self.assertEqual(len(models), 4)  # ball screw, guide, bearing, stepper
        self.assertIn("model", self.m.CYL_SPEC)
        self.assertGreater(self.m.CYL_SPEC["selected_for"]["margin"], 1.0)

    def test_full_assembly_check_geometry_passes(self):
        self.m.check_geometry(self.m.gen_step())  # validity + interference + 4 sweeps

    def test_every_dof_actually_travels_over_the_sweep(self):
        # Displacement-flavor anti-vacuous guard: each carriage group (and a
        # nozzle) must actually displace by its full stroke between pose endpoints,
        # so the four swept DOFs really exercise motion -- a static scene swept N
        # times would prove nothing. Covers X/Y/Z travel + one cylinder down-stroke.
        m = self.m

        def lo(frame, name, axis):
            return getattr(dict(frame)[name].bounding_box().min, axis)

        seat = m.pose()
        self.assertAlmostEqual(
            lo(m.pose(x=m.X_STROKE), "x_carriage_body", "X") - lo(seat, "x_carriage_body", "X"),
            m.X_STROKE, delta=1.0)
        self.assertAlmostEqual(
            lo(m.pose(y=m.Y_STROKE), "y_carriage_body", "Y") - lo(seat, "y_carriage_body", "Y"),
            m.Y_STROKE, delta=1.0)
        self.assertAlmostEqual(
            lo(m.pose(z=m.Z_STROKE), "z_carriage_body", "Z") - lo(seat, "z_carriage_body", "Z"),
            -m.Z_STROKE, delta=1.0)  # the Z carriage DESCENDS as z grows
        self.assertAlmostEqual(
            lo(m.pose(e=(m.CYL_STROKE, 0, 0, 0)), "nozzle0", "Z") - lo(seat, "nozzle0", "Z"),
            -m.CYL_STROKE, delta=1.0)  # nozzle 0 fires down on its own extension


class LinearPickStationGateTests(unittest.TestCase):
    """Gripper dogfood gate: a SELECTED linear guide + SELECTED parallel gripper
    assemble AND travel (carriage traverse + jaw open) penetration-free over both
    sweeps -- the gripper family's capstone, mirroring the other families'."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_model("linear_pick_station", "linear_pick_station")

    def test_consumes_two_selected_families(self):
        for spec in (self.m.GUIDE_SPEC, self.m.GRIPPER_SPEC):
            self.assertIn("model", spec)
            self.assertGreater(spec["selected_for"]["margin"], 1.0)
        # a linear guide and a gripper, not the same catalog row
        self.assertNotEqual(self.m.GUIDE_SPEC["model"], self.m.GRIPPER_SPEC["model"])

    def test_full_assembly_check_geometry_passes(self):
        self.m.check_geometry(self.m.gen_step())  # validity + interference + 2 sweeps

    def test_carriage_and_jaws_actually_travel(self):
        # anti-vacuous: the carriage displaces by the full traverse, and a finger by
        # half the gripper stroke, so both swept DOFs really exercise motion (a
        # static scene swept N times would prove nothing).
        def lo(frame, name):
            return dict(frame)[name].bounding_box().min.X

        seat = self.m.pose(0.0, 0.0)
        self.assertAlmostEqual(
            lo(self.m.pose(1.0, 0.0), "guide_block") - lo(seat, "guide_block"),
            self.m.TRAVERSE, delta=1.0)
        self.assertAlmostEqual(
            lo(self.m.pose(0.0, 1.0), "gripper_jaw_a") - lo(seat, "gripper_jaw_a"),
            -self.m.G_STROKE / 2.0, delta=0.01)  # jaw_a opens toward -X


if __name__ == "__main__":
    unittest.main()
