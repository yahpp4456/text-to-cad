"""驗證具名姿態、動作序列與影格的資料契約。"""

import json
import unittest
from collections import UserDict

from cadpy.motion_states import (
    MAX_SEQUENCES,
    MAX_SEQUENCE_STEPS,
    MAX_STATES,
    expand_state,
    interpolate_states,
    normalize_states,
    sequence_frames,
)

DOFS = [{"id": "lift"}, {"id": "grip"}, {"id": "finger_r", "couple": "grip"}]
POSES = {"open": {}, "closed": {"grip": 1}, "raised": {"grip": 1, "lift": 1}}
PICK = ["open", "closed", "raised"]
VALID_NAMES = ["a", "_x", "open-2", "x" * 32]
INVALID_NAMES = ["", "2open", "有中文", "x" * 33, "a b", "a\n", 123]


class NormalizeStateTests(unittest.TestCase):
    def test_absent_declarations(self):
        self.assertEqual(normalize_states(None, None, DOFS), ({}, {}, []))

    def test_valid_mappings_preserve_order_and_fill_defaults(self):
        raw = UserDict({name: UserDict(pose) for name, pose in POSES.items()})
        sequences = UserDict({"pick": tuple(PICK), "release": ["closed", "open"]})
        states, paths, errors = normalize_states(raw, sequences, DOFS)
        self.assertEqual(errors, [])
        self.assertEqual(list(states), ["open", "closed", "raised"])
        self.assertEqual(list(paths), ["pick", "release"])
        self.assertEqual(paths, {"pick": PICK, "release": ["closed", "open"]})
        self.assertEqual(states, {
            "open": {"lift": 0.0, "grip": 0.0},
            "closed": {"lift": 0.0, "grip": 1.0},
            "raised": {"lift": 1.0, "grip": 1.0},
        })
        for pose in states.values():
            self.assertEqual(list(pose), ["lift", "grip"])
            for value in pose.values():
                self.assertIs(type(value), float)
        self.assertEqual(json.loads(json.dumps([states, paths], allow_nan=False)), [states, paths])

    def test_states_must_be_mapping(self):
        self.assertEqual(normalize_states([], None, DOFS), (
            {}, {}, ["states 必須是 {名稱: {dof: 位置}} 的 dict"],
        ))

    def test_state_count_limit(self):
        self.assertEqual(MAX_STATES, 16)
        raw = {f"s{i}": {} for i in range(MAX_STATES)}
        states, _, errors = normalize_states(raw, None, DOFS)
        self.assertEqual(errors, [])
        self.assertEqual(list(states), list(raw))
        raw["!"] = None
        self.assertEqual(normalize_states(raw, None, DOFS), (
            {}, {}, ["states 最多 16 個,收到 17 個"],
        ))

    def test_state_names(self):
        raw = {name: {} for name in VALID_NAMES + INVALID_NAMES}
        states, _, errors = normalize_states(raw, None, DOFS)
        self.assertEqual(list(states), VALID_NAMES)
        self.assertEqual(errors, [
            f"states 名稱無效: {name!r}(限英數、底線、連字號,以字母或底線開頭,最多 32 字)"
            for name in INVALID_NAMES
        ])

    def test_pose_must_be_mapping(self):
        self.assertEqual(normalize_states({"open": []}, None, DOFS), (
            {}, {}, ["states.open 必須是 {dof: 位置} 的 dict"],
        ))

    def test_unknown_dof(self):
        self.assertEqual(normalize_states({"open": {"slide": 0}}, None, DOFS), (
            {}, {}, ["states.open: 未知的 dof 'slide'"],
        ))

    def test_coupled_dof_cannot_be_set(self):
        self.assertEqual(normalize_states({"open": {"finger_r": 1}}, None, DOFS), (
            {}, {}, ["states.open: finger_r 是從動 dof,位置由主動 dof grip 決定,不可單獨指定"],
        ))

    def test_position_bounds_and_types(self):
        for value in (0, 1, 0.0, 1.0, 0.375):
            with self.subTest(value=value):
                states, _, errors = normalize_states({"open": {"grip": value}}, None, DOFS)
                self.assertEqual(errors, [])
                self.assertIs(type(states["open"]["grip"]), float)
                self.assertEqual(states["open"]["grip"], value)
        for value in (-0.01, 1.01, float("nan"), float("inf"), True, False, "0.5", None):
            with self.subTest(value=value):
                self.assertEqual(normalize_states({"open": {"grip": value}}, None, DOFS), (
                    {}, {}, [f"states.open.grip: 位置必須是 0 到 1 之間的數(行程比例),收到 {value!r}"],
                ))

    def test_all_pose_errors_are_reported_and_valid_pose_is_kept(self):
        raw = {"bad": {"grip": -1, "missing": 0}, "ready": {"lift": 0.5}}
        states, _, errors = normalize_states(raw, None, DOFS)
        self.assertEqual(states, {"ready": {"lift": 0.5, "grip": 0.0}})
        self.assertEqual(errors, [
            "states.bad.grip: 位置必須是 0 到 1 之間的數(行程比例),收到 -1",
            "states.bad: 未知的 dof 'missing'",
        ])


class NormalizeSequenceTests(unittest.TestCase):
    def test_sequences_require_valid_states(self):
        self.assertEqual(normalize_states(None, {"pick": PICK}, DOFS), (
            {}, {}, ["sequences 需要先宣告 states"],
        ))
        self.assertEqual(normalize_states({"bad": None}, {"pick": PICK}, DOFS), (
            {}, {}, ["states.bad 必須是 {dof: 位置} 的 dict", "sequences 需要先宣告 states"],
        ))

    def test_sequences_must_be_mapping(self):
        _, paths, errors = normalize_states(POSES, [], DOFS)
        self.assertEqual(paths, {})
        self.assertEqual(errors, ["sequences 必須是 {名稱: [姿態名稱, ...]} 的 dict"])

    def test_sequence_count_limit(self):
        self.assertEqual(MAX_SEQUENCES, 8)
        raw = {f"path{i}": PICK for i in range(MAX_SEQUENCES)}
        _, paths, errors = normalize_states(POSES, raw, DOFS)
        self.assertEqual(errors, [])
        self.assertEqual(list(paths), list(raw))
        raw["!"] = None
        _, paths, errors = normalize_states(POSES, raw, DOFS)
        self.assertEqual(paths, {})
        self.assertEqual(errors, ["sequences 最多 8 個,收到 9 個"])

    def test_sequence_names(self):
        for name in VALID_NAMES:
            with self.subTest(name=name):
                _, paths, errors = normalize_states(POSES, {name: PICK}, DOFS)
                self.assertEqual((paths, errors), ({name: PICK}, []))
        for name in INVALID_NAMES:
            with self.subTest(name=name):
                _, paths, errors = normalize_states(POSES, {name: PICK}, DOFS)
                self.assertEqual(paths, {})
                self.assertEqual(errors, [
                    f"sequences 名稱無效: {name!r}(限英數、底線、連字號,以字母或底線開頭,最多 32 字)"
                ])

    def test_steps_must_be_list_or_tuple_of_names(self):
        for invalid in ("open", {"open": 1}, ("open", 1), ["open", []]):
            with self.subTest(invalid=invalid):
                _, paths, errors = normalize_states(POSES, {"pick": invalid}, DOFS)
                self.assertEqual(paths, {})
                self.assertEqual(errors, ["sequences.pick 必須是姿態名稱的清單"])

    def test_too_few_steps(self):
        for steps in ([], ["open"]):
            with self.subTest(steps=steps):
                _, paths, errors = normalize_states(POSES, {"pick": steps}, DOFS)
                self.assertEqual(paths, {})
                self.assertEqual(errors, [f"sequences.pick 至少要 2 個姿態,收到 {len(steps)} 個"])

    def test_step_count_limit(self):
        self.assertEqual(MAX_SEQUENCE_STEPS, 12)
        steps = ["open", "closed"] * 6
        _, paths, errors = normalize_states(POSES, {"cycle": steps}, DOFS)
        self.assertEqual((paths, errors), ({"cycle": steps}, []))
        _, paths, errors = normalize_states(POSES, {"cycle": steps + ["open"]}, DOFS)
        self.assertEqual(paths, {})
        self.assertEqual(errors, ["sequences.cycle 最多 12 個姿態,收到 13 個"])

    def test_unknown_and_rejected_states_are_each_reported_once(self):
        raw = {**POSES, "bad": []}
        sequences = {"invalid": ["bad", "missing", "bad", "missing"], "pick": PICK}
        states, paths, errors = normalize_states(raw, sequences, DOFS)
        self.assertEqual(list(states), list(POSES))
        self.assertEqual(paths, {"pick": PICK})
        self.assertEqual(errors, [
            "states.bad 必須是 {dof: 位置} 的 dict",
            "sequences.invalid: 未知的姿態 'bad'",
            "sequences.invalid: 未知的姿態 'missing'",
        ])

    def test_adjacent_repetitions_report_each_pair(self):
        _, paths, errors = normalize_states(POSES, {"hold": ["open", "closed", "closed", "closed"]}, DOFS)
        self.assertEqual(paths, {})
        self.assertEqual(errors, [
            "sequences.hold: 第 2 步與第 3 步是同一個姿態 'closed'",
            "sequences.hold: 第 3 步與第 4 步是同一個姿態 'closed'",
        ])


class MotionFrameTests(unittest.TestCase):
    def test_expand_state_uses_master_regardless_of_declaration_order(self):
        dofs = [
            {"id": "finger_r", "couple": "grip"},
            {"id": "lift", "couple": None},
            {"id": "grip", "couple": ""},
            {"id": "orphan", "couple": "missing"},
        ]
        expanded = expand_state({"grip": 0.75}, dofs)
        self.assertEqual(list(expanded.items()), [
            ("finger_r", 0.75), ("lift", 0.0), ("grip", 0.75), ("orphan", 0.0),
        ])

    def test_interpolation_clamps_t_and_preserves_union_order(self):
        a = {"grip": 1.0, "lift": 0.25}
        b = {"slide": 0.5, "lift": 0.75}
        for t, values in [
            (-1, [1.0, 0.25, 0.0]), (0, [1.0, 0.25, 0.0]),
            (0.5, [0.5, 0.5, 0.25]),
            (1, [0.0, 0.75, 0.5]), (2, [0.0, 0.75, 0.5]),
        ]:
            with self.subTest(t=t):
                pose = interpolate_states(a, b, t)
                self.assertEqual(list(pose), ["grip", "lift", "slide"])
                self.assertEqual(list(pose.values()), values)

    def test_sequence_labels_and_interpolated_poses(self):
        states, _, _ = normalize_states(POSES, None, DOFS)
        frames = sequence_frames("pick", PICK, states, samples_per_step=4)
        self.assertEqual(len(frames), 9)
        self.assertEqual([label for label, _ in frames], [
            "pick:open", "pick:open>closed@0.250", "pick:open>closed@0.500",
            "pick:open>closed@0.750", "pick:closed", "pick:closed>raised@0.250",
            "pick:closed>raised@0.500", "pick:closed>raised@0.750", "pick:raised",
        ])
        self.assertEqual([(pose["lift"], pose["grip"]) for _, pose in frames], [
            (0.0, 0.0), (0.0, 0.25), (0.0, 0.5), (0.0, 0.75), (0.0, 1.0),
            (0.25, 1.0), (0.5, 1.0), (0.75, 1.0), (1.0, 1.0),
        ])

    def test_samples_per_step_defaults_to_six_and_clamps_to_one(self):
        states, _, _ = normalize_states(POSES, None, DOFS)
        self.assertEqual(len(sequence_frames("pick", PICK, states)), 13)
        for count in (0, -2, 1):
            with self.subTest(count=count):
                self.assertEqual(sequence_frames("pick", PICK, states, samples_per_step=count), [
                    ("pick:open", states["open"]),
                    ("pick:closed", states["closed"]),
                    ("pick:raised", states["raised"]),
                ])


if __name__ == "__main__":
    unittest.main()
