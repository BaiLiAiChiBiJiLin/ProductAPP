pub mod assets;
mod custom_products;
mod coreldraw;
mod fonts;
mod geometry;
mod compositor;
mod finish_matching;
mod product_config_cache;
pub mod svg_measure;
use assets::Asset;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, fs, io::{Cursor, Read}, path::PathBuf, sync::{Arc, Mutex}, time::Instant};
use pdf_writer::Finish;
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use base64::Engine;

const PRODUCT_CONFIGS_URL: &str = "https://edit.feykan.com/apps/keychain-designer/api/product-configs?shop=jqvxaw-fz.myshopify.com";
// The cached catalog is currently about 9 MB. Refuse unexpectedly large
// responses before collecting them in memory; this prevents a bad/proxy
// response from making reqwest reserve hundreds of megabytes at startup.
const MAX_PRODUCT_CONFIG_BYTES: usize = 32 * 1024 * 1024;
const MAX_REMOTE_IMAGE_BYTES: usize = 12 * 1024 * 1024;

fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("printflow.sqlite")).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, saved_at TEXT NOT NULL, payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
    // Metadata was added after the initial history schema. SQLite has no
    // portable IF NOT EXISTS form for ADD COLUMN, so ignore the duplicate
    // column error while keeping existing databases readable.
    let _ = conn.execute("ALTER TABLE batches ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'", []);
    Ok(conn)
}

fn flatten_embedded_svg_images(mut svg: String) -> Result<String, String> {
    let marker = "data:image/svg+xml;base64,";
    let mut instance = 0;
    loop {
        let Some(marker_pos_global) = svg.find(marker) else { break };
        let image_start = svg[..marker_pos_global].rfind("<image").ok_or("SVG 图片资源缺少 image 标签")?;
        let image_end = svg[image_start..].find('>').map(|i| image_start + i + 1).ok_or("SVG 图片标签不完整")?;
        let tag = &svg[image_start..image_end];
        let marker_pos = tag.find(marker).ok_or("SVG 图片资源位置无效")?;
        let encoded_start = marker_pos + marker.len();
        let encoded_end = tag[encoded_start..].find(['"', '\'', ')', ' ']).map(|i| encoded_start + i).unwrap_or(tag.len());
        let inner_svg = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(&tag[encoded_start..encoded_end]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let inner_svg = flatten_embedded_svg_images(inner_svg)?;
        // Each embedded image is an isolated SVG document. Resolve its CSS,
        // root transforms and resource references before combining documents;
        // repeated CorelDRAW clip IDs must never bind to a sibling artwork.
        let tree = usvg::Tree::from_str(&inner_svg, &assets::export_options()?)
            .map_err(|error| format!("嵌入 SVG 解析失败：{error}"))?;
        let inner_svg = tree.to_string(&usvg::WriteOptions {
            id_prefix: Some(format!("pf_embed_{instance}_")),
            ..Default::default()
        });
        instance += 1;
        // A valid viewBox already defines the coordinate system. Parsing the
        // complete artwork here decodes embedded images again for every copy.
        let view_box = if let Some(view_box) = embedded_svg_view_box(&inner_svg) { view_box } else {
            let tree = usvg::Tree::from_str(&inner_svg, &assets::export_options()?).map_err(|e| e.to_string())?;
            [0.0, 0.0, tree.size().width(), tree.size().height()]
        };
        let attr = |name: &str| tag.split_once(&format!("{}=\"", name)).and_then(|(_, rest)| rest.split_once('"').map(|(v, _)| v));
        let number = |name: &str| attr(name).unwrap_or("0").parse::<f32>().unwrap_or(0.0);
        let x = number("x"); let y = number("y"); let w = number("width"); let h = number("height");
        let [vx, vy, vw, vh] = view_box;
        let raw_x = w / vw.max(f32::EPSILON);
        let raw_y = h / vh.max(f32::EPSILON);
        let preserve = embedded_svg_attr(&inner_svg, "preserveAspectRatio").unwrap_or_else(|| "xMidYMid meet".into());
        let preserve_parts = preserve.split_whitespace().collect::<Vec<_>>();
        let preserve_none = preserve_parts.first().copied() == Some("none");
        let preserve_slice = preserve_parts.get(1).copied() == Some("slice");
        let align = preserve_parts.first().copied().unwrap_or("xMidYMid");
        let (scale_x, scale_y, offset_x, offset_y) = if preserve_none {
            (raw_x, raw_y, 0.0, 0.0)
        } else {
            let scale = if preserve_slice { raw_x.max(raw_y) } else { raw_x.min(raw_y) };
            let extra_x = w - vw * scale;
            let extra_y = h - vh * scale;
            let offset_x = if align.starts_with("xMin") { 0.0 } else if align.starts_with("xMax") { extra_x } else { extra_x / 2.0 };
            let offset_y = if align.ends_with("YMin") { 0.0 } else if align.ends_with("YMax") { extra_y } else { extra_y / 2.0 };
            (scale, scale, offset_x, offset_y)
        };
        let outer_transform = attr("transform").unwrap_or("").trim();
        let prefix = if outer_transform.is_empty() { format!("translate({x} {y})") } else { format!("{outer_transform} translate({x} {y})") };
        // Imported documents can start with an XML declaration, comments and
        // a DOCTYPE. The first '>' is not necessarily the SVG opening tag.
        let document = roxmltree::Document::parse_with_options(&inner_svg, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() })
            .map_err(|error| format!("嵌入 SVG 结构无效：{error}"))?;
        let root = document.root_element();
        let inner = root.children().map(|node| &inner_svg[node.range()]).collect::<String>();
        let namespaces = root.namespaces().map(|namespace| {
            let name = namespace.name().map(|name| format!(":{name}")).unwrap_or_default();
            let uri = namespace.uri().replace('&', "&amp;").replace('"', "&quot;");
            format!(" xmlns{name}=\"{uri}\"")
        }).collect::<String>();
        let replacement = format!("<g{namespaces} transform=\"{prefix} translate({offset_x} {offset_y}) scale({scale_x} {scale_y}) translate({} {})\">{inner}</g>", -vx, -vy);
        svg.replace_range(image_start..image_end, &replacement);
    }
    Ok(svg)
}

fn embedded_svg_attr(source: &str, name: &str) -> Option<String> {
    let document = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    document.root_element().attribute(name).map(str::to_owned)
}

fn embedded_svg_view_box(source: &str) -> Option<[f32; 4]> {
    let value = embedded_svg_attr(source, "viewBox")?;
    let values = value.replace(',', " ").split_whitespace().filter_map(|part| part.parse::<f32>().ok()).collect::<Vec<_>>();
    (values.len() == 4 && values[2] > 0.0 && values[3] > 0.0).then_some([values[0], values[1], values[2], values[3]])
}

/// usvg intentionally does not perform network I/O. Accessory images in the
/// product data are external URLs, so fetch them once here and turn them into
/// data URLs before parsing the page SVG. The cache also prevents downloading
/// the same accessory once per page.
fn embed_external_raster_images(mut svg: String, client: &reqwest::blocking::Client, cache: &mut HashMap<String, Option<String>>) -> Result<String, String> {
    let mut targets = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative_start) = svg[cursor..].find("<image") {
        let start = cursor + relative_start;
        let Some(relative_end) = svg[start..].find('>') else { break };
        let end = start + relative_end + 1;
        let tag = &svg[start..end];
        // Only the persisted accessory and note images emitted by PrintFlow
        // need downloading. Imported SVG artwork remains untouched.
        if !tag.contains("data-printflow-accessory=\"true\"") && !tag.contains("data-printflow-note=\"true\"") { cursor = end; continue }
        let href_marker = if tag.contains("href=\"") { "href=\"" } else if tag.contains("xlink:href=\"") { "xlink:href=\"" } else { cursor = end; continue };
        let Some(href_start) = tag.find(href_marker).map(|index| index + href_marker.len()) else { cursor = end; continue };
        let Some(href_end_relative) = tag[href_start..].find('"') else { cursor = end; continue };
        let href_end = href_start + href_end_relative;
        let url = tag[href_start..href_end].replace("&amp;", "&");
        if url.starts_with("http://") || url.starts_with("https://") { targets.push((start, end, href_start, href_end, url)); }
        cursor = end;
    }
    let pending = targets.iter().map(|(_, _, _, _, url)| url).filter(|url| !cache.contains_key(*url)).cloned().collect::<HashSet<_>>();
    let results = Arc::new(Mutex::new(HashMap::<String, Option<String>>::new()));
    std::thread::scope(|scope| {
        for url in pending {
            let client = client.clone();
            let results = Arc::clone(&results);
            scope.spawn(move || {
                let value = (|| {
                    let response = client.get(&url).send().ok()?;
                    if !response.status().is_success() { return None }
                    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).and_then(|value| value.split(';').next()).filter(|value| value.starts_with("image/")).unwrap_or("image/jpeg").to_string();
                    let bytes = response.bytes().ok()?;
                    // The accessory is rendered into a bounded slot on the A4 page. Keeping a
                    // multi-megapixel source unchanged makes PDF conversion needlessly slow;
                    // cap only oversized raster accessories while preserving the vector artwork.
                    let (bytes, mime) = if mime == "image/png" || mime == "image/jpeg" {
                        if let Ok(image) = image::load_from_memory(&bytes) {
                            if image.width().max(image.height()) > 768 {
                                let resized = image.thumbnail(768, 768);
                                let mut output = Cursor::new(Vec::new());
                                if resized.write_to(&mut output, image::ImageFormat::Png).is_ok() {
                                    (output.into_inner(), "image/png".to_string())
                                } else { (bytes.to_vec(), mime) }
                            } else { (bytes.to_vec(), mime) }
                        } else { (bytes.to_vec(), mime) }
                    } else { (bytes.to_vec(), mime) };
                    Some(format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(bytes)))
                })();
                if value.is_none() { log::warn!("配件图片下载超时或失败：{url}"); }
                results.lock().expect("image result lock poisoned").insert(url, value);
            });
        }
    });
    for (_, _, _, _, url) in &targets {
        if !cache.contains_key(url) {
            let value = results.lock().expect("image result lock poisoned").get(url).cloned().unwrap_or(None);
            cache.insert(url.clone(), value);
        }
    }
    if let Some(url) = targets.iter().map(|(_, _, _, _, url)| url).find(|url| cache.get(*url).is_some_and(|value| value.is_none())) {
        return Err(format!("配件图片加载失败：{url}"));
    }
    for (start, end, href_start, href_end, url) in targets.into_iter().rev() {
        let Some(Some(data_url)) = cache.get(&url).cloned() else { continue };
        let tag = &svg[start..end];
        let mut replacement = tag.to_string();
        replacement.replace_range(href_start..href_end, &data_url);
        svg.replace_range(start..end, &replacement);
    }
    Ok(svg)
}

#[cfg(test)]
mod export_tests {
    use super::flatten_embedded_svg_images;
    use super::{batch_signature, Asset, BatchMetadata};
    use crate::assets;
    use base64::Engine;

    #[test]
    fn flatten_accepts_xml_prolog_doctype_and_preserves_namespaces() {
        let inner = r##"<?xml version="1.0" encoding="UTF-8"?>
<!-- exported source -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><path id="shape" d="M0 0h10v10H0Z"/></defs><use xlink:href="#shape"/></svg>"##;
        let encoded = base64::engine::general_purpose::STANDARD.encode(inner);
        let page = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image x="0" y="0" width="100" height="100" href="data:image/svg+xml;base64,{encoded}"/></svg>"#);
        let flattened = flatten_embedded_svg_images(page).unwrap();
        assert!(!flattened.contains("DOCTYPE"));
        assert!(!flattened.contains("<?xml"));
        let parsed = roxmltree::Document::parse(&flattened).unwrap();
        assert!(parsed.descendants().any(|node| node.has_tag_name("path")));
        let tree = usvg::Tree::from_str(&flattened, &usvg::Options::default()).unwrap();
        assert!(!tree.root().children().is_empty());
    }

    #[test]
    #[ignore = "Run with scripts/prepare-pdf-benchmark.mjs output and a real batch"]
    fn real_batch_pdf_performance() {
        let path = std::env::var("PRINTFLOW_PDF_FIXTURE").unwrap_or_else(|_| "../.test-output/pdf-performance/pages.json".into());
        let mut pages: Vec<String> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let count = std::env::var("PRINTFLOW_PDF_PAGES").ok().and_then(|v| v.parse().ok()).unwrap_or(pages.len());
        pages.truncate(count);
        let limit: f64 = std::env::var("PRINTFLOW_PDF_LIMIT_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(30.0);
        let output = std::env::var("PRINTFLOW_PDF_OUTPUT").unwrap_or_else(|_| "../.test-output/pdf-performance/export.pdf".into());
        let started = std::time::Instant::now();
        let count = pages.len();
        tauri::async_runtime::block_on(super::export_pdf_for_test(output.clone(), pages)).expect("real batch export failed");
        let elapsed = started.elapsed().as_secs_f64();
        eprintln!("real PDF export: pages={count}, seconds={elapsed:.3}, bytes={}", std::fs::metadata(output).unwrap().len());
        assert!(elapsed <= limit, "Export took {elapsed:.3}s; budget is {limit}s");
    }

    #[test]
    fn batch_signature_stays_compact_for_large_asset_batches() {
        let assets = (0..80).map(|index| Asset {
            source_file_name: String::new(),
            id: format!("asset-{index}"), name: format!("图 {index}"), product_id: "a".into(), product_name: String::new(),
            width: 100.0, height: 100.0, source_group_width_mm: 0.0, source_group_height_mm: 0.0, source_group_bounds: [0.0; 4], svg: format!("<svg>{}</svg>", "x".repeat(1024 * 1024)), preview_url: String::new(), thumbnail_url: String::new(),
            storage_path: String::new(), mode_used: "groups".into(), merge_status: "kept-separate".into(), source_group_id: String::new(), attributes: Default::default(), attribute_images: Default::default(), note: String::new(), note_image: String::new(), attributes_confirmed: false, product_group_id: String::new(), product_group_color: String::new(), product_group_leader_id: String::new(), product_group_mode: String::new(), product_group_position: 0,
        }).collect::<Vec<_>>();
        let signature = batch_signature(&assets, &BatchMetadata::default()).unwrap();
        assert!(signature.len() < 100_000, "signature unexpectedly contains full SVG payload");
    }
    #[test]
    fn expands_nested_svg_images_to_vector_groups() {
        let inner = r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="red"/></svg>"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(inner);
        let page = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image x="5" y="6" width="20" height="20" href="data:image/svg+xml;base64,{encoded}"/></svg>"#);
        let flattened = flatten_embedded_svg_images(page).unwrap();
        assert!(flattened.contains("<path"));
        assert!(!flattened.contains("data:image/svg+xml"));
    }

    #[test]
    fn repeated_clip_ids_preserve_independent_artwork_pixels() {
        let first = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="clip"><rect x="10" y="10" width="30" height="80"/></clipPath></defs><rect width="100" height="100" fill="red" clip-path="url(#clip)"/></svg>"##;
        let second = first.replace("x=\"10\"", "x=\"60\"").replace("fill=\"red\"", "fill=\"blue\"");
        let page = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><image width="100" height="100" href="data:image/svg+xml;base64,{}"/><image x="100" width="100" height="100" href="data:image/svg+xml;base64,{}"/></svg>"#,
            base64::engine::general_purpose::STANDARD.encode(first), base64::engine::general_purpose::STANDARD.encode(second));
        let render = |source: &str| {
            let tree = usvg::Tree::from_str(source, &usvg::Options::default()).unwrap();
            let mut pixmap = tiny_skia::Pixmap::new(200, 100).unwrap();
            resvg::render(&tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
            pixmap
        };
        let original = render(&page);
        let flattened = flatten_embedded_svg_images(page).unwrap();
        let result = render(&flattened);
        assert_eq!(original.data(), result.data(), "embedded SVG clip resources leaked across artwork");
        let dir = std::path::Path::new("../.test-output/pdf-resource-regression");
        std::fs::create_dir_all(dir).unwrap();
        original.save_png(dir.join("reference.png")).unwrap();
        let tree = usvg::Tree::from_str(&flattened, &usvg::Options::default()).unwrap();
        let pdf = svg2pdf::to_pdf(&tree, Default::default(), Default::default()).unwrap();
        std::fs::write(dir.join("verified.pdf"), pdf).unwrap();
    }

    #[test]
    fn vector_pdf_parser_accepts_embedded_raster_accessory_images() {
        // 1x1 transparent PNG. This mirrors the data URL produced for a
        // downloaded Accessories Color image before SVG -> PDF conversion.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 500 707"><image x="20" y="20" width="40" height="40" href="data:image/png;base64,{png}"/></svg>"#);
        let tree = usvg::Tree::from_str(&svg, &assets::export_options().unwrap()).unwrap();
        let (chunk, _) = svg2pdf::to_chunk(&tree, svg2pdf::ConversionOptions::default()).unwrap();
        assert!(String::from_utf8_lossy(chunk.as_bytes()).contains("/Subtype /Image"), "accessory image must be embedded in the actual PDF converter output");
    }

    #[test]
    #[ignore = "Requires local imported assets; use real_batch_pdf_performance for full batch verification"]
    fn exports_real_asset_pages_for_visual_check() {
        use std::fs;
        let dir = std::path::Path::new("../printflow-data/assets");
        let files: Vec<_> = fs::read_dir(dir).unwrap().filter_map(Result::ok).filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("svg")).take(6).collect();
        assert!(!files.is_empty());
        let mut pages = Vec::new();
        for chunk in files.chunks(3) {
            let mut body = String::new();
            for (slot, entry) in chunk.iter().enumerate() {
                let source = fs::read_to_string(entry.path()).unwrap();
                let start = source.find('>').unwrap(); let end = source.rfind("</svg>").unwrap();
                body.push_str(&format!("<g transform=\"translate({} {}) scale(0.25)\">{}</g>", 40 + slot * 170, 180, &source[start + 1..end]));
            }
            let header = r##"<g font-family="Arial, sans-serif" fill="#202124"><rect x="5" y="5" width="490" height="105" fill="white" stroke="#111"/><text x="15" y="27" font-size="18" font-weight="700">ORDER PROOF</text><text x="15" y="49" font-size="15">Customer: Test Customer</text><text x="15" y="70" font-size="10">Please review the details below and confirm.</text><rect x="300" y="14" width="105" height="72" fill="white" stroke="#888"/><path d="M300 38h105M300 62h105M350 14v72" fill="none" stroke="#888"/><text x="305" y="30" font-size="8">Drawing Date</text><text x="355" y="30" font-size="8">9月12日</text><text x="305" y="54" font-size="8">Estimated Ship Date</text><text x="355" y="54" font-size="8">9月6日</text><text x="305" y="78" font-size="8">Designer</text><text x="355" y="78" font-size="8">Designer</text><rect x="414" y="14" width="70" height="72" fill="white" stroke="#111"/><text x="449" y="31" text-anchor="middle" font-size="8">Page</text><text x="449" y="58" text-anchor="middle" font-size="12">1 of 2</text></g>"##;
            let page_svg = flatten_embedded_svg_images(format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"210mm\" height=\"297mm\" viewBox=\"0 0 500 707\">{header}{body}</svg>")).unwrap();
            pages.push(page_svg);
        }
        fs::create_dir_all("../.test-output").unwrap();
        tauri::async_runtime::block_on(super::export_pdf_for_test("../.test-output/real-assets.pdf".into(), pages)).unwrap();
    }

}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress { request_id: String, phase: String, completed: usize, total: usize }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportProgress { phase: String, completed: usize, total: usize }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportAssetBatch { request_id: String, assets: Vec<Asset> }

fn project_data_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // `cargo run` and the Tauri dev runner may use `src-tauri` as the
    // working directory. Keep mutable import data beside the project instead
    // of under `src-tauri`, because Tauri watches that directory and would
    // restart the app for every streamed SVG asset written during a large
    // import.
    let base = if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        cwd.parent().map(PathBuf::from).unwrap_or(cwd)
    } else if cwd.ancestors().any(|path| path.file_name().and_then(|name| name.to_str()) == Some("src-tauri")) {
        // Also cover an executable launched with `src-tauri/target/...` as
        // its working directory.
        cwd.ancestors()
            .find(|path| path.file_name().and_then(|name| name.to_str()) == Some("src-tauri"))
            .and_then(|path| path.parent())
            .map(PathBuf::from)
            .unwrap_or(cwd)
    } else {
        cwd
    };
    base.join("printflow-data")
}

fn product_configs_cache_path() -> PathBuf {
    project_data_dir().join("cache").join("product-configs.json")
}

fn finish_catalog_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Refreshed catalogs override the bundled offline fallback in all builds.
    let local = project_data_dir().join("cache/finish.json");
    if local.is_file() { return Ok(local); }
    app.path().resolve("printflow-data/cache/finish.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("工艺资源路径不可用：{e}"))
}

async fn refresh_product_configs_inner() -> Result<(), String> {
    let started = Instant::now();
    log::info!(target: "printflow::product-configs", "产品配置请求开始");
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let response = client.get(PRODUCT_CONFIGS_URL)
        .header("Accept", "application/json")
        .send().await.map_err(|e| format!("产品选项请求失败：{e}"))?;
    if !response.status().is_success() { return Err(format!("产品选项请求返回 HTTP {}", response.status())); }
    if response.content_length().is_some_and(|length| length > MAX_PRODUCT_CONFIG_BYTES as u64) {
        return Err(format!("产品选项响应过大（上限 {} MB）", MAX_PRODUCT_CONFIG_BYTES / (1024 * 1024)));
    }
    let declared_length = response.content_length().unwrap_or(0) as usize;
    let mut bytes = Vec::with_capacity(declared_length.min(MAX_PRODUCT_CONFIG_BYTES));
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("产品选项读取失败：{e}"))? {
        if bytes.len().saturating_add(chunk.len()) > MAX_PRODUCT_CONFIG_BYTES {
            return Err(format!("产品选项响应过大（上限 {} MB）", MAX_PRODUCT_CONFIG_BYTES / (1024 * 1024)));
        }
        bytes.extend_from_slice(&chunk);
    }
    let path = product_configs_cache_path();
    let byte_count = bytes.len();
    let finish_count = tauri::async_runtime::spawn_blocking(move || product_config_cache::refresh(&path, &bytes))
        .await.map_err(|e| e.to_string())??;
    finish_matching::invalidate();
    log::info!(target: "printflow::product-configs", "产品配置及工艺缓存完成：bytes={} finish_items={} elapsed_ms={}", byte_count, finish_count, started.elapsed().as_millis());
    Ok(())
}

#[tauri::command]
async fn load_product_configs() -> Result<String, String> {
    let path = product_configs_cache_path();
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("产品选项缓存不可用：{e}"))?;
    let text = String::from_utf8(bytes).map_err(|e| format!("产品选项缓存不是 UTF-8：{e}"))?;
    // Keep the command's contract as raw JSON text. Tauri then copies one
    // compact string to the WebView and the frontend performs the only object
    // materialisation needed by the editor.
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    serde::de::IgnoredAny::deserialize(&mut deserializer).map_err(|e| format!("产品选项缓存解析失败：{e}"))?;
    deserializer.end().map_err(|e| format!("产品选项缓存解析失败：{e}"))?;
    Ok(text)
}

fn normalize_finish_key(value: &str) -> String {
    value.chars()
        .filter(|character| !character.is_whitespace() && *character != '_' && *character != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishCacheRecord {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    label_zh: Option<String>,
}

/// Return a compact lookup instead of sending the full finish catalog to the
/// WebView. Values are indexed by both the canonical name and its localized
/// label; the renderer always displays the canonical `name`.
#[tauri::command]
async fn load_finish_names(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = finish_catalog_path(&app)?;
        let bytes = fs::read(&path).map_err(|e| format!("Finish 缓存不可用：{e}"))?;
        let records: Vec<FinishCacheRecord> = serde_json::from_slice(&bytes).map_err(|e| format!("Finish 缓存解析失败：{e}"))?;
        let mut names = HashMap::with_capacity(records.len() * 2);
        for record in records {
            let Some(name) = record.name.as_deref().map(str::trim).filter(|value| !value.is_empty()) else { continue; };
            names.insert(normalize_finish_key(name), name.to_owned());
            if let Some(label) = record.label_zh.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                names.insert(normalize_finish_key(label), name.to_owned());
            }
        }
        Ok(names)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn refresh_product_configs() -> Result<(), String> { refresh_product_configs_inner().await }

fn safe_asset_file_name(id: &str) -> String {
    id.chars().map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') { ch } else { '_' }).collect()
}

fn compact_asset(asset: &Asset) -> Asset {
    let mut compact = asset.clone();
    compact.svg.clear();
    compact.preview_url.clear();
    compact.thumbnail_url.clear();
    compact
}

fn hydrate_asset(mut asset: Asset) -> Asset {
    if asset.svg.is_empty() && !asset.storage_path.is_empty() {
        if let Ok(svg) = fs::read_to_string(&asset.storage_path) { asset.svg = svg; }
    }
    asset
}

fn persist_assets(app_assets: Vec<Asset>) -> Result<Vec<Asset>, String> {
    let root = project_data_dir();
    let temp_dir = root.join("temp-assets");
    let asset_dir = root.join("assets");
    fs::create_dir_all(&asset_dir).map_err(|e| e.to_string())?;
    let mut persisted = Vec::with_capacity(app_assets.len());
    for asset in app_assets {
        let file_name = format!("{}.svg", safe_asset_file_name(&asset.id));
        let destination = asset_dir.join(file_name);
        let svg = if asset.svg.is_empty() && !asset.storage_path.is_empty() { fs::read_to_string(&asset.storage_path).map_err(|e| e.to_string())? } else { asset.svg.clone() };
        fs::write(&destination, svg.as_bytes()).map_err(|e| e.to_string())?;
        let mut saved = asset;
        saved.svg = svg;
        saved.storage_path = destination.to_string_lossy().to_string();
        persisted.push(saved);
    }
    // Temporary files are safe to remove only after every durable write has
    // succeeded. They are best-effort cleanup so a locked file cannot break a
    // successful save.
    if let Ok(entries) = fs::read_dir(&temp_dir) {
        for entry in entries.flatten() { let _ = fs::remove_file(entry.path()); }
    }
    Ok(persisted)
}

#[tauri::command]
async fn import_assets(app: tauri::AppHandle, path: String, product_id: String, mode: String, request_id: String) -> Result<Vec<Asset>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = project_data_dir().join("temp-assets");
        fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        let pending_assets: Arc<Mutex<Vec<Asset>>> = Arc::new(Mutex::new(Vec::with_capacity(8)));
        let pending_for_callback = Arc::clone(&pending_assets);
        let assets = assets::import_with_stage(&PathBuf::from(path), &product_id, &mode, &request_id, |phase, completed, total| {
            let _ = app.emit("import-progress", ImportProgress { request_id: request_id.clone(), phase: phase.to_owned(), completed, total });
        }, |asset| {
            let temp_path = temp_dir.join(format!("{}.svg", safe_asset_file_name(&asset.id)));
            let mut streamed_asset = asset.clone();
            if fs::write(&temp_path, asset.svg.as_bytes()).is_ok() { streamed_asset.storage_path = temp_path.to_string_lossy().to_string(); }
            let batch = {
                let Ok(mut pending) = pending_for_callback.lock() else { return };
                pending.push(streamed_asset);
                if pending.len() >= 8 { std::mem::take(&mut *pending) } else { Vec::new() }
            };
            if !batch.is_empty() { let _ = app.emit("import-asset-batch", ImportAssetBatch { request_id: request_id.clone(), assets: batch }); }
        })?;
        if let Ok(mut pending) = pending_assets.lock() {
            if !pending.is_empty() { let batch = std::mem::take(&mut *pending); let _ = app.emit("import-asset-batch", ImportAssetBatch { request_id: request_id.clone(), assets: batch }); }
        }
        Ok(assets)
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct Workspace { assets: Vec<Asset>, pages: Option<String> }

#[tauri::command]
async fn load_workspace(app: tauri::AppHandle) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = database(&app)?;
        let mut stmt = conn.prepare("SELECT payload FROM assets ORDER BY rowid").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut assets = Vec::new();
        for row in rows { assets.push(hydrate_asset(serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?)); }
        let pages = conn.query_row("SELECT payload FROM workspace WHERE id=1", [], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        Ok(Workspace { assets, pages })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_workspace(app: tauri::AppHandle, pages: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::from_str::<serde_json::Value>(&pages).map_err(|e| e.to_string())?;
        database(&app)?.execute("INSERT INTO workspace(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [pages]).map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_asset(app: tauri::AppHandle, id: String, batch_id: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = database(&app)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        if let Some(batch_id) = batch_id {
            let payload: Option<String> = tx
                .query_row("SELECT payload FROM batches WHERE id=?1", [&batch_id], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(payload) = payload {
                let mut assets: Vec<Asset> = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
                assets.retain(|asset| asset.id != id);
                let compact: Vec<_> = assets.iter().map(compact_asset).collect();
                tx.execute(
                    "UPDATE batches SET payload=?1 WHERE id=?2",
                    params![serde_json::to_string(&compact).map_err(|e| e.to_string())?, batch_id],
                ).map_err(|e| e.to_string())?;
            }
        }

        // Keep an asset row while another saved batch still references it.
        let mut referenced_elsewhere = false;
        let mut stmt = tx.prepare("SELECT payload FROM batches").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for row in rows {
            let value = row.map_err(|e| e.to_string())?;
            if let Ok(other) = serde_json::from_str::<Vec<Asset>>(&value) {
                if other.iter().any(|asset| asset.id == id) { referenced_elsewhere = true; break; }
            }
        }
        drop(stmt);
        if !referenced_elsewhere {
            tx.execute("DELETE FROM assets WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

/// Fetch remote catalog images inside the desktop process. WebView image
/// requests are subject to the source server's CORS policy; returning a data
/// URL makes the same image available to Konva and the SVG/PDF exporter.
#[tauri::command]
async fn fetch_remote_image(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "远程图片地址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err("远程图片只支持 HTTP/HTTPS".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(20))
            .build().map_err(|e| format!("远程图片客户端初始化失败：{e}"))?;
        let response = client.get(parsed).send().map_err(|e| format!("远程图片读取失败：{e}"))?;
        if !response.status().is_success() { return Err(format!("远程图片返回 HTTP {}", response.status())); }
        if response.content_length().is_some_and(|size| size > MAX_REMOTE_IMAGE_BYTES as u64) { return Err("远程图片超过 12 MB 限制".into()); }
        let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).and_then(|value| value.split(';').next())
            .filter(|value| value.starts_with("image/")).unwrap_or("image/png").to_string();
        let bytes = response.bytes().map_err(|e| format!("远程图片读取失败：{e}"))?;
        if bytes.len() > MAX_REMOTE_IMAGE_BYTES { return Err("远程图片超过 12 MB 限制".into()); }
        Ok(format!("data:{content_type};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchMetadata {
    #[serde(default)]
    customer_name: String,
    #[serde(default)]
    drawing_date: String,
    #[serde(default)]
    estimated_ship_date: String,
    #[serde(default = "default_designer")]
    designer: String,
}

fn default_designer() -> String { "张三".into() }

impl Default for BatchMetadata {
    fn default() -> Self { Self { customer_name: String::new(), drawing_date: String::new(), estimated_ship_date: String::new(), designer: default_designer() } }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchRecord { id: String, saved_at: String, assets: Vec<Asset>, metadata: BatchMetadata }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveBatchResult { assets: Vec<Asset>, duplicate: bool, batch_id: String, metadata: BatchMetadata }

/// Build a stable batch identity from the actual asset content and its
/// product metadata. Generated ids, preview URLs and storage paths are
/// deliberately excluded because re-importing the same files creates new
/// transient ids and paths.
fn batch_signature(assets: &[Asset], metadata: &BatchMetadata) -> Result<String, String> {
    fn fnv1a(bytes: &[u8]) -> u64 {
        let mut hash = 0xcbf29ce484222325u64;
        for byte in bytes { hash ^= *byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
        hash
    }
    fn asset_digest(asset: &Asset) -> Result<(u64, u64), String> {
        if !asset.svg.is_empty() {
            return Ok((fnv1a(asset.svg.as_bytes()), asset.svg.len() as u64));
        }
        if asset.storage_path.is_empty() { return Ok((0, 0)); }
        let mut file = fs::File::open(&asset.storage_path).map_err(|e| e.to_string())?;
        let mut hash = 0xcbf29ce484222325u64;
        let mut size = 0u64;
        let mut buffer = [0u8; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 { break; }
            size += read as u64;
            for byte in &buffer[..read] { hash ^= *byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
        }
        Ok((hash, size))
    }
    let identities: Vec<_> = assets.iter().map(|asset| -> Result<serde_json::Value, String> {
        let (svg_hash, svg_bytes) = asset_digest(asset)?;
        Ok(serde_json::json!({
            "name": asset.name,
            "productId": asset.product_id,
            "productName": asset.product_name,
            "width": asset.width,
            "height": asset.height,
            "sourceGroupWidthMm": asset.source_group_width_mm,
            "sourceGroupHeightMm": asset.source_group_height_mm,
            "sourceGroupBounds": asset.source_group_bounds,
            "svgHash": format!("{svg_hash:016x}"),
            "svgBytes": svg_bytes,
            "attributes": asset.attributes,
            "note": asset.note,
            "noteImage": asset.note_image,
            "attributesConfirmed": asset.attributes_confirmed,
            "productGroupId": asset.product_group_id,
            "productGroupColor": asset.product_group_color,
            "productGroupLeaderId": asset.product_group_leader_id,
            "productGroupMode": asset.product_group_mode,
            "productGroupPosition": asset.product_group_position,
            "modeUsed": asset.mode_used,
            "mergeStatus": asset.merge_status,
            "sourceGroupId": asset.source_group_id,
        }))
    }).collect::<Result<Vec<_>, String>>()?;
    serde_json::to_string(&(metadata, identities)).map_err(|e| e.to_string())
}

fn remove_temp_asset_files(assets: &[Asset]) {
    for asset in assets {
        if asset.storage_path.contains("printflow-data\\temp-assets") || asset.storage_path.contains("printflow-data/temp-assets") {
            let _ = fs::remove_file(&asset.storage_path);
        }
    }
}

#[tauri::command]
async fn save_batch(app: tauri::AppHandle, id: String, saved_at: String, assets: Vec<Asset>, metadata: Option<BatchMetadata>) -> Result<SaveBatchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut assets = assets;
        finish_matching::fill(&mut assets, &finish_catalog_path(&app)?)?;
        let metadata = metadata.unwrap_or_default();
        let signature_started = Instant::now();
        let incoming_signature = batch_signature(&assets, &metadata)?;
        log::info!("save_batch phase=signature assets={} elapsed_ms={}", assets.len(), signature_started.elapsed().as_millis());
        let conn = database(&app)?;
        // An opened/current batch is an edit session. Its stable id must win
        // over content-based duplicate detection, otherwise changing one
        // product/attribute could redirect the save to another history row.
        let current_exists = conn.query_row(
            "SELECT 1 FROM batches WHERE id = ?1 LIMIT 1",
            params![id],
            |_| Ok(()),
        ).optional().map_err(|e| e.to_string())?.is_some();
        if !current_exists {
            let mut stmt = conn.prepare("SELECT id,saved_at,payload,metadata FROM batches ORDER BY saved_at DESC LIMIT 20").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                let payload: String = row.get(2)?;
                let metadata: String = row.get(3)?;
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, payload, metadata))
            }).map_err(|e| e.to_string())?;
            for row in rows {
                let (existing_id, _existing_saved_at, payload, metadata_json) = row.map_err(|e| e.to_string())?;
                let existing_assets: Vec<Asset> = serde_json::from_str(&payload).unwrap_or_default();
                let existing_metadata: BatchMetadata = serde_json::from_str(&metadata_json).unwrap_or_default();
                let Ok(existing_signature) = batch_signature(&existing_assets, &existing_metadata) else { continue };
                if existing_signature == incoming_signature {
                    remove_temp_asset_files(&assets);
                    let compact: Vec<_> = existing_assets.into_iter().map(|asset| compact_asset(&hydrate_asset(asset))).collect();
                    return Ok(SaveBatchResult { assets: compact, duplicate: true, batch_id: existing_id, metadata: existing_metadata });
                }
            }
        }
        let persist_started = Instant::now();
        let persisted = persist_assets(assets)?;
        log::info!("save_batch phase=persist assets={} elapsed_ms={}", persisted.len(), persist_started.elapsed().as_millis());
        let compact: Vec<_> = persisted.iter().map(compact_asset).collect();
        let payload = serde_json::to_string(&compact).map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for asset in &compact {
            tx.execute("INSERT INTO assets(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![asset.id, serde_json::to_string(asset).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO batches(id,saved_at,payload,metadata) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET saved_at=excluded.saved_at,payload=excluded.payload,metadata=excluded.metadata", params![id, saved_at, payload, serde_json::to_string(&metadata).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        let compact_result: Vec<_> = persisted.iter().map(compact_asset).collect();
        Ok(SaveBatchResult { assets: compact_result, duplicate: false, batch_id: id, metadata })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn persist_batch_assets(app: tauri::AppHandle, assets: Vec<Asset>) -> Result<Vec<Asset>, String> {
    tauri::async_runtime::spawn_blocking(move || { let persisted = persist_assets(assets)?; let compact: Vec<_> = persisted.iter().map(compact_asset).collect(); let conn = database(&app)?; let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?; for asset in &compact { tx.execute("INSERT INTO assets(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![asset.id, serde_json::to_string(asset).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?; } tx.commit().map_err(|e| e.to_string())?; Ok(persisted) }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn discard_temp_assets(assets: Vec<Asset>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for asset in assets {
            if asset.storage_path.contains("printflow-data\\temp-assets") || asset.storage_path.contains("printflow-data/temp-assets") { let _ = fs::remove_file(asset.storage_path); }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_batches(app: tauri::AppHandle) -> Result<Vec<BatchRecord>, String> {
    // History cards only need ids, names and counts. Never hydrate the SVG
    // files here: the assets table can contain hundreds of megabytes and this
    // command runs during application startup.
    tauri::async_runtime::spawn_blocking(move || {
        let conn = database(&app)?;
        let mut stmt = conn.prepare("SELECT id,saved_at,payload,metadata FROM batches ORDER BY saved_at DESC LIMIT 20").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            let payload: String = row.get(2)?;
            let metadata: String = row.get(3)?;
            let assets: Vec<Asset> = serde_json::from_str(&payload).unwrap_or_default();
            Ok(BatchRecord { id: row.get(0)?, saved_at: row.get(1)?, assets: assets.into_iter().map(|asset| compact_asset(&asset)).collect(), metadata: serde_json::from_str(&metadata).unwrap_or_default() })
        }).map_err(|e| e.to_string())?;
        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_batch(app: tauri::AppHandle, id: String) -> Result<BatchRecord, String> {
    // Hydrate only the batch the user explicitly opened. This keeps startup
    // cheap while preserving the original SVG data for editing and arranging.
    tauri::async_runtime::spawn_blocking(move || {
        let conn = database(&app)?;
        let row = conn.query_row("SELECT id,saved_at,payload,metadata FROM batches WHERE id=?1", [&id], |row| {
            let payload: String = row.get(2)?;
            let metadata: String = row.get(3)?;
            let assets: Vec<Asset> = serde_json::from_str(&payload).unwrap_or_default();
            Ok(BatchRecord { id: row.get(0)?, saved_at: row.get(1)?, assets: assets.into_iter().map(hydrate_asset).collect(), metadata: serde_json::from_str(&metadata).unwrap_or_default() })
        }).optional().map_err(|e| e.to_string())?;
        row.ok_or_else(|| "历史批次不存在或已被删除".to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_batch(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = database(&app)?;
        let payload: Option<String> = conn.query_row("SELECT payload FROM batches WHERE id=?1", [&id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        let Some(payload) = payload else { return Ok(()) };
        let assets: Vec<Asset> = serde_json::from_str(&payload).unwrap_or_default();
        let mut referenced = HashSet::new();
        let mut stmt = conn.prepare("SELECT payload FROM batches WHERE id<>?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for row in rows {
            if let Ok(other) = row.and_then(|value| serde_json::from_str::<Vec<Asset>>(&value).map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))) { for asset in other { referenced.insert(asset.id); } }
        }
        conn.execute("DELETE FROM batches WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
        for asset in assets {
            if referenced.contains(&asset.id) { continue; }
            conn.execute("DELETE FROM assets WHERE id=?1", [&asset.id]).map_err(|e| e.to_string())?;
            if asset.storage_path.contains("printflow-data\\assets") || asset.storage_path.contains("printflow-data/assets") { let _ = fs::remove_file(asset.storage_path); }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_artwork(output: String, svg: String, format: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if format == "svg" { return fs::write(output, svg).map_err(|e| e.to_string()); }
        if format == "jpg" || format == "jpeg" {
            let tree = usvg::Tree::from_str(&svg, &assets::export_options()?).map_err(|e| e.to_string())?;
            let mut pixmap = tiny_skia::Pixmap::new(2480, 3508).ok_or("无法创建 JPG 画布")?;
            resvg::render(&tree, tiny_skia::Transform::from_scale(2480.0 / tree.size().width(), 3508.0 / tree.size().height()), &mut pixmap.as_mut());
            let mut rgb = image::RgbImage::new(2480, 3508);
            for (index, pixel) in pixmap.data().chunks_exact(4).enumerate() {
                let x = (index as u32) % 2480; let y = (index as u32) / 2480;
                let alpha = pixel[3] as u32;
                rgb.put_pixel(x, y, image::Rgb([((pixel[0] as u32 * alpha + 255 * (255 - alpha)) / 255) as u8, ((pixel[1] as u32 * alpha + 255 * (255 - alpha)) / 255) as u8, ((pixel[2] as u32 * alpha + 255 * (255 - alpha)) / 255) as u8]));
            }
            return rgb.save_with_format(output, image::ImageFormat::Jpeg).map_err(|e| e.to_string());
        } else if format != "png" { return Err("PDF 多页导出需要安装矢量 PDF 引擎；当前环境未提供该依赖".into()); }
        let svg = flatten_embedded_svg_images(svg)?;
        let tree = usvg::Tree::from_str(&svg, &assets::export_options()?).map_err(|e| e.to_string())?;
        let mut pixmap = tiny_skia::Pixmap::new(2480, 3508).ok_or("无法创建 PNG 画布")?;
        resvg::render(&tree, tiny_skia::Transform::from_scale(2480.0 / tree.size().width(), 3508.0 / tree.size().height()), &mut pixmap.as_mut());
        pixmap.save_png(output).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_pdf(app: tauri::AppHandle, output: String, pages: Vec<String>) -> Result<(), String> {
    export_pdf_with_progress(output, pages, Some(app)).await
}

fn pdf_stage_path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') { return Err("无效的导出缓存标识".into()); }
    Ok(std::env::temp_dir().join(format!("printflow-pdf-{id}.svg")))
}

#[tauri::command]
async fn stage_pdf_page(id: String, svg: String) -> Result<(), String> {
    let path = pdf_stage_path(&id)?;
    tokio::fs::write(path, svg).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_pdf_pages(ids: Vec<String>) -> Result<(), String> {
    for id in ids { let path = pdf_stage_path(&id)?; let _ = tokio::fs::remove_file(path).await; }
    Ok(())
}

#[tauri::command]
async fn export_staged_pdf(app: tauri::AppHandle, output: String, ids: Vec<String>) -> Result<(), String> {
    let paths = ids.iter().map(|id| pdf_stage_path(id)).collect::<Result<Vec<_>, _>>()?;
    let pages = paths.iter().map(|path| path.to_string_lossy().into_owned()).collect();
    let result = export_pdf_sources(output, pages, Some(app), true).await;
    if let Err(error) = &result { log::error!(target: "printflow::pdf", "PDF 导出失败：{error}"); }
    for path in paths { let _ = tokio::fs::remove_file(path).await; }
    result
}

#[cfg(test)]
async fn export_pdf_for_test(output: String, pages: Vec<String>) -> Result<(), String> {
    export_pdf_with_progress(output, pages, None).await
}

async fn export_pdf_with_progress(output: String, pages: Vec<String>, progress_app: Option<tauri::AppHandle>) -> Result<(), String> {
    export_pdf_sources(output, pages, progress_app, false).await
}

async fn export_pdf_sources(output: String, pages: Vec<String>, progress_app: Option<tauri::AppHandle>, staged: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if pages.is_empty() { return Err("没有可导出的页面".into()); }
        let export_started = Instant::now();
        log::info!(target: "printflow::pdf", "开始导出 PDF：pages={}, svg_bytes={}", pages.len(), pages.iter().map(String::len).sum::<usize>());
        let client = reqwest::blocking::Client::builder().connect_timeout(std::time::Duration::from_secs(4)).timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
        let mut external_image_cache = HashMap::new();
        let mut pdf = pdf_writer::Pdf::new();
        let catalog_ref = pdf_writer::Ref::new(1);
        let pages_ref = pdf_writer::Ref::new(2);
        let page_refs = pages.iter().enumerate().map(|(index, _)| pdf_writer::Ref::new(100 + index as i32)).collect::<Vec<_>>();
        let mut next_ref = 10_000;
        pdf.catalog(catalog_ref).pages(pages_ref);
        pdf.pages(pages_ref).kids(page_refs.iter().copied()).count(page_refs.len() as i32);
        if let Some(app) = progress_app.as_ref() {
            let _ = app.emit("pdf-export-progress", PdfExportProgress { phase: "rendering".into(), completed: 0, total: pages.len() });
        }
        for (index, source) in pages.iter().enumerate() {
            let report = |phase: &str| {
                log::info!(target: "printflow::pdf", "PDF page={}/{} stage={}", index + 1, pages.len(), phase);
                if let Some(app) = progress_app.as_ref() {
                    let _ = app.emit("pdf-export-progress", PdfExportProgress { phase: phase.into(), completed: index, total: pages.len() });
                }
            };
            report("resources");
            let phase_start = Instant::now();
            let svg = if staged { fs::read_to_string(source).map_err(|e| format!("读取导出页面失败：{e}"))? } else { source.clone() };
            let embedded = embed_external_raster_images(svg, &client, &mut external_image_cache)?;
            let resources_ms = phase_start.elapsed().as_millis();
            let phase_start = Instant::now();
            report("flatten");
            let flattened = flatten_embedded_svg_images(embedded)?;
            let flatten_ms = phase_start.elapsed().as_millis();
            let phase_start = Instant::now();
            report("fonts");
            let options = assets::export_options()?;
            let fonts_ms = phase_start.elapsed().as_millis();
            let phase_start = Instant::now();
            report("parse");
            let tree = usvg::Tree::from_str(&flattened, &options).map_err(|error| format!("PDF 矢量页面解析失败：{error}"))?;
            let parse_ms = phase_start.elapsed().as_millis();
            let phase_start = Instant::now();
            report("convert");
            let (chunk, svg_ref) = svg2pdf::to_chunk(&tree, svg2pdf::ConversionOptions::default())
                .map_err(|error| format!("PDF 矢量页面转换失败：{error}"))?;
            log::info!(target: "printflow::pdf", "PDF page={}/{} resources_ms={} flatten_ms={} fonts_ms={} parse_ms={} convert_ms={}", index + 1, pages.len(), resources_ms, flatten_ms, fonts_ms, parse_ms, phase_start.elapsed().as_millis());
            let mut chunk_refs = HashMap::new();
            let chunk = chunk.renumber(|old| *chunk_refs.entry(old).or_insert_with(|| {
                let allocated = pdf_writer::Ref::new(next_ref);
                next_ref += 1;
                allocated
            }));
            let svg_ref = *chunk_refs.get(&svg_ref).ok_or("PDF 矢量资源引用丢失")?;
            pdf.extend(&chunk);
            let content_ref = pdf_writer::Ref::new(next_ref);
            next_ref += 1;
            let mut content = pdf_writer::Content::new();
            content.transform([595.2756, 0.0, 0.0, 841.8898, 0.0, 0.0]).x_object(pdf_writer::Name(b"PageSvg"));
            pdf.stream(content_ref, &content.finish());
            let mut page = pdf.page(page_refs[index]);
            page.parent(pages_ref).media_box(pdf_writer::Rect::new(0.0, 0.0, 595.2756, 841.8898)).contents(content_ref);
            let mut resources = page.resources();
            resources.x_objects().pair(pdf_writer::Name(b"PageSvg"), svg_ref);
            resources.finish();
            page.finish();
            if let Some(app) = progress_app.as_ref() {
                let _ = app.emit("pdf-export-progress", PdfExportProgress { phase: "page".into(), completed: index + 1, total: pages.len() });
            }
        }
        let write_started = Instant::now();
        if let Some(app) = progress_app.as_ref() {
            let _ = app.emit("pdf-export-progress", PdfExportProgress { phase: "write".into(), completed: pages.len(), total: pages.len() });
        }
        let bytes = pdf.finish();
        let output_bytes = bytes.len();
        fs::write(output, bytes).map_err(|e| e.to_string())?;
        log::info!(target: "printflow::pdf", "PDF 导出完成：pages={}, bytes={}, finish_write_ms={}, total_ms={}", pages.len(), output_bytes, write_started.elapsed().as_millis(), export_started.elapsed().as_millis());
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep development logs beside the executable; the managed Windows profile
    // may deny writes to the OS log directory even when app data is readable.
    let log_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        .join("logs");
    let _ = fs::create_dir_all(&log_dir);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Folder { path: log_dir, file_name: Some("printflow.log".into()) }),
        ]).build())
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![import_assets, load_workspace, save_workspace, delete_asset, save_batch, persist_batch_assets, discard_temp_assets, list_batches, load_batch, delete_batch, export_artwork, export_pdf, stage_pdf_page, clear_pdf_pages, export_staged_pdf, load_product_configs, fetch_remote_image, load_finish_names, refresh_product_configs, custom_products::list_custom_products, custom_products::save_custom_product, custom_products::import_custom_product_image, coreldraw::open_with_coreldraw])
        .run(tauri::generate_context!()).expect("error while running tauri application");
}

