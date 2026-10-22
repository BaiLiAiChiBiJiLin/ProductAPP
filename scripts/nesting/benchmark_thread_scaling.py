"""Measure actual Rust nesting scaling on one frozen production contour request.

Run with the nesting virtualenv, for example::

    .tools/nesting/.venv/Scripts/python.exe scripts/nesting/benchmark_thread_scaling.py \
        --input path/to/request.json

The benchmark never reads or changes live orders. Every solve uses a fresh
process, the same 0.5 mm masks, seed and quantities. A warm-up populates one
shared disk cache before alternating thread counts across repeated rounds.
Independent Shapely validation checks full QT, original image frames, true
contour overlap and configured spacing. Timings exclude process startup,
source SVG decoding and the independent validation, and disable cProfile.
Results and per-run evidence are written under the system temp by default.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile

from profile_local_tools import canonical_hash, sha256, write_json


ROOT = Path(__file__).resolve().parents[2]
PROFILE = Path(__file__).with_name("profile_local_tools.py")


def alternating_order(threads, round_index):
    # Separate adjacent counts in the first round and reverse later rounds to
    # reduce systematic warm-up / laptop temperature bias. Runs stay serial.
    ordered = list(threads[::2]) + list(threads[1::2])
    return ordered if round_index % 2 == 0 else list(reversed(ordered))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--threads", nargs="+", type=int, default=[1, 2, 4, 8])
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--thread-field", help="Also set this optional request field per run")
    parser.add_argument("--load-note", default="Serial measurements; other host activity is not controlled")
    args = parser.parse_args()
    if args.rounds < 2 or not args.threads or min(args.threads) < 1 or len(set(args.threads)) != len(args.threads):
        parser.error("Use at least two rounds and distinct positive thread counts")
    if 1 not in args.threads:
        parser.error("Include one thread to measure the baseline")
    output = args.output_dir or Path(tempfile.mkdtemp(prefix="printflow-thread-scaling-"))
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("Output directory must be empty; prior evidence is never overwritten")
    document = json.loads(args.input.read_text(encoding="utf-8"))
    request = document.get("request", document)
    write_json(output / "frozen-request.json", request)
    cache = output / "mask-cache"
    runs = []
    print(f"Evidence: {output}", flush=True)

    def run(threads, objective, round_index, *, warmup=False):
        label = f"warmup-{objective}" if warmup else f"round-{round_index + 1:02d}-{objective}-{threads:02d}-threads"
        directory = output / label
        frozen_input = output / "frozen-request.json"
        if args.thread_field:
            frozen_input = output / f"request-{threads:02d}-threads.json"
            write_json(frozen_input, dict(request, **{args.thread_field: threads}))
        command = [sys.executable, "-B", str(PROFILE), "--input", str(frozen_input),
                   "--output-dir", str(directory), "--backend", "rust", "--objective", objective,
                   "--cache-dir", str(cache), "--cache-mode", "cold" if warmup else "warm",
                   "--no-profile", "--load-note", args.load_note]
        environment = dict(os.environ, PRINTFLOW_NESTING_CORE="rust", PRINTFLOW_NESTING_THREADS=str(threads))
        with (output / f"{label}.stdout.log").open("w", encoding="utf-8") as stream:
            process = subprocess.run(command, cwd=ROOT, env=environment, stdout=stream,
                                     stderr=subprocess.STDOUT, check=False)
        report_file = directory / "report.json"
        if not report_file.exists():
            raise RuntimeError(f"Benchmark process failed without a report: {label}, exit={process.returncode}")
        report = json.loads(report_file.read_text(encoding="utf-8"))
        actual_threads = (report.get("searchCore") or {}).get("threads")
        if process.returncode or not report.get("passed") or actual_threads != threads:
            raise RuntimeError(f"Invalid measurement {label}: passed={report.get('passed')}, "
                               f"requestedThreads={threads}, actualThreads={actual_threads}; see {report_file}")
        validation = report["validation"]
        row = dict(round=round_index + 1, objective=objective, requestedThreads=threads,
                   actualThreads=actual_threads, solverSeconds=report["solverSeconds"],
                   cpuSeconds=report["cpuSeconds"], searchCore=report["searchCore"],
                   validation=validation, cacheAudit=report["cacheAudit"],
                   processMemory=report.get("processMemory"), report=str(report_file),
                   implementationSha256=report["implementationSha256"],
                   nativeLibrarySha256=report["nativeLibrary"]["sha256"],
                   configuration=report["configuration"])
        print(f"{label}: {row['solverSeconds']:.3f}s; {validation['placementCount']} QT; "
              f"{validation['sheetsUsed']} boards; {validation['templates']} templates; "
              f"Rust workers={actual_threads}", flush=True)
        if not warmup:
            runs.append(row)
            write_json(output / "measurements.json", runs)
        return row

    warmup = run(1, "material", -1, warmup=True)
    for round_index in range(args.rounds):
        objectives = ("material", "uniform") if round_index % 2 == 0 else ("uniform", "material")
        for threads in alternating_order(args.threads, round_index):
            for objective in objectives:
                run(threads, objective, round_index)

    summaries = []
    for objective in ("material", "uniform"):
        matching = [r for r in runs if r["objective"] == objective]
        baseline = statistics.median(r["solverSeconds"] for r in matching if r["requestedThreads"] == 1)
        placements_identical = len({r["validation"]["placementSha256"] for r in matching}) == 1
        for threads in sorted(args.threads):
            samples = [r for r in matching if r["requestedThreads"] == threads]
            times = [r["solverSeconds"] for r in samples]
            median = statistics.median(times)
            summaries.append(dict(objective=objective, threads=threads, seconds=times,
                                  medianSeconds=median, speedupVsOneThread=baseline / median,
                                  placementCount=samples[0]["validation"]["placementCount"],
                                  sheetsUsed=samples[0]["validation"]["sheetsUsed"],
                                  templates=samples[0]["validation"]["templates"],
                                  allThreadCountsHaveIdenticalPlacements=placements_identical))
    sources_unchanged = len({canonical_hash(r["implementationSha256"]) for r in [warmup, *runs]}) == 1
    native_unchanged = len({r["nativeLibrarySha256"] for r in [warmup, *runs]}) == 1
    result = dict(completedAt=datetime.now(timezone.utc).isoformat(), host=platform.platform(),
                  logicalCpus=os.cpu_count(), inputFile=str(args.input.resolve()),
                  inputSha256=sha256(args.input), frozenRequestSha256=canonical_hash(request),
                  measurementScriptSha256=sha256(__file__), rounds=args.rounds,
                  sourceCount=len(request["items"]), quantity=sum(i.get("quantity", 1) for i in request["items"]),
                  spacingMm=request["spacingMm"], seed=0, resolutionMm=.5,
                  loadNote=args.load_note, implementationUnchanged=sources_unchanged,
                  nativeLibraryUnchanged=native_unchanged, warmup=warmup,
                  summary=summaries, measurements=runs,
                  passed=sources_unchanged and native_unchanged and all(
                      s["allThreadCountsHaveIdenticalPlacements"] for s in summaries))
    write_json(output / "summary.json", result)
    print(json.dumps(dict(passed=result["passed"], summary=summaries, report=str(output / "summary.json")),
                     ensure_ascii=False, indent=2), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
