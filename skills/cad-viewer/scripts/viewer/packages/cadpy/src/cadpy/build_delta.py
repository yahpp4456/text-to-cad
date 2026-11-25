"""Summarize build geometry without importing a CAD kernel."""

import hashlib
import math

SUMMARY_SCHEMA_VERSION = 1
MAX_PARTS = 400


def _finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite geometry")
    return number


def _rounded(value):
    return round(value, 3) or 0.0


def _measure_geometry(shape):
    volume = _finite(shape.volume)
    area = _finite(shape.area)
    faces = len(shape.faces())
    edges = len(shape.edges())
    vertices = len(shape.vertices())
    signature = f"{_rounded(volume):.3f}|{_rounded(area):.3f}|{faces}|{edges}|{vertices}"
    key = hashlib.sha1(signature.encode("ascii")).hexdigest()[:12]
    return key, volume, faces


def geometry_key(shape) -> str:
    """Fingerprint the shape independently of its placement."""
    return _measure_geometry(shape)[0]


def _error_text(exc, limit=None):
    try:
        message = str(exc)[:limit]
    except Exception:
        message = ""
    return f"{type(exc).__name__}: {message}"


def _measure_part(name, shape):
    # Retain the raw volume so the build total is rounded only once.
    label = ""
    try:
        label = str(name)
        key, volume, faces = _measure_geometry(shape)
        box = shape.bounding_box()
        bbox = [
            [_rounded(_finite(coord)) for coord in (point.X, point.Y, point.Z)]
            for point in (box.min, box.max)
        ]
        return {
            "name": label,
            "key": key,
            "bbox": bbox,
            "volume": _rounded(volume),
            "faces": faces,
        }, volume
    except Exception as exc:
        return {"name": label, "error": _error_text(exc, 120)}, 0.0


def part_summary(name: str, shape) -> dict:
    """Return a JSON-ready measurement or a per-part error."""
    return _measure_part(name, shape)[0]


def build_summary(named_parts) -> dict:
    """Count every input part and aggregate the first MAX_PARTS measurements."""
    parts = []
    volumes = []
    bbox = None
    count = 0
    try:
        for count, (name, shape) in enumerate(named_parts, start=1):
            if count > MAX_PARTS:
                continue
            part, volume = _measure_part(name, shape)
            parts.append(part)
            if "error" in part:
                continue
            volumes.append(volume)
            lo, hi = part["bbox"]
            if bbox is None:
                bbox = [lo.copy(), hi.copy()]
            else:
                bbox = [
                    [min(a, b) for a, b in zip(bbox[0], lo)],
                    [max(a, b) for a, b in zip(bbox[1], hi)],
                ]
        total_volume = _rounded(math.fsum(volumes))
    except Exception as exc:
        return {
            "schemaVersion": SUMMARY_SCHEMA_VERSION, "partCount": 0, "bbox": None,
            "volume": 0.0, "parts": [], "error": _error_text(exc),
        }

    summary = {
        "schemaVersion": SUMMARY_SCHEMA_VERSION, "partCount": count, "bbox": bbox,
        "volume": total_volume, "parts": parts,
    }
    if count > MAX_PARTS:
        summary["truncated"] = True
    return summary
