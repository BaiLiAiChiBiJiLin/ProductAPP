//! Board-sized, one-layout-per-file, ordered multi-page PDF export. The SVG coordinate
//! system is retained; unlike schematic exports, no A4 page transform is applied.
use pdf_writer::Finish;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::Emitter;

fn pdf_worker_count(page_count: usize, requested: Option<usize>) -> usize {
    use crate::imposition_pdf_runtime::{automatic_workers, memory_workers, worker_memory};
    let target = requested
        .unwrap_or_else(automatic_workers)
        .clamp(1, automatic_workers());
    memory_workers(page_count, target, worker_memory())
}

fn page_size(width_mm: f64, height_mm: f64) -> Result<(f32, f32), String> {
    if !width_mm.is_finite()
        || !height_mm.is_finite()
        || width_mm <= 0.0
        || height_mm <= 0.0
        || width_mm > 10_000.0
        || height_mm > 10_000.0
    {
        return Err("板材宽高必须为 0 至 10000 mm 之间的有效数字".into());
    }
    Ok((
        (width_mm * 72.0 / 25.4) as f32,
        (height_mm * 72.0 / 25.4) as f32,
    ))
}

fn checked_output(output: &str) -> Result<PathBuf, String> {
    checked_export_output(output, "pdf")
}

pub(crate) fn checked_export_output(output: &str, extension: &str) -> Result<PathBuf, String> {
    let format_name = extension.to_ascii_uppercase();
    let path = PathBuf::from(output);
    if !path.is_absolute() || !path.parent().is_some_and(Path::is_dir) {
        return Err(format!("请选择已存在的 {format_name} 导出文件夹"));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{format_name} 文件名无效"))?;
    if !name.to_ascii_lowercase().ends_with(&format!(".{extension}"))
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        || name.ends_with([' ', '.'])
    {
        return Err(format!("{format_name} 文件名无效：{name}"));
    }
    if path.exists() {
        return Err(format!("文件已存在，请修改文件名或选择其他文件夹：{name}"));
    }
    Ok(path)
}

#[tauri::command]
pub async fn check_imposition_pdf_outputs(outputs: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if outputs.is_empty() {
            return Err("没有可导出的拼版版式".into());
        }
        let mut names = HashSet::new();
        for output in outputs {
            let extension = if output.to_ascii_lowercase().ends_with(".dxf") {
                "dxf"
            } else {
                "pdf"
            };
            let path = checked_export_output(&output, extension)?;
            let key = path.to_string_lossy().to_lowercase();
            if !names.insert(key) {
                return Err("导出文件名重复，请调整版式文件名".into());
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    phase: &'a str,
    page_index: usize,
    page_count: usize,
}

#[tauri::command]
pub async fn export_imposition_pdf(
    app: tauri::AppHandle,
    output: String,
    id: String,
    page_ids: Vec<String>,
    width_mm: f64,
    height_mm: f64,
    worker_count: Option<usize>,
) -> Result<(), String> {
    // The file id is only a progress key. Each page resource must independently
    // pass the stage identifier allowlist before any filesystem reads happen.
    if page_ids.is_empty() {
        return Err("没有可导出的拼版页面".into());
    }
    for id in &page_ids {
        crate::staged_artwork::path(id)?;
    }
    let page_count = page_ids.len();
    let size = page_size(width_mm, height_mm)?;
    tauri::async_runtime::spawn_blocking(move || {
        let report = |page_index: usize, phase: &str| {
            let _ = app.emit(
                "imposition-pdf-export-progress",
                Progress {
                    id: &id,
                    phase,
                    page_index,
                    page_count,
                },
            );
        };
        let output = checked_output(&output)?;
        crate::imposition_pdf_runtime::export_isolated(
            &output,
            page_ids,
            size,
            worker_count,
            report,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
fn export_staged_pdf(
    output: &str,
    staged: &[PathBuf],
    size: (f32, f32),
    report: impl Fn(usize, &str),
) -> Result<(), String> {
    let output = checked_output(output)?;
    let bytes = render_staged_pdf(staged, size, &report, None)?;
    report(staged.len(), "write");
    commit_pdf(&output, &bytes)
}

pub(crate) fn render_staged_pdf(
    staged: &[PathBuf],
    size: (f32, f32),
    report: impl Fn(usize, &str),
    workers: Option<usize>,
) -> Result<Vec<u8>, String> {
    let costs = staged
        .iter()
        .map(|path| {
            fs::metadata(path)
                .map(|m| {
                    usize::try_from(m.len())
                        .unwrap_or(usize::MAX)
                        .saturating_mul(24)
                        .max(crate::imposition_pdf_runtime::PER_WORKER)
                })
                .map_err(|e| format!("读取拼版页面大小失败：{e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    render_pdf_pages_with_costs(
        staged.len(),
        |index| {
            fs::read_to_string(&staged[index])
                .map_err(|error| format!("读取拼版导出页面失败：{error}"))
        },
        size,
        &report,
        workers,
        Some(&costs),
    )
}

/// Convert SVG pages in bounded parallel batches, then append their PDF chunks
/// in the original order. Only the current batch is retained, and a worker
/// panic becomes an ordinary export error instead of unwinding the Tauri task.
#[cfg(test)]
fn render_pdf_pages(
    page_count: usize,
    load_page: impl FnMut(usize) -> Result<String, String>,
    size: (f32, f32),
    report: impl Fn(usize, &str),
) -> Result<Vec<u8>, String> {
    render_pdf_pages_with_workers(page_count, load_page, size, report, None)
}

#[cfg(test)]
fn render_pdf_pages_with_workers(
    page_count: usize,
    load_page: impl FnMut(usize) -> Result<String, String>,
    size: (f32, f32),
    report: impl Fn(usize, &str),
    requested_workers: Option<usize>,
) -> Result<Vec<u8>, String> {
    render_pdf_pages_with_costs(page_count, load_page, size, report, requested_workers, None)
}

fn render_pdf_pages_with_costs(
    page_count: usize,
    mut load_page: impl FnMut(usize) -> Result<String, String>,
    size: (f32, f32),
    report: impl Fn(usize, &str),
    requested_workers: Option<usize>,
    costs: Option<&[usize]>,
) -> Result<Vec<u8>, String> {
    if page_count == 0 {
        return Err("没有可导出的拼版页面".into());
    }
    let count = i32::try_from(page_count).map_err(|_| "拼版 PDF 页面数量过多")?;
    let client = Arc::new(
        reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(4))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?,
    );
    let mut pdf = pdf_writer::Pdf::new();
    let catalog = pdf_writer::Ref::new(1);
    let pages = pdf_writer::Ref::new(2);
    let mut next_ref = 3;
    let mut page_refs = Vec::with_capacity(page_count);
    pdf.catalog(catalog).pages(pages);

    let mut batch_start = 0;
    while batch_start < page_count {
        // Re-evaluate each batch, so memory pressure can lower concurrency and
        // recovered memory can raise it again within the shared CPU allocation.
        let workers = pdf_worker_count(page_count - batch_start, requested_workers);
        let maximum_end = (batch_start + workers).min(page_count);
        let mut batch_end = batch_start;
        let mut inputs = Vec::with_capacity(maximum_end - batch_start);
        let budget = crate::imposition_pdf_runtime::worker_memory()
            .unwrap_or(0)
            .saturating_sub(crate::imposition_pdf_runtime::RESERVE);
        let mut reserved = 0usize;
        for index in batch_start..maximum_end {
            let cost = costs.map_or(crate::imposition_pdf_runtime::PER_WORKER, |costs| {
                costs[index]
            });
            if !inputs.is_empty() && reserved.saturating_add(cost) > budget {
                break;
            }
            report(index + 1, "resources");
            let svg = load_page(index)
                .map_err(|error| format!("第 {} / {page_count} 页导出失败：{error}", index + 1))?;
            inputs.push((index, svg));
            reserved = reserved.saturating_add(cost);
            batch_end = index + 1;
        }

        enum Message {
            Phase(usize, &'static str),
            Done(usize, Result<PreparedPdfPage, String>),
        }
        let prepared = thread::scope(|scope| {
            let (sender, receiver) = std::sync::mpsc::channel();
            let mut handles = Vec::new();
            let mut thread_error = None;
            for (index, svg) in inputs {
                let client = Arc::clone(&client);
                let sender = sender.clone();
                match thread::Builder::new()
                    .name(format!("pdf-page-{}", index + 1))
                    .spawn_scoped(scope, move || {
                        let result = catch_unwind(AssertUnwindSafe(|| {
                            prepare_pdf_page(svg, size, &client, |phase| {
                                let _ = sender.send(Message::Phase(index, phase));
                            })
                        }))
                        .map_err(|_| "PDF 页面转换线程异常，已安全停止本批任务".to_string())
                        .and_then(|value| value);
                        let _ = sender.send(Message::Done(index, result));
                    }) {
                    Ok(handle) => handles.push(handle),
                    Err(error) => {
                        thread_error = Some(format!("无法创建 PDF 转换线程：{error}"));
                        break;
                    }
                }
            }
            drop(sender);
            let mut results = Vec::with_capacity(handles.len());
            // Forward live progress from one receiver; report need not be Sync.
            for message in receiver {
                match message {
                    Message::Phase(index, phase) => report(index + 1, phase),
                    Message::Done(index, value) => results.push((index, value)),
                }
            }
            for handle in handles {
                if handle.join().is_err() {
                    thread_error = Some("PDF 页面转换线程异常".into());
                }
            }
            results.sort_by_key(|(index, _)| *index);
            thread_error.map_or(Ok(results), Err)
        })?;

        for (index, result) in prepared {
            let prepared = result
                .map_err(|error| format!("第 {} / {page_count} 页导出失败：{error}", index + 1))?;
            let page = append_prepared_pdf_page(&mut pdf, pages, &mut next_ref, prepared, size)
                .map_err(|error| format!("第 {} / {page_count} 页导出失败：{error}", index + 1))?;
            report(index + 1, "merge");
            page_refs.push(page);
        }
        batch_start = batch_end;
    }

    pdf.pages(pages).kids(page_refs).count(count);
    Ok(pdf.finish())
}

#[cfg(test)]
fn render_pdf(svg: String, size: (f32, f32), report: impl Fn(&str)) -> Result<Vec<u8>, String> {
    let mut source = Some(svg);
    render_pdf_pages(
        1,
        |_| Ok(source.take().unwrap()),
        size,
        |_, phase| report(phase),
    )
}

struct PreparedPdfPage {
    chunk: pdf_writer::Chunk,
    svg_ref: pdf_writer::Ref,
}

fn prepare_pdf_page(
    svg: String,
    size: (f32, f32),
    client: &reqwest::blocking::Client,
    report: impl Fn(&'static str),
) -> Result<PreparedPdfPage, String> {
    report("resources");
    let embedded = crate::embed_external_raster_images(svg, client, &mut Default::default())?;
    // Keep <image> intact. Replacing it with <g> loses image-local clipping,
    // opacity, masks and viewport/preserveAspectRatio semantics.
    report("parse");
    let tree = parse_board_svg(&embedded)?;
    let svg_ratio = tree.size().width() / tree.size().height();
    if (svg_ratio / (size.0 / size.1) - 1.0).abs() > 0.0001 {
        return Err("SVG 页面比例与板材毫米宽高不一致，已停止导出以避免缩放变形".into());
    }
    report("convert");
    let (chunk, svg_ref) = svg2pdf::to_chunk(&tree, Default::default())
        .map_err(|error| format!("拼版矢量 PDF 转换失败：{error}"))?;
    Ok(PreparedPdfPage { chunk, svg_ref })
}

fn append_prepared_pdf_page(
    pdf: &mut pdf_writer::Pdf,
    pages: pdf_writer::Ref,
    next_ref: &mut i32,
    prepared: PreparedPdfPage,
    size: (f32, f32),
) -> Result<pdf_writer::Ref, String> {
    let PreparedPdfPage { chunk, svg_ref } = prepared;
    // Every page, content stream and converted SVG object shares one allocator.
    // SVG chunks restart their local ids, so each needs a fresh local mapping.
    let page_ref = pdf_writer::Ref::new(*next_ref);
    *next_ref += 1;
    let content_ref = pdf_writer::Ref::new(*next_ref);
    *next_ref += 1;
    let mut refs = std::collections::HashMap::new();
    let chunk = chunk.renumber(|old| {
        *refs.entry(old).or_insert_with(|| {
            let allocated = pdf_writer::Ref::new(*next_ref);
            *next_ref += 1;
            allocated
        })
    });
    let svg_ref = *refs.get(&svg_ref).ok_or("拼版 PDF 图层资源引用丢失")?;
    pdf.extend(&chunk);
    let mut content = pdf_writer::Content::new();
    content
        .save_state()
        .transform([size.0, 0.0, 0.0, size.1, 0.0, 0.0])
        .x_object(pdf_writer::Name(b"BoardSvg"))
        .restore_state();
    // Half-width inset keeps the complete 0.2 mm stroke inside the media box.
    let border_width = (0.2 * 72.0 / 25.4) as f32;
    content
        .set_stroke_rgb(0.0, 0.0, 0.0)
        .set_line_width(border_width)
        .rect(
            border_width / 2.0,
            border_width / 2.0,
            size.0 - border_width,
            size.1 - border_width,
        )
        .stroke();
    pdf.stream(content_ref, &content.finish());
    let mut page = pdf.page(page_ref);
    page.parent(pages)
        .media_box(pdf_writer::Rect::new(0.0, 0.0, size.0, size.1))
        .contents(content_ref);
    let mut resources = page.resources();
    resources
        .x_objects()
        .pair(pdf_writer::Name(b"BoardSvg"), svg_ref);
    resources.finish();
    page.finish();
    Ok(page_ref)
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
        if error.is_none() {
            *error = Some(message);
        }
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
                Err(error) => {
                    self.fail(format!("嵌入 SVG 图片解析失败：{error}"));
                    None
                }
            }
        };
        self.depth.fetch_sub(1, Ordering::Relaxed);
        result
    }
}

pub(crate) fn parse_board_svg(svg: &str) -> Result<usvg::Tree, String> {
    let mut options = crate::assets::export_options()?;
    let state = Arc::new(ImageResolverState::default());
    let data_state = state.clone();
    let default_data = usvg::ImageHrefResolver::default_data_resolver();
    options.image_href_resolver.resolve_data = Box::new(move |mime, bytes, options| {
        let key = (mime.to_string(), bytes.clone());
        let cached = data_state.images.lock().unwrap().get(&key).cloned();
        if let Some(image) = cached {
            return Some(image);
        }
        // usvg's default SVG-image loader discards *all* nested images. Parse
        // with these same bounded resolvers instead, retaining embedded PNGs.
        let is_svg = mime == "image/svg+xml"
            || mime == "text/plain"
                && String::from_utf8_lossy(&bytes)
                    .trim_start_matches('\u{feff}')
                    .trim_start()
                    .starts_with('<');
        let image = if is_svg {
            data_state.svg(&bytes, options)
        } else {
            default_data(mime, bytes, options)
        };
        if let Some(image) = image.as_ref() {
            data_state.images.lock().unwrap().insert(key, image.clone());
        } else {
            data_state.fail(format!("无法解析嵌入的 {mime} 图片，已停止导出以避免缺图"));
        }
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
            Err(error) => {
                staged_state.fail(error);
                None
            }
        }
    });
    let tree = usvg::Tree::from_str(svg, &options)
        .map_err(|error| format!("拼版 SVG 解析失败：{error}"))?;
    if let Some(error) = state.error.lock().unwrap().take() {
        return Err(error);
    }
    Ok(tree)
}

struct PendingFile(PathBuf);
impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Build a complete file in the same directory, then publish it without ever
/// replacing another file (including one created after the batch preflight).
#[cfg(test)]
fn commit_pdf(output: &Path, bytes: &[u8]) -> Result<(), String> {
    commit_pdf_reader(output, &mut std::io::Cursor::new(bytes))
}

pub(crate) fn commit_pdf_file(output: &Path, source: &Path) -> Result<(), String> {
    let mut source = fs::File::open(source).map_err(|e| format!("读取已完成 PDF 失败：{e}"))?;
    commit_pdf_reader(output, &mut source)
}

fn commit_pdf_reader(output: &Path, source: &mut impl Read) -> Result<(), String> {
    commit_export_reader(output, source, "pdf")
}

pub(crate) fn commit_dxf(output: &Path, bytes: &[u8]) -> Result<(), String> {
    commit_export_reader(output, &mut std::io::Cursor::new(bytes), "dxf")
}

fn commit_export_reader(output: &Path, source: &mut impl Read, extension: &str) -> Result<(), String> {
    let format_name = extension.to_ascii_uppercase();
    // Conversion may overlap, but destination disk writes and publication cannot.
    static COMMIT: Mutex<()> = Mutex::new(());
    let _commit = COMMIT.lock().map_err(|_| format!("{format_name} 写盘调度器异常"))?;
    checked_export_output(&output.to_string_lossy(), extension)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = output.parent().ok_or_else(|| format!("{format_name} 导出目录无效"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temp = parent.join(format!(
        ".printflow-{extension}-{}-{stamp}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| format!("创建 {format_name} 临时文件失败：{error}"))?;
    let pending = PendingFile(temp);
    std::io::copy(source, &mut file)
        .map(|_| ())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入 {format_name} 失败：{error}"))?;
    drop(file);
    // std::fs::rename also replaces an existing Windows destination. Invoke
    // MoveFileExW without REPLACE_EXISTING for an atomic create-if-absent commit.
    #[cfg(windows)]
    let result = move_without_replace(&pending.0, output);
    #[cfg(not(windows))]
    let result = fs::hard_link(&pending.0, output);
    result.map_err(|error| {
        if output.exists() {
            format!("文件已存在，未覆盖：{}", output.display())
        } else {
            format!("提交 {format_name} 文件失败：{error}")
        }
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
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn nested_svg_fixture() -> String {
        let mut png = tiny_skia::Pixmap::new(2, 2).unwrap();
        png.fill(tiny_skia::Color::from_rgba8(0, 255, 0, 255));
        let png = base64::engine::general_purpose::STANDARD.encode(png.encode_png().unwrap());
        let inner = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 10 20"><rect width="10" height="20" fill="red"/><image x="0" y="10" width="10" height="10" href="data:image/png;base64,{png}"/></svg>"#
        );
        let inner = base64::engine::general_purpose::STANDARD.encode(inner);
        format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464"><defs><clipPath id="clip"><rect x="10" y="10" width="12" height="30"/></clipPath><mask id="mask" maskUnits="userSpaceOnUse" x="50" y="10" width="30" height="30"><rect x="50" y="10" width="15" height="30" fill="white"/></mask><g id="source"><image x="10" y="10" width="30" height="30" preserveAspectRatio="none" opacity="0.5" clip-path="url(#clip)" href="data:image/svg+xml;base64,{inner}"/><image x="50" y="10" width="30" height="30" preserveAspectRatio="xMidYMid meet" mask="url(#mask)" href="data:image/svg+xml;base64,{inner}"/><image x="90" y="10" width="30" height="30" preserveAspectRatio="none" style="opacity:0.25" href="data:image/svg+xml;base64,{inner}"/></g></defs><use href="#source" transform="translate(0 100)"/><use href="#source" transform="translate(180 200) rotate(90)"/></svg>"##
        )
    }
    #[test]
    fn shared_nested_svg_images_preserve_clip_opacity_mask_viewports_and_raster_children() {
        let svg = nested_svg_fixture();
        let tree = parse_board_svg(&svg).unwrap();
        let mut pixels = tiny_skia::Pixmap::new(300, 464).unwrap();
        pixels.fill(tiny_skia::Color::WHITE);
        resvg::render(
            &tree,
            tiny_skia::Transform::from_scale(
                300.0 / tree.size().width(),
                464.0 / tree.size().height(),
            ),
            &mut pixels.as_mut(),
        );
        let color = |x, y| {
            let p = pixels.pixel(x, y).unwrap();
            [p.red(), p.green(), p.blue()]
        };
        assert_eq!(
            color(17, 115),
            [255, 128, 128],
            "image opacity must survive a defs/use placement"
        );
        assert_eq!(color(25, 115), [255, 255, 255], "image clip must survive");
        assert_eq!(
            color(17, 130),
            [128, 255, 128],
            "nested PNG must not be discarded"
        );
        assert_eq!(
            color(52, 115),
            [255, 255, 255],
            "meet centers the narrow SVG in the image viewport"
        );
        assert_eq!(color(60, 115), [255, 0, 0]);
        assert_eq!(color(70, 115), [255, 255, 255], "image mask must survive");
        assert_eq!(
            color(100, 115),
            [255, 191, 191],
            "none stretches and image-local style remains"
        );
        assert_eq!(
            color(165, 217),
            [255, 128, 128],
            "second use rotation preserves the same layers"
        );
        let pdf = render_pdf(svg, page_size(300.0, 464.0).unwrap(), |_| {}).unwrap();
        assert!(
            String::from_utf8_lossy(&pdf).contains("/Subtype /Image"),
            "nested PNG must reach PDF conversion"
        );
    }
    #[test]
    fn repeated_png_copies_share_one_lossless_image_and_alpha_resource() {
        let mut pixels = tiny_skia::Pixmap::new(2, 1).unwrap();
        pixels.data_mut().copy_from_slice(&[255, 0, 0, 255, 0, 128, 0, 128]);
        let png = base64::engine::general_purpose::STANDARD.encode(pixels.encode_png().unwrap());
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm"><defs><g id="art"><image width="20" height="10" href="data:image/png;base64,{png}"/></g></defs><use href="#art"/><use href="#art" x="30"/><use href="#art" x="60" transform="rotate(90 60 0)"/></svg>"##
        );
        let pdf = render_pdf(svg, page_size(300., 464.).unwrap(), |_| {}).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert_eq!(text.matches("/Subtype /Image").count(), 2,
            "QT copies must share one lossless RGB image and one alpha mask");
        assert_eq!(text.matches("/SMask ").count(), 1);
    }
    #[test]
    fn interlaced_png_preserves_palette_alpha_and_sixteen_bit_samples() {
        use sha2::{Digest, Sha256};
        // Independently encoded Adam7 fixtures: 1-bit grayscale, indexed with
        // tRNS, and 16-bit RGBA. 9 x 7 exercises all seven uneven-sized passes.
        let cases = [
            ("iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHAQAAAAGF52pbAAAAEklEQVR4nGNgQAEfoHBVAwQBAEDVBz/8XSdyAAAAAElFTkSuQmCC", 8,
             "47fe02fd7e8d2b62d6c36c68951a99ecfe1ca1ae228fd5c0efb2ddfa9cc37fdb", None),
            ("iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHAQMAAAGXUsW1AAAABlBMVEX/AAAA/wDSh+9xAAAAAnRSTlP/QJNrcdoAAAASSURBVHicY2BAAR+gcFUDBAEAQNUHP/xdJ3IAAAAASUVORK5CYII=", 8,
             "26ca963c1b74128928ed44f00786c2d7d660fb1be4985d9be73d023b1733ac2c", Some("9bffe0576b4600a6d099d55ce2b31ba8e6e86eb8cfcdf4bb4fd9bbb2474cecaa")),
            ("iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHEAYAAAH9DIu1AAABW0lEQVR4nC3Qj0edcRiH4fv+jkTKyIgcRmJkZBOJkRhHRGKaSMQRkZhNpMRETGSJLJGIiWwiSyQikc3IEhmRkWVkMzIi7fW8/8DnxwXQxCBL/LRgl1PwklVOrYY5DrjxseU+8YXvHXPd81QLLQyzwgkf+GGNHfDVOzY7ZJsjrnkG7UywwQWTbHFpHTv89YG9/POh/c77yAEXPSQrsuh4FuNrN7MFbvvHaXe9Sg3ue50aUwkKdDHFNt1Ms8sVb9nn2kY+i00OwgCLHFrGMsdW2Mp37/rUUe/Z7oQbsM65tXbyy/s+84319jjjnn3OeeANWZwlF7I4lzxy2BVPUpWrnqbqVIR6ephhjzZGWOOMviBiLLJ5FxB8ig6+BR2/867KACL4rIorNgS4xbhkKVj/e5BvKeQuLbHJ7vAhdH0el30Vys7m1z/m2l+CwItQT2VOuuVlqnPZ41SRWm8BE/J+Z9WoZ7cAAAAASUVORK5CYII=", 16,
             "bde63801092d2803eefe867e5d5fc65200067f1cfc299e9c39614ef86b2f558e", Some("ef74991e42356f2190ef2e0abc04abe0aaa26aeede3a4d31c22930cad901f749")),
        ];
        for (png, bits, rgb, alpha) in cases {
            let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm"><image width="90" height="70" href="data:image/png;base64,{png}"/></svg>"#);
            let pdf = render_pdf(svg, page_size(300., 464.).unwrap(), |_| {}).unwrap();
            let mut remaining = pdf.as_slice();
            let mut hashes = Vec::new();
            while let Some(image) = remaining.windows(15).position(|p| p == b"/Subtype /Image") {
                let start = remaining[..image].windows(2).rposition(|p| p == b"<<").unwrap();
                let stream = image + remaining[image..].windows(7).position(|p| p == b"stream\n").unwrap() + 7;
                let header = std::str::from_utf8(&remaining[start..stream]).unwrap();
                assert!(header.contains(&format!("/BitsPerComponent {bits}")));
                let length: usize = header.split("/Length ").nth(1).unwrap().split_whitespace().next().unwrap().parse().unwrap();
                let mut decoded = Vec::new();
                flate2::read::ZlibDecoder::new(&remaining[stream..stream + length]).read_to_end(&mut decoded).unwrap();
                hashes.push(format!("{:x}", Sha256::digest(&decoded)));
                remaining = &remaining[stream + length..];
            }
            let expected: Vec<_> = alpha.into_iter().chain(std::iter::once(rgb)).collect();
            assert_eq!(hashes, expected, "PNG samples must survive PDF conversion exactly");
        }
    }
    #[test]
    fn invalid_embedded_svg_fails_instead_of_silently_dropping_an_image() {
        let encoded = base64::engine::general_purpose::STANDARD.encode("<svg broken");
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm"><image width="20" height="20" href="data:image/svg+xml;base64,{encoded}"/></svg>"#
        );
        assert!(parse_board_svg(&svg)
            .unwrap_err()
            .contains("嵌入 SVG 图片解析失败"));
    }
    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "printflow-imposition-pdf-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn board_dimensions_are_mm_not_a4() {
        let (w, h) = page_size(300.0, 464.0).unwrap();
        assert!((w - 850.3937).abs() < 0.001);
        assert!((h - 1315.2756).abs() < 0.001);
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, 10_001.0] {
            assert!(page_size(invalid, 464.0).is_err());
        }
        assert!(crate::staged_artwork::path("../secret").is_err());
    }
    #[test]
    fn board_pdf_retains_gradient_clip_and_physical_page_transform() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><clipPath id="c"><rect width="20" height="30"/></clipPath></defs><g transform="translate(70 120) rotate(90)"><rect width="40" height="40" fill="url(#g)" clip-path="url(#c)"/></g><path d="M 15 20 L 45 20 L 45 60 Z" fill="none" stroke="magenta" stroke-width="0.1"/></svg>"##;
        let pdf = render_pdf(svg.into(), page_size(300.0, 464.0).unwrap(), |_| {}).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(
            text.contains("/MediaBox [0 0 850.3937 1315.2756]"),
            "{text}"
        );
        assert!(text.contains("850.3937 0 0 1315.2756 0 0 cm"));
        assert!(text.contains("/ShadingType"), "gradient must stay vector");
        assert!(!text.contains("595.2756"));
    }
    #[test]
    fn board_pdf_rejects_mismatched_svg_page_instead_of_distorting() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"210mm\" height=\"297mm\"><path d=\"M0 0L1 1\"/></svg>";
        assert!(
            render_pdf(svg.into(), page_size(300.0, 464.0).unwrap(), |_| {})
                .unwrap_err()
                .contains("比例")
        );
    }
    #[test]
    fn ordered_pages_keep_independent_resources_and_identical_physical_board_sizes() {
        use std::cell::RefCell;
        let colored_page = |color: &str| {
            format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464"><defs><linearGradient id="g"><stop stop-color="{color}"/><stop offset="1" stop-color="white"/></linearGradient></defs><path d="M20 20H80V80H20Z" fill="url(#g)"/></svg>"##
            )
        };
        let mut sources = [
            colored_page("red"),
            nested_svg_fixture(),
            colored_page("blue"),
        ]
        .into_iter();
        let events = RefCell::new(Vec::new());
        let bytes = render_pdf_pages(
            3,
            |index| {
                events.borrow_mut().push(format!("load:{index}"));
                Ok(sources.next().unwrap())
            },
            page_size(300.0, 464.0).unwrap(),
            |index, phase| events.borrow_mut().push(format!("{phase}:{index}")),
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("/Count 3"));
        assert_eq!(
            text.matches("/MediaBox [0 0 850.3937 1315.2756]").count(),
            3
        );
        let mut object_ids = HashSet::new();
        let mut object_references = Vec::new();
        for object in text.split("endobj") {
            // Only scan object dictionaries, not binary image/compressed streams.
            let header = object.split("\nstream\n").next().unwrap();
            for line in header.lines() {
                if let Some(id) = line
                    .strip_suffix(" 0 obj")
                    .and_then(|id| id.parse::<i32>().ok())
                {
                    assert!(
                        object_ids.insert(id),
                        "PDF object {id} was reused across pages"
                    );
                }
            }
            let tokens: Vec<_> = header.split_whitespace().collect();
            for reference in tokens
                .windows(3)
                .filter(|tokens| tokens[1] == "0" && tokens[2] == "R")
            {
                if let Ok(id) = reference[0].trim_start_matches('[').parse::<i32>() {
                    object_references.push(id);
                }
            }
        }
        assert!(
            object_ids.len() > 15,
            "fixture must include real per-page image/gradient resources"
        );
        for id in object_references {
            assert!(
                object_ids.contains(&id),
                "PDF refers to missing object {id}"
            );
        }
        let board_refs: Vec<_> = text
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("/BoardSvg ")
                    .and_then(|value| value.strip_suffix(" 0 R"))
            })
            .collect();
        assert_eq!(board_refs.len(), 3);
        assert_eq!(
            board_refs.iter().collect::<HashSet<_>>().len(),
            3,
            "each page must refer to its own converted SVG"
        );
        let events = events.borrow();
        let load_positions: Vec<_> = (0..3)
            .map(|index| {
                events
                    .iter()
                    .position(|event| event == &format!("load:{index}"))
            })
            .collect();
        let convert_positions: Vec<_> = (1..=3)
            .map(|index| {
                events
                    .iter()
                    .position(|event| event == &format!("merge:{index}"))
            })
            .collect();
        assert!(load_positions.iter().all(Option::is_some));
        assert!(convert_positions.iter().all(Option::is_some));
        assert!(load_positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(convert_positions.windows(2).all(|pair| pair[0] < pair[1]));
        for index in 0..3 {
            assert!(load_positions[index] < convert_positions[index]);
        }
    }
    #[test]
    fn every_pdf_page_has_an_inset_point_two_mm_black_vector_board_border() {
        let size = page_size(300.0, 464.0).unwrap();
        let bytes = render_pdf_pages(2, |_| Ok(nested_svg_fixture()), size, |_, _| {}).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let streams: Vec<_> = text
            .split("\nstream\n")
            .skip(1)
            .filter_map(|part| {
                let content = part.split("\nendstream").next().unwrap();
                content.contains("/BoardSvg Do").then_some(content)
            })
            .collect();
        assert_eq!(streams.len(), 2);
        for stream in streams {
            assert!(
                stream.contains("/BoardSvg Do\nQ\n"),
                "restore the SVG scale before stroking the physical border"
            );
            assert!(stream.contains("0 0 0 RG"), "border must be black");
            let width = stream
                .lines()
                .find_map(|line| line.strip_suffix(" w"))
                .unwrap()
                .parse::<f32>()
                .unwrap();
            assert!((width * 25.4 / 72.0 - 0.2).abs() < 0.00001);
            let rect: Vec<f32> = stream
                .lines()
                .find_map(|line| line.strip_suffix(" re"))
                .unwrap()
                .split_whitespace()
                .map(|value| value.parse().unwrap())
                .collect();
            assert_eq!(rect.len(), 4);
            assert!((rect[0] - width / 2.0).abs() < 0.00001);
            assert!((rect[1] - width / 2.0).abs() < 0.00001);
            assert!((rect[2] + width - size.0).abs() < 0.0001);
            assert!((rect[3] + width - size.1).abs() < 0.0002);
            assert!(
                stream.trim_end().ends_with('S'),
                "border is an unfilled stroke"
            );
        }
    }
    #[test]
    fn later_page_failure_never_publishes_a_partial_layout_pdf() {
        let dir = scratch();
        let first = dir.join("first.svg");
        let second = dir.join("second.svg");
        let output = dir.join("整版.pdf");
        fs::write(&first, nested_svg_fixture()).unwrap();
        fs::write(&second, "<svg broken").unwrap();
        let error = export_staged_pdf(
            output.to_str().unwrap(),
            &[first, second],
            page_size(300.0, 464.0).unwrap(),
            |_, phase| {
                assert_ne!(
                    phase, "write",
                    "no publish phase before every page is valid"
                );
            },
        )
        .unwrap_err();
        assert!(error.contains("第 2 / 2 页"), "{error}");
        assert!(!output.exists());
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            2,
            "no incomplete PDF or temporary file should remain"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn empty_pdf_page_list_is_rejected_before_loading() {
        assert!(render_pdf_pages(
            0,
            |_| panic!("empty page list must not load a resource"),
            page_size(300.0, 464.0).unwrap(),
            |_, _| {}
        )
        .unwrap_err()
        .contains("没有可导出"));
    }
    #[test]
    fn atomic_commit_never_overwrites_and_cleans_temporary_file() {
        let dir = scratch();
        let output = dir.join("图层_01.pdf");
        commit_pdf(&output, b"first").unwrap();
        assert!(commit_pdf(&output, b"second").is_err());
        assert_eq!(fs::read(&output).unwrap(), b"first");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(checked_output(output.to_str().unwrap()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_publication_cannot_overwrite_and_failed_copy_leaves_no_partial_pdf() {
        let dir = scratch();
        let output = dir.join("competing.pdf");
        let barrier = std::sync::Barrier::new(2);
        let results = thread::scope(|scope| {
            let handles: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
                .into_iter()
                .map(|bytes| {
                    let output = &output;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        commit_pdf(output, bytes)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let data = fs::read(&output).unwrap();
        assert!(data == b"first" || data == b"second");
        struct Failing;
        impl Read for Failing {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("simulated disk read failure"))
            }
        }
        let failed = dir.join("failed.pdf");
        assert!(commit_pdf_reader(&failed, &mut Failing).is_err());
        assert!(!failed.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn parallel_conversion_merges_pages_in_input_order() {
        let sources: Vec<_> = (0..8)
            .map(|index| {
                nested_svg_fixture().replace("rotate(90)", &format!("rotate({})", index * 45))
            })
            .collect();
        let merged = std::cell::RefCell::new(Vec::new());
        let bytes = render_pdf_pages_with_workers(
            sources.len(),
            |i| Ok(sources[i].clone()),
            page_size(300.0, 464.0).unwrap(),
            |index, phase| {
                if phase == "merge" {
                    merged.borrow_mut().push(index);
                }
            },
            Some(4),
        )
        .unwrap();
        assert_eq!(*merged.borrow(), (1..=8).collect::<Vec<_>>());
        assert!(String::from_utf8_lossy(&bytes).contains("/Count 8"));
    }
    #[test]
    #[ignore = "Set PRINTFLOW_IMPOSITION_PDF_FIXTURE and PRINTFLOW_IMPOSITION_PDF_OUTPUT for a real export/render check"]
    fn export_board_fixture() {
        let input = std::env::var("PRINTFLOW_IMPOSITION_PDF_FIXTURE").unwrap();
        let output = PathBuf::from(std::env::var("PRINTFLOW_IMPOSITION_PDF_OUTPUT").unwrap());
        let pdf = render_pdf(
            fs::read_to_string(input).unwrap(),
            page_size(300.0, 464.0).unwrap(),
            |_| {},
        )
        .unwrap();
        commit_pdf(&output, &pdf).unwrap();
    }
    #[test]
    #[ignore = "Set PRINTFLOW_IMPOSITION_PDF_FIXTURES to a JSON array of SVG paths and PRINTFLOW_IMPOSITION_PDF_OUTPUT for a real multi-page export"]
    fn export_multi_page_board_fixture() {
        let inputs: Vec<PathBuf> =
            serde_json::from_str(&std::env::var("PRINTFLOW_IMPOSITION_PDF_FIXTURES").unwrap())
                .unwrap();
        let output = std::env::var("PRINTFLOW_IMPOSITION_PDF_OUTPUT").unwrap();
        export_staged_pdf(
            &output,
            &inputs,
            page_size(300.0, 464.0).unwrap(),
            |_, _| {},
        )
        .unwrap();
    }
    #[test]
    #[ignore = "Set PRINTFLOW_IMPOSITION_PDF_OUTPUT for Poppler verification of nested SVG image semantics"]
    fn export_nested_svg_fixture() {
        let output = PathBuf::from(std::env::var("PRINTFLOW_IMPOSITION_PDF_OUTPUT").unwrap());
        let pdf = render_pdf(
            nested_svg_fixture(),
            page_size(300.0, 464.0).unwrap(),
            |_| {},
        )
        .unwrap();
        commit_pdf(&output, &pdf).unwrap();
    }
}
