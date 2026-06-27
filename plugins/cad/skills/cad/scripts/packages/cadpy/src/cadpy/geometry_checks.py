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
- declared intended-contact pair (in ``allow``)                        -> skipped

So ``assert_no_interference`` fails only on *undeclared* volume overlap; the
author declares the intended contacts exactly as they would reason about them.

Naming: parts are named by their build123d label (or position). Duplicate
labels are common (identical fasteners, repeated gears), so they are
disambiguated with a ``#n`` suffix -- otherwise a single allow-list entry would
silently whitelist every same-named pair. Declare an intended contact against
the name shown in :class:`InterferenceReport` / the failure message.
"""

from __future__ import annotations

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
        if not ov and not nr:
            out.append("no overlaps, no clearance violations")
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


def enumerate_interferences(
    parts: Any,
    *,
    clearance: float = 0.0,
    overlap_tol: float = 1e-3,
    allow: Iterable[Sequence[str]] | None = (),
) -> InterferenceReport:
    """Sweep every unordered part pair and classify it (detect, never raise).

    Cost is O(n^2) exact kernel queries (a distance per pair, plus a boolean
    intersection per touching pair) with no broad-phase, so it is intended for
    the small-to-moderate assemblies this skill produces, not hundreds of parts.

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

    for i in range(len(named)):
        na, sa = named[i]
        for j in range(i + 1, len(named)):
            nb, sb = named[j]
            if frozenset((na, nb)) in allow_set:
                continue  # declared intended contact

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
