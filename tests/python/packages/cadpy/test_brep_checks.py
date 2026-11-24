"""``cadpy.kernel.brep_checks``: an invalid solid's faults, by name and by face.

The injected defects are the ones a generator actually produces: a shell that is
not closed, and a face whose wires run the wrong way round.
"""

from __future__ import annotations

import unittest

from cadpy.geometry_checks import (
    assert_all_valid,
    assert_valid_solid,
    invalid_solid_detail,
    is_valid_solid,
)
from cadpy.kernel.brep_checks import diagnose, summarize


def _open_shell_solid():
    """A 'solid' built from 5 of a box's 6 faces: its shell is not closed."""
    from build123d import Box
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.TopoDS import TopoDS_Shell

    shell = TopoDS_Shell()
    builder = BRep_Builder()
    builder.MakeShell(shell)
    for face in list(Box(10, 10, 10).faces())[:5]:
        builder.Add(shell, face.wrapped)
    return BRepBuilderAPI_MakeSolid(shell).Solid()


class DiagnoseTests(unittest.TestCase):
    def test_valid_box_has_no_findings(self) -> None:
        from build123d import Box

        box = Box(10, 20, 30)
        self.assertTrue(is_valid_solid(box))
        self.assertEqual(diagnose(box), [])
        self.assertEqual(invalid_solid_detail(box), "")

    def test_open_shell_is_named(self) -> None:
        solid = _open_shell_solid()
        self.assertFalse(is_valid_solid(solid))
        findings = diagnose(solid)
        self.assertEqual(findings, [{"kind": "shell", "index": 1, "faults": ["NotClosed"]}])
        self.assertEqual(summarize(findings), "shell 1: NotClosed")
        self.assertEqual(invalid_solid_detail(solid), "shell 1: NotClosed")

    def test_accepts_build123d_and_raw_shapes_and_never_raises(self) -> None:
        from build123d import Box, Solid

        raw = _open_shell_solid()
        self.assertEqual(diagnose(Solid(raw)), diagnose(raw))
        self.assertEqual(diagnose(None), [])
        from OCP.TopoDS import TopoDS_Shape

        self.assertEqual(diagnose(TopoDS_Shape()), [])  # null shape
        self.assertEqual(invalid_solid_detail(object()), "")  # not a shape at all
        self.assertEqual(diagnose(Box(1, 1, 1).wrapped), [])

    def test_face_indices_follow_step_topology_order(self) -> None:
        # A compound of a good box and the open one: the fault is reported on the
        # compound's shell 2, the numbering a pick token's ordinals use.
        from build123d import Box, Compound, Pos, Solid

        compound = Compound(children=[Box(5, 5, 5), Pos(50, 0, 0) * Solid(_open_shell_solid())])
        findings = diagnose(compound)
        self.assertEqual([(f["kind"], f["index"], f["faults"]) for f in findings], [("shell", 2, ["NotClosed"])])


class SummarizeTests(unittest.TestCase):
    def test_wire_findings_name_their_face(self) -> None:
        findings = [
            {"kind": "face", "index": 12, "faults": ["IntersectingWires"]},
            {"kind": "wire", "index": 2, "face": 12, "faults": ["SelfIntersectingWire", "NotClosed"]},
        ]
        self.assertEqual(
            summarize(findings),
            "face 12: IntersectingWires; face 12 wire 2: SelfIntersectingWire, NotClosed",
        )

    def test_long_lists_are_counted_not_spelled_out(self) -> None:
        findings = [{"kind": "face", "index": i, "faults": ["BadOrientationOfSubshape"]} for i in range(1, 8)]
        self.assertTrue(summarize(findings).endswith("; +4 more"))
        self.assertEqual(summarize(findings, limit=1), "face 1: BadOrientationOfSubshape; +6 more")
        self.assertEqual(summarize([]), "")


class AssertionMessageTests(unittest.TestCase):
    """The fixed heads of these messages are matched elsewhere (cad-chat's lessons
    library keys on them); the named faults are appended, never substituted."""

    def test_assert_valid_solid_keeps_its_prefix_and_appends_the_fault(self) -> None:
        with self.assertRaises(AssertionError) as caught:
            assert_valid_solid(_open_shell_solid(), label="bracket")
        self.assertEqual(
            str(caught.exception),
            "bracket: BRepCheck_Analyzer reports an invalid solid (shell 1: NotClosed)",
        )

    def test_assert_all_valid_names_the_part_then_its_fault(self) -> None:
        from build123d import Box

        parts = [("base", Box(5, 5, 5)), ("lid", _open_shell_solid())]
        with self.assertRaises(AssertionError) as caught:
            assert_all_valid(parts, label="part")
        message = str(caught.exception)
        self.assertTrue(message.startswith("invalid part(s): lid"), message)
        self.assertEqual(message, "invalid part(s): lid [lid: shell 1: NotClosed]")

    def test_valid_parts_still_pass(self) -> None:
        from build123d import Box

        box = Box(5, 5, 5)
        self.assertIs(assert_valid_solid(box), box)
        assert_all_valid([("a", box), ("b", Box(1, 2, 3))])


if __name__ == "__main__":
    unittest.main()
