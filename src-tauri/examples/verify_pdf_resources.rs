// Diagnostic harness: functions extracted verbatim from lib.rs for Windows test-runtime isolation.
use base64::Engine;
mod assets { pub fn export_options() -> Result<usvg::Options<'static>, String> { Ok(usvg::Options::default()) } }
fn flatten_embedded_svg_images(mut svg: String) -> Result<String, String> {
    let marker = "data:image/svg+xml;base64,";
    let mut instance = 0;
    loop {
        let Some(marker_pos_global) = svg.find(marker) else { break };
        let image_start = svg[..marker_pos_global].rfind("<image").ok_or("SVG 图片资源缺少 image 标签")?;
        let image_end = svg[image_start..].find('>').map(|i| image_start + i + 1).ok_or("SVG 图片标签不完整")?;
        let tag = &svg[image_start..image_end];
        let marker_pos = tag.find(marker).ok_or("SVG 图片资源位置无效")?;
        let encoded_start = marker_pos + marker.len();
        let encoded_end = tag[encoded_start..].find(['"', '\'', ')', ' ']).map(|i| encoded_start + i).unwrap_or(tag.len());
        let inner_svg = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(&tag[encoded_start..encoded_end]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let inner_svg = flatten_embedded_svg_images(inner_svg)?;
        // Each embedded image is an isolated SVG document. Resolve its CSS,
        // root transforms and resource references before combining documents;
        // repeated CorelDRAW clip IDs must never bind to a sibling artwork.
        let tree = usvg::Tree::from_str(&inner_svg, &assets::export_options()?)
            .map_err(|error| format!("嵌入 SVG 解析失败：{error}"))?;
        let inner_svg = tree.to_string(&usvg::WriteOptions {
            id_prefix: Some(format!("pf_embed_{instance}_")),
            ..Default::default()
        });
        instance += 1;
        // A valid viewBox already defines the coordinate system. Parsing the
        // complete artwork here decodes embedded images again for every copy.
        let view_box = if let Some(view_box) = embedded_svg_view_box(&inner_svg) { view_box } else {
            let tree = usvg::Tree::from_str(&inner_svg, &assets::export_options()?).map_err(|e| e.to_string())?;
            [0.0, 0.0, tree.size().width(), tree.size().height()]
        };
        let attr = |name: &str| tag.split_once(&format!("{}=\"", name)).and_then(|(_, rest)| rest.split_once('"').map(|(v, _)| v));
        let number = |name: &str| attr(name).unwrap_or("0").parse::<f32>().unwrap_or(0.0);
        let x = number("x"); let y = number("y"); let w = number("width"); let h = number("height");
        let [vx, vy, vw, vh] = view_box;
        let raw_x = w / vw.max(f32::EPSILON);
        let raw_y = h / vh.max(f32::EPSILON);
        let preserve = embedded_svg_attr(&inner_svg, "preserveAspectRatio").unwrap_or_else(|| "xMidYMid meet".into());
        let preserve_parts = preserve.split_whitespace().collect::<Vec<_>>();
        let preserve_none = preserve_parts.first().copied() == Some("none");
        let preserve_slice = preserve_parts.get(1).copied() == Some("slice");
        let align = preserve_parts.first().copied().unwrap_or("xMidYMid");
        let (scale_x, scale_y, offset_x, offset_y) = if preserve_none {
            (raw_x, raw_y, 0.0, 0.0)
        } else {
            let scale = if preserve_slice { raw_x.max(raw_y) } else { raw_x.min(raw_y) };
            let extra_x = w - vw * scale;
            let extra_y = h - vh * scale;
            let offset_x = if align.starts_with("xMin") { 0.0 } else if align.starts_with("xMax") { extra_x } else { extra_x / 2.0 };
            let offset_y = if align.ends_with("YMin") { 0.0 } else if align.ends_with("YMax") { extra_y } else { extra_y / 2.0 };
            (scale, scale, offset_x, offset_y)
        };
        let outer_transform = attr("transform").unwrap_or("").trim();
        let prefix = if outer_transform.is_empty() { format!("translate({x} {y})") } else { format!("{outer_transform} translate({x} {y})") };
        // Imported documents can start with an XML declaration, comments and
        // a DOCTYPE. The first '>' is not necessarily the SVG opening tag.
        let document = roxmltree::Document::parse_with_options(&inner_svg, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() })
            .map_err(|error| format!("嵌入 SVG 结构无效：{error}"))?;
        let root = document.root_element();
        let inner = root.children().map(|node| &inner_svg[node.range()]).collect::<String>();
        let namespaces = root.namespaces().map(|namespace| {
            let name = namespace.name().map(|name| format!(":{name}")).unwrap_or_default();
            let uri = namespace.uri().replace('&', "&amp;").replace('"', "&quot;");
            format!(" xmlns{name}=\"{uri}\"")
        }).collect::<String>();
        let replacement = format!("<g{namespaces} transform=\"{prefix} translate({offset_x} {offset_y}) scale({scale_x} {scale_y}) translate({} {})\">{inner}</g>", -vx, -vy);
        svg.replace_range(image_start..image_end, &replacement);
    }
    Ok(svg)
}

fn embedded_svg_attr(source: &str, name: &str) -> Option<String> {
    let document = roxmltree::Document::parse_with_options(source, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).ok()?;
    document.root_element().attribute(name).map(str::to_owned)
}

fn embedded_svg_view_box(source: &str) -> Option<[f32; 4]> {
    let value = embedded_svg_attr(source, "viewBox")?;
    let values = value.replace(',', " ").split_whitespace().filter_map(|part| part.parse::<f32>().ok()).collect::<Vec<_>>();
    (values.len() == 4 && values[2] > 0.0 && values[3] > 0.0).then_some([values[0], values[1], values[2], values[3]])
}


    fn main() {
        if let Some(path) = std::env::args().nth(1) {
            let source = std::fs::read_to_string(&path).unwrap();
            let flattened = flatten_embedded_svg_images(source.clone()).unwrap();
            let render = |source: &str| {
                let tree = usvg::Tree::from_str(source, &usvg::Options::default()).unwrap();
                let scale = 1000.0 / tree.size().width();
                let mut pixmap = tiny_skia::Pixmap::new(1000, (tree.size().height()*scale).ceil() as u32).unwrap();
                resvg::render(&tree,tiny_skia::Transform::from_scale(scale,scale), &mut pixmap.as_mut()); pixmap
            };
            let a=render(&source);let b=render(&flattened);
            a.save_png(format!("{path}.reference.png")).unwrap();
            b.save_png(format!("{path}.flattened.png")).unwrap();
            let diff=a.data().iter().zip(b.data()).filter(|(a,b)| a.abs_diff(**b)>8).count();
            println!("pixels channel difference >8: {diff}/{}",a.data().len());
            let tree=usvg::Tree::from_str(&flattened,&usvg::Options::default()).unwrap();
            std::fs::write(format!("{path}.verified.pdf"),svg2pdf::to_pdf(&tree,Default::default(),Default::default()).unwrap()).unwrap();
            return;
        }

        let first = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="clip"><rect x="10" y="10" width="30" height="80"/></clipPath></defs><rect width="100" height="100" fill="red" clip-path="url(#clip)"/></svg>"##;
        let second = first.replace("x=\"10\"", "x=\"60\"").replace("fill=\"red\"", "fill=\"blue\"");
        let page = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><image width="100" height="100" href="data:image/svg+xml;base64,{}"/><image x="100" width="100" height="100" href="data:image/svg+xml;base64,{}"/></svg>"#,
            base64::engine::general_purpose::STANDARD.encode(first), base64::engine::general_purpose::STANDARD.encode(second));
        let render = |source: &str| {
            let tree = usvg::Tree::from_str(source, &usvg::Options::default()).unwrap();
            let mut pixmap = tiny_skia::Pixmap::new(200, 100).unwrap();
            resvg::render(&tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
            pixmap
        };
        let original = render(&page);
        let flattened = flatten_embedded_svg_images(page).unwrap();
        let result = render(&flattened);
        assert_eq!(original.data(), result.data(), "embedded SVG clip resources leaked across artwork");
        let dir = std::path::Path::new("../.test-output/pdf-resource-regression");
        std::fs::create_dir_all(dir).unwrap();
        original.save_png(dir.join("reference.png")).unwrap();
        let tree = usvg::Tree::from_str(&flattened, &usvg::Options::default()).unwrap();
        let pdf = svg2pdf::to_pdf(&tree, Default::default(), Default::default()).unwrap();
        std::fs::write(dir.join("verified.pdf"), pdf).unwrap();
    }

