use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};
use crate::geometry::ancestor_transform;
#[path = "svg_modes/mod.rs"]
mod svg_modes;

const MAX_SVG_BYTES: usize = 500 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub source_file_name: String,
    pub product_id: String,
    #[serde(default)]
    pub product_name: String,
    pub width: f32,
    pub height: f32,
    /// Physical dimensions of the original source group, in millimetres.
    /// These are measured from the usvg viewport and remain independent from
    /// the visual crop used by the page.
    #[serde(default)]
    pub source_group_width_mm: f64,
    #[serde(default)]
    pub source_group_height_mm: f64,
    /// Original source-space bounds as [x, y, width, height].
    #[serde(default)]
    pub source_group_bounds: [f64; 4],
    pub svg: String,
    /// Kept for backwards-compatible workspace records. The canonical asset
    /// is `svg`; duplicating the full SVG in preview and thumbnail fields can
    /// multiply memory use for large split imports.
    #[serde(default)]
    pub preview_url: String,
    #[serde(default)]
    pub thumbnail_url: String,
    #[serde(default)]
    pub storage_path: String,
    #[serde(default)]
    pub mode_used: String,
    #[serde(default)]
    pub merge_status: String,
    #[serde(default)]
    pub source_group_id: String,
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
    #[serde(default)]
    pub attribute_images: BTreeMap<String, String>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub note_image: String,
    #[serde(default)]
    pub attributes_confirmed: bool,
    #[serde(default)]
    pub product_group_id: String,
    #[serde(default)]
    pub product_group_color: String,
    #[serde(default)]
    pub product_group_leader_id: String,
    #[serde(default)]
    pub product_group_mode: String,
    /// 1-based order inside a product group. Zero is reserved for legacy
    /// records that predate draggable group ordering.
    #[serde(default)]
    pub product_group_position: i32,
}

#[cfg(test)]
mod note_persistence_tests {
    use super::Asset;

    #[test]
    fn old_assets_default_notes_and_new_notes_survive_json_storage() {
        let mut asset: Asset = serde_json::from_value(serde_json::json!({
            "id": "note-test", "name": "test", "productId": "custom:1",
            "width": 10, "height": 10, "svg": "<svg/>"
        })).unwrap();
        assert!(asset.note.is_empty() && asset.note_image.is_empty());
        assert!(!asset.attributes_confirmed);
        assert!(asset.product_group_id.is_empty() && asset.product_group_color.is_empty());
        assert!(asset.product_group_leader_id.is_empty());
        assert!(asset.product_group_mode.is_empty());
        assert_eq!(asset.product_group_position, 0);
        assert_eq!(asset.source_group_width_mm, 0.0);
        assert_eq!(asset.source_group_height_mm, 0.0);
        assert_eq!(asset.source_group_bounds, [0.0; 4]);
        asset.product_group_id = "group-test".into();
        asset.product_group_color = "#d9f7be".into();
        asset.product_group_leader_id = "leader-test".into();
        asset.product_group_mode = "free".into();
        asset.product_group_position = 2;
        asset.source_group_width_mm = 70.1998;
        asset.source_group_height_mm = 70.2;
        asset.source_group_bounds = [100.0, 200.0, 2454617.0, 2454617.0];
        asset.attributes_confirmed = true;
        asset.note = "保留文字备注".into();
        asset.note_image = "data:image/png;base64,AA==".into();
        let json = serde_json::to_string(&asset).unwrap();
        let restored: Asset = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.note, asset.note);
        assert_eq!(restored.note_image, asset.note_image);
        assert!(restored.attributes_confirmed);
        assert_eq!(restored.product_group_id, asset.product_group_id);
        assert_eq!(restored.product_group_color, asset.product_group_color);
        assert_eq!(restored.product_group_leader_id, asset.product_group_leader_id);
        assert_eq!(restored.product_group_mode, asset.product_group_mode);
        assert_eq!(restored.product_group_position, asset.product_group_position);
        assert_eq!(restored.source_group_width_mm, asset.source_group_width_mm);
        assert_eq!(restored.source_group_height_mm, asset.source_group_height_mm);
        assert_eq!(restored.source_group_bounds, asset.source_group_bounds);
    }
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct SceneNode<'a> {
    pub kind: String,
    pub xml: &'a str,
    pub order: usize,
    pub bounds: [f64; 4],
    pub clip_path: Option<String>,
    pub mask: Option<String>,
}

#[allow(dead_code)]
pub fn collect_scene_nodes<'a>(data: &'a str) -> Result<Vec<SceneNode<'a>>, String> {
    let doc = roxmltree::Document::parse_with_options(data, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| format!("SVG 解析失败：{e}"))?;
    let root = doc.root_element();
    let mut order = 0;
    let mut result = Vec::new();
    for node in root.descendants().filter(|n| n.is_element()) {
        let kind = node.tag_name().name();
        if !matches!(kind, "image" | "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line" | "text" | "use") { continue; }
        let x = node.attribute("x").and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let y = node.attribute("y").and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let w = node.attribute("width").and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let h = node.attribute("height").and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let bounds = ancestor_transform(node).bounds(x, y, w, h);
        result.push(SceneNode { kind: kind.to_owned(), xml: &data[node.range()], order, bounds, clip_path: node.attribute("clip-path").map(str::to_owned), mask: node.attribute("mask").map(str::to_owned) });
        order += 1;
    }
    Ok(result)
}

pub fn options() -> usvg::Options<'static> {
    let mut options = usvg::Options::default();
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    // Font lookup is deferred until usvg lays out actual text. This also
    // covers scene bounds, pixel checks and embedded SVG images, without
    // scanning fonts for the much more common path/raster-only artwork.
    options.font_resolver = crate::fonts::artwork::resolver();
    options
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SourceRootGeometry {
    width_mm: f64,
    height_mm: f64,
    view_box: [f64; 4],
    scale_x: f64,
    scale_y: f64,
    offset_x: f64,
    offset_y: f64,
}

fn parse_svg_length(value: Option<&str>, fallback: f64) -> (f64, f64) {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else { return (fallback, fallback * 25.4 / 96.0) };
    let end = raw.find(|character: char| !(character.is_ascii_digit() || matches!(character, '.' | '+' | '-' | 'e' | 'E'))).unwrap_or(raw.len());
    let number = raw[..end].parse::<f64>().ok().filter(|value| value.is_finite() && *value > 0.0).unwrap_or(fallback);
    let unit = raw[end..].trim().to_ascii_lowercase();
    let px = match unit.as_str() {
        "mm" => number * 96.0 / 25.4,
        "cm" => number * 96.0 / 2.54,
        "in" => number * 96.0,
        "pt" => number * 96.0 / 72.0,
        "pc" => number * 16.0,
        "" | "px" => number,
        _ => fallback,
    };
    let mm = match unit.as_str() {
        "mm" => number,
        "cm" => number * 10.0,
        "in" => number * 25.4,
        "pt" => number * 25.4 / 72.0,
        "pc" => number * 25.4 / 6.0,
        "" | "px" => number * 25.4 / 96.0,
        _ => fallback * 25.4 / 96.0,
    };
    (px, mm)
}

fn parse_view_box(value: Option<&str>, fallback_width: f64, fallback_height: f64) -> [f64; 4] {
    let values: Vec<f64> = value.unwrap_or_default().replace(',', " ").split_whitespace().filter_map(|value| value.parse().ok()).collect();
    if values.len() == 4 && values[2] > 0.0 && values[3] > 0.0 { [values[0], values[1], values[2], values[3]] }
    else { [0.0, 0.0, fallback_width, fallback_height] }
}

fn root_geometry(source: &str) -> Option<SourceRootGeometry> {
    let doc = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" { return None; }
    let preliminary_width = root.attribute("viewBox").and_then(|value| {
        let values: Vec<f64> = value.replace(',', " ").split_whitespace().filter_map(|part| part.parse().ok()).collect();
        (values.len() == 4 && values[2] > 0.0).then_some(values[2])
    }).unwrap_or(100.0);
    let preliminary_height = root.attribute("viewBox").and_then(|value| {
        let values: Vec<f64> = value.replace(',', " ").split_whitespace().filter_map(|part| part.parse().ok()).collect();
        (values.len() == 4 && values[3] > 0.0).then_some(values[3])
    }).unwrap_or(100.0);
    let (viewport_width_px, width_mm) = parse_svg_length(root.attribute("width"), preliminary_width);
    let (viewport_height_px, height_mm) = parse_svg_length(root.attribute("height"), preliminary_height);
    let view_box = parse_view_box(root.attribute("viewBox"), viewport_width_px, viewport_height_px);
    // SVG's default preserveAspectRatio is xMidYMid meet. Support the common
    // align/meet/slice forms so bounds remain in the original user space even
    // when the viewport and viewBox have different aspect ratios.
    let preserve = root.attribute("preserveAspectRatio").unwrap_or("xMidYMid meet").split_whitespace().collect::<Vec<_>>();
    let none = preserve.first().copied() == Some("none");
    let slice = preserve.get(1).copied() == Some("slice");
    let raw_x = viewport_width_px / view_box[2];
    let raw_y = viewport_height_px / view_box[3];
    let (scale_x, scale_y) = if none { (raw_x, raw_y) } else { let scale = if slice { raw_x.max(raw_y) } else { raw_x.min(raw_y) }; (scale, scale) };
    let extra_x = viewport_width_px - view_box[2] * scale_x;
    let extra_y = viewport_height_px - view_box[3] * scale_y;
    let align = preserve.first().copied().unwrap_or("xMidYMid");
    let offset_x = if align.starts_with("xMin") { 0.0 } else if align.starts_with("xMax") { extra_x } else { extra_x / 2.0 } - view_box[0] * scale_x;
    let offset_y = if align.ends_with("YMin") { 0.0 } else if align.ends_with("YMax") { extra_y } else { extra_y / 2.0 } - view_box[1] * scale_y;
    Some(SourceRootGeometry { width_mm, height_mm, view_box, scale_x, scale_y, offset_x, offset_y })
}

fn source_group_metrics(source: &str, tree: &usvg::Tree) -> (f64, f64, [f64; 4]) {
    let Some(root) = root_geometry(source) else { return (0.0, 0.0, [0.0; 4]); };
    let Some((width_mm, height_mm, viewport)) = source_measurement(root, tree) else { return (0.0, 0.0, [0.0; 4]); };
    let bounds = viewport_to_source_bounds(root, viewport);
    (width_mm, height_mm, bounds)
}

fn source_measurement(root: SourceRootGeometry, tree: &usvg::Tree) -> Option<(f64, f64, [f64; 4])> {
    // The vector outline path is authoritative for CorelDRAW-style artwork.
    // If a source contains no unfilled stroke outline (for example a plain
    // embedded raster), retain the renderer layer bounds as a safe fallback.
    if let Some(measurement) = crate::svg_measure::measure_tree(tree, root.width_mm, root.height_mm) {
        return Some((measurement.width_mm, measurement.height_mm, measurement.viewport_bounds));
    }
    let viewport = tree_bounds(tree)?;
    let viewport_width = tree.size().width() as f64;
    let viewport_height = tree.size().height() as f64;
    if viewport_width <= 0.0 || viewport_height <= 0.0 { return None; }
    let sx = root.width_mm / viewport_width;
    let sy = root.height_mm / viewport_height;
    let width_mm = (viewport[2] - viewport[0]) * sx;
    let height_mm = (viewport[3] - viewport[1]) * sy;
    if ![width_mm, height_mm].iter().all(|value| value.is_finite()) || width_mm <= 0.0 || height_mm <= 0.0 { return None; }
    Some((width_mm, height_mm, viewport))
}

/// Return the absolute layer bounds in the usvg viewport coordinate system for
/// image-only sources. Outline-based assets use `svg_measure` above; this
/// fallback keeps raster-only SVGs importable without inventing dimensions.
fn tree_bounds(tree: &usvg::Tree) -> Option<[f64; 4]> {
    // Fallback for image-only sources. Outline measurement above is preferred
    // whenever the group contains authored stroke geometry.
    let bounds = tree.root().abs_layer_bounding_box();
    let values = [bounds.x() as f64, bounds.y() as f64, bounds.width() as f64, bounds.height() as f64];
    if !values.iter().all(|value| value.is_finite()) || values[2] <= 0.0 || values[3] <= 0.0 { return None; }
    Some([values[0], values[1], values[0] + values[2], values[1] + values[3]])
}

/// Convert an absolute usvg viewport box back to the original SVG user space.
/// The inverse uses the root preserveAspectRatio mapping already used by the
/// importer, so non-zero viewBox origins and xMidYMid padding are preserved.
fn viewport_to_source_bounds(root: SourceRootGeometry, viewport: [f64; 4]) -> [f64; 4] {
    let to_source = |value: f64, scale: f64, offset: f64| {
        if scale.abs() > f64::EPSILON { (value - offset) / scale } else { value }
    };
    let x1 = to_source(viewport[0], root.scale_x, root.offset_x);
    let y1 = to_source(viewport[1], root.scale_y, root.offset_y);
    let x2 = to_source(viewport[2], root.scale_x, root.offset_x);
    let y2 = to_source(viewport[3], root.scale_y, root.offset_y);
    let left = x1.min(x2);
    let top = y1.min(y2);
    [left, top, (x1.max(x2) - left).max(0.0), (y1.max(y2) - top).max(0.0)]
}

fn source_group_viewport_bounds(source: &str, tree: &usvg::Tree) -> Option<[f64; 4]> {
    let root = root_geometry(source)?;
    source_measurement(root, tree).map(|(_, _, bounds)| bounds)
}

fn source_root_metrics(source: &str) -> (f64, f64, [f64; 4]) {
    let Some(root) = root_geometry(source) else { return (0.0, 0.0, [0.0; 4]); };
    (root.width_mm, root.height_mm, root.view_box)
}

fn root_opening_range(source: &str) -> Result<(usize, usize), String> {
    let doc = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() })
        .map_err(|error| format!("SVG 解析失败：{error}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" { return Err("文件不是 SVG".into()); }
    let start = root.range().start;
    let rest = &source[start..];
    let mut quote = None;
    for (offset, character) in rest.char_indices() {
        match (quote, character) {
            (None, '\'' | '"') => quote = Some(character),
            (Some(current), value) if current == value => quote = None,
            (None, '>') => return Ok((start, start + offset + 1)),
            _ => (),
        }
    }
    Err("SVG 根节点不完整".into())
}

/// Replace only the root viewBox value while retaining every other root
/// attribute byte-for-byte, especially the authored width and height. A
/// cropped split asset therefore gets a tight viewport without changing the
/// source document's physical dimensions.
fn replace_root_view_box(source: &str, bounds: [f64; 4]) -> Result<String, String> {
    let (start, end) = root_opening_range(source)?;
    let opening = &source[start..end];
    let value = format!("{:.9} {:.9} {:.9} {:.9}", bounds[0], bounds[1], bounds[2], bounds[3]);
    let bytes = opening.as_bytes();
    let content_end = opening.len().saturating_sub(1);
    let mut index = 1usize;
    while index < content_end {
        while index < content_end && bytes[index].is_ascii_whitespace() { index += 1; }
        if index >= content_end || bytes[index] == b'/' { break; }
        let name_start = index;
        while index < content_end && !bytes[index].is_ascii_whitespace() && bytes[index] != b'=' && bytes[index] != b'/' { index += 1; }
        let attribute_name = &opening[name_start..index];
        while index < content_end && bytes[index].is_ascii_whitespace() { index += 1; }
        if index >= content_end || bytes[index] != b'=' {
            while index < content_end && !bytes[index].is_ascii_whitespace() { index += 1; }
            continue;
        }
        index += 1;
        while index < content_end && bytes[index].is_ascii_whitespace() { index += 1; }
        if index >= content_end { break; }
        let (value_start, value_end) = if bytes[index] == b'\'' || bytes[index] == b'"' {
            let quote = bytes[index];
            let value_start = index + 1;
            index = value_start;
            while index < content_end && bytes[index] != quote { index += 1; }
            (value_start, index.min(content_end))
        } else {
            let value_start = index;
            while index < content_end && !bytes[index].is_ascii_whitespace() && bytes[index] != b'/' { index += 1; }
            (value_start, index)
        };
        if attribute_name == "viewBox" {
            let mut replaced = String::with_capacity(opening.len() + value.len());
            replaced.push_str(&opening[..value_start]);
            replaced.push_str(&value);
            replaced.push_str(&opening[value_end..]);
            let mut result = String::with_capacity(source.len() + value.len());
            result.push_str(&source[..start]);
            result.push_str(&replaced);
            result.push_str(&source[end..]);
            return Ok(result);
        }
        if value_end < content_end && (bytes[value_end] == b'\'' || bytes[value_end] == b'"') { index = value_end + 1; } else { index = value_end; }
    }
    let insert_at = if opening[..content_end].trim_end().ends_with('/') {
        opening[..content_end].trim_end().len() - 1
    } else { content_end };
    let mut replaced = String::with_capacity(opening.len() + value.len() + 12);
    replaced.push_str(&opening[..insert_at]);
    replaced.push_str(" viewBox=\"");
    replaced.push_str(&value);
    replaced.push_str("\"");
    replaced.push_str(&opening[insert_at..]);
    let mut result = String::with_capacity(source.len() + value.len() + 12);
    result.push_str(&source[..start]);
    result.push_str(&replaced);
    result.push_str(&source[end..]);
    Ok(result)
}

/// Page export has a separate font cache from original artwork import.
pub fn export_options() -> Result<usvg::Options<'static>, String> {
    let mut options = usvg::Options::default();
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    options.font_family = "Arial".into();
    options.fontdb = crate::fonts::page_fonts()?;
    Ok(options)
}

#[allow(dead_code)]
pub fn render(tree: &usvg::Tree, max_side: f32) -> Result<String, String> {
    let pixmap = render_pixmap(tree, max_side)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(pixmap.encode_png().map_err(|e| e.to_string())?)))
}

fn render_pixmap(tree: &usvg::Tree, max_side: f32) -> Result<tiny_skia::Pixmap, String> {
    let scale = (max_side / tree.size().width().max(tree.size().height())).min(1.0);
    let w = (tree.size().width() * scale).ceil().max(1.0) as u32;
    let h = (tree.size().height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("无法创建图片预览")?;
    resvg::render(tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    Ok(pixmap)
}

#[allow(dead_code)]
pub fn split_sources(data: &str, split: bool) -> Result<Vec<(String, String)>, String> {
    svg_modes::scene::split_sources_with_progress(data, split, |_, _, _| {})
}

#[allow(dead_code)]
pub fn auto_split(data: &str) -> Result<bool, String> {
    Ok(!matches!(svg_modes::classifier::classify(data)?, svg_modes::classifier::SvgKind::Whole))
}

#[allow(dead_code)]
pub fn import(path: &Path, product_id: &str, mode: &str, request_id: &str, progress: impl Fn(usize, usize)) -> Result<Vec<Asset>, String> {
    import_with_asset(path, product_id, mode, request_id, progress, |_| {})
}

/// Import while reporting each completed asset. The callback is invoked after
/// the asset has been validated and its viewBox crop prepared, so callers can
/// stream complete SVG resources without exposing partially parsed nodes.
pub fn import_with_asset(
    path: &Path,
    product_id: &str,
    mode: &str,
    request_id: &str,
    progress: impl Fn(usize, usize),
    on_asset: impl Fn(&Asset),
) -> Result<Vec<Asset>, String> {
    import_with_stage(path, product_id, mode, request_id, |_, completed, total| progress(completed, total), on_asset)
}

pub fn import_with_stage(
    path: &Path,
    product_id: &str,
    mode: &str,
    request_id: &str,
    progress: impl Fn(&str, usize, usize),
    on_asset: impl Fn(&Asset),
) -> Result<Vec<Asset>, String> {
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let max_bytes = if extension == "svg" { MAX_SVG_BYTES } else { 35 * 1024 * 1024 };
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > max_bytes as u64 {
        return Err(format!("单个文件不能超过 {} MB", max_bytes / (1024 * 1024)));
    }
    // `auto` is the default UI mode and lets the importer decide between a
    // complete artwork and top-level graphic groups.
    if !matches!(mode, "auto" | "whole" | "groups") { return Err("未知导入模式".into()); }
    let data = fs::read(path).map_err(|e| format!("文件读取失败：{e}"))?;
    let name = path.file_stem().unwrap_or_default().to_string_lossy();
    let svg_text = if extension == "svg" {
        let text = std::str::from_utf8(&data).map_err(|_| "请将 SVG 保存为 UTF-8 编码")?;
        Some(embed_relative_images(text, path)?)
    } else { None };
    let svg_kind = if let Some(text) = svg_text.as_deref() {
        if mode == "whole" { svg_modes::classifier::SvgKind::Whole }
        else { svg_modes::classifier::classify(text)? }
    } else { svg_modes::classifier::SvgKind::Whole };
    let split = !matches!(svg_kind, svg_modes::classifier::SvgKind::Whole);
    let mode_used = if split { "groups" } else { "whole" }.to_owned();
    progress("parse", 0, 1);
    // Measure authored groups in the original coordinate system BEFORE any
    // splitting/cropping. The full usvg tree is dropped before asset rendering.
    let mut original_measurements = std::collections::HashMap::new();
    let svg_text = if split {
        if let Some(source) = svg_text {
            let doc = roxmltree::Document::parse_with_options(&source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| e.to_string())?;
            let container = if svg_kind == svg_modes::classifier::SvgKind::TopLevelGroups { Some(doc.root_element()) }
                else { svg_modes::scene::find_atomic_layer_group(doc.root_element()) };
            let ranges: Vec<_> = container.into_iter().flat_map(|node| node.children()).filter(|node| node.has_tag_name("g")).map(|node| node.range()).collect();
            if ranges.is_empty() { Some(source) } else {
                let mut measurement_options = options();
                measurement_options.dpi = 96.0;
                let (annotated, measurements) = crate::svg_measure::measure_groups(&source, &ranges, &measurement_options)?;
                original_measurements = measurements;
                Some(annotated)
            }
        } else { None }
    } else { svg_text };
    let sources = if extension == "png" {
        if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" { return Err("PNG 文件无效".into()); }
        let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 { return Err("PNG 尺寸无效或超过 4000 万像素".into()); }
        tiny_skia::Pixmap::decode_png(&data).map_err(|e| format!("PNG 解码失败：{e}"))?;
        vec![(String::new(), format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{width}\" height=\"{height}\"><image width=\"{width}\" height=\"{height}\" xlink:href=\"data:image/png;base64,{}\"/></svg>", STANDARD.encode(data)))]
    } else if extension == "jpg" || extension == "jpeg" {
        let decoded = image::load_from_memory(&data).map_err(|e| format!("JPG 解码失败：{e}"))?;
        let (width, height) = image::GenericImageView::dimensions(&decoded);
        vec![(String::new(), format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\"><image width=\"{width}\" height=\"{height}\" href=\"data:image/jpeg;base64,{}\"/></svg>", STANDARD.encode(data)))]
    } else if extension == "svg" {
        let svg_text = svg_text.as_deref().ok_or("SVG 内容为空")?;
        match svg_kind {
            svg_modes::classifier::SvgKind::Whole => svg_modes::whole::sources(svg_text)?,
            svg_modes::classifier::SvgKind::TopLevelGroups => svg_modes::top_groups::sources(svg_text, &progress)?,
            svg_modes::classifier::SvgKind::SceneTree => svg_modes::scene::split_sources_with_progress(svg_text, true, &progress)?,
        }
    } else { return Err("仅支持 SVG、PNG 和 JPG 文件".into()); };
    let options = options();
    let total = sources.len();
    progress("generate", 0, total.max(1));
    let mut assets = Vec::new();
    for (index, (part_name, source)) in sources.into_iter().enumerate() {
        let tree = usvg::Tree::from_str(&source, &options).map_err(|e| format!("图形解析失败：{e}"))?;
        if !tree.root().children().is_empty() {
            let source_doc = roxmltree::Document::parse_with_options(&source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| e.to_string())?;
            let original = source_doc.descendants().filter(|node| node.has_tag_name("g")).filter_map(|node| node.attribute("id").and_then(|id| original_measurements.get(id))).next();
            let (source_group_width_mm, source_group_height_mm, source_group_bounds) = if let Some(measured) = original {
                let root = root_geometry(&source).ok_or("SVG 原始坐标系无效")?;
                (measured.width_mm, measured.height_mm, viewport_to_source_bounds(root, measured.viewport_bounds))
            } else if split {
                source_group_metrics(&source, &tree)
            } else {
                source_root_metrics(&source)
            };
            let (svg, width, height) = if split {
                let viewport = original.map(|measurement| measurement.viewport_bounds).or_else(|| source_group_viewport_bounds(&source, &tree)).ok_or("图形没有有效的实际边界")?;
                let width = (viewport[2] - viewport[0]) as f32;
                let height = (viewport[3] - viewport[1]) as f32;
                // The generated file owns the original group's measured size,
                // not the entire source sheet's dimensions. Keep child geometry.
                let svg = if source_group_bounds[2] > 0.0 && source_group_bounds[3] > 0.0 {
                    replace_root_view_box(&source, source_group_bounds)?
                } else { source.clone() };
                let svg = crate::svg_measure::set_physical_size(&svg, source_group_width_mm, source_group_height_mm)?;
                (svg, width, height)
            } else {
                let width = tree.size().width();
                let height = tree.size().height();
                // The complete artwork remains byte-for-byte sourced from the
                // embedded input. No normalization step rewrites width/height.
                (source.clone(), width, height)
            };
            // Keep the authored SVG (with only a viewBox crop for split assets)
            // as the canonical resource. PNG rendering is reserved for
            // temporary pixel validation and export; importing every split
            // asset as a raster preview wastes time and duplicates SQLite data.
            let asset = Asset {
                source_file_name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                id: format!("{request_id}-{index}"),
                name: if part_name.is_empty() { name.to_string() } else { format!("{name} · {part_name}") },
                product_id: product_id.into(), product_name: String::new(), width, height,
                source_group_width_mm, source_group_height_mm, source_group_bounds,
                // SVG is the single source of truth. Preview URLs are kept
                // empty so one large embedded SVG is not stored three times
                // in memory/SQLite; the UI derives a data URL lazily when it
                // needs to display an asset.
                preview_url: String::new(), thumbnail_url: String::new(), storage_path: String::new(), svg, mode_used: mode_used.clone(), merge_status: if split { "kept-separate".into() } else { "whole".into() }, source_group_id: format!("{request_id}-{index}"), attributes: BTreeMap::new(), attribute_images: BTreeMap::new(), note: String::new(), note_image: String::new(), attributes_confirmed: false, product_group_id: String::new(), product_group_color: String::new(), product_group_leader_id: String::new(), product_group_mode: String::new(), product_group_position: 0,
            };
            on_asset(&asset);
            assets.push(asset);
        }
        progress("generate", index + 1, total.max(1));
    }
    if assets.is_empty() { return Err("没有找到可渲染的图形，请检查 SVG 内容和字体".into()); }
    Ok(assets)
}

fn embed_relative_images(svg: &str, svg_path: &Path) -> Result<String, String> {
    let mut out = svg.to_owned();
    for key in ["xlink:href=\"", "href=\""] {
        let mut pos = 0;
        while let Some(start) = out[pos..].find(key) {
            let start = pos + start + key.len();
            let Some(end_rel) = out[start..].find('"') else { break };
            let end = start + end_rel;
            let href = &out[start..end];
            if href.starts_with("data:") { pos = end + 1; continue; }
            if href.contains("://") || Path::new(href).is_absolute() { return Err("SVG 含不支持的外部图片引用".into()); }
            let base_dir = svg_path.parent().unwrap_or_else(|| Path::new("."));
            let mut image_path = base_dir.join(href);
            // Some Corel exports rename the companion `_Images` folder while
            // leaving the old folder name in the SVG. Resolve that sibling
            // folder by its `_Images` suffix when the literal path is absent.
            if !image_path.exists() {
                if let Some(file_name) = Path::new(href).file_name() {
                    if let Ok(entries) = fs::read_dir(base_dir) {
                        let source_stem = svg_path.file_stem().map(|value| value.to_string_lossy().to_lowercase()).unwrap_or_default();
                        let mut folders: Vec<_> = entries.flatten().filter(|entry| entry.path().is_dir() && entry.file_name().to_string_lossy().ends_with("_Images")).collect();
                        // Prefer the companion folder whose name shares the
                        // SVG stem. Falling back to the first *_Images folder
                        // could silently pick another order's image with the
                        // same ImgID and made large imports appear corrupted.
                        folders.sort_by_key(|entry| {
                            let name = entry.file_name().to_string_lossy().to_lowercase();
                            if name.starts_with(&source_stem) { 0 } else { 1 }
                        });
                        let suffix = file_name.to_string_lossy().split_once("_ImgID").map(|(_, rest)| format!("_ImgID{rest}"));
                        'folders: for folder in folders {
                            let exact = folder.path().join(file_name);
                            if exact.exists() {
                                image_path = exact;
                                break 'folders;
                            }
                            if let Some(suffix) = suffix.as_deref() {
                                if let Ok(files) = fs::read_dir(folder.path()) {
                                    if let Some(found) = files.flatten().find(|item| item.file_name().to_string_lossy().ends_with(suffix)) {
                                        image_path = found.path();
                                        break 'folders;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let bytes = fs::read(&image_path).map_err(|e| format!("关联图片读取失败：{} ({e})", image_path.display()))?;
            let mime = match image_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", _ => return Err("SVG 关联图片仅支持 PNG/JPG".into()) };
            let encoded = format!("data:{mime};base64,{}", STANDARD.encode(bytes));
            let expanded_size = out.len().saturating_sub(end - start).saturating_add(encoded.len());
            if expanded_size > MAX_SVG_BYTES {
                return Err("SVG 嵌入图片展开后超过 500 MB，请拆分文件或压缩图片后重试".into());
            }
            out.replace_range(start..end, &encoded);
            pos = start + encoded.len() + 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn artwork_without_text_never_loads_fonts() {
        let options = super::options();
        assert_eq!(options.fontdb.len(), 0, "import options must start without fonts");
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><style>path { font-family: Arial; }</style><path d="M0 0h40v40H0z"/><text display="none">Hidden</text></svg>"#;
        let tree = usvg::Tree::from_str(source, &options).unwrap();
        assert_eq!(tree.fontdb().len(), 0, "paths and hidden text must not request fonts");
        assert!(!tree.root().children().is_empty());
    }

    #[test]
    fn source_group_metrics_use_viewbox_ratio_and_physical_root_size() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="163.78mm" height="74.4334mm" viewBox="0 0 5726758 2602642"><g><rect x="100" y="200" width="2454617" height="2454617" fill="red"/></g></svg>"#;
        let tree = usvg::Tree::from_str(source, &options()).unwrap();
        let (width_mm, height_mm, bounds) = source_group_metrics(source, &tree);
        assert!((width_mm - 70.1998).abs() < 0.001, "width={width_mm}");
        assert!((height_mm - 70.2).abs() < 0.001, "height={height_mm}");
        assert!((bounds[2] - 2454617.0).abs() < 1.0);
        assert!((bounds[3] - 2454617.0).abs() < 1.0);
    }

    #[test]
    fn split_viewbox_keeps_authored_root_dimensions() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 1000 500"><g><rect x="100" y="50" width="200" height="100" fill="red"/></g></svg>"#;
        let cropped = replace_root_view_box(source, [100.0, 50.0, 200.0, 100.0]).unwrap();
        assert!(cropped.contains("width=\"100mm\""));
        assert!(cropped.contains("height=\"50mm\""));
        assert!(cropped.contains("viewBox=\"100.000000000 50.000000000 200.000000000 100.000000000\""));
        let tree = usvg::Tree::from_str(&cropped, &options()).unwrap();
        assert_eq!(tree.size().width(), usvg::Tree::from_str(source, &options()).unwrap().size().width());
    }

    #[test]
    fn cropped_imports_keep_source_root_dimensions() {
        let assets = import(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/grouped.svg")), "b", "groups", "root-size", |_, _| {}).unwrap();
        assert_eq!(assets.len(), 2);
        assert!(assets[0].svg.contains("width=\"200\""));
        assert!(assets[0].svg.contains("height=\"100\""));
        assert!(assets[0].svg.contains("viewBox=\"20.000000000 10.000000000 30.000000000 40.000000000\""));
    }

    #[test]
    fn source_group_metrics_ignore_large_clip_geometry_outside_visible_artwork() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 1000 1000"><defs><clipPath id="far"><rect x="0" y="0" width="1000" height="9000"/></clipPath></defs><g><rect x="400" y="400" width="200" height="200" fill="red" clip-path="url(#far)"/></g></svg>"#;
        let tree = usvg::Tree::from_str(source, &options()).unwrap();
        let (width_mm, height_mm, bounds) = source_group_metrics(source, &tree);
        assert!((width_mm - 20.0).abs() < 0.2, "width={width_mm}, bounds={bounds:?}");
        assert!((height_mm - 20.0).abs() < 0.2, "height={height_mm}, bounds={bounds:?}");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn export_fonts_are_bounded_and_cached() {
        let started = std::time::Instant::now();
        let first = super::export_options().unwrap();
        let faces = first.fontdb.faces().count();
        eprintln!("export font initialization: faces={faces}, elapsed_ms={}", started.elapsed().as_millis());
        assert!(faces > 0 && faces <= 16, "page export should only load its English/Chinese font families, got {faces} faces");
        assert!(std::sync::Arc::ptr_eq(&first.fontdb, &super::export_options().unwrap().fontdb), "exports should share the font cache");
    }
    use super::*;

    fn asset_pixmap(asset: &Asset) -> tiny_skia::Pixmap {
        assert!(asset.preview_url.is_empty());
        assert!(asset.thumbnail_url.is_empty());
        let tree = usvg::Tree::from_str(&asset.svg, &options()).unwrap();
        render_pixmap(&tree, 1536.0).unwrap()
    }
    #[test]
    fn preserves_nested_graphics_defs_and_transform() {
        let source = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><defs><linearGradient id="a"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><g id="one" transform="translate(20 10)"><rect width="30" height="40" fill="url(#a)"/></g><circle cx="100" cy="50" r="10"/></svg>"##;
        let sources = split_sources(source, true).unwrap();
        assert_eq!(sources.len(), 2);
        let tree = usvg::Tree::from_str(&sources[0].1, &options()).unwrap();
        let bounds = tree.root().abs_layer_bounding_box();
        assert_eq!((bounds.x(), bounds.y(), bounds.width(), bounds.height()), (20.0, 10.0, 30.0, 40.0));
        assert!(render(&tree, 192.0).unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(split_sources(source, false).unwrap().len(), 1);
    }
    #[test]
    fn assigns_standalone_outline_to_nearest_image_group() {
        let image = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJyZWQiLz48L3N2Zz4=";
        let source = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g><image x="20" y="30" width="10" height="10" href="data:image/svg+xml;base64,{image}"/><path d="M19.8 29.8h10.4v10.4h-10.4z" fill="none" stroke="black" stroke-width="0.2"/></g></svg>"#);
        let sources = split_sources(&source, true).unwrap();
        assert_eq!(sources.len(), 1, "outline should be assigned to its image group");
        assert!(sources[0].1.contains("<image"));
        assert!(sources[0].1.contains("<path"));
    }
    #[test]
    fn layer_named_group_keeps_each_child_as_one_asset() {
        let embedded = STANDARD.encode(r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>"#);
        let source = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><clipPath id="clip"><rect width="8" height="8"/></clipPath></defs><g id="图层_x0020_1" transform="translate(10 20)"><g id="one"><image width="8" height="8" href="data:image/svg+xml;base64,{embedded}"/><path d="M0 0h8v8h-8z" clip-path="url(#clip)" fill="none" stroke="black"/></g><g id="two"><image x="20" width="8" height="8" href="data:image/svg+xml;base64,{embedded}"/><path d="M20 0h8v8h-8z" fill="none" stroke="black"/></g></g></svg>"#);
        let sources = split_sources(&source, true).unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|(_, svg)| svg.contains("<image") && svg.contains("<path") && svg.contains("<clipPath")));
    }
    #[test]
    fn handles_many_split_candidates_without_cloning_the_scene() {
        let embedded = STANDARD.encode(r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>"#);
        let mut source = String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="800" height="80"><g>"#);
        for index in 0..80 {
            let x = index * 10;
            source.push_str(&format!(r#"<g id="item-{index}"><image x="{x}" y="0" width="8" height="8" href="data:image/svg+xml;base64,{embedded}"/><path d="M{x} 0h8v8h-8z" fill="none" stroke="black"/></g>"#));
        }
        source.push_str("</g></svg>");
        let sources = split_sources(&source, true).unwrap();
        assert_eq!(sources.len(), 80);
    }
    #[test]
    fn rejects_missing_external_images_and_invalid_xml() {
        assert!(split_sources("broken", true).is_err());
        assert!(split_sources(r#"<svg><image href="file:///private.png"/></svg>"#, false).is_err());
    }
    #[test]
    fn cropped_imports_have_real_pixels_and_keep_aspect_ratio() {
        let assets = import(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/grouped.svg")), "b", "groups", "fixture", |_, _| {}).unwrap();
        assert_eq!(assets.len(), 2);
        assert_eq!((assets[0].width, assets[0].height), (30.0, 40.0));
        assert_eq!((assets[1].width, assets[1].height), (20.0, 20.0));
        for asset in assets {
            let image = asset_pixmap(&asset);
            assert!(image.pixels().iter().any(|pixel| pixel.alpha() > 0));
            assert_eq!(asset.product_id, "b");
        }
    }
    #[test]
    fn local_order_fixture_when_available() {
        let Ok(path) = std::env::var("PRINTFLOW_TEST_SVG") else { return };
        for mode in ["whole", "groups"] {
            let assets = import(Path::new(&path), "a", mode, "test", |_, _| {}).unwrap();
            assert!(!assets.is_empty());
            if mode == "whole" { assert_eq!(assets.len(), 1); }
            for asset in &assets {
                assert!(asset.width > 0.0 && asset.height > 0.0);
                let image = asset_pixmap(asset);
                assert!(image.pixels().iter().any(|p| p.alpha() > 0));
                if mode == "whole" {
                    assert!(image.pixels().iter().any(|p| p.alpha() > 0 && p.red() < 200 && p.green() < 200 && p.blue() < 200));
                    if let Ok(output) = std::env::var("PRINTFLOW_TEST_OUTPUT") {
                        fs::create_dir_all(&output).unwrap();
                        let bytes = image.encode_png().unwrap();
                        fs::write(Path::new(&output).join("order-preview.png"), bytes).unwrap();
                        fs::write(Path::new(&output).join("order-normalized.svg"), &asset.svg).unwrap();
                        let png_assets = import(&Path::new(&output).join("order-preview.png"), "a", "whole", "png-test", |_, _| {}).unwrap();
                        assert_eq!(png_assets.len(), 1);
                        assert_eq!(png_assets[0].width as u32, image.width());
                        assert_eq!(png_assets[0].height as u32, image.height());
                    }
                }
            }
            println!("{mode}: {} rendered assets", assets.len());
        }
    }

    #[test]
    fn exported_svg_image_renders_with_rotation() {
        let embedded = STANDARD.encode(r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>"#);
        let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><image x="-20" y="-10" width="40" height="20" transform="translate(100 100) rotate(90)" href="data:image/svg+xml;base64,{embedded}"/></svg>"#);
        let tree = usvg::Tree::from_str(&svg, &options()).unwrap();
        let png = render(&tree, 200.0).unwrap();
        let image = tiny_skia::Pixmap::decode_png(&STANDARD.decode(png.split_once(',').unwrap().1).unwrap()).unwrap();
        let center = image.pixel(100, 100).unwrap();
        assert_eq!((center.red(), center.green(), center.blue(), center.alpha()), (255, 0, 0, 255));
        assert_eq!(image.pixel(115, 100).unwrap().alpha(), 0);
        assert_eq!(image.pixel(100, 115).unwrap().alpha(), 255);
    }
}







