//! Test-only browser compatibility experiment for large Corel SVG coordinates.
//! Keep root units and path geometry intact; only localize image coordinates.
pub fn localize_images(source: &str) -> Result<String, String> {
    let doc = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions {
        allow_dtd: true, ..Default::default()
    }).map_err(|error| error.to_string())?;
    let mut edits = Vec::new();
    for node in doc.descendants().filter(|node| node.has_tag_name("image")) {
        // CSS geometry and image-local effects need a separate normalization
        // strategy: translating those effects could change their meaning.
        if ["style", "class", "clip-path", "mask", "filter"].iter().any(|key| node.has_attribute(*key))
            || node.children().any(|child| child.is_element()) { continue; }
        let coordinate = |key| node.attribute(key).unwrap_or("0").trim().parse::<f64>().ok().filter(|v| v.is_finite());
        let (Some(x), Some(y)) = (coordinate("x"), coordinate("y")) else { continue };
        if x.abs().max(y.abs()) < 16_000_000.0 { continue; }
        for key in ["x", "y"] {
            if let Some(attr) = node.attribute_node(key) { edits.push((attr.range_value(), "0".to_owned())); }
        }
        let translation = format!(" translate({x} {y})");
        if let Some(attr) = node.attribute_node("transform") {
            // Append in local coordinates, after the existing transform.
            let end = attr.range_value().end;
            edits.push((end..end, translation));
        } else {
            let start = node.range().start;
            let end = source[start..].find(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>').unwrap() + start;
            edits.push((end..end, format!(" transform=\"{}\"", translation.trim())));
        }
    }
    let mut result = source.to_owned();
    edits.sort_by_key(|(range, _)| range.start);
    for (range, value) in edits.into_iter().rev() { result.replace_range(range, &value); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_units_paths_and_transform_order_and_is_idempotent() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="236.531mm" viewBox="0 0 61380868 50621178"><g id="art"><image x='53542166' y='1079527' width='7460760' height='6085101' transform='scale(2)'/><path d="M53542166 1079527h7460760"/></g></svg>"#;
        let result = localize_images(svg).unwrap();
        assert!(result.contains("transform='scale(2) translate(53542166 1079527)'"));
        assert!(result.contains("x='0' y='0'"));
        assert!(result.contains("width=\"236.531mm\""));
        assert!(result.contains("<path d=\"M53542166 1079527h7460760\"/>"));
        assert_eq!(localize_images(&result).unwrap(), result);
    }
    #[test]
    fn leaves_small_percentage_and_effect_coordinates_untouched() {
        for image in [r#"<image x="10" y="20"/>"#, r#"<image x="50%" y="50000000"/>"#, r#"<image x="50000000" clip-path="url(#clip)"/>"#] {
            let svg = format!("<svg>{image}</svg>");
            assert_eq!(localize_images(&svg).unwrap(), svg);
        }
    }
}
