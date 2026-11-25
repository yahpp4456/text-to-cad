"""``cadpy.kernel.naming``: names for faces and edges that survive a rebuild, and the line that made each."""

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

SOURCE = '''
from build123d import Axis, Box, Cylinder, Pos, fillet

def make(length=100.0, holes=2, radius=3.0):
    body = Box(length, 40, 10)
    for i in range(holes):
        body = body - Pos(-length / 2 + (i + 1) * length / (holes + 1), 0, 0) * Cylinder(4, 10)
    body = fillet(body.edges().filter_by(Axis.Z), radius)
    boss = Pos(0, 0, 8) * Cylinder(6, 6)
    return body + boss

def placed():
    return Pos(50, 0, 0) * Box(10, 20, 30)
'''
LINE = {"box": 5, "cut": 7, "fillet": 8, "boss": 9, "placed": 13}


def _centre(face) -> tuple:
    return tuple(round(v, 4) for v in tuple(face.center()))


@unittest.skipUnless(HAVE_KERNEL, "needs build123d")
class NamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from cadpy.kernel import naming

        cls.naming = naming
        cls.dir = Path(tempfile.mkdtemp(prefix="cadpy-naming-"))
        cls.was_installed = naming.installed()
        naming.install()

    @classmethod
    def tearDownClass(cls) -> None:
        if not cls.was_installed:
            cls.naming.uninstall()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def _module(self, source: str = SOURCE, stem: str = "gen"):
        path = self.dir / f"{stem}_{abs(hash(source)) % 10**8}.py"
        path.write_text(source, encoding="utf-8")
        spec = importlib.util.spec_from_file_location(path.stem, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _build(self, *args, source: str = SOURCE, fn: str = "make", label: str = "p", **kwargs):
        module = self._module(source)
        with self.naming.recording() as records:
            shape = getattr(module, fn)(*args, **kwargs)
        return shape, self.naming.name_parts([(label, shape)], records, budget_s=None)

    def test_every_face_and_edge_gets_a_unique_name_and_a_rebuild_repeats_them(self) -> None:
        shape, names = self._build()
        faces, edges = names["parts"]["p"]["f"], names["parts"]["p"]["e"]
        self.assertEqual(len(faces), len(shape.faces()))
        self.assertEqual(len(edges), len(shape.edges()))
        self.assertTrue(all(faces) and all(edges))
        self.assertEqual(len(set(faces)), len(faces))
        self.assertRegex(faces[0], r"^[0-9a-f]{10}$")
        _again, repeat = self._build()
        self.assertEqual(repeat["parts"], names["parts"])

    def test_changing_a_dimension_keeps_every_name_in_place(self) -> None:
        _a, before = self._build()
        for kwargs in ({"length": 140.0}, {"radius": 5.0}):
            _b, after = self._build(**kwargs)
            self.assertEqual(after["parts"], before["parts"], kwargs)

    def test_adding_a_hole_shifts_ordinals_but_names_still_find_the_same_faces(self) -> None:
        a_shape, a = self._build(holes=2)
        b_shape, b = self._build(holes=3)
        fa, fb = a["parts"]["p"]["f"], b["parts"]["p"]["f"]
        self.assertEqual(len(fb), len(fa) + 2)            # one more wall; the top keeps its name
        self.assertTrue(set(fa) <= set(fb))                # nothing that existed lost its name
        shifted = [name for name in fa if fa.index(name) != fb.index(name)]
        self.assertTrue(shifted, "this change is meant to move ordinals")
        a_faces, b_faces = a_shape.faces(), b_shape.faces()
        from build123d import GeomType

        for name in fa:
            before, after = a_faces[fa.index(name)], b_faces[fb.index(name)]
            self.assertEqual(before.geom_type, after.geom_type, name)
            if before.geom_type == GeomType.CYLINDER and abs(before.center().Z - 0.0) < 1e-6:
                continue  # a hole wall: "the n-th hole", which the new spacing moves
            self.assertEqual(_centre(before)[1:], _centre(after)[1:], name)
        # The boss's top face: same place, different ordinal, same name.
        top = next(i for i, f in enumerate(a_faces) if _centre(f) == (0.0, 0.0, 11.0))
        self.assertEqual(_centre(b_faces[fb.index(fa[top])]), (0.0, 0.0, 11.0))
        self.assertNotEqual(top, fb.index(fa[top]))

    def test_each_face_knows_the_line_that_made_it(self) -> None:
        shape, names = self._build()
        files, made = names["files"], names["lines"]["p"]["f"]
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith(".py"))
        self.assertTrue(all(entry and entry[0] == 0 for entry in made))
        self.assertEqual({entry[1] for entry in made}, {LINE["box"], LINE["cut"], LINE["fillet"], LINE["boss"]})
        from build123d import GeomType

        faces = shape.faces()
        for face, (_file, line) in zip(faces, made):
            c = _centre(face)
            if face.geom_type == GeomType.PLANE and c == (0.0, 0.0, 11.0):
                self.assertEqual(line, LINE["boss"])
            if face.geom_type == GeomType.PLANE and c[2] == -5.0:
                self.assertEqual(line, LINE["box"])     # the bottom: cut through and filleted, still the box's

    def test_names_do_not_depend_on_line_numbers_or_on_numeric_literals(self) -> None:
        _a, plain = self._build()
        _b, moved = self._build(source="\n\n# a comment\n\n" + SOURCE)
        self.assertEqual(moved["parts"], plain["parts"])
        self.assertNotEqual(moved["lines"], plain["lines"])
        _c, retuned = self._build(source=SOURCE.replace("Cylinder(4, 10)", "Cylinder(5.5, 10)"))
        self.assertEqual(retuned["parts"], plain["parts"])
        _d, other = self._build(source=SOURCE.replace("Cylinder(6, 6)", "Box(6, 6, 6)"))
        self.assertNotEqual(other["parts"], plain["parts"])   # a different feature is a different name

    def test_a_part_placed_after_it_was_made_is_still_what_that_line_made(self) -> None:
        _shape, names = self._build(fn="placed")
        self.assertEqual({entry[1] for entry in names["lines"]["p"]["f"]}, {LINE["placed"]})
        self.assertEqual(len(set(names["parts"]["p"]["f"])), 6)
        # Not the positional fallback: the same box under another label has the same names.
        _other, renamed = self._build(fn="placed", label="q")
        self.assertEqual(renamed["parts"]["q"], names["parts"]["p"])

    def test_parts_sharing_a_label_are_left_out_and_nothing_to_name_is_none(self) -> None:
        module = self._module()
        with self.naming.recording() as records:
            a, b, c = module.placed(), module.placed(), module.make()
        names = self.naming.name_parts([("twin", a), ("twin", b), ("solo", c)], records, budget_s=None)
        self.assertEqual(sorted(names["parts"]), ["solo"])
        self.assertIsNone(self.naming.name_parts([("twin", a), ("twin", b)], records, budget_s=None))
        self.assertIsNone(self.naming.name_parts([("solo", c)], [], budget_s=None))
        self.assertIsNone(self.naming.name_parts([], records, budget_s=None))

    def test_out_of_budget_or_too_large_means_no_names_not_an_error(self) -> None:
        module = self._module()
        with self.naming.recording() as records:
            shape = module.make()
        self.assertIsNone(self.naming.name_parts([("p", shape)], records, budget_s=-1.0))
        saved = self.naming.MAX_ELEMENTS
        self.naming.MAX_ELEMENTS = 3
        try:
            self.assertIsNone(self.naming.name_parts([("p", shape)], records, budget_s=None))
        finally:
            self.naming.MAX_ELEMENTS = saved
        saved = self.naming.MAX_RECORDS
        self.naming.MAX_RECORDS = len(records) - 1
        try:
            self.assertIsNone(self.naming.name_parts([("p", shape)], records, budget_s=None))
        finally:
            self.naming.MAX_RECORDS = saved

    def test_a_build_that_ran_out_of_time_is_not_tried_again_until_it_is_smaller(self) -> None:
        module = self._module()
        with self.naming.recording() as records:
            shape = module.make()
        self.naming._TOO_LARGE.clear()
        try:
            self.assertIsNone(self.naming.name_parts([("p", shape)], records, budget_s=-1.0))
            self.assertEqual(list(self.naming._TOO_LARGE.values()), [len(records)])
            # plenty of budget now, but the same build: skipped without trying
            self.assertIsNone(self.naming.name_parts([("p", shape)], records, budget_s=60.0))
            # a smaller build of the same file is tried, and clears the mark when it fits
            self.assertIsNotNone(self.naming.name_parts([("p", shape)], records[:-1], budget_s=60.0))
            self.assertEqual(self.naming._TOO_LARGE, {})
            self.assertIsNotNone(self.naming.name_parts([("p", shape)], records, budget_s=60.0))
        finally:
            self.naming._TOO_LARGE.clear()

    def test_nothing_is_recorded_outside_a_recording(self) -> None:
        module = self._module()
        with self.naming.recording() as records:
            pass
        module.make()
        self.assertEqual(records, [])

    # ---- cases an independent review found --------------------------------------------------

    def test_a_long_lived_process_reads_the_file_again_on_every_build(self) -> None:
        """Names come from the text of source lines; a worker that kept last build's text
        would name a file by what it used to say."""
        path = self.dir / "edited_in_place.py"
        path.write_text(SOURCE, encoding="utf-8")

        def build():
            spec = importlib.util.spec_from_file_location("edited_in_place", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with self.naming.recording() as records:
                shape = module.make()
            return self.naming.name_parts([("p", shape)], records, budget_s=None)

        before = build()
        path.write_text("# one\n# two\n" + SOURCE, encoding="utf-8")   # same code, two lines lower
        self.assertEqual(build()["parts"], before["parts"])

    def test_identifiers_that_end_in_digits_are_not_numbers(self) -> None:
        blank = lambda text: self.naming._NUMBER_RE.sub("#", text)   # noqa: E731
        self.assertEqual(blank("part10 = Box(10, 2.5, 1e3) - hole_2"), "part10 = Box(#, #, #) - hole_2")
        self.assertNotEqual(blank("part10 = Box(1, 1, 1)"), blank("part11 = Box(1, 1, 1)"))
        self.assertEqual(blank("fillet(e, 2)"), blank("fillet(e, 3.5)"))

    def test_one_body_placed_many_times_gives_each_placement_its_own_names(self) -> None:
        """A pattern: one tooth made once, placed around and fused. Every face needs a name."""
        source = SOURCE + "\n".join([
            "",
            "def comb(n=6):",
            "    tooth = Box(4, 4, 10)",
            "    body = Box(60, 10, 4)",
            "    return body + [Pos(-25 + i * 10, 0, 7) * tooth for i in range(n)]",
            "",
        ])
        shape, names = self._build(source=source, fn="comb")
        faces = names["parts"]["p"]["f"]
        self.assertEqual(len(faces), len(shape.faces()))
        self.assertTrue(all(faces), f"{faces.count('')} faces share a name")
        _again, wider = self._build(8, source=source, fn="comb")
        self.assertTrue(set(faces) <= set(wider["parts"]["p"]["f"]) | {""} or
                        len(set(faces) & set(wider["parts"]["p"]["f"])) >= 0.9 * len(faces))

    def test_many_cuts_on_one_body_stay_cheap(self) -> None:
        import time

        source = SOURCE + (
            "\ndef perforated(n=12):\n    body = Box(200, 200, 5)\n"
            "    for i in range(n):\n        for j in range(n):\n"
            "            body = body - Pos(-90 + i * 16, -90 + j * 16, 0) * Cylinder(2, 5)\n    return body\n"
        )
        module = self._module(source)
        built = time.perf_counter()
        with self.naming.recording() as records:
            shape = module.perforated()
        built = time.perf_counter() - built
        start = time.perf_counter()
        names = self.naming.name_parts([("p", shape)], records, budget_s=None)
        elapsed = time.perf_counter() - start
        self.assertEqual(len(names["parts"]["p"]["f"]), 6 + 144)
        self.assertTrue(all(names["parts"]["p"]["f"]))
        # Against the build itself, not the clock: naming re-mapped the whole body for every
        # cut once, and took as long as the cuts did.
        self.assertLess(elapsed, max(1.0, 0.4 * built), f"144 cuts: built in {built:.2f}s, named in {elapsed:.2f}s")

    def test_a_part_that_is_not_a_shape_does_not_cost_the_others_their_names(self) -> None:
        module = self._module()
        with self.naming.recording() as records:
            shape = module.make()
        names = self.naming.name_parts([("p", shape), ("odd", [shape, shape]), ("none", None)], records, budget_s=None)
        self.assertEqual(sorted(names["parts"]), ["p"])

    def test_switch_and_uninstall(self) -> None:
        naming = self.naming
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

        self.assertTrue(getattr(BRepAlgoAPI_Cut.__init__, "__kernel_naming__", False))
        self.assertFalse(naming.install())          # already in
        self.assertTrue(naming.uninstall())
        try:
            self.assertFalse(getattr(BRepAlgoAPI_Cut.__init__, "__kernel_naming__", False))
            saved = os.environ.get(naming.ENV_SWITCH)
            os.environ[naming.ENV_SWITCH] = "0"
            try:
                self.assertFalse(naming.ensure_installed())
                self.assertFalse(naming.installed())
            finally:
                if saved is None:
                    del os.environ[naming.ENV_SWITCH]
                else:
                    os.environ[naming.ENV_SWITCH] = saved
        finally:
            naming.install()
        self.assertTrue(naming.ensure_installed())


if __name__ == "__main__":
    unittest.main()
