"""機構具名姿態與動作序列的正規化、展開與內插。"""

import re
from collections.abc import Mapping, Sequence

MAX_STATES = 16
MAX_SEQUENCES = 8
MAX_SEQUENCE_STEPS = 12
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,31}$")


def _check_name(section, name, errors):
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        errors.append(
            f"{section} 名稱無效: {name!r}(限英數、底線、連字號,以字母或底線開頭,最多 32 字)"
        )


def _normalize_poses(raw_states, dofs, errors):
    states = {}
    if raw_states is None:
        return states
    if not isinstance(raw_states, Mapping):
        errors.append("states 必須是 {名稱: {dof: 位置}} 的 dict")
        return states
    if len(raw_states) > MAX_STATES:
        errors.append(f"states 最多 {MAX_STATES} 個,收到 {len(raw_states)} 個")
        return states

    masters = {dof["id"]: dof.get("couple") for dof in dofs}
    defaults = {dof_id: 0.0 for dof_id, master in masters.items() if not master}
    for name, pose in raw_states.items():
        before = len(errors)
        _check_name("states", name, errors)
        if not isinstance(pose, Mapping):
            errors.append(f"states.{name} 必須是 {{dof: 位置}} 的 dict")
            continue

        positions = defaults.copy()
        for dof_id, value in pose.items():
            if dof_id not in masters:
                errors.append(f"states.{name}: 未知的 dof {dof_id!r}")
            elif masters[dof_id]:
                errors.append(
                    f"states.{name}: {dof_id} 是從動 dof,位置由主動 dof "
                    f"{masters[dof_id]} 決定,不可單獨指定"
                )
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
                errors.append(f"states.{name}.{dof_id}: 位置必須是 0 到 1 之間的數(行程比例),收到 {value!r}")
            elif dof_id in positions:
                positions[dof_id] = float(value)
        if len(errors) == before:
            states[name] = positions
    return states


def _normalize_sequences(raw_sequences, states, errors):
    sequences = {}
    if raw_sequences is None:
        return sequences
    if not states:
        errors.append("sequences 需要先宣告 states")
        return sequences
    if not isinstance(raw_sequences, Mapping):
        errors.append("sequences 必須是 {名稱: [姿態名稱, ...]} 的 dict")
        return sequences
    if len(raw_sequences) > MAX_SEQUENCES:
        errors.append(f"sequences 最多 {MAX_SEQUENCES} 個,收到 {len(raw_sequences)} 個")
        return sequences

    for name, steps in raw_sequences.items():
        before = len(errors)
        _check_name("sequences", name, errors)
        if not isinstance(steps, (list, tuple)) or not all(isinstance(step, str) for step in steps):
            errors.append(f"sequences.{name} 必須是姿態名稱的清單")
            continue
        if len(steps) < 2:
            errors.append(f"sequences.{name} 至少要 2 個姿態,收到 {len(steps)} 個")
        elif len(steps) > MAX_SEQUENCE_STEPS:
            errors.append(f"sequences.{name} 最多 {MAX_SEQUENCE_STEPS} 個姿態,收到 {len(steps)} 個")
        unknown = set()
        for index, step in enumerate(steps):
            if step not in states and step not in unknown:
                errors.append(f"sequences.{name}: 未知的姿態 {step!r}")
                unknown.add(step)
            if index and step == steps[index - 1]:
                errors.append(f"sequences.{name}: 第 {index} 步與第 {index + 1} 步是同一個姿態 {step!r}")
        if len(errors) == before:
            sequences[name] = list(steps)
    return sequences


def normalize_states(
    raw_states: object, raw_sequences: object, dofs: Sequence[Mapping]
) -> tuple[dict, dict, list[str]]:
    """依宣告順序收錄合法的姿態與序列，並回傳驗證時發現的錯誤。"""
    errors: list[str] = []
    states = _normalize_poses(raw_states, dofs, errors)
    sequences = _normalize_sequences(raw_sequences, states, errors)
    return states, sequences, errors


def expand_state(state: Mapping, dofs: Sequence[Mapping]) -> dict[str, float]:
    """依自由度的宣告順序展開姿態，從動自由度沿用其主動自由度的位置。"""
    active = {dof["id"]: state.get(dof["id"], 0.0) for dof in dofs if not dof.get("couple")}
    return {dof["id"]: active.get(dof.get("couple") or dof["id"], 0.0) for dof in dofs}


def interpolate_states(a: Mapping, b: Mapping, t: float) -> dict[str, float]:
    """將行程比例限制在兩端之間，對兩個姿態的所有自由度做線性內插。"""
    t = min(1.0, max(0.0, t))
    result = {}
    for key in {**a, **b}:
        start = a.get(key, 0.0)
        result[key] = start + (b.get(key, 0.0) - start) * t
    return result


def sequence_frames(
    name: str, sequence: Sequence[str], states: Mapping, *, samples_per_step: int = 6
) -> list[tuple[str, dict[str, float]]]:
    """沿序列逐段等距取樣，每個具名姿態與中間影格皆附上對應標籤。"""
    samples_per_step = max(1, samples_per_step)
    frames = [(f"{name}:{sequence[0]}", states[sequence[0]])]
    for frm, to in zip(sequence, sequence[1:]):
        for k in range(1, samples_per_step):
            t = k / samples_per_step
            pose = interpolate_states(states[frm], states[to], t)
            frames.append((f"{name}:{frm}>{to}@{t:.3f}", pose))
        frames.append((f"{name}:{to}", states[to]))
    return frames
