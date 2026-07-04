"""Shape-level geometric acceptance checks over real OCP B-rep solids.

Unlike :mod:`cadpy.validators` (which asserts over an exported *manifest* JSON
dict), these operate directly on OCCT solids through the OCP kernel that
build123d already ships:

- validity        -> ``BRepCheck_Analyzer``
- minimum gap     -> ``BRepExtrema_DistShapeShape``
- overlap volume  -> ``BRepAlgoAPI_Common`` + ``BRepGProp`` volume

They are the *deterministic* counterpart to the mandatory snapshot review, and
the two are meant to be used TOGETHER (see
``skills/cad/references/repair-loop.md`` "Acceptance contract"), not one instead
of the other: deterministic checks decide pass/fail on what they can encode;
the snapshot catches the semantic errors they cannot.

Interference semantics (important)
----------------------------------
A real assembly is full of INTENDED contact -- a shaft in a bore, meshing gear
teeth, a press fit -- which shows up as touching faces or even overlapping
volume. A naive "any overlap fails" check would reject every realistic
assembly (the repo's own ``rack_pinion_rotary_actuator`` has six intended
volume overlaps). The model here mirrors a mechanism sandbox's intent-contact
allow-list:

- overlap  (common volume > ``overlap_tol``) on a pair NOT in ``allow`` -> defect
- near     (``0 < gap < clearance``, no overlap)                        -> reported, not blocking
- declared intended-contact pair (in ``allow``) -> classified ``allowed``: its
  overlap volume is still MEASURED and reported (see ``InterferenceReport.allowed``
  and ``summary``), but it does not block.

So ``assert_no_interference`` fails only on *undeclared* volume overlap; the
author declares the intended contacts exactly as they would reason about them.

Allow-list is for a genuine FIT, not a license to glue blocks (lesson L-5)
-------------------------------------------------------------------------
A legitimate intended contact is a real mechanical fit -- a shaft in a bore, a
pin in a hole, a press fit, a gear mesh -- where the overlap represents that fit.
It is NOT a license to allow-list a gross interpenetration of two distinct
STRUCTURAL members so the gate passes ("glued blocks"): two parts that should be
fastened cannot occupy the same volume. Model such a joint pin-mediated (a
dowel/bolt/pin that overlaps each member in a small bore contact, while the two
members themselves stay clear) or face-mated. Magnitude alone does not separate
the two (a piston rod legitimately fills most of its barrel bore), so the report
now surfaces every ``allowed`` overlap's volume for review, and a consuming model
should assert its joined members do NOT overlap while the mediator overlaps each
(see ``tests/.../test_parts_models.py`` and ``skills/cad/references/lessons.md``).

Naming: parts are named by their build123d label (or position). Duplicate
labels are common (identical fasteners, repeated gears), so they are
disambiguated with a ``#n`` suffix -- otherwise a single allow-list entry would
silently whitelist every same-named pair. Declare an intended contact against
the name shown in :class:`InterferenceReport` / the failure message.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps

# Two solids are considered "touching" when the precise kernel gap is at or
# below this (mm). Below it we look at the actual penetration volume to tell a
# face-on-face touch (volume ~0) from a real interpenetration (volume > tol).
_TOUCH_EPS = 1e-7


def _topods(shape: Any) -> Any:
    """Return the raw ``TopoDS_Shape`` for a build123d shape or a TopoDS shape.

    build123d shapes expose the kernel handle as ``.wrapped``; a bare TopoDS
    shape (no ``.wrapped``) is returned unchanged. A null/empty build123d shape
    raises ``AssertionError`` from the ``.wrapped`` property, and ``None`` is a
    possible input too; both normalize to ``None`` so a null shape can be
    reported invalid rather than leaking a bare ``AssertionError`` (which the
    acceptance hook would misread as a deliberate gate rejection).
    """
    if shape is None:
        return None
    try:
        return shape.wrapped
    except AttributeError:
        return shape  # already a raw TopoDS shape
    except Exception:
        return None  # build123d null/empty shape -> treat as null


# ---------------------------------------------------------------------------
# Validity (BRepCheck)
# ---------------------------------------------------------------------------
def is_valid_solid(shape: Any) -> bool:
    """True when OCCT's ``BRepCheck_Analyzer`` reports the solid valid.

    Accepts a build123d shape or a raw TopoDS shape (compounds are checked
    recursively by the analyzer). A null/None shape is reported invalid
    (``False``) rather than letting the kernel raise.
    """
    topo = _topods(shape)
    if topo is None or (hasattr(topo, "IsNull") and topo.IsNull()):
        return False
    return bool(BRepCheck_Analyzer(topo).IsValid())


def assert_valid_solid(shape: Any, *, label: str = "solid") -> Any:
    """Raise ``AssertionError`` unless ``shape`` is a valid B-rep solid."""
    if not is_valid_solid(shape):
        raise AssertionError(f"{label}: BRepCheck_Analyzer reports an invalid solid")
    return shape


def assert_all_valid(parts: Any, *, label: str = "part") -> None:
    """Assert every named part of an assembly (or a single solid) is valid.

    ``parts`` may be a build123d Compound/shape, a ``gen_step`` envelope dict, or
    a sequence of ``(name, shape)`` pairs / bare shapes (see
    :func:`enumerate_interferences`). A single solid is validated as one part,
    never skipped.
    """
    named = _as_named_parts(parts)
    if not named:
        raise AssertionError(f"assert_all_valid: no {label}s to validate")
    invalid = [name for name, shape in named if not is_valid_solid(shape)]
    if invalid:
        raise AssertionError(f"invalid {label}(s): {', '.join(invalid)}")


# ---------------------------------------------------------------------------
# Pairwise metrics (distance / overlap)
# ---------------------------------------------------------------------------
def min_gap(a: Any, b: Any) -> float:
    """Precise minimum clearance (mm) between two solids; 0 when touching/overlapping."""
    ta, tb = _topods(a), _topods(b)
    if ta is None or tb is None:
        raise RuntimeError("min_gap: a null/empty shape has no distance")
    dss = BRepExtrema_DistShapeShape(ta, tb)
    if not dss.IsDone():
        raise RuntimeError("BRepExtrema_DistShapeShape failed to compute a distance")
    return float(dss.Value())


def overlap_volume(a: Any, b: Any) -> float:
    """Volume (mm^3) of the boolean intersection of two solids; 0 when disjoint.

    A non-intersecting ``common`` yields a valid empty shape (not null) whose
    volume is 0, so callers should gate penetration on ``volume > tol``.
    """
    ta, tb = _topods(a), _topods(b)
    if ta is None or tb is None:
        raise RuntimeError("overlap_volume: a null/empty shape has no volume")
    common = BRepAlgoAPI_Common(ta, tb)
    common.Build()
    if not common.IsDone():
        raise RuntimeError("BRepAlgoAPI_Common failed to build an intersection")
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(common.Shape(), props)
    return abs(float(props.Mass()))


# ---------------------------------------------------------------------------
# Interference enumeration over an assembly
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PairResult:
    """One unordered part pair's clearance verdict."""

    a: str
    b: str
    gap: float
    overlap_volume: float
    kind: str  # "overlap" | "near" | "clear"


@dataclass(frozen=True)
class InterferenceReport:
    """Structured result of an all-pairs interference sweep (detect, do not block)."""

    pairs: tuple[PairResult, ...]
    clearance: float

    @property
    def overlaps(self) -> tuple[PairResult, ...]:
        return tuple(p for p in self.pairs if p.kind == "overlap")

    @property
    def near(self) -> tuple[PairResult, ...]:
        return tuple(p for p in self.pairs if p.kind == "near")

    @property
    def allowed(self) -> tuple[PairResult, ...]:
        """Declared intended-contact pairs, with their MEASURED overlap volume.

        Surfaced (not silently skipped) so an author/reviewer can audit what is
        being whitelisted and how much it overlaps -- a gross declared overlap
        between two structural members is the "glued blocks" smell (lesson L-5).
        """
        return tuple(p for p in self.pairs if p.kind == "allowed")

    def summary(self) -> str:
        if not self.pairs:
            return "no part pairs to check"
        ov, nr = self.overlaps, self.near
        out = [f"{len(self.pairs)} pair(s) checked"]
        if ov:
            out.append(
                "overlap: " + ", ".join(f"{p.a}~{p.b}({p.overlap_volume:.1f}mm^3)" for p in ov)
            )
        if nr:
            out.append(
                f"near(<{self.clearance}mm): "
                + ", ".join(f"{p.a}~{p.b}({p.gap:.3f}mm)" for p in nr)
            )
        allowed_ov = tuple(p for p in self.allowed if p.overlap_volume > 0)
        if allowed_ov:
            out.append(
                "allowed: "
                + ", ".join(f"{p.a}~{p.b}({p.overlap_volume:.1f}mm^3)" for p in allowed_ov)
            )
        if not ov and not nr:
            out.append("no undeclared overlaps, no clearance violations")
        return "; ".join(out)


def _disambiguate(named: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    """Make part names unique so the by-name allow-list cannot over-match.

    Duplicate build123d labels are common (identical fasteners, repeated gears).
    The first occurrence keeps its label; later ones get a ``#n`` suffix, so an
    allow-list entry naming the bare label whitelists only the first instance and
    a second identical instance's unintended overlap is still caught.
    """
    seen: dict[str, int] = {}
    out: list[tuple[str, Any]] = []
    for name, shape in named:
        if name in seen:
            seen[name] += 1
            out.append((f"{name}#{seen[name]}", shape))
        else:
            seen[name] = 0
            out.append((name, shape))
    return out


def _as_named_parts(parts: Any) -> list[tuple[str, Any]]:
    """Normalize the ``parts`` argument to a list of unique ``(name, shape)``.

    Accepts:
    - a sequence of ``(name, shape)`` pairs, or of bare shapes (named by
      ``.label`` or positional index);
    - a build123d assembly Compound -> its labeled ``children`` (a Compound with
      a NON-empty children list);
    - a single build123d shape -> one named part (a bare solid, or a Compound
      with an empty children list such as a boolean-cut result);
    - a ``gen_step`` envelope ``dict`` -> its ``children``/``instances``.

    Duplicate names are disambiguated (see :func:`_disambiguate`).
    """
    if isinstance(parts, dict):  # gen_step envelope payload form
        inner = parts.get("children")
        if inner is None:
            inner = parts.get("instances")
        if inner is None:
            raise TypeError(
                "interference check: dict payload has no 'children' or 'instances'"
            )
        return _as_named_parts(inner)

    if isinstance(parts, (list, tuple)):
        named: list[tuple[str, Any]] = []
        for i, item in enumerate(parts):
            if isinstance(item, (list, tuple)) and len(item) == 2 and not hasattr(item, "wrapped"):
                named.append((str(item[0]), item[1]))
            else:
                named.append((str(getattr(item, "label", None) or f"part{i}"), item))
        return _disambiguate(named)

    children = getattr(parts, "children", None)
    if children:  # a build123d Compound with real children -> an assembly
        named = [
            (str(getattr(ch, "label", None) or f"part{i}"), ch) for i, ch in enumerate(children)
        ]
        return _disambiguate(named)

    # a single shape: a bare solid, or a Compound whose children list is empty
    # (e.g. a boolean-cut result). Validate it as one part rather than skipping.
    return [(str(getattr(parts, "label", None) or "part0"), parts)]


def _normalize_allow(allow: Iterable[Sequence[str]] | None) -> set[frozenset[str]]:
    out: set[frozenset[str]] = set()
    for pair in allow or ():
        items = list(pair)
        if len(items) != 2:
            raise ValueError(f"allow entry must be a (name_a, name_b) pair, got {pair!r}")
        a, b = str(items[0]), str(items[1])
        if a == b:
            raise ValueError(f"allow entry must name two distinct parts, got {pair!r}")
        out.add(frozenset((a, b)))
    return out


def _shape_aabb(shape) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Conservative axis-aligned box (OCC bounding boxes CONTAIN the shape)."""
    bb = shape.bounding_box()
    return ((bb.min.X, bb.min.Y, bb.min.Z), (bb.max.X, bb.max.Y, bb.max.Z))


def _aabb_separation(a, b) -> float:
    """Euclidean separation of two AABBs (0.0 when they intersect/touch).

    Because each box CONTAINS its shape, this is a true LOWER BOUND on the
    exact ``min_gap`` -- a pair whose boxes are separated by more than the
    required clearance cannot overlap nor violate that clearance.
    """
    total = 0.0
    for k in range(3):
        d = max(a[0][k] - b[1][k], b[0][k] - a[1][k])
        if d > 0.0:
            total += d * d
    return math.sqrt(total)


def enumerate_interferences(
    parts: Any,
    *,
    clearance: float = 0.0,
    overlap_tol: float = 1e-3,
    allow: Iterable[Sequence[str]] | None = (),
) -> InterferenceReport:
    """Sweep every unordered part pair and classify it (detect, never raise).

    Cost is O(n^2), but an AABB broad-phase skips the exact kernel queries for
    pairs whose boxes (grown by ``clearance``) are disjoint -- those are
    reported as ``clear`` with the box separation as the gap lower bound. Only
    the surviving candidate pairs pay a distance query (plus a boolean
    intersection per touching pair), so moderate assemblies (tens of parts)
    stay fast; hundreds of parts remain out of scope.

    Parameters
    ----------
    parts:
        Build123d Compound/shape, ``gen_step`` envelope dict, or sequence of
        parts (see :func:`_as_named_parts`).
    clearance:
        Desired minimum gap (mm). Pairs with ``0 < gap < clearance`` (or a
        face-on-face touch when ``clearance > 0``) are flagged ``near``.
    overlap_tol:
        Penetration volume (mm^3) above which a pair is a true ``overlap``
        rather than a coincident-face touch / numeric sliver. This is an
        ABSOLUTE volume, so a very shallow, small-area penetration can fall below
        it; lower it for small features when that matters.
    allow:
        Iterable of ``(name_a, name_b)`` pairs that MAY interpenetrate
        (intended contact: bore/shaft, press fit, gear mesh). Names must match
        the (disambiguated) part names; these pairs are skipped entirely.
    """
    named = _as_named_parts(parts)
    allow_set = _normalize_allow(allow)
    results: list[PairResult] = []
    # Broad-phase: one conservative AABB per part, computed once up front.
    boxes = [_shape_aabb(s) for _, s in named]

    for i in range(len(named)):
        na, sa = named[i]
        for j in range(i + 1, len(named)):
            nb, sb = named[j]
            if frozenset((na, nb)) in allow_set:
                # declared intended contact: still MEASURE it (so its magnitude is
                # reviewable -- a gross declared overlap is the glued-block smell),
                # but classify as "allowed" so it never blocks.
                gap = min_gap(sa, sb)
                ov = overlap_volume(sa, sb) if gap <= _TOUCH_EPS else 0.0
                results.append(PairResult(na, nb, gap, ov, "allowed"))
                continue

            # Broad-phase skip: box separation is a lower bound on the exact
            # gap, so beyond the clearance the verdict can only be "clear".
            # The pair is still REPORTED (pair enumeration stays complete);
            # its gap is the box separation, an honest lower bound.
            sep = _aabb_separation(boxes[i], boxes[j])
            if sep > clearance and sep > _TOUCH_EPS:
                results.append(PairResult(na, nb, sep, 0.0, "clear"))
                continue

            gap = min_gap(sa, sb)
            ov = 0.0
            if gap <= _TOUCH_EPS:
                ov = overlap_volume(sa, sb)
                if ov > overlap_tol:
                    kind = "overlap"
                elif clearance > 0:
                    kind = "near"  # touching faces, but a positive gap was required
                else:
                    kind = "clear"  # coincident faces are acceptable by default
            elif clearance > 0 and gap < clearance:
                kind = "near"
            else:
                kind = "clear"
            results.append(PairResult(na, nb, gap, ov, kind))

    return InterferenceReport(tuple(results), clearance)


def assert_no_interference(
    parts: Any,
    *,
    clearance: float = 0.0,
    allow: Iterable[Sequence[str]] | None = (),
    overlap_tol: float = 1e-3,
    block_near: bool = False,
) -> InterferenceReport:
    """Acceptance gate: raise ``AssertionError`` on undeclared interference.

    Fails on any ``overlap`` pair not listed in ``allow``. ``near`` pairs
    (clearance shortfalls) are reported but do not block unless
    ``block_near=True``. Returns the full :class:`InterferenceReport` on success
    so callers can log near-misses.
    """
    report = enumerate_interferences(
        parts, clearance=clearance, overlap_tol=overlap_tol, allow=allow
    )
    bad = list(report.overlaps)
    if block_near:
        bad += list(report.near)
    if bad:
        lines = "; ".join(
            f"{p.a}~{p.b}(gap={p.gap:.3f}mm, overlap={p.overlap_volume:.2f}mm^3)" for p in bad
        )
        raise AssertionError(f"interference: {len(bad)} undeclared pair(s): {lines}")
    return report


# ---------------------------------------------------------------------------
# Motion sweep (static pose -> whole travel)
# ---------------------------------------------------------------------------
# A static assembly passing :func:`assert_no_interference` says nothing about its
# MOTION: a mechanism can be clear when seated yet drive a part through another
# mid-travel (the deepest overlap is usually mid-stroke, not at an endpoint).
# These sweep a sequence of POSED assemblies and flag, per tracked pair, the
# frames whose overlap EXCEEDS the pair's intended constant contact -- so a grip
# or a press foot that legitimately touches all along is not mistaken for a clash
# (declare it via ``baseline``), while a true mid-motion penetration is caught.


@dataclass(frozen=True)
class SweepHit:
    """One (frame, pair) whose overlap exceeded the pair's allowed baseline."""

    where: Any            # the frame label (e.g. an install fraction or index)
    a: str
    b: str
    overlap: float        # mm^3 at this frame
    excess: float         # mm^3 above the pair's baseline contact


def _name_map(parts: Any) -> dict[str, Any]:
    """A {name: shape} map from a sweep frame: a dict (returned as-is), a
    sequence of ``(name, shape)``, or a labeled Compound's children."""
    if isinstance(parts, dict):
        return dict(parts)
    if isinstance(parts, (list, tuple)):
        return {str(n): s for n, s in parts}
    children = getattr(parts, "children", None)
    if children:
        return {str(getattr(ch, "label", None) or f"part{i}"): ch for i, ch in enumerate(children)}
    raise TypeError("sweep frame must be a {name: shape} dict, a sequence of (name, shape), or a labeled Compound")


def _pair_volume(parts_map: dict[str, Any], a: str, b: str, overlap_tol: float) -> float:
    """Penetration volume (mm^3) of a pair in one posed frame; a cheap distance
    pre-check skips the boolean for separated parts."""
    gap = min_gap(parts_map[a], parts_map[b])
    if gap > _TOUCH_EPS:
        return 0.0
    ov = overlap_volume(parts_map[a], parts_map[b])
    return ov if ov > overlap_tol else 0.0


def _resolve_baseline(baseline, pairs, overlap_tol):
    out: dict[frozenset, float] = {}
    if baseline is None:
        return {frozenset(p): 0.0 for p in pairs}
    if isinstance(baseline, dict):
        for p in pairs:
            out[frozenset(p)] = float(baseline.get(tuple(p), baseline.get((p[1], p[0]), 0.0)))
        return out
    ref = _name_map(baseline)  # a reference pose -> its pair overlaps are allowed
    for a, b in pairs:
        out[frozenset((a, b))] = _pair_volume(ref, a, b, overlap_tol)
    return out


def _resolve_tol(tol, pairs):
    if isinstance(tol, dict):
        default = float(tol.get(None, 0.05))
        return {frozenset(p): float(tol.get(tuple(p), tol.get((p[1], p[0]), default))) for p in pairs}
    return {frozenset(p): float(tol) for p in pairs}


def sweep_interference(
    poses: Iterable[tuple[Any, Any]],
    pairs: Iterable[Sequence[str]],
    *,
    baseline: Any = None,
    tol: Any = 0.05,
    overlap_tol: float = 1e-3,
) -> list[SweepHit]:
    """Sweep posed assemblies; return the (frame, pair) penetrations beyond
    baseline, worst-excess first (empty when clean).

    Parameters
    ----------
    poses:
        Iterable of ``(where, parts)``. ``where`` labels the frame (an install
        fraction, an index, ...); ``parts`` is a ``{name: shape}`` dict, a
        sequence of ``(name, shape)``, or a labeled Compound (see
        :func:`_name_map`). Consumed once, so a generator is fine.
    pairs:
        ``(name_a, name_b)`` pairs to track over the motion.
    baseline:
        Allowed constant overlap per pair: ``None`` (all 0), a ``{(a, b): mm^3}``
        dict, or a single reference ``parts`` pose (e.g. the seated pose) whose
        pair overlaps become the baselines -- so an intended steady contact (grip,
        press foot) rides along without being flagged; only overlap ABOVE it
        counts. Pair order is ignored.
    tol:
        Excess (mm^3) above which a frame is a hit: a float (uniform) or a
        ``{(a, b): float}`` dict (per pair, with key ``None`` as the fallback).

    Cost is O(pairs x frames) exact kernel queries; intended for the small
    assemblies and modest sample counts this skill produces.
    """
    pairs = [tuple(p) for p in pairs]
    base = _resolve_baseline(baseline, pairs, overlap_tol)
    tols = _resolve_tol(tol, pairs)
    hits: list[SweepHit] = []
    for where, parts in poses:
        pmap = _name_map(parts)
        for a, b in pairs:
            key = frozenset((a, b))
            ov = _pair_volume(pmap, a, b, overlap_tol)
            excess = ov - base[key]
            if excess > tols[key]:
                hits.append(SweepHit(where, a, b, ov, excess))
    hits.sort(key=lambda h: h.excess, reverse=True)
    return hits


def assert_motion_clear(
    poses: Iterable[tuple[Any, Any]],
    pairs: Iterable[Sequence[str]],
    *,
    baseline: Any = None,
    tol: Any = 0.05,
    overlap_tol: float = 1e-3,
    label: str = "motion sweep",
) -> None:
    """Acceptance gate over a MOTION: raise ``AssertionError`` if any tracked pair
    penetrates beyond its baseline anywhere along ``poses``.

    The static :func:`assert_no_interference` checks one pose; this extends it to
    the whole travel, where the deepest overlap usually is. Use it inside a
    generator's ``check_geometry`` after the static checks, driving ``poses`` from
    the same kinematics the animation sidecar uses, so a STEP is refused unless
    the motion is penetration-free too.
    """
    hits = sweep_interference(poses, pairs, baseline=baseline, tol=tol, overlap_tol=overlap_tol)
    if hits:
        worst = hits[0]
        lines = "; ".join(f"{h.a}~{h.b}(+{h.excess:.2f}mm^3 @ {h.where})" for h in hits[:4])
        raise AssertionError(
            f"{label}: {len(hits)} pair-frame penetration(s) beyond baseline; "
            f"worst {worst.a}~{worst.b} +{worst.excess:.2f}mm^3 at {worst.where} ({lines})"
        )
