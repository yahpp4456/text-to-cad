"""Represent geometry check results independently of the CAD kernel."""

import math
from dataclasses import dataclass


STATUSES = ("ok", "failed", "not_checked")
RULES = {
    "solid.invalid": "零件不是有效實體",
    "interference.overlap": "兩個零件重疊,且沒有宣告為接觸",
    "interference.declared_contact": "宣告為接觸的一對,實際重疊量",
    "interference.clearance": "兩個零件的間隙小於要求",
    "interference.unmeasured": "這一對沒有量到",
    "motion.declaration": "運動宣告無效",
    "motion.sweep_error": "行程掃掠執行失敗",
    "motion.penetration": "行程中兩個零件穿透",
    "motion.unmeasured": "行程沒有掃完",
}


def _round4(x) -> float | None:
    rounded = float(f"{float(x):.4g}")
    if not math.isfinite(rounded):
        return None
    return rounded or 0.0


@dataclass(frozen=True)
class Finding:
    rule: str
    status: str
    message: str
    value: float | None = None
    limit: float | None = None
    unit: str | None = None
    refs: tuple[str, ...] = ()
    where: str | None = None

    def __post_init__(self):
        if self.status not in STATUSES:
            raise ValueError(f"Unknown finding status: {self.status}")
        if self.rule not in RULES:
            raise ValueError(f"Unknown finding rule: {self.rule}")
        object.__setattr__(self, "refs", tuple(str(x) for x in self.refs))

    def to_dict(self) -> dict:
        fields = {
            "rule": self.rule,
            "status": self.status,
            "message": self.message,
            "value": _round4(self.value) if self.value is not None else None,
            "limit": _round4(self.limit) if self.limit is not None else None,
            "unit": self.unit,
            "refs": list(self.refs) if self.refs else None,
            "where": self.where,
        }
        return {key: value for key, value in fields.items() if value is not None}


def sort_key(finding: Finding) -> tuple:
    priority = ("failed", "not_checked", "ok").index(finding.status)
    value = finding.value
    missing = value is None or math.isnan(value)
    return priority, missing, 0.0 if missing else -value, finding.rule, finding.refs


def invalid_solid_findings(bad) -> list[Finding]:
    findings = []
    for name, detail in bad:
        message = f"{name} 不是有效實體"
        if detail:
            message += f":{detail}"
        findings.append(Finding("solid.invalid", "failed", message, refs=(name,)))
    return findings


def interference_findings(report, *, overlap_tol) -> list[Finding]:
    findings = []
    for pair in report.pairs:
        a, b = refs = (pair.a, pair.b)
        if pair.kind == "overlap":
            finding = Finding(
                "interference.overlap", "failed", f"{a} 與 {b} 重疊 {pair.overlap_volume:.1f} mm³",
                value=pair.overlap_volume, limit=overlap_tol, unit="mm^3", refs=refs,
            )
        elif pair.kind == "allowed" and pair.overlap_volume > 0:
            finding = Finding(
                "interference.declared_contact", "ok",
                f"{a} 與 {b} 為宣告接觸,重疊 {pair.overlap_volume:.1f} mm³",
                value=pair.overlap_volume, unit="mm^3", refs=refs,
            )
        elif pair.kind == "near":
            finding = Finding(
                "interference.clearance", "ok",
                f"{a} 與 {b} 間隙 {pair.gap:.3f} mm,小於要求的 {report.clearance:.3f} mm",
                value=pair.gap, limit=report.clearance, unit="mm", refs=refs,
            )
        elif pair.kind == "unmeasured":
            finding = Finding("interference.unmeasured", "not_checked", f"{a} 與 {b} 未量測", refs=refs)
        else:
            continue
        findings.append(finding)
    return sorted(findings, key=sort_key)


def sweep_findings(hits, *, tol=0.05) -> list[Finding]:
    """Keep the frame with the greatest excess for each unordered pair."""
    peaks = {}
    for hit in hits:
        key = tuple(sorted((hit.a, hit.b)))
        peak, count = peaks.get(key, (hit, 0))
        if hit.excess > peak.excess:
            peak = hit
        peaks[key] = peak, count + 1

    findings = []
    for peak, count in peaks.values():
        a, b = peak.a, peak.b
        where = str(peak.where)
        limit = tol
        if isinstance(tol, dict):
            limit = tol.get((a, b), tol.get((b, a), tol.get(None, 0.05)))
        message = f"{a} 與 {b} 在 {where} 穿透,超出 {peak.excess:.1f} mm³"
        if count > 1:
            message += f"(共 {count} 幀穿透)"
        findings.append(Finding(
            "motion.penetration", "failed", message,
            value=peak.excess, limit=limit, unit="mm^3", refs=(a, b), where=where,
        ))
    return sorted(findings, key=sort_key)


def summarize(findings) -> str:
    status = "ok"
    for finding in findings:
        if finding.status == "failed":
            return "failed"
        if finding.status == "not_checked":
            status = "not_checked"
    return status


def to_dicts(findings, *, cap=20) -> list[dict]:
    ordered = sorted(findings, key=sort_key)
    return [finding.to_dict() for finding in ordered[:cap]]
