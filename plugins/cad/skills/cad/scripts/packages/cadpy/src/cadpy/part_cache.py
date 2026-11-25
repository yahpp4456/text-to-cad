"""Remember what a part generator built, for as long as the process lives.

A standard part -- a linear guide, a ball screw, a gear, a swept sleeve -- is a pure
function of its arguments, and in an assembly most of them are called with the same
arguments build after build: a slider that changes the stroke does not change the motor.
The CAD worker is a long-lived process, so the shape from the last build is still there.
``cached_part`` keeps it:

    @cached_part
    def linear_guide(rail_width, rail_height, ...): ...

A call with arguments seen before returns a copy of the shape built then (a new Python
object each time, so a caller that labels, colours or places it changes nothing for the
next caller), without running the kernel.

Three things keep a hit indistinguishable from a miss:

- **Stable names** (``cadpy.kernel.naming``): the kernel makers the generator ran are kept
  with the shape and replayed into the current recording on a hit, so the elements of a
  cached part are named exactly as if it had just been built. The makers a decorated
  function runs are identified by the function and their position inside it (a naming
  *scope*) rather than by their position in the build -- on a miss as well, so the names
  do not depend on what happened to be cached, nor on the arguments.
- **Made-by** (``cadpy.assembly``): the labels the generator gave are recorded again at
  the calling line.
- **Arguments** must be plain data (numbers, strings, booleans, None, and lists, tuples
  and dicts of those). Anything else -- a shape, an object -- and the call is simply not
  cached.

Switch off with ``CADPY_PART_CACHE=0``. The cache is per process, bounded
(``MAX_ENTRIES``, least recently used out first) and holds no files.
"""

from __future__ import annotations

import copy
import functools
import os
import threading
from collections import OrderedDict
from typing import Any, Callable

__all__ = ["cached_part", "clear", "enabled", "stats"]

ENV_SWITCH = "CADPY_PART_CACHE"
MAX_ENTRIES = 64
_UNCACHEABLE = object()

_LOCK = threading.Lock()
_CACHE: "OrderedDict[tuple, _Entry]" = OrderedDict()
_STATS = {"hits": 0, "misses": 0, "bypassed": 0}


class _Entry:
    __slots__ = ("shape", "records", "labels")

    def __init__(self, shape: Any, records: list | None, labels: list[str]) -> None:
        self.shape = shape
        self.records = records    # the makers that built it; None when built outside a recording
        self.labels = labels      # the labels the generator gave, for made-by


def enabled() -> bool:
    return os.environ.get(ENV_SWITCH, "1").strip().lower() not in ("0", "false", "off", "no")


def stats() -> dict[str, int]:
    return {**_STATS, "entries": len(_CACHE)}


def clear() -> None:
    with _LOCK:
        _CACHE.clear()
        for key in _STATS:
            _STATS[key] = 0


def _freeze(value: Any) -> Any:
    """Plain data as a hashable, order-independent key; ``_UNCACHEABLE`` for anything else."""
    if value is None or isinstance(value, (bool, int, str)):
        return (type(value).__name__, value)
    if isinstance(value, float):
        return ("float", repr(value))
    if isinstance(value, (list, tuple)):
        items = tuple(_freeze(item) for item in value)
        return _UNCACHEABLE if any(item is _UNCACHEABLE for item in items) else (type(value).__name__, items)
    if isinstance(value, dict):
        items = []
        for key in sorted(value, key=repr):
            if not isinstance(key, (str, int)):
                return _UNCACHEABLE
            frozen = _freeze(value[key])
            if frozen is _UNCACHEABLE:
                return _UNCACHEABLE
            items.append((key, frozen))
        return ("dict", tuple(items))
    return _UNCACHEABLE


def _copy_of(shape: Any) -> Any:
    """A caller's own object over the cached geometry."""
    return copy.copy(shape)


def cached_part(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Cache ``fn``'s result by its arguments (see the module docstring)."""
    name = f"{fn.__module__}.{fn.__qualname__}"

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        from cadpy import assembly
        from cadpy.kernel import naming

        frozen = _freeze((args, kwargs))
        if frozen is _UNCACHEABLE:
            _STATS["bypassed"] += 1
            return fn(*args, **kwargs)
        key = (name, frozen)
        # The naming scope is the function alone, not its arguments: a guide that is 20 mm
        # longer is the same guide with the same faces, and must keep their names.
        scope_key = name
        recording = naming.recording_active()
        if enabled():
            with _LOCK:
                entry = _CACHE.get(key)
                if entry is not None:
                    _CACHE.move_to_end(key)
            # An entry built outside a recording has no makers to replay; inside one it
            # cannot stand in for a build, or the part would have no names.
            if entry is not None and (entry.records is not None or not recording):
                _STATS["hits"] += 1
                if recording and entry.records:
                    naming.replay(entry.records, scope_key)
                assembly.record_made_by(entry.labels)
                return _copy_of(entry.shape)
        _STATS["misses"] += 1
        before = assembly.made_by()
        with naming.scope(scope_key) as made:
            # Copied once inside the scope: what leaves it is then made entirely by scoped
            # makers. A child the generator only placed (a pin it never cut or fused) would
            # otherwise first meet a maker in the caller's copy, and be named after
            # whichever caller happened to copy the cached shape first.
            shape = _copy_of(fn(*args, **kwargs))
        after = assembly.made_by()
        labels = [label for label, site in after.items() if before.get(label) != site]
        assembly.record_made_by(labels)   # at the caller's line, as a hit will record them
        if enabled():
            with _LOCK:
                _CACHE[key] = _Entry(shape, list(made) if recording else None, labels)
                _CACHE.move_to_end(key)
                while len(_CACHE) > MAX_ENTRIES:
                    _CACHE.popitem(last=False)
        return _copy_of(shape)

    wrapper.__cached_part__ = True
    return wrapper
