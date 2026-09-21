//! Vector outline measurement for imported SVG groups.
//!
//! This module intentionally stays separate from upload and splitting. It
//! measures authored, unfilled stroke paths after all parent transforms have
//! been applied by usvg. The result is in the same CSS-pixel viewport used by
//! usvg and is converted to millimetres exactly once by the root physical size.

use usvg::{Node, Tree};
use std::collections::HashMap;

/// Measure selected authored groups in one original-document parse, before
/// splitting. Temporary IDs affect only the in-memory import copy.
pub fn measure_groups(source: &str, ranges: &[std::ops::Range<usize>], options: &usvg::Options) -> Result<(String, HashMap<String, Measurement>), String> {
    let doc = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| e.to_string())?;
    let mut annotated = source.to_owned();
    let mut ids = Vec::new();
    let mut edits = Vec::new();
    for (index, range) in ranges.iter().enumerate() {
        let node = doc.descendants().find(|node| node.is_element() && node.range() == *range).ok_or("测量分组不存在")?;
        let id = if let Some(id) = node.attribute("id") { id.to_owned() } else {
            let mut id = format!("__printflow_measure_{index}");
            while doc.descendants().any(|n| n.attribute("id") == Some(id.as_str())) { id.push('_'); }
            let tag_end = source[range.start..].find(|c: char| c.is_whitespace() || c == '>' || c == '/').ok_or("无效分组标签")?;
            edits.push((range.start + tag_end, format!(" id=\"{id}\"")));
            id
        };
        ids.push(id);
    }
    edits.sort_by_key(|(offset, _)| std::cmp::Reverse(*offset));
    for (offset, text) in edits { annotated.insert_str(offset, &text); }
    let tree = Tree::from_str(&annotated, options).map_err(|e| e.to_string())?;
    let measurements = ids.into_iter().filter_map(|id| {
        let bounds = outline_bounds(tree.node_by_id(&id)?)?;
        let width_mm = (bounds[2] - bounds[0]) * 25.4 / 96.0;
        let height_mm = (bounds[3] - bounds[1]) * 25.4 / 96.0;
        (width_mm > 0.0 && height_mm > 0.0).then_some((id, Measurement { viewport_bounds: bounds, width_mm, height_mm }))
    }).collect();
    Ok((annotated, measurements))
}

pub type Bounds = [f64; 4];

/// Give the generated standalone resource its measured physical size. Only
/// root dimensions change; artwork coordinates and transforms remain intact.
pub fn set_physical_size(source: &str, width_mm: f64, height_mm: f64) -> Result<String, String> {
    if !width_mm.is_finite() || !height_mm.is_finite() || width_mm <= 0.0 || height_mm <= 0.0 {
        return Err("图片实际毫米尺寸无效".into());
    }
    let doc = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| e.to_string())?;
    let root = doc.root_element();
    let mut edits: Vec<_> = root.attributes().filter(|attr| attr.namespace().is_none() && matches!(attr.name(), "width" | "height"))
        .map(|attr| (attr.range(), String::new())).collect();
    let start = root.range().start;
    let offset = source[start..].find(|c: char| c.is_whitespace() || c == '>' || c == '/').ok_or("无效 SVG 根标签")? + start;
    edits.push((offset..offset, format!(" width=\"{width_mm}mm\" height=\"{height_mm}mm\"")));
    edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut result = source.to_owned();
    for (range, replacement) in edits { result.replace_range(range, &replacement); }
    Ok(result)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measurement {
    pub viewport_bounds: Bounds,
    pub width_mm: f64,
    pub height_mm: f64,
}

fn union(a: Bounds, b: Bounds) -> Bounds {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

/// Measure only authored outline geometry. Filled artwork, embedded image
/// rectangles, clip paths, masks and filters are excluded so their external
/// geometry cannot inflate the product size.
pub fn outline_bounds(node: &Node) -> Option<Bounds> {
    match node {
        Node::Group(group) => {
            if group.clip_path().is_some() || group.mask().is_some() || !group.filters().is_empty() { return None; }
            group.children().iter().filter_map(outline_bounds).reduce(union)
        }
        Node::Path(path) if path.fill().is_none() && path.stroke().is_some() && path.is_visible() => {
            let transformed = path.data().clone().transform(path.abs_transform())?;
            let bounds = transformed.compute_tight_bounds()?;
            Some([bounds.left() as f64, bounds.top() as f64, bounds.right() as f64, bounds.bottom() as f64])
        }
        _ => None,
    }
}

/// Measure a parsed tree using the same vector algorithm as
/// `examples/measure_groups.rs`. Parent transforms are already included by
/// `abs_transform`; CSS pixels are converted to mm once, avoiding a second
/// viewBox ratio conversion.
pub fn measure_tree(tree: &Tree, width_mm: f64, height_mm: f64) -> Option<Measurement> {
    if !width_mm.is_finite() || !height_mm.is_finite() || width_mm <= 0.0 || height_mm <= 0.0 { return None; }
    let bounds = tree.root().children().iter().filter_map(outline_bounds).reduce(union)?;
    let viewport_width = tree.size().width() as f64;
    let viewport_height = tree.size().height() as f64;
    if viewport_width <= 0.0 || viewport_height <= 0.0 { return None; }
    let measured_width = (bounds[2] - bounds[0]) * width_mm / viewport_width;
    let measured_height = (bounds[3] - bounds[1]) * height_mm / viewport_height;
    if !measured_width.is_finite() || !measured_height.is_finite() || measured_width <= 0.0 || measured_height <= 0.0 { return None; }
    Some(Measurement { viewport_bounds: bounds, width_mm: measured_width, height_mm: measured_height })
}

#[cfg(test)]
mod tests {
    use super::measure_tree;
    use usvg::{Options, Tree};

    #[test]
    fn standalone_dimensions_use_measured_mm_without_changing_artwork() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="300mm" viewBox="100 200 100 200"><g transform="translate(100 200)"><path d="M0 0h100v200H0z" fill="none" stroke="red"/></g></svg>"#;
        let result = super::set_physical_size(source, 10.000123, 20.000246).unwrap();
        let doc = roxmltree::Document::parse(&result).unwrap();
        assert_eq!(doc.root_element().attribute("width"), Some("10.000123mm"));
        assert_eq!(doc.root_element().attribute("height"), Some("20.000246mm"));
        assert_eq!(doc.root_element().attribute("viewBox"), Some("100 200 100 200"));
        assert_eq!(&source[source.find("<g ").unwrap()..], &result[result.find("<g ").unwrap()..]);
        let tree = Tree::from_str(&result, &Options::default()).unwrap();
        assert!((tree.size().width() as f64 * 25.4 / 96.0 - 10.000123).abs() < 0.001);
        let without_size = r#"<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>"#;
        assert!(roxmltree::Document::parse(&super::set_physical_size(without_size, 10.0, 20.0).unwrap()).is_ok());
    }

    #[test]
    fn original_groups_keep_absolute_geometry_and_anonymous_identity() {
        let source = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 2000 2000"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><g id="图层" transform="translate(1000 500)"><g id="original"><path d="M0 0h100v200H0z" fill="none" stroke="red" stroke-width="50"/><rect width="9000" height="9000"/><g clip-path="url(#clip)"><path d="M0 0h9000v9000" fill="none" stroke="red"/></g></g><g transform="scale(2)"><path d="M0 0h100v200H0z" fill="none" stroke="red"/></g></g></svg>"##;
        let doc = roxmltree::Document::parse(source).unwrap();
        let layer = doc.descendants().find(|n| n.attribute("id") == Some("图层")).unwrap();
        let ranges: Vec<_> = layer.children().filter(|n| n.has_tag_name("g")).map(|n| n.range()).collect();
        let (annotated, measurements) = super::measure_groups(source, &ranges, &Options::default()).unwrap();
        assert_eq!(measurements.len(), 2);
        let first = measurements["original"];
        let second = measurements["__printflow_measure_1"];
        for (actual, expected) in [(first.width_mm, 10.0), (first.height_mm, 20.0), (second.width_mm, 20.0), (second.height_mm, 40.0)] {
            assert!((actual - expected).abs() < 0.001, "{actual} != {expected}");
        }
        assert!(annotated.contains("width=\"200mm\" height=\"200mm\""));
        assert!(annotated.contains("transform=\"translate(1000 500)\""));
        assert!(!source.contains("__printflow_measure_1"));
    }

    #[test]
    fn transformed_outline_is_measured_without_stroke_expansion() {
        let source = r#"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 2000 2000"><g transform="translate(1000 500)"><path d="M0 0h100v200H0z" fill="none" stroke="red" stroke-width="20"/></g></svg>"#;
        let tree = Tree::from_str(source, &Options::default()).unwrap();
        let measured = measure_tree(&tree, 200.0, 200.0).unwrap();
        assert!((measured.width_mm - 10.0).abs() < 0.0001);
        assert!((measured.height_mm - 20.0).abs() < 0.0001);
    }

    #[test]
    fn clipped_and_filled_geometry_is_not_used_as_outline() {
        let source = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 2000 2000"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><g><rect width="9000" height="9000" fill="red"/><g clip-path="url(#clip)"><path d="M-9000 -9000h20000v20000" fill="none" stroke="blue"/></g><path d="M0 0h100v200H0z" fill="none" stroke="black"/></g></svg>"##;
        let tree = Tree::from_str(source, &Options::default()).unwrap();
        let measured = measure_tree(&tree, 200.0, 200.0).unwrap();
        assert!((measured.width_mm - 10.0).abs() < 0.0001);
        assert!((measured.height_mm - 20.0).abs() < 0.0001);
    }
}
