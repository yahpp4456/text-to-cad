"""Kernel tests for cadpy.surface (real OCP): closed forms, continuity golden, builder examples,
and every construction gate with an input that must FAIL (the kernel calls these valid).

Probe results pinned here (2026-10-10, build123d 0.11.0 / OCCT 7.9.3):
- continuity must be sampled at the SAME edge parameter on both pcurves (3D nearest-point
  matching reports two hemispheres as a 3° G0 crease);
- two hemispheres -> G2, cylinder+hemisphere -> G1 (not G2), box -> G0, box fillet -> G1;
- MakeFilling accepts G2 on bspline/plane/cylinder supports but rejects it on a sphere
  support -> patch() downgrades to G1 and reports it;
- Solid.thicken(hemisphere R=10, t=12) returns a "valid" self-intersecting solid (2.7x volume)
  -> thicken() gates t < 0.9 / max|k|;
- a mirrored half-model whose sections do not end perpendicular to the symmetry plane seams
  with a 15-40° crease -> builder rejects unless minContinuity is G0.
"""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from build123d import Box, Location, Solid  # noqa: E402

from cadpy.surface import (  # noqa: E402
    SurfaceBuilder,
    check_surface_model,
    design_rows,
    harvest_meta,
    last_build,
    normalize_spec,
)
from cadpy.surface import analysis as A  # noqa: E402
from cadpy.surface import ops, surfaces  # noqa: E402
from cadpy.surface.curves import curve_comb, curve_polyline, make_curve  # noqa: E402

REPO = Path(__file__).resolve().parents[4]
EXAMPLES = REPO / "apps/cad-chat/src/lib/surface/examples"


def _example(name: str) -> dict:
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


def _grades(shape) -> list[str]:
    return [r["grade"] for r in A.edge_continuity(shape, samples=3, polyline_points=2)]


class CurveTests(unittest.TestCase):
    def test_spline_through_points_and_tangent(self) -> None:
        e = make_curve({"id": "s", "kind": "spline", "points": [[0, 0, 0], [10, 5, 0], [20, 0, 0]],
                        "tangents": {"end": [1, 0, 0]}})
        for p in ([0, 0, 0], [10, 5, 0], [20, 0, 0]):
            self.assertLess(e.distance_to(tuple(p)), 1e-6)
        t_end = e.tangent_at(1.0)
        self.assertAlmostEqual(abs(t_end.X), 1.0, places=5)
        self.assertAlmostEqual(t_end.Y, 0.0, places=5)

    def test_nurbs_quarter_circle_closed_form(self) -> None:
        w = math.sqrt(2) / 2
        e = make_curve({"id": "q", "kind": "nurbs", "degree": 2,
                        "poles": [[10, 0, 0], [10, 10, 0], [0, 10, 0]], "weights": [1, w, 1]})
        for pt in curve_polyline(e, 17):
            self.assertAlmostEqual(math.hypot(pt[0], pt[1]), 10.0, places=5)
        self.assertAlmostEqual(e.length, math.pi * 10 / 2, places=4)

    def test_arc_circle_line_bezier(self) -> None:
        arc = make_curve({"id": "a", "kind": "arc3", "points": [[0, 0, -10], [10, 0, 0], [0, 0, 10]]})
        self.assertAlmostEqual(arc.length, math.pi * 10, places=5)
        circ = make_curve({"id": "c", "kind": "circle", "center": [1, 2, 3], "normal": [0, 0, 1], "r": 5})
        self.assertAlmostEqual(circ.length, 2 * math.pi * 5, places=5)
        line = make_curve({"id": "l", "kind": "line", "points": [[0, 0, 0], [3, 4, 0]]})
        self.assertAlmostEqual(line.length, 5.0, places=9)
        bz = make_curve({"id": "b", "kind": "bezier", "poles": [[0, 0, 0], [5, 10, 0], [10, 0, 0]]})
        self.assertLess(bz.distance_to((5, 5, 0)), 1e-6)

    def test_comb_curvature_of_arc(self) -> None:
        arc = make_curve({"id": "a", "kind": "arc3", "points": [[-10, 0, 0], [0, 10, 0], [10, 0, 0]]})
        comb = curve_comb(arc, 9, scale=1.0)
        for row in comb:
            self.assertAlmostEqual(row["k"], 0.1, places=6)
            self.assertAlmostEqual(math.sqrt(sum(x * x for x in row["v"])), 0.1, places=6)

    def test_curve_gates(self) -> None:
        with self.assertRaises(ValueError):
            make_curve({"id": "x", "kind": "arc3", "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0]]})
        with self.assertRaises(ValueError):
            make_curve({"id": "x", "kind": "line", "points": [[0, 0, 0], [0, 0, 0]]})
        with self.assertRaises(ValueError):
            make_curve({"id": "x", "kind": "nurbs", "degree": 3, "poles": [[0, 0, 0], [1, 0, 0]], "closed": True})


class ContinuityGoldenTests(unittest.TestCase):
    def test_two_hemispheres_g2(self) -> None:
        sph = Solid.make_sphere(10)
        half_a = sph & Box(40, 40, 40).moved(Location((0, 0, 20)))
        half_b = sph & Box(40, 40, 40).moved(Location((0, 0, -20)))
        from build123d import GeomType, Shell

        shell = Shell([f for f in list(half_a.faces()) + list(half_b.faces()) if f.geom_type != GeomType.PLANE])
        rows = A.edge_continuity(shell, samples=5, polyline_points=2)
        self.assertTrue(rows)
        self.assertTrue(all(r["grade"] == "G2" for r in rows), rows)
        self.assertTrue(all(r["g1Deg"] < 1e-6 for r in rows))

    def test_capsule_g1_box_g0_fillet_g1(self) -> None:
        cyl = Solid.make_cylinder(10, 20)
        cap = Solid.make_sphere(10).moved(Location((0, 0, 20))) & Box(40, 40, 40).moved(Location((0, 0, 40)))
        grades = _grades(cyl + cap)
        self.assertIn("G1", grades)
        self.assertIn("G0", grades)  # bottom disc rim
        self.assertEqual(set(_grades(Solid.make_box(10, 10, 10))), {"G0"})
        from build123d import Axis, fillet

        rounded = fillet(Solid.make_box(10, 10, 10).edges().filter_by(Axis.Z)[0], 2)
        self.assertIn("G1", _grades(rounded))

    def test_curvature_golden(self) -> None:
        from build123d import Face, GeomType

        s = A.face_curvature_stats(Solid.make_sphere(10).faces()[0])
        self.assertAlmostEqual(s["kgaussMax"], 0.01, places=6)
        self.assertAlmostEqual(abs(s["kmin"]), 0.1, places=6)
        c = A.face_curvature_stats(Solid.make_cylinder(10, 5).faces().filter_by(GeomType.CYLINDER)[0])
        self.assertAlmostEqual(c["kgaussMax"], 0.0, places=6)
        self.assertAlmostEqual(c["kabsMax"], 0.1, places=6)
        p = A.face_curvature_stats(Face.make_rect(10, 10))
        self.assertEqual(p["kabsMax"], 0.0)
        self.assertAlmostEqual(A.max_abs_curvature(Solid.make_sphere(4)), 0.25, places=6)

    def test_free_edges_and_closed(self) -> None:
        from build123d import Face

        self.assertEqual(len(A.free_edges(Face.make_rect(10, 10), polyline_points=2)), 4)
        self.assertEqual(A.free_edges(Solid.make_box(1, 1, 1), polyline_points=2), [])


class SurfaceOpTests(unittest.TestCase):
    def test_loft_frustum_closed_form(self) -> None:
        c0 = make_curve({"id": "a", "kind": "circle", "center": [0, 0, 0], "normal": [0, 0, 1], "r": 10})
        c1 = make_curve({"id": "b", "kind": "circle", "center": [0, 0, 30], "normal": [0, 0, 1], "r": 5})
        sh = surfaces.loft([c0, c1], ruled=True)
        slant = math.hypot(30, 5)
        self.assertAlmostEqual(sh.area, math.pi * (10 + 5) * slant, delta=0.5)

    def test_revolve_sphere_area_and_solid(self) -> None:
        arc = make_curve({"id": "a", "kind": "arc3", "points": [[0, 0, -10], [10, 0, 0], [0, 0, 10]]})
        f = surfaces.revolve(arc, [0, 0, 0], [0, 0, 1], 360)
        self.assertAlmostEqual(f.area, 4 * math.pi * 100, delta=1e-3)
        shells, free = ops.sew([f], 0.01)
        self.assertEqual(len(shells), 1)
        self.assertTrue(ops.is_closed(shells[0]))
        s = ops.solid_from_shell(shells[0])
        self.assertAlmostEqual(s.volume, 4 / 3 * math.pi * 1000, delta=1e-2)

    def test_patch_g1_on_sphere_downgrades_g2(self) -> None:
        from build123d import GeomType, Shell

        windowed = Solid.make_sphere(20) - Box(14, 14, 60)
        sph_face = [f for f in windowed.faces() if f.geom_type == GeomType.SPHERE][0]
        free = A.free_edges(Shell([sph_face]), polyline_points=2)
        from OCP.TopoDS import TopoDS
        from build123d import Edge

        emap = A._edge_face_map(Shell([sph_face]))
        top = [Edge(TopoDS.Edge_s(emap.FindKey(r["i"]))) for r in free]
        top = [e for e in top if e.center().Z > 0]
        self.assertGreaterEqual(len(top), 4)
        face, notes = surfaces.patch(top, {i: (sph_face, "G1") for i in range(len(top))})
        self.assertTrue(face.is_valid)
        rows = A.edge_continuity(Shell([sph_face, face]), samples=5, polyline_points=2)
        self.assertTrue(all(r["g1Deg"] < A.G1_TOL_DEG for r in rows), rows)
        face2, notes2 = surfaces.patch(top, {i: (sph_face, "G2") for i in range(len(top))})
        self.assertTrue(any("降為 G1" in n for n in notes2), notes2)

    def test_capped_revolve_and_sweep_close_the_shell(self) -> None:
        # 半圓環(旋轉 180° 的圓)兩端平面開口 → capped 封成閉殼 → 體積 = 半個圓環
        circ = make_curve({"id": "c", "kind": "circle", "center": [30, 0, 0], "normal": [0, 1, 0], "r": 5})
        faces = surfaces.revolve(circ, [0, 0, 0], [0, 0, 1], 180, capped=True)
        self.assertEqual(len(faces), 3)
        shells, _ = ops.sew(faces, 0.01)
        self.assertTrue(ops.is_closed(shells[0]))
        s = ops.solid_from_shell(shells[0])
        self.assertAlmostEqual(s.volume, 0.5 * 2 * math.pi ** 2 * 30 * 25, delta=2.0)
        # 沿弧掃掠的管 + capped → 閉殼
        rail = make_curve({"id": "r", "kind": "arc3", "points": [[0, 0, 0], [20, 0, 20], [40, 0, 0]]})
        prof = make_curve({"id": "p", "kind": "circle", "center": [0, 0, 0], "normal": [1, 0, 1], "r": 3})
        tube = surfaces.sweep(prof, rail, capped=True)
        shells2, _ = ops.sew(tube, 0.01)
        self.assertTrue(ops.is_closed(shells2[0]))
        self.assertGreater(ops.solid_from_shell(shells2[0]).volume, 0)
        # 非平面開口:kernel 會用填充面封(仍是閉殼);只要求結果閉合、不丟
        wavy = make_curve({"id": "w", "kind": "spline", "points": [[10, 0, 0], [0, 10, 3], [-10, 0, 0], [0, -10, -3]], "closed": True})
        shells3, _ = ops.sew(surfaces.extrude(wavy, [0, 0, 1], 10, capped=True), 0.01)
        self.assertTrue(ops.is_closed(shells3[0]))

    def test_patch_open_boundary_fails(self) -> None:
        a = make_curve({"id": "a", "kind": "line", "points": [[0, 0, 0], [10, 0, 0]]})
        b = make_curve({"id": "b", "kind": "line", "points": [[10, 0, 0], [10, 10, 0]]})
        with self.assertRaises(ValueError):
            surfaces.patch([a, b])

    def test_gordon_and_sweep_guide(self) -> None:
        def pts(z, w, h):
            return [[-w, z, 0], [-w * 0.5, z, h * 0.9], [0, z, h], [w * 0.5, z, h * 0.9], [w, z, 0]]

        prof = [make_curve({"id": f"p{i}", "kind": "spline", "points": pts(z, w, h)}) for i, (z, w, h) in enumerate(((0, 20, 10), (40, 30, 18), (80, 22, 12)))]
        guides = [
            make_curve({"id": "g0", "kind": "spline", "points": [[-20, 0, 0], [-30, 40, 0], [-22, 80, 0]]}),
            make_curve({"id": "g1", "kind": "spline", "points": [[0, 0, 10], [0, 40, 18], [0, 80, 12]]}),
            make_curve({"id": "g2", "kind": "spline", "points": [[20, 0, 0], [30, 40, 0], [22, 80, 0]]}),
        ]
        g = surfaces.gordon(prof, guides)
        self.assertTrue(g.is_valid)
        self.assertGreater(g.area, 5000)
        with self.assertRaises(ValueError):
            surfaces.gordon(prof, [make_curve({"id": "far", "kind": "line", "points": [[0, 0, 50], [0, 80, 50]]})] + guides[1:])
        rail = make_curve({"id": "r", "kind": "line", "points": [[0, 0, 0], [0, 100, 0]]})
        prof_c = make_curve({"id": "c", "kind": "circle", "center": [0, 0, 0], "normal": [0, 1, 0], "r": 10})
        guide = make_curve({"id": "gd", "kind": "spline", "points": [[10, 0, 0], [16, 50, 0], [10, 100, 0]]})
        plain = surfaces.sweep(prof_c, rail)
        guided = surfaces.sweep(prof_c, rail, guide)
        self.assertAlmostEqual(plain.bounding_box().size.X, 20, places=3)
        self.assertGreater(guided.bounding_box().size.X, 21)

    def test_loft_gates(self) -> None:
        a = make_curve({"id": "a", "kind": "spline", "points": [[0, 0, 0], [10, 0, 5], [20, 0, 0]]})
        b = make_curve({"id": "b", "kind": "spline", "points": [[20, 30, 0], [10, 30, 6], [0, 30, 0]]})  # reversed
        with self.assertRaises(ValueError):
            surfaces.loft([a, b])
        c = make_curve({"id": "c", "kind": "circle", "center": [0, 30, 0], "normal": [0, 1, 0], "r": 5})
        with self.assertRaises(ValueError):
            surfaces.loft([a, c])  # open + closed


class OpsTests(unittest.TestCase):
    def test_sew_free_edges(self) -> None:
        from build123d import Face

        f1 = Face.make_rect(10, 10)
        f2 = Face.make_rect(10, 10).moved(Location((10.05, 0, 0)))
        shells, free = ops.sew([f1, f2], 0.1)
        self.assertEqual(len(shells), 1)
        self.assertEqual(free, 6)
        shells2, free2 = ops.sew([f1, f2], 0.01)
        self.assertEqual(len(shells2), 2)

    def test_thicken_gate_and_volume(self) -> None:
        from build123d import GeomType, Shell

        half = Solid.make_sphere(10) & Box(40, 40, 40).moved(Location((0, 0, 20)))
        hemi = Shell([f for f in half.faces() if f.geom_type != GeomType.PLANE])
        s = ops.thicken(hemi, 1.0, "outward")
        self.assertAlmostEqual(s.volume, 2 / 3 * math.pi * (11 ** 3 - 10 ** 3), delta=0.5)
        s_in = ops.thicken(hemi, 1.0, "inward")
        self.assertAlmostEqual(s_in.volume, 2 / 3 * math.pi * (10 ** 3 - 9 ** 3), delta=0.5)
        with self.assertRaises(ValueError):
            ops.thicken(hemi, 12.0, "outward")  # kernel says valid; gate must not
        with self.assertRaises(ValueError):
            ops.thicken(hemi, 9.5, "inward")

    def test_mirror_fuse_fillet(self) -> None:
        from build123d import Face

        f = Face.make_rect(10, 10).moved(Location((10, 0, 0)))
        m = ops.mirror_faces([f], "YZ")[0]
        self.assertAlmostEqual(m.center().X, -10.0, places=6)
        head = Solid.make_sphere(20)
        ear = Solid.make_sphere(11).moved(Location((16, 0, 20)))
        fused = ops.fuse([head, ear, ear.mirror(ops._plane("YZ"))])
        self.assertTrue(fused.is_valid)
        self.assertGreaterEqual(len(ops.sharp_edges(fused)), 2)  # 兩圈交線(可能被球面接縫切段)
        rounded = ops.fillet_sharp(fused, 3.0)
        self.assertTrue(rounded.is_valid)
        self.assertEqual(ops.sharp_edges(rounded), [])
        with self.assertRaises(ValueError):
            ops.fillet_sharp(fused, 25.0)


class BuilderTests(unittest.TestCase):
    def test_examples_build_and_pass_gate(self) -> None:
        for name in ("mouse_shell", "vase", "mickey"):
            spec = _example(name)
            shape = SurfaceBuilder(spec).build()
            self.assertTrue(shape.is_valid, name)
            self.assertGreater(shape.volume, 0, name)
            check_surface_model(shape, spec)
            meta = harvest_meta(type("M", (), {"SURFACE_SPEC": spec}))
            self.assertEqual(meta["schemaVersion"], 1)
            self.assertNotIn("error", meta, name)
            self.assertTrue(meta["summary"]["ok"], name)
            json.dumps(meta)

    def test_mouse_symmetry_and_meta(self) -> None:
        spec = _example("mouse_shell")
        shape = SurfaceBuilder(spec).build()
        bb = shape.bounding_box()
        self.assertAlmostEqual(bb.min.X, -bb.max.X, places=3)
        build = last_build()
        rows, free = design_rows(build)
        self.assertEqual([r["grade"] for r in rows], ["G2"], "對稱接縫 G2")
        self.assertEqual(len(free), 6)
        meta = harvest_meta(type("M", (), {"SURFACE_SPEC": spec}))
        self.assertEqual(len(meta["cages"]), 2)
        self.assertEqual(len(meta["curves"]), 3)
        self.assertEqual(len(meta["combs"]), 3)
        self.assertTrue(meta["finalEdges"], "加厚後拓撲不同 → 最終邊也量")

    def test_params_override_thickness(self) -> None:
        spec = _example("vase")
        thin = SurfaceBuilder(spec, {"thick": 1.0}).build()
        thick = SurfaceBuilder(spec, {"thick": 3.0}).build()
        self.assertGreater(thick.volume, 2.5 * thin.volume)

    def test_must_fail_gates(self) -> None:
        spec = _example("mouse_shell")
        bad = json.loads(json.dumps(spec))
        for c in bad["curves"]:
            c.pop("tangents", None)
        with self.assertRaises(ValueError):
            SurfaceBuilder(bad).build()  # seam crease
        bad = json.loads(json.dumps(spec))
        bad["ops"][1]["t"] = 30
        with self.assertRaises(ValueError):
            SurfaceBuilder(bad).build()  # thicker than curvature radius
        bad = json.loads(json.dumps(spec))
        bad["ops"] = [{"op": "sew"}]
        with self.assertRaises(ValueError):
            SurfaceBuilder(bad).build()  # open shell, result solid, no thicken
        bad = json.loads(json.dumps(spec))
        bad["analysis"]["minContinuity"] = "G0"
        bad["result"] = "shell"
        bad["ops"] = [{"op": "sew"}]
        for c in bad["curves"]:
            c.pop("tangents", None)
        SurfaceBuilder(bad).build()  # crease allowed when G0 requested (shell; thicken over a crease is a kernel failure)

    def test_capped_extrude_cutter_and_role(self) -> None:
        # body = capped extruded circle (closed shell -> solid); cut = smaller capped cylinder through it
        spec = {
            "schemaVersion": 1, "result": "solid", "symmetry": None,
            "curves": [
                {"id": "outer", "kind": "circle", "center": [0, 0, 0], "normal": [0, 0, 1], "r": 20},
                {"id": "hole", "kind": "circle", "center": [0, 0, -5], "normal": [0, 0, 1], "r": 5},
            ],
            "surfaces": [
                {"id": "disc", "op": "extrude", "curve": "outer", "dir": [0, 0, 1], "length": 10, "capped": True},
                {"id": "bore", "op": "extrude", "curve": "hole", "dir": [0, 0, 1], "length": 20, "capped": True, "role": "cut"},
            ],
        }
        shape = SurfaceBuilder(spec).build()
        self.assertTrue(shape.is_valid)
        self.assertAlmostEqual(shape.volume, math.pi * (20 ** 2 - 5 ** 2) * 10, delta=1.0)
        check_surface_model(shape, spec)  # cap edges are flat-adjacent -> reported, not gated
        rows, _ = design_rows(last_build())
        self.assertTrue(rows and all(r["flat"] for r in rows), rows)
        bad = json.loads(json.dumps(spec))
        bad["surfaces"][1]["capped"] = False
        with self.assertRaises(ValueError):
            SurfaceBuilder(bad).build()  # open cutter shell
        # role=add:切除後才融合——穿過孔的軸不被孔吃掉(體積 = 盤 − 孔 + 軸的露出部分)
        add = json.loads(json.dumps(spec))
        add["curves"].append({"id": "axle", "kind": "circle", "center": [0, 0, -10], "normal": [0, 0, 1], "r": 6})
        add["surfaces"].append({"id": "shaft", "op": "extrude", "curve": "axle", "dir": [0, 0, 1], "length": 30, "capped": True, "role": "add"})
        shape2 = SurfaceBuilder(add).build()
        # 盤(r20,h10)− 孔(r5)+ 軸(r6,h30)− 軸與盤重疊的環(r5..6,h10)
        self.assertAlmostEqual(shape2.volume, math.pi * (20 ** 2 - 5 ** 2) * 10 + math.pi * 6 ** 2 * 30 - math.pi * (6 ** 2 - 5 ** 2) * 10, delta=2.0)
        floating = json.loads(json.dumps(add))
        floating["curves"][-1]["center"] = [60, 0, -10]
        with self.assertRaises(ValueError):
            SurfaceBuilder(floating).build()  # 附加體沒碰到本體

    def test_check_surface_model_reports_violation(self) -> None:
        spec = normalize_spec(_example("mickey"))
        shape = SurfaceBuilder(spec).build()
        from build123d import Shell

        # fake a build whose design shell has a G0 seam: cylinder side + hemisphere? no - use two
        # bspline-ish faces meeting at 90°: a quarter-cylinder patch and a swept flat-ish bspline
        # Simplest non-planar G0 seam: two half-cylinders of different radius sharing an axis line
        # would not share an edge; instead sew a cylinder side face to a cone side face (both
        # non-planar) that meet at a hard edge.
        cyl = Solid.make_cylinder(10, 10)
        cone = Solid.make_cone(10, 5, 10).moved(Location((0, 0, 10)))
        from build123d import GeomType

        cfaces = [f for f in (cyl + cone).faces() if f.geom_type != GeomType.PLANE]
        shells, _ = ops.sew(cfaces, 0.01)
        rows = A.edge_continuity(shells[0], samples=3, polyline_points=2)
        self.assertTrue(any(r["grade"] == "G0" and not r["flat"] for r in rows), rows)
        fake = {"shells": shells, "shape": shape, "spec": spec}
        with self.assertRaises(AssertionError):
            check_surface_model(shape, spec, build=fake)


if __name__ == "__main__":
    unittest.main()
