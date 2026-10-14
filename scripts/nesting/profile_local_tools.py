"""Replay a fixed production request and profile the real local-tools entry point.

Run with the nesting virtualenv. Outputs include an immutable request, source
hashes, cProfile, matchTemplate calls/time, geometry checks, and Windows process
memory. No solver source is modified. A frozen checkout can be selected using
--implementation-root. Use --command-json '["path/to/rust.exe"]' for a JSON
stdin/stdout Rust adapter. The executable receives {"request": request}.
Normally --backend python|rust selects PRINTFLOW_NESTING_CORE on the same
Python adapter. A Rust measurement passes only if result.searchCore confirms
the Rust core actually executed without falling back.

Example::

    python scripts/nesting/profile_local_tools.py --input request.json --limit 4 \
        --quantity 1 --objective material --output-dir .test-output/local-tools/rust-migration-small

Use --cache-dir from an earlier run and --cache-mode warm to measure disk-cache
reuse in a fresh process. --compare-report checks the same frozen input/config
and reports relative time/memory plus exact placement equality. --max-seconds
is an optional measured regression threshold, never a process-killing timeout.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter, defaultdict
import contextlib
import copy
import cProfile
import ctypes
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import pstats
import subprocess
import sys
import threading
import time

# The controller's independent validator also imports NumPy through Shapely.
# Match the production core's single-thread native-library memory settings.
for _thread_env in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_thread_env] = "1"

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_RELATIVE = Path("src-tauri/src/imposition/local_nesting")
SOURCE_FILES = tuple(str(RUNTIME_RELATIVE / name) for name in (
    "nesting_common.py", "nest_uniform.py", "local_tools_engine.py", "nesting_rust.py",
    "rust_core/Cargo.toml", "rust_core/Cargo.lock", "rust_core/src/lib.rs"))


def adapter_path(root):
    """Allow an explicitly selected historical checkout for migration comparisons."""
    runtime = root / RUNTIME_RELATIVE
    adapter = runtime / "local_tools_engine.py"
    if adapter.is_file():
        return adapter
    historical = root / "scripts/nesting/local_tools_engine.py"
    if root.resolve() != ROOT and historical.is_file():
        return historical
    raise FileNotFoundError(f"Local nesting adapter not found: {adapter}")


def implementation_sources(root):
    if adapter_path(root).parent == root / RUNTIME_RELATIVE:
        return SOURCE_FILES
    # This branch is only for --implementation-root pointing at a frozen old copy.
    return ("tools/nesting_common.py", "tools/nest_uniform.py", "tools/nest_material.py",
            "scripts/nesting/local_tools_engine.py", "tools/nesting_rust.py",
            "scripts/nesting/rust_core/Cargo.toml", "scripts/nesting/rust_core/Cargo.lock",
            "scripts/nesting/rust_core/src/lib.rs")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def memory_state(pid=None):
    """Current and OS lifetime peaks; Windows peak commit includes native arrays."""
    if os.name != "nt":
        try:
            import psutil
            mem = psutil.Process(pid or os.getpid()).memory_info()
            return {"rssBytes": mem.rss, "privateBytes": getattr(mem, "private", mem.vms)}
        except (ImportError, OSError):
            return {}
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.OpenProcess(0x410, False, pid or os.getpid())
    if not handle:
        return {}
    try:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        api = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
        api.argtypes = (wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD)
        if not api(handle, ctypes.byref(counters), counters.cb):
            return {}
        return {"rssBytes": counters.WorkingSetSize, "peakRssBytes": counters.PeakWorkingSetSize,
                "privateBytes": counters.PrivateUsage, "peakCommitBytes": counters.PeakPagefileUsage}
    finally:
        kernel.CloseHandle(handle)


def system_memory():
    if os.name != "nt":
        return {}
    from ctypes import wintypes

    class Status(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("loadPercent", wintypes.DWORD)] + [
            (name, ctypes.c_ulonglong) for name in ("totalPhysical", "availablePhysical",
            "totalCommit", "availableCommit", "totalVirtual", "availableVirtual", "unused")]

    status = Status()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return {}
    return {name: getattr(status, name) for name in ("loadPercent", "totalPhysical",
            "availablePhysical", "totalCommit", "availableCommit")}


def cache_inventory(path):
    files = sorted(Path(path).glob("*.pkl"))
    entries = []
    for path in files:
        stat = path.stat()
        entries.append({"name": path.name, "bytes": stat.st_size, "modifiedNs": stat.st_mtime_ns})
    return {"maskFiles": len(files), "maskBytes": sum(entry["bytes"] for entry in entries),
            "entriesSha256": canonical_hash(entries), "entries": entries}


def timing_contract(external=False):
    """Version the actual timing wrappers, independently of report-only edits."""
    if external:
        return {"scope": "external-process-including-startup", "instrumentation": "none"}
    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
    names = {"timed_match", "timed_masks", "MeasuredProgress"}
    functions = {node.name: ast.dump(node, include_attributes=False) for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names}
    return {"scope": "adapter-solve-only", "instrumentation": "timed-matchTemplate-make_masks-progress",
            "wrappersAstSha256": canonical_hash(functions),
            "note": "Instrumented solve wall time; per-call native timers remain enabled without cProfile"}


def audit_cache(report):
    """A warm claim needs unchanged files, not merely a nonempty directory."""
    configuration = report.get("configuration", {})
    before, after = configuration.get("cacheBefore", {}), report.get("cacheAfter", {})
    mode = configuration.get("cacheMode")
    result = {"mode": mode, "fullyWarm": None, "coldAtStart": None, "reason": None}
    if mode == "cold":
        result["coldAtStart"] = before.get("maskFiles") == 0 and before.get("maskBytes") == 0
        result["reason"] = "No cached masks at start" if result["coldAtStart"] else "Cold cache already contained masks"
    elif mode == "warm":
        legacy_unchanged = all(before.get(k) == after.get(k) and before.get(k) is not None
                               for k in ("maskFiles", "maskBytes"))
        result["countsAndBytesUnchanged"] = legacy_unchanged
        masks = report.get("makeMasks", {})
        if not before.get("entriesSha256") or not after.get("entriesSha256"):
            result["reason"] = "Legacy inventory lacks filenames and modification times; unchanged counts/bytes alone cannot prove every mask was loaded"
        elif not masks.get("calls") or not masks.get("uniqueArrays"):
            result["reason"] = "Measured mask preparation metadata is unavailable"
        else:
            result["fullyWarm"] = bool(before.get("maskFiles", 0) >= masks["calls"] and legacy_unchanged
                                       and before["entriesSha256"] == after["entriesSha256"])
            result["reason"] = "All cache files unchanged during mask preparation/search" if result["fullyWarm"] else "Cache files were added, removed or modified during the run"
    else:
        result["reason"] = "Reuse mode permits an unspecified mix of warm and cold masks"
    return result


def compare_reports(reference, measured, *, reference_path=None):
    """Postprocess reports without rerunning or changing their measurements."""
    settings = ("requestSha256", "seed", "rotationStepDegrees", "resolutionMm", "materialRuns", "lookahead", "cacheMode")
    first_config, second_config = reference.get("configuration", {}), measured.get("configuration", {})
    same_input = all(first_config.get(key) == second_config.get(key) and first_config.get(key) is not None for key in settings)
    first_contract, second_contract = reference.get("timingContract"), measured.get("timingContract")
    same_scope = bool(first_contract and second_contract and first_contract.get("scope") == second_contract.get("scope"))
    same_instrumentation = bool(first_contract and second_contract and
        all(first_contract.get(key) == second_contract.get(key) for key in ("instrumentation", "wrappersAstSha256")))
    profiles_disabled = reference.get("profileEnabled") is False and measured.get("profileEnabled") is False
    first_masks, second_masks = reference.get("makeMasks", {}), measured.get("makeMasks", {})
    same_masks = all(key in first_masks and first_masks.get(key) == second_masks.get(key)
                     for key in ("calls", "uniqueArrays", "bytes", "resolutionsMm"))
    first_cache, second_cache = audit_cache(reference), audit_cache(measured)
    if first_config.get("cacheMode") == second_config.get("cacheMode") == "warm":
        equivalent_cache = first_cache["fullyWarm"] is True and second_cache["fullyWarm"] is True
    elif first_config.get("cacheMode") == second_config.get("cacheMode") == "cold":
        equivalent_cache = first_cache["coldAtStart"] is True and second_cache["coldAtStart"] is True
    else:
        equivalent_cache = False
    checks = {"sameInputAndSettings": same_input, "bothProfilesDisabled": profiles_disabled,
              "timingScopesMatch": same_scope, "timingInstrumentationMatches": same_instrumentation,
              "samePreparedMaskCountAndBytes": same_masks, "equivalentVerifiedCacheState": equivalent_cache,
              "bothRunsPassed": reference.get("passed") is True and measured.get("passed") is True}
    reasons = [key for key, passed in checks.items() if not passed]
    comparable = not reasons
    first_memory = reference.get("processMemory", reference.get("memoryAfter", {}))
    second_memory = measured.get("processMemory", measured.get("memoryAfter", {}))
    first_validation, second_validation = reference.get("validation", {}), measured.get("validation", {})
    ratio = lambda key: second_memory[key] / first_memory[key] if comparable and first_memory.get(key) and second_memory.get(key) else None
    return {"reference": str(reference_path) if reference_path else None, **checks,
            "comparable": comparable, "timingComparable": comparable, "incomparableReasons": reasons,
            "referenceCacheAudit": first_cache, "measuredCacheAudit": second_cache,
            "solverSpeedup": reference["solverSeconds"] / measured["solverSeconds"] if comparable and measured.get("solverSeconds") else None,
            "peakCommitRatio": ratio("peakCommitBytes"), "peakRssRatio": ratio("peakRssBytes"),
            "identicalPlacements": first_validation.get("placementSha256") == second_validation.get("placementSha256"),
            "sameSheetCount": first_validation.get("sheetsUsed") == second_validation.get("sheetsUsed"),
            "sameTemplateCount": first_validation.get("templates") == second_validation.get("templates"),
            "sheetCountDelta": second_validation.get("sheetsUsed", 0) - first_validation.get("sheetsUsed", 0),
            "templateCountDelta": second_validation.get("templates", 0) - first_validation.get("templates", 0),
            "profileModesMatch": reference.get("profileEnabled") == measured.get("profileEnabled"),
            "speedupScope": "Single-run instrumented solve wall time; host load/repetition must be audited separately"}


def profile_rows(profiler):
    stats = pstats.Stats(profiler)
    total = stats.total_tt
    rows = []
    for (filename, line, name), (primitive, calls, own, cumulative, _callers) in stats.stats.items():
        rows.append({"file": filename, "line": line, "function": name, "calls": calls,
                     "primitiveCalls": primitive, "selfSeconds": own, "inclusiveSeconds": cumulative,
                     "selfPercent": 100 * own / total if total else 0,
                     "inclusivePercent": 100 * cumulative / total if total else 0})
    return {"totalProfileSeconds": total,
            "byInclusive": sorted(rows, key=lambda x: -x["inclusiveSeconds"]),
            "bySelf": sorted(rows, key=lambda x: -x["selfSeconds"])}


def worker(args):
    """Fresh process isolates module state, disk cache, and native peak memory."""
    root, output = args.implementation_root.resolve(), args.output_dir.resolve()
    spec = importlib.util.spec_from_file_location("profiled_local_tools_engine", adapter_path(root))
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    import cv2
    import numpy
    import shapely

    request = json.loads(args.input.read_text(encoding="utf-8"))
    matches = {"calls": 0, "seconds": 0., "inputPixels": 0, "resultPixels": 0}
    masks = {"calls": 0, "seconds": 0., "uniqueArrays": 0, "bytes": 0, "resolutionsMm": []}
    phases = []
    mask_ids = set()
    original_match, original_masks = cv2.matchTemplate, adapter.make_masks

    def timed_match(image, template, method, *extra, **kwargs):
        started = time.perf_counter()
        try:
            return original_match(image, template, method, *extra, **kwargs)
        finally:
            matches["calls"] += 1
            matches["seconds"] += time.perf_counter() - started
            matches["inputPixels"] += int(image.size)
            matches["resultPixels"] += max(0, image.shape[0] - template.shape[0] + 1) * max(0, image.shape[1] - template.shape[1] + 1)

    def timed_masks(*positional, **kwargs):
        started = time.perf_counter()
        resolution = positional[2] if len(positional) > 2 else kwargs.get("res")
        if resolution not in masks["resolutionsMm"]:
            masks["resolutionsMm"].append(resolution)
        try:
            result = original_masks(*positional, **kwargs)
            for bank in result.values():
                for entry in bank:
                    arr = entry["mask"]
                    if id(arr) not in mask_ids:
                        mask_ids.add(id(arr))
                        masks["uniqueArrays"] += 1
                        masks["bytes"] += arr.nbytes
            return result
        finally:
            masks["calls"] += 1
            masks["seconds"] += time.perf_counter() - started

    class MeasuredProgress(adapter.Progress):
        def emit(self, phase, detail, *values, **kwargs):
            if not phases or phases[-1]["phase"] != phase:
                phases.append({"phase": phase, "atSeconds": time.perf_counter() - started})
            super().emit(phase, detail, *values, **kwargs)

    cv2.matchTemplate, adapter.make_masks = timed_match, timed_masks
    profiler = cProfile.Profile()
    memory_before = memory_state()
    write_json(output / "worker-start.json", {"processId": os.getpid(), "memoryBefore": memory_before,
        "selectedCoreEnvironment": os.environ.get("PRINTFLOW_NESTING_CORE"),
        "adapterFile": adapter.__file__, "startedAt": datetime.now(timezone.utc).isoformat()})
    started, cpu_started = time.perf_counter(), time.process_time()
    result = None
    error = None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if not args.no_profile:
                profiler.enable()
            if args.resolution == .5:
                result = adapter.solve(request, cache_dir=args.cache_dir, progress=MeasuredProgress())
            else:
                result = adapter._solve(request, cache_dir=args.cache_dir, progress=MeasuredProgress(), resolution=args.resolution)
    except BaseException as exc:
        error = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        profiler.disable()
        elapsed = time.perf_counter() - started
        cpu = time.process_time() - cpu_started
        memory_after = memory_state()
        cv2.matchTemplate, adapter.make_masks = original_match, original_masks
    if not args.no_profile:
        profiler.dump_stats(output / "profile.pstats")
        with (output / "profile.txt").open("w", encoding="utf-8") as stream:
            pstats.Stats(profiler, stream=stream).sort_stats("cumulative").print_stats(70)
            pstats.Stats(profiler, stream=stream).sort_stats("tottime").print_stats(70)
    for index, phase in enumerate(phases):
        end = phases[index + 1]["atSeconds"] if index + 1 < len(phases) else elapsed
        phase["seconds"] = end - phase["atSeconds"]
    write_json(output / "worker-report.json", {"solverSeconds": elapsed, "cpuSeconds": cpu,
        "profileEnabled": not args.no_profile, "profile": profile_rows(profiler) if not args.no_profile else {}, "matchTemplate": matches,
        "makeMasks": masks, "phases": phases, "memoryBefore": memory_before,
        "memoryAfter": memory_after, "measuredProcessId": os.getpid(),
        "selectedCoreEnvironment": os.environ.get("PRINTFLOW_NESTING_CORE"),
        "versions": {"python": sys.version, "numpy": numpy.__version__,
        "opencv": cv2.__version__, "shapely": shapely.__version__}, "error": error})
    if result is not None:
        write_json(output / "result.json", result)
    return 1 if error else 0


def validate(request, result):
    """Independent protocol reconstruction; no solver transform helpers used."""
    from shapely.geometry import Polygon, box
    from shapely.strtree import STRtree
    items = {str(item["id"]): item for item in request["items"]}
    expected = {ident if ordinal == 0 else f"{ident}#qt-{ordinal + 1}": ident
                for ident, item in items.items() for ordinal in range(int(item.get("quantity", 1)))}
    placements = result.get("placements", [])
    errors = []
    seen = Counter(str(p["id"]) for p in placements)
    if seen != Counter({ident: 1 for ident in expected}):
        errors.append("Expected QT placement IDs differ from result (missing, extra or duplicate)")
    if result.get("unplaced") or result.get("excludedItems"):
        errors.append("Unplaced or excluded production contours")
    width = min(request["effectiveWidthMm"], request["plateWidthMm"] - request["effectiveRightMm"])
    height = min(request["effectiveHeightMm"], request["plateHeightMm"])
    left, top = request["plateWidthMm"] - request["effectiveRightMm"] - width, (request["plateHeightMm"] - height) / 2
    region = box(left, top, left + width, top + height).buffer(1e-6)
    sheets = defaultdict(list)
    signatures = defaultdict(list)
    for placement in placements:
        if placement["id"] not in expected:
            continue
        source = items[expected[placement["id"]]]
        if not isinstance(placement["sheetIndex"], int) or placement["sheetIndex"] < 0:
            errors.append(f"Invalid sheet index: {placement['id']}")
            continue
        if not all(math.isfinite(float(placement[key])) for key in
                   ("xMm", "yMm", "rotationDeg", "widthMm", "heightMm")):
            errors.append(f"Nonfinite placement: {placement['id']}")
            continue
        if any(abs(float(placement[key]) - float(source[key])) > 1e-6 for key in ("widthMm", "heightMm")):
            errors.append(f"Source dimensions changed: {placement['id']}")
        angle = math.radians(placement["rotationDeg"])
        cosine, sine = math.cos(angle), math.sin(angle)
        def rotate(point):
            x, y = point
            return cosine * x - sine * y, sine * x + cosine * y
        frame = [rotate(p) for p in ((0, 0), (source["widthMm"], 0),
                 (source["widthMm"], source["heightMm"]), (0, source["heightMm"]))]
        tx, ty = placement["xMm"] - min(p[0] for p in frame), placement["yMm"] - min(p[1] for p in frame)
        frame_poly = Polygon([(x + tx, y + ty) for x, y in frame])
        poly = Polygon([(x + tx, y + ty) for x, y in map(rotate, source["polygon"])])
        if not region.covers(frame_poly) or not region.covers(poly):
            errors.append(f"Out of effective region: {placement['id']}")
        sheets[placement["sheetIndex"]].append(poly)
        signatures[placement["sheetIndex"]].append((canonical_hash(source["polygon"]),
                    round(placement["xMm"], 7), round(placement["yMm"], 7), round(placement["rotationDeg"], 7)))
    gap = request["spacingMm"]
    for index, polys in sheets.items():
        tree = STRtree(polys)
        for i, poly in enumerate(polys):
            for j in tree.query(poly.buffer(gap + 1e-7)):
                if j > i and (poly.intersection(polys[j]).area > 1e-7 or poly.distance(polys[j]) < gap - 1e-6):
                    errors.append(f"True contour gap/overlap failed: sheet {index}, placements {i}, {j}")
    if set(sheets) != set(range(int(result.get("sheetsUsed", 0)))):
        errors.append("sheetsUsed differs from occupied sheet count")
    return {"passed": not errors, "errors": errors, "placementCount": len(placements),
            "sheetsUsed": result.get("sheetsUsed"), "templates": len({tuple(sorted(s)) for s in signatures.values()}),
            "templateSignatureScope": "Request outer contours plus placement; internal SVG cutting paths are unavailable in this protocol",
            "utilization": result.get("utilization"), "placementSha256": canonical_hash(placements)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--implementation-root", type=Path, default=ROOT)
    parser.add_argument("--backend", choices=("python", "rust"), default="python")
    parser.add_argument("--command-json", help="JSON array command for external stdin/stdout adapter")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--quantity", type=int)
    parser.add_argument("--objective", choices=("material", "uniform"))
    parser.add_argument("--resolution", type=float, default=.5)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--cache-mode", choices=("cold", "warm", "reuse"), default="cold")
    parser.add_argument("--load-note", default="")
    parser.add_argument("--compare-report", type=Path)
    parser.add_argument("--require-identical-placements", action="store_true",
                        help="Fail if --compare-report has different placement coordinates/order")
    parser.add_argument("--max-seconds", type=float)
    parser.add_argument("--no-profile", action="store_true", help="Disable cProfile for fair end-to-end timing comparisons")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker:
        return worker(args)
    if args.require_identical_placements and not args.compare_report:
        parser.error("--require-identical-placements needs --compare-report")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "report.json").exists():
        parser.error("Output already contains a report; choose a new output directory to preserve evidence")
    cache = (args.cache_dir or output / "cache").resolve()
    cache.mkdir(parents=True, exist_ok=True)
    before_cache = cache_inventory(cache)
    if args.cache_mode == "cold" and before_cache["maskFiles"]:
        parser.error("Cold cache must be empty; use a new directory (existing cache is never deleted)")
    if args.cache_mode == "warm" and not before_cache["maskFiles"]:
        parser.error("Warm cache requires existing masks")
    document = json.loads(args.input.read_text(encoding="utf-8"))
    request = copy.deepcopy(document.get("request", document))
    if args.limit is not None:
        if args.limit < 1:
            parser.error("--limit must be positive")
        request["items"] = request["items"][:args.limit]
    if args.quantity is not None:
        if args.quantity < 1:
            parser.error("--quantity must be positive")
        for item in request["items"]:
            item["quantity"] = args.quantity
    if args.objective:
        request["objective"] = "least-cutting" if args.objective == "uniform" else "least-material"
    write_json(output / "request.json", request)
    configuration = {"requestSha256": canonical_hash(request), "seed": 0, "rotationStepDegrees": 15,
                     "resolutionMm": args.resolution, "materialRuns": 3, "lookahead": 1,
                     "cacheMode": args.cache_mode, "cacheDirectory": str(cache),
                     "cacheBefore": before_cache, "sources": len(request["items"]),
                     "quantity": sum(item.get("quantity", 1) for item in request["items"]),
                     "objective": request["objective"], "inputFile": str(args.input.resolve()),
                     "inputFileSha256": sha256(args.input), "contoursSha256": canonical_hash([
                         {key: item[key] for key in ("id", "widthMm", "heightMm", "polygon")} for item in request["items"]])}
    source_hashes = {name: sha256(args.implementation_root / name) for name in implementation_sources(args.implementation_root.resolve())
                     if (args.implementation_root / name).exists()}
    command = json.loads(args.command_json) if args.command_json else [sys.executable, "-B", str(Path(__file__).resolve()),
        "--worker", "--input", str(output / "request.json"), "--output-dir", str(output),
        "--implementation-root", str(args.implementation_root.resolve()), "--cache-dir", str(cache),
        "--resolution", str(args.resolution)]
    if args.no_profile and not args.command_json:
        command.append("--no-profile")
    report = {"startedAt": datetime.now(timezone.utc).isoformat(), "backend": args.backend,
              "configuration": configuration, "implementationRoot": str(args.implementation_root.resolve()),
              "implementationSha256": source_hashes, "command": command, "host": platform.platform(),
              "measurementScriptSha256": sha256(__file__), "nativeCallTimingEnabled": not bool(args.command_json),
              "timingContract": timing_contract(external=bool(args.command_json)),
              "loadNote": args.load_note, "systemMemoryBefore": system_memory(),
              "threadEnvironment": {key: os.environ.get(key) for key in (
                  "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "PRINTFLOW_NESTING_THREADS")}}
    library = Path(os.environ.get("PRINTFLOW_NESTING_CORE_LIBRARY", args.implementation_root / ".tools/nesting/native/printflow_nesting_core.dll"))
    if library.is_file():
        report["nativeLibrary"] = {"path": str(library.resolve()), "sha256": sha256(library)}
    if args.command_json:
        report["commandFileSha256"] = {p: sha256(p) for p in command if Path(p).is_file()}
    write_json(output / "run-config.json", report)
    peak = {}
    stop = threading.Event()
    started = time.perf_counter()
    with (output / "solver-progress.log").open("w", encoding="utf-8") as stderr, (output / "adapter-stdout.json").open("w", encoding="utf-8") as stdout:
        environment = dict(os.environ, PRINTFLOW_NESTING_CORE=args.backend)
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                   cwd=args.implementation_root, text=True, encoding="utf-8", env=environment)
        def sample():
            while not stop.is_set():
                for key, value in memory_state(process.pid).items():
                    peak[key] = max(peak.get(key, 0), value)
                stop.wait(.025)
        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        process.communicate(json.dumps({"request": request}) if args.command_json else None)
        stop.set()
        sampler.join()
    report.update(processSeconds=time.perf_counter() - started, exitCode=process.returncode,
                  sampledProcessMemory=peak, systemMemoryAfter=system_memory(), cacheAfter=cache_inventory(cache))
    if (output / "worker-report.json").exists():
        report.update(json.loads((output / "worker-report.json").read_text(encoding="utf-8")))
        report["processMemory"] = report["memoryAfter"]
        report["processMemoryScope"] = "OS lifetime peak in actual Python solver process; sampledProcessMemory may describe the virtualenv launcher"
    elif args.command_json:
        report.update(solverSeconds=report["processSeconds"], profileEnabled=False)
        raw = json.loads((output / "adapter-stdout.json").read_text(encoding="utf-8"))
        write_json(output / "result.json", raw.get("result", raw))
    if (output / "result.json").exists():
        result = json.loads((output / "result.json").read_text(encoding="utf-8"))
        report["searchCore"] = result.get("searchCore")
        report["actualBackend"] = (result.get("searchCore") or {}).get("backend", "python" if args.backend == "python" else "unverified")
        report["requestedBackendUsed"] = report["actualBackend"] == args.backend
        validation_started = time.perf_counter()
        try:
            report["validation"] = validate(request, result)
        except Exception as exc:
            report["validation"] = {"passed": False, "errors": [f"{type(exc).__name__}: {exc}"]}
        report["independentValidationSeconds"] = time.perf_counter() - validation_started
    report["passed"] = process.returncode == 0 and report.get("validation", {}).get("passed", False)
    report["passed"] &= report.get("requestedBackendUsed", False)
    observed_resolutions = report.get("makeMasks", {}).get("resolutionsMm", [])
    report["requestedResolutionUsed"] = not observed_resolutions or observed_resolutions == [args.resolution]
    report["passed"] &= report["requestedResolutionUsed"]
    report["cacheAudit"] = audit_cache(report)
    if args.cache_mode == "warm":
        report["passed"] &= report["cacheAudit"]["fullyWarm"] is True
    if args.max_seconds is not None:
        report["withinTimeBudget"] = report.get("solverSeconds", float("inf")) <= args.max_seconds
        report["passed"] &= report["withinTimeBudget"]
    if args.compare_report:
        reference = json.loads(args.compare_report.read_text(encoding="utf-8"))
        report["comparison"] = compare_reports(reference, report, reference_path=args.compare_report.resolve())
        report["passed"] &= report["comparison"]["comparable"]
        if args.require_identical_placements:
            report["passed"] &= report["comparison"]["identicalPlacements"]
    write_json(output / "report.json", report)
    compact = {k: v for k, v in report.items() if k not in ("profile", "configuration", "command")}
    compact["report"] = str(output / "report.json")
    print(json.dumps(compact, ensure_ascii=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
