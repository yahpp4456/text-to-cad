"""Tests for the opt-in check_geometry acceptance hook in the generation pipeline.

The hook lets a generator refuse its own STEP write when geometry fails a
deterministic check. These tests pin the hook contract directly (no full STEP
pipeline needed): absent hook is a no-op, a raising hook propagates (so the
write is aborted), the payload is forwarded verbatim, and a non-callable hook
is rejected loudly.
"""

from __future__ import annotations

import types
import unittest
from contextlib import nullcontext
from pathlib import Path

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.generation import _run_geometry_acceptance_check  # noqa: E402


class _FakeLogger:
    """Minimal stand-in matching the logger surface the hook uses."""

    def timed(self, _message: str):
        return nullcontext()

    def debug(self, _message: str) -> None:
        return None


_SCRIPT = Path("gen.py")


class CheckGeometryHookTests(unittest.TestCase):
    def test_absent_hook_is_noop(self) -> None:
        module = types.SimpleNamespace()  # no check_geometry attribute
        _run_geometry_acceptance_check(
            module, object(), script_path=_SCRIPT, logger=_FakeLogger()
        )

    def test_raising_hook_propagates_to_abort_write(self) -> None:
        def check_geometry(_shape) -> None:
            raise AssertionError("invalid solid in part X")

        module = types.SimpleNamespace(check_geometry=check_geometry)
        with self.assertRaisesRegex(AssertionError, "invalid solid in part X"):
            _run_geometry_acceptance_check(
                module, object(), script_path=_SCRIPT, logger=_FakeLogger()
            )

    def test_hook_receives_the_generator_payload(self) -> None:
        seen = {}

        def check_geometry(shape) -> None:
            seen["shape"] = shape

        module = types.SimpleNamespace(check_geometry=check_geometry)
        sentinel = object()
        _run_geometry_acceptance_check(
            module, sentinel, script_path=_SCRIPT, logger=_FakeLogger()
        )
        self.assertIs(seen["shape"], sentinel)

    def test_non_callable_hook_is_rejected(self) -> None:
        module = types.SimpleNamespace(check_geometry=123)
        with self.assertRaisesRegex(TypeError, "check_geometry must be callable"):
            _run_geometry_acceptance_check(
                module, object(), script_path=_SCRIPT, logger=_FakeLogger()
            )


if __name__ == "__main__":
    unittest.main()
