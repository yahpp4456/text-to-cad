"""``cadpy.kernel.determinism``: the same generator, built in separate processes, hands back
its faces, edges and vertices in the same order.

Without it build123d's shape sets iterate in heap-address order, so a model that
fillets a polyline or subtracts edge lists comes out numbered differently on each
run (measured 2026-11-25 on build123d 0.13: five different orderings in six builds
of the case below; the geometry itself identical). Selection tokens are positional
(``f12`` is the twelfth face), so that is a face that silently becomes another face.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from cadpy.kernel import determinism

# Walks the build123d sites that de-duplicate shapes through a set: FilletPolyline
# (a set comprehension over vertices) and edge-list subtraction / intersection.
CASE = textwrap.dedent(
    """
    from build123d import *


    def gen_step():
        pts = [(0, 0), (40, 0), (40, 25), (22, 25), (22, 12), (8, 12), (8, 30), (0, 30)]
        with BuildPart() as p:
            with BuildSketch():
                with BuildLine():
                    FilletPolyline(*pts, radius=2.5, close=True)
                make_face()
            extrude(amount=10)
            top = p.faces().sort_by(Axis.Z)[-1]
            fillet((p.edges() & top.edges())[:6], radius=0.8)
            with Locations((12, 5, 10), (30, 6, 10), (30, 18, 10)):
                Hole(radius=1.6)
        return p.part
    """
)

CHILD = textwrap.dedent(
    """
    import hashlib, importlib.util, json, sys
    from cadpy.kernel import determinism
    active = determinism.install()
    spec = importlib.util.spec_from_file_location("determinism_case", sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    shape = module.gen_step()
    def digest(rows):
        return hashlib.sha1(json.dumps(rows).encode()).hexdigest()[:12]
    faces = [[round(f.center().X, 4), round(f.center().Y, 4), round(f.center().Z, 4), round(f.area, 3)] for f in shape.faces()]
    edges = [[round(e.center().X, 4), round(e.center().Y, 4), round(e.center().Z, 4), round(e.length, 4)] for e in shape.edges()]
    verts = [[round(v.X, 4), round(v.Y, 4), round(v.Z, 4)] for v in shape.vertices()]
    print("RESULT " + json.dumps({
        "active": active, "state": determinism.installed(),
        "faces": digest(faces), "edges": digest(edges), "verts": digest(verts),
        "geometry": digest(sorted(faces)), "counts": [len(faces), len(edges), len(verts)],
    }))
    """
)


def _build_in_fresh_process(case_path: Path, *, env_extra: dict[str, str] | None = None) -> dict:
    env = dict(os.environ, PYTHONUTF8="1", PYTHONHASHSEED="random", **(env_extra or {}))
    result = subprocess.run(
        [sys.executable, "-c", CHILD, str(case_path)], capture_output=True, text=True, env=env, timeout=300
    )
    line = next((row for row in result.stdout.splitlines() if row.startswith("RESULT ")), None)
    if line is None:
        raise AssertionError(f"child build failed:\n{result.stdout[-400:]}\n{result.stderr[-1200:]}")
    return json.loads(line[len("RESULT "):])


class OrderedShapeSetTests(unittest.TestCase):
    """The set stand-in keeps set semantics and first-occurrence order."""

    def test_dedups_and_keeps_first_occurrence_order(self) -> None:
        items = determinism.OrderedShapeSet(["c", "a", "c", "b", "a"])
        self.assertEqual(list(items), ["c", "a", "b"])
        self.assertEqual(len(items), 3)
        self.assertIn("a", items)
        self.assertNotIn("z", items)

    def test_operators_used_by_build123d(self) -> None:
        left = determinism.OrderedShapeSet(["c", "a", "b"])
        self.assertEqual(list(left & ["b", "c", "x"]), ["c", "b"])
        self.assertEqual(list(left - ["a"]), ["c", "b"])
        self.assertEqual(list(left | ["d", "a"]), ["c", "a", "b", "d"])
        self.assertEqual(list(["x", "b", "c"] & left), ["b", "c"])
        self.assertEqual(list(["x", "b"] - left), ["x"])
        self.assertTrue(left == {"a", "b", "c"})
        self.assertTrue(left != {"a"})
        with self.assertRaises(TypeError):
            hash(left)

    def test_only_shape_lists_are_diverted(self) -> None:
        class FakeShapeList(list):
            pass

        ordered_set = determinism._make_ordered_set(FakeShapeList)
        self.assertIsInstance(ordered_set(), set)
        self.assertIsInstance(ordered_set([3, 1, 2]), set)  # anything else stays a real set
        self.assertIsInstance(ordered_set(FakeShapeList([3, 1, 3])), determinism.OrderedShapeSet)
        self.assertEqual(list(ordered_set(FakeShapeList([3, 1, 3]))), [3, 1])


class InstallTests(unittest.TestCase):
    """install() must be ACTIVE on the kernel under test, not merely return True."""

    def test_install_is_active_on_this_build123d(self) -> None:
        self.assertTrue(determinism.install())
        state = determinism.installed()
        # A module install() stepped aside from would be missing here: fail loudly
        # instead of passing on an install that quietly did nothing.
        self.assertEqual(sorted(state["modules"]), sorted(determinism._SHADOWED_MODULES), state)
        self.assertTrue(state["vertexHash"], state)
        self.assertTrue(determinism.install())  # idempotent

    def test_vertices_at_one_point_hash_alike(self) -> None:
        from build123d import Vertex

        determinism.install()
        self.assertEqual(hash(Vertex(1.0, 2.0, 3.0)), hash(Vertex(1.0, 2.0, 3.0)))
        self.assertNotEqual(hash(Vertex(1.0, 2.0, 3.0)), hash(Vertex(1.0, 2.0, 3.5)))


class CrossProcessOrderTests(unittest.TestCase):
    """The property that matters: separate processes agree on the order."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._dir = tempfile.TemporaryDirectory(prefix="cadpy-determinism-")
        cls.case = Path(cls._dir.name) / "determinism_case.py"
        cls.case.write_text(CASE, encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dir.cleanup()

    def test_three_processes_agree_on_face_edge_vertex_order(self) -> None:
        runs = [_build_in_fresh_process(self.case) for _ in range(3)]
        for run in runs:
            self.assertTrue(run["active"], run)
            self.assertEqual(sorted(run["state"]["modules"]), sorted(determinism._SHADOWED_MODULES), run)
        for key in ("counts", "geometry", "faces", "edges", "verts"):
            self.assertEqual(len({json.dumps(run[key]) for run in runs}), 1, f"{key} differs: {[r[key] for r in runs]}")

    def test_switch_off_leaves_build123d_alone_and_geometry_unchanged(self) -> None:
        on = _build_in_fresh_process(self.case)
        off = _build_in_fresh_process(self.case, env_extra={"CADPY_DETERMINISM": "0"})
        self.assertFalse(off["active"])
        self.assertEqual(off["state"]["modules"], [])
        self.assertFalse(off["state"]["vertexHash"])
        # the shim changes the ORDER shapes are handed back in, never the shapes
        self.assertEqual(off["counts"], on["counts"])
        self.assertEqual(off["geometry"], on["geometry"])


if __name__ == "__main__":
    unittest.main()
