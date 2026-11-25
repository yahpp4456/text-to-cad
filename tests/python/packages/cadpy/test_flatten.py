"""Flat pattern geometry and exact DXF circles and polyline arcs."""

from __future__ import annotations

import collections
import importlib.util
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cadpy import flatten


def _plate():
    """A plate with everything a cut profile can have: rounded corners, round
    holes, and a slot (two arcs joined by lines)."""
    import build123d as bd

    with bd.BuildPart() as part:
        with bd.BuildSketch():
            bd.RectangleRounded(70, 40, 6)
            with bd.Locations((-26, 0), (26, 0)):
                bd.Circle(3.25, mode=bd.Mode.SUBTRACT)
            bd.SlotOverall(24, 8, mode=bd.Mode.SUBTRACT)
        bd.extrude(amount=6)
    return part.part


def _drawing(shape, **options):
    import ezdxf

    document = ezdxf.new("R2010")
    counts = flatten.emit_profile(document.modelspace(), shape, **options)
    return document, counts


def _entity_kinds(shape) -> dict[str, int]:
    document, _ = _drawing(shape)
    kinds = collections.Counter()
    for entity in document.modelspace():
        kinds[entity.dxftype()] += 1
        if entity.dxftype() == "LWPOLYLINE":
            kinds.update(segment.dxftype() for segment in entity.virtual_entities())
    return dict(kinds)


class FlatPatternTests(unittest.TestCase):
    def test_a_flat_pattern_keeps_arcs_and_circles(self) -> None:
        kinds = _entity_kinds(flatten.flat_pattern(_plate(), coordinate=6.0))
        self.assertEqual(kinds.get("ARC"), 6, "four corner fillets and two slot ends")
        self.assertEqual(kinds.get("CIRCLE"), 2, "two bolt holes")
        self.assertEqual(kinds.get("LWPOLYLINE"), 2, "outer contour and slot")
        self.assertEqual(kinds.get("LINE"), 6, "four straight sides and two straight slot edges")

    def test_kerf_compensation_keeps_arcs(self) -> None:
        """The reason the shapely path stopped being primary: its buffer()
        turned every offset curve into chords."""
        kinds = _entity_kinds(flatten.flat_pattern(_plate(), coordinate=6.0, kerf=0.2))
        self.assertEqual(kinds.get("ARC"), 6)
        self.assertEqual(kinds.get("CIRCLE"), 2)

    def test_kerf_changes_the_geometry_in_the_right_direction(self) -> None:
        plate = _plate()
        plain = flatten.flat_pattern(plate, coordinate=6.0)
        grown = flatten.flat_pattern(plate, coordinate=6.0, kerf=0.2)
        shrunk = flatten.flat_pattern(plate, coordinate=6.0, kerf=-0.2)
        self.assertGreater(grown.area, plain.area)
        self.assertLess(shrunk.area, plain.area)

    def test_flatten_face_lands_the_face_on_z_zero(self) -> None:
        import build123d as bd

        raised = bd.Location((3, -4, 12)) * bd.Rectangle(10, 5).face()
        flat = flatten.flatten_face(raised)
        self.assertLess(max(abs(v.Z) for v in flat.vertices()), 1e-9)
        self.assertAlmostEqual(flat.area, raised.area, places=6)

    def test_planar_faces_raises_when_the_selection_is_empty(self) -> None:
        """An empty selection means the plane or the sign is wrong. Returning
        nothing would write an empty drawing that nobody notices."""
        with self.assertRaises(RuntimeError):
            flatten.planar_faces(
                _plate(),
                normal_axis="z",
                normal_sign=1.0,
                coordinate_axis="z",
                coordinate=999.0,
            )

    def test_an_impossible_offset_says_what_went_wrong(self) -> None:
        import build123d as bd

        with self.assertRaises(RuntimeError) as caught:
            flatten.offset_profile(bd.Rectangle(2, 2).face(), -5.0)
        self.assertIn("consumes it entirely", str(caught.exception))


class UnionTests(unittest.TestCase):
    def test_overlapping_faces_fuse_into_one(self) -> None:
        import build123d as bd

        left = bd.Rectangle(10, 5).face()
        right = bd.Pos(5, 0) * bd.Rectangle(10, 5).face()
        fused = flatten.union_faces([left, right])
        self.assertEqual(len(fused.faces()), 1)
        self.assertAlmostEqual(fused.area, 15 * 5, places=6)
        self.assertEqual(_entity_kinds(fused), {"LWPOLYLINE": 1, "LINE": 4}, "the shared edge is gone")

    def test_disjoint_faces_stay_a_nested_layout(self) -> None:
        import build123d as bd

        left = bd.Rectangle(10, 5).face()
        right = bd.Pos(30, 0) * bd.Rectangle(10, 5).face()
        fused = flatten.union_faces([left, right])
        self.assertEqual(len(fused.faces()), 2)
        self.assertEqual(_entity_kinds(fused), {"LWPOLYLINE": 2, "LINE": 8})

    def test_a_single_face_passes_through_untouched(self) -> None:
        import build123d as bd

        face = bd.Rectangle(10, 5).face()
        self.assertIs(flatten.union_faces([face]), face)

    def test_no_faces_is_an_error(self) -> None:
        with self.assertRaises(RuntimeError):
            flatten.union_faces([])

    @unittest.skipUnless(importlib.util.find_spec("shapely"), "Shapely is not installed")
    def test_the_shapely_fallback_still_produces_a_usable_profile(self) -> None:
        """It is the fallback, and it costs curvature: the rebuilt profile is
        polygonal. That is the trade, and it is why nothing reaches for it by
        choice."""
        import build123d as bd

        left = bd.Rectangle(10, 5).face()
        right = bd.Pos(5, 0) * bd.Rectangle(10, 5).face()
        rebuilt = flatten._shapely_union_fallback([left, right], cause=RuntimeError("forced"))
        self.assertAlmostEqual(rebuilt.area, 15 * 5, places=3)
        kinds = _entity_kinds(rebuilt)
        self.assertEqual(kinds.get("LWPOLYLINE"), 1)
        self.assertNotIn("ARC", kinds)
        self.assertGreater(kinds.get("LINE", 0), 4, "sampled, not exact")

    def test_missing_shapely_reports_the_exact_union_failure(self) -> None:
        cause = RuntimeError("OCC fuse failed")
        with patch("builtins.__import__", side_effect=ModuleNotFoundError(name="shapely")):
            with self.assertRaisesRegex(RuntimeError, "exact union failed and shapely is not installed") as caught:
                flatten._shapely_union_fallback([], cause=cause)
        self.assertIs(caught.exception.__cause__, cause)


def _rounded_plate_face():
    import build123d as bd

    with bd.BuildSketch() as sketch:
        bd.RectangleRounded(40, 20, 4)
        bd.Circle(3, mode=bd.Mode.SUBTRACT)
    return sketch.sketch.face()


class EmitProfileTests(unittest.TestCase):
    def test_rounded_rectangle_with_round_hole(self) -> None:
        document, counts = _drawing(_rounded_plate_face(), layer="OUTLINE")
        self.assertEqual(counts, {"circles": 1, "polylines": 1, "arcs": 4, "sampled_edges": 0})
        msp = document.modelspace()
        self.assertEqual(len(msp), 2)
        circle, = msp.query("CIRCLE")
        self.assertAlmostEqual(circle.dxf.radius, 3)
        self.assertAlmostEqual(circle.dxf.center.x, 0)
        self.assertAlmostEqual(circle.dxf.center.y, 0)
        polyline, = msp.query("LWPOLYLINE")
        self.assertTrue(polyline.closed)
        self.assertTrue(all(entity.dxf.layer == "OUTLINE" for entity in msp))
        points = polyline.get_points("xyb")
        self.assertEqual(len(points), 8)
        bulges = [b for _, _, b in points if b]
        self.assertEqual(len(bulges), 4)
        for b in bulges:
            self.assertAlmostEqual(abs(b), math.tan(math.pi / 8), delta=1e-6)
            self.assertGreater(b * bulges[0], 0)

    def test_bulge_direction_recovers_the_rounded_area(self) -> None:
        document, _ = _drawing(_rounded_plate_face())
        polyline, = document.modelspace().query("LWPOLYLINE")
        points = polyline.get_points("xyb")
        segments = list(zip(points, points[1:] + points[:1]))
        signed_area = sum(x * ny - nx * y for (x, y, _), (nx, ny, _) in segments) / 2
        area = signed_area
        for (x, y, bulge), (nx, ny, _) in segments:
            if bulge:
                theta = 4 * math.atan(abs(bulge))
                radius = math.hypot(nx - x, ny - y) / (2 * math.sin(theta / 2))
                arc_area = radius**2 / 2 * (theta - math.sin(theta))
                area += math.copysign(arc_area, bulge * signed_area)
        self.assertAlmostEqual(abs(area), 40 * 20 - (4 - math.pi) * 4**2, delta=1e-6)

    def test_full_circle(self) -> None:
        import build123d as bd

        document, counts = _drawing(bd.Circle(5).face())
        self.assertEqual(counts, {"circles": 1, "polylines": 0, "arcs": 0, "sampled_edges": 0})
        circle, = document.modelspace()
        self.assertEqual(circle.dxftype(), "CIRCLE")
        self.assertEqual(circle.dxf.layer, "CUT")
        self.assertAlmostEqual(circle.dxf.radius, 5)

    def test_rectangle(self) -> None:
        import build123d as bd

        document, _ = _drawing(bd.Rectangle(10, 6).face())
        polyline, = document.modelspace()
        self.assertEqual(polyline.dxftype(), "LWPOLYLINE")
        self.assertTrue(polyline.closed)
        self.assertEqual([b for _, _, b in polyline.get_points("xyb")], [0.0] * 4)

    def test_slot_has_two_exact_semicircles(self) -> None:
        import build123d as bd

        document, _ = _drawing(bd.SlotOverall(20, 6).face())
        polyline, = document.modelspace()
        self.assertEqual(polyline.dxftype(), "LWPOLYLINE")
        self.assertTrue(polyline.closed)
        points = polyline.get_points("xyb")
        for (_, y, bulge), (_, next_y, _) in zip(points, points[1:] + points[:1]):
            if bulge == 0:
                self.assertAlmostEqual(abs(y), 3)
                self.assertAlmostEqual(next_y, y)
        bulges = [b for _, _, b in points if b]
        self.assertEqual(len(bulges), 2)
        self.assertGreater(bulges[0] * bulges[1], 0)
        for b in bulges:
            self.assertAlmostEqual(abs(b), 1, delta=1e-6)

    def test_raised_face_is_rejected(self) -> None:
        import build123d as bd

        with self.assertRaisesRegex(ValueError, "^emit_profile: geometry is not in the XY plane$"):
            _drawing(bd.Pos(Z=1) * bd.Rectangle(10, 6).face())

    def test_shape_needs_faces_method(self) -> None:
        with self.assertRaises(TypeError):
            _drawing(object())

    def test_xy_tolerance_applies_to_the_curve_geometry(self) -> None:
        import build123d as bd

        spline = bd.Edge.make_spline([(0, 0), (1, 1), (2, 0)])
        face = bd.Face(bd.Wire([spline, bd.Edge.make_line((2, 0), (0, 0))]))
        _, counts = _drawing(bd.Pos(Z=1e-6) * face)
        self.assertEqual(counts["sampled_edges"], 1)
        with self.assertRaises(ValueError):
            _drawing(bd.Pos(Z=1.01e-6) * face)
        with self.assertRaises(ValueError):
            _drawing(bd.Rot(X=90) * bd.Circle(2).face())

    def test_ellipse_is_sampled_on_the_curve(self) -> None:
        import build123d as bd

        document, counts = _drawing(bd.Ellipse(10, 4).face())
        self.assertGreaterEqual(counts["sampled_edges"], 1)
        polyline, = document.modelspace()
        self.assertEqual(polyline.dxftype(), "LWPOLYLINE")
        self.assertTrue(polyline.closed)
        points = polyline.get_points("xyb")
        self.assertGreater(len(points), 16)
        self.assertNotEqual(points[0], points[-1])
        for x, y, bulge in points:
            self.assertLess(abs((x / 10)**2 + (y / 4)**2 - 1), 1e-6)
            self.assertEqual(bulge, 0)

    def test_only_the_ellipse_in_a_mixed_wire_is_sampled(self) -> None:
        import build123d as bd

        wire = bd.Wire([
            bd.Edge.make_ellipse(10, 4, start_angle=0, end_angle=180),
            bd.Edge.make_line((-10, 0), (-10, -2)),
            bd.Edge.make_three_point_arc((-10, -2), (0, -12), (10, -2)),
            bd.Edge.make_line((10, -2), (10, 0)),
        ])
        face = bd.Face(wire)
        sizes = []
        for tolerance in (0.2, 0.01):
            document, counts = _drawing(face, sample_tolerance_mm=tolerance)
            self.assertEqual(counts, {"circles": 0, "polylines": 1, "arcs": 1, "sampled_edges": 1})
            polyline, = document.modelspace()
            sizes.append(len(polyline))
            arc, = (segment for segment in polyline.virtual_entities() if segment.dxftype() == "ARC")
            self.assertAlmostEqual(arc.dxf.radius, 10)
            self.assertAlmostEqual(arc.dxf.center.x, 0)
            self.assertAlmostEqual(arc.dxf.center.y, -2)
        self.assertGreater(sizes[1], sizes[0])

    def test_two_disjoint_faces(self) -> None:
        import build123d as bd

        face = bd.Rectangle(10, 6).face()
        document, counts = _drawing(bd.Compound([face, bd.Pos(X=20) * face]))
        msp = document.modelspace()
        self.assertEqual(len(msp), 2)
        self.assertEqual(len(msp.query("LWPOLYLINE")), 2)
        self.assertEqual(counts["polylines"], 2)

    def test_dxf_round_trip(self) -> None:
        import ezdxf

        document, _ = _drawing(_rounded_plate_face())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "profile.dxf"
            document.saveas(path)
            msp = ezdxf.readfile(path).modelspace()
        self.assertEqual(len(msp), 2)
        self.assertEqual(len(msp.query("CIRCLE")), 1)
        polyline, = msp.query("LWPOLYLINE")
        self.assertTrue(polyline.closed)
        self.assertEqual(sum(b != 0 for _, _, b in polyline.get_points("xyb")), 4)


class PlateDxfTests(unittest.TestCase):
    """``plate_dxf``:等厚平板 → 一份輪廓 DXF(圓弧維持是圓弧);不是平板就拒絕。"""

    def _cut_plate(self):
        from build123d import BuildPart, BuildSketch, Circle, Locations, RectangleRounded, SlotOverall, extrude

        with BuildPart() as part:
            with BuildSketch():
                RectangleRounded(80, 50, 6)
                with Locations((-28, 0), (28, 0)):
                    Circle(3.3, mode=__import__("build123d").Mode.SUBTRACT)
                with Locations((0, 12)):
                    SlotOverall(24, 6, mode=__import__("build123d").Mode.SUBTRACT)
            extrude(amount=5)
        return part.part

    def test_plate_profile_keeps_arcs_and_circles(self) -> None:
        doc = flatten.plate_dxf(self._cut_plate())
        msp = doc.modelspace()
        self.assertEqual({entity.dxf.layer for entity in msp}, {"CUT"})
        self.assertEqual(len(msp.query("CIRCLE")), 2)
        self.assertEqual({round(c.dxf.radius, 6) for c in msp.query("CIRCLE")}, {3.3})
        polylines = list(msp.query("LWPOLYLINE"))
        self.assertEqual(len(polylines), 2)  # 外框 + 長孔
        for polyline in polylines:
            self.assertTrue(polyline.closed)
        bulges = sorted(
            (sum(1 for _, _, b in p.get_points("xyb") if abs(b) > 1e-9), len(p.get_points("xyb"))) for p in polylines
        )
        # 長孔:2 個半圓(4 個頂點);外框:4 個四分之一圓(8 個頂點)
        self.assertEqual(bulges, [(2, 4), (4, 8)])
        outer = max(polylines, key=lambda p: len(p.get_points("xyb")))
        xs = [x for x, _, _ in outer.get_points("xyb")]
        ys = [y for _, y, _ in outer.get_points("xyb")]
        self.assertAlmostEqual(max(xs) - min(xs), 80.0, places=6)
        self.assertAlmostEqual(max(ys) - min(ys), 50.0, places=6)

    def test_plate_dxf_round_trips_through_a_file(self) -> None:
        import ezdxf

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "plate.dxf"
            flatten.plate_dxf(self._cut_plate()).saveas(path)
            msp = ezdxf.readfile(path).modelspace()
        self.assertEqual((len(msp.query("CIRCLE")), len(msp.query("LWPOLYLINE"))), (2, 2))

    def test_refuses_a_part_that_is_not_a_plate(self) -> None:
        from build123d import Box, Pos

        stepped = Box(40, 40, 5) + Pos(0, 0, 5) * Box(20, 20, 5)   # 有階梯
        with self.assertRaisesRegex(ValueError, "不是等厚平板"):
            flatten.plate_dxf(stepped)
        pocketed = Box(40, 40, 5) - Pos(0, 0, 1.5) * Box(10, 10, 2)  # 盲孔:頂面輪廓×厚度 > 體積
        with self.assertRaisesRegex(ValueError, "不是等厚平板"):
            flatten.plate_dxf(pocketed)

    def test_kerf_grows_the_profile(self) -> None:
        from build123d import Box

        doc = flatten.plate_dxf(Box(40, 20, 3), kerf=0.1)
        polyline, = doc.modelspace().query("LWPOLYLINE")
        xs = [x for x, _, _ in polyline.get_points("xyb")]
        self.assertAlmostEqual(max(xs) - min(xs), 40.2, places=4)


if __name__ == "__main__":
    unittest.main()
