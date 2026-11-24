import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("regress_fixtures", ROOT / "scripts/dev/regress_fixtures.py")
regress = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(regress)


class CompareResultsTests(unittest.TestCase):
    key = "slide/slide.py"

    def setUp(self):
        part = {"label": "carriage", "volume": 100.0, "area": 20.0, "bbox": [0, 0, 0, 10, 5, 2],
                "faces": 6, "edges": 12, "vertices": 8, "valid": True}
        self.base = {"fixtures": {self.key: {
            "gen": {"ok": True, "partCount": 1, "volume": 100.0, "bbox": list(part["bbox"]),
                    "parts": [part], "seconds": 1.0},
            "validate": {"ok": True, "seconds": 2.0, "checks": [{"id": "motion_sweep", "ok": True}]},
            "pipeline": {"ok": True, "metaPartCount": 1},
        }}}
        self.current = deepcopy(self.base)
        self.old = self.base["fixtures"][self.key]
        self.new = self.current["fixtures"][self.key]

    def assert_changes(self, *expected, strict=False):
        differences = regress.compare_results(self.base, self.current, strict_topology=strict)
        self.assertCountEqual([(d["level"], d["what"]) for d in differences], expected)
        return differences

    def test_identical(self):
        self.assert_changes()

    def test_volume_tolerance(self):
        self.new["gen"]["volume"] += 0.009
        self.assert_changes()
        self.new["gen"]["volume"] += 0.002
        self.assert_changes(("FAIL", "volume"))

    def test_area_tolerance_near_zero(self):
        self.old["gen"]["area"] = 0
        self.new["gen"]["area"] = 0.001
        self.assert_changes()
        self.new["gen"]["area"] = 0.001001
        self.assert_changes(("FAIL", "area"))

    def test_bbox_absolute_tolerance(self):
        self.new["gen"]["bbox"][3] += 0.01
        self.assert_changes(("FAIL", "bbox"))

    def test_part_geometry_and_unavailable_measurements(self):
        before = self.old["gen"]["parts"][0]
        after = self.new["gen"]["parts"][0]
        for field in ("area", "bbox", "volume"):
            after[field] = None
            with self.subTest(field=field):
                diff, = self.assert_changes(("FAIL", field))
                self.assertIn("part=carriage", diff["detail"])
                before[field] = None
                self.assert_changes()

    def test_topology_severity(self):
        self.new["gen"]["parts"][0]["faces"] += 1
        self.assert_changes(("WARN", "topology"))
        self.assert_changes(("FAIL", "topology"), strict=True)

    def test_different_labels(self):
        self.new["gen"]["parts"][0]["label"] = "rail"
        self.assert_changes(("FAIL", "labels"))

    def test_part_count_and_validity(self):
        self.new["gen"]["partCount"] = 2
        self.new["gen"]["parts"][0]["valid"] = False
        self.assert_changes(("FAIL", "partCount"), ("FAIL", "valid"))

    def test_generation_failure_skips_geometry(self):
        self.new["gen"] = {"ok": False, "error": "build failed"}
        self.assert_changes(("FAIL", "gen.ok"))
        self.old["gen"] = {"ok": False, "error": "previous error"}
        self.assert_changes()
        self.new["validate"]["ok"] = False
        self.assert_changes(("FAIL", "validate.ok"))

    def test_failed_motion_check(self):
        self.new["validate"]["checks"][0]["ok"] = False
        self.assert_changes(("FAIL", "check:motion_sweep"))

    def test_newly_skipped_motion_check(self):
        check = self.new["validate"]["checks"][0]
        check["skipped"] = False
        self.assert_changes()
        check["skipped"] = True
        self.assert_changes(("FAIL", "check:motion_sweep"))

    def test_missing_and_new_fixtures(self):
        self.current["fixtures"] = {"new/new.py": self.new}
        changes = self.assert_changes(("FAIL", "missing"), ("WARN", "new"))
        self.assertEqual({d["what"]: d["fixture"] for d in changes},
                         {"missing": self.key, "new": "new/new.py"})

    def test_duplicate_labels_match_by_occurrence(self):
        for data in (self.old, self.new):
            data["gen"]["parts"] = [{"label": "bolt", "volume": 1}, {"label": "bolt", "volume": 2}]
            data["gen"]["partCount"] = 2
        self.new["gen"]["parts"][1]["volume"] = 3
        diff, = self.assert_changes(("FAIL", "volume"))
        self.assertEqual(diff["detail"], "base=2 now=3 part=bolt#1")

    def test_missing_optional_stages(self):
        del self.new["validate"]
        del self.old["pipeline"]
        self.assert_changes()

    def test_pipeline_regression(self):
        self.new["pipeline"] = {"ok": False, "metaPartCount": None}
        self.assert_changes(("FAIL", "pipeline.ok"), ("FAIL", "pipeline.partCount"))

    def test_timing_and_unshared_checks_ignored(self):
        self.new["gen"]["seconds"] += 100
        self.new["validate"]["seconds"] += 100
        self.new["validate"]["checks"].append({"id": "new_check", "ok": False})
        self.assert_changes()


if __name__ == "__main__":
    unittest.main()
