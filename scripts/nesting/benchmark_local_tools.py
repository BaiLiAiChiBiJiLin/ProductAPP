"""Run and independently verify the local-tools adapter against real SVGs.

Examples (from the repository root)::

    python scripts/nesting/benchmark_local_tools.py --objective material --limit 4 --quantity 1
    python scripts/nesting/benchmark_local_tools.py --objective uniform --quantity-mode synthetic
    python scripts/nesting/benchmark_local_tools.py --result path/to/result.json --svg-dir path/to/svgs

The input report supplies dimensions/QT only. Contours are freshly read from
the original SVGs in image-local millimetres, without subtracting their bounds.
The independent validator reconstructs the canvas transform from the complete
image frame, and checks true polygons with Shapely rather than raster masks.
Only the final JSON report is written to stdout. Solver progress stays in the
saved stderr log. No wall-clock timeout terminates the adapter.
Without --svg-dir, the first existing production asset directory is read.
Without --output-dir, reports go to a fresh directory under the system temp.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import copy
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "src-tauri/src/imposition/local_nesting"
from svg_benchmark_geometry import parse_sources  # noqa: E402
from shapely.geometry import Polygon, box  # noqa: E402

NS = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"
ET.register_namespace("", NS)
ET.register_namespace("xlink", XLINK)
TOLERANCE = 1e-5
QT_PATTERN = (20, 18, 15, 12, 10, 8, 6, 5)


def tag(name):
    return f"{{{NS}}}{name}"


def mm_length(value):
    match = re.fullmatch(r"\s*([+\-\d.eE]+)\s*(mm)?\s*", value or "")
    if not match:
        raise ValueError(f"Expected an SVG millimetre length, got {value!r}")
    result = float(match.group(1))
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"Invalid SVG dimension: {value!r}")
    return result


def qt_id(ident, ordinal):
    return ident if ordinal == 0 else f"{ident}#qt-{ordinal + 1}"


def source_cut_signature(root):
    """Conservative full cutting-geometry identity, including internal holes.

    Artwork image data and colour are excluded. Retaining SVG source geometry
    means mathematically equivalent but differently encoded contours can count
    as distinct templates; it cannot conflate two different inner hole paths.
    """
    shape_tags = {"path", "rect", "circle", "ellipse", "polygon", "polyline", "line"}
    geometric_attrs = {"d", "points", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "ry", "cx", "cy", "r"}
    shapes = []

    def walk(element, parents):
        transforms = parents + ([element.get("transform")] if element.get("transform") else [])
        local_tag = element.tag.rsplit("}", 1)[-1]
        if local_tag in shape_tags:
            classes = element.get("class", "").split()
            stroked = any("str" in name.lower() for name in classes) or element.get("stroke", "none") != "none" or "stroke:" in element.get("style", "")
            geometry = [local_tag, sorted((k, v) for k, v in element.attrib.items() if k in geometric_attrs), transforms]
            shapes.append((stroked, geometry))
        for child in element:
            walk(child, transforms)

    walk(root, [])
    relevant = [geometry for stroked, geometry in shapes if stroked]
    if not relevant:
        relevant = [geometry for _, geometry in shapes]
    encoded = json.dumps([root.get("width"), root.get("height"), root.get("viewBox"), relevant], separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def default_svg_directory():
    """Find existing production assets without creating or changing any order."""
    assets = ROOT / "printflow-data/assets"
    if assets.is_dir():
        for directory in sorted(assets.iterdir()):
            if directory.is_dir() and next(directory.glob("*.svg"), None) is not None:
                return directory
    raise ValueError("No production SVG directory found; pass --svg-dir explicitly")


def load_job(args):
    document = json.loads(args.input.read_text(encoding="utf-8")) if args.input else {}
    old_request = document.get("request", document)
    source_dir = args.svg_dir or (Path(document["fixture"]) if document.get("fixture") else default_svg_directory())
    source_dir = source_dir.resolve()
    old_items = old_request.get("items", [])
    file_by_id = {path.stem: path for path in sorted(source_dir.glob("*.svg"))}
    if not file_by_id:
        raise ValueError(f"No SVG sources found in {source_dir}")
    order = [str(item["id"]) for item in old_items] if old_items else list(file_by_id)
    if args.limit:
        order = order[:args.limit]
    missing = [ident for ident in order if ident not in file_by_id]
    if missing:
        raise ValueError(f"Missing real SVG assets: {missing}")
    parsed = parse_sources([file_by_id[ident] for ident in order])
    quantities = {str(item["id"]): int(item.get("quantity", 1)) for item in old_items}
    sources, items = {}, []
    for index, (ident, source) in enumerate(zip(order, parsed)):
        source["root"] = ET.parse(source["file"]).getroot()
        source["width"] = mm_length(source["root"].get("width"))
        source["height"] = mm_length(source["root"].get("height"))
        source["id"] = ident
        source["cut_signature"] = source_cut_signature(source["root"])
        if source["poly"].geom_type != "Polygon":
            raise ValueError(f"{ident}: multiple outer contours need an explicit protocol; refusing to discard them")
        quantity = args.quantity
        if quantity is None:
            if args.quantity_mode == "synthetic":
                quantity = QT_PATTERN[index % len(QT_PATTERN)]
            elif args.quantity_mode == "one":
                quantity = 1
            else:
                quantity = quantities.get(ident, 1)
        if quantity < 0:
            raise ValueError(f"Negative QT for {ident}")
        points = [list(p) for p in source["poly"].exterior.coords[:-1]]
        items.append(dict(id=ident, widthMm=source["width"], heightMm=source["height"],
                          quantity=quantity, polygon=points))
        sources[ident] = source
    request = {key: old_request.get(key, default) for key, default in (
        ("plateWidthMm", 300), ("plateHeightMm", 464),
        ("effectiveWidthMm", 285), ("effectiveHeightMm", 440),
        ("effectiveRightMm", 5), ("spacingMm", 3))}
    request.update(objective="least-cutting" if args.objective == "uniform" else "least-material",
                   irregularAlgorithm="local-tools", items=items)
    return request, sources, source_dir


def placement_transform(placement, source):
    """Recover R(p) + t from the top-left of the *rotated image* frame.

    This deliberately does not use the solver's transform helper or normalize
    the contour. Positive angles use the SVG/Konva downward-y coordinate plane.
    """
    angle = math.radians(float(placement["rotationDeg"]))
    cosine, sine = math.cos(angle), math.sin(angle)
    width, height = source["width"], source["height"]
    corners = ((0., 0.), (width, 0.), (width, height), (0., height))
    rotated = [(cosine * x - sine * y, sine * x + cosine * y) for x, y in corners]
    tx = float(placement["xMm"]) - min(x for x, _ in rotated)
    ty = float(placement["yMm"]) - min(y for _, y in rotated)
    matrix = (cosine, sine, -sine, cosine, tx, ty)
    frame = Polygon([(x + tx, y + ty) for x, y in rotated])
    points = [(cosine * x - sine * y + tx, sine * x + cosine * y + ty)
              for x, y in source["poly"].exterior.coords]
    return matrix, frame, Polygon(points)


def contour_signature(poly):
    # Ring start and winding do not change the physical cutting layout.
    points = [(round(x, 5), round(y, 5)) for x, y in poly.exterior.coords[:-1]]
    start = min(range(len(points)), key=points.__getitem__)
    forward = points[start:] + points[:start]
    reverse = [forward[0]] + list(reversed(forward[1:]))
    return min(forward, reverse)


def validate(request, result, sources):
    width = min(float(request["effectiveWidthMm"]), float(request["plateWidthMm"]) - float(request["effectiveRightMm"]))
    height = min(float(request["effectiveHeightMm"]), float(request["plateHeightMm"]))
    left = float(request["plateWidthMm"]) - float(request["effectiveRightMm"]) - width
    top = (float(request["plateHeightMm"]) - height) / 2
    region = box(left, top, left + width, top + height)
    gap = float(request["spacingMm"])
    expected = {qt_id(item["id"], copy_no): item["id"]
                for item in request["items"] for copy_no in range(item["quantity"])}
    received = Counter(str(p.get("id")) for p in result.get("placements", []))
    duplicate_ids = [ident for ident, count in received.items() if count > 1]
    unknown_ids = sorted(set(received) - set(expected))
    missing_ids = sorted(set(expected) - set(received))
    unplaced = list(result.get("unplaced", []))
    unaccounted = sorted(set(missing_ids) - set(unplaced))
    placed_and_unplaced = sorted(set(received).intersection(unplaced))
    boards = defaultdict(list)
    problems, overlap_pairs, spacing_pairs, frame_outside, contour_outside, mismatched_size = [], 0, 0, 0, 0, 0
    for placement in result.get("placements", []):
        ident = str(placement["id"])
        if ident not in expected:
            continue
        source = sources[expected[ident]]
        numbers = [placement[k] for k in ("xMm", "yMm", "rotationDeg", "widthMm", "heightMm")]
        if not all(math.isfinite(float(n)) for n in numbers):
            problems.append(dict(id=ident, problem="nonfinite_coordinate"))
            continue
        sheet = placement["sheetIndex"]
        if not isinstance(sheet, int) or sheet < 0:
            problems.append(dict(id=ident, problem="invalid_sheet", value=sheet))
            continue
        matrix, frame, poly = placement_transform(placement, source)
        if abs(float(placement["widthMm"]) - source["width"]) > TOLERANCE or abs(float(placement["heightMm"]) - source["height"]) > TOLERANCE:
            mismatched_size += 1
            problems.append(dict(id=ident, problem="source_dimensions_changed"))
        if not region.buffer(TOLERANCE).covers(frame):
            frame_outside += 1
            problems.append(dict(id=ident, problem="image_frame_outside", bounds=frame.bounds))
        if not region.buffer(TOLERANCE).covers(poly):
            contour_outside += 1
            problems.append(dict(id=ident, problem="true_contour_outside", bounds=poly.bounds))
        boards[sheet].append(dict(placement=placement, source=source, matrix=matrix, frame=frame, poly=poly))
    minimum_gap = math.inf
    templates, outer_templates, per_board = Counter(), Counter(), []
    for sheet, entries in sorted(boards.items()):
        board_gap = math.inf
        for i, entry in enumerate(entries):
            for other in entries[i + 1:]:
                a, b = entry["poly"], other["poly"]
                distance = a.distance(b)
                board_gap = min(board_gap, distance)
                overlap = a.intersection(b).area > 1e-7
                too_close = distance < gap - TOLERANCE
                overlap_pairs += int(overlap)
                spacing_pairs += int(too_close)
                if overlap or too_close:
                    problems.append(dict(sheet=sheet, ids=[entry["placement"]["id"], other["placement"]["id"]],
                                         problem="overlap" if overlap else "spacing", distanceMm=distance))
        minimum_gap = min(minimum_gap, board_gap)
        rings = sorted(contour_signature(entry["poly"]) for entry in entries)
        outer_signature = hashlib.sha256(json.dumps(rings, separators=(",", ":")).encode()).hexdigest()
        cutting_layout = sorted((entry["source"]["cut_signature"], tuple(round(v, 5) for v in entry["matrix"])) for entry in entries)
        signature = hashlib.sha256(json.dumps(cutting_layout, separators=(",", ":")).encode()).hexdigest()
        templates[signature] += 1
        outer_templates[outer_signature] += 1
        per_board.append(dict(sheetIndex=sheet, placements=len(entries),
                              utilization=sum(e["poly"].area for e in entries) / (width * height),
                              minimumContourGapMm=board_gap if math.isfinite(board_gap) else None,
                              cuttingTemplate=signature, outerContourTemplate=outer_signature))
    sheets_used = int(result.get("sheetsUsed", 0))
    empty_sheets = sorted(set(range(sheets_used)) - set(boards))
    outside_sheet_indices = sorted(set(boards) - set(range(sheets_used)))
    checks = dict(allRequestedPlaced=not missing_ids and not unknown_ids and not duplicate_ids,
                  allQuantityAccounted=not unaccounted and not unknown_ids and not placed_and_unplaced and not duplicate_ids,
                  noOverlap=overlap_pairs == 0, spacingMaintained=spacing_pairs == 0,
                  completeImageFrameInside=frame_outside == 0, trueContourInside=contour_outside == 0,
                  sourceDimensionsPreserved=mismatched_size == 0,
                  noEmptySheets=not empty_sheets and not outside_sheet_indices,
                  validCoordinates=not any(p["problem"] in ("nonfinite_coordinate", "invalid_sheet") for p in problems))
    return dict(passed=all(checks.values()), checks=checks, uniqueSources=len(request["items"]),
                requestedQuantity=len(expected), placedQuantity=sum(received.values()),
                sheetsUsed=sheets_used, nonemptySheets=len(boards), uniqueCuttingTemplates=len(templates),
                uniqueOuterContourTemplates=len(outer_templates),
                templateSignatureScope="all original SVG stroked geometry including internal holes; conservative source-geometry identity",
                templateRepeats=sorted(templates.values(), reverse=True),
                minimumContourGapMm=minimum_gap if math.isfinite(minimum_gap) else None,
                overlaps=overlap_pairs, spacingViolations=spacing_pairs, imageFrameOutOfBounds=frame_outside,
                contourOutOfBounds=contour_outside, duplicateIds=duplicate_ids, unknownIds=unknown_ids,
                missingIds=missing_ids, unaccountedIds=unaccounted, placedAndUnplaced=placed_and_unplaced,
                emptySheets=empty_sheets, invalidSheetIndices=outside_sheet_indices,
                excludedItems=result.get("excludedItems", []), problems=problems,
                boards=per_board), boards


def probe_gaps(request, result, sources, *, board_limit=4, source_limit=10, resolution=.5, rotation_step=15, sheet_indices=None):
    """Probe a bounded sample of later-board parts without changing the plan.

    OpenCV correlation is only a candidate filter on a 0.5 mm grid. Every
    reported insertion is independently checked against the original Shapely
    outlines and the full rotated image frame. Raster filtering can miss a
    narrow feasible position; finding no candidate is not an optimality proof.
    """
    import cv2
    import numpy as np

    started = time.perf_counter()
    width = min(float(request["effectiveWidthMm"]), float(request["plateWidthMm"]) - float(request["effectiveRightMm"]))
    height = min(float(request["effectiveHeightMm"]), float(request["plateHeightMm"]))
    left = float(request["plateWidthMm"]) - float(request["effectiveRightMm"]) - width
    top = (float(request["plateHeightMm"]) - height) / 2
    gap = float(request["spacingMm"])
    region = box(left, top, left + width, top + height)
    base_by_copy = {qt_id(item["id"], i): item["id"] for item in request["items"] for i in range(item["quantity"])}
    boards = defaultdict(list)
    for p in result.get("placements", []):
        source = sources[base_by_copy[p["id"]]]
        matrix, frame, poly = placement_transform(p, source)
        boards[p["sheetIndex"]].append(dict(placement=p, source=source, poly=poly))
    pad = int(math.ceil(gap / resolution)) + 3
    reports, counterexamples = [], []

    def rasterize(poly, shape, x_origin, y_origin):
        image = np.zeros(shape, np.uint8)
        geoms = [poly] if poly.geom_type == "Polygon" else list(poly.geoms)
        for geom in geoms:
            xy = np.rint([(float(x - x_origin) / resolution, float(y - y_origin) / resolution)
                          for x, y in geom.exterior.coords]).astype(np.int32)
            cv2.fillPoly(image, [xy], 1)
        return image

    selected_sheets = sorted(boards)[:board_limit] if sheet_indices is None else list(sheet_indices)[:board_limit]
    for sheet in selected_sheets:
        print(f"Gap probe: board {sheet + 1}, up to {source_limit} later-board sources", file=sys.stderr, flush=True)
        entries = boards[sheet]
        candidates = {}
        for later_sheet in sorted(boards):
            if later_sheet <= sheet:
                continue
            for entry in boards[later_sheet]:
                candidates.setdefault(entry["source"]["id"], entry)
        choices = sorted(candidates.values(), key=lambda e: (e["source"]["poly"].area, e["source"]["id"]))[:source_limit]
        rows = int(math.floor(height / resolution)) + 1 + 2 * pad
        cols = int(math.floor(width / resolution)) + 1 + 2 * pad
        occupancy = np.zeros((rows, cols), np.uint8)
        for entry in entries:
            occupancy |= rasterize(entry["poly"], occupancy.shape, left - pad * resolution, top - pad * resolution)
        probe = dict(sheetIndex=sheet, sourceIds=[e["source"]["id"] for e in choices],
                     attemptedSources=0, attemptedRotations=0, rasterCandidates=0, exactChecks=0, insertion=None)
        for donor in choices:
            source = donor["source"]
            probe["attemptedSources"] += 1
            for angle in range(0, 360, rotation_step):
                probe["attemptedRotations"] += 1
                candidate = dict(id=donor["placement"]["id"], sheetIndex=sheet,
                                 xMm=0., yMm=0., widthMm=source["width"], heightMm=source["height"], rotationDeg=angle)
                _, frame, rotated = placement_transform(candidate, source)
                frame_width = frame.bounds[2] - frame.bounds[0]
                frame_height = frame.bounds[3] - frame.bounds[1]
                if frame_width > width + TOLERANCE or frame_height > height + TOLERANCE:
                    continue
                clearance = rotated.buffer(gap)
                min_x, min_y, max_x, max_y = clearance.bounds
                mask_x = math.floor(min_x / resolution) * resolution
                mask_y = math.floor(min_y / resolution) * resolution
                mask_cols = int(math.ceil((max_x - mask_x) / resolution)) + 1
                mask_rows = int(math.ceil((max_y - mask_y) / resolution)) + 1
                if mask_cols > cols or mask_rows > rows:
                    continue
                mask = rasterize(clearance, (mask_rows, mask_cols), mask_x, mask_y)
                correlation = cv2.matchTemplate(occupancy, mask, cv2.TM_CCORR)
                ys, xs = np.nonzero(correlation < .5)
                probe["rasterCandidates"] += int(len(xs))
                for ix, iy in zip(xs, ys):
                    target_x = (int(ix) - pad) * resolution - mask_x
                    target_y = (int(iy) - pad) * resolution - mask_y
                    if target_x < -TOLERANCE or target_y < -TOLERANCE or target_x + frame_width > width + TOLERANCE or target_y + frame_height > height + TOLERANCE:
                        continue
                    candidate.update(xMm=left + target_x, yMm=top + target_y)
                    _, full_frame, true_poly = placement_transform(candidate, source)
                    probe["exactChecks"] += 1
                    if not region.buffer(TOLERANCE).covers(full_frame) or not region.buffer(TOLERANCE).covers(true_poly):
                        continue
                    distances = [true_poly.distance(entry["poly"]) for entry in entries]
                    if any(d < gap - TOLERANCE for d in distances):
                        continue
                    if any(true_poly.intersection(entry["poly"]).area > 1e-7 for entry in entries):
                        continue
                    insertion = dict(sourceId=source["id"], donorPlacementId=donor["placement"]["id"],
                                     donorSheetIndex=donor["placement"]["sheetIndex"],
                                     targetPlacement=dict(candidate), minimumContourGapMm=min(distances),
                                     imageFrameBoundsMm=full_frame.bounds)
                    probe["insertion"] = insertion
                    counterexamples.append(insertion)
                    break
                if probe["insertion"]:
                    break
            if probe["insertion"]:
                break
        reports.append(probe)
    return dict(elapsedSeconds=time.perf_counter() - started,
                scope=dict(firstBoards=board_limit, sheetIndices=selected_sheets, smallestLaterSourcesPerBoard=source_limit,
                           resolutionMm=resolution, angles=list(range(0, 360, rotation_step))),
                caveat="Bounded raster-filtered insertion probe with exact final geometry validation; no candidate does not prove global optimality. Result placements are not modified.",
                counterexamples=counterexamples, boards=reports)


def scoped_source(source, index):
    """Keep original artwork, definitions and image bytes; scope SVG references."""
    clone = copy.deepcopy(source["root"])
    prefix = f"source_{index}_"
    ids = {e.get("id"): prefix + e.get("id") for e in clone.iter() if e.get("id")}
    classes = {c for e in clone.iter() for c in (e.get("class") or "").split()}
    for element in clone.iter():
        for name, value in list(element.attrib.items()):
            if name == "id":
                value = ids[value]
            elif name == "class":
                value = " ".join(prefix + c for c in value.split())
            else:
                for old, new in ids.items():
                    value = value.replace(f"url(#{old})", f"url(#{new})")
                    if name.endswith("href") and value == f"#{old}":
                        value = f"#{new}"
            element.set(name, value)
        if element.tag == tag("style") and element.text:
            css = element.text
            for old, new in ids.items():
                css = re.sub(r"#" + re.escape(old) + r"(?![\w-])", "#" + new, css)
            for old in classes:
                css = re.sub(r"\." + re.escape(old) + r"(?![\w-])", "." + prefix + old, css)
            element.text = css
    clone.set("id", f"source_{index}")
    clone.set("width", str(source["width"]))
    clone.set("height", str(source["height"]))
    clone.set("x", "0")
    clone.set("y", "0")
    return clone


def render_preview(request, sources, board_entries, metrics, output, *, sheet_indices=None, name="preview-first-4"):
    indices = sorted(board_entries)[:4] if sheet_indices is None else list(sheet_indices)[:4]
    if not indices:
        return []
    width, height = float(request["plateWidthMm"]), float(request["plateHeightMm"])
    effective_w = min(float(request["effectiveWidthMm"]), width - float(request["effectiveRightMm"]))
    effective_h = min(float(request["effectiveHeightMm"]), height)
    left, top = width - float(request["effectiveRightMm"]) - effective_w, (height - effective_h) / 2
    by_metric = {b["sheetIndex"]: b for b in metrics["boards"]}

    def write_svg(sheet_indices, path):
        canvas_w, canvas_h = len(sheet_indices) * (width + 14) + 14, height + 36
        root = ET.Element(tag("svg"), dict(width=f"{canvas_w}mm", height=f"{canvas_h}mm",
                                           viewBox=f"0 0 {canvas_w} {canvas_h}", version="1.1"))
        ET.SubElement(root, tag("rect"), dict(width="100%", height="100%", fill="#f0f5f9"))
        ET.SubElement(root, tag("metadata")).text = json.dumps(dict(
            source="original SVG artwork; image-local millimetres; rotation without mirroring",
            spacingMm=request["spacingMm"], objective=request["objective"], sheets=sheet_indices))
        defs = ET.SubElement(root, tag("defs"))
        used = sorted({entry["source"]["id"] for sheet in sheet_indices for entry in board_entries[sheet]})
        refs = {ident: index for index, ident in enumerate(used)}
        for ident, index in refs.items():
            defs.append(scoped_source(sources[ident], index))
        for column, sheet in enumerate(sheet_indices):
            group = ET.SubElement(root, tag("g"), transform=f"translate({14 + column * (width + 14)},22)")
            ET.SubElement(group, tag("rect"), dict(width=str(width), height=str(height), fill="white", stroke="#cbd5e1", **{"stroke-width": ".3"}))
            label = ET.SubElement(group, tag("text"), dict(x=str(width / 2), y="-5", fill="#dc2626", **{
                "text-anchor": "middle", "font-family": "Microsoft YaHei, SimHei, sans-serif", "font-size": "4"}))
            label.text = f"利用率 {by_metric[sheet]['utilization']:.1%}"
            ET.SubElement(group, tag("rect"), dict(x=str(left), y=str(top), width=str(effective_w), height=str(effective_h),
                fill="none", stroke="#ef4444", **{"stroke-width": ".25", "stroke-dasharray": "1.5 1"}))
            for entry in board_entries[sheet]:
                matrix = "matrix(" + " ".join(f"{v:.14g}" for v in entry["matrix"]) + ")"
                ET.SubElement(group, tag("use"), {f"{{{XLINK}}}href": f"#source_{refs[entry['source']['id']]}",
                    "transform": matrix, "data-placement": entry["placement"]["id"],
                    "data-rotation": str(entry["placement"]["rotationDeg"])})
        ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
        return str(path.resolve())

    previews = [write_svg(indices, output / f"{name}.svg")]
    previews.extend(write_svg([sheet], output / f"board-{sheet + 1:03d}.svg") for sheet in indices)
    return previews


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--svg-dir", type=Path)
    parser.add_argument("--objective", choices=("material", "uniform"), default="material")
    parser.add_argument("--quantity-mode", choices=("report", "one", "synthetic"), default="report")
    parser.add_argument("--quantity", type=int)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--result", type=Path, help="Validate an existing adapter result without computing it again")
    parser.add_argument("--engine-python", default=sys.executable)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    output = (args.output_dir or Path(tempfile.mkdtemp(prefix=f"printflow-nesting-{args.objective}-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    implementation = {}
    for relative in ("src-tauri/src/imposition/local_nesting/local_tools_engine.py",
                     "src-tauri/src/imposition/local_nesting/nesting_common.py",
                     "src-tauri/src/imposition/local_nesting/nest_uniform.py",
                     "src-tauri/src/imposition/local_nesting/nesting_rust.py",
                     "src-tauri/src/imposition/local_nesting/rust_core/Cargo.toml",
                     "src-tauri/src/imposition/local_nesting/rust_core/Cargo.lock",
                     "src-tauri/src/imposition/local_nesting/rust_core/src/lib.rs",
                     "scripts/nesting/svg_benchmark_geometry.py",
                     "scripts/nesting/benchmark_local_tools.py"):
        path = ROOT / relative
        implementation[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    try:
        request, sources, source_dir = load_job(args)
        request_path = output / "request.json"
        request_path.write_text(json.dumps(request, ensure_ascii=True), encoding="utf-8")
        (output / "run-config.json").write_text(json.dumps(dict(
            startedAt=datetime.now().isoformat(), objective=args.objective,
            implementationSha256=implementation, sources=len(request["items"]),
            requestedQuantity=sum(item["quantity"] for item in request["items"])), indent=2), encoding="utf-8")
        result_path = output / "result.json"
        elapsed = None
        if args.result:
            result_doc = json.loads(args.result.read_text(encoding="utf-8"))
        else:
            solver_started = time.perf_counter()
            with result_path.open("w", encoding="utf-8") as stdout, (output / "solver-progress.log").open("w", encoding="utf-8") as stderr:
                process = subprocess.run([args.engine_python, "-B", str(RUNTIME / "local_tools_engine.py")],
                    input=json.dumps({"engine": "local-tools", "request": request}), text=True, encoding="utf-8",
                    stdout=stdout, stderr=stderr, cwd=ROOT, check=False)
            elapsed = time.perf_counter() - solver_started
            result_doc = json.loads(result_path.read_text(encoding="utf-8"))
            if process.returncode or result_doc.get("ok") is False:
                raise ValueError(f"Adapter failed: {result_doc}")
        result = result_doc.get("result", result_doc)
        result_path.write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
        validate_started = time.perf_counter()
        metrics, boards = validate(request, result, sources)
        validation_seconds = time.perf_counter() - validate_started
        previews = render_preview(request, sources, boards, metrics, output)
        distinct_sheets, seen_templates = [], set()
        for board in metrics["boards"]:
            if board["cuttingTemplate"] not in seen_templates:
                distinct_sheets.append(board["sheetIndex"])
                seen_templates.add(board["cuttingTemplate"])
        distinct_previews = render_preview(request, sources, boards, metrics, output,
            sheet_indices=distinct_sheets, name="preview-first-4-distinct-templates")
        report = dict(objective=args.objective, fixture=str(source_dir), quantityMode=args.quantity_mode,
                      inputContours="svg_benchmark_geometry.parse_sources adaptive SVG sampling plus buffer(0) repair, image-local mm without contour-origin normalization; repaired inputs can differ from Rust exclusions",
                      repairedInputContours=[ident for ident, source in sources.items() if source["invalid_repaired"]],
                      algorithm=result.get("algorithm"), solverSeconds=elapsed, validationSeconds=validation_seconds,
                      implementationSha256=implementation,
                      elapsedSeconds=time.perf_counter() - started, metrics=metrics,
                      files=dict(request=str(request_path), result=str(result_path), previews=previews,
                                 distinctTemplatePreviews=distinct_previews,
                                 progress=str(output / "solver-progress.log")))
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=True))
        return 0 if metrics["passed"] else 1
    except Exception as exc:
        failure = dict(passed=False, error=str(exc), elapsedSeconds=time.perf_counter() - started, outputDir=str(output))
        (output / "failure.json").write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(failure, ensure_ascii=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
