"""``cadpy.assembly`` creation-site record: which generator line labelled each part."""

from __future__ import annotations

import inspect
import unittest
from types import SimpleNamespace

from cadpy import assembly
from cadpy.assembly import label_shape, made_by, reset_made_by


def _make(name: str):
    return label_shape(SimpleNamespace(), name), inspect.currentframe().f_lineno


class MadeByTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_made_by()

    def test_records_file_line_and_function_of_the_caller(self) -> None:
        _shape, line = _make("base")
        self.assertEqual(made_by()["base"], {"file": "test_made_by.py", "line": line, "func": "_make"})

    def test_details_are_part_of_the_key_and_later_calls_win(self) -> None:
        label_shape(SimpleNamespace(), "bolt", "front")
        first = made_by()["bolt:front"]["line"]
        label_shape(SimpleNamespace(), "bolt", "front")
        self.assertEqual(made_by()["bolt:front"]["line"], first + 2)

    def test_reset_clears_and_copy_is_detached(self) -> None:
        _make("a")
        snapshot = made_by()
        snapshot["a"]["line"] = -1
        self.assertGreater(made_by()["a"]["line"], 0)
        reset_made_by()
        self.assertEqual(made_by(), {})

    def test_frames_inside_the_package_are_skipped(self) -> None:
        # A call made from a file inside the cadpy package is attributed to its first outside caller.
        code = compile("def build(label_shape, shape):\n    return label_shape(shape, 'inner')\n",
                       assembly._PACKAGE_DIR + "parts_fake.py", "exec")
        scope: dict = {}
        exec(code, scope)
        scope["build"](label_shape, SimpleNamespace()); line = inspect.currentframe().f_lineno
        site = made_by()["inner"]
        self.assertEqual((site["file"], site["line"]), ("test_made_by.py", line))

    def test_capacity_is_bounded(self) -> None:
        saved = assembly.MADE_BY_MAX
        assembly.MADE_BY_MAX = 2
        try:
            for name in ("a", "b", "c"):
                label_shape(SimpleNamespace(), name)
            self.assertEqual(sorted(made_by()), ["a", "b"])
        finally:
            assembly.MADE_BY_MAX = saved


if __name__ == "__main__":
    unittest.main()
