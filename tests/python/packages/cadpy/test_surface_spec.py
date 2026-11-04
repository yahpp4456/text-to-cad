"""OCP-free tests for cadpy.surface.spec (surface-draft-v1 validation / normalization).

The JS twin (apps/cad-chat/src/lib/surface/surfaceSchema.js) must agree on every rule
here; both sides are pinned by the shared example drafts under
apps/cad-chat/src/lib/surface/examples/*.json.
"""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadpy/src")

from cadpy.surface.spec import (  # noqa: E402
    SpecError,
    apply_params,
    normalize_spec,
    scalar_params,
    validate_spec,
)

REPO = Path(__file__).resolve().parents[4]
EXAMPLES = sorted((REPO / "apps/cad-chat/src/lib/surface/examples").glob("*.json"))


def _mouse() -> dict:
    return json.loads((REPO / "apps/cad-chat/src/lib/surface/examples/mouse_shell.json").read_text(encoding="utf-8"))


def _paths(errs: list[dict]) -> set[str]:
    return {e["path"] for e in errs}


class ExamplesTests(unittest.TestCase):
    def test_examples_exist_and_validate(self) -> None:
        self.assertGreaterEqual(len(EXAMPLES), 3, "至少 mouse_shell / vase / mickey 三份範例")
        for path in EXAMPLES:
            raw = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(validate_spec(raw), [], path.name)
            n = normalize_spec(raw)
            # idempotent + JSON 相容(無 tuple)
            self.assertEqual(normalize_spec(n), n, path.name)
            json.dumps(n)
            self.assertEqual(n["ops"][0]["op"], "sew")


class ValidationTests(unittest.TestCase):
    def test_minimal_defaults(self) -> None:
        raw = {
            "schemaVersion": 1,
            "curves": [{"id": "a", "kind": "line", "points": [[0, 0, 0], [10, 0, 0]]}],
            "surfaces": [{"id": "s", "op": "extrude", "curve": "a", "dir": [0, 0, 1], "length": 5}],
        }
        n = normalize_spec(raw)
        self.assertEqual(n["result"], "solid")
        self.assertIsNone(n["symmetry"])
        self.assertTrue(n["fuse"])
        self.assertEqual(n["ops"], [{"op": "sew", "tol": 0.01}])
        self.assertEqual(n["surfaces"][0]["role"], "body")
        self.assertIs(n["surfaces"][0]["capped"], False)
        self.assertEqual(n["analysis"], {"minContinuity": "G1", "creases": 0, "zebra": True})
        self.assertEqual(n["revision"], 0)

    def test_ops_sorted_and_single(self) -> None:
        raw = _mouse()
        raw["ops"] = [{"op": "thicken", "t": 1}, {"op": "sew", "tol": 0.05}]
        n = normalize_spec(raw)
        self.assertEqual([o["op"] for o in n["ops"]], ["sew", "thicken"])
        raw["ops"].append({"op": "thicken", "t": 2})
        self.assertIn("ops[2]", _paths(validate_spec(raw)))

    def test_error_paths(self) -> None:
        cases = [
            (lambda r: r.__setitem__("schemaVersion", 2), "schemaVersion"),
            (lambda r: r.__setitem__("result", "mesh"), "result"),
            (lambda r: r.__setitem__("symmetry", "ZX"), "symmetry"),
            (lambda r: r.__setitem__("curves", []), "curves"),
            (lambda r: r["curves"][0].__setitem__("id", "Bad-Id"), "curves[0].id"),
            (lambda r: r["curves"][1].__setitem__("id", "sec_front"), "curves[1].id"),
            (lambda r: r["curves"][0].__setitem__("kind", "helix"), "curves[0].kind"),
            (lambda r: r["curves"][0].__setitem__("points", [[0, 0, 0]]), "curves[0].points"),
            (lambda r: r["curves"][0].__setitem__("tangents", {"mid": [1, 0, 0]}), "curves[0].tangents"),
            (lambda r: r["surfaces"][0].__setitem__("sections", ["sec_front", "ghost"]), "surfaces[0].sections[1]"),
            (lambda r: r["surfaces"][0].__setitem__("sections", ["sec_front"]), "surfaces[0].sections"),
            (lambda r: r["surfaces"][0].__setitem__("op", "trim"), "surfaces[0].op"),
            (lambda r: r["ops"].__setitem__(1, {"op": "thicken", "t": -1}), "ops[1].t"),
            (lambda r: r["ops"].__setitem__(1, {"op": "thicken", "t": 1, "dir": "up"}), "ops[1].dir"),
            (lambda r: r.__setitem__("analysis", {"minContinuity": "G3"}), "analysis.minContinuity"),
            (lambda r: r.__setitem__("analysis", {"creases": -1}), "analysis.creases"),
            (lambda r: r.__setitem__("revision", -1), "revision"),
            (lambda r: r["surfaces"][0].__setitem__("role", "trim"), "surfaces[0].role"),
            (lambda r: r["surfaces"][0].__setitem__("capped", "yes"), "surfaces[0].capped"),
            (lambda r: r["surfaces"].append({"id": "pp", "op": "patch", "boundary": ["sec_front", "sec_mid"], "capped": True}), "surfaces[1].capped"),
        ]
        for mutate, path in cases:
            raw = _mouse()
            mutate(raw)
            self.assertIn(path, _paths(validate_spec(raw)), path)

    def test_shell_result_rejects_thicken_and_fillet(self) -> None:
        raw = _mouse()
        raw["result"] = "shell"
        self.assertIn("ops[1]", _paths(validate_spec(raw)))
        raw["ops"] = [{"op": "fillet", "r": 1}]
        self.assertIn("ops[0]", _paths(validate_spec(raw)))

    def test_patch_rules(self) -> None:
        raw = _mouse()
        raw["curves"].append({"id": "c_a", "kind": "line", "points": [[0, 0, 0], [1, 0, 0]]})
        raw["curves"].append({"id": "c_b", "kind": "line", "points": [[1, 0, 0], [0, 0, 0]]})
        raw["surfaces"].append({"id": "p", "op": "patch", "boundary": ["c_a", "c_b"],
                                "continuity": {"c_a": {"face": "body", "level": "G2"}}})
        self.assertEqual(validate_spec(raw), [])
        bad = copy.deepcopy(raw)
        bad["surfaces"][-1]["continuity"] = {"sec_mid": {"face": "body", "level": "G2"}}
        self.assertIn("surfaces[1].continuity.sec_mid", _paths(validate_spec(bad)))
        bad = copy.deepcopy(raw)
        bad["surfaces"][-1]["continuity"] = {"c_a": {"face": "nope", "level": "G2"}}
        self.assertIn("surfaces[1].continuity.c_a.face", _paths(validate_spec(bad)))
        bad = copy.deepcopy(raw)
        bad["surfaces"][-1]["continuity"] = {"c_a": {"face": "body", "level": "C2"}}
        self.assertIn("surfaces[1].continuity.c_a", _paths(validate_spec(bad)))

    def test_nurbs_rules(self) -> None:
        raw = _mouse()
        raw["curves"].append({"id": "n", "kind": "nurbs", "degree": 3, "poles": [[0, 0, 0], [1, 0, 0], [2, 0, 0]]})
        self.assertIn("curves[3].poles", _paths(validate_spec(raw)))
        raw["curves"][-1]["poles"].append([3, 0, 0])
        raw["curves"][-1]["weights"] = [1, 1, 1]
        self.assertIn("curves[3].weights", _paths(validate_spec(raw)))
        raw["curves"][-1]["weights"] = [1, 1, 1, 1]
        self.assertEqual(validate_spec(raw), [])

    def test_spec_error_carries_errors(self) -> None:
        with self.assertRaises(SpecError) as cm:
            normalize_spec({"schemaVersion": 1})
        self.assertTrue(any(e["path"] == "curves" for e in cm.exception.errors))


class ParamsTests(unittest.TestCase):
    def test_scalar_params_and_apply(self) -> None:
        n = normalize_spec(_mouse())
        self.assertEqual(scalar_params(n), {"thick": 2.0})
        n2 = apply_params(n, {"thick": 3.5, "fillet_r": 9, "revolve_deg": 90})
        self.assertEqual(next(o for o in n2["ops"] if o["op"] == "thicken")["t"], 3.5)
        self.assertEqual(next(o for o in n["ops"] if o["op"] == "thicken")["t"], 2.0, "不改原件")
        vase = normalize_spec(json.loads((REPO / "apps/cad-chat/src/lib/surface/examples/vase.json").read_text(encoding="utf-8")))
        self.assertEqual(scalar_params(vase), {"thick": 2.0, "revolve_deg": 360.0})
        v2 = apply_params(vase, {"revolve_deg": 180})
        self.assertEqual(v2["surfaces"][0]["angle"], 180.0)
        self.assertEqual(apply_params(vase, {"thick": -1})["ops"][1]["t"], 2.0, "非法值忽略")


if __name__ == "__main__":
    unittest.main()
