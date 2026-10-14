//! Board-sized, one-layer-group-per-file PDF export. The original SVG coordinate
//! system is retained; unlike schematic exports, no A4 page transform is applied.
use pdf_writer::Finish;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, AtomicUsize, Ordering}, Arc, Mutex},
};
use tauri::Emitter;

fn page_size(width_mm: f64, height_mm: f64) -> Result<(f32, f32), String> {
    if !width_mm.is_finite() || !height_mm.is_finite()
        || width_mm <= 0.0 || height_mm <= 0.0
        || width_mm > 10_000.0 || height_mm > 10_000.0
    {
        return Err("板材宽高必须为 0 至 10000 mm 之间的有效数字".into());
    }
    Ok(((width_mm * 72.0 / 25.4) as f32, (height_mm * 72.0 / 25.4) as f32))
}

fn checked_output(output: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(output);
    if !path.is_absolute() || !path.parent().is_some_and(Path::is_dir) {
        return Err("请选择已存在的 PDF 导出文件夹".into());
    }
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("PDF 文件名无效")?;
    if !name.to_ascii_lowercase().ends_with(".pdf")
        || name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        || name.ends_with([' ', '.'])
    {
        return Err(format!("PDF 文件名无效：{name}"));
    }
    if path.exists() {
        return Err(format!("文件已存在，请修改文件名或选择其他文件夹：{name}"));
    }
    Ok(path)
}

#[tauri::command]
pub async fn check_imposition_pdf_outputs(outputs: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if outputs.is_empty() { return Err("没有可导出的拼版图层组".into()); }
        let mut names = HashSet::new();
        for output in outputs {
            let path = checked_output(&output)?;
            let key = path.to_string_lossy().to_lowercase();
            if !names.insert(key) { return Err("导出文件名重复，请调整版式或图层组文件名".into()); }
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> { id: &'a str, phase: &'a str }

#[tauri::command]
pub async fn export_imposition_pdf(
    app: tauri::AppHandle,
    output: String,
    id: String,
    width_mm: f64,
    height_mm: f64,
) -> Result<(), String> {
    // Validate the id before dispatching work; it may never designate a path.
    let staged = crate::staged_artwork::path(&id)?;
    let size = page_size(width_mm, height_mm)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = checked_output(&output)?;
        let report = |phase: &str| {
            let _ = app.emit("imposition-pdf-export-progress", Progress { id: &id, phase });
        };
        let source = fs::read_to_string(staged).map_err(|error| format!("读取拼版导出页面失败：{error}"))?;
        let bytes = render_pdf(source, size, report)?;
        report("write");
        commit_pdf(&output, &bytes)
    }).await.map_err(|error| error.to_string())?
}

fn render_pdf(svg: String, size: (f32, f32), report: impl Fn(&str)) -> Result<Vec<u8>, String> {
    report("resources");
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(20)).build().map_err(|error| error.to_string())?;
    let embedded = crate::embed_external_raster_images(svg, &client, &mut Default::default())?;
    report("flatten");
    // Keep <image> intact. Replacing it with <g> loses image-local clipping,
    // opacity, masks and viewport/preserveAspectRatio semantics.
    report("fonts");
    report("parse");
    let tree = parse_board_svg(&embedded)?;
    // Reject a mismatching SVG aspect ratio instead of stretching positions and
    // paths when the caller accidentally provides a different board size.
    let svg_ratio = tree.size().width() / tree.size().height();
    if (svg_ratio / (size.0 / size.1) - 1.0).abs() > 0.0001 {
        return Err("SVG 页面比例与板材毫米宽高不一致，已停止导出以避免缩放变形".into());
    }
    report("convert");
    let (chunk, svg_ref) = svg2pdf::to_chunk(&tree, Default::default())
        .map_err(|error| format!("拼版矢量 PDF 转换失败：{error}"))?;
    let mut next_ref = 100;
    let mut refs = std::collections::HashMap::new();
    let chunk = chunk.renumber(|old| *refs.entry(old).or_insert_with(|| {
        let allocated = pdf_writer::Ref::new(next_ref); next_ref += 1; allocated
    }));
    let svg_ref = *refs.get(&svg_ref).ok_or("拼版 PDF 图层资源引用丢失")?;
    let mut pdf = pdf_writer::Pdf::new();
    let catalog = pdf_writer::Ref::new(1);
    let pages = pdf_writer::Ref::new(2);
    let page = pdf_writer::Ref::new(3);
    let content_ref = pdf_writer::Ref::new(4);
    pdf.catalog(catalog).pages(pages);
    pdf.pages(pages).kids([page]).count(1);
    pdf.extend(&chunk);
    // svg2pdf::to_chunk returns a normalized form. Scaling to physical points
    // once preserves the SVG viewBox (including transformed/rotated products).
    let mut content = pdf_writer::Content::new();
    content.transform([size.0, 0.0, 0.0, size.1, 0.0, 0.0]).x_object(pdf_writer::Name(b"BoardSvg"));
    pdf.stream(content_ref, &content.finish());
    let mut page = pdf.page(page);
    page.parent(pages).media_box(pdf_writer::Rect::new(0.0, 0.0, size.0, size.1)).contents(content_ref);
    let mut resources = page.resources();
    resources.x_objects().pair(pdf_writer::Name(b"BoardSvg"), svg_ref);
    resources.finish();
    page.finish();
    Ok(pdf.finish())
}

#[derive(Default)]
struct ImageResolverState {
    depth: AtomicUsize,
    error: Mutex<Option<String>>,
    // <defs>/<use> can ask for the same bitmap repeatedly. All copies share
    // the immutable raster bytes; SVGs retain their own isolated id scope.
    images: Mutex<HashMap<(String, Arc<Vec<u8>>), usvg::ImageKind>>,
}

impl ImageResolverState {
    fn fail(&self, message: String) {
        let mut error = self.error.lock().unwrap();
        if error.is_none() { *error = Some(message); }
    }
    fn svg(&self, data: &[u8], options: &usvg::Options) -> Option<usvg::ImageKind> {
        // Staged resources may reference one another. Bound nesting depth so a
        // cyclic or corrupted document produces a useful error, not a stack crash.
        let depth = self.depth.fetch_add(1, Ordering::Relaxed);
        let result = if depth >= 64 {
            self.fail("嵌入 SVG 图片层级过深或存在循环资源引用".into());
            None
        } else {
            match usvg::Tree::from_data(data, options) {
                Ok(tree) => Some(usvg::ImageKind::SVG(tree)),
                Err(error) => { self.fail(format!("嵌入 SVG 图片解析失败：{error}")); None }
            }
        };
        self.depth.fetch_sub(1, Ordering::Relaxed);
        result
    }
}

fn parse_board_svg(svg: &str) -> Result<usvg::Tree, String> {
    let mut options = crate::assets::export_options()?;
    let state = Arc::new(ImageResolverState::default());
    let data_state = state.clone();
    let default_data = usvg::ImageHrefResolver::default_data_resolver();
    options.image_href_resolver.resolve_data = Box::new(move |mime, bytes, options| {
        let key = (mime.to_string(), bytes.clone());
        let cached = data_state.images.lock().unwrap().get(&key).cloned();
        if let Some(image) = cached { return Some(image); }
        // usvg's default SVG-image loader discards *all* nested images. Parse
        // with these same bounded resolvers instead, retaining embedded PNGs.
        let is_svg = mime == "image/svg+xml" || mime == "text/plain"
            && String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').trim_start().starts_with('<');
        let image = if is_svg { data_state.svg(&bytes, options) }
            else { default_data(mime, bytes, options) };
        if let Some(image) = image.as_ref() { data_state.images.lock().unwrap().insert(key, image.clone()); }
        else { data_state.fail(format!("无法解析嵌入的 {mime} 图片，已停止导出以避免缺图")); }
        image
    });
    let staged_state = state.clone();
    options.image_href_resolver.resolve_string = Box::new(move |reference, options| {
        // As with assets::export_options, arbitrary local/network image reads
        // remain disabled. Only our validated stage identifiers are accepted.
        if !reference.starts_with(crate::staged_artwork::PREFIX) {
            staged_state.fail(format!("导出图片未嵌入或资源不可访问：{reference}"));
            return None;
        }
        match crate::staged_artwork::read(reference) {
            Ok(svg) => staged_state.svg(svg.as_bytes(), options),
            Err(error) => { staged_state.fail(error); None }
        }
    });
    let tree = usvg::Tree::from_str(svg, &options)
        .map_err(|error| format!("拼版 SVG 解析失败：{error}"))?;
    if let Some(error) = state.error.lock().unwrap().take() { return Err(error); }
    Ok(tree)
}

struct PendingFile(PathBuf);
impl Drop for PendingFile {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

/// Build a complete file in the same directory, then publish it without ever
/// replacing another file (including one created after the batch preflight).
fn commit_pdf(output: &Path, bytes: &[u8]) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = output.parent().ok_or("PDF 导出目录无效")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?.as_nanos();
    let temp = parent.join(format!(".printflow-pdf-{}-{stamp}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|error| format!("创建 PDF 临时文件失败：{error}"))?;
    let pending = PendingFile(temp);
    file.write_all(bytes).and_then(|_| file.sync_all())
        .map_err(|error| format!("写入 PDF 失败：{error}"))?;
    drop(file);
    // std::fs::rename also replaces an existing Windows destination. Invoke
    // MoveFileExW without REPLACE_EXISTING for an atomic create-if-absent commit.
    #[cfg(windows)]
    let result = move_without_replace(&pending.0, output);
    #[cfg(not(windows))]
    let result = fs::hard_link(&pending.0, output);
    result.map_err(|error| {
        if output.exists() { format!("文件已存在，未覆盖：{}", output.display()) }
        else { format!("提交 PDF 文件失败：{error}") }
    })
}

#[cfg(windows)]
fn move_without_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both UTF-16 buffers are NUL terminated and remain alive throughout the call.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn nested_svg_fixture() -> String {
        let mut png = tiny_skia::Pixmap::new(2, 2).unwrap();
        png.fill(tiny_skia::Color::from_rgba8(0, 255, 0, 255));
        let png = base64::engine::general_purpose::STANDARD.encode(png.encode_png().unwrap());
        let inner = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 10 20"><rect width="10" height="20" fill="red"/><image x="0" y="10" width="10" height="10" href="data:image/png;base64,{png}"/></svg>"#);
        let inner = base64::engine::general_purpose::STANDARD.encode(inner);
        format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464"><defs><clipPath id="clip"><rect x="10" y="10" width="12" height="30"/></clipPath><mask id="mask" maskUnits="userSpaceOnUse" x="50" y="10" width="30" height="30"><rect x="50" y="10" width="15" height="30" fill="white"/></mask><g id="source"><image x="10" y="10" width="30" height="30" preserveAspectRatio="none" opacity="0.5" clip-path="url(#clip)" href="data:image/svg+xml;base64,{inner}"/><image x="50" y="10" width="30" height="30" preserveAspectRatio="xMidYMid meet" mask="url(#mask)" href="data:image/svg+xml;base64,{inner}"/><image x="90" y="10" width="30" height="30" preserveAspectRatio="none" style="opacity:0.25" href="data:image/svg+xml;base64,{inner}"/></g></defs><use href="#source" transform="translate(0 100)"/><use href="#source" transform="translate(180 200) rotate(90)"/></svg>"##)
    }
    #[test]
    fn shared_nested_svg_images_preserve_clip_opacity_mask_viewports_and_raster_children() {
        let svg = nested_svg_fixture();
        let tree = parse_board_svg(&svg).unwrap();
        let mut pixels = tiny_skia::Pixmap::new(300, 464).unwrap();
        pixels.fill(tiny_skia::Color::WHITE);
        resvg::render(&tree, tiny_skia::Transform::from_scale(300.0 / tree.size().width(), 464.0 / tree.size().height()), &mut pixels.as_mut());
        let color = |x, y| { let p = pixels.pixel(x, y).unwrap(); [p.red(), p.green(), p.blue()] };
        assert_eq!(color(17, 115), [255, 128, 128], "image opacity must survive a defs/use placement");
        assert_eq!(color(25, 115), [255, 255, 255], "image clip must survive");
        assert_eq!(color(17, 130), [128, 255, 128], "nested PNG must not be discarded");
        assert_eq!(color(52, 115), [255, 255, 255], "meet centers the narrow SVG in the image viewport");
        assert_eq!(color(60, 115), [255, 0, 0]);
        assert_eq!(color(70, 115), [255, 255, 255], "image mask must survive");
        assert_eq!(color(100, 115), [255, 191, 191], "none stretches and image-local style remains");
        assert_eq!(color(165, 217), [255, 128, 128], "second use rotation preserves the same layers");
        let pdf = render_pdf(svg, page_size(300.0, 464.0).unwrap(), |_| {}).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Subtype /Image"), "nested PNG must reach PDF conversion");
    }
    #[test]
    fn invalid_embedded_svg_fails_instead_of_silently_dropping_an_image() {
        let encoded = base64::engine::general_purpose::STANDARD.encode("<svg broken");
        let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm"><image width="20" height="20" href="data:image/svg+xml;base64,{encoded}"/></svg>"#);
        assert!(parse_board_svg(&svg).unwrap_err().contains("嵌入 SVG 图片解析失败"));
    }
    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!("printflow-imposition-pdf-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&path).unwrap(); path
    }
    #[test]
    fn board_dimensions_are_mm_not_a4() {
        let (w, h) = page_size(300.0, 464.0).unwrap();
        assert!((w - 850.3937).abs() < 0.001);
        assert!((h - 1315.2756).abs() < 0.001);
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, 10_001.0] { assert!(page_size(invalid, 464.0).is_err()); }
        assert!(crate::staged_artwork::path("../secret").is_err());
    }
    #[test]
    fn board_pdf_retains_gradient_clip_and_physical_page_transform() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><clipPath id="c"><rect width="20" height="30"/></clipPath></defs><g transform="translate(70 120) rotate(90)"><rect width="40" height="40" fill="url(#g)" clip-path="url(#c)"/></g><path d="M 15 20 L 45 20 L 45 60 Z" fill="none" stroke="magenta" stroke-width="0.1"/></svg>"##;
        let pdf = render_pdf(svg.into(), page_size(300.0, 464.0).unwrap(), |_| {}).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/MediaBox [0 0 850.3937 1315.2756]"), "{text}");
        assert!(text.contains("850.3937 0 0 1315.2756 0 0 cm"));
        assert!(text.contains("/ShadingType"), "gradient must stay vector");
        assert!(!text.contains("595.2756"));
    }
    #[test]
    fn board_pdf_rejects_mismatched_svg_page_instead_of_distorting() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"210mm\" height=\"297mm\"><path d=\"M0 0L1 1\"/></svg>";
        assert!(render_pdf(svg.into(), page_size(300.0, 464.0).unwrap(), |_| {}).unwrap_err().contains("比例"));
    }
    #[test]
    fn atomic_commit_never_overwrites_and_cleans_temporary_file() {
        let dir = scratch(); let output = dir.join("图层_01.pdf");
        commit_pdf(&output, b"first").unwrap();
        assert!(commit_pdf(&output, b"second").is_err());
        assert_eq!(fs::read(&output).unwrap(), b"first");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(checked_output(output.to_str().unwrap()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "Set PRINTFLOW_IMPOSITION_PDF_FIXTURE and PRINTFLOW_IMPOSITION_PDF_OUTPUT for a real export/render check"]
    fn export_board_fixture() {
        let input = std::env::var("PRINTFLOW_IMPOSITION_PDF_FIXTURE").unwrap();
        let output = PathBuf::from(std::env::var("PRINTFLOW_IMPOSITION_PDF_OUTPUT").unwrap());
        let pdf = render_pdf(fs::read_to_string(input).unwrap(), page_size(300.0, 464.0).unwrap(), |_| {}).unwrap();
        commit_pdf(&output, &pdf).unwrap();
    }
    #[test]
    #[ignore = "Set PRINTFLOW_IMPOSITION_PDF_OUTPUT for Poppler verification of nested SVG image semantics"]
    fn export_nested_svg_fixture() {
        let output = PathBuf::from(std::env::var("PRINTFLOW_IMPOSITION_PDF_OUTPUT").unwrap());
        let pdf = render_pdf(nested_svg_fixture(), page_size(300.0, 464.0).unwrap(), |_| {}).unwrap();
        commit_pdf(&output, &pdf).unwrap();
    }
}
