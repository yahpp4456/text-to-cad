"""``cadpy.holes``: holes found on a part's geometry, grouped, and written as drawing callouts."""

from __future__ import annotations

import unittest

try:
    import build123d  # noqa: F401

    HAVE_KERNEL = True
except Exception:  # noqa: BLE001
    HAVE_KERNEL = False

from cadpy.holes import Hole, HoleGroup, callout_text, find_holes, group_holes


def _plate():
    from build123d import Box, Cylinder, Pos, Rot

    plate = Box(100, 60, 12)
    for x, y in ((-40, -20), (40, -20), (-40, 20), (40, 20)):
        plate -= Pos(x, y, 0) * Cylinder(3.3, 12)                 # 4 個 ⌀6.6 通孔
    plate -= Pos(0, 0, 2) * Cylinder(2.5, 8)                      # 盲孔 ⌀5 深 8,開口在上
    plate -= Pos(20, 0, 0) * Cylinder(3.3, 12)                    # 沉頭孔的通孔
    plate -= Pos(20, 0, 6 - 3.25) * Cylinder(5.5, 6.5)            # 沉頭 ⌀11 深 6.5,在上
    plate -= Pos(-20, 0, 0) * Rot(90, 0, 0) * Cylinder(2, 60)     # 沿 Y 的橫向通孔 ⌀4
    plate += Pos(0, 20, 10) * Cylinder(4, 8)                      # 凸柱:不是孔
    return plate


class CalloutText(unittest.TestCase):
    def _group(self, n=1, **kw):
        base = dict(direction=(0, 0, 1), diameter=6.6, depth=None, thru=True, cbore=None)
        base.update(kw)
        g = HoleGroup(**base)
        g.holes = [Hole((0, 0, 0), (0, 0, 1), base["diameter"], 1.0, base["thru"])] * n
        return g

    def test_symbols(self):
        self.assertEqual(callout_text(self._group(4)), "4× ⌀6.6 THRU")
        self.assertEqual(callout_text(self._group(1)), "⌀6.6 THRU")
        self.assertEqual(callout_text(self._group(2, diameter=5.0, depth=12.0, thru=False)), "2× ⌀5 ↧12")
        self.assertEqual(callout_text(self._group(1, cbore=(11.0, 6.5))), "⌀6.6 THRU  ⌴ ⌀11 ↧6.5")
        self.assertEqual(callout_text(self._group(1), diameter_sign="D"), "D6.6 THRU")
        self.assertEqual(callout_text(self._group(1, cbore=(11.0, 6.5)), cbore_sign="CBORE"),
                         "⌀6.6 THRU  CBORE ⌀11 ↧6.5")


@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class FindHoles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.holes = find_holes(_plate())
        cls.groups = group_holes(cls.holes)
        cls.by_text = {callout_text(g): g for g in cls.groups}

    def test_finds_each_kind_once_and_ignores_the_boss(self):
        self.assertEqual(sorted(self.by_text), sorted([
            "4× ⌀6.6 THRU", "⌀4 THRU", "⌀5 ↧8", "⌀6.6 THRU  ⌴ ⌀11 ↧6.5",
        ]))
        self.assertEqual(len(self.holes), 7)

    def test_pattern_members_and_their_positions(self):
        four = self.by_text["4× ⌀6.6 THRU"]
        self.assertEqual(sorted((h.top[0], h.top[1]) for h in four.holes),
                         [(-40.0, -20.0), (-40.0, 20.0), (40.0, -20.0), (40.0, 20.0)])
        self.assertTrue(all(h.thru and h.depth == 12.0 for h in four.holes))

    def test_blind_hole_opens_at_its_mouth_and_points_into_the_part(self):
        (blind,) = self.by_text["⌀5 ↧8"].holes
        self.assertEqual(blind.top, (0.0, 0.0, 6.0))
        self.assertEqual(blind.direction, (0.0, 0.0, -1.0))
        self.assertFalse(blind.thru)

    def test_counterbore_is_one_hole_with_its_mouth_at_the_wide_end(self):
        (stepped,) = self.by_text["⌀6.6 THRU  ⌴ ⌀11 ↧6.5"].holes
        self.assertEqual(stepped.top, (20.0, 0.0, 6.0))
        self.assertEqual(stepped.direction, (0.0, 0.0, -1.0))
        self.assertEqual(stepped.cbore, (11.0, 6.5))
        self.assertTrue(stepped.thru)

    def test_cross_hole_has_its_own_direction(self):
        group = self.by_text["⌀4 THRU"]
        self.assertEqual(tuple(abs(c) for c in group.direction), (0.0, 1.0, 0.0))

    def test_order_is_stable(self):
        self.assertEqual([callout_text(g) for g in self.groups][0], "4× ⌀6.6 THRU")
        again = [callout_text(g) for g in group_holes(find_holes(_plate()))]
        self.assertEqual(again, [callout_text(g) for g in self.groups])


@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class NotHoles(unittest.TestCase):
    def test_solid_without_holes_and_a_plain_shaft(self):
        from build123d import Box, Cylinder

        self.assertEqual(find_holes(Box(10, 10, 10)), [])
        self.assertEqual(find_holes(Cylinder(5, 20)), [])

    def test_closed_cavity_and_half_round_notch_are_not_called_out(self):
        from build123d import Box, Cylinder, Pos

        cavity = Box(30, 30, 30) - Cylinder(5, 10)                 # 封在裡面,兩端都是料
        self.assertEqual(find_holes(cavity), [])
        notch = Box(30, 30, 10) - Pos(15, 0, 0) * Cylinder(5, 10)  # 邊上的半圓缺口:不是整圈
        self.assertEqual(find_holes(notch), [])

    def test_holes_in_every_part_of_an_assembly(self):
        from build123d import Box, Compound, Cylinder, Pos

        a = Box(20, 20, 5) - Cylinder(2, 5)
        b = Pos(50, 0, 0) * (Box(20, 20, 5) - Cylinder(2, 5))
        groups = group_holes(find_holes(Compound(children=[a, b])))
        self.assertEqual([callout_text(g) for g in groups], ["2× ⌀4 THRU"])




@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class MirroredParts(unittest.TestCase):
    """A mirrored feature's cylinder surface is left-handed: its own normal points at the
    axis, so the face's orientation flag alone says the opposite of the truth."""

    def test_holes_and_bosses_are_told_apart_after_a_mirror(self):
        from build123d import Box, Cylinder, Plane, Pos, mirror

        part = Box(40, 20, 10) - Pos(10, 0, 0) * Cylinder(3, 10) + Pos(-10, 0, 8) * Cylinder(3, 6)
        for shape in (part, mirror(part, about=Plane.YZ), mirror(part, about=Plane.XZ)):
            groups = group_holes(find_holes(shape))
            self.assertEqual([callout_text(g) for g in groups], ["⌀6 THRU"])

@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class ReviewedCases(unittest.TestCase):
    """Shapes an independent review found the first version got wrong."""

    def _texts(self, shape):
        return sorted(callout_text(g) for g in group_holes(find_holes(shape)))

    def test_two_blind_holes_on_one_axis_are_two_holes_not_one_through_hole(self):
        from build123d import Box, Cylinder, Pos

        block = Box(40, 40, 20) - Pos(0, 0, 7.5) * Cylinder(3, 5) - Pos(0, 0, -7.5) * Cylinder(3, 5)
        holes = find_holes(block)
        self.assertEqual(len(holes), 2)
        self.assertTrue(all(not h.thru and h.depth == 5.0 for h in holes))
        self.assertEqual(sorted(h.top[2] for h in holes), [-10.0, 10.0])
        self.assertEqual({h.direction[2] for h in holes}, {-1.0, 1.0})

    def test_counterbored_from_both_sides_is_not_a_plain_wide_through_hole(self):
        from build123d import Box, Cylinder, Pos

        block = Box(40, 40, 20) - Cylinder(3, 20) - Pos(0, 0, 8) * Cylinder(5, 4) - Pos(0, 0, -8) * Cylinder(5, 4)
        self.assertNotIn("⌀10 THRU", self._texts(block))   # three steps: left to a hand-written note
        self.assertEqual(find_holes(block), [])

    def test_a_drilled_or_ball_bottom_is_a_bottom(self):
        from build123d import Box, Cone, Cylinder, Pos, Sphere

        drilled = Box(30, 30, 30) - Pos(0, 0, 5) * Cylinder(3, 20) - Pos(0, 0, -5.9) * Cone(0, 3, 1.8)
        (hole,) = find_holes(drilled)
        self.assertEqual((hole.thru, hole.depth, hole.top, hole.direction), (False, 20.0, (0.0, 0.0, 15.0), (0.0, 0.0, -1.0)))
        ball = Box(30, 30, 30) - Pos(0, 0, 5) * Cylinder(3, 20) - Pos(0, 0, -5) * Sphere(3)
        (hole,) = find_holes(ball)
        self.assertEqual((hole.thru, hole.top), (False, (0.0, 0.0, 15.0)))

    def test_a_groove_inside_a_bore_is_not_a_hole_and_the_bore_runs_through_it(self):
        from build123d import Box, Cylinder, Pos

        bore = Box(40, 40, 30) - Cylinder(5, 30) - Pos(0, 0, 3) * Cylinder(6, 2)
        self.assertEqual(self._texts(bore), ["⌀10 THRU"])
        self.assertEqual(find_holes(bore)[0].depth, 30.0)

    def test_a_hole_into_a_closed_cavity_is_the_hole_not_a_counterbore(self):
        from build123d import Box, Cylinder, Pos

        block = Box(40, 40, 30) - Pos(0, 0, 10) * Cylinder(3, 10) - Pos(0, 0, 3) * Cylinder(6, 4)
        (hole,) = find_holes(block)
        self.assertIsNone(hole.cbore)
        self.assertEqual((hole.diameter, hole.depth, hole.top, hole.direction), (6.0, 10.0, (0.0, 0.0, 15.0), (0.0, 0.0, -1.0)))

    def test_a_hole_through_one_wall_of_a_channel_is_through(self):
        from build123d import Box, Cylinder, Pos, Rot

        channel = Box(60, 40, 40) - Pos(0, 0, 5) * Box(60, 30, 35)          # U: two walls 30 apart
        drilled = channel - Pos(0, 17.5, 5) * Rot(90, 0, 0) * Cylinder(2, 5)  # one wall only
        self.assertEqual(self._texts(drilled), ["⌀4 THRU"])


if __name__ == "__main__":
    unittest.main()
