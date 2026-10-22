//! Regression: cargo test --example verify_parallel_import
//! Benchmark: cargo run --release --example verify_parallel_import -- "input.svg" [repeats]
//! Imports read the source in place; neither assets nor history records are saved.
use app_lib::assets::{import_with_stage_workers, Asset};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Write},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

struct DigestWriter(Sha256);

impl Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// Stream the JSON into the digest instead of allocating another copy of a
// potentially large set of SVG assets just for the benchmark comparison.
fn asset_digest(assets: &[Asset]) -> String {
    let mut writer = DigestWriter(Sha256::new());
    serde_json::to_writer(&mut writer, assets).expect("serialize imported assets");
    format!("{:x}", writer.0.finalize())
}

#[derive(Default)]
struct Events {
    progress: Vec<(String, usize, usize)>,
    asset_ids: Vec<String>,
    generation_started: Option<Instant>,
}

fn assert_progress(events: &Events, expected_ids: &[String]) {
    assert_eq!(
        events.asset_ids, expected_ids,
        "asset callback order changed"
    );
    let mut last_parse = 0;
    let mut last_generate = 0;
    let mut generating = false;
    for (stage, completed, total) in &events.progress {
        assert!(*total > 0 && completed <= total, "invalid progress event");
        let previous = match stage.as_str() {
            "parse" => {
                assert!(!generating, "parse progress followed generation progress");
                &mut last_parse
            }
            "generate" => {
                generating = true;
                &mut last_generate
            }
            other => panic!("unexpected stage: {other}"),
        };
        assert!(*completed >= *previous, "{stage} progress moved backwards");
        *previous = *completed;
    }
    if !expected_ids.is_empty() {
        let (stage, completed, total) = events.progress.last().expect("progress events");
        assert_eq!(stage, "generate");
        assert_eq!(completed, total, "generation never reached completion");
    }
}

struct Run {
    digest: String,
    asset_ids: Vec<String>,
    count: usize,
    svg_bytes: usize,
    parse: Duration,
    generate: Duration,
    total: Duration,
}

fn measure(path: &Path, workers: usize) -> Run {
    let events = Mutex::new(Events::default());
    let started = Instant::now();
    let assets = import_with_stage_workers(
        path,
        "a",
        "auto",
        "parallel-import-benchmark",
        workers,
        |stage, completed, total| {
            let mut events = events.lock().unwrap();
            if stage == "generate" && events.generation_started.is_none() {
                events.generation_started = Some(Instant::now());
            }
            events.progress.push((stage.into(), completed, total));
        },
        |asset| events.lock().unwrap().asset_ids.push(asset.id.clone()),
    )
    .expect("import failed");
    let ended = Instant::now();
    let events = events.into_inner().unwrap();
    let asset_ids = assets
        .iter()
        .map(|asset| asset.id.clone())
        .collect::<Vec<_>>();
    assert_progress(&events, &asset_ids);
    let generation_started = events.generation_started.unwrap_or(ended);
    Run {
        digest: asset_digest(&assets),
        asset_ids,
        count: assets.len(),
        svg_bytes: assets.iter().map(|asset| asset.svg.len()).sum(),
        parse: generation_started.duration_since(started),
        generate: ended.duration_since(generation_started),
        total: ended.duration_since(started),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: verify_parallel_import <input.svg> [repeats]");
    let repeats: usize = args
        .next()
        .map(|value| value.parse().expect("invalid repeats"))
        .unwrap_or(2);
    assert!(repeats > 0, "repeats must be positive");
    let logical_cores = std::thread::available_parallelism().map_or(1, usize::from);
    let auto_workers = (logical_cores / 2).max(1);
    println!("logical_cores={logical_cores} auto_workers={auto_workers} repeats={repeats}");
    let mut sequential_total = Duration::ZERO;
    let mut parallel_total = Duration::ZERO;
    for round in 0..repeats {
        // Alternate order to reduce the bias from OS file/font caches.
        let order = if round % 2 == 0 {
            [1, auto_workers]
        } else {
            [auto_workers, 1]
        };
        let first = measure(Path::new(&path), order[0]);
        let second = measure(Path::new(&path), order[1]);
        assert_eq!(
            first.digest, second.digest,
            "serialized asset content changed"
        );
        assert_eq!(first.asset_ids, second.asset_ids, "import ordering changed");
        for (position, (workers, run)) in order.into_iter().zip([&first, &second]).enumerate() {
            let sequential = (round % 2 == 0) == (position == 0);
            if sequential {
                sequential_total += run.total;
            } else {
                parallel_total += run.total;
            }
            println!(
                "round={} mode={} workers={} assets={} svg_bytes={} parse_ms={:.1} generate_ms={:.1} total_ms={:.1}",
                round + 1, if sequential { "sequential" } else { "auto" }, workers,
                run.count, run.svg_bytes, run.parse.as_secs_f64() * 1000.0,
                run.generate.as_secs_f64() * 1000.0, run.total.as_secs_f64() * 1000.0,
            );
        }
    }
    println!(
        "equivalent=true sequential_mean_ms={:.1} auto_mean_ms={:.1} speedup={:.2}x",
        sequential_total.as_secs_f64() * 1000.0 / repeats as f64,
        parallel_total.as_secs_f64() * 1000.0 / repeats as f64,
        sequential_total.as_secs_f64() / parallel_total.as_secs_f64(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{io::Cursor, path::PathBuf, sync::mpsc, time::SystemTime};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(source: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "parallel-import-{}-{}.svg",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::write(&path, source).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn raster(width: u32, height: u32, format: image::ImageFormat) -> String {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([180, 60, 30]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        let mime = if format == image::ImageFormat::Png {
            "png"
        } else {
            "jpeg"
        };
        format!(
            "data:image/{mime};base64,{}",
            STANDARD.encode(bytes.into_inner())
        )
    }

    fn import(path: &Path, workers: usize, mode: &str) -> (Vec<Asset>, Events) {
        let events = Mutex::new(Events::default());
        let assets = import_with_stage_workers(
            path,
            "test-product",
            mode,
            "stable-request",
            workers,
            |stage, done, total| {
                events
                    .lock()
                    .unwrap()
                    .progress
                    .push((stage.into(), done, total))
            },
            |asset| events.lock().unwrap().asset_ids.push(asset.id.clone()),
        )
        .unwrap();
        let events = events.into_inner().unwrap();
        assert_progress(
            &events,
            &assets
                .iter()
                .map(|asset| asset.id.clone())
                .collect::<Vec<_>>(),
        );
        (assets, events)
    }

    fn assert_equivalent(path: &Path, mode: &str) -> Vec<Asset> {
        let (sequential, first_events) = import(path, 1, mode);
        let (parallel, second_events) = import(path, 4, mode);
        assert_eq!(
            serde_json::to_vec(&sequential).unwrap(),
            serde_json::to_vec(&parallel).unwrap()
        );
        assert_eq!(first_events.asset_ids, second_events.asset_ids);
        assert_eq!(first_events.progress, second_events.progress);
        parallel
    }

    #[test]
    fn split_raster_groups_keep_bytes_metadata_order_and_progress() {
        let png = raster(37, 59, image::ImageFormat::Png);
        let jpeg = raster(71, 43, image::ImageFormat::Jpeg);
        let source = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 2000 1000">
          <defs><clipPath id="cut"><rect width="8" height="18"/></clipPath></defs>
          <g id="图层_1">
            <g id="first" transform="translate(100 100) scale(2)"><image id="photo" width="10" height="20" preserveAspectRatio="none" clip-path="url(#cut)" href="{png}"/></g>
            <g id="second"><image id="back" x="400" y="100" width="20" height="10" preserveAspectRatio="none" href="{jpeg}"/></g>
            <g id="third"><rect x="700" y="100" width="50" height="80" fill="red"/></g>
            <g id="fourth" transform="translate(1000 100) rotate(12)"><rect width="60" height="70" fill="none" stroke="blue" stroke-width="2"/></g>
            <g id="fifth"><circle cx="1300" cy="150" r="30" fill="green"/></g>
            <g id="sixth"><path d="M1600 100 L1660 100 L1630 180 Z" fill="purple"/></g>
          </g>
        </svg>"##
        );
        let file = Fixture::new(&source);
        let assets = assert_equivalent(&file.0, "auto");
        assert_eq!(assets.len(), 6);
        assert_eq!(std::fs::read_to_string(&file.0).unwrap(), source);
        let photo_asset = assets
            .iter()
            .find(|asset| asset.svg.contains(&png))
            .unwrap();
        let photo = &photo_asset.source_images.as_ref().unwrap()[0];
        assert_eq!(
            (
                &*photo.node_id,
                photo.width_px,
                photo.height_px,
                &*photo.format
            ),
            ("photo", 37, 59, "PNG")
        );
        assert!((photo.width_mm.unwrap() - 2.0).abs() < 0.001);
        assert!((photo.height_mm.unwrap() - 4.0).abs() < 0.001);
        let back_asset = assets
            .iter()
            .find(|asset| asset.svg.contains(&jpeg))
            .unwrap();
        let back = &back_asset.source_images.as_ref().unwrap()[0];
        assert_eq!(
            (&*back.node_id, back.width_px, back.height_px, &*back.format),
            ("back", 71, 43, "JPEG")
        );
        assert!((back.width_mm.unwrap() - 2.0).abs() < 0.001);
        assert!((back.height_mm.unwrap() - 1.0).abs() < 0.001);
    }

    #[test]
    fn top_level_vector_groups_and_whole_import_are_equivalent() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="80mm" viewBox="0 0 1000 800"><g id="one"><rect x="10" y="10" width="40" height="80" fill="red"/></g><g id="two"><circle cx="300" cy="200" r="50" fill="blue"/></g><g id="three"><path d="M500 50 L580 50 L540 150 Z"/></g></svg>"#;
        let file = Fixture::new(source);
        assert_eq!(assert_equivalent(&file.0, "auto").len(), 3);
        let whole = assert_equivalent(&file.0, "whole");
        assert_eq!(whole.len(), 1);
        assert_eq!(whole[0].svg, source);
    }

    #[test]
    fn generic_scene_candidates_keep_outline_assignment_and_order() {
        let png = raster(10, 10, image::ImageFormat::Png);
        let mut source =
            String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="250" height="100"><g>"#);
        for (index, x) in [20, 90, 160].into_iter().enumerate() {
            // Images and their outlines are separate candidates without an
            // authored layer/group boundary. Their bounds may finish out of
            // order in the worker pool, but association must stay identical.
            source.push_str(&format!(r#"<image id="image-{index}" x="{x}" y="30" width="10" height="10" href="{png}"/><path d="M{} 29.8h10.4v10.4h-10.4z" fill="none" stroke="black" stroke-width="0.2"/>"#, x as f64 - 0.2));
        }
        source.push_str("</g></svg>");
        let file = Fixture::new(&source);
        let assets = assert_equivalent(&file.0, "auto");
        assert_eq!(assets.len(), 3);
        for (index, asset) in assets.iter().enumerate() {
            assert!(asset.svg.contains(&format!("id=\"image-{index}\"")));
            assert!(asset.svg.contains("<path"));
            assert_eq!(asset.source_images.as_ref().unwrap().len(), 1);
        }
        assert_eq!(std::fs::read_to_string(&file.0).unwrap(), source);
    }

    #[test]
    fn a_zero_worker_request_still_completes_as_a_single_worker() {
        let file = Fixture::new(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20"/></svg>"#,
        );
        let (single, _) = import(&file.0, 1, "auto");
        let (zero, _) = import(&file.0, 0, "auto");
        assert_eq!(
            serde_json::to_vec(&single).unwrap(),
            serde_json::to_vec(&zero).unwrap()
        );
    }

    #[test]
    fn empty_and_malformed_sources_return_errors_without_hanging() {
        for source in [
            "",
            "<svg><g></svg>",
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><rect width="1" height="1"/></svg>"#,
        ] {
            let file = Fixture::new(source);
            let (sender, receiver) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = import_with_stage_workers(
                    &file.0,
                    "",
                    "auto",
                    "error-test",
                    4,
                    |_, _, _| {},
                    |_| {},
                );
                sender.send(result.map(|assets| assets.len())).unwrap();
            });
            let result = receiver
                .recv_timeout(Duration::from_secs(15))
                .expect("invalid input import hung");
            worker.join().unwrap();
            assert!(result.is_err(), "invalid input was accepted: {source}");
        }
    }
}
