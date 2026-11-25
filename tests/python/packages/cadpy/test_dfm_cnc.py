"""``cadpy.dfm_cnc``: machining recommendations measured on a part's geometry."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

try:
    import build123d  # noqa: F401

    HAVE_KERNEL = True
except Exception:  # noqa: BLE001
    HAVE_KERNEL = False

from cadpy.dfm_cnc import cnc_advisories, machined_parts


class MachinedDeclaration(unittest.TestCase):
    def test_reads_the_module_declaration(self) -> None:
        labels = ["base", "arm", "motor"]
        self.assertEqual(machined_parts(SimpleNamespace(), labels), [])
        self.assertEqual(machined_parts(SimpleNamespace(MACHINED=True), labels), labels)
        self.assertEqual(machined_parts(SimpleNamespace(MACHINED=["arm", "ghost"]), labels), ["arm"])
        self.assertEqual(machined_parts(SimpleNamespace(MACHINED="base"), labels), ["base"])
        self.assertEqual(machined_parts(SimpleNamespace(MACHINED=False), labels), [])
        self.assertEqual(machined_parts(SimpleNamespace(MACHINED=3), labels), [])


@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class CncAdvisories(unittest.TestCase):
    def setUp(self) -> None:
        from build123d import Box, Pos

        self.block = Box(80, 60, 30)
        self.pocket = Pos(0, 0, 5) * Box(40, 30, 20)

    def _rules(self, shape) -> dict:
        return {a["rule"]: a for a in cnc_advisories([("p", shape)])}

    def test_closed_pocket_with_sharp_upright_corners(self) -> None:
        found = self._rules(self.block - self.pocket)
        self.assertEqual(list(found), ["cnc.sharp_internal_corner"])
        corner = found["cnc.sharp_internal_corner"]
        self.assertEqual((corner["value"], corner["severity"], corner["refs"]), (4.0, "warning", ["p"]))
        self.assertIn("最長 20 mm", corner["message"])

    def test_through_window_with_sharp_corners(self) -> None:
        from build123d import Box

        self.assertEqual(self._rules(self.block - Box(40, 30, 30))["cnc.sharp_internal_corner"]["value"], 4.0)

    def test_corners_an_end_mill_reaches_are_not_reported(self) -> None:
        from build123d import Box, Pos

        self.assertEqual(self._rules(self.block), {})
        self.assertEqual(self._rules(self.block - Pos(20, 0, 10) * Box(40, 60, 10)), {})       # a step
        self.assertEqual(self._rules(self.block - Pos(20, 0, 5) * Box(40, 20, 20)), {})        # slot open at one end
        self.assertEqual(self._rules(Box(40, 40, 10) + Pos(0, 0, 10) * Box(10, 10, 10)), {})   # a boss: convex corners

    def test_rounded_corners_pass_until_the_round_is_too_small_for_its_height(self) -> None:
        from build123d import Axis, fillet

        upright = self.pocket.edges().filter_by(Axis.Z)
        self.assertEqual(self._rules(self.block - fillet(upright, 3)), {})        # 20 / 6 = 3.3
        found = self._rules(self.block - fillet(upright, 1))                      # 20 / 2 = 10
        self.assertEqual(list(found), ["cnc.deep_corner"])
        deep = found["cnc.deep_corner"]
        self.assertEqual((deep["value"], deep["limit"]), (10.0, 4.0))
        self.assertIn("共 4 處", deep["message"])   # all four, whichever way each round's surface is handed

    def test_a_fillet_along_the_foot_of_an_open_step_is_not_a_corner(self) -> None:
        from build123d import Axis, Box, Pos, fillet

        step = Box(100, 60, 30) - Pos(0, 15, 10) * Box(100, 30, 10)
        foot = [e for e in step.edges().filter_by(Axis.X) if abs(e.center().Y) < 1e-6 and abs(e.center().Z - 5) < 1e-6]
        self.assertEqual(len(foot), 1)
        self.assertEqual(self._rules(fillet(foot, 2)), {})     # 100 long, R2: a ball mill's, from above

    def test_the_answer_does_not_depend_on_how_busy_the_machine_is(self) -> None:
        part = self.block - self.pocket
        self.assertEqual(cnc_advisories([("p", part)]), cnc_advisories([("p", part)]))
        # Out of budget part-way through: nothing for that part, never half a list.
        self.assertEqual(cnc_advisories([("p", part)], max_queries=10), [])

    def test_deep_and_tiny_holes(self) -> None:
        from build123d import Box, Cylinder, Pos

        part = Box(30, 30, 50) - Pos(0, 0, 5) * Cylinder(1.5, 40) - Pos(8, 0, 0) * Cylinder(0.4, 50)
        found = self._rules(part)
        self.assertEqual(sorted(found), ["cnc.deep_hole", "cnc.small_hole"])
        self.assertIn("共 2 個", found["cnc.deep_hole"]["message"])
        self.assertEqual(found["cnc.small_hole"]["value"], 0.8)
        ok = Box(30, 30, 20) - Cylinder(3, 20)
        self.assertEqual(self._rules(ok), {})

    def test_each_part_is_reported_by_its_own_name_and_nothing_raises(self) -> None:
        found = cnc_advisories([("good", self.block), ("bad", self.block - self.pocket), ("junk", object())])
        self.assertEqual([(a["rule"], a["refs"]) for a in found], [("cnc.sharp_internal_corner", ["bad"])])
        self.assertTrue(found[0]["message"].startswith("bad: "))
        self.assertEqual(cnc_advisories([("bad", self.block - self.pocket)], max_queries=0), [])

    def test_findings_accept_the_rules(self) -> None:
        from cadpy.findings import RULES, advisory_findings

        found = advisory_findings(cnc_advisories([("p", self.block - self.pocket)]))
        self.assertEqual([(f.rule, f.status) for f in found], [("cnc.sharp_internal_corner", "warning")])
        for rule in ("cnc.sharp_internal_corner", "cnc.deep_corner", "cnc.deep_hole", "cnc.small_hole"):
            self.assertIn(rule, RULES)


if __name__ == "__main__":
    unittest.main()
