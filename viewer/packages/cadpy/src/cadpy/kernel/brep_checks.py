"""Named diagnostics for an invalid solid: which shell, face or wire is at fault, and how.

``BRepCheck_Analyzer.IsValid()`` answers yes or no. To repair a model one needs
the next question answered -- is a shell open, do a face's wires cross, is a wire
unclosed -- and on which face. OCP does not bind the analyzer's status lists, so
this asks each per-type checker its scalar questions instead and keeps the faults
it can name.

A shape can be invalid with nothing named here: edges and vertices have no
checker of their own (the shell or face they belong to reports the fault), and
some defects are only visible to the analyzer as a whole. ``diagnose`` returning
an empty list therefore does NOT mean the shape is valid; callers ask
``geometry_checks.is_valid_solid`` for that.

``probed_statuses`` is ported from earthtojake/text-to-cad (MIT License,
Copyright (c) 2026 Thompson Labs LLC), ``packages/cad/src/cad/engine/kernel/checks.py``
@ 2738524be. ``diagnose`` and ``summarize`` are this fork's.
"""

from __future__ import annotations

from typing import Any

__all__ = ["diagnose", "probed_statuses", "summarize"]


def probed_statuses(entity, face=None) -> list:
    """The ``BRepCheck_Status`` values the per-type checkers report for one entity.

    Each checker answers one question with one status -- is the shell closed, are
    the face's wires oriented, do they intersect -- so the faults it can name are
    fewer than a result's status list, but every one of them is named exactly.
    Edges and vertices have no such question: the analyzer still says they are
    invalid, and the shell or face they belong to reports the fault."""
    from OCP.BRepCheck import (
        BRepCheck_Face,
        BRepCheck_NoError,
        BRepCheck_Shell,
        BRepCheck_UnorientableShape,
        BRepCheck_Wire,
    )
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_WIRE
    from OCP.TopoDS import TopoDS, TopoDS_Edge

    kind = entity.ShapeType()
    statuses = []
    if kind == TopAbs_SHELL:
        checker = BRepCheck_Shell(TopoDS.Shell(entity))
        statuses += [checker.Closed(False), checker.Orientation(False)]
        if checker.IsUnorientable():
            statuses.append(BRepCheck_UnorientableShape)
    elif kind == TopAbs_FACE:
        checker = BRepCheck_Face(TopoDS.Face(entity))
        statuses += [checker.IntersectWires(False), checker.ClassifyWires(False), checker.OrientationOfWires(False)]
        if checker.IsUnorientable():
            statuses.append(BRepCheck_UnorientableShape)
    elif kind == TopAbs_WIRE:
        checker = BRepCheck_Wire(TopoDS.Wire(entity))
        if face is not None:
            statuses.append(checker.SelfIntersect(TopoDS.Face(face), TopoDS_Edge(), TopoDS_Edge(), False))
        statuses.append(checker.Closed(False))
    return [status for status in statuses if status != BRepCheck_NoError]


def _names(statuses: list) -> list[str]:
    """Status names without the ``BRepCheck_`` prefix, each once, in first-seen order."""
    seen: list[str] = []
    for status in statuses:
        name = str(getattr(status, "name", status)).removeprefix("BRepCheck_")
        if name not in seen:
            seen.append(name)
    return seen


def diagnose(shape: Any) -> list[dict[str, Any]]:
    """Every shell, face and wire of ``shape`` with a nameable fault.

    Each finding is ``{"kind": "shell" | "face" | "wire", "index": n, "faults": [...]}``;
    a wire's finding also carries ``"face"``. Indices are 1-based and match the
    face ordinals of the part's STEP topology (``TopExp.MapShapes`` order), so a
    finding on face 12 is the face a pick token calls ``f12``. A wire's index
    counts within its face.

    Accepts a build123d shape or a raw ``TopoDS_Shape``. Never raises: a checker
    that fails on an entity is skipped (the analyzer's verdict still stands).
    """
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_WIRE
    from OCP.TopExp import TopExp, TopExp_Explorer

    from cadpy.kernel.ocp_compat import IndexedMapOfShape

    topo = getattr(shape, "wrapped", shape)
    if topo is None or topo.IsNull():
        return []
    findings: list[dict[str, Any]] = []

    def mapped(kind):
        index = IndexedMapOfShape()
        TopExp.MapShapes_s(topo, kind, index)
        return [index.FindKey(i) for i in range(1, index.Extent() + 1)]

    for number, shell in enumerate(mapped(TopAbs_SHELL), 1):
        try:
            faults = _names(probed_statuses(shell))
        except Exception:  # noqa: BLE001 - a diagnostic must not turn into a second failure
            continue
        if faults:
            findings.append({"kind": "shell", "index": number, "faults": faults})

    for number, face in enumerate(mapped(TopAbs_FACE), 1):
        try:
            faults = _names(probed_statuses(face))
        except Exception:  # noqa: BLE001
            faults = []
        if faults:
            findings.append({"kind": "face", "index": number, "faults": faults})
        explorer = TopExp_Explorer(face, TopAbs_WIRE)
        wire_number = 0
        while explorer.More():
            wire_number += 1
            try:
                wire_faults = _names(probed_statuses(explorer.Current(), face=face))
            except Exception:  # noqa: BLE001
                wire_faults = []
            if wire_faults:
                findings.append({"kind": "wire", "index": wire_number, "face": number, "faults": wire_faults})
            explorer.Next()
    return findings


def summarize(findings: list[dict[str, Any]], *, limit: int = 3) -> str:
    """One line for a check note: ``shell 1: NotClosed; face 12 wire 2: SelfIntersectingWire``.

    At most ``limit`` findings are spelled out; the rest are counted. Empty for no findings."""
    parts = []
    for finding in findings[:limit]:
        where = (
            f"face {finding['face']} wire {finding['index']}"
            if finding["kind"] == "wire"
            else f"{finding['kind']} {finding['index']}"
        )
        parts.append(f"{where}: {', '.join(finding['faults'])}")
    if len(findings) > limit:
        parts.append(f"+{len(findings) - limit} more")
    return "; ".join(parts)
