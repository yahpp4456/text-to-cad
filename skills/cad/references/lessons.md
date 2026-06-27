# Lessons

Read this file when a validation or repair failure has just been resolved, or when starting work a past lesson might cover. A lesson turns one failure into a durable, deterministic check so the same defect cannot silently return.

## Why this exists

Deterministic checks and snapshot review (`inspection-and-validation.md`, `snapshot-review.md`) only catch what they already encode. A defect that slips past both did so because nothing encoded it yet. "Repair and rerun" fixes the model; it does not fix the skill. Unless the missing check is added, the next model repeats the defect. This file is where a one-off failure becomes a standing guard.

## When to record a lesson

Record one when ALL of these hold:

- a defect reached a STEP or snapshot that the existing checks passed (a false green), and
- the root cause is general — it would recur on other parts or assemblies, and
- it can be expressed as a deterministic check or a concrete rule.

Do not record one-off typos, a user-specific dimension mistake, or anything an existing check already covers.

## How to record (the loop)

1. Name the root cause in one sentence — the cause, not the symptom.
2. Express it as the smallest durable artifact:
   - a deterministic check — extend `cadpy.validators` (manifest-level) or `cadpy.geometry_checks` (shape-level), or add an `assert_*` call to the generator's `check_geometry`;
   - or a rule — a `symptom -> action` bullet in the reference file that owns the topic.
3. Lock it with a known-bad fixture: a test that FAILS before the fix and passes after (mirror the injected-defect cases in `tests/python/packages/cadpy/test_geometry_checks.py`).
4. Add a one-line entry to the index below.
5. Cross-reference it from the reference file the rule lives in.

## Lesson entry template

```text
L-<n> | <one-line root cause> | <durable check or rule + where it lives> | <fixture that locks it>
```

## Index

These seed entries are the first lessons institutionalized — the deterministic counterpart to mandatory snapshot review (see the acceptance contract in `repair-loop.md`).

| id | root cause | institutionalized as | locked by |
|---|---|---|---|
| L-1 | A generated part can be an invalid B-rep solid (open shell, self-intersection) yet still export; bbox and manifest checks do not see it. | `geometry_checks.assert_valid_solid` (BRepCheck), called from the generator's `check_geometry`. | `test_geometry_checks.py::test_open_shell_is_invalid` |
| L-2 | Assembly parts that look clear in a snapshot can interpenetrate; the deepest overlap is often mid-travel, not at an endpoint. | `geometry_checks.assert_no_interference` over all part pairs. | `test_geometry_checks.py::test_undeclared_overlap_fails`, `::test_injected_penetrator_fails_despite_allowlist` |
| L-3 | Intended contact — shaft in bore, gear mesh, press fit — makes a naive "any overlap fails" check reject real assemblies. | Allow-list semantics: the author declares intended contact pairs; only undeclared overlap fails. | `test_geometry_checks.py::test_real_assembly_passes_with_declared_contacts` |
