use super::super::{options, render_pixmap};

fn opening_tag(source: &str) -> Result<&str, String> {
    let mut quote = None;
    for (index, ch) in source.char_indices() {
        match (quote, ch) {
            (None, '\'' | '"') => quote = Some(ch),
            (Some(q), current) if q == current => quote = None,
            (None, '>') => return Ok(&source[..=index]),
            _ => (),
        }
    }
    Err("SVG 根节点不完整".into())
}

#[allow(dead_code)]
pub fn split_sources(data: &str, split: bool) -> Result<Vec<(String, String)>, String> {
    split_sources_with_progress(data, split, |_, _, _| {})
}

pub(crate) fn split_sources_with_progress<F: Fn(&str, usize, usize)>(data: &str, split: bool, progress: F) -> Result<Vec<(String, String)>, String> {
    // CorelDRAW and Illustrator commonly include the standard SVG DOCTYPE.
    // roxmltree does not fetch the external DTD.
    let doc = roxmltree::Document::parse_with_options(data, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).map_err(|e| format!("SVG 解析失败：{e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" { return Err("文件不是 SVG".into()); }
    for node in root.descendants().filter(|n| n.is_element()) {
        if matches!(node.tag_name().name(), "script" | "foreignObject") { return Err("请先移除 SVG 中的脚本或 HTML 内容".into()); }
        for attr in node.attributes() {
            if attr.name().starts_with("on") { return Err("SVG 不支持事件脚本".into()); }
            if attr.name() == "href" && !attr.value().starts_with('#') && !attr.value().starts_with("data:") {
                return Err("SVG 含外部图片引用，请先在原软件中嵌入图片再导入".into());
            }
        }
    }
    if !split { return Ok(vec![(String::new(), data.to_owned())]); }
    let drawable = |n: &roxmltree::Node<'_, '_>| matches!(n.tag_name().name(), "g" | "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line" | "text" | "image" | "use" | "svg" | "switch");
    let children: Vec<_> = root.children().filter(|n| n.is_element()).collect();
    // CorelDRAW exports often place every artwork layer below one large
    // container group while leaving a few page-level paths beside it. Pick
    // that container by drawable descendant count, then split its direct
    // children so nested groups retain their paths/images together.
    let container = children.iter().filter(|n| n.tag_name().name() == "g")
        .max_by_key(|n| n.descendants().filter(|d| d.is_element() && drawable(d)).count());
    let shared: String = children.iter().filter(|n| !drawable(n)).map(|n| &data[n.range()]).collect();
    let opening = opening_tag(&data[root.range()])?;
    // The selected container's transform is part of the global scene. Keep
    // it around each candidate so usvg can calculate the same bounds as the
    // original document instead of comparing raw x/y attributes.
    let container_opening = container
        .map(|node| opening_tag(&data[node.range()]).map(str::to_owned))
        .transpose()?;

    // Some CorelDRAW exports put every finished artwork in a direct child
    // group of a layer group (for example `id="图层_x0020_1"`). Those child
    // groups are already the product boundaries. Keep them atomically and
    // skip per-node geometry/merge analysis; this is both faster and safer
    // because the outline paths, circles and image remain in their authored
    // group and z-order.
    if let Some(layer) = find_atomic_layer_group(root) {
        let groups: Vec<_> = layer.children().filter(|node| {
            node.is_element() && node.tag_name().name() == "g"
                && node.descendants().any(|descendant| descendant.is_element() && is_drawable_name(descendant.tag_name().name()))
        }).collect();
        if !groups.is_empty() {
            if groups.len() > 500 { return Err("图层组超过 500 个，请分批导入或使用整图模式".into()); }
            let total = groups.len();
            progress("parse", 0, total.max(1));
            let prefix = &data[..root.range().start];
            let opening = opening_tag(&data[root.range()])?;
            let shared = shared_root_content(data, root, &children);
            let mut sources = Vec::with_capacity(total);
            for (index, group) in groups.into_iter().enumerate() {
                let raw_xml = &data[group.range()];
                let source = atomic_layer_source(prefix, opening, &shared, layer, raw_xml, data)?;
                let name = group.attribute("data-name").or_else(|| group.attribute("id"))
                    .map(str::to_owned).unwrap_or_else(|| format!("图形 {}", index + 1));
                sources.push((name, source));
                progress("parse", index + 1, total.max(1));
            }
            return Ok(sources);
        }
    }

    let mut candidate_specs = Vec::new();
    if let Some(group) = container {
        for node in group.children().filter(|n| n.is_element() && drawable(n)) {
            candidate_specs.push((node, container_opening.clone()));
        }
        // A large container does not own root-level artwork. Keep those
        // siblings as candidates too instead of silently dropping them.
        for node in children.iter().filter(|n| drawable(*n) && Some(n.id()) != container.map(|group| group.id())) {
            candidate_specs.push((*node, None));
        }
    } else {
        candidate_specs.extend(children.iter().filter(|n| drawable(*n)).copied().map(|node| (node, None)));
    }
    candidate_specs.sort_by_key(|(node, _)| node.range().start);
    if candidate_specs.len() > 500 { return Err("顶层图形超过 500 个，请分批导入或使用整图模式".into()); }
    let candidate_total = candidate_specs.len();
    progress("parse", 0, candidate_total.max(1));
    let prefix = &data[..root.range().start];
    let render_options = options();
    let mut parsed = Vec::with_capacity(candidate_specs.len());
    for (order, (node, wrapper)) in candidate_specs.into_iter().enumerate() {
        let raw_xml = data[node.range()].to_owned();
        let xml = wrap_candidate_xml(wrapper.as_deref(), &raw_xml);
        let has_image = node.descendants().any(|n| n.is_element() && n.tag_name().name() == "image");
        let candidate_source = scene_source(prefix, opening, &shared, None, &xml);
        let bounds = rendered_bounds(&candidate_source, &render_options);
        let name = node.attribute("data-name").or_else(|| node.attribute("id")).map(str::to_owned)
            .unwrap_or_else(|| format!("图形 {}", order + 1));
        parsed.push(SplitCandidate { name, xml, order, has_image, bounds });
        progress("parse", order + 1, candidate_total.max(1));
    }

    // First form image groups by their rendered global bounding boxes. Then
    // attach standalone paths/lines to the nearest image group. This is what
    // keeps a separately exported outline with the image it surrounds.
    let mut groups: Vec<SplitGroup> = Vec::new();
    let mut unattached = Vec::new();
    for candidate in parsed {
        if candidate.has_image {
            let matching = candidate.bounds.and_then(|bounds| groups.iter().position(|group| {
                group.bounds.map(|known| bounds_nearly_same(known, bounds)).unwrap_or(false)
            }));
            if let Some(index) = matching {
                groups[index].nodes.push(candidate);
            } else {
                groups.push(SplitGroup::new(candidate));
            }
        } else {
            unattached.push(candidate);
        }
    }
    for candidate in unattached {
        let Some(bounds) = candidate.bounds else {
            groups.push(SplitGroup::new(candidate));
            continue;
        };
        let nearest = groups.iter().enumerate().filter_map(|(index, group)| {
            if !group.has_image { return None; }
            let known = group.bounds?;
            let (gap, center_distance) = bounds_distance(known, bounds);
            let scale = (known[2] - known[0]).max(known[3] - known[1])
                .max(bounds[2] - bounds[0]).max(bounds[3] - bounds[1]).max(1.0);
            // A path that overlaps the image (or its small stroke margin) is
            // always a match. For detached paths, allow a bounded nearest
            // match so thin contour lines still follow their artwork while
            // distant page decorations remain standalone.
            let close = gap <= (scale * 0.12).max(0.1) || center_distance <= scale * 1.5;
            close.then_some((index, gap + center_distance * 0.05))
        }).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        if let Some((index, _)) = nearest {
            groups[index].nodes.push(candidate);
            groups[index].recalculate_bounds();
        } else {
            groups.push(SplitGroup::new(candidate));
        }
    }
    groups.sort_by_key(|group| group.nodes.iter().map(|node| node.order).min().unwrap_or(usize::MAX));
    // A geometric match is only accepted if rendering the merged scene is
    // pixel-equivalent to rendering the original candidate scene. This keeps
    // a bad bounding-box match from losing a stroke, mask or clipping effect.
    let mut merged_nodes: Vec<&SplitCandidate> = groups.iter().flat_map(|group| group.nodes.iter()).collect();
    merged_nodes.sort_by_key(|node| node.order);
    let merged_body: String = merged_nodes.into_iter().map(|node| node.xml.as_str()).collect();
    let merged_scene = scene_source(prefix, opening, &shared, None, &merged_body);
    // `data` is already the complete, embedded source document. Reusing it
    // for the left side of the pixel comparison avoids concatenating another
    // full copy of every image before rendering.
    let merge_is_safe = scene_pixel_match(data, &merged_scene, &render_options, 0.001);
    if !merge_is_safe {
        // All candidates are already owned by `groups`; flatten them instead
        // of retaining a second cloned copy just for the fallback path.
        groups = groups.into_iter().flat_map(|group| group.nodes).map(SplitGroup::new).collect();
        groups.sort_by_key(|group| group.nodes.first().map(|node| node.order).unwrap_or(usize::MAX));
    }
    Ok(groups.into_iter().enumerate().map(|(index, mut group)| {
        group.nodes.sort_by_key(|node| node.order);
        let body: String = group.nodes.iter().map(|node| node.xml.as_str()).collect();
        let name = group.nodes.iter().find(|node| node.has_image).map(|node| node.name.clone())
            .unwrap_or_else(|| format!("图形 {}", index + 1));
        // Keep sibling definitions and the original container transform so
        // <use>, clipPath, mask, gradients and filters continue to resolve.
        (name, scene_source(prefix, opening, &shared, None, &body))
    }).collect())
}

fn scene_pixel_match(a: &str, b: &str, options: &usvg::Options<'static>, threshold: f32) -> bool {
    let Ok(tree_a) = usvg::Tree::from_str(a, options) else { return false; };
    let Ok(tree_b) = usvg::Tree::from_str(b, options) else { return false; };
    let Ok(pixmap_a) = render_pixmap(&tree_a, 1024.0) else { return false; };
    let Ok(pixmap_b) = render_pixmap(&tree_b, 1024.0) else { return false; };
    crate::compositor::within_threshold(&pixmap_a, &pixmap_b, threshold)
}

#[derive(Clone, Debug)]
struct SplitCandidate {
    name: String,
    xml: String,
    order: usize,
    has_image: bool,
    bounds: Option<[f64; 4]>,
}

#[derive(Clone, Debug)]
struct SplitGroup {
    nodes: Vec<SplitCandidate>,
    bounds: Option<[f64; 4]>,
    has_image: bool,
}

impl SplitGroup {
    fn new(candidate: SplitCandidate) -> Self {
        Self { bounds: candidate.bounds, has_image: candidate.has_image, nodes: vec![candidate] }
    }

    fn recalculate_bounds(&mut self) {
        self.bounds = self.nodes.iter().filter_map(|node| node.bounds).reduce(union_bounds);
    }
}

fn scene_source(prefix: &str, opening: &str, shared: &str, container_opening: Option<&str>, body: &str) -> String {
    match container_opening {
        Some(container) => format!("{prefix}{opening}{shared}{container}{body}</g></svg>"),
        None => format!("{prefix}{opening}{shared}{body}</svg>"),
    }
}

pub(crate) fn find_atomic_layer_group<'a>(root: roxmltree::Node<'a, 'a>) -> Option<roxmltree::Node<'a, 'a>> {
    root.descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "g")
        .filter(|node| {
            let id = node.attribute("id").unwrap_or_default();
            let name = node.attribute("data-name").unwrap_or_default();
            id.contains("图层") || name.contains("图层") || id.to_ascii_lowercase().contains("layer") || name.to_ascii_lowercase().contains("layer")
        })
        .filter(|node| node.children().any(|child| child.is_element() && child.tag_name().name() == "g"))
        .max_by_key(|node| node.children().filter(|child| child.is_element() && child.tag_name().name() == "g").count())
}

fn is_drawable_name(name: &str) -> bool {
    matches!(name, "g" | "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line" | "text" | "image" | "use" | "svg" | "switch")
}

fn shared_root_content(data: &str, root: roxmltree::Node<'_, '_>, children: &[roxmltree::Node<'_, '_>]) -> String {
    let mut shared: String = children.iter().filter(|node| !is_drawable_name(node.tag_name().name())).map(|node| &data[node.range()]).collect();
    // Definitions are commonly placed below the layer wrapper in CorelDRAW
    // exports. Copy each defs block into the generated document so references
    // such as clip-path, mask, gradients and symbols keep resolving.
    for defs in root.descendants().filter(|node| node.is_element() && node.tag_name().name() == "defs") {
        let xml = &data[defs.range()];
        if !shared.contains(xml) { shared.push_str(xml); }
    }
    shared
}

fn atomic_layer_source(
    prefix: &str,
    opening: &str,
    shared: &str,
    layer: roxmltree::Node<'_, '_>,
    body: &str,
    data: &str,
) -> Result<String, String> {
    let mut ancestors = Vec::new();
    let mut current = layer;
    while let Some(parent) = current.parent() {
        // Stop at the document root element. The root itself is emitted by
        // `opening`; every group between it and the selected layer is a
        // wrapper whose transform must remain active.
        if parent.tag_name().name() == "svg" { break; }
        if parent.is_element() && parent.tag_name().name() == "g" {
            ancestors.push(opening_tag(&data[parent.range()])?.to_owned());
        }
        current = parent;
    }
    ancestors.reverse();
    let mut source = String::with_capacity(prefix.len() + opening.len() + shared.len() + body.len() + ancestors.iter().map(String::len).sum::<usize>() + 32);
    source.push_str(prefix);
    source.push_str(opening);
    source.push_str(shared);
    for ancestor in &ancestors { source.push_str(ancestor); }
    source.push_str(&opening_tag(&data[layer.range()])?);
    // The selected layer is a wrapper; the candidate group remains intact as
    // authored, including its image, outline paths, clip-path and z-order.
    source.push_str(body);
    source.push_str("</g>");
    for _ in &ancestors { source.push_str("</g>"); }
    source.push_str("</svg>");
    Ok(source)
}

fn wrap_candidate_xml(wrapper: Option<&str>, xml: &str) -> String {
    match wrapper {
        Some(opening) => format!("{opening}{xml}</g>"),
        None => xml.to_owned(),
    }
}

fn rendered_bounds(source: &str, options: &usvg::Options<'static>) -> Option<[f64; 4]> {
    let tree = usvg::Tree::from_str(source, options).ok()?;
    rendered_tree_bounds(&tree).or_else(|| {
        let rect = tree.root().abs_layer_bounding_box();
        if !rect.width().is_finite() || !rect.height().is_finite() || rect.width() <= 0.0 || rect.height() <= 0.0 { return None; }
        let x = rect.x() as f64;
        let y = rect.y() as f64;
        let width = rect.width() as f64;
        let height = rect.height() as f64;
        Some([x, y, x + width, y + height])
    })
}

/// Calculate the visible bounds from rendered alpha pixels. `abs_layer_bounding_box`
/// can include very large clipPath/mask geometry that is not itself visible;
/// using the rasterized alpha channel avoids creating an oversized viewBox for
/// an otherwise correctly positioned image.
pub(crate) fn rendered_tree_bounds(tree: &usvg::Tree) -> Option<[f64; 4]> {
    let max_side = 2048.0_f32;
    let source_width = tree.size().width();
    let source_height = tree.size().height();
    if !source_width.is_finite() || !source_height.is_finite() || source_width <= 0.0 || source_height <= 0.0 { return None; }
    let scale = (max_side / source_width.max(source_height)).min(1.0);
    let width = (source_width * scale).ceil().max(1.0) as u32;
    let height = (source_height * scale).ceil().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(width, height)?;
    resvg::render(tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0_u32;
    let mut max_y = 0_u32;
    let mut found = false;
    for (index, pixel) in pixmap.data().chunks_exact(4).enumerate() {
        // Ignore fully transparent antialiasing fringes while retaining light
        // strokes and semi-transparent artwork.
        if pixel[3] <= 2 { continue; }
        let x = (index as u32) % width;
        let y = (index as u32) / width;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        found = true;
    }
    if !found { return None; }
    let x = min_x as f64 / scale as f64;
    let y = min_y as f64 / scale as f64;
    let right = (max_x + 1) as f64 / scale as f64;
    let bottom = (max_y + 1) as f64 / scale as f64;
    (right > x && bottom > y).then_some([x, y, right, bottom])
}

fn union_bounds(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

fn bounds_nearly_same(a: [f64; 4], b: [f64; 4]) -> bool {
    crate::geometry::Matrix::nearly_same(a, b, crate::geometry::DEFAULT_TOLERANCE)
}

fn bounds_distance(a: [f64; 4], b: [f64; 4]) -> (f64, f64) {
    let gap_x = (a[0] - b[2]).max(b[0] - a[2]).max(0.0);
    let gap_y = (a[1] - b[3]).max(b[1] - a[3]).max(0.0);
    let ac = ((a[0] + a[2]) * 0.5, (a[1] + a[3]) * 0.5);
    let bc = ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5);
    (gap_x.hypot(gap_y), (ac.0 - bc.0).hypot(ac.1 - bc.1))
}
