"""``cadpy.part_cache``: a part generator's result is reused, and a reused part is
indistinguishable from a rebuilt one -- same geometry, same stable names, same made-by."""

from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path

try:
    import build123d  # noqa: F401

    HAVE_KERNEL = True
except Exception:  # noqa: BLE001
    HAVE_KERNEL = False

from cadpy import part_cache
from cadpy.part_cache import _UNCACHEABLE, _freeze

SOURCE = '''
from build123d import Box, Compound, Cylinder, Pos
from cadpy.assembly import label_shape
from cadpy.part_cache import cached_part

CALLS = []


@cached_part
def bracket(length=60.0, holes=2, *, label="bracket"):
    CALLS.append((length, holes))
    body = Box(length, 30, 8)
    for i in range(holes):
        body = body - Pos(-length / 2 + (i + 1) * length / (holes + 1), 0, 0) * Cylinder(3, 8)
    pin = Pos(0, 0, 8) * Cylinder(2, 8)
    return Compound(label=label, children=[label_shape(body, label + "_body"), label_shape(pin, label + "_pin")])


def assembly(length=60.0):
    left = bracket(length, 2, label="left")
    right = Pos(100, 0, 0) * bracket(length, 2, label="right")
    twin = Pos(0, 80, 0) * bracket(length, 2, label="left")     # same arguments as `left`
    return left, right, twin
'''


class Freeze(unittest.TestCase):
    def test_plain_data_is_a_stable_key(self) -> None:
        self.assertEqual(_freeze({"b": [1, 2.0], "a": None}), _freeze({"a": None, "b": [1, 2.0]}))
        self.assertNotEqual(_freeze(1), _freeze(1.0))          # an int and a float are different arguments
        self.assertNotEqual(_freeze([1, 2]), _freeze((1, 2)))
        self.assertNotEqual(_freeze(True), _freeze(1))
        hash(_freeze(((1, "x"), {"k": {"n": [1, 2, (3, 4)]}})))

    def test_anything_else_is_not_cacheable(self) -> None:
        for value in (object(), {1.5: "x"}, [1, object()], {"a": {"b": {3, 4}}}, b"bytes"):
            self.assertIs(_freeze(value), _UNCACHEABLE, value)


@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class CachedPart(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from cadpy.kernel import naming

        cls.naming = naming
        cls.dir = Path(tempfile.mkdtemp(prefix="cadpy-part-cache-"))
        path = cls.dir / "gen_cache.py"
        path.write_text(SOURCE, encoding="utf-8")
        spec = importlib.util.spec_from_file_location(path.stem, path)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)
        cls.was_installed = naming.installed()
        naming.install()

    @classmethod
    def tearDownClass(cls) -> None:
        if not cls.was_installed:
            cls.naming.uninstall()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self) -> None:
        part_cache.clear()
        self.module.CALLS.clear()
        os.environ.pop(part_cache.ENV_SWITCH, None)

    def tearDown(self) -> None:
        os.environ.pop(part_cache.ENV_SWITCH, None)
        part_cache.clear()

    def _named(self, shapes) -> list:
        return [(child.label, child) for shape in shapes for child in shape.children]

    def _build(self, length=60.0):
        from cadpy import assembly

        assembly.reset_made_by()
        with self.naming.recording() as records:
            shapes = self.module.assembly(length)
            named = [(f"{i}:{name}", shape) for i, (name, shape) in enumerate(self._named(shapes))]
            names = self.naming.name_parts(named, records, budget_s=None)
        return shapes, names, assembly.made_by()

    def test_second_call_is_a_hit_and_returns_its_own_object(self) -> None:
        first = self.module.bracket(60.0, 2)
        second = self.module.bracket(60.0, 2)
        self.assertEqual(self.module.CALLS, [(60.0, 2)])
        self.assertEqual((part_cache.stats()["hits"], part_cache.stats()["misses"]), (1, 1))
        self.assertIsNot(first, second)
        self.assertAlmostEqual(first.volume, second.volume, places=6)
        self.assertEqual([c.label for c in second.children], ["bracket_body", "bracket_pin"])

    def test_what_a_caller_does_to_its_copy_stays_with_that_copy(self) -> None:
        from build123d import Location

        first = self.module.bracket(60.0, 2)
        first.label = "mine"
        first.children[0].label = "renamed"
        first.location = Location((500, 0, 0))
        second = self.module.bracket(60.0, 2)
        self.assertEqual(second.label, "bracket")
        self.assertEqual([c.label for c in second.children], ["bracket_body", "bracket_pin"])
        self.assertAlmostEqual(second.bounding_box().center().X, 0.0, places=6)

    def test_different_arguments_are_different_parts_and_keywords_count(self) -> None:
        self.module.bracket(60.0, 2)
        self.module.bracket(60.0, 3)
        self.module.bracket(60.0, 2, label="other")
        self.module.bracket(60, 2)           # an int length is another key
        self.assertEqual(len(self.module.CALLS), 4)

    def test_a_reused_part_is_named_exactly_like_a_rebuilt_one(self) -> None:
        _a, cold, _ = self._build()          # nothing cached: the twin call is the first hit
        self.assertEqual(len(self.module.CALLS), 2)
        _b, warm, _ = self._build()          # everything cached
        self.assertEqual(len(self.module.CALLS), 2)
        self.assertEqual(warm["parts"], cold["parts"])
        for table in cold["parts"].values():
            self.assertTrue(all(table["f"]) and all(table["e"]))
        os.environ[part_cache.ENV_SWITCH] = "0"
        part_cache.clear()
        _c, off, _ = self._build()           # no cache at all: every call builds
        self.assertEqual(len(self.module.CALLS), 5)
        self.assertEqual(off["parts"], cold["parts"])

    def test_names_survive_a_rebuild_where_only_some_parts_are_reused(self) -> None:
        _a, before, _ = self._build(60.0)
        part_cache.clear()
        self.module.bracket(60.0, 2, label="right")      # only `right` is cached going in
        _b, after, _ = self._build(60.0)
        self.assertEqual(after["parts"], before["parts"])

    def test_made_by_points_at_the_calling_line_hit_or_miss(self) -> None:
        _a, _names, cold = self._build()
        _b, _names, warm = self._build()
        self.assertEqual(warm, cold)
        self.assertEqual(cold["right_body"]["file"], "gen_cache.py")
        self.assertEqual(cold["right_body"]["func"], "assembly")
        # `left` is labelled twice (the twin); the later call's line is the one on record
        self.assertEqual(cold["left_body"]["line"], cold["right_body"]["line"] + 1)

    def test_an_entry_built_outside_a_recording_is_not_used_inside_one(self) -> None:
        self.module.bracket(60.0, 2, label="left")       # no recording: no makers kept
        with self.naming.recording() as records:
            shape = self.module.bracket(60.0, 2, label="left")
            names = self.naming.name_parts(self._named([shape]), records, budget_s=None)
        self.assertEqual(len(self.module.CALLS), 2)       # built again, so it has names
        self.assertTrue(all(names["parts"]["left_body"]["f"]))
        self.module.bracket(60.0, 2, label="left")       # and that entry serves both
        self.assertEqual(len(self.module.CALLS), 2)

    def test_bounded_switchable_and_bypassed_for_non_data_arguments(self) -> None:
        saved = part_cache.MAX_ENTRIES
        part_cache.MAX_ENTRIES = 2
        try:
            for holes in (1, 2, 3):
                self.module.bracket(60.0, holes)
            self.assertEqual(part_cache.stats()["entries"], 2)
            self.module.bracket(60.0, 1)                  # the oldest was dropped
            self.assertEqual(len(self.module.CALLS), 4)
        finally:
            part_cache.MAX_ENTRIES = saved
        os.environ[part_cache.ENV_SWITCH] = "0"
        self.module.bracket(60.0, 3)
        self.module.bracket(60.0, 3)
        self.assertEqual(len(self.module.CALLS), 6)
        os.environ.pop(part_cache.ENV_SWITCH)
        before = part_cache.stats()["bypassed"]
        with self.assertRaises(Exception):
            self.module.bracket(object(), 2)              # not plain data: called straight through
        self.assertEqual(part_cache.stats()["bypassed"], before + 1)


@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class StandardParts(unittest.TestCase):
    def setUp(self) -> None:
        part_cache.clear()

    def tearDown(self) -> None:
        part_cache.clear()

    def test_the_standard_part_generators_are_cached(self) -> None:
        from cadpy import parts

        for name in ("linear_guide", "ball_screw", "deep_groove_bearing", "stepper_motor",
                     "pneumatic_cylinder", "gripper", "gear", "gear_rack", "swept_solid",
                     "cleanroom_sleeve", "kcl_clamp"):
            self.assertTrue(getattr(getattr(parts, name), "__cached_part__", False), name)

    def test_a_real_part_comes_back_the_same(self) -> None:
        from cadpy.parts import linear_guide

        first = linear_guide(15, 13, 200, 34, 24, 40)
        second = linear_guide(15, 13, 200, 34, 24, 40)
        self.assertEqual(part_cache.stats()["hits"], 1)
        self.assertIsNot(first, second)
        self.assertAlmostEqual(first.volume, second.volume, places=6)
        self.assertEqual([c.label for c in first.children], [c.label for c in second.children])


if __name__ == "__main__":
    unittest.main()
