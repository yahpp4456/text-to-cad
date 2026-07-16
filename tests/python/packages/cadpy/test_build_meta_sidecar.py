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


_VIEW_OK = {
    "pathKind": "drag_chain",
    "pathParams": ["straight_a", "bend_r", "straight_b"],
    "profileParams": [{"key": "pockets", "value": 6}, {"key": "pocket_w", "value": 16.0, "unit": "mm"}],
    "profileLoops": [[[0.0, 0.0], [10.0, 0.0], [10.0, 5.0]]],
}


class HarvestSweepViewTests(unittest.TestCase):
    """SWEEP_VIEW(掃出工作窗)收割:任一欄壞 → 整份 None(絕不送半份)。"""

    def _view(self, **attrs: object):
        return _harvest_build_meta(_module(**attrs), _PAYLOAD)["sweepView"]

    def test_valid_view_round_trips(self) -> None:
        v = self._view(SWEEP_VIEW=_VIEW_OK)
        self.assertEqual(v["pathKind"], "drag_chain")
        self.assertEqual(v["pathParams"], ["straight_a", "bend_r", "straight_b"])
        self.assertEqual(v["profileParams"][0], {"key": "pockets", "value": 6.0})
        self.assertEqual(v["profileParams"][1]["unit"], "mm")
        self.assertEqual(len(v["profileLoops"]), 1)

    def test_absent_or_bad_shape_is_none(self) -> None:
        self.assertIsNone(self._view())
        self.assertIsNone(self._view(SWEEP_VIEW="not-a-dict"))

    def test_any_bad_field_drops_whole_view(self) -> None:
        cases = [
            {**_VIEW_OK, "pathKind": "spiral"},  # 白名單外
            {**_VIEW_OK, "pathParams": "not-a-list"},
            {**_VIEW_OK, "profileParams": [{"value": 1}]},  # 缺 key
            {**_VIEW_OK, "profileParams": [{"key": "a", "value": float("nan")}]},
            {**_VIEW_OK, "profileLoops": []},  # 空
            {**_VIEW_OK, "profileLoops": [[[0, 0], [1, 1]]]},  # 圈點數 <3
            {**_VIEW_OK, "profileLoops": [[[0, 0], [1, 1], [1, "x"]]]},  # 壞點
        ]
        for bad in cases:
            with self.subTest(bad=str(bad)[:60]):
                self.assertIsNone(self._view(SWEEP_VIEW=bad))

    def test_caps(self) -> None:
        too_many_loops = {**_VIEW_OK, "profileLoops": [[[0, 0], [1, 0], [1, 1]]] * 13}
        self.assertIsNone(self._view(SWEEP_VIEW=too_many_loops))
        long_loop = {**_VIEW_OK, "profileLoops": [[[float(i), 0.0] for i in range(513)]]}
        self.assertIsNone(self._view(SWEEP_VIEW=long_loop))


class HarvestSweepPathsTests(unittest.TestCase):
    """模組層 SWEEP_PATHS(掃出路徑預覽)的防禦性收割:壞路徑整條丟棄、
    超限截斷、缺席 = 空清單(前端 overlay 的 sidecar 資料源)。"""

    def _harvest(self, **attrs: object) -> list:
        return _harvest_build_meta(_module(**attrs), _PAYLOAD)["sweepPaths"]

    def test_valid_paths_round_trip(self) -> None:
        paths = [{"label": "sleeve_path", "points": [[0.0, 0.0, 0.0], [0.0, 1.5, 2.5]]}]
        self.assertEqual(self._harvest(SWEEP_PATHS=paths), paths)

    def test_absent_is_empty(self) -> None:
        self.assertEqual(self._harvest(), [])
        self.assertEqual(self._harvest(SWEEP_PATHS=None), [])
        self.assertEqual(self._harvest(SWEEP_PATHS="not-a-list"), [])

    def test_malformed_path_dropped_whole(self) -> None:
        good = {"label": "ok", "points": [[0, 0, 0], [0, 0, 1]]}
        for bad in (
            "not-a-dict",
            {"label": "no-points"},
            {"label": "one-point", "points": [[0, 0, 0]]},
            {"label": "2d-point", "points": [[0, 0, 0], [1, 2]]},
            {"label": "nan", "points": [[0, 0, 0], [0, 0, float("nan")]]},
            {"label": "non-num", "points": [[0, 0, 0], [0, 0, "x"]]},
        ):
            with self.subTest(bad=bad):
                out = self._harvest(SWEEP_PATHS=[bad, good])
                self.assertEqual(len(out), 1)
                self.assertEqual(out[0]["label"], "ok")

    def test_label_defaults_and_coerces(self) -> None:
        out = self._harvest(SWEEP_PATHS=[{"points": [[0, 0, 0], [0, 0, 1]]}, {"label": 7, "points": [[0, 0, 0], [0, 0, 2]]}])
        self.assertEqual([p["label"] for p in out], ["path_0", "7"])

    def test_caps_truncate(self) -> None:
        many = [{"label": f"p{i}", "points": [[0, 0, 0], [0, 0, 1]]} for i in range(12)]
        self.assertEqual(len(self._harvest(SWEEP_PATHS=many)), 8)
        long = [{"label": "long", "points": [[0.0, 0.0, float(i)] for i in range(600)]}]
        out = self._harvest(SWEEP_PATHS=long)
        self.assertEqual(len(out[0]["points"]), 512)


if __name__ == "__main__":
    unittest.main()
