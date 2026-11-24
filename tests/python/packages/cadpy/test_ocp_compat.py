"""``cadpy.kernel.ocp_compat``: the names that differ between OCP 7.9 and OCP 8.

These run on whichever kernel the interpreter has; the point is that the same
calls work on both, so each assertion is about behaviour, not about which
module a class came from.
"""

from __future__ import annotations

import unittest

from cadpy.kernel import ocp_compat
from cadpy.kernel.ocp_compat import IndexedMapOfShape, LabelSequence, ListOfShape, bnd_box_limits


class OcpCompatTests(unittest.TestCase):
    def test_indexed_map_of_shape_indexes_faces_from_one(self) -> None:
        from build123d import Box
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp

        shape = Box(1, 2, 3).wrapped
        faces = IndexedMapOfShape()
        TopExp.MapShapes_s(shape, TopAbs_FACE, faces)
        self.assertEqual(faces.Extent(), 6)
        first = faces.FindKey(1)
        self.assertEqual(faces.FindIndex(first), 1)
        self.assertTrue(faces.Contains(first))

    def test_label_sequence_starts_empty(self) -> None:
        sequence = LabelSequence()
        self.assertEqual(sequence.Length(), 0)
        self.assertTrue(sequence.IsEmpty())

    def test_list_of_shape_appends(self) -> None:
        from build123d import Box

        shapes = ListOfShape()
        shapes.Append(Box(1, 1, 1).wrapped)
        shapes.Append(Box(2, 2, 2).wrapped)
        self.assertEqual(shapes.Extent(), 2)

    def test_bnd_box_limits_matches_the_box_including_its_gap(self) -> None:
        from OCP.Bnd import Bnd_Box

        box = Bnd_Box()
        box.Update(1.0, 2.0, 3.0, 4.0, 5.0, 6.0)
        self.assertEqual(bnd_box_limits(box), (1.0, 2.0, 3.0, 4.0, 5.0, 6.0))
        box.SetGap(0.5)
        self.assertEqual(bnd_box_limits(box), (0.5, 1.5, 2.5, 4.5, 5.5, 6.5))

    def test_bnd_box_limits_of_a_real_shape(self) -> None:
        from build123d import Box, Pos
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib

        box = Bnd_Box()
        BRepBndLib.AddOptimal_s((Pos(10, 0, 0) * Box(2, 4, 6)).wrapped, box, False, False)
        limits = bnd_box_limits(box)
        for got, want in zip(limits, (9.0, -2.0, -3.0, 11.0, 2.0, 3.0)):
            self.assertAlmostEqual(got, want, places=5)

    def test_suffixless_downcasts_exist(self) -> None:
        # The spelling both kernels accept; OCP 8 dropped the ``_s`` forms.
        from build123d import Box
        from OCP.TopoDS import TopoDS, TopoDS_Edge, TopoDS_Face, TopoDS_Vertex

        box = Box(1, 1, 1)
        self.assertIsInstance(TopoDS.Face(box.faces()[0].wrapped), TopoDS_Face)
        self.assertIsInstance(TopoDS.Edge(box.edges()[0].wrapped), TopoDS_Edge)
        self.assertIsInstance(TopoDS.Vertex(box.vertices()[0].wrapped), TopoDS_Vertex)

    def test_flag_says_which_layout_was_found(self) -> None:
        import importlib.util

        self.assertEqual(
            ocp_compat.OCP_COLLECTIONS_MODULE,
            importlib.util.find_spec("OCP.collections") is not None,
        )


if __name__ == "__main__":
    unittest.main()
