//! Bounded raster previews. Original artwork never crosses IPC for a list card.
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
// Large SVGs are compacted before usvg parses them. This is a compressed-file
// limit, never permission to allocate an equally large decoded pixel canvas.
const MAX_SVG_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_NESTED_BYTES: usize = 2 * 1024 * 1024;
const MAX_RASTER_PIXELS: u64 = 24 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 512;
const MAX_PNG_BYTES: u64 = 4 * 1024 * 1024;

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn edge(value: Option<u32>) -> u32 {
    value.unwrap_or(256).clamp(128, 512)
}

pub(crate) fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let limit = if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        MAX_SVG_SOURCE_BYTES
    } else {
        MAX_SOURCE_BYTES
    };
    let file = fs::File::open(path).map_err(|_| "预览源文件不可访问")?;
    let size = file.metadata().map_err(|_| "无法读取预览源文件信息")?.len();
    if size > limit {
        return Err("图片超过安全预览大小，原文件仍保留".into());
    }
    let mut bytes = Vec::new();
    // Avoid Vec's doubling growth for a 120 MB source; leave one byte to detect
    // files that grow between metadata and reading without another allocation.
    bytes
        .try_reserve_exact(size as usize + 1)
        .map_err(|_| "预览源文件内存不足")?;
    file.take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "预览源文件读取失败")?;
    if bytes.len() as u64 != size {
        return Err("预览源文件读取期间发生变化，请重试".into());
    }
    if bytes.len() as u64 > limit {
        return Err("图片超过安全预览大小，原文件仍保留".into());
    }
    Ok(bytes)
}

#[derive(Default)]
struct Budget {
    pixels: u64,
    failed: bool,
    depth: u32,
}

fn raster_wrapper(width: u32, height: u32, png: &[u8]) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><image width="{width}" height="{height}" preserveAspectRatio="none" href="data:image/png;base64,{}"/></svg>"#,
        STANDARD.encode(png)
    )
}

// Base64 in exported SVG attributes can contain line breaks. Decode it as a
// stream instead of retaining another complete compressed PNG in memory.
struct Base64Text<'a>(&'a [u8]);
impl Read for Base64Text<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut written = 0;
        while written < output.len() && !self.0.is_empty() {
            let byte = self.0[0];
            self.0 = &self.0[1..];
            if !byte.is_ascii_whitespace() {
                output[written] = byte;
                written += 1;
            }
        }
        Ok(written)
    }
}

fn compact_large_svg(source: &[u8], max_edge: u32) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(source).map_err(|_| "大 SVG 预览编码不支持")?;
    // Match usvg's parser: Corel exports include a standard SVG DOCTYPE.
    let document = roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|error| format!("大 SVG 预览解析失败：{error}"))?;
    let mut compact = Vec::new();
    let mut offset = 0;
    let mut replaced = false;
    let append = |output: &mut Vec<u8>, bytes: &[u8]| -> Result<(), String> {
        if output.len().saturating_add(bytes.len()) as u64 > MAX_SOURCE_BYTES {
            return Err("SVG 精简后仍超过安全预览预算，原文件仍保留".into());
        }
        output
            .try_reserve(bytes.len())
            .map_err(|_| "SVG 预览内存不足")?;
        output.extend_from_slice(bytes);
        Ok(())
    };
    for node in document
        .descendants()
        .filter(|node| node.has_tag_name("image"))
    {
        for attribute in node
            .attributes()
            .filter(|attribute| attribute.name() == "href")
        {
            let Some((header, encoded)) = attribute.value().split_once(',') else {
                continue;
            };
            if !header.eq_ignore_ascii_case("data:image/png;base64") {
                continue;
            }
            let range = attribute.range_value();
            if range.start < offset {
                return Err("SVG 预览图片引用重叠".into());
            }
            append(&mut compact, &source[offset..range.start])?;
            let reader =
                base64::read::DecoderReader::new(Base64Text(encoded.as_bytes()), &STANDARD);
            let reduced = crate::asset_preview_png::reduce(reader, max_edge)?;
            let wrapper = raster_wrapper(reduced.width, reduced.height, &reduced.png);
            append(&mut compact, b"data:image/svg+xml;base64,")?;
            append(&mut compact, STANDARD.encode(wrapper).as_bytes())?;
            offset = range.end;
            replaced = true;
        }
    }
    if !replaced {
        return Err("大 SVG 未找到可安全缩小的 PNG 图层，原文件仍保留".into());
    }
    append(&mut compact, &source[offset..])?;
    Ok(compact)
}

fn resolve_image(
    mime: &str,
    data: Arc<Vec<u8>>,
    opts: &usvg::Options,
    budget: &Mutex<Budget>,
    max_edge: u32,
) -> Option<usvg::ImageKind> {
    if budget
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .failed
    {
        return None;
    }
    let fail = || {
        budget
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .failed = true;
        None
    };
    if mime == "image/svg+xml" {
        {
            let mut state = budget.lock().unwrap_or_else(|error| error.into_inner());
            let nested_limit = if max_edge > 512 { 96 * 1024 * 1024 } else { MAX_NESTED_BYTES };
            if data.len() > nested_limit || state.depth >= 4 {
                state.failed = true;
                return None;
            }
            state.depth += 1;
        }
        let tree = usvg::Tree::from_data(&data, opts).ok();
        budget
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .depth -= 1;
        return tree.map(usvg::ImageKind::SVG).or_else(fail);
    }
    let is_png = data.starts_with(b"\x89PNG\r\n\x1a\n");
    let dimensions = if data.starts_with(b"GIF8") && data.len() >= 10 {
        Some((
            u16::from_le_bytes([data[6], data[7]]) as u32,
            u16::from_le_bytes([data[8], data[9]]) as u32,
        ))
    } else {
        image::ImageReader::new(Cursor::new(data.as_slice()))
            .with_guessed_format()
            .ok()
            .and_then(|reader| reader.into_dimensions().ok())
    };
    let Some((width, height)) = dimensions else {
        return fail();
    };
    let pixels = u64::from(width) * u64::from(height);
    if is_png && (width > max_edge || height > max_edge) {
        // The PNG decoder retains only scanlines plus the small output. A
        // 26,575 x 34,097 image must never allocate its 3.6 GB pixel canvas.
        let reduced = crate::asset_preview_png::reduce(Cursor::new(data.as_slice()), max_edge).ok();
        let tree = reduced.and_then(|reduced| {
            usvg::Tree::from_str(
                &raster_wrapper(reduced.width, reduced.height, &reduced.png),
                opts,
            )
            .ok()
        });
        return tree.map(usvg::ImageKind::SVG).or_else(fail);
    }
    if width > 16_384 || height > 16_384 || pixels == 0 || pixels > MAX_RASTER_PIXELS {
        return fail();
    }
    if width > max_edge || height > max_edge {
        // Decode only one bounded raster at a time, then retain the reduced PNG.
        // A nested SVG preserves the original natural dimensions even when the
        // authored <image> omits width/height or uses preserveAspectRatio.
        let decoded = (|| -> Option<usvg::ImageKind> {
            let mut reader = image::ImageReader::new(Cursor::new(data.as_slice()))
                .with_guessed_format()
                .ok()?;
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(128 * 1024 * 1024);
            limits.max_image_width = Some(16_384);
            limits.max_image_height = Some(16_384);
            reader.limits(limits);
            let reduced = reader.decode().ok()?.thumbnail(max_edge, max_edge);
            let mut png = Cursor::new(Vec::new());
            reduced.write_to(&mut png, image::ImageFormat::Png).ok()?;
            let wrapper = raster_wrapper(width, height, &png.into_inner());
            let tree = usvg::Tree::from_str(&wrapper, opts).ok()?;
            Some(usvg::ImageKind::SVG(tree))
        })();
        return decoded.or_else(fail);
    }
    {
        let mut state = budget.lock().unwrap_or_else(|error| error.into_inner());
        if state.pixels.saturating_add(pixels) > MAX_RASTER_PIXELS {
            state.failed = true;
            return None;
        }
        state.pixels += pixels;
    }
    let image = usvg::ImageHrefResolver::default_data_resolver()(mime, data, opts);
    if image.is_none() {
        return fail();
    }
    image
}
/// Parsing retains compressed image data; check dimensions before resvg can
/// allocate its raster buffers. Never return a successful, incomplete preview.
pub(crate) fn render_png(source: &[u8], path: &Path, max_edge: u32) -> Result<Vec<u8>, String> {
    render_at_resolution(source, path, edge(Some(max_edge)))
}

/// PDF artwork uses its physical print size, independently of the 512 px UI cap.
pub(crate) fn render_at_resolution(source: &[u8], path: &Path, max_edge: u32) -> Result<Vec<u8>, String> {
    let max_edge = max_edge.clamp(1, 4096);
    if source.len() as u64 > MAX_SVG_SOURCE_BYTES {
        return Err("图片超过安全预览大小，原文件仍保留".into());
    }
    let compact;
    let source = if source.len() as u64 > MAX_SOURCE_BYTES {
        compact = compact_large_svg(source, max_edge)?;
        compact.as_slice()
    } else {
        source
    };
    let mut options = crate::assets::export_options()?;
    options.resources_dir = path.parent().map(Path::to_owned);
    let budget = Arc::new(Mutex::new(Budget::default()));
    let data_budget = budget.clone();
    let string_budget = budget.clone();

    options.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: Box::new(move |mime, data, opts| {
            resolve_image(mime, data, opts, &data_budget, max_edge)
        }),
        resolve_string: Box::new(move |href, opts| {
            let requested = opts
                .resources_dir
                .as_ref()
                .map(|root| root.join(href))
                .unwrap_or_else(|| PathBuf::from(href));
            let Some(data) = read_bounded(&requested).ok() else {
                string_budget
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .failed = true;
                return None;
            };
            resolve_image("text/plain", Arc::new(data), opts, &string_budget, max_edge)
        }),
    };
    let tree = usvg::Tree::from_data(source, &options).map_err(|_| "SVG 预览解析失败")?;
    if budget
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .failed
    {
        return Err("图片内容超过安全预览预算或存在无法读取的图层，原文件仍保留".into());
    }
    let scale = max_edge as f32 / tree.size().width().max(tree.size().height());
    let mut pixmap = tiny_skia::Pixmap::new(
        (tree.size().width() * scale)
            .ceil()
            .clamp(1.0, max_edge as f32) as u32,
        (tree.size().height() * scale)
            .ceil()
            .clamp(1.0, max_edge as f32) as u32,
    )
    .ok_or("无法创建安全预览")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().map_err(|_| "预览编码失败".into())
}

fn prune(cache: &Path) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_str()?;
            if path.extension()?.to_str()? != "png"
                || stem.len() != 64
                || !stem.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((path, metadata.len(), metadata.modified().ok()))
        })
        .collect();
    files.sort_by_key(|file| file.2);
    let mut bytes: u64 = files.iter().map(|file| file.1).sum();
    let mut count = files.len();
    for (path, size, _) in files {
        if bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_FILES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            bytes = bytes.saturating_sub(size);
            count -= 1;
        }
    }
}

fn cache_read(path: &Path, max_edge: u32) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_PNG_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_PNG_BYTES + 1).read_to_end(&mut bytes).ok()?;
    let (width, height) = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    (width > 0 && height > 0 && width <= max_edge && height <= max_edge).then_some(bytes)
}

fn publish(cache: &Path, target: &Path, png: &[u8]) {
    if fs::create_dir_all(cache).is_err() {
        return;
    }
    if let Ok(mut file) = tempfile::NamedTempFile::new_in(cache) {
        if file.write_all(png).is_ok() {
            let _ = file.persist(target);
        }
    }
    prune(cache);
}

fn from_path_in(
    path: &Path,
    cache: &Path,
    max_edge: u32,
    expected_hash: Option<&str>,
) -> Result<String, String> {
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(from_path_png_in(path,cache,max_edge,expected_hash)?)))
}

fn resize_preview(png: &[u8], edge: u32) -> Result<Vec<u8>,String> {
    let image = image::load_from_memory(png).map_err(|_|"PNG 预览读取失败")?;
    let scale = edge as f64 / image.width().max(image.height()) as f64;
    let width = (image.width() as f64*scale).ceil().clamp(1.,edge as f64) as u32;
    let height = (image.height() as f64*scale).ceil().clamp(1.,edge as f64) as u32;
    let mut output = Cursor::new(Vec::new());
    image.resize_exact(width,height,image::imageops::FilterType::Lanczos3).write_to(&mut output,image::ImageFormat::Png).map_err(|_|"PNG 预览缩小失败")?;
    Ok(output.into_inner())
}

fn path_cache_key(path: &Path, metadata: &fs::Metadata, edge: u32, expected_hash: Option<&str>) -> String {
    let modified = metadata.modified().ok().and_then(|value|value.duration_since(UNIX_EPOCH).ok()).map(|value|value.as_nanos());
    hash(format!("bounded-preview-v3:{}:{}:{:?}:{}:{:?}",path.to_string_lossy(),metadata.len(),modified,edge,expected_hash).as_bytes())
}

fn from_path_png_in(path: &Path,cache: &Path,max_edge: u32,expected_hash: Option<&str>) -> Result<Vec<u8>,String> {
    let metadata = fs::metadata(path).map_err(|_| "预览源文件不可访问")?;
    if metadata.len() > MAX_SVG_SOURCE_BYTES {
        return Err("图片超过安全预览大小，原文件仍保留".into());
    }
    let max_edge = edge(Some(max_edge));
    let key_for = |edge| path_cache_key(path,&metadata,edge,expected_hash);
    let target = cache.join(format!("{}.png",key_for(max_edge)));
    {
        let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?;
        if let Some(png) = cache_read(&target,max_edge) {
            return Ok(png);
        }
    }
    let _permit = crate::preview_runtime::acquire(metadata.len() as usize)?;
    // All sizes for one source share the same work lock. A history request
    // warming the 512 px master cannot race another view into decoding SVG twice.
    let entry = crate::preview_runtime::key_lock(&cache.join(format!("{}.png",key_for(512))))?;
    let _entry = entry.lock().map_err(|_|"图片缓存暂不可用")?;
    let cached = {
        let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?;
        cache_read(&target,max_edge)
    };
    let png = if let Some(png) = cached { png } else {
        let larger = {
            let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?;
            [256,512].into_iter().filter(|edge|*edge>max_edge).find_map(|edge|cache_read(&cache.join(format!("{}.png",key_for(edge))),edge))
        };
        let png = if let Some(png) = larger { resize_preview(&png,max_edge)? } else {
        let bytes = read_bounded(path)?;
        if expected_hash.is_some_and(|expected| hash(&bytes) != expected) {
            return Err("共享图片校验失败，文件可能被外部修改".into());
        }
        render_png(&bytes, path, max_edge)?
        };
        { let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?; publish(cache, &target, &png); }
        png
    };
    Ok(png)
}

pub(crate) fn try_stage_preview(path: &Path,expected_hash: Option<&str>,required_edge: u32,output: &Path) -> Result<bool,String> {
    if required_edge>512 { return Ok(false); }
    // A background batch save can clean a retained import after it was
    // resolved. Treat this as a miss so the authoritative batch can recover.
    let Ok(metadata) = fs::metadata(path) else { return Ok(false); };
    let key = path_cache_key(path,&metadata,512,expected_hash);
    crate::preview_runtime::pin_preview(&crate::project_data_dir().join("cache/asset-previews").join(format!("{key}.png")),required_edge,output)
}

/// History cards retain a small response while populating the exact 512 px PNG
/// used by arrangement canvases. Smaller views derive from that cached master.
pub(crate) fn history_preview_from_path(path: &Path, expected_hash: Option<&str>) -> Result<String,String> {
    let cache = crate::project_data_dir().join("cache/asset-previews");
    from_path_png_in(path,&cache,512,expected_hash)?;
    from_path_in(path,&cache,128,expected_hash)
}

pub(crate) fn history_inline_preview(source: &[u8], path: &Path) -> Result<String,String> {
    let png = inline_png(source,path,512)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(resize_preview(&png,128)?)))
}

pub(crate) fn from_path(
    path: &Path,
    max_edge: u32,
    expected_hash: Option<&str>,
) -> Result<String, String> {
    from_path_in(
        path,
        &crate::project_data_dir().join("cache/asset-previews"),
        max_edge,
        expected_hash,
    )
}

fn inline(source: &[u8], path: &Path, max_edge: u32) -> Result<String, String> {
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(inline_png(source,path,max_edge)?)))
}

fn inline_png(source: &[u8], path: &Path, max_edge: u32) -> Result<Vec<u8>, String> {
    if path.as_os_str().is_empty() {
        return crate::schematic_raster::with_cached(source, max_edge, "", &[], |cached| {
            fs::read(cached).map_err(|_| "图片缓存读取失败".to_owned())
        });
    }
    let _permit = crate::preview_runtime::acquire(source.len())?;
    render_png(source, path, max_edge)
}

#[tauri::command]
pub async fn load_inline_asset_preview(
    svg: String,
    max_edge_px: Option<u32>,
) -> Result<String, String> {
    if svg.len() > 256 * 1024 {
        return Err("此图片需要源文件路径才能生成安全预览".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = if let Some(id) = svg.strip_prefix(crate::staged_artwork::PREFIX) {
            fs::metadata(crate::staged_artwork::path(id)?).map_err(|_|"预览临时资源不可访问")?.len() as usize
        } else { svg.len() };
        let _permit = crate::preview_runtime::acquire(bytes)?;
        if let Some(id) = svg.strip_prefix(crate::staged_artwork::PREFIX) {
            return staged_preview(id, edge(max_edge_px));
        }
        inline(svg.as_bytes(), Path::new(""), edge(max_edge_px))
    })
    .await
    .map_err(|_| "预览任务异常结束".to_owned())?
}

// Edited layer selections/back artwork has no saved batch path. Reuse bounded
// chunk staging rather than sending a second giant SVG JSON message to WebView2.
fn staged_preview(id: &str, max_edge: u32) -> Result<String, String> {
    let path = crate::staged_artwork::path(id)?;
    let size = fs::metadata(&path).map_err(|_| "预览临时资源不可访问")?.len();
    if size > MAX_SVG_SOURCE_BYTES {
        return Err("图片超过安全预览大小，原文件仍保留".into());
    }
    let mut source = Vec::new();
    source.try_reserve_exact(size as usize + 1).map_err(|_| "预览源文件内存不足")?;
    fs::File::open(&path).map_err(|_| "预览临时资源不可访问")?
        .take(size + 1).read_to_end(&mut source).map_err(|_| "预览临时资源读取失败")?;
    if source.len() as u64 != size { return Err("预览临时资源读取期间发生变化".into()); }
    inline(&source, Path::new(""), max_edge)
}

#[tauri::command]
pub async fn load_temp_asset_preview(
    path: String,
    max_edge_px: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = fs::canonicalize(crate::project_data_dir().join("temp-assets"))
            .map_err(|_| "临时图片目录不可访问")?;
        let actual = fs::canonicalize(path).map_err(|_| "临时图片不可访问")?;
        if !actual.starts_with(root) || !actual.is_file() {
            return Err("临时图片路径无效".into());
        }
        from_path(&actual, edge(max_edge_px), None)
    })
    .await
    .map_err(|_| "预览任务异常结束".to_owned())?
}

#[tauri::command]
pub async fn load_batch_asset_preview(
    app: tauri::AppHandle,
    batch_id: String,
    asset_id: String,
    max_edge_px: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::database(&app)?;
        // A legacy inline batch may contain hundreds of megabytes of XML.
        // Admit it before SQLite parses JSON, then keep that permit through
        // rendering. Normal reference-only manifests stay fully parallel.
        let payload_bytes: usize = conn.query_row("SELECT length(CAST(payload AS BLOB)) FROM batches WHERE id=?1", [&batch_id], |row|row.get(0)).map_err(|_|"历史批次不存在")?;
        let _legacy = if payload_bytes > 1024*1024 { Some(crate::preview_runtime::acquire(payload_bytes)?) } else { None };
        let asset = crate::batch_history::read_asset(&conn, &batch_id, &asset_id)?;
        if !asset.storage_path.is_empty() {
            from_path(Path::new(&asset.storage_path), edge(max_edge_px), None)
        } else {
            inline(asset.svg.as_bytes(), Path::new(""), edge(max_edge_px))
        }
    })
    .await
    .map_err(|_| "预览任务异常结束".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Read-only export-resource benchmark; set PRINTFLOW_PREVIEW_FIXTURE"]
    fn measure_export_preview_reuse() {
        let data: serde_json::Value = serde_json::from_slice(&fs::read(std::env::var("PRINTFLOW_PREVIEW_FIXTURE").unwrap()).unwrap()).unwrap();
        let mut sources: Vec<_> = data["assets"].as_array().unwrap().iter().filter_map(|asset| {
            let path = PathBuf::from(asset["storagePath"].as_str()?); let size = fs::metadata(&path).ok()?.len();
            (size<=16*1024*1024).then_some((path,size))
        }).collect();
        sources.sort_by_key(|(_,size)|std::cmp::Reverse(*size)); sources.truncate(8); assert_eq!(sources.len(),8);
        for (path,_) in &sources { from_path(path,512,None).unwrap(); }
        let start = std::time::Instant::now();
        for (path,_) in &sources {
            let bytes = read_bounded(path).unwrap(); let _version = hash(&bytes);
            render_at_resolution(&bytes,path,420).unwrap();
        }
        let original_ms = start.elapsed().as_millis();
        let outputs = tempfile::tempdir().unwrap();
        let start = std::time::Instant::now();
        for (index,(path,_)) in sources.iter().enumerate() {
            assert!(try_stage_preview(path,None,420,&outputs.path().join(format!("{index}.png"))).unwrap());
        }
        println!("sources={} original_bytes={} old_prepare_ms={original_ms} reuse_prepare_ms={}",sources.len(),sources.iter().map(|(_,size)|size).sum::<u64>(),start.elapsed().as_millis());
    }
    #[test]
    fn export_reuses_the_displayed_png_without_svg_decode_and_keeps_it_after_pruning() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("export-cache.svg");
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>"#;
        fs::write(&source,svg).unwrap();
        let displayed = from_path(&source,512,None).unwrap();
        let modified = fs::metadata(&source).unwrap().modified().unwrap();
        fs::write(&source,vec![b' ';svg.len()]).unwrap();
        fs::OpenOptions::new().write(true).open(&source).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        let output = root.path().join("pinned.png");
        assert!(try_stage_preview(&source,None,420,&output).unwrap());
        assert_eq!(STANDARD.decode(displayed.strip_prefix("data:image/png;base64,").unwrap()).unwrap(),fs::read(&output).unwrap());
        assert!(!try_stage_preview(&source,None,700,&root.path().join("high.png")).unwrap(),"a 512px preview must never replace larger print artwork");
        let info = fs::metadata(&source).unwrap();
        let stamp = info.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let key = hash(format!("bounded-preview-v3:{}:{}:{:?}:{}:{:?}",source.to_string_lossy(),info.len(),Some(stamp),512,None::<&str>).as_bytes());
        fs::remove_file(crate::project_data_dir().join("cache/asset-previews").join(format!("{key}.png"))).unwrap();
        assert!(tiny_skia::Pixmap::decode_png(&fs::read(&output).unwrap()).is_ok());
        fs::write(&source,svg.replace("red","blue")).unwrap();
        assert!(!try_stage_preview(&source,None,420,&root.path().join("changed.png")).unwrap());
    }
    #[test]
    #[ignore = "Read-only real-artwork benchmark; set PRINTFLOW_PREVIEW_FIXTURE to a batch metadata JSON"]
    fn measure_parallel_page_previews() {
        let fixture = std::env::var("PRINTFLOW_PREVIEW_FIXTURE").expect("metadata fixture");
        let data: serde_json::Value = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        let mut sources: Vec<_> = data["assets"].as_array().unwrap().iter().filter_map(|asset| {
            let path = PathBuf::from(asset["storagePath"].as_str()?);
            let bytes = fs::metadata(&path).ok()?.len();
            (bytes <= 16*1024*1024).then_some((path,bytes))
        }).collect();
        sources.sort_by_key(|(_,bytes)|std::cmp::Reverse(*bytes)); sources.truncate(8);
        assert_eq!(sources.len(),8);
        crate::assets::export_options().unwrap(); // Font initialization is common to both runs.
        let run = |workers: usize| {
            let cache = tempfile::tempdir().unwrap();
            let start = std::time::Instant::now();
            let mut result = Vec::new();
            for chunk in sources.chunks(workers) {
                std::thread::scope(|scope| {
                    let jobs: Vec<_> = chunk.iter().map(|(path,_)| {
                        let directory = cache.path();
                        scope.spawn(move || from_path_in(path,directory,256,None).unwrap())
                    }).collect();
                    for job in jobs { result.push(job.join().unwrap()); }
                });
            }
            (start.elapsed().as_millis(),result)
        };
        let (serial,expected) = run(1);
        let (parallel,actual) = run(4);
        assert_eq!(actual,expected);
        for (path,bytes) in &sources { assert_eq!(fs::metadata(path).unwrap().len(),*bytes); }
        println!("sources={} original_bytes={} serial_ms={serial} parallel_ms={parallel}",sources.len(),sources.iter().map(|(_,bytes)|bytes).sum::<u64>());
    }
    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="#f00"/></svg>"##;
    #[test]
    fn edited_staged_artwork_returns_a_bounded_preview_without_changing_its_source() {
        let id = format!("abc-{:x}", std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
        let path = crate::staged_artwork::path(&id).unwrap();
        let source = SVG.replace("</svg>", &format!("<!--{}--></svg>", "x".repeat(300 * 1024)));
        fs::write(&path, source.as_bytes()).unwrap();
        let result = staged_preview(&id, 512);
        let unchanged = fs::read(&path).unwrap() == source.as_bytes();
        fs::remove_file(&path).unwrap();
        let bytes = STANDARD.decode(result.unwrap().strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        let image = tiny_skia::Pixmap::decode_png(&bytes).unwrap();
        assert_eq!(image.width(), 512);
        assert!(image.height() <= 512);
        assert!(unchanged);
        assert!(staged_preview("../untrusted.svg", 512).is_err());
    }
    #[test]
    fn previews_are_png_bounded_and_do_not_change_artwork() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("image.svg");
        fs::write(&source, SVG).unwrap();
        let before = hash(&fs::read(&source).unwrap());
        let url = from_path_in(&source, &root.path().join("cache"), 256, Some(&before)).unwrap();
        let png = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let image = tiny_skia::Pixmap::decode_png(&png).unwrap();
        assert_eq!(image.width(), 256);
        assert!((192..=193).contains(&image.height()));
        assert!(png.len() < 16_000);
        assert_eq!(hash(&fs::read(source).unwrap()), before);
    }
    #[test]
    fn invalid_cached_images_are_not_returned_and_missing_sources_do_not_use_cache() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("image.svg");
        fs::write(&source, SVG).unwrap();
        let cache = root.path().join("cache");
        let first = from_path_in(&source, &cache, 256, None).unwrap();
        for file in fs::read_dir(&cache).unwrap() {
            fs::write(file.unwrap().path(), b"bad png").unwrap();
        }
        assert_eq!(from_path_in(&source, &cache, 256, None).unwrap(), first);
        fs::remove_file(&source).unwrap();
        assert!(from_path_in(&source, &cache, 256, None).is_err());
    }
    #[test]
    fn unsafe_embedded_image_dimensions_fail_without_decoding_or_partial_success() {
        let root = tempfile::tempdir().unwrap();
        let mut header = b"GIF89a".to_vec();
        header.extend_from_slice(&u16::MAX.to_le_bytes());
        header.extend_from_slice(&u16::MAX.to_le_bytes());
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/gif;base64,{}"/></svg>"#,
            STANDARD.encode(header)
        );
        assert!(render_png(svg.as_bytes(), &root.path().join("image.svg"), 256).is_err());
    }

    #[test]
    fn source_budget_and_expected_hash_are_checked_before_rendering() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("image.svg");
        let cache = root.path().join("cache");
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_SVG_SOURCE_BYTES + 1)
            .unwrap();
        assert!(read_bounded(&source).is_err());
        assert!(from_path_in(&source, &cache, 256, None).is_err());
        fs::write(&source, SVG).unwrap();
        assert!(from_path_in(&source, &cache, 256, Some("incorrect-hash")).is_err());
        assert!(!cache.exists());
    }

    #[test]
    fn large_svg_compaction_preserves_natural_size_clipping_and_original_file() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("large.svg");
        let mut raster = tiny_skia::Pixmap::new(8, 4).unwrap();
        raster.fill(tiny_skia::Color::from_rgba8(240, 20, 30, 255));
        let data = STANDARD.encode(raster.encode_png().unwrap());
        let svg = format!(
            r##"<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="4"><defs><clipPath id="cut"><rect x="4" width="4" height="4"/></clipPath><image id="original" xlink:href="data:image/png;base64,{}{}"/></defs><use xlink:href="#original" clip-path="url(#cut)"/><use x="8" xlink:href="#original"/></svg>"##,
            " \n".repeat(MAX_SOURCE_BYTES as usize / 2),
            data
        );
        assert!(svg.len() as u64 > MAX_SOURCE_BYTES);
        fs::write(&source, &svg).unwrap();
        let original_hash = hash(svg.as_bytes());
        drop(svg);
        let url = from_path_in(
            &source,
            &root.path().join("cache"),
            256,
            Some(&original_hash),
        )
        .unwrap();
        let png = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let bitmap = tiny_skia::Pixmap::decode_png(&png).unwrap();
        let at = |x: usize| &bitmap.data()[(32 * 256 + x) * 4..(32 * 256 + x) * 4 + 4];
        assert_eq!(at(32), [0, 0, 0, 0]);
        assert_eq!(at(96), [240, 20, 30, 255]);
        assert_eq!(at(160), [240, 20, 30, 255]);
        assert_eq!(hash(&fs::read(&source).unwrap()), original_hash);
    }

    #[test]
    #[ignore = "Set PRINTFLOW_PREVIEW_ASSET_MANIFEST to a read-only batch asset manifest"]
    fn real_batch_all_thumbnails_load() {
        let manifest = std::env::var("PRINTFLOW_PREVIEW_ASSET_MANIFEST").unwrap();
        let records: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        let numbers = std::env::var("PRINTFLOW_PREVIEW_NUMBERS").unwrap_or_default();
        let output = std::env::var_os("PRINTFLOW_PREVIEW_OUTPUT_DIR").map(PathBuf::from);
        if let Some(output) = &output {
            fs::create_dir_all(output).unwrap();
        }
        let root = tempfile::tempdir().unwrap();
        let mut failed = Vec::new();
        let mut completed = 0;
        for record in records {
            let number = record["number"].as_u64().unwrap();
            if !numbers.is_empty()
                && !numbers
                    .split(',')
                    .any(|value| value.parse::<u64>().ok() == Some(number))
            {
                continue;
            }
            let path = Path::new(record["path"].as_str().unwrap());
            let expected = path.file_stem().and_then(|stem| stem.to_str());
            match from_path_in(path, root.path(), 256, expected) {
                Ok(url) => {
                    let png = STANDARD
                        .decode(url.strip_prefix("data:image/png;base64,").unwrap())
                        .unwrap();
                    let bitmap = tiny_skia::Pixmap::decode_png(&png).unwrap();
                    assert!(bitmap.width() <= 256 && bitmap.height() <= 256);
                    assert!(
                        bitmap.data().chunks_exact(4).any(|pixel| pixel[3] > 0),
                        "No {number} returned an empty thumbnail"
                    );
                    if let Some(output) = &output {
                        fs::write(output.join(format!("No{number:02}.png")), png).unwrap();
                    }
                    completed += 1;
                }
                Err(error) => failed.push(format!("No {number}: {error}")),
            }
        }
        eprintln!(
            "Real batch thumbnails: completed={completed}, failed={}",
            failed.len()
        );
        assert!(failed.is_empty(), "{}", failed.join("\n"));
        assert!(completed > 0);
    }

    #[test]
    fn several_large_rasters_keep_natural_size_and_all_layers_in_the_small_preview() {
        let mut images = String::new();
        for (index, color) in [[255, 0, 0], [0, 255, 0], [0, 0, 255]]
            .into_iter()
            .enumerate()
        {
            let image = image::RgbImage::from_pixel(4000, 3000, image::Rgb(color));
            let mut png = Cursor::new(Vec::new());
            image.write_to(&mut png, image::ImageFormat::Png).unwrap();
            images.push_str(&format!(
                r#"<image x="{}" href="data:image/png;base64,{}"/>"#,
                index * 4000,
                STANDARD.encode(png.into_inner())
            ));
        }
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="12000" height="3000">{images}</svg>"#
        );
        let png = render_png(svg.as_bytes(), Path::new("image.svg"), 256).unwrap();
        let image = tiny_skia::Pixmap::decode_png(&png).unwrap();
        for (x, expected) in [
            (42, [255, 0, 0, 255]),
            (128, [0, 255, 0, 255]),
            (212, [0, 0, 255, 255]),
        ] {
            let start = (32 * image.width() as usize + x) * 4;
            assert_eq!(&image.data()[start..start + 4], expected.as_slice());
        }
    }

    #[test]
    #[ignore = "Set PRINTFLOW_PREVIEW_TEST_DIR to a local SVG sample directory"]
    fn real_svg_preview_stress_is_bounded() {
        let source_dir = std::env::var("PRINTFLOW_PREVIEW_TEST_DIR").unwrap();
        let sources: Vec<_> = fs::read_dir(source_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
            })
            .collect();
        assert!(!sources.is_empty());
        let before: Vec<_> = sources
            .iter()
            .map(|path| hash(&fs::read(path).unwrap()))
            .collect();
        let root = tempfile::tempdir().unwrap();
        let start = std::time::Instant::now();
        let mut rendered = 0;
        let mut refused = 0;
        let mut total_png_bytes = 0;
        for index in 0..64 {
            match from_path_in(&sources[index % sources.len()], root.path(), 256, None) {
                Ok(url) => {
                    let png = STANDARD
                        .decode(url.strip_prefix("data:image/png;base64,").unwrap())
                        .unwrap();
                    let image = tiny_skia::Pixmap::decode_png(&png).unwrap();
                    assert!(image.width() <= 256 && image.height() <= 256);
                    total_png_bytes += png.len();
                    rendered += 1;
                }
                Err(error) => {
                    assert!(error.contains("预览"));
                    refused += 1;
                }
            }
        }
        assert!(rendered > 0);
        for (path, expected) in sources.iter().zip(before) {
            assert_eq!(hash(&fs::read(path).unwrap()), expected);
        }
        eprintln!("preview stress: requests=64 sources={} rendered={} safely_refused={} total_png_bytes={} elapsed_ms={}", sources.len(), rendered, refused, total_png_bytes, start.elapsed().as_millis());
    }
}
