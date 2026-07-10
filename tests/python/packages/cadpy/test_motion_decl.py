"""Tests for cadpy.motion_decl — the single source of truth for the cad-chat
MOTION declaration contract.

normalize_motion is consumed both by the build-side sidecar harvest
(generation._harvest_build_meta) and by the cad-chat validate harness
(_read_motion wrapper); these tests pin the shared normalization behaviour and
the playback_motion projection. Pure stdlib on purpose — no OCP import, so the
suite runs in milliseconds.
"""

from __future__ import annotations

import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.motion_decl import MOTION_MAX_DOFS, normalize_motion, playback_motion  # noqa: E402

LABELS = ["a", "b", "body", "arm", "hub"]


class NormalizeMotionTests(unittest.TestCase):
    def test_none_declaration_is_not_an_error(self) -> None:
        motion, errs = normalize_motion(None, LABELS)
        self.assertIsNone(motion)
        self.assertEqual(errs, [])

    def test_accepts_linear(self) -> None:
        motion, errs = normalize_motion(
            {"dofs": [{"id": "x", "axis": [1, 0, 0], "travel": 40, "moving": ["arm"]}]},
            LABELS,
        )
        self.assertEqual(errs, [])
        d = motion["dofs"][0]
        self.assertEqual(d["type"], "linear")
        self.assertEqual(d["travel"], 40.0)
        self.assertEqual(d["axis"], [1.0, 0.0, 0.0])
        self.assertNotIn("pivot", d)

    def test_accepts_revolute_and_normalizes_axis(self) -> None:
        motion, errs = normalize_motion(
            {"dofs": [
                {"id": "flip", "type": "revolute", "axis": [0, 2, 0],
                 "pivot": [0, 0, -31], "angle_deg": 90,
                 "moving": ["arm", "hub"], "pairs": [["arm", "body"]]},
            ]},
            LABELS,
        )
        self.assertEqual(errs, [])
        d = motion["dofs"][0]
        self.assertEqual(d["type"], "revolute")
        self.assertEqual(d["axis"], [0.0, 1.0, 0.0])  # 模長正規化
        self.assertEqual(d["pivot"], [0.0, 0.0, -31.0])
        self.assertEqual(d["angle_deg"], 90.0)
        self.assertNotIn("travel", d)

    def test_revolute_requires_explicit_pairs(self) -> None:
        _, errs = normalize_motion(
            {"dofs": [
                {"id": "f", "type": "revolute", "axis": [0, 1, 0],
                 "pivot": [0, 0, 0], "angle_deg": 45, "moving": ["arm"]},
            ]},
            LABELS,
        )
        self.assertTrue(any("pairs" in e for e in errs))

    def test_rejects_unknown_label(self) -> None:
        _, errs = normalize_motion(
            {"dofs": [{"id": "x", "axis": [1, 0, 0], "travel": 10, "moving": ["ghost"]}]},
            LABELS,
        )
        self.assertTrue(any("ghost" in e for e in errs))

    def test_rejects_ambiguous_label(self) -> None:
        # _as_named_parts 對重複 label 加 #n:名單裡出現 jaw#1 代表 jaw 有歧義
        _, errs = normalize_motion(
            {"dofs": [{"id": "x", "axis": [1, 0, 0], "travel": 10, "moving": ["jaw"]}]},
            ["jaw", "jaw#1", "body"],
        )
        self.assertTrue(any("重複的 label" in e for e in errs))

    def test_dof_count_bounds(self) -> None:
        _, errs = normalize_motion({"dofs": []}, LABELS)
        self.assertEqual(errs, [f"dofs 數量須為 1–{MOTION_MAX_DOFS}"])
        too_many = [{"id": f"d{i}", "axis": [1, 0, 0], "travel": 5, "moving": ["arm"]}
                    for i in range(MOTION_MAX_DOFS + 1)]
        _, errs = normalize_motion({"dofs": too_many}, LABELS)
        self.assertEqual(errs, [f"dofs 數量須為 1–{MOTION_MAX_DOFS}"])

    def test_samples_and_period_clamped(self) -> None:
        motion, errs = normalize_motion(
            {"dofs": [{"id": "x", "axis": [1, 0, 0], "travel": 10, "moving": ["arm"],
                       "samples": 99, "period_s": 100}]},
            LABELS,
        )
        self.assertEqual(errs, [])
        self.assertEqual(motion["dofs"][0]["samples"], 24)
        self.assertEqual(motion["dofs"][0]["period_s"], 20.0)


class PlaybackMotionTests(unittest.TestCase):
    def test_none_passthrough(self) -> None:
        self.assertIsNone(playback_motion(None))

    def test_projects_playback_subset(self) -> None:
        motion, errs = normalize_motion(
            {"dofs": [
                {"id": "x", "axis": [1, 0, 0], "travel": 40, "moving": ["arm"],
                 "pairs": [["arm", "body"]], "samples": 12},
                {"id": "flip", "type": "revolute", "axis": [0, 1, 0],
                 "pivot": [0, 0, -31], "angle_deg": 90,
                 "moving": ["hub"], "pairs": [["hub", "body"]]},
            ]},
            LABELS,
        )
        self.assertEqual(errs, [])
        play = playback_motion(motion)
        self.assertEqual(play["schemaVersion"], 1)
        lin, rev = play["dofs"]
        # 掃掠專用欄位(pairs/samples/baseline/origin)不外洩給前端
        for d in (lin, rev):
            for hidden in ("pairs", "samples", "baseline", "origin"):
                self.assertNotIn(hidden, d)
        self.assertEqual(lin["travel"], 40.0)
        self.assertNotIn("pivot", lin)
        self.assertEqual(rev["pivot"], [0.0, 0.0, -31.0])
        self.assertEqual(rev["angle_deg"], 90.0)
        self.assertNotIn("travel", rev)


class CoupleTests(unittest.TestCase):
    """couple(嚙合耦合:齒輪齒條/齒輪對)——從動 dof 與主動 dof 由同一參數
    同步驅動的宣告契約。掃掠與播放都靠這個欄位把嚙合當一組滾動。"""

    def _decl(self, slave_extra=None, master_extra=None):
        master = {"id": "stroke", "axis": [0, 1, 0], "travel": -7.7,
                  "moving": ["a"], "pairs": [["a", "body"]]}
        slave = {"id": "swing", "type": "revolute", "axis": [0, 0, 1],
                 "pivot": [0, 0, 0], "angle_deg": 90, "moving": ["hub"],
                 "pairs": [["hub", "a"]], "couple": "stroke"}
        master.update(master_extra or {})
        slave.update(slave_extra or {})
        return {"dofs": [master, slave]}

    def test_accepts_couple_and_projects_to_playback(self) -> None:
        motion, errs = normalize_motion(self._decl(), LABELS)
        self.assertEqual(errs, [])
        stroke, swing = motion["dofs"]
        self.assertNotIn("couple", stroke)
        self.assertEqual(swing["couple"], "stroke")
        play = playback_motion(motion)
        self.assertNotIn("couple", play["dofs"][0])
        self.assertEqual(play["dofs"][1]["couple"], "stroke")

    def test_rejects_unknown_or_self_target(self) -> None:
        _, errs = normalize_motion(self._decl(slave_extra={"couple": "nope"}), LABELS)
        self.assertTrue(any("couple 須指向另一個存在的 dof id" in e for e in errs))
        _, errs = normalize_motion(self._decl(slave_extra={"couple": "swing"}), LABELS)
        self.assertTrue(any("couple 須指向另一個存在的 dof id" in e for e in errs))

    def test_rejects_chained_coupling(self) -> None:
        decl = self._decl(master_extra={"couple": "third"})
        decl["dofs"].append({"id": "third", "axis": [1, 0, 0], "travel": 5,
                             "moving": ["b"], "pairs": [["b", "body"]]})
        _, errs = normalize_motion(decl, LABELS)
        self.assertTrue(any("禁止鏈式耦合" in e for e in errs))

    def test_coupled_dofs_must_declare_explicit_pairs(self) -> None:
        # 從動缺 pairs(linear 從動才可能走到這;revolute 本來就強制 pairs)
        decl = self._decl()
        decl["dofs"][1] = {"id": "swing", "axis": [0, 0, 1], "travel": 5,
                           "moving": ["hub"], "couple": "stroke"}
        _, errs = normalize_motion(decl, LABELS)
        self.assertTrue(any("耦合 dof 必須明給 pairs" in e for e in errs))
        # 主動缺 pairs → 自動配對語意在耦合群內不成立,一樣擋
        _, errs = normalize_motion(self._decl(master_extra={"pairs": None}), LABELS)
        self.assertTrue(any("主動 dof stroke 必須明給 pairs" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
