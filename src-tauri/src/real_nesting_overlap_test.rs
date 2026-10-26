//! Independent artwork-overlap check for a read-only real-job snapshot.
//!
//! Unlike contour validation, this renders the original SVG, including embedded
//! pictures and clip paths. A missing collision contour cannot make this check
//! pass. Run the ignored test explicitly with PRINTFLOW_OVERLAP_JOB pointing to
//! a JSON snapshot containing `id` and `images` (normal production image fields).
//! Reports and previews go to %TEMP%/printflow-overlap-repro; no job is modified.

use super::{
    extract_svg_geometry, pack_irregular, NestItem, NestPlacement, NestRequest, NestResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use tiny_skia::{Color, FilterQuality, Pixmap, PixmapPaint, Transform};

const PIXELS_PER_MM: f64 = 3.0;
const PLATE_WIDTH_MM: f64 = 300.0;
const PLATE_HEIGHT_MM: f64 = 464.0;
// Ignore only faint antialiasing fringes; opaque art is always tested.
const OCCUPIED_ALPHA: u8 = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    id: String,
    name: String,
    file_path: PathBuf,
    width_mm: f64,
    height_mm: f64,
    #[serde(default)]
    attributes: HashMap<String, Value>,
}

#[derive(Deserialize)]
struct Job {
    id: String,
    images: Vec<Asset>,
}

fn quantity(asset: &Asset) -> u32 {
    let qt = asset.attributes.get("QT");
    let value = qt
        .and_then(Value::as_u64)
        .or_else(|| {
            qt.and_then(Value::as_str)
                .and_then(|text| text.parse().ok())
        })
        .unwrap_or(1);
    assert!(
        value > 0 && value <= u32::MAX as u64,
        "invalid QT for {}",
        asset.id
    );
    value as u32
}

fn source_id(id: &str) -> &str {
    id.split("#qt-").next().unwrap()
}

fn write_json(path: &Path, value: &impl serde::Serialize) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn rasterize_source(asset: &Asset) -> Pixmap {
    let bytes = fs::read(&asset.file_path).unwrap();
    let options = usvg::Options {
        resources_dir: asset.file_path.parent().map(Path::to_owned),
        ..Default::default()
    };
    let tree = usvg::Tree::from_data(&bytes, &options)
        .unwrap_or_else(|error| panic!("cannot render {}: {error}", asset.id));
    let width = (asset.width_mm * PIXELS_PER_MM).ceil().max(1.0) as u32;
    let height = (asset.height_mm * PIXELS_PER_MM).ceil().max(1.0) as u32;
    let mut raster = Pixmap::new(width, height).unwrap();
    resvg::render(
        &tree,
        Transform::from_scale(
            width as f32 / tree.size().width(),
            height as f32 / tree.size().height(),
        ),
        &mut raster.as_mut(),
    );
    assert!(
        raster
            .pixels()
            .iter()
            .any(|pixel| pixel.alpha() > OCCUPIED_ALPHA),
        "the independent SVG raster is empty for {}",
        asset.id
    );
    // The tree (and its potentially large decoded embedded image) is dropped
    // here. Only this small board-resolution pixmap is cached for QT copies.
    raster
}

fn rasterize_placement(source: &Pixmap, placement: &NestPlacement) -> (i32, i32, Pixmap) {
    let (sin, cos) = placement.rotation_deg.to_radians().sin_cos();
    let width = placement.width_mm;
    let height = placement.height_mm;
    // x/y in NestPlacement are the rotated whole SVG frame's AABB, matching
    // Konva and PDF export. Do not align using the extracted collision contour.
    let min_x = (cos * width).min(0.0) + (-sin * height).min(0.0);
    let min_y = (sin * width).min(0.0) + (cos * height).min(0.0);
    let rotated_width = width * cos.abs() + height * sin.abs();
    let rotated_height = width * sin.abs() + height * cos.abs();
    let x = (placement.x_mm * PIXELS_PER_MM).floor() as i32;
    let y = (placement.y_mm * PIXELS_PER_MM).floor() as i32;
    let patch_width = ((placement.x_mm + rotated_width) * PIXELS_PER_MM).ceil() as i32 - x + 1;
    let patch_height = ((placement.y_mm + rotated_height) * PIXELS_PER_MM).ceil() as i32 - y + 1;
    let mut patch = Pixmap::new(patch_width as u32, patch_height as u32).unwrap();
    let sx = width * PIXELS_PER_MM / f64::from(source.width());
    let sy = height * PIXELS_PER_MM / f64::from(source.height());
    let transform = Transform::from_row(
        (cos * sx) as f32,
        (sin * sx) as f32,
        (-sin * sy) as f32,
        (cos * sy) as f32,
        ((placement.x_mm - min_x) * PIXELS_PER_MM - f64::from(x)) as f32,
        ((placement.y_mm - min_y) * PIXELS_PER_MM - f64::from(y)) as f32,
    );
    let paint = PixmapPaint {
        quality: FilterQuality::Bilinear,
        ..Default::default()
    };
    patch.draw_pixmap(0, 0, source.as_ref(), &paint, transform, None);
    (x, y, patch)
}

struct RasterCheck {
    preview: Pixmap,
    overlaps: BTreeMap<(String, String), usize>,
    outside_pixels: usize,
}

fn check_board(placements: &[&NestPlacement], sources: &HashMap<String, Pixmap>) -> RasterCheck {
    let width = (PLATE_WIDTH_MM * PIXELS_PER_MM).ceil() as u32;
    let height = (PLATE_HEIGHT_MM * PIXELS_PER_MM).ceil() as u32;
    let mut preview = Pixmap::new(width, height).unwrap();
    preview.fill(Color::WHITE);
    let mut owners = vec![usize::MAX; width as usize * height as usize];
    let mut overlaps = BTreeMap::new();
    let mut outside_pixels = 0;
    for (index, placement) in placements.iter().enumerate() {
        let source = sources.get(source_id(&placement.id)).unwrap();
        let (x, y, patch) = rasterize_placement(source, placement);
        for py in 0..patch.height() {
            for px in 0..patch.width() {
                let offset = py as usize * patch.width() as usize + px as usize;
                if patch.pixels()[offset].alpha() <= OCCUPIED_ALPHA {
                    continue;
                }
                let bx = x + px as i32;
                let by = y + py as i32;
                if bx < 0 || by < 0 || bx >= width as i32 || by >= height as i32 {
                    outside_pixels += 1;
                    continue;
                }
                let board_offset = by as usize * width as usize + bx as usize;
                let owner = owners[board_offset];
                if owner != usize::MAX && owner != index {
                    let pair = (placements[owner].id.clone(), placement.id.clone());
                    *overlaps.entry(pair).or_insert(0) += 1;
                } else {
                    owners[board_offset] = index;
                }
            }
        }
        preview.draw_pixmap(
            x,
            y,
            patch.as_ref(),
            &PixmapPaint::default(),
            Transform::identity(),
            None,
        );
    }
    RasterCheck {
        preview,
        overlaps,
        outside_pixels,
    }
}

fn board_key(placements: &[&NestPlacement]) -> Vec<String> {
    let mut key = placements
        .iter()
        .map(|placement| {
            format!(
                "{}|{:.6}|{:.6}|{:.6}|{:.6}|{:.6}",
                source_id(&placement.id),
                placement.x_mm,
                placement.y_mm,
                placement.width_mm,
                placement.height_mm,
                placement.rotation_deg.rem_euclid(360.0),
            )
        })
        .collect::<Vec<_>>();
    key.sort();
    key
}

#[test]
fn independent_raster_check_detects_overlapping_art() {
    let mut source = Pixmap::new(30, 30).unwrap();
    source.fill(Color::BLACK);
    let sources = HashMap::from([("art".to_string(), source)]);
    let first = NestPlacement {
        id: "art".into(),
        sheet_index: 0,
        x_mm: 10.0,
        y_mm: 10.0,
        width_mm: 10.0,
        height_mm: 10.0,
        rotation_deg: 0.0,
    };
    let second = NestPlacement {
        id: "art#qt-2".into(),
        x_mm: 15.0,
        ..first.clone()
    };
    let bad = check_board(&[&first, &second], &sources);
    assert!(
        bad.overlaps.values().sum::<usize>() > 300,
        "independent raster check must reject visible artwork overlap even without polygons"
    );
    let clear = NestPlacement {
        x_mm: 23.0,
        ..second
    };
    let good = check_board(&[&first, &clear], &sources);
    assert!(good.overlaps.is_empty());
    assert_eq!(good.outside_pixels, 0);
}

#[test]
#[ignore = "reads real SVG fixtures and runs the full local nesting engine; explicit regression only"]
fn real_job_artwork_does_not_overlap() {
    let report_dir = std::env::var_os("PRINTFLOW_OVERLAP_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("printflow-overlap-repro"));
    fs::create_dir_all(&report_dir).unwrap();
    let job_path = std::env::var_os("PRINTFLOW_OVERLAP_JOB")
        .map(PathBuf::from)
        .unwrap_or_else(|| report_dir.join("job.json"));
    let job: Job = serde_json::from_slice(&fs::read(&job_path).unwrap()).unwrap();
    assert!(
        !job.images.is_empty(),
        "job snapshot must contain SVG assets"
    );
    let objective =
        std::env::var("PRINTFLOW_OVERLAP_OBJECTIVE").unwrap_or_else(|_| "least-cutting".into());
    assert!(["least-material", "least-cutting", "combined"].contains(&objective.as_str()));
    let started = Instant::now();
    let mut items = Vec::with_capacity(job.images.len());
    let mut geometries = Vec::with_capacity(job.images.len());
    let mut sources = HashMap::new();
    for (index, asset) in job.images.iter().enumerate() {
        eprintln!("SVG {}/{}: {}", index + 1, job.images.len(), asset.name);
        let geometry = extract_svg_geometry(&asset.file_path, asset.width_mm, asset.height_mm)
            .unwrap_or_else(|error| {
                panic!("invalid contour {} ({}): {error}", asset.id, asset.name)
            });
        geometries.push(json!({ "id": asset.id, "name": asset.name, "filePath": asset.file_path, "widthMm": asset.width_mm, "heightMm": asset.height_mm, "quantity": quantity(asset), "geometry": geometry }));
        items.push(NestItem {
            id: asset.id.clone(),
            width_mm: asset.width_mm,
            height_mm: asset.height_mm,
            quantity: quantity(asset),
            line_only: geometry.line_only,
            polygon: Some(geometry.polygon),
        });
        sources.insert(asset.id.clone(), rasterize_source(asset));
    }
    write_json(
        &report_dir.join(format!("{objective}-geometry.json")),
        &geometries,
    );
    let mut request = NestRequest {
        plate_width_mm: PLATE_WIDTH_MM,
        plate_height_mm: PLATE_HEIGHT_MM,
        effective_width_mm: 285.0,
        effective_height_mm: 440.0,
        effective_right_mm: 5.0,
        spacing_mm: 3.0,
        objective: objective.clone(),
        irregular_algorithm: "local-tools".into(),
        template_repack: None,
        allow_base_mixing: std::env::var("PRINTFLOW_OVERLAP_BASE_MIXING")
            .is_ok_and(|value| value == "1" || value == "true"),
        thread_count: std::env::var("PRINTFLOW_OVERLAP_THREADS")
            .ok()
            .map(|value| value.parse().expect("invalid test thread count")),
        items,
    };
    write_json(
        &report_dir.join(format!("{objective}-native-extracted-request.json")),
        &request,
    );
    // Tauri serializes extracted geometry to the UI and deserializes the
    // subsequent NestRequest. This opt-in read-only replay exposes numerical
    // changes at that JSON boundary instead of bypassing it in solver tests.
    if std::env::var("PRINTFLOW_OVERLAP_IPC_ROUNDTRIP").is_ok_and(|value| value == "1") {
        request = serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap();
    }
    write_json(
        &report_dir.join(format!("{objective}-request.json")),
        &request,
    );
    // Match pack_local_irregular's envelope serialization exactly. Rust's
    // validation keeps these valid items intact before forwarding the bytes.
    fs::write(
        report_dir.join(format!("{objective}-worker-input.json")),
        serde_json::to_vec(&json!({ "engine": "local-tools", "request": request })).unwrap(),
    )
    .unwrap();
    let expected_qt = request
        .items
        .iter()
        .map(|item| item.quantity as usize)
        .sum::<usize>();
    eprintln!(
        "Native contours and independent rasters ready: {} sources, {} QT, {:.2}s",
        request.items.len(),
        expected_qt,
        started.elapsed().as_secs_f64()
    );
    if let Some(root) = super::local_tool_root(None) {
        eprintln!(
            "Actual Rust-selected runtime: {}; Python: {:?}; base mixing: {}; threads: {:?}",
            root.display(),
            super::local_python(&root),
            request.allow_base_mixing,
            request.thread_count
        );
    }
    // Optionally replay a captured result, useful to establish a red baseline
    // from the exact old placements without modifying the production job.
    let result: NestResult = if let Some(path) = std::env::var_os("PRINTFLOW_OVERLAP_RESULT") {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    } else {
        pack_irregular(request.clone()).expect("real job nesting must succeed")
    };
    write_json(
        &report_dir.join(format!("{objective}-result.json")),
        &result,
    );
    let mut counts = HashMap::<&str, usize>::new();
    let mut ids = HashSet::new();
    let mut boards = BTreeMap::<usize, Vec<&NestPlacement>>::new();
    for placement in &result.placements {
        assert!(
            ids.insert(&placement.id),
            "duplicate QT id {}",
            placement.id
        );
        assert!(
            sources.contains_key(source_id(&placement.id)),
            "unknown source {}",
            placement.id
        );
        *counts.entry(source_id(&placement.id)).or_default() += 1;
        boards
            .entry(placement.sheet_index)
            .or_default()
            .push(placement);
    }
    assert!(
        result.unplaced.is_empty(),
        "unexpected unplaced QT: {:?}",
        result.unplaced
    );
    assert!(
        result.excluded_items.is_empty(),
        "unexpected excluded SVG: {:?}",
        result.excluded_items
    );
    assert_eq!(
        result.placements.len(),
        expected_qt,
        "retain the full actual job quantity"
    );
    for item in &request.items {
        assert_eq!(
            counts.get(item.id.as_str()).copied().unwrap_or(0),
            item.quantity as usize,
            "QT changed for {}",
            item.id
        );
    }
    assert_eq!(boards.len(), result.sheets_used);
    let mut unique = HashMap::<Vec<String>, usize>::new();
    let mut template_counts = Vec::new();
    let mut reports = Vec::new();
    let mut contact = Pixmap::new(920, 1412).unwrap();
    contact.fill(Color::from_rgba8(226, 232, 240, 255));
    let mut total_overlap_pixels = 0;
    let mut total_outside_pixels = 0;
    for (&sheet, placements) in &boards {
        let key = board_key(placements);
        if let Some(&index) = unique.get(&key) {
            template_counts[index] += 1usize;
            continue;
        }
        let index = unique.len();
        unique.insert(key, index);
        template_counts.push(1usize);
        let check = check_board(placements, &sources);
        let overlap_pixels = check.overlaps.values().sum::<usize>();
        total_overlap_pixels += overlap_pixels;
        total_outside_pixels += check.outside_pixels;
        let overlaps = check
            .overlaps
            .iter()
            .map(
                |((left, right), pixels)| json!({ "left": left, "right": right, "pixels": pixels }),
            )
            .collect::<Vec<_>>();
        eprintln!(
            "Template {} (sheet {}): {} items, {} overlapping pixels, {} outside pixels",
            index + 1,
            sheet + 1,
            placements.len(),
            overlap_pixels,
            check.outside_pixels
        );
        reports.push(json!({ "template": index + 1, "physicalSheet": sheet + 1, "placements": placements.len(), "overlapPixels": overlap_pixels, "outsidePixels": check.outside_pixels, "overlaps": overlaps }));
        if index < 4 || overlap_pixels > 0 {
            check
                .preview
                .save_png(report_dir.join(format!("{objective}-board-{:02}.png", index + 1)))
                .unwrap();
        }
        if index < 4 {
            let x = 5 + (index % 2) as i32 * 460;
            let y = 5 + (index / 2) as i32 * 706;
            contact.draw_pixmap(
                0,
                0,
                check.preview.as_ref(),
                &PixmapPaint {
                    quality: FilterQuality::Bilinear,
                    ..Default::default()
                },
                Transform::from_row(0.5, 0.0, 0.0, 0.5, x as f32, y as f32),
                None,
            );
        }
    }
    contact
        .save_png(report_dir.join(format!("{objective}-contact.png")))
        .unwrap();
    let report = json!({ "jobId": job.id, "objective": objective, "sourceCount": job.images.len(), "requestedQt": expected_qt, "placedQt": result.placements.len(), "sheets": result.sheets_used, "templates": unique.len(), "templateRepeatCounts": template_counts, "pixelsPerMm": PIXELS_PER_MM, "opaqueAlphaThreshold": OCCUPIED_ALPHA, "overlapPixels": total_overlap_pixels, "outsidePixels": total_outside_pixels, "elapsedSeconds": started.elapsed().as_secs_f64(), "boards": reports });
    write_json(
        &report_dir.join(format!("{objective}-raster-report.json")),
        &report,
    );
    eprintln!("Independent artwork report: {}", report_dir.display());
    assert_eq!(
        total_overlap_pixels, 0,
        "visible SVG artwork overlaps; inspect the raster report and board PNGs"
    );
    assert_eq!(
        total_outside_pixels, 0,
        "visible SVG artwork crosses a board boundary"
    );
}
