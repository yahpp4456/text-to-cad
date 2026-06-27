"""Read the per-family spec tables shipped under ``cadpy/parts/specs/*.json``.

The spec tables are the catalog half of the resolver: each row is one
representative standard size (4-6 per family, not an exhaustive catalog). Every
row MUST carry ``source`` and ``confidence`` -- the honesty contract that keeps
selection from passing off a reconstructed dimension as an authoritative vendor
value (see the plan's "source honesty" rule and ``select.py``).

Loading goes through :func:`importlib.resources.files` so it works both from the
editable source tree and from a vendored runtime copy.
"""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

# Confidence levels a spec row may declare, lowest to highest trust.
CONFIDENCE_LEVELS = ("low", "med", "high")


def load_specs(family: str) -> list[dict[str, Any]]:
    """Return the spec rows for ``family`` (e.g. ``"cylinders"``), UTF-8.

    Raises ``ValueError`` if the file is missing the honesty fields, so a row
    can never reach selection without a declared ``source`` + ``confidence``.
    """
    resource = files("cadpy.parts.specs").joinpath(f"{family}.json")
    rows = json.loads(resource.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"specs/{family}.json must be a non-empty JSON array")
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"specs/{family}.json row {i} is not an object")
        if "source" not in row:
            raise ValueError(f"specs/{family}.json row {i} missing 'source'")
        conf = row.get("confidence")
        if conf not in CONFIDENCE_LEVELS:
            raise ValueError(
                f"specs/{family}.json row {i} confidence {conf!r} "
                f"not one of {CONFIDENCE_LEVELS}"
            )
    return rows
