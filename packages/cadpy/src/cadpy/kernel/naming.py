"""Stable names for the faces and edges of a build, and the source line that made each.

A selection token (``#o1.2.f7``) is positional: the seventh face of that part. Change a
parameter that adds a hole and the seventh face is a different face. This module names
each face and edge by *where it came from* instead, so the name survives a rebuild as
long as the element's construction does.

How: while a generator runs (``recording``), the OCCT makers build123d constructs are
patched to note the shapes they were given and the shape they handed back. Afterwards
(``name_parts``) every element is followed through those makers in the order their
results were taken: an element a maker still holds is itself; one it reports as modified
or generated takes the origins of the element it was reported for. An element nothing
reported is a *root* and is identified by the maker that first produced or consumed it,
its kind and its ordinal there. An element's name is a digest of its set of root origins.

A maker is identified by the source line that ran it -- the innermost frame outside
installed packages -- as ``(function, line text with numbers blanked, maker class)`` plus
how many times that same key has occurred so far. Line *numbers* are not part of it, so
editing elsewhere in the file renames nothing, and changing a numeric literal on the line
keeps the name. The line number is kept beside the name only as "made by" information for
the current build.

The maker table and the per-maker reporting rules (``Modified``/``Generated``, a sweep's
``FirstShape``/``LastShape``, a clean's or a fix's ``History``, a sewing, a copy, a wire's
merged-vertex edges) are adapted from text-to-cad's ``cad/engine/kernel/history.py``
(MIT License, Copyright (c) earthtojake). The composition here is different: upstream
composes per traced feature with the feature's inputs given; this composes one whole
build and discovers the roots.

Works on OCP 7.9 and OCP 8. Every failure degrades to "no names": naming is never a
reason for a build to fail.
"""

from __future__ import annotations

import functools
import hashlib
import importlib
import itertools
import linecache
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
from OCP.TopExp import TopExp
from OCP.TopoDS import TopoDS_Shape

try:  # OCP 8
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as _IndexedMap
    from OCP.collections import List_TopoDS_Shape as _ShapeList
except ImportError:  # OCP 7.9
    from OCP.TopTools import TopTools_IndexedMapOfShape as _IndexedMap
    from OCP.TopTools import TopTools_ListOfShape as _ShapeList

__all__ = ["ensure_installed", "install", "installed", "name_parts", "recording", "recording_active",
           "replay", "scope", "uninstall"]

ENV_SWITCH = "CADPY_NAMING"
NAMES_SCHEMA_VERSION = 1
NAME_LENGTH = 10
MAX_ELEMENTS = 40_000        # faces + edges over all parts; beyond this no names are written
# Makers in one build; beyond this no names are written. Naming costs roughly 1.5-2 ms per
# maker, so this caps what it adds to a build at about two seconds. (The cable templates
# run 1,400-1,900 makers and would pay 3-4 s on a 10-12 s build, on every slider move.)
MAX_RECORDS = 1200
DEFAULT_BUDGET_S = 5.0

KINDS = (TopAbs_VERTEX, TopAbs_EDGE, TopAbs_FACE)
_KIND = {TopAbs_VERTEX: 0, TopAbs_EDGE: 1, TopAbs_FACE: 2}
_KIND_CODE = ("v", "e", "f")
SAME, MODIFIED, GENERATED = "I", "M", "G"
_STRENGTH = {SAME: 0, MODIFIED: 1, GENERATED: 2}

_LOCAL = threading.local()
_ORDER = itertools.count(1)
_object_key = object.__hash__
_installed = False
_PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + os.sep
_STDLIB_DIR = os.path.dirname(os.path.abspath(os.__file__)) + os.sep
# A numeric literal: digits not inside an identifier or another number (``part10`` keeps
# its 10, so ``part10 = ...`` and ``part11 = ...`` stay different lines).
_NUMBER_RE = re.compile(r"(?<![\w.])\d+(?:\.\d*)?(?:[eE][-+]?\d+)?")


_TOO_LARGE: dict[str, int] = {}   # generator file -> record count that ran out of time


class _OutOfTime(Exception):
    pass


# --- recording ----------------------------------------------------------------------------


class _Record:
    """One maker the build ran: what it was given, what it handed back, and where from."""

    __slots__ = ("maker", "adapter", "inputs", "result", "order", "site", "scope")

    def __init__(self, maker: Any, adapter: "_Adapter", site: tuple | None) -> None:
        self.maker = maker
        self.adapter = adapter
        self.inputs: list[Any] = []
        self.result: Any = None
        self.order = 0
        self.site = site
        # (scope key, which run of that scope in this build, position in the run) for a
        # maker run inside a naming scope; None for one run by the generator directly.
        self.scope: tuple[str, int, int] | None = None


def _user_site() -> tuple[str, int, str] | None:
    """The innermost frame that is neither this package nor an installed one."""
    frame = sys._getframe(3)
    while frame is not None:
        filename = frame.f_code.co_filename
        if not filename.startswith("<"):
            path = os.path.abspath(filename)
            if (not path.startswith(_PACKAGE_DIR) and not path.startswith(_STDLIB_DIR)
                    and "site-packages" not in path and "dist-packages" not in path):
                return (path, int(frame.f_lineno), frame.f_code.co_name)
        frame = frame.f_back
    return None


class recording:
    """Record the makers run on this thread until the block ends. Yields the list
    ``name_parts`` takes; the list keeps the makers alive, and is gone with the build."""

    __slots__ = ("_previous",)

    def __enter__(self) -> list[_Record]:
        self._previous = (getattr(_LOCAL, "records", None), getattr(_LOCAL, "index", None),
                          getattr(_LOCAL, "scope", None), getattr(_LOCAL, "scope_runs", None))
        records: list[_Record] = []
        _LOCAL.records, _LOCAL.index = records, {}
        _LOCAL.scope, _LOCAL.scope_runs = None, {}
        # A maker is identified by the text of the line that ran it, read through
        # linecache -- which, in a long-lived worker, still holds the file as it was on
        # the previous build unless told to look again.
        linecache.checkcache()
        return records

    def __exit__(self, *exc_info: object) -> None:
        _LOCAL.records, _LOCAL.index, _LOCAL.scope, _LOCAL.scope_runs = self._previous


def recording_active() -> bool:
    return getattr(_LOCAL, "records", None) is not None


class scope:
    """Makers run inside the block are identified by ``key`` and their position in the
    block, not by where in the build the block happens to run. Yields the records made
    in the block (an empty list outside a recording). For a pure part generator: its
    elements are then named the same wherever, and however many times, it is called."""

    __slots__ = ("key", "_previous", "_start", "_made")

    def __init__(self, key: str) -> None:
        self.key = key

    def __enter__(self) -> list[_Record]:
        self._made: list[_Record] = []
        records = getattr(_LOCAL, "records", None)
        self._previous = getattr(_LOCAL, "scope", None)
        if records is None:
            self._start = None
            return self._made
        runs = _LOCAL.scope_runs
        run = runs[self.key] = runs.get(self.key, 0) + 1
        _LOCAL.scope = [self.key, run, 0]
        self._start = len(records)
        return self._made

    def __exit__(self, *exc_info: object) -> None:
        if self._start is not None:
            self._made.extend(_LOCAL.records[self._start:])
            _LOCAL.scope = self._previous


def replay(records: list[_Record], key: str) -> None:
    """Add makers recorded in an earlier ``scope`` block to the current recording, as if
    the block had just run again: same makers and shapes, at the line being run now."""
    current = getattr(_LOCAL, "records", None)
    if current is None or not records:
        return
    try:
        site = _user_site()
    except Exception:  # noqa: BLE001
        site = None
    runs = _LOCAL.scope_runs
    renumbered: dict[tuple[str, int], int] = {}
    clones = []
    for record in records:
        clone = _Record(record.maker, record.adapter, site)
        clone.inputs, clone.result = record.inputs, record.result
        if record.scope is not None:
            was = (record.scope[0], record.scope[1])
            run = renumbered.get(was)
            if run is None:
                run = renumbered[was] = runs[was[0]] = runs.get(was[0], 0) + 1
            clone.scope = (was[0], run, record.scope[2])
        clones.append((record.order, clone))
    for _order, clone in sorted((pair for pair in clones if pair[0]), key=lambda pair: pair[0]):
        clone.order = next(_ORDER)
    current.extend(clone for _order, clone in clones)


def _record(maker: Any, adapter: "_Adapter") -> _Record | None:
    records = getattr(_LOCAL, "records", None)
    if records is None:
        return None
    index = _LOCAL.index
    record = index.get(_object_key(maker))
    if record is None or record.maker is not maker:
        try:
            site = _user_site()
        except Exception:  # noqa: BLE001
            site = None
        record = index[_object_key(maker)] = _Record(maker, adapter, site)
        scoped = getattr(_LOCAL, "scope", None)
        if scoped is not None:
            record.scope = (scoped[0], scoped[1], scoped[2])
            scoped[2] += 1
        records.append(record)
    return record


def _note_inputs(record: _Record, values: Any) -> None:
    for value in values:
        if isinstance(value, TopoDS_Shape):
            if not value.IsNull():
                record.inputs.append(value.Located(value.Location()))
        elif isinstance(value, _ShapeList):
            record.inputs.extend(listed(value))
        elif type(value).__name__.startswith("TopTools_") and hasattr(value, "Length") and hasattr(value, "Value"):
            for index in range(1, value.Length() + 1):
                shape = value.Value(index)
                if isinstance(shape, TopoDS_Shape) and not shape.IsNull():
                    record.inputs.append(shape.Located(shape.Location()))


def listed(shapes: Any) -> list[Any]:
    """A shape list's members without iterating it from Python (the exception that ends
    an iteration costs milliseconds): none, its first, its first and last, else a copy
    drained from its head."""
    size = shapes.Size()
    if size < 3:
        return [] if size == 0 else [shapes.First()] if size == 1 else [shapes.First(), shapes.Last()]
    copy = _ShapeList()
    copy.Assign(shapes)
    found = []
    for _member in range(size):
        found.append(copy.First())
        copy.RemoveFirst()
    return found


# --- adapters: how each maker reports -------------------------------------------------------


@dataclass(frozen=True)
class _Adapter:
    """``prepare(maker)`` returns ``query(sub-shape) -> [(shape, how)]`` or None for a
    maker with nothing to report. A ``generator`` makes new elements from elements it
    keeps (a prism's sides from the profile it keeps as its bottom), so every sub-shape
    of its inputs is asked about; any other maker only about those its result dropped.
    A ``primitive`` is given no shapes; its result's elements are roots made at its line."""

    prepare: Callable[[Any], Callable[[Any], list[tuple[Any, str]]] | None]
    generator: bool = False
    primitive: bool = False


def _made(maker: Any) -> Callable[[Any], list[tuple[Any, str]]]:
    def query(sub: Any) -> list[tuple[Any, str]]:
        return ([(shape, MODIFIED) for shape in listed(maker.Modified(sub))]
                + [(shape, GENERATED) for shape in listed(maker.Generated(sub))])
    return query


def _swept(maker: Any) -> Callable[[Any], list[tuple[Any, str]]]:
    made = _made(maker)

    def query(sub: Any) -> list[tuple[Any, str]]:
        found = made(sub)
        first, last = maker.FirstShape(sub), maker.LastShape(sub)
        if not first.IsNull() and not first.IsSame(sub):
            found.append((first, SAME))
        if not last.IsNull() and not last.IsSame(sub) and (first.IsNull() or not last.IsSame(first)):
            found.append((last, GENERATED))
        return found
    return query


def _from_history(history: Any) -> Callable[[Any], list[tuple[Any, str]]] | None:
    if history is None or not (history.HasModified() or history.HasGenerated()):
        return None

    def query(sub: Any) -> list[tuple[Any, str]]:
        return ([(shape, MODIFIED) for shape in listed(history.Modified(sub))]
                + [(shape, GENERATED) for shape in listed(history.Generated(sub))])
    return query


def _recorded(maker: Any) -> Callable[[Any], list[tuple[Any, str]]] | None:
    return _from_history(maker.History())


def _fixed(maker: Any) -> Callable[[Any], list[tuple[Any, str]]] | None:
    context = maker.Context()
    return None if context is None else _from_history(context.History())


def _sewn(maker: Any) -> Callable[[Any], list[tuple[Any, str]]]:
    def query(sub: Any) -> list[tuple[Any, str]]:
        if maker.IsModified(sub):
            shape = maker.Modified(sub)
        elif maker.IsModifiedSubShape(sub):
            shape = maker.ModifiedSubShape(sub)
        else:
            return []
        return [] if shape.IsNull() or shape.IsSame(sub) else [(shape, MODIFIED)]
    return query


def _copied(maker: Any) -> Callable[[Any], list[tuple[Any, str]]]:
    def query(sub: Any) -> list[tuple[Any, str]]:
        return [(shape, SAME) for shape in listed(maker.Modified(sub))]
    return query


def _transformed(maker: Any) -> Callable[[Any], list[tuple[Any, str]]]:
    def query(sub: Any) -> list[tuple[Any, str]]:
        return [(shape, MODIFIED) for shape in listed(maker.Modified(sub))]
    return query


def _tapered(maker: Any) -> Callable[[Any], list[tuple[Any, str]]]:
    def query(sub: Any) -> list[tuple[Any, str]]:
        return [(shape, GENERATED) for shape in listed(maker.Shapes(sub))]
    return query


_MAKER = _Adapter(_made)
_GENERATOR = _Adapter(_made, generator=True)
_COPY = _Adapter(_copied)
_WIRE = _Adapter(lambda maker: None)  # composed by its own rule (_wire_copies)
_PRIMITIVE = _Adapter(lambda maker: None, primitive=True)

# (module, class, adapter). A class this OCP does not have is skipped.
_ADAPTERS = (
    ("OCP.BRepAlgoAPI", "BRepAlgoAPI_Cut", _MAKER),
    ("OCP.BRepAlgoAPI", "BRepAlgoAPI_Fuse", _MAKER),
    ("OCP.BRepAlgoAPI", "BRepAlgoAPI_Common", _MAKER),
    ("OCP.BRepAlgoAPI", "BRepAlgoAPI_Section", _MAKER),
    ("OCP.BRepAlgoAPI", "BRepAlgoAPI_Splitter", _MAKER),
    ("OCP.BOPAlgo", "BOPAlgo_Splitter", _MAKER),
    ("OCP.ShapeUpgrade", "ShapeUpgrade_UnifySameDomain", _Adapter(_recorded)),
    ("OCP.BRepTools", "BRepTools_ReShape", _Adapter(_recorded)),
    ("OCP.ShapeFix", "ShapeFix_Shape", _Adapter(_fixed)),
    ("OCP.ShapeFix", "ShapeFix_Face", _Adapter(_fixed)),
    ("OCP.ShapeFix", "ShapeFix_Wire", _Adapter(_fixed)),
    ("OCP.ShapeFix", "ShapeFix_Solid", _Adapter(_fixed)),
    ("OCP.ShapeFix", "ShapeFix_Wireframe", _Adapter(_fixed)),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_Copy", _COPY),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_Transform", _Adapter(_transformed)),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_GTransform", _Adapter(_transformed)),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_Sewing", _Adapter(_sewn)),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_MakeWire", _WIRE),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_MakeFace", _MAKER),
    ("OCP.BRepBuilderAPI", "BRepBuilderAPI_MakeSolid", _MAKER),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakePrism", _Adapter(_swept, generator=True)),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeRevol", _Adapter(_swept, generator=True)),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeHalfSpace", _GENERATOR),
    ("OCP.BRepFilletAPI", "BRepFilletAPI_MakeFillet", _MAKER),
    ("OCP.BRepFilletAPI", "BRepFilletAPI_MakeChamfer", _MAKER),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_ThruSections", _GENERATOR),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_MakePipe", _GENERATOR),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_MakePipeShell", _GENERATOR),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_MakeOffset", _GENERATOR),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_MakeThickSolid", _GENERATOR),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_MakeFilling", _GENERATOR),
    ("OCP.BRepOffsetAPI", "BRepOffsetAPI_DraftAngle", _MAKER),
    ("OCP.BRepOffset", "BRepOffset_MakeOffset", _GENERATOR),
    ("OCP.BRepFeat", "BRepFeat_MakeDPrism", _GENERATOR),
    ("OCP.BRepFeat", "BRepFeat_SplitShape", _MAKER),
    ("OCP.LocOpe", "LocOpe_DPrism", _Adapter(_tapered, generator=True)),
    # Primitives: no shape goes in, so they report nothing -- but their faces are where
    # most names start, and patching them tells which line made them.
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeBox", _PRIMITIVE),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeCylinder", _PRIMITIVE),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeCone", _PRIMITIVE),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeSphere", _PRIMITIVE),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeTorus", _PRIMITIVE),
    ("OCP.BRepPrimAPI", "BRepPrimAPI_MakeWedge", _PRIMITIVE),
)
_SETTERS = ("Add", "AddWire", "AddVertex", "SetArguments", "SetTools", "Init", "Initialize", "Load")
_FINISHERS = ("Shape", "Face", "Edge", "Wire", "Vertex", "Solid", "Shell", "Result", "SewedShape")


def _classes() -> list[tuple[type, _Adapter]]:
    found = []
    for module_name, class_name, adapter in _ADAPTERS:
        try:
            found.append((getattr(importlib.import_module(module_name), class_name), adapter))
        except (ImportError, AttributeError):
            continue
    return found


def installed() -> bool:
    return _installed


def install() -> bool:
    """Patch the makers of ``_ADAPTERS``, once per process. Returns installed-now."""
    global _installed
    if _installed:
        return False
    for cls, adapter in _classes():
        _patch(cls, "__init__", _initializer(cls.__init__, adapter))
        for name in _SETTERS:
            original = cls.__dict__.get(name) or getattr(cls, name, None)
            if original is not None:
                _patch(cls, name, _setter(original, adapter))
        for name in _FINISHERS:
            original = cls.__dict__.get(name) or getattr(cls, name, None)
            if original is not None:
                _patch(cls, name, _finisher(original))
    _installed = True
    return True


def ensure_installed() -> bool:
    """Install unless switched off (``CADPY_NAMING=0``). Returns whether names are on.
    Never raises: a kernel this cannot patch simply has no names."""
    if os.environ.get(ENV_SWITCH, "1").strip().lower() in ("0", "false", "off", "no"):
        return False
    try:
        install()
    except Exception:  # noqa: BLE001
        return False
    return _installed


def uninstall() -> bool:
    global _installed
    if not _installed:
        return False
    for cls, _adapter in _classes():
        for name in ("__init__", *_SETTERS, *_FINISHERS):
            patched = cls.__dict__.get(name)
            if patched is not None and getattr(patched, "__kernel_naming__", False):
                setattr(cls, name, patched.__wrapped__)
    _installed = False
    return True


def _patch(cls: type, name: str, wrapper: Any) -> None:
    current = cls.__dict__.get(name)
    if current is not None and getattr(current, "__kernel_naming__", False):
        return
    setattr(cls, name, wrapper)


def _initializer(original: Any, adapter: _Adapter) -> Any:
    @functools.wraps(original)
    def __init__(self: Any, *args: Any, **kwargs: Any) -> None:
        original(self, *args, **kwargs)
        record = _record(self, adapter)
        if record is not None:
            _note_inputs(record, (*args, *kwargs.values()))

    __init__.__kernel_naming__ = True
    __init__.__wrapped__ = original
    return __init__


def _setter(original: Any, adapter: _Adapter) -> Any:
    @functools.wraps(original)
    def setter(self: Any, *args: Any, **kwargs: Any) -> Any:
        answer = original(self, *args, **kwargs)
        record = _record(self, adapter)
        if record is not None:
            _note_inputs(record, (*args, *kwargs.values()))
        return answer

    setter.__kernel_naming__ = True
    setter.__wrapped__ = original
    return setter


def _finisher(original: Any) -> Any:
    @functools.wraps(original)
    def finisher(self: Any, *args: Any, **kwargs: Any) -> Any:
        answer = original(self, *args, **kwargs)
        index = getattr(_LOCAL, "index", None)
        if index is not None and isinstance(answer, TopoDS_Shape) and not answer.IsNull():
            record = index.get(_object_key(self))
            if record is not None and record.maker is self and record.result is None:
                record.result = answer.Located(answer.Location())
                record.order = next(_ORDER)
        return answer

    finisher.__kernel_naming__ = True
    finisher.__wrapped__ = original
    return finisher


# --- composition ----------------------------------------------------------------------------


def _map(shape: Any, kind: Any) -> Any:
    found = _IndexedMap()
    TopExp.MapShapes_s(shape, kind, found)
    return found


def _then(first: str, second: str) -> str:
    if first == SAME:
        return second
    if second == SAME:
        return first
    return GENERATED if GENERATED in (first, second) else MODIFIED


def _merge(by_source: dict, source: tuple, how: str, place: tuple[int, ...]) -> None:
    """One origin per source element: the stronger account where a source arrives twice
    (generated over modified over copied), and its first place."""
    known = by_source.get(source)
    by_source[source] = (how, place) if known is None else (
        how if _STRENGTH[how] > _STRENGTH[known[0]] else known[0], min(place, known[1]))


def _site_key(site: tuple | None, cache: dict) -> str:
    """A maker's identity from its source line: function, the line's text with numeric
    literals blanked, never the line number."""
    if site is None:
        return "?"
    known = cache.get(site)
    if known is None:
        path, line, func = site
        text = _NUMBER_RE.sub("#", " ".join(linecache.getline(path, line).split()))
        known = cache[site] = f"{func}|{text}"
    return known


def _no_placement() -> Any:
    from OCP.TopLoc import TopLoc_Location

    return TopLoc_Location()


_NO_PLACEMENT = _no_placement()


class _Composer:
    def __init__(self, deadline: float | None) -> None:
        self.deadline = deadline
        self.reported = _IndexedMap()   # every element that has origins or is a root
        self.origins: list[dict] = []   # by index in `reported`: {(root, kind, ordinal): (how, place)}
        self.sites: list[tuple | None] = []  # by index: the line that made it, if known
        # The same elements with their placement stripped -> the line that made them. A part
        # placed after it was made (``Pos(...) * Box(...)``) reaches the next maker as other
        # shapes, as far as a shape map can tell; it is still the box that line made.
        self.unplaced = _IndexedMap()
        self.unplaced_sites: list[tuple | None] = []
        self.unplaced_slots: list[int] = []
        # Element maps of whole shapes, kept: a maker's result is the next maker's input,
        # and mapping it again for every maker made a run of N cuts on one body cost N^2.
        self.mapped = _IndexedMap()
        self.maps_of: list[list] = []
        self.rooted = _IndexedMap()          # whole shapes whose elements are all known already
        self.asked = 0

    def maps(self, shape: Any) -> list:
        index = self.mapped.Add(shape)
        if index > len(self.maps_of):
            self.maps_of.append([_map(shape, topabs) for topabs in KINDS])
        return self.maps_of[index - 1]

    def tick(self) -> None:
        self.asked += 1
        if self.deadline is not None and self.asked % 256 == 1 and time.monotonic() > self.deadline:
            raise _OutOfTime()

    def slot(self, shape: Any) -> int | None:
        index = self.reported.FindIndex(shape)
        return index - 1 if index else None

    def placed_slot(self, shape: Any) -> int | None:
        """``slot``, else that of the same element at another placement: a finished part
        is usually placed after the last maker ran, and is still what that maker made."""
        index = self.reported.FindIndex(shape)
        if index:
            return index - 1
        bare = self.unplaced.FindIndex(shape.Located(_NO_PLACEMENT))
        return self.unplaced_slots[bare - 1] if bare else None

    def new(self, shape: Any, site: tuple | None) -> dict:
        index = self.reported.Add(shape)
        if index > len(self.origins):
            bare = self.unplaced.Add(shape.Located(_NO_PLACEMENT))
            if bare > len(self.unplaced_sites):
                self.unplaced_sites.append(site)
                self.unplaced_slots.append(index - 1)
            elif site is None:
                site = self.unplaced_sites[bare - 1]
            elif self.unplaced_sites[bare - 1] is None:
                self.unplaced_sites[bare - 1] = site
            self.origins.append({})
            self.sites.append(site)
        return self.origins[index - 1]

    def root(self, shape: Any, key: str, kind: int, ordinal: int, site: tuple | None) -> None:
        """Make ``shape`` a root unless it is already known.

        A body placed after it was made (``Pos(...) * tooth``) reaches the maker that
        consumes it as shapes no map has seen. They are rooted here, at that maker and by
        the position it was given them in -- not traced back to the unplaced body. Tracing
        back would give every placement of one body the same origins, and a pattern (one
        tooth placed forty times and fused) would be forty faces with one name, which is
        no name; the consumer and position tell them apart, deterministically. Only the
        line that made the body is carried over (``new`` looks it up)."""
        if self.reported.Contains(shape):
            return
        self.new(shape, site)[(key, kind, ordinal)] = (SAME, ())

    def roots_of(self, shape: Any, key: str, site: tuple | None) -> None:
        if self.rooted.Contains(shape):
            return
        self.rooted.Add(shape)
        for kind, subs in enumerate(self.maps(shape)):
            for ordinal in range(1, subs.Extent() + 1):
                self.root(subs.FindKey(ordinal), key, kind, ordinal, site)

    def derive(self, made: Any, found: dict, how: str, at: int, site: tuple | None,
               source_site: tuple | None = None) -> None:
        """``made`` comes from the element whose origins are ``found``. The line that made
        it: this maker's where it was generated here; where it is an existing element
        carried along (modified, copied), the line that made that element."""
        if how != GENERATED and source_site is not None:
            site = source_site
        at_slot = self.slot(made)
        merged = self.new(made, site) if at_slot is None else self.origins[at_slot]
        if at_slot is not None and self.sites[at_slot] is None:
            self.sites[at_slot] = site
        for source, (was, place) in found.items():
            _merge(merged, source, _then(was, how), (*place, at))

    def run(self, records: list[_Record]) -> None:
        taken = sorted((r for r in records if r.result is not None), key=lambda r: r.order)
        seen: dict[str, int] = {}
        site_cache: dict = {}
        for record in taken:
            if self.deadline is not None and time.monotonic() > self.deadline:
                raise _OutOfTime()
            if record.scope is not None:
                # Inside a naming scope: the scope and the position in it.
                # Not which run: two calls with the same arguments build the same part, and a
                # part handed back from a cache is the very shapes of the first call -- with the
                # run in the key, a reused part and a rebuilt one would be named differently.
                base, nth = f"scope:{record.scope[0]}|{type(record.maker).__name__}", record.scope[2]
            else:
                base = f"{_site_key(record.site, site_cache)}|{type(record.maker).__name__}"
                nth = seen[base] = seen.get(base, 0) + 1
            key = hashlib.sha1(f"{base}|{nth}".encode("utf-8")).hexdigest()[:12]
            if not record.adapter.primitive:
                # What it was given and nobody made: roots, known by this maker.
                for position, shape in enumerate(record.inputs):
                    self.roots_of(shape, f"{key}/{position}", None)
                if record.adapter is _WIRE:
                    self.wire(record)
                else:
                    self.ask(record)
            # What it handed back that nothing accounts for: roots made here.
            self.roots_of(record.result, f"{key}/out", record.site)

    def ask(self, record: _Record) -> None:
        try:
            query = record.adapter.prepare(record.maker)
        except Exception:  # noqa: BLE001 - a maker that cannot say what it did reports nothing
            query = None
        if query is None:
            return
        held = None if record.adapter.generator else self.maps(record.result)
        for shape in record.inputs:
            for kind, subs in enumerate(self.maps(shape)):
                for ordinal in range(1, subs.Extent() + 1):
                    sub = subs.FindKey(ordinal)
                    if held is not None and held[kind].Contains(sub):
                        continue
                    at_slot = self.slot(sub)
                    if at_slot is None:
                        continue
                    self.tick()
                    try:
                        answers = query(sub)
                    except Exception:  # noqa: BLE001 - asked about a shape it never saw
                        continue
                    found = dict(self.origins[at_slot])
                    for at, (made, how) in enumerate(answers, 1):
                        if made.ShapeType() not in _KIND or made.IsSame(sub):
                            continue
                        self.derive(made, found, how, at, record.site, self.sites[at_slot])

    def wire(self, record: _Record) -> None:
        """``BRepBuilderAPI_MakeWire`` reports nothing, and copies each edge whose vertices
        it merges with a neighbour's: an edge of the wire that is no edge it was given, on
        the same curve object over the same parameters as one it was, is that edge copied."""
        from OCP.BRep import BRep_Tool
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS

        edge_of = getattr(TopoDS, "Edge_s", None) or TopoDS.Edge
        alive: list = []

        def signature(edge: Any) -> tuple | None:
            location = TopLoc_Location()
            cast = edge_of(edge)
            curve = BRep_Tool.Curve_s(cast, location, 0.0, 0.0)
            if curve is None:
                return None
            alive.append(curve)
            value = location.Transformation().Value
            return (_object_key(curve), BRep_Tool.Range_s(cast),
                    tuple(value(row, column) for row in (1, 2, 3) for column in (1, 2, 3, 4)))

        held = _IndexedMap()
        given: dict[tuple, Any] = {}
        for shape in record.inputs:
            edges = _map(shape, TopAbs_EDGE)
            for ordinal in range(1, edges.Extent() + 1):
                edge = edges.FindKey(ordinal)
                held.Add(edge)
                key = signature(edge)
                if key is not None:
                    given.setdefault(key, edge)
        result = _map(record.result, TopAbs_EDGE)
        for ordinal in range(1, result.Extent() + 1):
            edge = result.FindKey(ordinal)
            if held.Contains(edge):
                continue
            key = signature(edge)
            original = given.get(key) if key is not None else None
            at_slot = self.slot(original) if original is not None else None
            if at_slot is not None:
                self.derive(edge, dict(self.origins[at_slot]), SAME, 1, record.site, self.sites[at_slot])


def _digest(origins: dict, *, exact: bool = False) -> str:
    """An element's name from its origins. The plain name says only *which root elements*
    it came from and whether it was generated from each or is that element carried along
    (copied and modified count the same: a face one more hole is cut through is still that
    face). ``exact`` adds how and where among the maker's answers, which tells apart the
    pieces a split leaves -- used only where the plain name is shared within a part."""
    if exact:
        rows = ["exact"] + sorted(f"{root}:{kind}:{ordinal}:{how}:{'.'.join(map(str, place))}"
                                  for (root, kind, ordinal), (how, place) in origins.items())
    else:
        rows = sorted(f"{root}:{kind}:{ordinal}:{'G' if how == GENERATED else 'K'}"
                      for (root, kind, ordinal), (how, _place) in origins.items())
    return hashlib.sha1("\n".join(rows).encode("utf-8")).hexdigest()[:NAME_LENGTH]


def _wrapped(shape: Any) -> Any:
    inner = getattr(shape, "wrapped", None)
    return inner if isinstance(inner, TopoDS_Shape) else shape


def name_parts(named_parts: list[tuple[str, Any]], records: list[_Record], *,
               budget_s: float | None = DEFAULT_BUDGET_S) -> dict[str, Any] | None:
    """Names for the faces and edges of each part, by ordinal.

    Returns ``{"schemaVersion", "parts": {part: {"f": [...], "e": [...]}}, "lines":
    {part: {"f": [...], "e": [...]}}, "files": [...]}`` -- ``parts`` holds one name per
    element in ``TopExp.MapShapes`` order (``""`` where a name is not unique within the
    part, so it cannot be used to find the element again); ``lines`` holds, per element,
    ``[file index, line]`` of the maker that made it or ``None``. Parts sharing a label
    are left out (a name could not say which). ``None`` when there is nothing to name,
    there are too many elements, or the time budget ran out.
    """
    # A build that ran out of time last time is not tried again while it is at least as
    # large: otherwise every rebuild of a big model would spend the whole budget to learn
    # the same thing. Remembered per generator file, for the life of the process.
    try:
        source = next((record.site[0] for record in records if record.site), None)
        if budget_s is not None and source is not None and len(records) >= _TOO_LARGE.get(source, 1 << 62):
            return None
        try:
            names = _name_parts(named_parts, records, budget_s)
        except _OutOfTime:
            if source is not None:
                _TOO_LARGE[source] = len(records)
            return None
        if source is not None:
            _TOO_LARGE.pop(source, None)
        return names
    except Exception:  # noqa: BLE001 - naming never fails a build
        return None


def _name_parts(named_parts: list[tuple[str, Any]], records: list[_Record],
                budget_s: float | None) -> dict[str, Any] | None:
    if not records or not named_parts or len(records) > MAX_RECORDS:
        return None
    labels = [name for name, _shape in named_parts]
    unique = [(name, _wrapped(shape)) for name, shape in named_parts if labels.count(name) == 1]
    unique = [(name, shape) for name, shape in unique if isinstance(shape, TopoDS_Shape) and not shape.IsNull()]
    if not unique:
        return None
    maps = {name: [_map(shape, TopAbs_EDGE), _map(shape, TopAbs_FACE)] for name, shape in unique}
    if sum(m.Extent() for pair in maps.values() for m in pair) > MAX_ELEMENTS:
        return None

    composer = _Composer(None if budget_s is None else time.monotonic() + budget_s)
    composer.run(records)

    files: list[str] = []
    file_index: dict[str, int] = {}
    parts: dict[str, dict[str, list[str]]] = {}
    lines: dict[str, dict[str, list]] = {}
    for name, _shape in unique:
        parts[name], lines[name] = {}, {}
        for code, elements, kind in (("e", maps[name][0], 1), ("f", maps[name][1], 2)):
            names: list[str] = []
            exact: list[str] = []
            made: list = []
            for ordinal in range(1, elements.Extent() + 1):
                at_slot = composer.placed_slot(elements.FindKey(ordinal))
                if at_slot is None:
                    # Nothing ever touched it: it is this part's own, by its ordinal here.
                    names.append(_digest({(f"part:{name}", kind, ordinal): (SAME, ())}))
                    exact.append(names[-1])
                    made.append(None)
                    continue
                names.append(_digest(composer.origins[at_slot]))
                exact.append(_digest(composer.origins[at_slot], exact=True))
                site = composer.sites[at_slot]
                if site is None:
                    made.append(None)
                else:
                    base = os.path.basename(site[0])
                    at_file = file_index.get(base)
                    if at_file is None:
                        at_file = file_index[base] = len(files)
                        files.append(base)
                    made.append([at_file, site[1]])
            counts: dict[str, int] = {}
            for value in names:
                counts[value] = counts.get(value, 0) + 1
            # A plain name shared within the part (the pieces of a split): use the exact one.
            names = [value if counts[value] == 1 else exact[at] for at, value in enumerate(names)]
            counts = {}
            for value in names:
                counts[value] = counts.get(value, 0) + 1
            parts[name][code] = [value if counts[value] == 1 else "" for value in names]
            lines[name][code] = made
    return {"schemaVersion": NAMES_SCHEMA_VERSION, "parts": parts, "lines": lines, "files": files}
