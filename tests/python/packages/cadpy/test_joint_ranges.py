"""``cadpy.joint_ranges``: the outward search for the first collision beyond each end of a stroke."""

from __future__ import annotations

import unittest

from cadpy.joint_ranges import free_travel


def obstacle(start: float | None = None, end: float | None = None, name: str = "stop"):
    """collides(u) for something in the way on ``[start, end]`` (None = unbounded on that side)."""
    def collides(u: float):
        if (start is None or u >= start) and (end is None or u <= end):
            return name
        return None
    return collides


def either(*checks):
    def collides(u: float):
        for check in checks:
            hit = check(u)
            if hit:
                return hit
        return None
    return collides


class FreeTravelTests(unittest.TestCase):
    def test_stop_beyond_the_end_is_bracketed_to_the_tolerance(self) -> None:
        result = free_travel(obstacle(start=1.23), step=0.05, max_extent=0.5)
        self.assertEqual(result.upper.hit, "stop")
        self.assertFalse(result.upper.blocked)
        self.assertLessEqual(result.upper.u, 1.23)
        self.assertGreater(result.upper.u, 1.23 - 0.05 / 16 - 1e-12)   # 預設容差 = step / 16
        self.assertAlmostEqual(result.margin_after, 0.23, delta=0.05 / 16)
        # 另一側沒有東西:走到搜尋範圍的邊界,沒有止點
        self.assertTrue(result.lower.open)
        self.assertAlmostEqual(result.lower.u, -0.5, places=9)
        self.assertAlmostEqual(result.margin_before, 0.5, places=9)

    def test_stops_on_both_sides(self) -> None:
        result = free_travel(either(obstacle(start=1.1, name="front"), obstacle(end=-0.2, name="back")), step=0.05)
        self.assertEqual((result.upper.hit, result.lower.hit), ("front", "back"))
        self.assertAlmostEqual(result.margin_after, 0.1, delta=0.004)
        self.assertAlmostEqual(result.margin_before, 0.2, delta=0.004)

    def test_nothing_in_the_way_is_open_on_both_sides(self) -> None:
        result = free_travel(lambda u: None, step=0.1, max_extent=0.3)
        self.assertTrue(result.upper.open and result.lower.open)
        self.assertAlmostEqual(result.upper.u, 1.3, places=9)
        self.assertAlmostEqual(result.lower.u, -0.3, places=9)

    def test_an_end_that_already_collides_is_blocked_and_not_searched_past(self) -> None:
        seen = []

        def collides(u: float):
            seen.append(u)
            return "wall" if u >= 0.98 else None

        result = free_travel(collides, step=0.05)
        self.assertTrue(result.upper.blocked)
        self.assertEqual((result.upper.u, result.upper.hit), (1.0, "wall"))
        self.assertEqual(result.margin_after, 0.0)
        self.assertEqual([u for u in seen if u > 1.0], [])   # 終點已經撞到,不再往外找
        self.assertTrue(result.lower.open)

    def test_tolerance_controls_how_tightly_the_limit_is_bracketed(self) -> None:
        loose = free_travel(obstacle(start=1.237), step=0.1, tolerance=0.05)
        tight = free_travel(obstacle(start=1.237), step=0.1, tolerance=0.001)
        self.assertLessEqual(1.237 - loose.upper.u, 0.05 + 1e-12)
        self.assertLessEqual(1.237 - tight.upper.u, 0.001 + 1e-12)
        self.assertGreater(tight.evaluations, loose.evaluations)

    def test_evaluation_count_is_bounded(self) -> None:
        result = free_travel(lambda u: None, step=0.05, max_extent=0.5)
        self.assertEqual(result.evaluations, 2 * (1 + 10))   # 每側:端點 1 次 + 往外 10 步
        hit = free_travel(obstacle(start=1.23), step=0.05, max_extent=0.5)
        self.assertLess(hit.evaluations, 2 * (1 + 10) + 8)

    def test_the_limit_never_lands_inside_the_obstacle(self) -> None:
        for edge in (1.001, 1.049, 1.05, 1.333, 1.499):
            result = free_travel(obstacle(start=edge), step=0.05, max_extent=0.5)
            self.assertLess(result.upper.u, edge, edge)
            self.assertIsNone(obstacle(start=edge)(result.upper.u))

    def test_a_thin_obstacle_between_strides_is_missed_as_documented(self) -> None:
        # 0.012 寬的障礙落在兩步之間:搜尋看不到。文件寫明 step 不可大於擋路物的厚度。
        result = free_travel(obstacle(start=1.071, end=1.083), step=0.05, max_extent=0.2)
        self.assertTrue(result.upper.open)
        seen = free_travel(obstacle(start=1.071, end=1.083), step=0.01, max_extent=0.2)
        self.assertEqual(seen.upper.hit, "stop")

    def test_bad_arguments(self) -> None:
        for kwargs in ({"step": 0}, {"step": -0.1}, {"max_extent": -1}, {"tolerance": 0}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                free_travel(lambda u: None, **kwargs)


if __name__ == "__main__":
    unittest.main()
