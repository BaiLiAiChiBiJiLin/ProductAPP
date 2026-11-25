//! Resolve one editable artwork on the backend. Layout carries only references.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

pub const SNAPSHOT_PREFIX: &str = "printflow-snapshot:";
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub resource_id: String,
}
pub fn snapshot(value: &str) -> Result<Snapshot, String> {
    serde_json::from_str(
        value
            .strip_prefix(SNAPSHOT_PREFIX)
            .ok_or("不是审核图片引用")?,
    )
    .map_err(|_| "审核图片引用无效".into())
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerPlan {
    pub version: String,
    pub remove: Vec<usize>,
    pub reveal: Vec<usize>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    #[serde(default)]
    pub back: bool,
    #[serde(default)]
    pub fit_first_image: bool,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layers: Option<LayerPlan>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(default)]
    pub svg: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub variant: Option<Variant>,
}

static PREVIEWS: Mutex<VecDeque<(String, u32, PathBuf)>> = Mutex::new(VecDeque::new());
fn preview_key(app: &tauri::AppHandle, source: &Source) -> Result<String, String> {
    preview_cache_key(&crate::cloud::artwork_cache_scope(app)?, source)
}
fn preview_cache_key(scope: &str, source: &Source) -> Result<String, String> {
    let stamp = source
        .path
        .as_ref()
        .filter(|path| Path::new(path).is_absolute())
        .map(|path| {
            fs::metadata(path).ok().map(|info| {
                (
                    info.len(),
                    info.modified()
                        .ok()
                        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                        .map(|value| value.as_nanos()),
                )
            })
        });
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(scope, source, stamp)).map_err(|e| e.to_string())?)
    ))
}
fn remember_preview(key: String, edge: u32, path: &Path) {
    if let Ok(mut entries) = PREVIEWS.lock() {
        if let Some(index) = entries.iter().position(|entry| entry.0 == key) {
            if entries[index].1 > edge {
                return;
            }
            entries.remove(index);
        }
        entries.push_back((key, edge, path.to_path_buf()));
        while entries.len() > 128 {
            entries.pop_front();
        }
    }
}
fn stage_remembered_preview(key: &str, edge: u32, output: &Path) -> Result<bool, String> {
    let path = PREVIEWS
        .lock()
        .map_err(|_| "图片缓存暂不可用")?
        .iter()
        .find(|entry| entry.0 == key && entry.1 >= edge)
        .map(|entry| entry.2.clone());
    // Release the index before acquiring CACHE_LOCK; preview publication takes
    // these locks in the opposite direction while returning its PNG.
    if let Some(path) = path {
        return crate::preview_runtime::pin_preview(&path, edge, output);
    }
    Ok(false)
}

/// Validate the source's ownership/membership without reading its SVG bytes.
fn source_file(
    app: &tauri::AppHandle,
    source: &Source,
) -> Result<Option<(PathBuf, Option<String>)>, String> {
    if source.svg.starts_with(crate::staged_artwork::PREFIX) {
        return Ok(Some((
            crate::staged_artwork::path(
                source
                    .svg
                    .strip_prefix(crate::staged_artwork::PREFIX)
                    .unwrap(),
            )?,
            None,
        )));
    }
    if source.svg.starts_with(SNAPSHOT_PREFIX) {
        let reference = snapshot(&source.svg)?;
        if crate::cloud::config::load()?.is_some() {
            let (path, hash) = crate::cloud::snapshot_artwork_path(app, &reference)?;
            return Ok(Some((path, Some(hash))));
        }
        let conn = crate::database(app)?;
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM schematic_review_resources WHERE record_id=?1 AND (resource_id=?2 OR resource_id=(SELECT resource_id FROM schematic_review_resource_aliases WHERE record_id=?1 AND alias=?2)))",
            rusqlite::params![reference.id,reference.resource_id],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !exists {
            return Err("示意图原始图片不存在".into());
        }
        return Ok(None);
    }
    if !source.svg.is_empty() {
        return Ok(None);
    }
    if let Some(path) = &source.path {
        if let (Ok(root), Ok(actual)) = (
            fs::canonicalize(crate::project_data_dir().join("temp-assets")),
            fs::canonicalize(path),
        ) {
            if actual.starts_with(root) && actual.is_file() {
                return Ok(Some((actual, None)));
            }
        }
    }
    if let Some(batch) = &source.batch_id {
        if crate::cloud::config::load()?.is_some() {
            let (path, hash) = crate::cloud::source_artwork_path(app, batch, &source.asset_id)?;
            return Ok(Some((path, Some(hash))));
        }
        return Ok(crate::batch_history::asset_file(
            &crate::database(app)?,
            batch,
            &source.asset_id,
        )?
        .map(|path| (PathBuf::from(path), None)));
    }
    let root = fs::canonicalize(crate::project_data_dir().join("temp-assets"))
        .map_err(|_| "临时图片目录不可访问")?;
    let path = fs::canonicalize(source.path.as_ref().ok_or("图片缺少原图引用")?)
        .map_err(|_| "原始图片文件不可访问")?;
    if !path.starts_with(root) {
        return Err("原始图片路径无效".into());
    }
    Ok(Some((path, None)))
}

struct LayerSource {
    key: String,
    version: String,
    svg: Arc<String>,
    used: Instant,
}
// Only the currently inspected document can retain original bytes. This is
// native memory, bounded to 128 MiB rather than several WebView string copies.
static LAYER_SOURCE: Mutex<Option<LayerSource>> = Mutex::new(None);
const LAYER_SOURCE_BYTES: usize = 128 * 1024 * 1024;
fn layer_source_with(
    key: String,
    read: impl FnOnce() -> Result<String, String>,
) -> Result<(Arc<String>, String), String> {
    let mut cached = LAYER_SOURCE.lock().map_err(|_| "图层读取暂不可用")?;
    if let Some(entry) = cached
        .as_mut()
        .filter(|entry| entry.key == key && entry.used.elapsed() < Duration::from_secs(60))
    {
        entry.used = Instant::now();
        return Ok((entry.svg.clone(), entry.version.clone()));
    }
    // Release the previous source before reading the next large document.
    *cached = None;
    let svg = Arc::new(read()?);
    let version = format!("{:x}", Sha256::digest(svg.as_bytes()));
    if svg.len() <= LAYER_SOURCE_BYTES {
        *cached = Some(LayerSource {
            key,
            version: version.clone(),
            svg: svg.clone(),
            used: Instant::now(),
        });
    }
    Ok((svg, version))
}
fn layer_source(app: &tauri::AppHandle, source: &Source) -> Result<(Arc<String>, String), String> {
    let mut original_source = source.clone();
    original_source.variant = None;
    // Old reviews can retain a source path that no longer exists. Their owned
    // snapshot (and an import whose temp file was cleaned after saving) remains
    // authoritative, so a missing optional path must not prevent resolution.
    let stamp = source
        .path
        .as_ref()
        .filter(|path| std::path::Path::new(path).is_absolute())
        .map(|path| {
            fs::metadata(path).ok().map(|info| {
                (
                    info.len(),
                    info.modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|time| time.as_nanos()),
                )
            })
        });
    let scope = crate::cloud::artwork_cache_scope(app)?;
    let key = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(scope, original_source, stamp)).map_err(|e| e.to_string())?
        )
    );
    layer_source_with(key, || original(app, source))
}

#[derive(Serialize)]
pub struct LayerDocument {
    svg: String,
    version: String,
}
#[tauri::command]
pub async fn load_artwork_layer_document(
    app: tauri::AppHandle,
    source: Source,
) -> Result<LayerDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (svg, version) = layer_source(&app, &source)?;
        Ok(LayerDocument {
            svg: filtered_geometry(&svg, true)?,
            version,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn original(app: &tauri::AppHandle, source: &Source) -> Result<String, String> {
    if source.svg.starts_with(crate::staged_artwork::PREFIX) {
        return crate::staged_artwork::read(&source.svg);
    }
    if source.svg.starts_with(SNAPSHOT_PREFIX) {
        let reference = snapshot(&source.svg)?;
        let bytes = if crate::cloud::config::load()?.is_some() {
            crate::cloud::snapshot_artwork(app, &reference)?
        } else {
            crate::schematic_review::load_resource(
                &crate::database(app)?,
                &reference.id,
                &reference.resource_id,
            )?
        };
        return String::from_utf8(bytes).map_err(|_| "审核图片编码无效".into());
    }
    if !source.svg.is_empty() {
        return Ok(source.svg.clone());
    }
    // A shared save may still be in flight. Prefer the retained local import,
    // then fall back to the authoritative batch after temporary-file cleanup.
    if let Some(path) = &source.path {
        if let (Ok(root), Ok(actual)) = (
            fs::canonicalize(crate::project_data_dir().join("temp-assets")),
            fs::canonicalize(path),
        ) {
            if actual.starts_with(root) && actual.is_file() {
                return fs::read_to_string(actual).map_err(|_| "临时原图读取失败".into());
            }
        }
    }
    if let Some(batch) = &source.batch_id {
        if crate::cloud::config::load()?.is_some() {
            return crate::cloud::source_artwork(app, batch, &source.asset_id);
        }
        let asset =
            crate::batch_history::read_asset(&crate::database(app)?, batch, &source.asset_id)?;
        if !asset.svg.is_empty() {
            return Ok(asset.svg.clone());
        }
        return fs::read_to_string(&asset.storage_path).map_err(|_| "原始图片文件不可访问".into());
    }
    let root = fs::canonicalize(crate::project_data_dir().join("temp-assets"))
        .map_err(|_| "临时图片目录不可访问")?;
    let path = fs::canonicalize(source.path.as_ref().ok_or("图片缺少原图引用")?)
        .map_err(|_| "原始图片文件不可访问")?;
    if !path.starts_with(root) {
        return Err("原始图片路径无效".into());
    }
    fs::read_to_string(path).map_err(|_| "原始图片读取失败".into())
}

/// Same image-order/window-overlay semantics as svgBackLayerService.ts.
pub fn back_svg(svg: &str, variant: &Variant) -> Result<String, String> {
    if !variant.back {
        return Ok(svg.to_owned());
    }
    let document = roxmltree::Document::parse_with_options(
        svg,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|_| "背面图层解析失败")?;
    let images: Vec<_> = document
        .descendants()
        .filter(|node| node.has_tag_name("image"))
        .collect();
    let role = |index: usize| {
        variant
            .roles
            .get(index)
            .filter(|role| !role.is_empty())
            .map(String::as_str)
            .unwrap_or_else(|| match (variant.roles.len(), index) {
                (3, 0) | (2, 0) => "back",
                (3, 1) => "window",
                (3, 2) | (2, 1) => "front",
                _ => "",
            })
    };
    let overlay =
        images.len() == variant.roles.len() && (0..images.len()).any(|i| role(i) == "window");
    let keep = |i: usize| {
        if overlay {
            role(i) == "back" || role(i) == "window"
        } else {
            i == 0
        }
    };
    let mut replacements: Vec<(std::ops::Range<usize>, String)> = images
        .iter()
        .enumerate()
        .filter(|(i, _)| !keep(*i))
        .map(|(_, node)| (node.range(), String::new()))
        .collect();
    if variant.fit_first_image {
        if let Some((_, first)) = images.iter().enumerate().find(|(i, _)| keep(*i)) {
            let values: Option<Vec<f64>> = ["x", "y", "width", "height"]
                .iter()
                .map(|key| {
                    first
                        .attribute(*key)?
                        .parse::<f64>()
                        .ok()
                        .filter(|n| n.is_finite() && *n > 0.0)
                })
                .collect();
            if let (Some(values), Some(attribute)) = (
                values,
                document
                    .root_element()
                    .attributes()
                    .find(|attr| attr.name() == "viewBox"),
            ) {
                replacements.push((
                    attribute.range_value(),
                    values
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(" "),
                ));
            }
        }
    }
    replacements.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut output = svg.to_owned();
    for (range, value) in replacements {
        output.replace_range(range, &value);
    }
    Ok(output)
}
fn selected(app: &tauri::AppHandle, source: &Source) -> Result<(String, String), String> {
    if let Some(plan) = source
        .variant
        .as_ref()
        .and_then(|variant| variant.layers.as_ref())
    {
        let (original, version) = layer_source(app, source)?;
        if version != plan.version {
            return Err("源图片已更新，请重新打开图层菜单".into());
        }
        return Ok((select_layer_nodes(&original, plan)?, version));
    }
    let original = original(app, source)?;
    let version = format!("{:x}", Sha256::digest(original.as_bytes()));
    let svg = match &source.variant {
        Some(variant) => back_svg(&original, variant)?,
        None => original,
    };
    Ok((svg, version))
}

fn select_layer_nodes(svg: &str, plan: &LayerPlan) -> Result<String, String> {
    let document = roxmltree::Document::parse_with_options(
        svg,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|_| "图层解析失败")?;
    let nodes: Vec<_> = document
        .descendants()
        .filter(|node| node.is_element())
        .collect();
    if plan
        .remove
        .iter()
        .chain(&plan.reveal)
        .any(|index| *index >= nodes.len())
    {
        return Err("图层选择已失效".into());
    }
    let mut removals: Vec<_> = plan
        .remove
        .iter()
        .map(|index| nodes[*index].range())
        .collect();
    removals.sort_by_key(|range| range.start);
    if removals
        .windows(2)
        .any(|ranges| ranges[0].end > ranges[1].start)
    {
        return Err("图层选择范围重叠".into());
    }
    let mut patches: Vec<_> = removals
        .iter()
        .cloned()
        .map(|range| (range, String::new()))
        .collect();
    let mut seen = std::collections::HashSet::new();
    for index in &plan.reveal {
        if !seen.insert(*index) {
            continue;
        }
        let node = nodes[*index];
        if removals
            .iter()
            .any(|range| range.start <= node.range().start && range.end >= node.range().end)
        {
            return Err("图层选择范围冲突".into());
        }
        let visibility = "display:inline!important;visibility:visible!important";
        if let Some(style) = node
            .attributes()
            .find(|attribute| attribute.name() == "style")
        {
            let range = style.range_value();
            patches.push((range.clone(), format!("{};{visibility}", &svg[range])));
        } else {
            let mut quote = 0;
            let mut end = node.range().start;
            for (offset, byte) in svg.as_bytes()[node.range()].iter().enumerate() {
                if quote != 0 {
                    if *byte == quote {
                        quote = 0;
                    }
                } else if *byte == b'\'' || *byte == b'"' {
                    quote = *byte;
                } else if *byte == b'>' {
                    end = node.range().start + offset;
                    break;
                }
            }
            let mut at = end;
            while at > node.range().start && svg.as_bytes()[at - 1].is_ascii_whitespace() {
                at -= 1;
            }
            if svg.as_bytes()[at - 1] == b'/' {
                at -= 1;
            } else {
                at = end;
            }
            patches.push((at..at, format!(" style=\"{visibility}\"")));
        }
    }
    patches.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut result = svg.to_owned();
    for (range, text) in patches {
        result.replace_range(range, &text);
    }
    Ok(result)
}
fn geometry(svg: &str) -> Result<String, String> {
    filtered_geometry(svg, false)
}
fn filtered_geometry(svg: &str, layer_list: bool) -> Result<String, String> {
    let document = roxmltree::Document::parse_with_options(
        svg,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|_| "图片几何信息解析失败")?;
    let mut edits: Vec<_> = document
        .descendants()
        .flat_map(|node| node.attributes())
        .filter(|attribute| {
            (attribute.name() == "href" && attribute.value().starts_with("data:"))
                || (layer_list && matches!(attribute.name(), "d" | "points"))
        })
        .map(|attribute| {
            (
                attribute.range_value(),
                attribute
                    .value()
                    .split_once(',')
                    .map(|(header, _)| format!("{header},"))
                    .unwrap_or_default(),
            )
        })
        .collect();
    if layer_list {
        edits.extend(
            document
                .descendants()
                .filter(|node| node.is_text() || node.is_comment())
                .map(|node| (node.range(), String::new())),
        );
    }
    edits.sort_by_key(|(range, _)| range.start);
    let mut output = String::with_capacity(svg.len().min(256 * 1024));
    let mut offset = 0;
    for (range, value) in edits {
        if range.start < offset {
            continue;
        }
        output.push_str(&svg[offset..range.start]);
        output.push_str(&value);
        offset = range.end;
        if output.len() > 8 * 1024 * 1024 {
            return Err("图片几何信息超过大小限制".into());
        }
    }
    output.push_str(&svg[offset..]);
    if output.len() > 8 * 1024 * 1024 {
        return Err("图片几何信息超过大小限制".into());
    }
    Ok(output)
}
#[tauri::command]
pub async fn load_artwork_geometry(
    app: tauri::AppHandle,
    source: Source,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || geometry(&original(&app, &source)?))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn load_artwork_preview(
    app: tauri::AppHandle,
    source: Source,
    max_edge_px: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Shared snapshot IDs address immutable SVG bytes. Reuse the same
        // bounded file-preview cache as the image list, without rereading a
        // large original solely to discover an already cached PNG.
        if source.variant.is_none()
            && source.svg.starts_with(SNAPSHOT_PREFIX)
            && crate::cloud::config::load()?.is_some()
        {
            let reference = snapshot(&source.svg)?;
            let (path, hash) = crate::cloud::snapshot_artwork_path(&app, &reference)?;
            return crate::asset_previews::from_path(&path, max_edge_px, Some(&hash));
        }
        let bytes = if source.svg.starts_with(crate::staged_artwork::PREFIX) {
            fs::metadata(crate::staged_artwork::path(
                source
                    .svg
                    .strip_prefix(crate::staged_artwork::PREFIX)
                    .unwrap(),
            )?)
            .ok()
            .map(|info| info.len() as usize)
        } else if !source.svg.is_empty() && !source.svg.starts_with(SNAPSHOT_PREFIX) {
            Some(source.svg.len())
        } else if let Some(plan) = source
            .variant
            .as_ref()
            .and_then(|variant| variant.layers.as_ref())
        {
            LAYER_SOURCE.lock().ok().and_then(|entry| {
                entry
                    .as_ref()
                    .filter(|entry| entry.version == plan.version)
                    .map(|entry| entry.svg.len())
            })
        } else {
            source
                .path
                .as_ref()
                .and_then(|path| fs::metadata(path).ok())
                .map(|info| info.len() as usize)
        };
        let _permit = if let Some(bytes) = bytes {
            crate::preview_runtime::acquire(bytes)?
        } else {
            crate::preview_runtime::acquire_unknown()?
        };
        let key = preview_key(&app, &source)?;
        let (svg, version) = selected(&app, &source)?;
        let variant = format!("{:?}", source.variant);
        crate::schematic_raster::with_cached(
            svg.as_bytes(),
            max_edge_px.clamp(128, 512),
            &version,
            &[variant],
            |path| {
                remember_preview(key, max_edge_px.clamp(128, 512), path);
                Ok(format!(
                    "data:image/png;base64,{}",
                    STANDARD.encode(fs::read(path).map_err(|_| "预览缓存读取失败")?)
                ))
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stage_asset_artwork(
    app: tauri::AppHandle,
    id: String,
    source: Source,
    max_edge_px: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::staged_artwork::path(&id)?;
        // Most schematic products need fewer than 512 pixels at standard 300 DPI.
        // Reuse the exact displayed selection without reopening/decoding SVG.
        let file = source_file(&app, &source)?;
        let preview_identity = if max_edge_px.is_some_and(|edge| edge <= 512) {
            Some(preview_key(&app, &source)?)
        } else {
            None
        };
        if let Some(edge) = max_edge_px.filter(|edge| *edge <= 512) {
            if source.variant.is_none() {
                if let Some((path, hash)) = &file {
                    if crate::asset_previews::try_stage_preview(
                        path,
                        hash.as_deref(),
                        edge,
                        &output,
                    )? {
                        return Ok(());
                    }
                }
            }
            if stage_remembered_preview(preview_identity.as_ref().unwrap(), edge, &output)? {
                return Ok(());
            }
        }
        let bytes = file
            .as_ref()
            .and_then(|(path, _)| fs::metadata(path).ok())
            .map(|info| info.len() as usize);
        let _permit = if let Some(bytes) = bytes {
            crate::preview_runtime::acquire(bytes)?
        } else {
            crate::preview_runtime::acquire_unknown()?
        };
        let (svg, version) = selected(&app, &source)?;
        if let Some(edge) = max_edge_px {
            crate::schematic_raster::with_cached(
                svg.as_bytes(),
                edge,
                &version,
                &[format!("{:?}", source.variant)],
                |png| {
                    if let Some(key) = preview_identity {
                        remember_preview(key, edge, png);
                    }
                    if fs::hard_link(png, &output).is_err() {
                        fs::copy(png, &output).map_err(|_| "导出图片准备失败")?;
                    }
                    Ok(())
                },
            )
        } else {
            fs::write(output, svg).map_err(|_| "导出原图准备失败".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_layer_export_keeps_source_version_selection_and_resolution() {
        let directory = tempfile::tempdir().unwrap();
        let image_path = directory.path().join("layer.png");
        let mut image = tiny_skia::Pixmap::new(512, 512).unwrap();
        image.fill(tiny_skia::Color::from_rgba8(0, 0, 255, 255));
        fs::write(&image_path, image.encode_png().unwrap()).unwrap();
        let source = Source {
            asset_id: directory.path().to_string_lossy().into_owned(),
            svg: "printflow-snapshot:version-one".into(),
            variant: Some(Variant {
                back: true,
                roles: vec!["back".into(), "window".into(), "front".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let key = preview_cache_key("user-one", &source).unwrap();
        remember_preview(key.clone(), 512, &image_path);
        let output = directory.path().join("export.png");
        assert!(stage_remembered_preview(&key, 420, &output).unwrap());
        assert_eq!(fs::read(&output).unwrap(), fs::read(&image_path).unwrap());
        let mut other = source.clone();
        other.variant = None;
        assert!(!stage_remembered_preview(
            &preview_cache_key("user-one", &other).unwrap(),
            420,
            &directory.path().join("wrong-layer.png")
        )
        .unwrap());
        other = source.clone();
        other.svg = "printflow-snapshot:version-two".into();
        assert!(!stage_remembered_preview(
            &preview_cache_key("user-one", &other).unwrap(),
            420,
            &directory.path().join("wrong-version.png")
        )
        .unwrap());
        assert!(!stage_remembered_preview(
            &preview_cache_key("user-two", &source).unwrap(),
            420,
            &directory.path().join("other-user.png")
        )
        .unwrap());
        assert!(!stage_remembered_preview(&key, 700, &directory.path().join("high.png")).unwrap());
        fs::remove_file(&image_path).unwrap();
        assert!(tiny_skia::Pixmap::decode_png(&fs::read(&output).unwrap()).is_ok());
        assert!(
            !stage_remembered_preview(&key, 420, &directory.path().join("evicted.png")).unwrap()
        );
    }
    #[test]
    fn layer_previews_reuse_one_original_and_source_changes_invalidate_it() {
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let key = format!("layer-cache-test-{:?}", Instant::now());
        let content = format!(
            "<svg><image href=\"data:image/png;base64,{}\"/></svg>",
            "a".repeat(2 * 1024 * 1024)
        );
        let read = || {
            reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(content.clone())
        };
        let (source, version) = layer_source_with(key.clone(), read).unwrap();
        let small = geometry(&source).unwrap();
        assert!(small.len() < 100);
        for _ in 0..4 {
            let (again, again_version) = layer_source_with(key.clone(), read).unwrap();
            assert!(Arc::ptr_eq(&source, &again));
            assert_eq!(version, again_version);
        }
        assert_eq!(reads.load(std::sync::atomic::Ordering::Relaxed), 1);
        let (_, next) = layer_source_with(format!("{key}-new"), || Ok("<svg/>".into())).unwrap();
        assert_ne!(version, next);
    }
    #[test]
    fn selected_layers_preserve_resources_transforms_cutlines_and_authored_text() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="cut"><rect width="10" height="10"/></clipPath></defs><g id="front" transform="translate(2 3)"><image href="data:image/png;base64,ORIGINAL"/></g><g id="back" style="display:none"><text>中文</text><image href="data:image/png;base64,ORIGINAL2"/></g><g id="CutLine"><path d="M0 0L1 1"/></g></svg>"#;
        let plan = LayerPlan {
            version: String::new(),
            remove: vec![4],
            reveal: vec![6, 0],
        };
        let output = select_layer_nodes(svg, &plan).unwrap();
        assert!(!output.contains("id=\"front\""));
        assert!(
            output.contains("ORIGINAL2")
                && output.contains("中文")
                && output.contains("clipPath")
                && output.contains("CutLine")
        );
        assert!(
            output.contains("display:none;display:inline!important;visibility:visible!important")
        );
        assert_eq!(
            roxmltree::Document::parse(&output)
                .unwrap()
                .root_element()
                .tag_name()
                .name(),
            "svg"
        );
        assert!(select_layer_nodes(
            svg,
            &LayerPlan {
                remove: vec![100],
                ..Default::default()
            }
        )
        .is_err());
        assert!(select_layer_nodes(
            svg,
            &LayerPlan {
                remove: vec![0],
                reveal: vec![6],
                ..Default::default()
            }
        )
        .is_err());
    }
    #[test]
    fn layer_png_displays_the_selected_face_and_color_window() {
        let png = |color| {
            let mut image = tiny_skia::Pixmap::new(8, 8).unwrap();
            image.fill(color);
            STANDARD.encode(image.encode_png().unwrap())
        };
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image id="back" style="display:none" width="8" height="8" href="data:image/png;base64,{}"/><image id="window" width="8" height="8" href="data:image/png;base64,{}"/><image id="front" width="8" height="8" href="data:image/png;base64,{}"/></svg>"#,
            png(tiny_skia::Color::from_rgba8(0, 0, 255, 255)),
            png(tiny_skia::Color::from_rgba8(0, 255, 0, 128)),
            png(tiny_skia::Color::from_rgba8(255, 0, 0, 255))
        );
        let selected = select_layer_nodes(
            &svg,
            &LayerPlan {
                remove: vec![3],
                reveal: vec![1, 2, 0],
                ..Default::default()
            },
        )
        .unwrap();
        let result = crate::asset_previews::render_at_resolution(
            selected.as_bytes(),
            std::path::Path::new(""),
            128,
        )
        .unwrap();
        let image = tiny_skia::Pixmap::decode_png(&result).unwrap();
        let pixel = image.pixel(image.width() / 2, image.height() / 2).unwrap();
        assert!(
            pixel.red() < 10 && pixel.blue() > 100 && pixel.green() > 100 && pixel.alpha() == 255
        );
        assert!(svg.contains("id=\"front\""));
    }
    #[test]
    fn ruler_geometry_has_no_embedded_raster_bytes() {
        let svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><image x=\"10\" y=\"20\" width=\"30\" height=\"40\" href=\"data:image/png;base64,{}\"/></svg>","x".repeat(300_000));
        let result = geometry(&svg).unwrap();
        assert!(
            result.len() < 300
                && result.contains("y=\"20\"")
                && result.contains("data:image/png;base64,")
        );
    }
    #[test]
    fn layer_document_omits_bitmap_and_vector_payloads_without_changing_element_ordinals() {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg"><!--comment--><defs><style><![CDATA[path {{fill: red}}]]></style></defs><g id="face"><path d="{}"/><image x="10" y="20" width="30" height="40" href="data:image/png;base64,{}"/></g></svg>"#,
            "M1 2L3 4".repeat(100_000),
            "a".repeat(2_000_000)
        );
        let result = filtered_geometry(&svg, true).unwrap();
        assert!(result.len() < 400);
        let before = roxmltree::Document::parse(&svg).unwrap();
        let after = roxmltree::Document::parse(&result).unwrap();
        let tags = |doc: &roxmltree::Document| {
            doc.descendants()
                .filter(|node| node.is_element())
                .map(|node| node.tag_name().name().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(tags(&before), tags(&after));
        assert!(result.contains("id=\"face\"") && result.contains("y=\"20\""));
    }
    #[test]
    #[ignore = "Read-only local benchmark; set PRINTFLOW_LAYER_FIXTURE to an SVG"]
    fn measure_real_layer_document() {
        let path = std::env::var("PRINTFLOW_LAYER_FIXTURE").expect("fixture path");
        let start = Instant::now();
        let svg = fs::read_to_string(path).unwrap();
        let read_ms = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        let result = filtered_geometry(&svg, true).unwrap();
        let parse_ms = start.elapsed().as_secs_f64() * 1000.;
        println!(
            "source_bytes={} document_bytes={} read_ms={read_ms:.2} document_ms={parse_ms:.2}",
            svg.len(),
            result.len()
        );
    }
    #[test]
    fn lazy_back_preserves_root_defs_transform_and_window_overlay() {
        let svg = r#"<svg viewBox="0 0 100 100"><defs><clipPath id="cut"><rect width="100" height="100"/></clipPath></defs><g transform="translate(2 3)"><image id="back" x="5" y="6" width="30" height="40"/><image id="window"/><image id="front"/></g></svg>"#;
        let output = back_svg(
            svg,
            &Variant {
                back: true,
                fit_first_image: true,
                roles: vec!["back".into(), "window".into(), "front".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            output.contains("id=\"back\"")
                && output.contains("id=\"window\"")
                && !output.contains("id=\"front\"")
        );
        assert!(
            output.contains("viewBox=\"5 6 30 40\"")
                && output.contains("clipPath")
                && output.contains("translate(2 3)")
        );
    }
}
