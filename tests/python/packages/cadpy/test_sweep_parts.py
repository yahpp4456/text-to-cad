"""Geometry tests for cadpy.parts.sweep (profile-along-path, real OCP solids).

Locks the closed forms (Pappus volume == area * path length -- also the cusp
regression witness, since a tangency-broken path sweeps into garbage the
kernel still calls "valid"), the EHSL width formula N*(pw+1)+3 against the
catalog, the measured OEM 16-series cross-section, the zero-twist witness
(swept bbox X == band width), and every validation gate with an input that
must FAIL -- mirrors the discipline of test_sheet_metal.py.
"""

from __future__ import annotations

import math
import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.geometry_checks import (  # noqa: E402
    assert_valid_solid,
    min_gap,
    overlap_volume,
)
from cadpy.parts import (  # noqa: E402
    NoFittingPart,
    cleanroom_sleeve,
    clamp_location,
    default_bend_r,
    kcl_clamp,
    load_specs,
    path_polyline,
    select_kcl_clamp,
    select_sleeve,
    sleeve_dims,
    sleeve_profile,
    swept_solid,
)
from cadpy.parts.sweep import (  # noqa: E402
    KCL_HOLE_D,
    KCL_PLATE_DEPTH,
    KCL_PLATE_T,
    check_geometry,
)

U_PATH = {"kind": "drag_chain", "straight_a": 300.0, "bend_r": 80.0, "straight_b": 300.0}
U_LEN = 300.0 + math.pi * 80.0 + 300.0


class PappusVolumeTests(unittest.TestCase):
    """Volume == section area * path length (centroid rides the spine, so the
    equality is exact) -- the sharpest witness against silent cusp garbage."""

    def test_circle_on_line(self) -> None:
        s = swept_solid({"kind": "circle", "d": 10.0}, {"kind": "line", "length": 100.0})
        self.assertAlmostEqual(s.volume, math.pi * 25.0 * 100.0, delta=1e-3)

    def test_hollow_circle_on_u_path(self) -> None:
        s = swept_solid({"kind": "circle", "d": 10.0}, U_PATH, wall_t=1.0)
        ring = math.pi * (25.0 - 16.0)
        self.assertAlmostEqual(s.volume / (ring * U_LEN), 1.0, places=6)

    def test_sleeve_on_u_path_matches_profile_area(self) -> None:
        prof = sleeve_profile(6, 16.0)
        s = cleanroom_sleeve(6, 16.0, path=U_PATH)
        self.assertAlmostEqual(s.volume / (prof.area * U_LEN), 1.0, places=6)

    def test_waypoints_fillet_closed_form(self) -> None:
        # L-path 100 x 80 with r=30 corner: len = 70 + 30*pi/2 + 50
        s = swept_solid(
            {"kind": "circle", "d": 8.0},
            {"kind": "waypoints", "points": [[0, 0], [100, 0], [100, 80]], "radius": 30.0},
        )
        length = 70.0 + 30.0 * math.pi / 2.0 + 50.0
        self.assertAlmostEqual(s.volume / (math.pi * 16.0 * length), 1.0, places=6)


class ValidSolidMatrixTests(unittest.TestCase):
    def test_profiles_by_paths(self) -> None:
        profiles = [
            {"kind": "stadium", "w": 20.0, "h": 8.0},
            {"kind": "rounded_rect", "w": 20.0, "h": 8.0, "r": 2.0},
            {"kind": "polyline", "points": [[0, 0], [20, 0], [20, 8], [0, 8]], "fillet_r": 1.5},
        ]
        paths = [{"kind": "line", "length": 60.0}, U_PATH]
        for prof in profiles:
            for path in paths:
                for wall in (None, 1.0):
                    with self.subTest(profile=prof["kind"], path=path["kind"], wall=wall):
                        s = swept_solid(prof, path, wall_t=wall)
                        assert_valid_solid(s, label=f"{prof['kind']} sweep")
                        self.assertEqual(len(s.solids()), 1)


class SleeveWidthFormulaTests(unittest.TestCase):
    """Total width N*(pw+1)+3 must land on the EHSL catalog numbers (the
    16-series is also directly measured from OEM Cable X.stp)."""

    CASES = {2: 37.0, 3: 54.0, 6: 105.0, 7: 122.0}

    def test_dims_closed_form(self) -> None:
        for pockets, total in self.CASES.items():
            self.assertAlmostEqual(sleeve_dims(pockets, 16.0)["total_w"], total, places=9)

    def test_profile_bbox_matches(self) -> None:
        for pockets, total in self.CASES.items():
            bb = sleeve_profile(pockets, 16.0).bounding_box()
            self.assertAlmostEqual(bb.size.X, total, places=6)
            self.assertAlmostEqual(bb.size.Y, 6.7, places=6)


class SleeveCrossSectionTests(unittest.TestCase):
    def test_measured_oem_16_series(self) -> None:
        # OEM Cable X.stp 6x16 band: bores 14.0 x 4.7 in a 6.7-high band, wall 1.0
        d = sleeve_dims(6, 16.0, wall_t=1.0)
        self.assertAlmostEqual(2 * d["bore_rx"], 14.0, places=9)
        self.assertAlmostEqual(2 * d["bore_ry"], 4.7, places=9)
        self.assertAlmostEqual(d["outer_h"], 6.7, places=9)
        # crown wall witness: (outer_h - bore_h) / 2 == wall_t
        self.assertAlmostEqual(d["ry"] - d["bore_ry"], d["wall_t"], places=12)

    def test_profile_face_count(self) -> None:
        prof = sleeve_profile(3, 16.0)
        self.assertEqual(len(prof.faces()), 1)  # one face, three bore holes
        self.assertEqual(len(prof.faces()[0].inner_wires()), 3)


class ZeroTwistTests(unittest.TestCase):
    def test_swept_band_bbox_x_is_band_width(self) -> None:
        s = cleanroom_sleeve(6, 16.0, path=U_PATH)
        self.assertAlmostEqual(s.bounding_box().size.X, 105.0, places=4)


class PathPolylineTests(unittest.TestCase):
    def test_u_path_samples(self) -> None:
        pts = path_polyline(U_PATH, 96)
        self.assertEqual(len(pts), 96)
        self.assertEqual(pts[0], [0.0, 0.0, 0.0])
        # 世界姿態 (d,e)->(0,-d,e):終點 d=sa-sb=0、e=2r → 頂層直段末端在正上方
        self.assertAlmostEqual(pts[-1][1], 0.0, places=9)  # -d = 0
        self.assertAlmostEqual(pts[-1][2], 160.0, places=9)  # e = 2r(上層)
        self.assertTrue(all(p[0] == 0.0 for p in pts))  # planar: world X = 0
        # near-equal chord spacing (chords under-shoot arcs only slightly)
        step = U_LEN / 95.0
        for a, b in zip(pts, pts[1:]):
            chord = math.dist(a, b)
            self.assertLess(abs(chord - step), 0.05 * step)

    def test_waypoints_fillet_continuity(self) -> None:
        pts = path_polyline(
            {"kind": "waypoints", "points": [[0, 0], [100, 0], [100, 80]], "radius": 30.0},
            64,
        )
        length = 70.0 + 30.0 * math.pi / 2.0 + 50.0
        step = length / 63.0
        for a, b in zip(pts, pts[1:]):
            self.assertLess(math.dist(a, b), 1.5 * step)
        self.assertAlmostEqual(pts[-1][1], -100.0, places=9)  # -d
        self.assertAlmostEqual(pts[-1][2], 80.0, places=9)  # e

    def test_tuple_at_offset(self) -> None:
        pts = path_polyline({"kind": "line", "length": 10.0}, 2, at=(1.0, 2.0, 3.0))
        self.assertEqual(pts[0], [1.0, 2.0, 3.0])
        self.assertEqual(pts[-1], [1.0, -8.0, 3.0])  # 直段沿 -Y(世界姿態)+ 平移

    def test_location_at_reorients(self) -> None:
        # Location 版 at(重新指定擺向的正路):Rot(Z=90) 把 -Y 直段轉到 +X。
        # 回歸鎖:Vertex.X/.Y/.Z 不吃 moved() location,必須走 center()。
        from build123d import Rot

        pts = path_polyline({"kind": "line", "length": 10.0}, 2, at=Rot(Z=90))
        self.assertAlmostEqual(pts[0][0], 0.0, places=9)
        self.assertAlmostEqual(pts[-1][0], 10.0, places=9)  # (0,-10,0) -Z90-> (10,0,0)
        self.assertAlmostEqual(pts[-1][1], 0.0, places=9)
        self.assertAlmostEqual(pts[-1][2], 0.0, places=9)


class ValueErrorGateTests(unittest.TestCase):
    def test_bend_radius_floor(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "circle", "d": 10.0},
                {"kind": "drag_chain", "straight_a": 50.0, "bend_r": 5.0, "straight_b": 50.0},
            )

    def test_self_intersecting_polyline(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "polyline", "points": [[0, 0], [10, 0], [0, 10], [10, 10]]},
                {"kind": "line", "length": 10.0},
            )

    def test_wall_too_thick(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "stadium", "w": 20.0, "h": 8.0},
                {"kind": "line", "length": 10.0},
                wall_t=4.0,
            )

    def test_sharp_corner_rejected(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "circle", "d": 10.0},
                {"kind": "waypoints", "points": [[0, 0], [50, 0], [50, 50]], "radius": 0},
            )

    def test_fillet_radius_too_large(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "circle", "d": 6.0},
                {"kind": "waypoints", "points": [[0, 0], [20, 0], [20, 20]], "radius": 50.0},
            )

    def test_reversal_corner_rejected(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "circle", "d": 6.0},
                {"kind": "waypoints", "points": [[0, 0], [50, 0], [0, 0]], "radius": 10.0},
            )

    def test_spline_v1_unsupported(self) -> None:
        with self.assertRaises(ValueError):
            swept_solid(
                {"kind": "circle", "d": 6.0},
                {"kind": "spline", "points": [[0, 0], [50, 20]]},
            )

    def test_pockets_and_wall_gates(self) -> None:
        with self.assertRaises(ValueError):
            cleanroom_sleeve(0, 16.0)
        with self.assertRaises(ValueError):
            sleeve_dims(3, 16.0, wall_t=3.4)  # >= outer_h / 2
        with self.assertRaises(ValueError):
            default_bend_r(16.0, factor=5.0)

    def test_check_geometry_rejects_sweep_args(self) -> None:
        s = swept_solid({"kind": "circle", "d": 8.0}, {"kind": "line", "length": 20.0})
        with self.assertRaises(ValueError):
            check_geometry(s, sweep_args={})

    def test_kcl_clamp_arg_exclusivity(self) -> None:
        with self.assertRaises(ValueError):
            kcl_clamp("7A", sleeve_width=105.0)
        with self.assertRaises(ValueError):
            kcl_clamp()
        with self.assertRaises(ValueError):
            kcl_clamp("9Z")

    def test_polyline_samples_gate(self) -> None:
        with self.assertRaises(ValueError):
            path_polyline(U_PATH, 1)


class KclClampTests(unittest.TestCase):
    def test_closed_forms_7a(self) -> None:
        k = kcl_clamp("7A", sleeve_h=6.7)
        bb = k.bounding_box()
        self.assertAlmostEqual(bb.size.X, 118.2, places=6)
        self.assertAlmostEqual(bb.size.Y, 6.7 + 2 * KCL_PLATE_T, places=6)
        self.assertAlmostEqual(bb.size.Z, KCL_PLATE_DEPTH, places=6)
        plate_v = 118.2 * KCL_PLATE_T * KCL_PLATE_DEPTH - 2 * (
            math.pi / 4.0 * KCL_HOLE_D**2 * KCL_PLATE_T
        )
        self.assertAlmostEqual(k.volume / (2 * plate_v), 1.0, places=6)
        self.assertEqual([c.label for c in k.children], ["kcl_top", "kcl_bottom"])

    def test_clamp_touches_sleeve_without_overlap(self) -> None:
        # 夾板要經 clamp_location 擺放(同 fixture 用法)——出口姿態旋轉後,
        # 未擺放的 BUILD frame 夾板與世界姿態護套不再同框。
        sleeve = cleanroom_sleeve(6, 16.0, path=U_PATH)
        clamp = kcl_clamp(sleeve_width=105.0, sleeve_h=6.7)
        loc = clamp_location(U_PATH, "start")
        for plate in clamp.children:
            placed = loc * plate
            self.assertAlmostEqual(min_gap(placed, sleeve), 0.0, places=6)
            self.assertAlmostEqual(overlap_volume(placed, sleeve), 0.0, places=6)

    def test_clamp_location_end_lands_on_path_end(self) -> None:
        from build123d import Vertex

        loc = clamp_location(U_PATH, "end")
        p = loc.position  # transform of the local origin
        # 世界姿態:U 終點 (d=0, e=2r) → (0, 0, 160):上層直段末端在起點正上方
        self.assertAlmostEqual(p.X, 0.0, places=9)
        self.assertAlmostEqual(p.Y, 0.0, places=9)
        self.assertAlmostEqual(p.Z, 160.0, places=9)
        # local +Z 指回路徑內側(上層直段的 +d 方向,世界像 = -Y);高度(Z)不變。
        # 注意:Vertex.X/.Y/.Z 不吃 moved() location,要讀 center()(回歸鎖)。
        q = Vertex(0, 0, 10.0).moved(loc).center()
        self.assertAlmostEqual(q.Y - p.Y, -10.0, places=9)
        self.assertAlmostEqual(q.Z - p.Z, 0.0, places=9)


class SelectTests(unittest.TestCase):
    def test_select_sleeve_three_8mm_cables(self) -> None:
        row = select_sleeve([8.0, 8.0, 8.0])
        self.assertEqual(row["model"], "EHSL 00316")
        self.assertEqual(row["pockets"], 3)
        self.assertAlmostEqual(row["selected_for"]["bend_r"], 80.0, places=9)

    def test_select_sleeve_no_fit(self) -> None:
        with self.assertRaises(NoFittingPart):
            select_sleeve([40.0])  # OD beyond the 66-pocket's 33 max
        with self.assertRaises(NoFittingPart):
            select_sleeve([8.0] * 8)  # more pockets than any 16-fit row offers

    def test_select_kcl_pairs_like_oem(self) -> None:
        self.assertEqual(select_kcl_clamp(6, 105.0)["size"], "7A")
        self.assertEqual(select_kcl_clamp(2, 37.0)["size"], "2A")
        with self.assertRaises(NoFittingPart):
            select_kcl_clamp(7, 122.0)


class ProfileLoopsTests(unittest.TestCase):
    """2D 預覽 loops(零 OCP 取樣)——掃出工作窗右半的資料源。"""

    def test_sleeve_loops_closed_forms(self) -> None:
        from cadpy.parts import sleeve_profile_loops

        loops = sleeve_profile_loops(6, 16.0, wall_t=1.0)
        self.assertEqual(len(loops), 7)  # 1 外圈 + 6 內腔
        outer = loops[0]
        xs = [p[0] for p in outer]
        ys = [p[1] for p in outer]
        self.assertAlmostEqual(max(xs) - min(xs), 105.0, places=9)  # 總寬閉式
        self.assertAlmostEqual(max(ys) - min(ys), 6.7, places=9)  # outer_h
        self.assertLessEqual(len(outer), 512)  # 收割上限內
        ox0, ox1, oy0, oy1 = min(xs), max(xs), min(ys), max(ys)
        for bore in loops[1:]:
            bxs = [p[0] for p in bore]
            bys = [p[1] for p in bore]
            self.assertAlmostEqual(max(bxs) - min(bxs), 14.0, places=9)  # bore_w
            self.assertAlmostEqual(max(bys) - min(bys), 4.7, places=9)  # bore_h
            self.assertTrue(ox0 < min(bxs) and max(bxs) < ox1)
            self.assertTrue(oy0 < min(bys) and max(bys) < oy1)

    def test_generic_loops(self) -> None:
        from cadpy.parts import profile_loops

        circ = profile_loops({"kind": "circle", "d": 10.0}, wall_t=1.0)
        self.assertEqual(len(circ), 2)
        self.assertAlmostEqual(max(math.hypot(*p) for p in circ[0]), 5.0, places=9)
        self.assertAlmostEqual(max(math.hypot(*p) for p in circ[1]), 4.0, places=9)

        st = profile_loops({"kind": "stadium", "w": 20.0, "h": 8.0})
        xs = [p[0] for p in st[0]]
        ys = [p[1] for p in st[0]]
        self.assertAlmostEqual(max(xs) - min(xs), 20.0, places=9)
        self.assertAlmostEqual(max(ys) - min(ys), 8.0, places=9)

        rr = profile_loops({"kind": "rounded_rect", "w": 20.0, "h": 8.0, "r": 2.0})
        xs = [p[0] for p in rr[0]]
        self.assertAlmostEqual(max(xs) - min(xs), 20.0, places=9)

        # polyline:質心置原點(與 _polyline_face 同慣例)、只回外圈
        pl = profile_loops({"kind": "polyline", "points": [[0, 0], [20, 0], [20, 8], [0, 8]]}, wall_t=1.0)
        self.assertEqual(len(pl), 1)
        cx = sum(p[0] for p in pl[0]) / len(pl[0])
        self.assertAlmostEqual(cx, 0.0, places=9)

    def test_loops_gates(self) -> None:
        from cadpy.parts import profile_loops, sleeve_profile_loops

        with self.assertRaises(ValueError):
            profile_loops({"kind": "circle", "d": 10.0}, wall_t=5.0)
        with self.assertRaises(ValueError):
            profile_loops({"kind": "polyline", "points": [[0, 0], [10, 0], [0, 10], [10, 10]]})
        with self.assertRaises(ValueError):
            sleeve_profile_loops(0, 16.0)
        with self.assertRaises(ValueError):
            sleeve_profile_loops(3, 16.0, samples_per_arc=2)


class SpecsHonestyTests(unittest.TestCase):
    def test_spec_tables_pass_honesty_gate(self) -> None:
        self.assertGreaterEqual(len(load_specs("ehsl_sleeves")), 20)
        self.assertEqual(len(load_specs("kcl_clamps")), 6)


if __name__ == "__main__":
    unittest.main()
