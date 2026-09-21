//! Atomic top-level group import. Files produced with one semantic object per
//! root-level `<g>` are kept at that boundary; no descendant splitting occurs.

use super::classifier;

fn opening_tag(source: &str) -> Result<&str, String> {
    let mut quote = None;
    for (i, ch) in source.char_indices() {
        match (quote, ch) {
            (None, '\'' | '"') => quote = Some(ch),
            (Some(q), c) if q == c => quote = None,
            (None, '>') => return Ok(&source[..=i]),
            _ => (),
        }
    }
    Err("SVG 根节点不完整".into())
}

fn drawable(name: &str) -> bool {
    matches!(name, "g" | "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line" | "text" | "image" | "use" | "svg" | "switch")
}

pub(crate) fn sources(data: &str, progress: impl Fn(&str, usize, usize)) -> Result<Vec<(String, String)>, String> {
    let doc = roxmltree::Document::parse_with_options(data, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| format!("SVG 解析失败：{e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" { return Err("文件不是 SVG".into()); }
    let opening = opening_tag(&data[root.range()])?;
    let prefix = &data[..root.range().start];
    let children: Vec<_> = root.children().filter(|node| node.is_element()).collect();
    let groups: Vec<_> = children.iter().filter(|node| node.tag_name().name() == "g" && !classifier::is_decoration(**node)).collect();
    if groups.is_empty() { return Err("未找到可用的顶层图片分组".into()); }
    let shared: String = children.iter()
        .filter(|node| !drawable(node.tag_name().name()) || classifier::is_decoration(**node))
        .map(|node| data[node.range()].to_owned())
        .filter(|xml| !xml.contains("print-guide-") && !xml.contains("workarea-background"))
        .collect();
    let total = groups.len();
    progress("parse", 0, total);
    let mut result = Vec::with_capacity(total);
    for (index, group) in groups.into_iter().enumerate() {
        let name = group.attribute("data-name").or_else(|| group.attribute("id")).map(str::to_owned).unwrap_or_else(|| format!("图形 {}", index + 1));
        let xml = format!("{prefix}{opening}{shared}{}</svg>", &data[group.range()]);
        result.push((name, xml));
        progress("parse", index + 1, total);
    }
    Ok(result)
}
