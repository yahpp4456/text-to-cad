"""Tests for findings produced by geometry checks."""

import json
import math
import unittest
from types import SimpleNamespace

from cadpy.findings import (
    RULES,
    Finding,
    interference_findings,
    invalid_solid_findings,
    sort_key,
    summarize,
    sweep_findings,
    to_dicts,
)


def pair(a, b, kind, volume=0.0, gap=0.0):
    return SimpleNamespace(a=a, b=b, kind=kind, overlap_volume=volume, gap=gap)


def hit(a, b, where, overlap, excess):
    return SimpleNamespace(a=a, b=b, where=where, overlap=overlap, excess=excess)


class FindingTests(unittest.TestCase):
    def test_validation_and_refs(self):
        with self.assertRaises(ValueError):
            Finding("solid.invalid", "unknown", "")
        with self.assertRaises(ValueError):
            Finding("unknown", "failed", "")
        refs = ["外殼", 4]
        finding = Finding("solid.invalid", "failed", "", refs=refs)
        refs.clear()
        self.assertEqual(finding.refs, ("外殼", "4"))

    def test_all_rules_are_valid(self):
        for rule in RULES:
            with self.subTest(rule=rule):
                self.assertEqual(Finding(rule, "ok", "").rule, rule)

    def test_serialized_fields_and_rounding(self):
        finding = Finding(
            "motion.penetration", "failed", "行程中兩個零件穿透",
            value=12345.678, limit=0.0123456, unit="mm^3", refs=("軸", "座"), where="90°",
        )
        data = finding.to_dict()
        self.assertEqual(list(data), ["rule", "status", "message", "value", "limit", "unit", "refs", "where"])
        self.assertEqual(data["value"], 12350.0)
        self.assertEqual(data["limit"], 0.01235)
        self.assertEqual(data["refs"], ["軸", "座"])
        self.assertEqual(json.loads(json.dumps(data, allow_nan=False)), data)

    def test_empty_and_nonfinite_fields(self):
        minimal = {"rule": "solid.invalid", "status": "failed", "message": ""}
        self.assertEqual(Finding(**minimal).to_dict(), minimal)
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                self.assertEqual(Finding(**minimal, value=value, limit=value).to_dict(), minimal)
        zero = Finding(**minimal, value=-0.0).to_dict()["value"]
        self.assertEqual(zero, 0.0)
        self.assertEqual(math.copysign(1, zero), 1)

    def test_sort_key_ties_and_missing_value(self):
        first = Finding("motion.penetration", "failed", "", value=-2, refs=("A",))
        second = Finding("motion.penetration", "failed", "", value=-2, refs=("B",))
        third = Finding("solid.invalid", "failed", "", value=-2)
        missing = Finding("motion.declaration", "failed", "")
        ordered = sorted([third, missing, second, first], key=sort_key)
        self.assertEqual(ordered, [first, second, third, missing])

    def test_invalid_solids_preserve_order(self):
        bad = [("殼", "破面"), ("B", ""), ("A", None)]
        self.assertEqual(invalid_solid_findings(iter(bad)), [
            Finding("solid.invalid", "failed", "殼 不是有效實體:破面", refs=("殼",)),
            Finding("solid.invalid", "failed", "B 不是有效實體", refs=("B",)),
            Finding("solid.invalid", "failed", "A 不是有效實體", refs=("A",)),
        ])

    def test_interference_kinds_and_order(self):
        report = SimpleNamespace(clearance=0.125, pairs=[
            pair("軸", "座", "allowed", volume=12.78),
            pair("軸", "環", "overlap", volume=1.03),
            pair("軸", "架", "near", gap=0.0345),
            pair("軸", "殼", "clear"),
            pair("殼", "座", "unmeasured"),
            pair("殼", "架", "overlap", volume=9.36),
            pair("環", "座", "allowed"),
            pair("環", "架", "allowed", volume=-1.0),
            pair("環", "殼", "unknown"),
        ])
        self.assertEqual(interference_findings(report, overlap_tol=0.05), [
            Finding("interference.overlap", "failed", "殼 與 架 重疊 9.4 mm³",
                    value=9.36, limit=0.05, unit="mm^3", refs=("殼", "架")),
            Finding("interference.overlap", "failed", "軸 與 環 重疊 1.0 mm³",
                    value=1.03, limit=0.05, unit="mm^3", refs=("軸", "環")),
            Finding("interference.unmeasured", "not_checked", "殼 與 座 未量測", refs=("殼", "座")),
            Finding("interference.declared_contact", "ok", "軸 與 座 為宣告接觸,重疊 12.8 mm³",
                    value=12.78, unit="mm^3", refs=("軸", "座")),
            Finding("interference.clearance", "ok", "軸 與 架 間隙 0.035 mm,小於要求的 0.125 mm",
                    value=0.0345, limit=0.125, unit="mm", refs=("軸", "架")),
        ])

    def test_sweep_peak_frame_count_and_order(self):
        hits = [
            hit("A", "C", 0, 80, 1.5),
            hit("A", "B", 4, 12, 2.5),
            hit("B", "A", 5, 8, 6.25),
            hit("A", "B", 6, 11, 3.0),
        ]
        tol = {("A", "B"): 0.2, None: 0.1}
        self.assertEqual(sweep_findings(iter(hits), tol=tol), [
            Finding("motion.penetration", "failed", "B 與 A 在 5 穿透,超出 6.2 mm³(共 3 幀穿透)",
                    value=6.25, limit=0.2, unit="mm^3", refs=("B", "A"), where="5"),
            Finding("motion.penetration", "failed", "A 與 C 在 0 穿透,超出 1.5 mm³",
                    value=1.5, limit=0.1, unit="mm^3", refs=("A", "C"), where="0"),
        ])

    def test_sweep_tolerance_priority_and_defaults(self):
        hits = [hit("A", "B", "起點", 4, 2)]
        for tol, expected in [
            ({("A", "B"): 0.0, ("B", "A"): 0.4, None: 0.8}, 0.0),
            ({("X", "Y"): 0.4}, 0.05),
            (0.6, 0.6),
        ]:
            with self.subTest(tol=tol):
                self.assertEqual(sweep_findings(hits, tol=tol)[0].limit, expected)
        self.assertEqual(sweep_findings(hits)[0].limit, 0.05)

    def test_summarize(self):
        ok = Finding("interference.clearance", "ok", "")
        unchecked = Finding("motion.unmeasured", "not_checked", "")
        failed = Finding("motion.sweep_error", "failed", "")
        self.assertEqual(summarize([]), "ok")
        self.assertEqual(summarize([ok]), "ok")
        self.assertEqual(summarize(iter([unchecked, ok])), "not_checked")
        self.assertEqual(summarize(iter([ok, unchecked, failed])), "failed")

    def test_to_dicts_sorts_before_applying_cap(self):
        findings = [Finding("interference.overlap", "failed", "", value=i) for i in range(24)]
        expected = [finding.to_dict() for finding in reversed(findings)]
        self.assertEqual(to_dicts(findings), expected[:20])
        self.assertEqual(to_dicts(findings, cap=2), expected[:2])
        self.assertEqual(to_dicts(findings, cap=0), [])
        self.assertEqual(to_dicts(findings, cap=None), expected)


if __name__ == "__main__":
    unittest.main()
