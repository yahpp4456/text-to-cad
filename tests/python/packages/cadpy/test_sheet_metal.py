"""Geometry tests for cadpy.parts.sheet_metal (fold tree, real OCP solids).

The fold tree is the single source of truth for folded()/flat()/dxf(); tests
lock the closed forms (bend allowance, jog web, flat size), the K=0.5 volume
invariant, the DXF layer contract (skills/dxf: bend layer names contain
"bend"), and every validation gate with a fixture that must FAIL -- mirrors
the sandbox discipline of the other parts families.
"""

from __future__ import annotations

import math
import os
import tempfile
import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.geometry_checks import assert_all_valid, assert_valid_solid  # noqa: E402
from cadpy.parts import (  # noqa: E402
    DEFAULT_K_FACTOR,
    SheetMetal,
    bend_allowance,
    jog_web,
)
from cadpy.parts.sheet_metal import check_geometry as check_sheet  # noqa: E402


def _l_bracket(k: float = DEFAULT_K_FACTOR) -> SheetMetal:
    """t=2, R=2; base 56x30 + one 90-degree flange of OUTER leg length 40
    (web 36). Folded outer sizes: 60 (=56+R+t) x 40."""
    sm = SheetMetal(thickness=2.0, bend_radius=2.0, k_factor=k, label="lb")
    sm.base_rect(56.0, 30.0).flange("x+", length=40.0, label="leg")
    return sm


class BendMathTests(unittest.TestCase):
    def test_bend_allowance_closed_form(self) -> None:
        self.assertAlmostEqual(
            bend_allowance(90.0, 2.0, 2.0, 0.44),
            math.pi / 2.0 * (2.0 + 0.88),
            places=9,
        )
        # magnitude only: down-folds unfold to the same length
        self.assertAlmostEqual(
            bend_allowance(-90.0, 2.0, 2.0, 0.44),
            bend_allowance(90.0, 2.0, 2.0, 0.44),
            places=12,
        )

    def test_jog_web_closed_form_90deg(self) -> None:
        # theta=90 degenerates to w = offset - 2R - t
        self.assertAlmostEqual(jog_web(10.0, 90.0, 2.0, 2.0), 4.0, places=9)


class LBracketTests(unittest.TestCase):
    def test_flat_length_closed_form(self) -> None:
        sm = _l_bracket()
        ba = bend_allowance(90.0, 2.0, 2.0, DEFAULT_K_FACTOR)
        dx, dy = sm.flat_size()
        # outer-size form: a + b - 2*(R+t) + BA with a=60, b=40
        self.assertAlmostEqual(dx, 60.0 + 40.0 - 2.0 * 4.0 + ba, places=6)
        self.assertAlmostEqual(dy, 30.0, places=6)

    def test_volume_invariant_k_half(self) -> None:
        # K=0.5: bend-zone volume == strap volume exactly; tolerance scales
        # with seam count (tab slivers are ~0 by construction, keep margin)
        sm = _l_bracket(k=0.5)
        self.assertAlmostEqual(sm.folded().volume, sm.flat().volume, delta=1 * 0.1)

    def test_flat_thickness_and_label(self) -> None:
        flat = _l_bracket().flat()
        bb = flat.bounding_box()
        self.assertAlmostEqual(bb.max.Z - bb.min.Z, 2.0, places=6)
        self.assertEqual(flat.label, "lb_flat")  # underscore, not ':' (cadjs labels)

    def test_folded_outer_sizes(self) -> None:
        body = _l_bracket().folded()
        self.assertEqual(body.label, "lb")
        bb = body.bounding_box()
        self.assertAlmostEqual(bb.max.Z, 40.0, places=6)  # length = OUTER leg
        self.assertAlmostEqual(bb.max.X, 60.0, places=6)  # base 56 + (R+t)

    def test_down_fold_mirrors_up_fold(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="down")
        sm.base_rect(56.0, 30.0).flange("x+", angle=-90.0, web=36.0)
        body = sm.folded()
        assert_valid_solid(body, label="down folded")
        bb = body.bounding_box()
        self.assertAlmostEqual(bb.min.Z, -38.0, places=6)  # web 36 + R 2 below z=0
        self.assertAlmostEqual(bb.max.Z, 2.0, places=6)


class AngleRobustnessTests(unittest.TestCase):
    """Tangent-fuse robustness across sweep angles (the tab strategy's gate)."""

    def test_folded_valid_at_30_135_180(self) -> None:
        for angle in (30.0, 135.0, 180.0):
            sm = SheetMetal(thickness=2.0, bend_radius=2.0, label=f"a{angle:g}")
            sm.base_rect(50.0, 30.0).flange("x+", angle=angle, web=20.0)
            body = sm.folded()
            solids = body.solids()
            self.assertEqual(len(solids), 1, f"angle={angle}: fuse split")
            assert_valid_solid(body, label=f"folded {angle}")


class HemJogTests(unittest.TestCase):
    def test_hem_flat_length(self) -> None:
        # base web + BA(180, R=gap/2) + return length
        sm = SheetMetal(thickness=1.5, bend_radius=1.5, k_factor=0.44, label="hem")
        sm.base_rect(50.0, 30.0).hem(1, length=8.0, gap=1.5, label="lip")
        ba = bend_allowance(180.0, 0.75, 1.5, 0.44)
        dx, _dy = sm.flat_size()
        self.assertAlmostEqual(dx, 50.0 + ba + 8.0, places=6)

    def test_hem_folded_valid_and_clears_parent(self) -> None:
        sm = SheetMetal(thickness=1.5, bend_radius=1.5, label="hem2")
        wall = sm.base_rect(50.0, 30.0).flange("x+", length=25.0, label="wall")
        wall.hem("tip", length=8.0, label="lip")
        assert_valid_solid(sm.folded(), label="hem folded")

    def test_jog_offset_realized(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="jog")
        sm.base_rect(60.0, 30.0).jog("x+", offset=16.0, length=20.0, label="step")
        body = sm.folded()
        assert_valid_solid(body, label="jog folded")
        # continuation plate top face sits at offset + t
        self.assertAlmostEqual(body.bounding_box().max.Z, 18.0, places=6)

    def test_jog_dxf_has_two_bend_lines(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="jogd")
        sm.base_rect(60.0, 30.0).jog("x+", offset=16.0, length=20.0)
        counts = _dxf_counts(sm.dxf())
        self.assertEqual(counts["bend_up"] + counts["bend_down"], 2)
        self.assertEqual(counts["bend_up"], 1)
        self.assertEqual(counts["bend_down"], 1)


class CornerReliefTests(unittest.TestCase):
    def test_auto_square_relief_flat_area_closed_form(self) -> None:
        # base W x D + two adjacent full-edge flanges; relief cuts one s x s
        # square out of the base corner; strap+web areas use trimmed spans
        t, r, k, s = 1.5, 2.0, 0.44, 1.5
        W, D, web = 60.0, 40.0, 15.0
        sm = SheetMetal(thickness=t, bend_radius=r, k_factor=k, label="rel")
        b = sm.base_rect(W, D)
        b.flange("x+", web=web, label="fx")
        b.flange("y+", web=web, label="fy")
        ba = bend_allowance(90.0, r, t, k)
        span_x = D - s  # x+ edge runs y- -> y+; trimmed at the shared top corner
        span_y = W - s
        expect = (W * D - s * s) + (span_x + span_y) * (ba + web)
        face_area = sm._flat_face().area
        self.assertAlmostEqual(face_area, expect, places=5)

    def test_relief_disabled_touching_spans_must_fail(self) -> None:
        sm = SheetMetal(thickness=1.5, bend_radius=2.0, corner_relief=None, label="norel")
        b = sm.base_rect(60.0, 40.0)
        b.flange("x+", web=15.0)
        b.flange("y+", web=15.0)
        with self.assertRaises(ValueError):
            sm.flat_size()

    def test_four_wall_inside_box_outer_size_is_declared(self) -> None:
        sm = SheetMetal(thickness=1.5, bend_radius=2.0, label="box")
        b = sm.base_rect(120.0, 80.0)
        for e in ("x+", "x-", "y+", "y-"):
            b.flange(e, length=40.0, placement="inside", label=f"wall_{e}")
        body = sm.folded()
        assert_valid_solid(body, label="box folded")
        bb = body.bounding_box()
        self.assertAlmostEqual(bb.max.X - bb.min.X, 120.0, places=6)
        self.assertAlmostEqual(bb.max.Y - bb.min.Y, 80.0, places=6)
        self.assertAlmostEqual(bb.max.Z, 40.0, places=6)
        assert_valid_solid(sm.flat(), label="box flat")

    def test_partial_span_flange(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="span")
        sm.base_rect(80.0, 40.0).flange("x+", web=15.0, span=(5.0, 25.0), label="tab")
        body = sm.folded()
        assert_valid_solid(body, label="partial span")
        counts = _dxf_counts(sm.dxf())
        self.assertEqual(counts["bend_up"], 1)
        self.assertAlmostEqual(counts["bend_len"], 20.0, places=6)


def _dxf_counts(doc) -> dict:
    """Write + read back via ezdxf; return layer/entity counts (self-computed
    extents -- the $EXTMIN/$EXTMAX headers are not written automatically)."""
    import ezdxf

    tmp = os.path.join(tempfile.gettempdir(), "cadpy_sm_test.dxf")
    doc.saveas(tmp)
    rd = ezdxf.readfile(tmp)
    msp = rd.modelspace()
    out = {
        "layers": {e.dxf.layer for e in msp},
        "kinds": {e.dxftype() for e in msp},
        "circles": len(msp.query("CIRCLE")),
        "polys": len(msp.query("LWPOLYLINE")),
        "bend_up": 0,
        "bend_down": 0,
        "bend_len": 0.0,
        "units": rd.units,
    }
    xs, ys = [], []
    for e in msp.query("LINE"):
        layer = e.dxf.layer
        p0, p1 = e.dxf.start, e.dxf.end
        if layer.startswith("BEND_UP"):
            out["bend_up"] += 1
            out["bend_len"] = math.hypot(p1.x - p0.x, p1.y - p0.y)
        elif layer.startswith("BEND_DOWN"):
            out["bend_down"] += 1
        xs += [p0.x, p1.x]
        ys += [p0.y, p1.y]
    for e in msp.query("LWPOLYLINE"):
        for x, y, *_ in e.get_points():
            xs.append(x)
            ys.append(y)
    for e in msp.query("CIRCLE"):
        c, r = e.dxf.center, e.dxf.radius
        xs += [c.x - r, c.x + r]
        ys += [c.y - r, c.y + r]
    out["extents"] = (max(xs) - min(xs), max(ys) - min(ys)) if xs else (0.0, 0.0)
    return out


class DxfRoundTripTests(unittest.TestCase):
    def _two_leg_shell(self) -> SheetMetal:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="dx")
        b = sm.base_rect(56.0, 30.0)
        leg = b.flange("x+", length=40.0, label="legA")
        b.flange("x-", length=25.0, label="legB")
        b.hole(10.0, 15.0, d=6.0)
        leg.hole(18.0, 15.0, d=5.0)
        b.cutout([(20.0, 8.0), (36.0, 8.0), (36.0, 22.0), (20.0, 22.0)])
        return sm

    def test_layers_contours_and_bend_lines(self) -> None:
        import ezdxf

        sm = self._two_leg_shell()
        counts = _dxf_counts(sm.dxf())
        # bend layer names carry direction+angle and contain "bend" lowercased
        self.assertEqual(counts["layers"], {"CUT", "BEND_UP_90"})
        self.assertTrue(all("bend" in l.lower()
                            for l in counts["layers"] if l != "CUT"))
        self.assertEqual(counts["bend_up"], 2)
        self.assertAlmostEqual(counts["bend_len"], 30.0, places=6)
        self.assertEqual(counts["circles"], 2)
        self.assertEqual(counts["polys"], 2)  # outer contour + rect cutout
        dx, dy = sm.flat_size()
        self.assertAlmostEqual(counts["extents"][0], dx, places=6)
        self.assertAlmostEqual(counts["extents"][1], dy, places=6)
        self.assertEqual(counts["units"], ezdxf.units.MM)

    def test_only_supported_entity_types(self) -> None:
        counts = _dxf_counts(self._two_leg_shell().dxf())
        # skills/dxf render_payload whitelist
        self.assertTrue(counts["kinds"] <= {"LINE", "ARC", "CIRCLE", "LWPOLYLINE"})


class MustFailTests(unittest.TestCase):
    """Every gate locked by a fixture that must FAIL (ValueError, zh message)."""

    def test_flange_too_short(self) -> None:
        sm = SheetMetal(thickness=2.0)
        with self.assertRaisesRegex(ValueError, "最小凸緣長"):
            sm.base_rect(50.0, 30.0).flange("x+", web=2.0)

    def test_hole_too_close_to_bend(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0)
        b = sm.base_rect(56.0, 30.0)
        b.flange("x+", web=20.0)
        b.hole(51.0, 15.0, d=6.0)  # edge margin ok (2mm), bend clearance 2 < 6
        with self.assertRaisesRegex(ValueError, "距折彎"):
            sm.flat_size()

    def test_hole_off_panel(self) -> None:
        sm = SheetMetal(thickness=2.0)
        b = sm.base_rect(50.0, 30.0)
        b.hole(60.0, 15.0, d=5.0)
        with self.assertRaisesRegex(ValueError, "板外"):
            sm.flat_size()

    def test_jog_offset_infeasible_names_minimum(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0)
        with self.assertRaisesRegex(ValueError, "最小可行 offset"):
            sm.base_rect(60.0, 30.0).jog("x+", offset=5.0, length=20.0)

    def test_k_factor_out_of_range(self) -> None:
        with self.assertRaisesRegex(ValueError, "k_factor"):
            SheetMetal(thickness=2.0, k_factor=0.7)
        sm = SheetMetal(thickness=2.0)
        with self.assertRaisesRegex(ValueError, "k_factor"):
            sm.base_rect(50.0, 30.0).flange("x+", web=10.0, k_factor=0.9)

    def test_radius_below_half_thickness(self) -> None:
        with self.assertRaisesRegex(ValueError, "半板厚"):
            SheetMetal(thickness=2.0, bend_radius=0.5)
        sm = SheetMetal(thickness=2.0)
        with self.assertRaisesRegex(ValueError, "半板厚"):
            sm.base_rect(50.0, 30.0).flange("x+", web=10.0, radius=0.5)

    def test_overlapping_spans_same_edge(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0)
        b = sm.base_rect(80.0, 40.0)
        b.flange("x+", web=10.0, span=(0.0, 20.0))
        b.flange("x+", web=10.0, span=(21.0, 40.0))  # gap 1 < t
        with self.assertRaisesRegex(ValueError, "span 重疊或間距"):
            sm.flat_size()

    def test_folded_self_collision_u_channel_lips(self) -> None:
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="u")
        b = sm.base_rect(30.0, 40.0)
        wr = b.flange("x+", web=20.0, label="wallR")
        wl = b.flange("x-", web=20.0, label="wallL")
        wr.flange("tip", web=18.0, label="lipR")
        wl.flange("tip", web=18.0, label="lipL")
        with self.assertRaisesRegex(ValueError, "摺疊後自碰"):
            sm.folded()

    def test_flat_self_intersection_concave_corner(self) -> None:
        # H2 gate: flanges on the two edges of a CONCAVE corner unfold into
        # each other -- folded is legal, the flat pattern silently is not
        sm = SheetMetal(thickness=2.0, bend_radius=2.0, label="cc")
        b = sm.base([(0, 0), (60, 0), (60, 30), (30, 30), (30, 60), (0, 60)])
        b.flange(2, web=25.0, label="fA")
        b.flange(3, web=25.0, label="fB")
        with self.assertRaisesRegex(ValueError, "攤平圖自交"):
            sm.flat_size()

    def test_length_with_non_right_angle(self) -> None:
        sm = SheetMetal(thickness=2.0)
        with self.assertRaisesRegex(ValueError, "web="):
            sm.base_rect(50.0, 30.0).flange("x+", angle=45.0, length=20.0)

    def test_hem_gap_below_thickness(self) -> None:
        sm = SheetMetal(thickness=2.0)
        with self.assertRaisesRegex(ValueError, "gap"):
            sm.base_rect(50.0, 30.0).hem(1, length=8.0, gap=1.0)

    def test_flange_on_flange_seam_edge(self) -> None:
        sm = SheetMetal(thickness=2.0)
        wall = sm.base_rect(50.0, 30.0).flange("x+", web=20.0)
        with self.assertRaisesRegex(ValueError, "seam"):
            wall.flange(3, web=10.0)

    def test_frozen_tree_rejects_new_features(self) -> None:
        # freeze gate fires on feature calls (base re-declaration has its own
        # earlier "base 已宣告過" guard, so probe with a hole)
        sm = SheetMetal(thickness=2.0, bend_radius=2.0)
        panel = sm.base_rect(50.0, 30.0)
        sm.folded()
        with self.assertRaisesRegex(ValueError, "凍結"):
            panel.hole(10.0, 10.0, d=5.0)


class CheckGeometryGateTests(unittest.TestCase):
    def test_single_part_gate_passes_folded_and_flat(self) -> None:
        sm = _l_bracket()
        check_sheet(sm.folded())
        check_sheet(_l_bracket().flat())

    def test_compound_interference_must_fail(self) -> None:
        from build123d import Box, Compound, Pos

        body = _l_bracket().folded()
        clash = Pos(28.0, 15.0, 0.0) * Box(10.0, 10.0, 10.0)
        clash.label = "clash"
        comp = Compound(label="assy", children=[body, clash])
        assert_all_valid(comp, label="pre")  # both solids are valid...
        with self.assertRaises(AssertionError):  # ...but interpenetrate
            check_sheet(comp)

    def test_sweep_args_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "運動掃掠"):
            check_sheet(_l_bracket().folded(), sweep_args={})


if __name__ == "__main__":
    unittest.main()
