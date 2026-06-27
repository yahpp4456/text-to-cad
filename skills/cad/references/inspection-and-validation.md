# Inspection and validation

Read this file for every generated STEP artifact and whenever the user asks for geometry facts, references, dimensions, mating, diffing, or frame inspection.

## Principle

Deterministic geometry checks decide pass/fail; mandatory snapshot review (see `snapshot-review.md`) catches semantic errors the deterministic checks did not encode. Scale the deterministic checks to the user's spec: every dimension, clearance, or relationship the user specified — including dimensions taken from a technical drawing — must be verified with `measure`, `align`, or `frame`. The facts/planes/positioning baseline runs for every generated artifact regardless of spec.

## Tool

The launcher lives in the CAD skill directory:

```bash
python scripts/inspect {refs|diff|frame|measure|align|worker|batch} ...
```

Inspection targets resolve from the command cwd; pass cwd-relative target paths. Common data-output flags: `--format json|text` (default is machine-readable), `--quiet`, `--verbose`.

Accepted target forms:

```text
path/to/entry
path/to/entry.step
```

Selector refs are local to the STEP/CAD entry target passed to the command. They do not include file paths:

```text
#o1.2
#o1.2.f1
#f1
```

Pass selector refs as `#...` tokens. The STEP/CAD file path or entry target is a separate CLI argument.

## Validation sequence

1. Generation completed and the STEP/STP file exists.
2. `refs --facts --planes --positioning` confirms scale, labels, major planes, and placement-ready references. Run this for every generated artifact.
3. Spec-driven checks: `measure` for every user-specified dimension, offset, or clearance; `align` for interfaces that should be flush or centered; `frame` for orientation and occurrence-placement expectations; `diff` for modifications that could affect unrelated geometry.
4. Shape-level kernel checks via `cadpy.geometry_checks`: `assert_valid_solid` for every solid (a valid B-rep, by `BRepCheck_Analyzer`) and, for assemblies, `assert_no_interference` (precise pairwise minimum gap and penetration volume). This is the deterministic counterpart to interference you would otherwise only eyeball in a snapshot.
5. Snapshot the primary STEP/STP per `snapshot-review.md`, then convert every visual concern into a deterministic geometry check before it becomes a validation claim.

## Shape-level geometry checks

`cadpy.geometry_checks` runs deterministic checks on the real OCCT solids (not the exported manifest), so they belong inside a generator's `gen_step()` or its `check_geometry(shape)` hook:

```python
from cadpy.geometry_checks import assert_valid_solid, assert_no_interference

def check_geometry(shape):           # the pipeline runs this before writing the STEP
    assert_valid_solid(shape, label="actuator")
    assert_no_interference(
        shape,                        # a build123d assembly Compound
        allow=[("piston_rod", "rack"), ("rack", "pinion")],  # declared intended contact
    )
```

A real assembly is full of INTENDED contact — a shaft in a bore, meshing gear teeth, a press fit — so `assert_no_interference` fails only on overlap between pairs NOT in `allow`; declare the intended pairs and a true unintended clash still fails. Near-misses (a positive gap below a requested `clearance`) are reported, not blocked. These are geometric-validity checks only — they make no structural, tolerance, or certification claim (see "Do not claim" below).

### Mechanism motion sweep

A static check passes the SEATED pose but says nothing about the travel — for a moving mechanism the deepest overlap is usually mid-stroke, and a snapshot of the final pose misses it too. `assert_motion_clear(poses, pairs, *, baseline=..., tol=...)` sweeps the motion and refuses the STEP if any tracked pair penetrates beyond its baseline anywhere along the path:

```python
from cadpy.geometry_checks import assert_no_interference, assert_motion_clear

def check_geometry(shape):
    assert_no_interference(shape, allow=INTENDED_CONTACT)         # the seated pose
    assert_motion_clear(                                          # ...then the whole stroke
        ((f, pose(f)) for f in frames),     # drive poses from the SAME kinematics as the .step.js sidecar
        [("clip", "rail"), ("clip", "gripper")],  # track moving-part-vs-tooling pairs too, not just vs the rail
        baseline=pose(seated),              # seated overlaps are the allowed steady contact (a grip, a press foot)
    )
```

Two failure modes this exists for (lesson L-4): the deepest clash is mid-travel, not at the seated endpoint the static check sees; and a sweep only catches the pairs you list — checking clip-vs-rail but not clip-vs-gripper hides a real clash. Pass the seated pose as `baseline` so steady intended contact rides along without being flagged (only EXCESS overlap is a defect); use a per-pair `tol` dict when rigid tooling on a rolling part leaves a tiny tilt-mismatch a compliant gripper would absorb.

## Reference discovery

Compact facts and planes:

```bash
python scripts/inspect refs path/to/model.step \
  --facts --planes --positioning
```

Detailed selector inspection:

```bash
python scripts/inspect refs path/to/model.step '#selector' \
  --detail --positioning
```

Topology enumeration, only when needed:

```bash
python scripts/inspect refs path/to/model.step --topology
```

Plane options:

```bash
--plane-coordinate-tolerance FLOAT
--plane-min-area-ratio FLOAT
--plane-limit INT
```

Use lower plane limits and compact facts for normal validation. Use topology enumeration only for selector discovery, complex debugging, or when a feature cannot be verified through facts/planes/measurements; it can be expensive on large models.

## Measurement checks

Use `measure` for bounding distances, clearances, offsets, part spacing, plate thickness, hole-to-face distances, and alignment verification.

```bash
python scripts/inspect measure path/to/model.step \
  --from '#selector_a' \
  --to '#selector_b' \
  --axis x
```

Axis may be inferred when possible, but specify `x`, `y`, or `z` for deterministic checks.

## Alignment checks

Use `align` when two exported STEP references should be flush or centered. It returns a translation delta between the selected refs; apply any required correction in the build123d source (see `positioning.md`), regenerate, and re-inspect.

```bash
python scripts/inspect align path/to/assembly.step \
  --moving '#moving_selector' \
  --target '#target_selector' \
  --mode flush \
  --axis z
```

## Frame inspection

Use `frame` to validate occurrence transforms and selected-reference world frames:

```bash
python scripts/inspect frame path/to/model.step '#selector'
```

Frame output is useful for assemblies, part-local-to-world conversion, and placement debugging.

## Diff checks

For modification tasks, compare before and after artifacts:

```bash
python scripts/inspect diff path/to/before.step path/to/after.step --planes
```

Use diff when a repair, feature addition, or source edit could affect unrelated geometry.

## Validation report content

Report only checks that were actually run or directly supported by tool output. If an important selector was inspected, return the local selector ref beside the owning CAD Viewer link.

Use this structure:

```text
Validation:
- STEP generation: passed/partial/failed
- Solids/assembly: <counts and labels>
- Bounding box: <dimensions and units>
- Major planes/refs: <summary>
- Positioning: <frame/measure/align results if relevant>
- Feature checks: <holes, cutouts, bosses, etc.>
- Visual review: `$cad-viewer` viewer link returned; CAD `scripts/snapshot` PNG/GIF included or skipped with reason; follow-up geometry checks for any visual findings
```

Do not claim:

- structural safety
- process certification
- tolerance compliance
- manufacturability beyond geometric plausibility
unless the relevant analysis or manufacturing data was explicitly performed.
