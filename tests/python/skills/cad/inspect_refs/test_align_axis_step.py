"""mode="axis" 的真 OCCT 整合測試(一支,收尾保險)。

真 build123d 造兩根不同軸向圓柱 → 真 STEP → 真 selector manifest,驗證:
1. 真圓柱面 rows 產生的 axisVector 餵進旋轉數學後,矩陣確實把 moving 軸打到與
   target 軸共線(<1e-6)——鎖定「幾何事實 → 數學」這條縫。
2. build123d ``Rotation(*eulerXYZDeg)`` 重建的旋轉矩陣與我們的矩陣一致——鎖定
   euler 慣例(R = Rx@Ry@Rz)與 build123d 相符,agent 直接貼 euler 才安全。
(axis 分支的輸出契約/退化案已由 test_refs_inspect 的 mock manifest 測試覆蓋。)
"""

from __future__ import annotations

import math
import unittest
from pathlib import Path

from tests.python.support.paths import add_repo_path
from tests.python.support.tmp_root import temporary_directory

add_repo_path("skills/cad/scripts/inspect")

import build123d  # noqa: E402

from cadpy import analysis  # noqa: E402
from cadpy.assembly import AssemblyHelper  # noqa: E402
from cadpy.selector_types import SelectorProfile  # noqa: E402
from cadpy.step_scene import (  # noqa: E402
    SelectorOptions,
    extract_selectors_from_scene,
    load_step_scene,
)


def _mat_vec(matrix: list[list[float]], vector: list[float]) -> list[float]:
    return [sum(matrix[r][c] * vector[c] for c in range(3)) for r in range(3)]


def _location_matrix3(location: build123d.Location) -> list[list[float]]:
    trsf = location.wrapped.Transformation()
    return [[trsf.Value(row + 1, col + 1) for col in range(3)] for row in range(3)]


class AlignAxisStepIntegrationTests(unittest.TestCase):
    maxDiff = None

    def test_real_cylinder_axes_align_and_euler_matches_build123d(self) -> None:
        with temporary_directory(prefix="align-axis-step-") as temp_dir:
            step_path = Path(temp_dir) / "two_cylinders.step"
            asm = AssemblyHelper("two_cylinders")
            asm.add(build123d.Cylinder(5.0, 20.0), "cyl_z")
            asm.add(
                build123d.Cylinder(5.0, 20.0).rotate(build123d.Axis.Y, 90.0).translate((30.0, 10.0, 5.0)),
                "cyl_x",
            )
            build123d.export_step(asm.build(), step_path)

            scene = load_step_scene(step_path)
            bundle = extract_selectors_from_scene(
                scene,
                cad_ref="fixtures/two_cylinders",
                profile=SelectorProfile.ARTIFACT,
                options=SelectorOptions(linear_deflection=0.2, angular_deflection=0.3),
            )

        face_columns = bundle.manifest["tables"]["faceColumns"]
        cylinder_rows = [
            dict(zip(face_columns, row))
            for row in bundle.manifest["faces"]
            if str(dict(zip(face_columns, row)).get("surfaceType")) == "cylinder"
        ]
        # 兩顆圓柱各至少一個圓柱面;按 occurrenceId 分組取一面
        by_occurrence: dict[str, dict[str, object]] = {}
        for row in cylinder_rows:
            by_occurrence.setdefault(str(row.get("occurrenceId")), row)
        self.assertEqual(2, len(by_occurrence), f"預期兩顆圓柱各有圓柱面: {sorted(by_occurrence)}")

        payloads = [
            analysis.positioning_facts_for_row("face", row) for row in by_occurrence.values()
        ]
        axes = [payload.get("axisVector") for payload in payloads]
        self.assertTrue(all(axis is not None for axis in axes), payloads)

        # 找出 z 軸那顆當 moving、x 軸那顆當 target(順序與 STEP 讀回順序無關)
        def _dominant(axis: list[float]) -> str:
            return "z" if abs(axis[2]) > abs(axis[0]) else "x"

        moving_axis = next(axis for axis in axes if _dominant(axis) == "z")
        target_axis = next(axis for axis in axes if _dominant(axis) == "x")

        rotation = analysis.rotation_between_vectors(moving_axis, target_axis)
        self.assertIsNotNone(rotation)
        self.assertAlmostEqual(90.0, rotation["angleDeg"], places=6)

        matrix3 = analysis.axis_angle_matrix(rotation["axis"], rotation["angleDeg"])
        rotated = _mat_vec(matrix3, [float(component) for component in moving_axis])
        # 旋轉後與 target 軸共線(圓柱軸是無向線,取 |dot| 判定)
        dot = sum(rotated[index] * float(target_axis[index]) for index in range(3))
        norm = math.sqrt(sum(component * component for component in rotated))
        self.assertAlmostEqual(1.0, abs(dot) / norm, places=6)

        # euler 慣例鎖定:build123d Rotation(*euler) 的 3x3 必須等於我們的矩陣
        euler = analysis.matrix_to_euler_xyz_deg(matrix3)
        self.assertIsNotNone(euler)
        rebuilt = _location_matrix3(build123d.Rotation(*euler))
        for row in range(3):
            for col in range(3):
                self.assertAlmostEqual(
                    matrix3[row][col],
                    rebuilt[row][col],
                    places=9,
                    msg=f"euler 慣例不符 @[{row}][{col}] euler={euler}",
                )


if __name__ == "__main__":
    unittest.main()
