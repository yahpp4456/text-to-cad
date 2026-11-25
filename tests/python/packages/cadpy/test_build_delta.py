"""Tests for build summaries and placement-independent geometry keys."""

import hashlib
import json
import math
import unittest
from types import SimpleNamespace

from cadpy.build_delta import MAX_PARTS, build_summary, geometry_key, part_summary


class FakeShape:
    def __init__(self, lo=(0, 0, 0), hi=(1, 2, 3), volume=6, area=22):
        self.lo, self.hi = lo, hi
        self.volume, self.area = volume, area
        self.face_count, self.edge_count, self.vertex_count = 6, 12, 8

    def bounding_box(self):
        def point(coords):
            return SimpleNamespace(X=coords[0], Y=coords[1], Z=coords[2])

        return SimpleNamespace(min=point(self.lo), max=point(self.hi))

    def faces(self):
        return range(self.face_count)

    def edges(self):
        return range(self.edge_count)

    def vertices(self):
        return range(self.vertex_count)


class BuildDeltaTests(unittest.TestCase):
    def test_part_fields_and_rounding(self):
        shape = FakeShape(lo=(-0.0001, 1.2346, -2), volume=6.1236)
        part = part_summary(7, shape)
        self.assertEqual(part, {
            "name": "7", "key": geometry_key(shape), "volume": 6.124, "faces": 6,
            "bbox": [[0.0, 1.235, -2], [1, 2, 3]],
        })
        self.assertEqual(math.copysign(1, part["bbox"][0][0]), 1)
        zero = FakeShape(volume=-0.0001, area=-0.0)
        self.assertEqual(geometry_key(zero), geometry_key(FakeShape(volume=0, area=0)))
        self.assertEqual(math.copysign(1, part_summary("zero", zero)["volume"]), 1)

    def test_geometry_key_uses_all_five_measurements(self):
        key = geometry_key(FakeShape())
        self.assertRegex(key, r"^[0-9a-f]{12}$")
        self.assertEqual(key, hashlib.sha1(b"6.000|22.000|6|12|8").hexdigest()[:12])
        for field in ("volume", "area", "face_count", "edge_count", "vertex_count"):
            with self.subTest(field=field):
                shape = FakeShape()
                setattr(shape, field, getattr(shape, field) + 1)
                self.assertNotEqual(geometry_key(shape), key)

    def test_real_box_and_translation(self):
        from build123d import Box

        box = Box(10, 20, 30)
        part = part_summary("box", box)
        self.assertEqual(part["volume"], 6000)
        self.assertEqual(part["faces"], 6)
        self.assertEqual(part["bbox"], [[-5, -10, -15], [5, 10, 15]])
        moved = part_summary("box", box.translate((5, 0, 0)))
        self.assertEqual(moved["key"], part["key"])
        self.assertEqual(moved["bbox"], [[0, -10, -15], [10, 10, 15]])
        self.assertNotEqual(geometry_key(Box(10, 20, 31)), part["key"])

    def test_measurement_errors(self):
        class BrokenShape(FakeShape):
            def edges(self):
                raise RuntimeError("x" * 150)

        self.assertEqual(part_summary("bad", BrokenShape()),
                         {"name": "bad", "error": "RuntimeError: " + "x" * 120})
        for shape in (FakeShape(volume=math.nan), FakeShape(area=math.inf),
                      FakeShape(hi=(1, 1, -math.inf))):
            self.assertEqual(part_summary("bad", shape),
                             {"name": "bad", "error": "ValueError: non-finite geometry"})
        self.assertEqual(set(part_summary("bad", FakeShape(area=None))), {"name", "error"})

    def test_build_union_and_unrounded_volume_sum(self):
        a = FakeShape(lo=(-3, 0, 1), volume=1.0004)
        b = FakeShape(lo=(0, -4, 2), hi=(8, 1, 6), volume=2.0004)
        summary = build_summary(iter([("a", a), ("b", b)]))
        self.assertEqual(summary, {
            "schemaVersion": 1, "partCount": 2, "bbox": [[-3, -4, 1], [8, 2, 6]],
            "volume": 3.001, "parts": [part_summary("a", a), part_summary("b", b)],
        })
        self.assertEqual(json.loads(json.dumps(summary, allow_nan=False)), summary)

    def test_bad_parts_do_not_contribute_geometry(self):
        summary = build_summary([("bad", None), ("good", FakeShape())])
        self.assertEqual(summary["partCount"], 2)
        self.assertIn("error", summary["parts"][0])
        self.assertEqual(summary["bbox"], [[0, 0, 0], [1, 2, 3]])
        self.assertEqual(summary["volume"], 6)
        self.assertIsNone(build_summary([("bad", None)])["bbox"])

    def test_part_limit_excludes_tail_geometry(self):
        parts = [(str(i), FakeShape()) for i in range(MAX_PARTS)]
        self.assertNotIn("truncated", build_summary(parts))
        parts.append(("tail", FakeShape(hi=(100, 200, 300), volume=100)))
        summary = build_summary(iter(parts))
        self.assertEqual(summary["partCount"], 401)
        self.assertEqual([p["name"] for p in summary["parts"]], [str(i) for i in range(400)])
        self.assertIs(summary["truncated"], True)
        self.assertEqual(summary["bbox"], [[0, 0, 0], [1, 2, 3]])
        self.assertEqual(summary["volume"], 2400)

    def test_malformed_input_discards_partial_measurements(self):
        for parts in (None, [1, 2], [("good", FakeShape()), ("bad",)]):
            summary = build_summary(parts)
            self.assertRegex(summary.pop("error"), r"^(TypeError|ValueError): .+")
            self.assertEqual(summary, {"schemaVersion": 1, "partCount": 0,
                                       "bbox": None, "volume": 0.0, "parts": []})
