"""Tests for cadpy.analysis rotation math (mode="axis" 的數學核心).

純向量計算,無 OCCT:rotation_between_vectors 的一般角/退化案(平行、反平行
確定性軸)、axis_angle_matrix(Rodrigues)、matrix_to_euler_xyz_deg 往返
(含 gimbal 分支)。euler 慣例 R = Rx@Ry@Rz,與 build123d Rotation 的一致性
另由真 OCCT 整合測試鎖定。
"""

from __future__ import annotations

import math
import unittest

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.analysis import (  # noqa: E402
    ROTATION_ANGLE_EPS_DEG,
    axis_angle_matrix,
    matrix_to_euler_xyz_deg,
    rotation_between_vectors,
)


def _mat_vec(matrix: list[list[float]], vector: tuple[float, float, float]) -> list[float]:
    return [sum(matrix[r][c] * vector[c] for c in range(3)) for r in range(3)]


def _mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)] for r in range(3)]


def _rx(deg: float) -> list[list[float]]:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[1, 0, 0], [0, c, -s], [0, s, c]]


def _ry(deg: float) -> list[list[float]]:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[c, 0, s], [0, 1, 0], [-s, 0, c]]


def _rz(deg: float) -> list[list[float]]:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]]


def _euler_xyz_matrix(rx: float, ry: float, rz: float) -> list[list[float]]:
    return _mat_mul(_rx(rx), _mat_mul(_ry(ry), _rz(rz)))


class RotationBetweenVectorsTests(unittest.TestCase):
    def test_ninety_degrees_z_to_x(self) -> None:
        rot = rotation_between_vectors([0, 0, 1], [1, 0, 0])
        self.assertIsNotNone(rot)
        self.assertAlmostEqual(rot["angleDeg"], 90.0, places=9)
        # cross(z, x) = +y
        self.assertAlmostEqual(rot["axis"][0], 0.0, places=12)
        self.assertAlmostEqual(rot["axis"][1], 1.0, places=12)
        self.assertAlmostEqual(rot["axis"][2], 0.0, places=12)

    def test_arbitrary_angle_and_unnormalized_inputs(self) -> None:
        # 30 度:輸入未正規化也要正確
        target = [math.sin(math.radians(30)) * 7.0, 0.0, math.cos(math.radians(30)) * 7.0]
        rot = rotation_between_vectors([0, 0, 5], target)
        self.assertAlmostEqual(rot["angleDeg"], 30.0, places=9)
        matrix = axis_angle_matrix(rot["axis"], rot["angleDeg"])
        rotated = _mat_vec(matrix, (0.0, 0.0, 1.0))
        expected = [component / 7.0 for component in target]
        for got, want in zip(rotated, expected):
            self.assertAlmostEqual(got, want, places=9)

    def test_parallel_is_identity(self) -> None:
        rot = rotation_between_vectors([0, 0, 2], [0, 0, 9])
        self.assertEqual(rot["angleDeg"], 0.0)
        self.assertIsNone(rot["axis"])

    def test_antiparallel_gets_deterministic_perpendicular_axis(self) -> None:
        rot = rotation_between_vectors([0, 0, 1], [0, 0, -1])
        self.assertEqual(rot["angleDeg"], 180.0)
        axis = rot["axis"]
        self.assertIsNotNone(axis)
        # 軸與 source 垂直、單位長,且規則確定(source=z → 最小分量軸=x → cross(z,x)=y)
        self.assertAlmostEqual(axis[0] * 0 + axis[1] * 0 + axis[2] * 1, 0.0, places=12)
        self.assertAlmostEqual(sum(component * component for component in axis), 1.0, places=12)
        self.assertAlmostEqual(axis[1], 1.0, places=12)
        # 180 度矩陣把 source 打到 target
        matrix = axis_angle_matrix(axis, 180.0)
        rotated = _mat_vec(matrix, (0.0, 0.0, 1.0))
        self.assertAlmostEqual(rotated[2], -1.0, places=9)

    def test_invalid_inputs_return_none(self) -> None:
        self.assertIsNone(rotation_between_vectors([0, 0, 0], [1, 0, 0]))
        self.assertIsNone(rotation_between_vectors(None, [1, 0, 0]))
        self.assertIsNone(rotation_between_vectors([1, 0], [1, 0, 0]))

    def test_eps_threshold_collapses_tiny_angles(self) -> None:
        tiny = math.radians(ROTATION_ANGLE_EPS_DEG / 2.0)
        rot = rotation_between_vectors([0, 0, 1], [math.sin(tiny), 0.0, math.cos(tiny)])
        self.assertEqual(rot["angleDeg"], 0.0)
        self.assertIsNone(rot["axis"])


class AxisAngleMatrixTests(unittest.TestCase):
    def test_rodrigues_basic_z_ninety(self) -> None:
        matrix = axis_angle_matrix([0, 0, 1], 90.0)
        rotated = _mat_vec(matrix, (1.0, 0.0, 0.0))
        self.assertAlmostEqual(rotated[0], 0.0, places=12)
        self.assertAlmostEqual(rotated[1], 1.0, places=12)

    def test_orthonormality(self) -> None:
        matrix = axis_angle_matrix([1, 2, 3], 47.0)
        # R @ R^T = I
        transpose = [[matrix[c][r] for c in range(3)] for r in range(3)]
        product = _mat_mul(matrix, transpose)
        for r in range(3):
            for c in range(3):
                self.assertAlmostEqual(product[r][c], 1.0 if r == c else 0.0, places=12)

    def test_invalid_axis_returns_none(self) -> None:
        self.assertIsNone(axis_angle_matrix([0, 0, 0], 30.0))
        self.assertIsNone(axis_angle_matrix(None, 30.0))


class EulerRoundTripTests(unittest.TestCase):
    def _assert_roundtrip(self, rx: float, ry: float, rz: float) -> None:
        matrix = _euler_xyz_matrix(rx, ry, rz)
        euler = matrix_to_euler_xyz_deg(matrix)
        self.assertIsNotNone(euler)
        rebuilt = _euler_xyz_matrix(*euler)
        for r in range(3):
            for c in range(3):
                self.assertAlmostEqual(rebuilt[r][c], matrix[r][c], places=9, msg=f"({rx},{ry},{rz}) @[{r}][{c}]")

    def test_generic_angles(self) -> None:
        self._assert_roundtrip(10.0, 20.0, 30.0)
        self._assert_roundtrip(-75.0, 40.0, 160.0)
        self._assert_roundtrip(179.0, -89.0, -179.0)

    def test_gimbal_plus_ninety(self) -> None:
        self._assert_roundtrip(25.0, 90.0, 0.0)

    def test_gimbal_minus_ninety(self) -> None:
        self._assert_roundtrip(-40.0, -90.0, 0.0)

    def test_axis_angle_to_euler_consistency(self) -> None:
        # 任意 axis-angle → matrix → euler → matrix 一致
        matrix = axis_angle_matrix([2, -1, 4], 73.0)
        euler = matrix_to_euler_xyz_deg(matrix)
        rebuilt = _euler_xyz_matrix(*euler)
        for r in range(3):
            for c in range(3):
                self.assertAlmostEqual(rebuilt[r][c], matrix[r][c], places=9)

    def test_invalid_matrix_returns_none(self) -> None:
        self.assertIsNone(matrix_to_euler_xyz_deg(None))
        self.assertIsNone(matrix_to_euler_xyz_deg([[1, 0], [0, 1]]))


if __name__ == "__main__":
    unittest.main()
