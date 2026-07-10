"""Tests for the build-side MOTION+parts sidecar harvest in cadpy.generation.

_run_script_generator_inner writes `.{name}.step.meta.json` after a successful
gen_step so cad-chat's design mode can read parts/MOTION with zero extra spawn.
These tests pin the harvest contract (_harvest_build_meta), the atomic no-throw
write (_write_build_meta_sidecar), and the path helper — without running the
full STEP pipeline.
"""

from __future__ import annotations

import json
import tempfile
import types
import unittest
from pathlib import Path

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.catalog import hidden_meta_path_for_step_path  # noqa: E402
from cadpy.generation import _harvest_build_meta, _write_build_meta_sidecar  # noqa: E402


class _FakeLogger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warning(self, message: str) -> None:
        self.warnings.append(message)


def _module(**attrs: object) -> types.SimpleNamespace:
    return types.SimpleNamespace(**attrs)


# _as_named_parts 接受 (name, shape) 對清單;shape 用啞物件即可(收割不碰幾何)
_PAYLOAD = [("body", object()), ("arm", object()), ("hub", object())]


class HarvestBuildMetaTests(unittest.TestCase):
    def test_harvests_parts_and_motion(self) -> None:
        module = _module(MOTION={"dofs": [
            {"id": "flip", "type": "revolute", "axis": [0, 1, 0], "pivot": [0, 0, -31],
             "angle_deg": 90, "moving": ["arm", "hub"], "pairs": [["arm", "body"]]},
        ]})
        meta = _harvest_build_meta(module, _PAYLOAD)
        self.assertEqual(meta["schemaVersion"], 1)
        self.assertEqual(meta["parts"], ["body", "arm", "hub"])
        self.assertEqual(meta["partCount"], 3)
        self.assertEqual(meta["motionErrs"], [])
        self.assertEqual(meta["motion"]["dofs"][0]["angle_deg"], 90.0)

    def test_no_motion_declaration(self) -> None:
        meta = _harvest_build_meta(_module(), _PAYLOAD)
        self.assertIsNone(meta["motion"])
        self.assertEqual(meta["motionErrs"], [])

    def test_invalid_motion_reports_errs(self) -> None:
        meta = _harvest_build_meta(_module(MOTION={"dofs": [
            {"id": "x", "axis": [1, 0, 0], "travel": 10, "moving": ["ghost"]},
        ]}), _PAYLOAD)
        self.assertIsNone(meta["motion"])
        self.assertTrue(any("ghost" in e for e in meta["motionErrs"]))

    def test_unparseable_payload_falls_back_to_single_part(self) -> None:
        # 鏡射 validate.py 的 ("part", payload) fallback
        meta = _harvest_build_meta(_module(), {"not-children": True})
        self.assertEqual(meta["parts"], ["part"])
        self.assertEqual(meta["partCount"], 1)


class WriteBuildMetaSidecarTests(unittest.TestCase):
    def test_writes_atomic_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            step_path = Path(tmp) / "x.step"
            logger = _FakeLogger()
            _write_build_meta_sidecar(_module(), _PAYLOAD, step_path=step_path, logger=logger)
            target = hidden_meta_path_for_step_path(step_path)
            self.assertEqual(target.name, ".x.step.meta.json")
            data = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(data["parts"], ["body", "arm", "hub"])
            self.assertEqual(logger.warnings, [])
            # 原子寫不留 .tmp 殘骸
            self.assertEqual(list(Path(tmp).glob("*.tmp")), [])

    def test_failure_is_nonfatal(self) -> None:
        # 目標目錄不存在 → 寫檔必失敗;只准 warning,絕不 raise(sidecar 壞不了 build)
        logger = _FakeLogger()
        _write_build_meta_sidecar(
            _module(), _PAYLOAD,
            step_path=Path(tempfile.gettempdir()) / "no-such-dir-cadpy-test" / "x.step",
            logger=logger,
        )
        self.assertEqual(len(logger.warnings), 1)
        self.assertIn("non-fatal", logger.warnings[0])


if __name__ == "__main__":
    unittest.main()
