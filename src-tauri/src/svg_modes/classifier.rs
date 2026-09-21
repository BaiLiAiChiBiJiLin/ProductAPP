use roxmltree::Node;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SvgKind {
    Whole,
    TopLevelGroups,
    SceneTree,
}

fn drawable(name: &str) -> bool {
    matches!(name, "g" | "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line" | "text" | "image" | "use" | "svg" | "switch")
}

fn is_page_decoration(node: Node<'_, '_>) -> bool {
    let id = node.attribute("id").unwrap_or_default();
    let name = node.attribute("data-name").unwrap_or_default();
    id == "workarea-background" || id.starts_with("print-guide-") || name.contains("背景") || name.contains("出血线") || name.contains("内容线")
}

/// Classify the SVG without opening or rewriting any image data. The two
/// split modes are intentionally based on mutually exclusive scene shapes.
pub(crate) fn classify(data: &str) -> Result<SvgKind, String> {
    let doc = roxmltree::Document::parse_with_options(data, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| format!("SVG 解析失败：{e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" { return Err("文件不是 SVG".into()); }
    let direct_groups: Vec<_> = root.children().filter(|node| node.is_element() && node.tag_name().name() == "g").collect();
    let has_image = root.descendants().any(|node| node.is_element() && node.tag_name().name() == "image");
    let has_complex_refs = root.descendants().any(|node| node.is_element() && matches!(node.tag_name().name(), "clipPath" | "mask" | "filter"));
    let atomic_groups = direct_groups.len() >= 2
        && direct_groups.iter().all(|group| !group.children().any(|node| node.is_element() && node.tag_name().name() == "g"))
        && !has_image
        && !has_complex_refs;
    if atomic_groups { return Ok(SvgKind::TopLevelGroups); }
    let drawable_count = root.descendants().filter(|node| node.is_element() && drawable(node.tag_name().name()) && !is_page_decoration(*node)).count();
    if drawable_count >= 2 { Ok(SvgKind::SceneTree) } else { Ok(SvgKind::Whole) }
}

pub(crate) fn is_decoration(node: Node<'_, '_>) -> bool { is_page_decoration(node) }

#[cfg(test)]
mod tests {
    use super::{classify, SvgKind};

    #[test]
    fn detects_atomic_root_groups() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><text>A</text></g><g id="b"><text>B</text></g><line id="print-guide-1" x1="0" x2="1" y1="0" y2="1"/></svg>"#;
        assert_eq!(classify(svg).unwrap(), SvgKind::TopLevelGroups);
    }

    #[test]
    fn detects_nested_scene_tree() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><g id="scene"><g id="item"><rect width="10" height="10"/></g><image width="10" height="10" href="data:image/png;base64,AA=="/></g></svg>"#;
        assert_eq!(classify(svg).unwrap(), SvgKind::SceneTree);
    }
}
