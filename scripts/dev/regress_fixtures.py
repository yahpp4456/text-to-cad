"""Build CAD fixtures in child processes and compare their geometry with a baseline."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from threading import Lock
import time


ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "models"
TMP = ROOT / "tmp"
WORK = TMP / "regress" / "work"
GEN_STEP = re.compile(r"^def gen_step\s*\(", re.MULTILINE)


def _measure(read):
    try:
        return read()
    except Exception:
        return None


def _bbox(shape):
    box = shape.bounding_box()
    return [round(value, 6) for point in (box.min, box.max) for value in (point.X, point.Y, point.Z)]


def _geometry(generator):
    for directory in (ROOT, generator.parent):
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))

    start = time.perf_counter()
    try:
        name = f"regress_fixture_{generator.stem}"
        spec = importlib.util.spec_from_file_location(name, generator)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load generator: {generator}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        payload = module.gen_step()
    except Exception as exc:
        return {"ok": False, "seconds": round(time.perf_counter() - start, 6),
                "error": f"{type(exc).__name__}: {exc}"}
    seconds = round(time.perf_counter() - start, 6)

    from cadpy.geometry_checks import _as_named_parts, is_valid_solid

    obj = payload["shape"] if isinstance(payload, dict) and "shape" in payload else payload
    try:
        named = list(_as_named_parts(obj))
    except Exception:
        named = [("part", obj)]

    parts = []
    volumes = []
    for label, shape in named:
        volume = _measure(lambda: float(shape.volume))
        if volume is not None:
            volumes.append(volume)
        parts.append({
            "label": label,
            "volume": round(volume, 6) if volume is not None else None,
            "area": _measure(lambda: round(float(shape.area), 6)),
            "bbox": _measure(lambda: _bbox(shape)),
            "faces": _measure(lambda: len(shape.faces())),
            "edges": _measure(lambda: len(shape.edges())),
            "vertices": _measure(lambda: len(shape.vertices())),
            "valid": _measure(lambda: bool(is_valid_solid(shape))),
        })

    boxes = [part["bbox"] for part in parts if part["bbox"] is not None]
    bounds = [min(axis) if i < 3 else max(axis) for i, axis in enumerate(zip(*boxes))]
    try:
        import OCP
        ocp_version = getattr(OCP, "__version__", None)
    except ImportError:
        ocp_version = None
    return {
        "ok": True, "seconds": seconds, "partCount": len(parts),
        "bbox": bounds or None, "volume": round(math.fsum(volumes), 6), "parts": parts,
        "versions": {
            "python": platform.python_version(),
            "build123d": _measure(lambda: importlib.metadata.version("build123d")),
            "ocp": ocp_version,
        },
    }


def _selected(key, only):
    # A trailing slash selects that directory, e.g. linear_stage/ must exclude
    # motorized_linear_stage/. Other names are substrings of the fixture key.
    return not only or any(key.startswith(name) if name.endswith("/") else name in key for name in only)


def _discover(only):
    fixtures = {}
    for path in MODELS.glob("*/*.py"):
        key = path.relative_to(MODELS).as_posix()
        if _selected(key, only) and path.is_file() and GEN_STEP.search(path.read_text(encoding="utf-8")):
            fixtures[key] = path
    return dict(sorted(fixtures.items()))


def _run(args, python_args):
    return subprocess.run(
        [args.python, *python_args], cwd=ROOT, timeout=args.timeout,
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
             "PYTHON_COLORS": "0", "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, encoding="utf-8", errors="replace",
    )


def _run_json(args, command, *, validate=False):
    start = time.perf_counter()
    try:
        process = _run(args, command)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timeout after {args.timeout:g}s"}
    seconds = round(time.perf_counter() - start, 6)
    line = next((s for s in reversed(process.stdout.splitlines()) if s.startswith("{")), "")
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return {"ok": False, "error": "no JSON output", "exitCode": process.returncode,
                "stderrTail": process.stderr[-500:]}
    if not validate:
        return data
    return {
        "ok": data["ok"], "seconds": seconds, "partCount": data.get("partCount"),
        "hasMotion": "motion" in data,
        "checks": [
            {"id": check["id"], "ok": check["ok"], "skipped": check.get("skipped", False),
             "note": check.get("note")}
            for check in data.get("checks", [])
        ],
        "error": data.get("error"),
    }


def _run_pipeline(args, generator):
    destination = WORK / generator.parent.name
    # Never follow a redirected work directory when removing the previous copy.
    if destination.resolve() != destination:
        raise ValueError(f"redirected pipeline work directory: {destination}")
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(generator.parent, destination, ignore=shutil.ignore_patterns("__pycache__"))

    start = time.perf_counter()
    try:
        process = _run(args, ["skills/cad/scripts/step", destination / generator.name, "--force"])
        code, stderr = process.returncode, process.stderr
    except subprocess.TimeoutExpired as exc:
        code = None
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace")
    seconds = round(time.perf_counter() - start, 6)

    step = destination / f"{generator.stem}.step"
    glb = destination / f".{step.name}.glb"
    meta = destination / f".{step.name}.meta.json"
    ok = code == 0 and step.is_file() and glb.is_file()
    result = {
        "ok": ok, "seconds": seconds, "exitCode": code,
        "stepBytes": step.stat().st_size if step.is_file() else None,
        "glbBytes": glb.stat().st_size if glb.is_file() else None,
        "metaPartCount": _measure(lambda: json.loads(meta.read_text(encoding="utf-8")).get("partCount")),
        "stderrTail": "" if ok else stderr[-500:],
    }
    if code is None:
        result["error"] = f"timeout after {args.timeout:g}s"
    return result


def _run_fixture(args, generator, directory_lock):
    result = {"gen": _run_json(args, [Path(__file__).resolve(), "--child", generator])}
    if not args.skip_validate:
        command = ["apps/cad-chat/src/server/cad/validate.py", generator]
        result["validate"] = _run_json(args, command, validate=True)
    if args.pipeline:
        # Generators sharing a source directory also share the pipeline work copy.
        with directory_lock:
            result["pipeline"] = _run_pipeline(args, generator)
    return result


def _part_map(parts):
    counts = Counter()
    indexed = {}
    for part in parts:
        label = part["label"]
        indexed[label, counts[label]] = part
        counts[label] += 1
    return indexed


def _part_name(key):
    label, index = key
    return f"{label}#{index}" if index else label


def _close(a, b):
    if a is None or b is None:
        return a is b
    return math.isclose(a, b, rel_tol=1e-4, abs_tol=1e-3)


def _same_bbox(a, b):
    if a is None or b is None:
        return a is b
    return len(a) == len(b) and all(abs(x - y) <= 1e-3 for x, y in zip(a, b))


def _compare_fixture(key, base, now, strict_topology):
    differences = []

    def report(what, old, new, context="", level="FAIL"):
        differences.append({"fixture": key, "level": level, "what": what,
                            "detail": f"base={old} now={new}{context}"})

    def compare_geometry(old, new, context=""):
        for field in ("volume", "area"):
            if not _close(old.get(field), new.get(field)):
                report(field, old.get(field), new.get(field), context)
        if not _same_bbox(old.get("bbox"), new.get("bbox")):
            report("bbox", old.get("bbox"), new.get("bbox"), context)

    a, b = base["gen"], now["gen"]
    if a["ok"] != b["ok"]:
        report("gen.ok", a["ok"], b["ok"])
    elif a["ok"]:
        if a.get("partCount") != b.get("partCount"):
            report("partCount", a.get("partCount"), b.get("partCount"))
        compare_geometry(a, b)
        old_parts, new_parts = _part_map(a.get("parts", [])), _part_map(b.get("parts", []))
        if old_parts.keys() != new_parts.keys():
            report("labels", [_part_name(k) for k in sorted(old_parts)],
                   [_part_name(k) for k in sorted(new_parts)])
        for part in sorted(old_parts.keys() & new_parts.keys()):
            old, new = old_parts[part], new_parts[part]
            context = f" part={_part_name(part)}"
            compare_geometry(old, new, context)
            if old.get("valid") != new.get("valid"):
                report("valid", old.get("valid"), new.get("valid"), context)
            for field in ("faces", "edges", "vertices"):
                if old.get(field) != new.get(field):
                    report("topology", old.get(field), new.get(field), f"{context} field={field}",
                           level="FAIL" if strict_topology else "WARN")

    if "validate" in base and "validate" in now:
        old, new = base["validate"], now["validate"]
        if old["ok"] != new["ok"]:
            report("validate.ok", old["ok"], new["ok"])
        old_checks = {c["id"]: c for c in old.get("checks", [])}
        new_checks = {c["id"]: c for c in new.get("checks", [])}
        for check_id in sorted(old_checks.keys() & new_checks.keys()):
            before, after = old_checks[check_id], new_checks[check_id]
            old_state = {"ok": before["ok"], "skipped": before.get("skipped", False)}
            new_state = {"ok": after["ok"], "skipped": after.get("skipped", False)}
            if old_state != new_state:
                report(f"check:{check_id}", old_state, new_state)

    if "pipeline" in base and "pipeline" in now:
        old, new = base["pipeline"], now["pipeline"]
        for field, what in (("ok", "pipeline.ok"), ("metaPartCount", "pipeline.partCount")):
            if old.get(field) != new.get(field):
                report(what, old.get(field), new.get(field))
    return differences


def compare_results(baseline: dict, current: dict, *, strict_topology: bool = False) -> list[dict]:
    """Return fixture, level, what and detail for each difference in two reports."""
    old, new = baseline["fixtures"], current["fixtures"]
    differences = []
    for key in sorted(old.keys() | new.keys()):
        if key not in new:
            differences.append({"fixture": key, "level": "FAIL", "what": "missing",
                                "detail": "base=present now=missing"})
        elif key not in old:
            differences.append({"fixture": key, "level": "WARN", "what": "new",
                                "detail": "base=missing now=present"})
        else:
            differences.extend(_compare_fixture(key, old[key], new[key], strict_topology))
    return differences


def _print_comparison(baseline, current, strict):
    differences = compare_results(baseline, current, strict_topology=strict)
    for diff in differences:
        print("{level} {fixture} {what}: {detail}".format(**diff))
    old, new = baseline["fixtures"], current["fixtures"]
    for key in sorted(old.keys() & new.keys()):
        times = []
        for stage in ("gen", "validate"):
            a = old[key].get(stage, {}).get("seconds")
            b = new[key].get(stage, {}).get("seconds")
            if a is not None and b is not None:
                times.append(f"{stage} {a:.1f}s -> {b:.1f}s")
        if times:
            print(f"{key}  " + "   ".join(times))
    counts = Counter(d["level"] for d in differences)
    print(f"compared {len(old.keys() | new.keys())} fixtures: {counts['FAIL']} FAIL, {counts['WARN']} WARN")
    return int(counts["FAIL"] > 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--child", type=Path, metavar="GENERATOR", help=argparse.SUPPRESS)
    parser.add_argument("--out", type=Path, help="output JSON path under tmp/")
    parser.add_argument("--compare", type=Path, metavar="BASELINE", help="compare with a previous report")
    parser.add_argument("--only", nargs="+", metavar="NAME", help="fixture key substrings")
    parser.add_argument("--jobs", type=int, default=1, help="maximum concurrent fixtures (default 1)")
    parser.add_argument("--timeout", type=float, default=900, help="seconds per child process (default 900)")
    parser.add_argument("--python", default=sys.executable, metavar="EXE", help="child Python interpreter")
    parser.add_argument("--skip-validate", action="store_true", help="skip cad-chat validation")
    parser.add_argument("--pipeline", action="store_true", help="also generate STEP and GLB in tmp/regress/work")
    parser.add_argument("--strict-topology", action="store_true", help="fail on changed topology counts")
    args = parser.parse_args()
    if args.child:
        sys.dont_write_bytecode = True
        result = _geometry(args.child.resolve())
        print(json.dumps(result, ensure_ascii=False))
        return int(not result["ok"])

    if args.jobs < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--jobs and --timeout must be positive")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    out = (args.out or TMP / "regress" / f"fixtures-{stamp}.json").resolve()
    if TMP not in out.parents:
        parser.error("--out must be a file under the repository tmp/ directory")
    baseline = None
    if args.compare:
        baseline = json.loads(args.compare.read_text(encoding="utf-8"))
        baseline["fixtures"] = {k: v for k, v in baseline["fixtures"].items() if _selected(k, args.only)}

    fixtures = _discover(args.only)
    locks = {path.parent: Lock() for path in fixtures.values()}
    results = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(_run_fixture, args, path, locks[path.parent]): key
                   for key, path in fixtures.items()}
        for completed, future in enumerate(as_completed(futures), 1):
            key = futures[future]
            results[key] = future.result()
            progress = []
            for stage, data in results[key].items():
                status = "ok" if data["ok"] else "fail"
                duration = f"({data['seconds']:.1f}s)" if "seconds" in data else ""
                progress.append(f"{stage}={status}{duration}")
            print(f"[{completed}/{len(fixtures)}] {key} " + " ".join(progress), file=sys.stderr, flush=True)

    ordered = {key: results[key] for key in fixtures}
    versions = next((v["gen"]["versions"] for v in ordered.values() if v["gen"]["ok"]), {})
    report = {"schemaVersion": 1, "createdAt": datetime.now().isoformat(timespec="seconds"),
              "python": args.python, "versions": versions, "fixtures": ordered}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    if baseline is not None:
        return _print_comparison(baseline, report, args.strict_topology)
    return 0


if __name__ == "__main__":
    sys.exit(main())
