//! Read-only regression harness for the real PrintFlow SVG jobs.
//!
//! This is an ignored unit test so it can reuse the application library's
//! already compiled algorithm target. It reads local fixtures only and prints
//! metrics and asserts valid results; it never writes to production data.
//! SVG geometry is real. QT uses a deterministic synthetic 20/18/15/12/10/8/6/5
//! workload (1005 copies for the 84-asset ds fixture), not production quantities.
//!
//! Examples (PowerShell, from the repository root):
//!   $env:PRINTFLOW_REAL_QT = '1'
//!   $env:PRINTFLOW_REAL_MODE = 'local-tools' # the only supported engine
//!   $env:PRINTFLOW_REAL_JOB = 'ds'           # ds|backup (omit for both)
//!   $env:PRINTFLOW_REAL_LIMIT = '16'        # omit for every SVG in the job
//!   cargo test --manifest-path src-tauri/Cargo.toml --lib `
//!     real_nesting_job_test::real_ds_and_backup_jobs --no-default-features -- `
//!     --ignored --nocapture
//!
//! Set PRINTFLOW_REAL_REPORT_DIR to export a JSON request/result/metric report
//! (the default is %TEMP%/printflow-real-nesting).
//! Set PRINTFLOW_REAL_BACKFILL=1 for the optional, slower gap/backfill probes.

use super::{
    extract_svg_geometry, pack_irregular, NestItem, NestPlacement, NestRequest, NestResult,
};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

const PLATE_W: f64 = 300.0;
const PLATE_H: f64 = 464.0;
const EFFECTIVE_W: f64 = 285.0;
const EFFECTIVE_H: f64 = 440.0;
const RIGHT_MARGIN: f64 = 5.0;
const SPACING: f64 = 3.0;

#[derive(Debug)]
struct SvgAsset {
    id: String,
    path: PathBuf,
    width: f64,
    height: f64,
    polygon: Vec<[f64; 2]>,
    line_only: bool,
}

fn attr_mm(source: &str, name: &str) -> f64 {
    let marker = format!("{name}=\"");
    let start = source.find(&marker).map(|i| i + marker.len()).unwrap_or(0);
    let rest = &source[start..];
    let end = rest.find('"').unwrap_or(0);
    rest[..end].trim_end_matches("mm").parse().unwrap_or(0.0)
}

fn read_asset(path: PathBuf) -> Result<SvgAsset, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let source = String::from_utf8_lossy(&bytes);
    let width = attr_mm(&source, "width");
    let height = attr_mm(&source, "height");
    let geometry = extract_svg_geometry(&path, width, height)?;
    let id = path.file_stem().unwrap().to_string_lossy().to_string();
    Ok(SvgAsset {
        id,
        path,
        width,
        height,
        polygon: geometry.polygon,
        line_only: geometry.line_only,
    })
}

fn request(items: Vec<NestItem>, algorithm: &str) -> NestRequest {
    NestRequest {
        plate_width_mm: PLATE_W,
        plate_height_mm: PLATE_H,
        effective_width_mm: EFFECTIVE_W,
        effective_height_mm: EFFECTIVE_H,
        effective_right_mm: RIGHT_MARGIN,
        spacing_mm: SPACING,
        objective: std::env::var("PRINTFLOW_REAL_OBJECTIVE")
            .unwrap_or_else(|_| "least-material".into()),
        irregular_algorithm: algorithm.into(),
        template_repack: None,
        allow_base_mixing: false,
        thread_count: None,
        items,
    }
}

fn rect_bounds(p: &NestPlacement) -> (f64, f64, f64, f64) {
    let (sin, cos) = p.rotation_deg.to_radians().sin_cos();
    let w = p.width_mm * cos.abs() + p.height_mm * sin.abs();
    let h = p.width_mm * sin.abs() + p.height_mm * cos.abs();
    (p.x_mm, p.y_mm, p.x_mm + w, p.y_mm + h)
}

/// Transform one source contour into the same top-down millimetre coordinates
/// exposed by `NestPlacement`: x/y are the rotated full image frame's AABB,
/// not the contour bounds; SVG and canvas both use a downward positive Y.
fn placement_polygon(placement: &NestPlacement, item: &NestItem) -> Vec<[f64; 2]> {
    let polygon = item.polygon.as_deref().unwrap_or(&[]);
    let angle = placement.rotation_deg.to_radians();
    let (sin, cos) = angle.sin_cos();
    let rotated = polygon
        .iter()
        .map(|point| {
            [
                cos.mul_add(point[0], -(sin * point[1])),
                sin.mul_add(point[0], cos * point[1]),
            ]
        })
        .collect::<Vec<_>>();
    if rotated.is_empty() {
        return rotated;
    }
    let frame = [
        [0.0, 0.0],
        [item.width_mm, 0.0],
        [item.width_mm, item.height_mm],
        [0.0, item.height_mm],
    ]
    .map(|point| {
        [
            cos * point[0] - sin * point[1],
            sin * point[0] + cos * point[1],
        ]
    });
    let min_x = frame
        .iter()
        .map(|point| point[0])
        .fold(f64::INFINITY, f64::min);
    let min_y = frame
        .iter()
        .map(|point| point[1])
        .fold(f64::INFINITY, f64::min);
    rotated
        .into_iter()
        .map(|point| {
            [
                placement.x_mm + point[0] - min_x,
                placement.y_mm + point[1] - min_y,
            ]
        })
        .collect()
}

fn point_in_polygon(point: [f64; 2], polygon: &[[f64; 2]]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut inside = false;
    for index in 0..polygon.len() {
        let a = polygon[index];
        let b = polygon[(index + 1) % polygon.len()];
        if super::on_segment(a, b, point) {
            return true;
        }
        let crosses = (a[1] > point[1]) != (b[1] > point[1]);
        if crosses {
            let x = (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0];
            if point[0] < x {
                inside = !inside;
            }
        }
    }
    inside
}

fn segment_distance(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> f64 {
    fn point_segment_distance(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let length_squared = dx.mul_add(dx, dy * dy);
        if length_squared <= 1e-16 {
            return (point[0] - a[0]).hypot(point[1] - a[1]);
        }
        let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_squared;
        let t = t.clamp(0.0, 1.0);
        (point[0] - (a[0] + t * dx)).hypot(point[1] - (a[1] + t * dy))
    }
    if super::segments_intersect(a, b, c, d) {
        return 0.0;
    }
    point_segment_distance(a, c, d)
        .min(point_segment_distance(b, c, d))
        .min(point_segment_distance(c, a, b))
        .min(point_segment_distance(d, a, b))
}

fn polygon_bounds(points: &[[f64; 2]]) -> (f64, f64, f64, f64) {
    points.iter().fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |(x1, y1, x2, y2), point| {
            (
                x1.min(point[0]),
                y1.min(point[1]),
                x2.max(point[0]),
                y2.max(point[1]),
            )
        },
    )
}

fn bounds_distance(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> f64 {
    (a.0 - b.2)
        .max(b.0 - a.2)
        .max(0.0)
        .hypot((a.1 - b.3).max(b.1 - a.3).max(0.0))
}

// Only distances below the configured gap matter. Index right-hand edges so
// high-resolution contours do not require every edge against every other edge.
fn polygon_distance(left: &[[f64; 2]], right: &[[f64; 2]]) -> (bool, f64) {
    if left.len() < 3 || right.len() < 3 {
        return (false, f64::INFINITY);
    }
    let cell = |coordinate: f64| (coordinate / SPACING).floor() as i64;
    let mut edge_cells = HashMap::<(i64, i64), Vec<usize>>::new();
    for other in 0..right.len() {
        let a = right[other];
        let b = right[(other + 1) % right.len()];
        for x in cell(a[0].min(b[0]))..=cell(a[0].max(b[0])) {
            for y in cell(a[1].min(b[1]))..=cell(a[1].max(b[1])) {
                edge_cells.entry((x, y)).or_default().push(other);
            }
        }
    }
    let mut distance = f64::INFINITY;
    let mut checked = vec![usize::MAX; right.len()];
    for index in 0..left.len() {
        let a = left[index];
        let b = left[(index + 1) % left.len()];
        for x in cell(a[0].min(b[0]) - SPACING)..=cell(a[0].max(b[0]) + SPACING) {
            for y in cell(a[1].min(b[1]) - SPACING)..=cell(a[1].max(b[1]) + SPACING) {
                for &other in edge_cells.get(&(x, y)).into_iter().flatten() {
                    if checked[other] == index {
                        continue;
                    }
                    checked[other] = index;
                    let c = right[other];
                    let d = right[(other + 1) % right.len()];
                    distance = distance.min(segment_distance(a, b, c, d));
                    if distance <= 1e-9 {
                        return (true, 0.0);
                    }
                }
            }
        }
    }
    if point_in_polygon(left[0], right) || point_in_polygon(right[0], left) {
        return (true, 0.0);
    }
    (false, distance)
}

fn metrics(
    result: &NestResult,
    items: &[NestItem],
    contour_metrics: bool,
    probe_backfill: bool,
) -> (usize, usize, usize, usize, usize) {
    let mut overlaps = 0;
    let mut spacing_violations = 0;
    let mut out_of_bounds = 0;
    let mut duplicate = 0;
    let mut seen = HashSet::new();
    for p in &result.placements {
        if !seen.insert(p.id.clone()) {
            duplicate += 1;
        }
        let (x1, y1, x2, y2) = rect_bounds(p);
        let left = PLATE_W - RIGHT_MARGIN - EFFECTIVE_W;
        let top = (PLATE_H - EFFECTIVE_H) / 2.0;
        if x1 < left - 1e-6
            || y1 < top - 1e-6
            || x2 > left + EFFECTIVE_W + 1e-6
            || y2 > top + EFFECTIVE_H + 1e-6
        {
            out_of_bounds += 1;
        }
    }
    if contour_metrics {
        let by_id = items
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect::<std::collections::HashMap<_, _>>();
        let polygons = result
            .placements
            .iter()
            .map(|placement| {
                let base = placement.id.split("#qt-").next().unwrap_or(&placement.id);
                by_id
                    .get(base)
                    .map(|item| placement_polygon(placement, item))
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        let bounds = polygons
            .iter()
            .map(|polygon| polygon_bounds(polygon))
            .collect::<Vec<_>>();
        let mut per_sheet = HashMap::<usize, Vec<usize>>::new();
        for (index, placement) in result.placements.iter().enumerate() {
            per_sheet
                .entry(placement.sheet_index)
                .or_default()
                .push(index);
        }
        for sheet in per_sheet.values() {
            for (offset, &index) in sheet.iter().enumerate() {
                for &other in sheet.iter().skip(offset + 1) {
                    if bounds_distance(bounds[index], bounds[other]) + 0.01 >= SPACING {
                        continue;
                    }
                    let (intersects, distance) =
                        polygon_distance(&polygons[index], &polygons[other]);
                    if intersects {
                        overlaps += 1;
                    }
                    if distance + 0.01 < SPACING {
                        spacing_violations += 1;
                    }
                }
            }
        }
    } else {
        for (i, a) in result.placements.iter().enumerate() {
            let (ax1, ay1, ax2, ay2) = rect_bounds(a);
            for b in result.placements.iter().skip(i + 1) {
                if a.sheet_index != b.sheet_index {
                    continue;
                }
                let (bx1, by1, bx2, by2) = rect_bounds(b);
                if ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1 {
                    overlaps += 1;
                }
                let overlap_x = ax1 < bx2 && ax2 > bx1;
                let overlap_y = ay1 < by2 && ay2 > by1;
                let gap_x = (bx1 - ax2).max(ax1 - bx2).max(0.0);
                let gap_y = (by1 - ay2).max(ay1 - by2).max(0.0);
                if (overlap_x && gap_y + 0.01 < SPACING) || (overlap_y && gap_x + 0.01 < SPACING) {
                    spacing_violations += 1;
                }
            }
        }
    }
    if !probe_backfill {
        return (overlaps, spacing_violations, out_of_bounds, duplicate, 0);
    }
    // Conservative rectangular backfill probe. A hit is evidence that an
    // unplaced item fits into an earlier sheet's envelope gap with 3 mm clear.
    let by_id = items
        .iter()
        .map(|i| (i.id.as_str(), i))
        .collect::<std::collections::HashMap<_, _>>();
    let mut backfill = 0;
    let mut probes = Vec::<(&str, usize)>::new();
    for id in &result.unplaced {
        probes.push((id.as_str(), result.sheets_used));
    }
    for placement in &result.placements {
        if placement.sheet_index > 0 {
            probes.push((placement.id.as_str(), placement.sheet_index));
        }
    }
    for (id, max_sheet) in probes {
        let base = id.split("#qt-").next().unwrap_or(id);
        let Some(item) = by_id.get(base) else {
            continue;
        };
        'sheet: for sheet in 0..max_sheet.min(result.sheets_used) {
            let placed = result
                .placements
                .iter()
                .filter(|p| p.sheet_index == sheet)
                .collect::<Vec<_>>();
            let mut xs = vec![PLATE_W - RIGHT_MARGIN - EFFECTIVE_W];
            let mut ys = vec![(PLATE_H - EFFECTIVE_H) / 2.0];
            for p in &placed {
                let (x1, y1, x2, y2) = rect_bounds(p);
                xs.extend([x1, x2 + SPACING]);
                ys.extend([y1, y2 + SPACING]);
            }
            for rotated in [false, true] {
                let (w, h) = if rotated {
                    (item.height_mm, item.width_mm)
                } else {
                    (item.width_mm, item.height_mm)
                };
                for &x in &xs {
                    for &y in &ys {
                        let candidate = (x, y, x + w, y + h);
                        if candidate.2 > PLATE_W - RIGHT_MARGIN + 1e-6
                            || candidate.3 > (PLATE_H - EFFECTIVE_H) / 2.0 + EFFECTIVE_H + 1e-6
                        {
                            continue;
                        }
                        if placed.iter().all(|p| {
                            let (x1, y1, x2, y2) = rect_bounds(p);
                            candidate.0 >= x2 + SPACING
                                || candidate.2 + SPACING <= x1
                                || candidate.1 >= y2 + SPACING
                                || candidate.3 + SPACING <= y1
                        }) {
                            backfill += 1;
                            eprintln!("backfill_candidate id={} target_sheet={sheet}", id);
                            break 'sheet;
                        }
                    }
                }
            }
        }
    }
    (
        overlaps,
        spacing_violations,
        out_of_bounds,
        duplicate,
        backfill,
    )
}

fn cumulative_backfill(result: &NestResult, items: &[NestItem]) -> (usize, usize) {
    let by_id = items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut sheets = (0..result.sheets_used)
        .map(|sheet| {
            result
                .placements
                .iter()
                .filter(|p| p.sheet_index == sheet)
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let left = PLATE_W - RIGHT_MARGIN - EFFECTIVE_W;
    let top = (PLATE_H - EFFECTIVE_H) / 2.0;
    let mut moved = 0;
    for source in (1..sheets.len()).collect::<Vec<_>>() {
        let mut cursor = 0;
        while cursor < sheets[source].len() {
            let target = sheets[source][cursor].clone();
            let base = target.id.split("#qt-").next().unwrap_or(&target.id);
            let Some(item) = by_id.get(base) else {
                cursor += 1;
                continue;
            };
            let mut destination = None;
            'dest: for dest in 0..source {
                let existing = &sheets[dest];
                let mut xs = vec![left];
                let mut ys = vec![top];
                for p in existing {
                    let (x1, y1, x2, y2) = rect_bounds(p);
                    xs.extend([x1, x2 + SPACING]);
                    ys.extend([y1, y2 + SPACING]);
                }
                for rotated in [false, true] {
                    let (w, h, rotation) = if rotated {
                        (item.height_mm, item.width_mm, 90.0)
                    } else {
                        (item.width_mm, item.height_mm, 0.0)
                    };
                    for &x in &xs {
                        for &y in &ys {
                            if x + w > left + EFFECTIVE_W + 0.01 || y + h > top + EFFECTIVE_H + 0.01
                            {
                                continue;
                            }
                            if existing.iter().all(|p| {
                                let (x1, y1, x2, y2) = rect_bounds(p);
                                x >= x2 + SPACING - 0.01
                                    || x + w <= x1 - SPACING + 0.01
                                    || y >= y2 + SPACING - 0.01
                                    || y + h <= y1 - SPACING + 0.01
                            }) {
                                destination = Some((dest, x, y, rotation));
                                break 'dest;
                            }
                        }
                    }
                }
            }
            if let Some((dest, x, y, rotation)) = destination {
                let mut moved_target = sheets[source].remove(cursor);
                moved_target.sheet_index = dest;
                moved_target.x_mm = x;
                moved_target.y_mm = y;
                moved_target.rotation_deg = rotation;
                sheets[dest].push(moved_target);
                moved += 1;
            } else {
                cursor += 1;
            }
        }
    }
    let nonempty = sheets.iter().filter(|sheet| !sheet.is_empty()).count();
    (moved, nonempty)
}

fn assert_real_result(
    result: &NestResult,
    items: &[NestItem],
    metrics: (usize, usize, usize, usize, usize),
) {
    assert!(
        !result.placements.is_empty(),
        "real fixture produced no placements; exclusions={:?}",
        result.excluded_items
    );
    let expected = items
        .iter()
        .flat_map(|item| {
            (1..=item.quantity).map(move |copy| {
                if copy == 1 {
                    item.id.clone()
                } else {
                    format!("{}#qt-{copy}", item.id)
                }
            })
        })
        .collect::<HashSet<_>>();
    let mut accounted = HashSet::new();
    for id in result
        .placements
        .iter()
        .map(|placement| &placement.id)
        .chain(result.unplaced.iter())
    {
        assert!(
            accounted.insert(id.clone()),
            "QT copy appears more than once in placements/unplaced: {id}"
        );
    }
    assert_eq!(
        accounted, expected,
        "every requested QT copy must be placed or explicitly unplaced"
    );
    for placement in &result.placements {
        assert!(
            [
                placement.x_mm,
                placement.y_mm,
                placement.width_mm,
                placement.height_mm,
                placement.rotation_deg
            ]
            .iter()
            .all(|number| number.is_finite()),
            "placement contains non-finite geometry: {}",
            placement.id
        );
        assert!(
            placement.sheet_index < result.sheets_used,
            "placement references a missing sheet: {}",
            placement.id
        );
    }
    let used = result
        .placements
        .iter()
        .map(|placement| placement.sheet_index)
        .collect::<HashSet<_>>();
    assert_eq!(
        used.len(),
        result.sheets_used,
        "result contains empty sheets"
    );
    assert_eq!(metrics.0, 0, "placed contours overlap");
    assert_eq!(metrics.1, 0, "placed contours violate the 3 mm spacing");
    assert_eq!(metrics.2, 0, "placements extend beyond the effective area");
    assert_eq!(metrics.3, 0, "duplicate placement IDs");
}

fn run_fixture(dir: &Path, quantities: bool) {
    let mut paths = fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|v| v.to_str()) == Some("svg"))
        .collect::<Vec<_>>();
    paths.sort();
    if let Some(limit) = std::env::var("PRINTFLOW_REAL_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
    {
        paths.truncate(limit);
    }
    let assets = paths
        .into_iter()
        .filter_map(|p| read_asset(p).ok())
        .collect::<Vec<_>>();
    let items = assets
        .iter()
        .enumerate()
        .map(|(i, a)| NestItem {
            id: a.id.clone(),
            width_mm: a.width,
            height_mm: a.height,
            quantity: if quantities {
                [20, 18, 15, 12, 10, 8, 6, 5][i % 8]
            } else {
                1
            },
            line_only: a.line_only,
            polygon: Some(a.polygon.clone()),
        })
        .collect::<Vec<_>>();
    let total: usize = items.iter().map(|i| i.quantity as usize).sum();
    assert!(
        !items.is_empty(),
        "real fixture contains no readable assets: {}",
        dir.display()
    );
    eprintln!(
        "fixture={} assets={} total_qt={} contours={} first_asset={}",
        dir.display(),
        items.len(),
        total,
        items
            .iter()
            .map(|i| i.polygon.as_ref().map(Vec::len).unwrap_or(0))
            .sum::<usize>(),
        assets
            .first()
            .map(|a| a.path.display().to_string())
            .unwrap_or_default()
    );
    for item in &items {
        eprintln!(
            "asset id={} qt={} size={:.3}x{:.3}",
            item.id, item.quantity, item.width_mm, item.height_mm
        );
    }
    let mode_filter = std::env::var("PRINTFLOW_REAL_MODE").ok();
    let report_dir = std::env::var_os("PRINTFLOW_REAL_REPORT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("printflow-real-nesting"));
    if let Err(error) = fs::create_dir_all(&report_dir) {
        eprintln!("report_dir={} ERROR create={error}", report_dir.display());
    }
    for mode in ["local-tools"] {
        if mode_filter.as_deref().is_some_and(|filter| filter != mode) {
            continue;
        }
        let start = Instant::now();
        let nest_request = request(items.clone(), mode);
        let result = pack_irregular(nest_request.clone());
        let compute_elapsed_ms = start.elapsed().as_millis();
        match result {
            Ok(result) => {
                let validation_start = Instant::now();
                let contour_metrics = true;
                let probe_backfill =
                    std::env::var("PRINTFLOW_REAL_BACKFILL").is_ok_and(|value| value == "1");
                let m = metrics(&result, &items, contour_metrics, probe_backfill);
                let (moved, nonempty) = if probe_backfill {
                    cumulative_backfill(&result, &items)
                } else {
                    (0, result.sheets_used)
                };
                eprintln!("mode={mode} compute_ms={compute_elapsed_ms} placements={} sheets={} unplaced={} utilization={:.3} overlaps={} spacing_violations={} bounds={} duplicate={} backfill_candidates={} contour_metrics={}", result.placements.len(), result.sheets_used, result.unplaced.len(), result.utilization, m.0,m.1,m.2,m.3,m.4, contour_metrics);
                eprintln!(
                    "timing compute_ms={compute_elapsed_ms} validation_ms={}",
                    validation_start.elapsed().as_millis()
                );
                eprintln!("algorithm={}", result.algorithm);
                eprintln!(
                    "cumulative_backfill_moved={} estimated_nonempty_sheets={}",
                    moved, nonempty
                );
                let fixture_name = dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("fixture")
                    .replace([' ', '\\', '/'], "_");
                let report_path = report_dir.join(format!("{fixture_name}-{mode}.json"));
                let report = json!({
                    "fixture": dir.display().to_string(),
                    "mode": mode,
                    "computeMs": compute_elapsed_ms,
                    "request": nest_request,
                    "result": result,
                    "metrics": {
                        "overlaps": m.0,
                        "spacingViolations": m.1,
                        "outOfBounds": m.2,
                        "duplicateIds": m.3,
                        "backfillCandidates": m.4,
                        "cumulativeBackfillMoved": moved,
                        "estimatedNonemptySheets": nonempty,
                        "contourMetrics": contour_metrics,
                        "backfillProbed": probe_backfill,
                    },
                });
                match serde_json::to_vec_pretty(&report) {
                    Ok(bytes) => match fs::write(&report_path, bytes) {
                        Ok(()) => eprintln!("report={}", report_path.display()),
                        Err(error) => {
                            eprintln!("report={} ERROR write={error}", report_path.display())
                        }
                    },
                    Err(error) => {
                        eprintln!("report={} ERROR serialize={error}", report_path.display())
                    }
                }
                for sheet in 0..result.sheets_used {
                    let ids = result
                        .placements
                        .iter()
                        .filter(|placement| placement.sheet_index == sheet)
                        .map(|placement| placement.id.split("#qt-").next().unwrap_or(&placement.id))
                        .collect::<Vec<_>>();
                    eprintln!(
                        "sheet={sheet} placements={} ids={}",
                        ids.len(),
                        ids.join(",")
                    );
                }
                assert_real_result(&result, &items, m);
            }
            Err(e) => panic!(
                "mode={mode} ERROR elapsed_ms={} {e}",
                start.elapsed().as_millis()
            ),
        }
    }
}

#[test]
#[should_panic(expected = "real fixture produced no placements")]
fn real_result_validation_rejects_an_empty_success() {
    let result = NestResult {
        placements: Vec::new(),
        unplaced: vec!["valid-asset".into()],
        sheets_used: 0,
        utilization: 0.0,
        algorithm: "tools/local".into(),
        excluded_items: Vec::new(),
        warnings: Vec::new(),
    };
    let items = vec![NestItem {
        id: "valid-asset".into(),
        width_mm: 20.0,
        height_mm: 20.0,
        quantity: 1,
        line_only: false,
        polygon: None,
    }];
    assert_real_result(&result, &items, (0, 0, 0, 0, 0));
}

#[test]
#[should_panic(expected = "every requested QT copy must be placed or explicitly unplaced")]
fn real_result_validation_rejects_missing_qt_copies() {
    let result = NestResult {
        placements: vec![NestPlacement {
            id: "valid-asset".into(),
            sheet_index: 0,
            x_mm: 10.0,
            y_mm: 12.0,
            width_mm: 20.0,
            height_mm: 20.0,
            rotation_deg: 0.0,
        }],
        unplaced: Vec::new(),
        sheets_used: 1,
        utilization: 0.0,
        algorithm: "tools/local".into(),
        excluded_items: Vec::new(),
        warnings: Vec::new(),
    };
    let items = vec![NestItem {
        id: "valid-asset".into(),
        width_mm: 20.0,
        height_mm: 20.0,
        quantity: 2,
        line_only: false,
        polygon: None,
    }];
    assert_real_result(&result, &items, (0, 0, 0, 0, 0));
}

#[test]
#[ignore = "reads real local printflow-data fixtures; run explicitly for regression evidence"]
fn real_ds_and_backup_jobs() {
    let root = std::env::var_os("PRINTFLOW_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..\\printflow-data"));
    let quantities = std::env::var("PRINTFLOW_REAL_QT")
        .map(|v| v != "0")
        .unwrap_or(true);
    let job = std::env::var("PRINTFLOW_REAL_JOB").unwrap_or_default();
    if job != "backup" {
        run_fixture(&root.join("assets/ds_202610091159"), quantities);
    }
    if job != "ds" {
        run_fixture(
            &root.join("assets/Backup_of_naomi hannah_202610091507"),
            quantities,
        );
    }
}

#[test]
fn contour_metrics_do_not_flag_rotated_bbox_only_overlap() {
    let polygon = vec![[0.0, 0.0], [20.0, 0.0], [0.0, 20.0]];
    let items = vec![
        NestItem {
            id: "triangle-a".into(),
            width_mm: 20.0,
            height_mm: 20.0,
            quantity: 1,
            line_only: false,
            polygon: Some(polygon.clone()),
        },
        NestItem {
            id: "triangle-b".into(),
            width_mm: 20.0,
            height_mm: 20.0,
            quantity: 1,
            line_only: false,
            polygon: Some(polygon),
        },
    ];
    let result = NestResult {
        placements: vec![
            NestPlacement {
                id: "triangle-a".into(),
                sheet_index: 0,
                x_mm: 100.0,
                y_mm: 100.0,
                width_mm: 20.0,
                height_mm: 20.0,
                rotation_deg: 0.0,
            },
            NestPlacement {
                id: "triangle-b".into(),
                sheet_index: 0,
                x_mm: 118.0,
                y_mm: 118.0,
                width_mm: 20.0,
                height_mm: 20.0,
                rotation_deg: 90.0,
            },
        ],
        unplaced: Vec::new(),
        sheets_used: 1,
        utilization: 0.0,
        algorithm: "tools/test".into(),
        excluded_items: Vec::new(),
        warnings: Vec::new(),
    };
    let metrics = metrics(&result, &items, true, false);
    assert_eq!(
        metrics.0, 0,
        "contours do not intersect despite bbox overlap"
    );
    assert_eq!(
        metrics.1, 0,
        "contour gap is greater than the configured spacing"
    );
}
