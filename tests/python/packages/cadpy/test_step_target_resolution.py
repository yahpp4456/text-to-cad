"""An explicit STEP path resolves to its catalog source without walking the CAD root.

``catalog.find_source_for_step_path`` must give the same answer as the tree walk
(``find_source_by_cad_ref``) for every file the walk can discover, and
``step_targets.resolve_step_target`` must use it for explicit STEP targets -- the walk
parses every generator under the root, so its cost grows with each session and snapshot
kept there.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cadpy import assembly_spec, catalog, step_targets

PART_GENERATOR = "def gen_step():\n    return make_part()\n"
ASSEMBLY_GENERATOR = 'def gen_step():\n    return {"instances": []}\n'
# Contains the marker the catalog scans for, but gen_step has no single return value:
# parsing it raises, which is what an agent's half-written generator looks like.
BROKEN_GENERATOR = "def gen_step():\n    pass\n"
STEP_BYTES = b"ISO-10303-21;\nEND-ISO-10303-21;\n"


class StepTargetResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        for module in (catalog, assembly_spec, step_targets):
            patcher = mock.patch.object(module, "REPO_ROOT", self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(catalog, "CAD_ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, relative: str, content: str | bytes) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        return path

    def walk(self, step_path: Path) -> catalog.CadSource | None:
        return catalog.find_source_by_cad_ref(catalog.cad_ref_from_step_path(step_path))

    def assert_same_as_walk(self, step_path: Path) -> catalog.CadSource | None:
        """Both local lookups -- by path and by ref -- agree with the tree walk."""
        walked = self.walk(step_path)
        local = catalog.find_source_for_step_path(step_path)
        self.assertEqual(local, walked)
        self.assertEqual(catalog.lookup_source_by_cad_ref(catalog.cad_ref_from_step_path(step_path)), walked)
        return local

    def test_generated_part_resolves_to_its_generator(self) -> None:
        script = self.write("models/bracket/bracket.py", PART_GENERATOR)
        step = self.write("models/bracket/bracket.step", STEP_BYTES)
        source = self.assert_same_as_walk(step)
        self.assertEqual((source.kind, source.source, source.source_path), ("part", "generated", script))

    def test_generated_assembly_keeps_its_kind(self) -> None:
        self.write("models/stage/stage.py", ASSEMBLY_GENERATOR)
        step = self.write("models/stage/stage.step", STEP_BYTES)
        source = self.assert_same_as_walk(step)
        self.assertEqual(source.kind, "assembly")

    def test_imported_step_is_its_own_source(self) -> None:
        step = self.write("models/session/imported/motor.step", STEP_BYTES)
        source = self.assert_same_as_walk(step)
        self.assertEqual((source.kind, source.source, source.source_path), ("part", "imported", step))

    def test_stp_suffix(self) -> None:
        step = self.write("models/vendor/rail.stp", STEP_BYTES)
        source = self.assert_same_as_walk(step)
        self.assertEqual(source.step_path, step)

    def test_sibling_python_that_is_not_a_generator_is_ignored(self) -> None:
        self.write("models/tools/helper.py", "VALUE = 1\n")
        step = self.write("models/tools/helper.step", STEP_BYTES)
        source = self.assert_same_as_walk(step)
        self.assertEqual(source.source, "imported")

    def test_generator_whose_step_is_not_written_yet(self) -> None:
        self.write("models/new/new.py", PART_GENERATOR)
        missing = self.root / "models/new/new.step"
        source = self.assert_same_as_walk(missing)
        self.assertEqual(source.source, "generated")

    def test_missing_file_without_generator_is_none(self) -> None:
        self.assertIsNone(self.assert_same_as_walk(self.root / "models/nope/nope.step"))

    def test_ignored_directory_is_not_discovered(self) -> None:
        self.write("node_modules/pkg/part.py", PART_GENERATOR)
        step = self.write("node_modules/pkg/part.step", STEP_BYTES)
        self.assertIsNone(self.assert_same_as_walk(step))

    def test_outside_root_is_none(self) -> None:
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        step = Path(other.name).resolve() / "loose.step"
        step.write_bytes(STEP_BYTES)
        self.assertIsNone(catalog.find_source_for_step_path(step))

    def test_non_step_suffix_is_none(self) -> None:
        self.assertIsNone(catalog.find_source_for_step_path(self.write("models/a/a.glb", b"glTF")))

    def test_unrelated_broken_generator_does_not_fail_the_lookup(self) -> None:
        self.write("models/bracket/bracket.py", PART_GENERATOR)
        step = self.write("models/bracket/bracket.step", STEP_BYTES)
        self.write("models/.cadchat/s_other/half_written.py", BROKEN_GENERATOR)
        with self.assertRaises(ValueError):
            self.walk(step)  # the walk parses every generator, so one bad file fails them all
        self.assertEqual(catalog.find_source_for_step_path(step).kind, "part")

    def test_ref_lookup_rejects_empty_and_outside_refs(self) -> None:
        self.assertIsNone(catalog.lookup_source_by_cad_ref(""))
        self.assertIsNone(catalog.lookup_source_by_cad_ref("models/nope/nope"))

    def test_resolve_step_target_never_walks_the_cad_root(self) -> None:
        script = self.write("models/stage/stage.py", ASSEMBLY_GENERATOR)
        step = self.write("models/stage/stage.step", STEP_BYTES)
        loose = self.write("models/stage/imported/motor.step", STEP_BYTES)
        with mock.patch.object(catalog, "iter_cad_sources", side_effect=AssertionError("walked the CAD root")):
            by_path = step_targets.resolve_step_target("models/stage/stage.step")
            by_ref = step_targets.resolve_step_target("models/stage/stage")  # how scripts/inspect asks
            imported = step_targets.resolve_step_target("models/stage/imported/motor")
            absolute = step_targets.resolve_step_target(str(step))
            self.assertEqual(step_targets.step_path_from_target("models/stage/stage"), step)
            with self.assertRaises(step_targets.CadRefError):
                step_targets.resolve_step_target("models/stage/missing")
        expected = step_targets.ResolvedStepTarget(
            cad_path="models/stage/stage", kind="assembly", source_path=script, step_path=step
        )
        self.assertEqual(by_path, expected)
        self.assertEqual(by_ref, expected)
        self.assertEqual(
            imported,
            step_targets.ResolvedStepTarget(
                cad_path="models/stage/imported/motor", kind="part", source_path=loose, step_path=loose
            ),
        )
        # An absolute target spells a ref the catalog never used; it stays a plain part, as before.
        self.assertEqual((absolute.kind, absolute.source_path, absolute.step_path), ("part", step, step))

    def test_resolve_step_target_matches_the_walk_based_answer(self) -> None:
        self.write("models/stage/stage.py", ASSEMBLY_GENERATOR)
        self.write("models/stage/stage.step", STEP_BYTES)
        self.write("models/bracket/bracket.py", PART_GENERATOR)
        self.write("models/bracket/bracket.step", STEP_BYTES)
        self.write("models/vendor/rail.stp", STEP_BYTES)

        def walk_based(target: str) -> step_targets.ResolvedStepTarget:
            # How this module resolved targets when it used the tree walk.
            cad_path = step_targets.entry_target_from_target(target).cad_path
            raw = step_targets._raw_step_path(target)
            source = catalog.find_source_by_cad_ref(cad_path)
            if raw is not None:
                if source is not None and source.step_path is not None and source.step_path.resolve() == raw.resolve():
                    return step_targets.ResolvedStepTarget(cad_path, source.kind, source.source_path, raw)
                return step_targets.ResolvedStepTarget(cad_path, "part", raw, raw)
            return step_targets.ResolvedStepTarget(cad_path, source.kind, source.source_path, source.step_path.resolve())

        for target in (
            "models/stage/stage.step",
            "models/stage/stage",
            "models/bracket/bracket.step",
            "models/bracket/bracket",
            "models/vendor/rail.stp",
            "models/vendor/rail",
        ):
            with self.subTest(target=target):
                self.assertEqual(step_targets.resolve_step_target(target), walk_based(target))


if __name__ == "__main__":
    unittest.main()
