//! Exercise the actual importer without the WebView. No source files are modified.
fn main() {
    let path = std::env::args().nth(1).expect("SVG path required");
    let start = std::time::Instant::now();
    let assets = app_lib::assets::import_with_stage(std::path::Path::new(&path), "a", "auto", "verify-import",
        |phase, done, total| eprintln!("{phase} {done}/{total}"), |_| {}).expect("import failed");
    assert!(!assets.is_empty());
    assert!(assets.iter().all(|a| !a.svg.is_empty() && a.width > 0.0 && a.height > 0.0));
    println!("assets={} svg_bytes={} elapsed={:?}", assets.len(), assets.iter().map(|a| a.svg.len()).sum::<usize>(), start.elapsed());
}
