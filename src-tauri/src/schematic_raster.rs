//! Content-addressed PNGs for editable artwork. Export references are pinned
//! copies, so pruning this disposable cache cannot break an in-progress PDF.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) const PREFIX: &str = "printflow-png:";
const CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PNG_BYTES: u64 = 64 * 1024 * 1024;

fn valid(path: &Path, edge: u32) -> bool {
    if !fs::metadata(path).is_ok_and(|info| info.len() <= MAX_PNG_BYTES) {
        return false;
    }
    image::ImageReader::open(path)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .filter(|reader| reader.format() == Some(image::ImageFormat::Png))
        .and_then(|reader| reader.into_dimensions().ok())
        .is_some_and(|(w, h)| w > 0 && h > 0 && w <= edge && h <= edge)
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
                || !stem.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return None;
            }
            let info = entry.metadata().ok()?;
            Some((path, info.len(), info.modified().ok()))
        })
        .collect();
    files.sort_by_key(|file| file.2);
    let mut bytes: u64 = files.iter().map(|file| file.1).sum();
    let mut count = files.len();
    for (path, size, _) in files {
        if bytes <= CACHE_BYTES && count <= 512 {
            break;
        }
        if fs::remove_file(path).is_ok() {
            bytes = bytes.saturating_sub(size);
            count -= 1;
        }
    }
}

#[cfg(test)]
fn cached_in(
    source: &[u8],
    cache: &Path,
    edge: u32,
    source_version: &str,
    layer_ids: &[String],
) -> Result<PathBuf, String> {
    with_cached_in(source,cache,edge,source_version,layer_ids,|path|Ok(path.to_path_buf()))
}

fn with_cached_in<T>(
    source: &[u8], cache: &Path, edge: u32, source_version: &str, layer_ids: &[String],
    use_png: impl FnOnce(&Path)->Result<T,String>,
) -> Result<T,String> {
    let edge = edge.clamp(1, 4096);
    // The selected SVG hash is authoritative even if a caller reuses a version
    // or layer name. Original source version invalidates unchanged selections.
    let target = cache_path(cache,source,edge,source_version,layer_ids)?;
    {
        let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?;
        if valid(&target, edge) { return use_png(&target); }
    }
    let _permit = crate::preview_runtime::acquire(source.len())?;
    let entry = crate::preview_runtime::key_lock(&target)?;
    let _entry = entry.lock().map_err(|_|"图片缓存暂不可用")?;
    {
        let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?;
        if valid(&target,edge) { return use_png(&target); }
    }
    let png = crate::asset_previews::render_at_resolution(source, Path::new(""), edge)?;
    if png.len() as u64 > MAX_PNG_BYTES { return Err("导出图片超过缓存大小限制".into()); }
    let _cache = crate::preview_runtime::CACHE_LOCK.lock().map_err(|_|"图片缓存暂不可用")?;
    fs::create_dir_all(cache).map_err(|e| format!("图片缓存目录创建失败：{e}"))?;
    let mut file = tempfile::NamedTempFile::new_in(cache).map_err(|e| e.to_string())?;
    file.write_all(&png).map_err(|e| e.to_string())?;
    file.persist(&target).map_err(|e| e.to_string())?;
    let result = use_png(&target);
    prune(cache);
    result
}

fn cache_path(cache: &Path, source: &[u8], edge: u32, source_version: &str, layer_ids: &[String]) -> Result<PathBuf,String> {
    let key_data = serde_json::to_vec(&(
        "schematic-png-v1",
        source_version,
        layer_ids,
        edge,
        format!("{:x}", Sha256::digest(source)),
    ))
    .map_err(|e| e.to_string())?;
    let key = format!("{:x}", Sha256::digest(key_data));
    Ok(cache.join(format!("{key}.png")))
}

pub(crate) fn with_cached<T>(
    source: &[u8],
    edge: u32,
    source_version: &str,
    layer_ids: &[String],
    use_png: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    with_cached_in(
        source,
        &crate::project_data_dir().join("cache/schematic-png"),
        edge,
        source_version,
        layer_ids, use_png,
    )
}

#[tauri::command]
pub async fn stage_schematic_png(
    id: String,
    svg: String,
    source_version: String,
    layer_ids: Vec<String>,
    max_edge_px: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::staged_artwork::path(&id)?;
        let source_id = svg
            .strip_prefix(crate::staged_artwork::PREFIX)
            .ok_or("导出图片需要临时原图引用")?;
        let input = crate::staged_artwork::path(source_id)?;
        if input == output {
            return Err("图片缓存不能覆盖原图".into());
        }
        let file = fs::File::open(&input).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if size > 256 * 1024 * 1024 {
            return Err("导出原图超过安全大小".into());
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(size as usize + 1)
            .map_err(|_| "导出图片内存不足")?;
        file.take(size + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != size {
            return Err("导出原图读取期间发生变化".into());
        }
        if max_edge_px<=512 {
            let preview = cache_path(&crate::project_data_dir().join("cache/schematic-png"),&bytes,512,"",&[])?;
            if crate::preview_runtime::pin_preview(&preview,max_edge_px,&output)? { return Ok(()); }
        }
        with_cached(&bytes, max_edge_px, &source_version, &layer_ids, |png| {
            // A hard link pins bytes without allocating/copying a large PNG. A
            // different-volume temp directory uses a bounded disk copy instead.
            if fs::hard_link(png, &output).is_err() {
                fs::copy(png, &output).map_err(|e| format!("导出图片准备失败：{e}"))?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Only our validated, export-lifetime PNG references are readable by PDF usvg.
pub(crate) fn resolve(href: &str, options: &usvg::Options) -> Option<usvg::ImageKind> {
    let id = href.strip_prefix(PREFIX)?;
    let path = crate::staged_artwork::path(id).ok()?;
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_PNG_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_PNG_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    usvg::ImageHrefResolver::default_data_resolver()("image/png", Arc::new(bytes), options)
}

pub(crate) fn validate_page(svg: &str) -> Result<(), String> {
    if !svg.contains(PREFIX) {
        return Ok(());
    }
    let document = roxmltree::Document::parse(svg).map_err(|e| e.to_string())?;
    for image in document
        .descendants()
        .filter(|node| node.has_tag_name("image"))
    {
        let Some(id) = image
            .attribute("href")
            .and_then(|href| href.strip_prefix(PREFIX))
        else {
            continue;
        };
        let path = crate::staged_artwork::path(id)?;
        if !valid(&path, 4096) {
            return Err("导出图片缓存缺失或损坏，请重新导出".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        format!(
            "{:x}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }
    const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect x="10" y="10" width="60" height="80" fill="red"/></svg>"#;
    #[test]
    fn cache_distinguishes_source_layers_resolution_and_keeps_alpha() {
        let root = tempfile::tempdir().unwrap();
        let a = cached_in(SVG, root.path(), 128, "v1", &["front".into()]).unwrap();
        assert_eq!(
            a,
            cached_in(SVG, root.path(), 128, "v1", &["front".into()]).unwrap()
        );
        for (version, layers, edge) in [
            ("v2", vec!["front".into()], 128),
            ("v1", vec!["back".into()], 128),
            ("v1", vec!["front".into()], 1200),
        ] {
            assert_ne!(
                a,
                cached_in(SVG, root.path(), edge, version, &layers).unwrap()
            );
        }
        let bytes = fs::read(&a).unwrap();
        let image = tiny_skia::Pixmap::decode_png(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (103, 128));
        assert_eq!(image.pixel(0, 0).unwrap().alpha(), 0);
        assert_eq!(image.pixel(50, 60).unwrap().red(), 255);
        fs::write(&a, b"broken").unwrap();
        assert_eq!(
            a,
            cached_in(SVG, root.path(), 128, "v1", &["front".into()]).unwrap()
        );
        assert!(valid(&a, 128));
        assert!(resolve("printflow-png:../secret", &usvg::Options::default()).is_none());
    }

    #[test]
    fn export_png_keeps_embedded_detail_above_the_thumbnail_limit() {
        use base64::Engine;
        let mut image = tiny_skia::Pixmap::new(1024, 1024).unwrap();
        for y in 0..1024 {
            for x in 0..1024 {
                let pixel = &mut image.data_mut()[((y * 1024 + x) * 4) as usize..][..4];
                pixel.copy_from_slice(if x % 2 == 0 {
                    &[255, 0, 0, 255]
                } else {
                    &[0, 0, 255, 255]
                });
            }
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(image.encode_png().unwrap());
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><image width="1024" height="1024" href="data:image/png;base64,{encoded}"/></svg>"#
        );
        let png = crate::asset_previews::render_at_resolution(svg.as_bytes(), Path::new(""), 1024)
            .unwrap();
        let output = tiny_skia::Pixmap::decode_png(&png).unwrap();
        assert_eq!((output.width(), output.height()), (1024, 1024));
        assert_eq!(output.pixel(500, 500).unwrap().red(), 255);
        assert_eq!(output.pixel(501, 500).unwrap().blue(), 255);
    }

    #[test]
    fn png_pdf_preserves_vectors_and_original_quality_pipeline() {
        use base64::Engine;
        let directory = PathBuf::from("../.test-output/cached-png-pdf");
        fs::create_dir_all(&directory).unwrap();
        let source_id = id();
        fs::write(crate::staged_artwork::path(&source_id).unwrap(), SVG).unwrap();
        let mut cleanup = vec![source_id.clone()];
        for (quality, dpi, label) in [
            (crate::SchematicPdfQuality::Standard, 300, "standard"),
            (crate::SchematicPdfQuality::High, 400, "high"),
            (crate::SchematicPdfQuality::Ultra, 500, "ultra"),
            (crate::SchematicPdfQuality::Original, 0, "original"),
        ] {
            let href = if dpi > 0 {
                let id = id();
                tauri::async_runtime::block_on(stage_schematic_png(
                    id.clone(),
                    format!("{}{source_id}", crate::staged_artwork::PREFIX),
                    "source-v1".into(),
                    vec!["front".into()],
                    (150.0_f64 / 500.0 * 210.0 / 25.4 * dpi as f64).ceil() as u32,
                ))
                .unwrap();
                cleanup.push(id.clone());
                format!("{PREFIX}{id}")
            } else {
                format!(
                    "data:image/svg+xml;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(SVG)
                )
            };
            let page = format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 500 707"><rect width="500" height="707" fill="white"/><rect x="20" y="120" width="460" height="550" fill="none" stroke="#888"/><text x="30" y="40" font-size="20">ORDER PROOF</text><text x="30" y="75" font-size="12">PNG artwork / vector text and rulers</text><image x="-60" y="-75" width="120" height="150" transform="translate(250 300) rotate(25) scale(-1 1)" href="{href}"/><line x1="120" y1="225" x2="120" y2="375" stroke="#2c99bf" stroke-width="0.4"/><line x1="120" y1="225" x2="175" y2="225" stroke="#2c99bf" stroke-width="0.4"/><line x1="120" y1="375" x2="175" y2="375" stroke="#2c99bf" stroke-width="0.4"/><text x="100" y="300" transform="rotate(-90 100 300)" font-size="10" fill="#2c99bf">100.00 mm</text></svg>"##
            );
            let page_id = id();
            if label == "standard" {
                for format in ["png", "jpg"] {
                    let output = directory.join(format!("standard-artwork.{format}"));
                    tauri::async_runtime::block_on(crate::export_artwork(output.to_string_lossy().into_owned(), page.clone(), format.into(), Some(true))).unwrap();
                    let image = image::open(output).unwrap().to_rgba8();
                    let pixel = image.get_pixel(1240,1489);
                    assert!(pixel[0]>240 && pixel[1]<20 && pixel[2]<20,"cached product artwork must remain visible in {format}");
                }
            }
            let page_path = crate::staged_artwork::path(&page_id).unwrap();
            fs::write(&page_path, &page).unwrap();
            cleanup.push(page_id);
            let mut options = crate::assets::export_options().unwrap();
            options.image_href_resolver.resolve_string = Box::new(resolve);
            let flattened = crate::flatten_svg_resources(page, true).unwrap();
            let tree = usvg::Tree::from_str(&flattened, &options).unwrap();
            assert!(!tree.root().children().is_empty());
            tauri::async_runtime::block_on(crate::export_pdf_sources(
                directory
                    .join(format!("{label}.pdf"))
                    .to_string_lossy()
                    .into_owned(),
                vec![page_path.to_string_lossy().into_owned()],
                None,
                true,
                quality,
            ))
            .unwrap();
        }
        for id in cleanup {
            let _ = fs::remove_file(crate::staged_artwork::path(&id).unwrap());
        }
        assert!(validate_page("<image href=\"printflow-png:deadbeef\"/>").is_err());
    }
}
