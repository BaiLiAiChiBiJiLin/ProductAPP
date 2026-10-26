//! Prefer complete visible vector outlines only when they cover the artwork.
//! Image clips remain the conservative fallback, never a little hanging hole.

use super::{cross, has_self_intersection, on_segment, polygon_area, svg_outline::sample_path};
use tiny_skia::Transform;
use usvg::{ClipPath, Group, Node};

type Ring = Vec<[f64; 2]>;

fn append_unique(rings: &mut Vec<Ring>, candidates: &[Ring]) -> Result<(), String> {
    let mut points: usize = rings.iter().map(Vec::len).sum();
    for ring in candidates {
        if rings.contains(ring) {
            continue;
        }
        points += ring.len();
        if points > 262_144 {
            return Err("SVG 累计轮廓过于复杂，未使用不完整轮廓".into());
        }
        rings.push(ring.clone());
    }
    Ok(())
}

fn clip_rings(clip: &ClipPath, referring: Transform) -> Result<Vec<Ring>, String> {
    fn visit(group: &Group, transform: Transform, rings: &mut Vec<Ring>) -> Result<(), String> {
        for child in group.children() {
            match child {
                Node::Group(group) => visit(group, transform, rings)?,
                Node::Path(path) if path.is_visible() => {
                    append_unique(
                        rings,
                        &sample_path(path, transform.pre_concat(path.abs_transform()))?,
                    )?;
                }
                Node::Text(text) => visit(text.flattened(), transform, rings)?,
                _ => {}
            }
        }
        Ok(())
    }
    let mut rings = Vec::new();
    visit(
        clip.root(),
        referring.pre_concat(clip.transform()),
        &mut rings,
    )?;
    Ok(rings)
}

fn area(rings: &[Ring]) -> f64 {
    rings.iter().map(|ring| polygon_area(ring)).sum()
}

fn collect(
    group: &Group,
    mm: Transform,
    ancestor_clip: Option<&[Ring]>,
    rings: &mut Vec<Ring>,
    vectors: &mut Vec<Ring>,
) -> Result<(), String> {
    if group.opacity().get() == 0.0 {
        return Ok(());
    }
    // A clip intersection is contained by each constituent clip. Choosing the
    // smallest complete clip provides a conservative vector footprint without
    // decoding bitmap pixels or dropping disconnected subpaths.
    let mut local_clip: Option<Vec<Ring>> = None;
    let mut clip = group.clip_path();
    while let Some(value) = clip {
        let candidate = clip_rings(value, mm.pre_concat(group.abs_transform()))?;
        if !candidate.is_empty()
            && local_clip
                .as_ref()
                .is_none_or(|old| area(&candidate) < area(old))
        {
            local_clip = Some(candidate);
        }
        // A referenced clip uses the original referring transform, as resvg does.
        clip = value.clip_path();
    }
    let active_clip = match (ancestor_clip, local_clip.as_deref()) {
        (Some(parent), Some(local)) => Some(if area(parent) < area(local) {
            parent
        } else {
            local
        }),
        (parent, local) => parent.or(local),
    };
    for child in group.children() {
        match child {
            Node::Group(group) => collect(group, mm, active_clip, rings, vectors)?,
            Node::Path(path)
                if path.is_visible()
                    && (path.fill().is_some_and(|fill| fill.opacity().get() > 0.0)
                        || path
                            .stroke()
                            .is_some_and(|stroke| stroke.opacity().get() > 0.0)) =>
            {
                let paths = sample_path(path, mm.pre_concat(path.abs_transform()))?;
                // Candidates come from actual visible artwork, never a clip
                // definition or an element name such as a product-specific ID.
                append_unique(vectors, &paths)?;
                if let Some(clip) = active_clip.filter(|clip| area(clip) < area(&paths)) {
                    append_unique(rings, clip)?;
                } else {
                    append_unique(rings, &paths)?;
                }
            }
            Node::Image(image) if image.is_visible() => {
                if let Some(clip) = active_clip {
                    append_unique(rings, clip)?;
                } else {
                    let bounds = image.abs_bounding_box();
                    append_unique(
                        rings,
                        &[vec![
                            [
                                bounds.left() as f64 * mm.sx as f64,
                                bounds.top() as f64 * mm.sy as f64,
                            ],
                            [
                                bounds.right() as f64 * mm.sx as f64,
                                bounds.top() as f64 * mm.sy as f64,
                            ],
                            [
                                bounds.right() as f64 * mm.sx as f64,
                                bounds.bottom() as f64 * mm.sy as f64,
                            ],
                            [
                                bounds.left() as f64 * mm.sx as f64,
                                bounds.bottom() as f64 * mm.sy as f64,
                            ],
                        ]],
                    )?;
                }
            }
            Node::Text(text) => collect(text.flattened(), mm, active_clip, rings, vectors)?,
            _ => {}
        }
    }
    Ok(())
}

fn contains(ring: &[[f64; 2]], point: [f64; 2]) -> bool {
    let mut inside = false;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        if on_segment(a, b, point) {
            return true;
        }
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    inside
}

fn encloses(outer: &[[f64; 2]], inner: &[[f64; 2]]) -> bool {
    inner.iter().enumerate().all(|(i, &a)| {
        let b = inner[(i + 1) % inner.len()];
        contains(outer, a)
            && contains(outer, [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0])
            && outer.iter().enumerate().all(|(j, &c)| {
                let d = outer[(j + 1) % outer.len()];
                // Proper crossings reveal an edge spanning a concave notch.
                !(cross(a, b, c) * cross(a, b, d) < -1e-12
                    && cross(c, d, a) * cross(c, d, b) < -1e-12)
            })
    })
}

fn convex_envelope(rings: &[Ring]) -> Ring {
    let mut points: Vec<_> = rings.iter().flatten().copied().collect();
    points.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    points.dedup();
    let mut hull = Vec::new();
    for &p in &points {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(p);
    }
    let lower = hull.len();
    for &p in points.iter().rev().skip(1) {
        while hull.len() > lower && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(p);
    }
    hull.pop();
    hull
}

// SVG viewports clip artwork at their edges. Intersect each support ring with
// that frame rather than rejecting an off-canvas part that is never displayed.
fn clip_to_frame(mut ring: Ring, width: f64, height: f64) -> Ring {
    for (axis, bound, keep_greater) in [
        (0, 0., true),
        (0, width, false),
        (1, 0., true),
        (1, height, false),
    ] {
        if ring.is_empty() {
            break;
        }
        let inside = |point: [f64; 2]| {
            if keep_greater {
                point[axis] >= bound
            } else {
                point[axis] <= bound
            }
        };
        let mut clipped = Vec::new();
        let mut previous = *ring.last().unwrap();
        for current in ring {
            if inside(current) != inside(previous) {
                let t = (bound - previous[axis]) / (current[axis] - previous[axis]);
                let mut intersection = [
                    previous[0] + t * (current[0] - previous[0]),
                    previous[1] + t * (current[1] - previous[1]),
                ];
                intersection[axis] = bound;
                clipped.push(intersection);
            }
            if inside(current) {
                clipped.push(current);
            }
            previous = current;
        }
        clipped.dedup();
        if clipped.first() == clipped.last() {
            clipped.pop();
        }
        ring = clipped;
    }
    ring
}

const VERIFY_PIXELS_PER_MM: f64 = 8.0;
const MAX_VERIFY_PIXELS: f64 = 4_194_304.0;
const MAX_DECODE_PIXELS: f64 = 16_777_216.0;
const MAX_VECTOR_CROSS_CHECKS: usize = 4_194_304;
// Covers curve sampling (0.03 mm) and thin cut-line antialiasing, without
// borrowing the configured picture spacing as permission to overlap artwork.
const VERIFY_EDGE_TOLERANCE_MM: f64 = 0.1;
// At alpha 1/255, some PNG exporters leave isolated quantization specks in
// otherwise transparent margins. Bound their total support to 1 mm² AND 0.1%
// of visible samples; alpha 2+ and substantial faint images are never ignored.
const MAX_QUANTIZATION_NOISE_PIXELS: usize = (VERIFY_PIXELS_PER_MM * VERIFY_PIXELS_PER_MM) as usize;

#[derive(Default)]
struct RenderBudget {
    decoded_pixels: f64,
    layer_pixels: f64,
    nodes: usize,
    images: usize,
}

fn simple_clip_tree(group: &Group, budget: &mut RenderBudget) -> bool {
    if group.clip_path().is_some() || group.mask().is_some() || !group.filters().is_empty() {
        return false;
    }
    for node in group.children() {
        budget.nodes += 1;
        if budget.nodes > 4096 {
            return false;
        }
        match node {
            Node::Group(child) if !simple_clip_tree(child, budget) => return false,
            Node::Text(text) if !simple_clip_tree(text.flattened(), budget) => return false,
            _ => {}
        }
    }
    true
}

fn can_verify_render(group: &Group, transform: Transform, budget: &mut RenderBudget) -> bool {
    if group.opacity().get() == 0.0 {
        return true;
    }
    // Filters, masks, patterns and embedded SVGs can allocate additional
    // offscreen surfaces. Unknown costs keep the existing safe footprint.
    if !group.filters().is_empty() || group.mask().is_some() {
        return false;
    }
    if group.should_isolate() {
        let Some(bounds) = group.abs_layer_bounding_box().transform(transform) else {
            return false;
        };
        // Isolated group, clip mask and clipping scratch image. Accumulating
        // all groups is conservative even when their lifetimes do not overlap.
        let mut clip = group.clip_path();
        let mut clips = 0;
        while let Some(value) = clip {
            clips += 1;
            if clips > 4 || !simple_clip_tree(value.root(), budget) {
                return false;
            }
            clip = value.clip_path();
        }
        budget.layer_pixels += (bounds.width().ceil() as f64 + 4.0)
            * (bounds.height().ceil() as f64 + 4.0)
            * (1.0 + clips as f64 * 2.0);
        if budget.layer_pixels > MAX_VERIFY_PIXELS * 4.0 {
            return false;
        }
    }
    for node in group.children() {
        budget.nodes += 1;
        if budget.nodes > 4096 {
            return false;
        }
        match node {
            Node::Group(child) => {
                if !can_verify_render(child, transform, budget) {
                    return false;
                }
            }
            Node::Text(text) => {
                if !can_verify_render(text.flattened(), transform, budget) {
                    return false;
                }
            }
            Node::Path(path) if path.is_visible() => {
                if path
                    .fill()
                    .is_some_and(|fill| matches!(fill.paint(), usvg::Paint::Pattern(_)))
                    || path
                        .stroke()
                        .is_some_and(|stroke| matches!(stroke.paint(), usvg::Paint::Pattern(_)))
                {
                    return false;
                }
            }
            Node::Image(image) if image.is_visible() => {
                budget.images += 1;
                budget.decoded_pixels += image.size().width() as f64 * image.size().height() as f64;
                if budget.decoded_pixels > MAX_DECODE_PIXELS {
                    return false;
                }
                // PNG is the alpha-bearing format used by imported SVGs. Check
                // with the same decoder as resvg, which otherwise silently skips
                // a broken bitmap and could falsely approve a tiny cut path.
                let usvg::ImageKind::PNG(data) = image.kind() else {
                    return false;
                };
                if tiny_skia::Pixmap::decode_png(data).is_err() {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

fn rendered_artwork_fits(tree: &usvg::Tree, outline: &Ring, width_mm: f64, height_mm: f64) -> bool {
    let width = (width_mm * VERIFY_PIXELS_PER_MM).ceil();
    let height = (height_mm * VERIFY_PIXELS_PER_MM).ceil();
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width * height > MAX_VERIFY_PIXELS
        || width > 8192.0
        || height > 8192.0
    {
        return false;
    }
    let transform = Transform::from_scale(
        (width_mm * VERIFY_PIXELS_PER_MM) as f32 / tree.size().width(),
        (height_mm * VERIFY_PIXELS_PER_MM) as f32 / tree.size().height(),
    );
    let mut budget = RenderBudget::default();
    if !can_verify_render(tree.root(), transform, &mut budget) || budget.images == 0 {
        return false;
    }
    let Some(mut artwork) = tiny_skia::Pixmap::new(width as u32, height as u32) else {
        return false;
    };
    resvg::render(tree, transform, &mut artwork.as_mut());
    let mut builder = tiny_skia::PathBuilder::new();
    for (index, point) in outline.iter().enumerate() {
        let x = (point[0] * VERIFY_PIXELS_PER_MM) as f32;
        let y = (point[1] * VERIFY_PIXELS_PER_MM) as f32;
        if index == 0 {
            builder.move_to(x, y);
        } else {
            builder.line_to(x, y);
        }
    }
    builder.close();
    let Some(path) = builder.finish() else {
        return false;
    };
    let Some(mut coverage) = tiny_skia::Pixmap::new(width as u32, height as u32) else {
        return false;
    };
    // The source renderer antialiases edges. Its boundary pixels represent an
    // intersected pixel cell, so coverage must use the same convention instead
    // of testing only a hard-edged pixel center and rejecting valid cut lines.
    let paint = tiny_skia::Paint::default();
    coverage.fill_path(
        &path,
        &paint,
        tiny_skia::FillRule::Winding,
        Transform::identity(),
        None,
    );
    coverage.stroke_path(
        &path,
        &paint,
        &tiny_skia::Stroke {
            width: (VERIFY_EDGE_TOLERANCE_MM * 2.0 * VERIFY_PIXELS_PER_MM) as f32,
            line_join: tiny_skia::LineJoin::Round,
            ..Default::default()
        },
        Transform::identity(),
        None,
    );
    raster_coverage_fits(&artwork, &coverage)
}

fn raster_coverage_fits(artwork: &tiny_skia::Pixmap, coverage: &tiny_skia::Pixmap) -> bool {
    let mut visible = 0usize;
    let mut quantization_noise = 0usize;
    for (pixel, cover) in artwork.pixels().iter().zip(coverage.pixels()) {
        if pixel.alpha() > 0 {
            visible += 1;
            if cover.alpha() == 0 {
                if pixel.alpha() > 1 {
                    return false;
                }
                quantization_noise += 1;
                if quantization_noise > MAX_QUANTIZATION_NOISE_PIXELS {
                    return false;
                }
            }
        }
    }
    visible > 0 && quantization_noise <= visible / 1000
}

fn verified_vector_outline(
    tree: &usvg::Tree,
    vectors: &[Ring],
    fallback: &Ring,
    width_mm: f64,
    height_mm: f64,
) -> Option<Ring> {
    let fallback_area = polygon_area(fallback);
    // An enclosing vector must contain every other visible vector. Start at
    // the largest; if it cannot contain the bitmap, a nested smaller one cannot.
    let candidate = vectors.first()?;
    if candidate.len() > 2048
        || polygon_area(candidate) <= 1e-8
        || polygon_area(candidate) >= fallback_area - 1e-6
        || candidate
            .len()
            .saturating_mul(vectors.iter().map(Vec::len).sum())
            > MAX_VECTOR_CROSS_CHECKS
        || has_self_intersection(candidate)
        || !vectors.iter().skip(1).all(|ring| encloses(candidate, ring))
    {
        return None;
    }
    rendered_artwork_fits(tree, candidate, width_mm, height_mm).then(|| candidate.clone())
}

pub fn extract(tree: &usvg::Tree, width_mm: f64, height_mm: f64) -> Result<Ring, String> {
    let mm = Transform::from_scale(
        width_mm as f32 / tree.size().width(),
        height_mm as f32 / tree.size().height(),
    );
    let mut rings = Vec::new();
    let mut vectors = Vec::new();
    collect(tree.root(), mm, None, &mut rings, &mut vectors)?;
    let mut rings: Vec<_> = rings
        .into_iter()
        .map(|ring| clip_to_frame(ring, width_mm, height_mm))
        // Signed area can cancel on visible self-crossing paths. Their support
        // still belongs in the envelope; never drop it and keep only a hole.
        .filter(|ring| ring.len() >= 3)
        .collect();
    rings.sort_by(|a, b| polygon_area(b).total_cmp(&polygon_area(a)));
    rings.dedup();
    let mut vectors: Vec<_> = vectors
        .into_iter()
        .map(|ring| clip_to_frame(ring, width_mm, height_mm))
        .filter(|ring| ring.len() >= 3)
        .collect();
    vectors.sort_by(|a, b| polygon_area(b).total_cmp(&polygon_area(a)));
    vectors.dedup();
    let largest = rings
        .first()
        .ok_or("SVG 中没有可用于异形拼版的闭合路径或图片裁剪轮廓")?;
    let fallback = if largest.len() <= 2048
        && polygon_area(largest) > 1e-8
        && !has_self_intersection(largest)
        && rings.iter().skip(1).all(|ring| encloses(largest, ring))
    {
        largest.clone()
    } else {
        convex_envelope(&rings)
    };
    // Some files omit the outer cut path but contain a clipped figure plus a
    // separate hanging-hole ring. One contour cannot represent disconnected
    // pieces: enclose all components instead of keeping only the little hole.
    // Complete enclosing cut paths keep their original concavities above.
    Ok(verified_vector_outline(tree, &vectors, &fallback, width_mm, height_mm).unwrap_or(fallback))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    const IMAGE: &str = r#"<image width="20" height="20" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rCkAAAAASUVORK5CYII="/>"#;

    fn footprint(svg: &str) -> Ring {
        let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap();
        extract(&tree, 30.0, 30.0).unwrap()
    }

    fn transparent_artwork(concave: bool) -> String {
        let mut pixmap = tiny_skia::Pixmap::new(30, 30).unwrap();
        for y in 3..23 {
            for x in 3..23 {
                if !concave || x < 9 || y < 9 {
                    pixmap.pixels_mut()[y * 30 + x] =
                        tiny_skia::PremultipliedColorU8::from_rgba(255, 0, 0, 255).unwrap();
                }
            }
        }
        format!(
            r#"<image width="30" height="30" href="data:image/png;base64,{}"/>"#,
            base64::engine::general_purpose::STANDARD.encode(pixmap.encode_png().unwrap())
        )
    }

    #[test]
    fn transparent_image_clip_does_not_expand_a_complete_concave_cut() {
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><defs><clipPath id="bitmap-frame"><rect width="30" height="30"/></clipPath></defs><g clip-path="url(#bitmap-frame)">{}</g><path id="arbitrary-cut-name" d="M2 2H24V10H10V24H2Z" fill="none" stroke="red" stroke-width=".05"/><circle cx="5" cy="5" r="1" fill="none" stroke="red" stroke-width=".05"/></svg>"##,
            transparent_artwork(true)
        );
        let ring = footprint(&svg);
        assert!(
            (polygon_area(&ring) - 288.0).abs() < 1e-5,
            "{}",
            polygon_area(&ring)
        );
        assert!(!contains(&ring, [20., 20.]));
        assert!(contains(&ring, [5., 20.]));
    }

    #[test]
    fn missing_or_incomplete_cut_never_replaces_the_bitmap_with_a_hole() {
        for clipped in [false, true] {
            for outline in [
                r#"<circle cx="5" cy="5" r="1" fill="none" stroke="red"/>"#,
                r#"<path d="M2 2H24V10H10V24H2Z" fill="none" stroke="red" stroke-width=".05"/>"#,
            ] {
                let svg = format!(
                    r##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><defs><clipPath id="bitmap-frame"><rect width="30" height="30"/></clipPath></defs><g {}>{}</g>{outline}</svg>"##,
                    if clipped {
                        r##"clip-path="url(#bitmap-frame)""##
                    } else {
                        ""
                    },
                    transparent_artwork(false)
                );
                let ring = footprint(&svg);
                assert!(
                    contains(&ring, [20., 20.]),
                    "clipped={clipped}, area={}",
                    polygon_area(&ring)
                );
            }
        }
    }

    #[test]
    fn faint_artwork_and_disconnected_vectors_are_not_silently_dropped() {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><g opacity=".01">{}</g><circle cx="5" cy="5" r="1" fill="none" stroke="red"/></svg>"#,
            transparent_artwork(false)
        );
        assert!(contains(&footprint(&svg), [20., 20.]));
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30">{}<path d="M2 2H24V10H10V24H2Z" fill="none" stroke="red" stroke-width=".05"/><rect x="25" y="25" width="2" height="2"/></svg>"#,
            transparent_artwork(true)
        );
        assert!(contains(&footprint(&svg), [26., 26.]));
    }

    #[test]
    fn exceeding_the_render_budget_keeps_the_safe_bitmap_frame() {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30">{}<path d="M2 2H24V10H10V24H2Z" fill="none" stroke="red" stroke-width=".05"/></svg>"#,
            transparent_artwork(true)
        );
        let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).unwrap();
        let ring = extract(&tree, 3000.0, 3000.0).unwrap();
        assert!((polygon_area(&ring) - 9_000_000.0).abs() < 1e-5);
    }

    #[test]
    fn malformed_png_cannot_make_a_hanging_hole_look_like_the_whole_product() {
        let mut pixmap = tiny_skia::Pixmap::new(30, 30).unwrap();
        pixmap.fill(tiny_skia::Color::WHITE);
        let mut png = pixmap.encode_png().unwrap();
        let idat = png.windows(4).position(|bytes| bytes == b"IDAT").unwrap();
        png[idat + 4] ^= 0xff;
        assert!(tiny_skia::Pixmap::decode_png(&png).is_err());
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><image width="30" height="30" href="data:image/png;base64,{}"/><circle cx="5" cy="5" r="1" fill="none" stroke="red"/></svg>"#,
            base64::engine::general_purpose::STANDARD.encode(png)
        );
        assert!(contains(&footprint(&svg), [20., 20.]));
    }

    #[test]
    fn alpha_quantization_noise_has_a_small_budget_but_translucent_artwork_does_not() {
        let mut artwork = tiny_skia::Pixmap::new(400, 400).unwrap();
        let mut coverage = tiny_skia::Pixmap::new(400, 400).unwrap();
        artwork.fill(tiny_skia::Color::WHITE);
        coverage.fill(tiny_skia::Color::WHITE);
        for index in 0..64 {
            artwork.pixels_mut()[index] =
                tiny_skia::PremultipliedColorU8::from_rgba(1, 0, 0, 1).unwrap();
            coverage.pixels_mut()[index] = tiny_skia::PremultipliedColorU8::TRANSPARENT;
        }
        assert!(raster_coverage_fits(&artwork, &coverage));
        artwork.pixels_mut()[0] = tiny_skia::PremultipliedColorU8::from_rgba(2, 0, 0, 2).unwrap();
        assert!(!raster_coverage_fits(&artwork, &coverage));
        artwork.pixels_mut()[0] = tiny_skia::PremultipliedColorU8::from_rgba(1, 0, 0, 1).unwrap();
        artwork.pixels_mut()[64] = tiny_skia::PremultipliedColorU8::from_rgba(1, 0, 0, 1).unwrap();
        coverage.pixels_mut()[64] = tiny_skia::PremultipliedColorU8::TRANSPARENT;
        assert!(!raster_coverage_fits(&artwork, &coverage));
        artwork.fill(tiny_skia::Color::from_rgba8(0, 0, 0, 1));
        coverage.fill(tiny_skia::Color::TRANSPARENT);
        assert!(!raster_coverage_fits(&artwork, &coverage));
    }

    #[test]
    #[ignore = "set PRINTFLOW_FOOTPRINT_JOB to a local JSON job to verify real source SVGs"]
    fn real_svg_job_preserves_available_cut_contours() {
        let input =
            std::env::var_os("PRINTFLOW_FOOTPRINT_JOB").expect("explicit source job required");
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
        let images = record["images"].as_array().unwrap();
        let mut output = Vec::new();
        let mut preserved_concave = 0;
        for (index, image) in images.iter().enumerate() {
            let started = std::time::Instant::now();
            let data = std::fs::read(image["filePath"].as_str().unwrap()).unwrap();
            let tree = usvg::Tree::from_data(&data, &crate::assets::options()).unwrap();
            let width = image["widthMm"].as_f64().unwrap();
            let height = image["heightMm"].as_f64().unwrap();
            let polygon = extract(&tree, width, height).unwrap();
            let mut supports = Vec::new();
            let mut vectors = Vec::new();
            collect(
                tree.root(),
                Transform::from_scale(
                    width as f32 / tree.size().width(),
                    height as f32 / tree.size().height(),
                ),
                None,
                &mut supports,
                &mut vectors,
            )
            .unwrap();
            let largest_vector = vectors
                .iter()
                .map(|ring| polygon_area(ring))
                .fold(0.0, f64::max);
            let area = polygon_area(&polygon);
            let matches_vector = largest_vector > 0.0 && (area - largest_vector).abs() < 0.01;
            if matches_vector
                && polygon_area(&convex_envelope(std::slice::from_ref(&polygon))) > area * 1.001
            {
                preserved_concave += 1;
            }
            eprintln!("source={index} area_mm2={area:.3} largest_vector_mm2={largest_vector:.3} preserves_vector={matches_vector} elapsed_ms={}", started.elapsed().as_millis());
            assert!(!has_self_intersection(&polygon));
            output.push(serde_json::json!({"id":image["id"], "polygon": polygon}));
        }
        let required: usize = std::env::var("PRINTFLOW_FOOTPRINT_EXPECT_CONCAVE")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1);
        assert!(
            preserved_concave >= required,
            "retained {preserved_concave} concave vector outlines; required {required}"
        );
        if let Some(path) = std::env::var_os("PRINTFLOW_FOOTPRINT_OUTPUT") {
            std::fs::write(path, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        }
    }

    #[test]
    fn disjoint_shapes_are_both_reserved_and_complete_concave_outline_stays_concave() {
        let ring = footprint(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M1 1H5V5H1Z M20 20H25V25H20Z"/></svg>"#,
        );
        for p in [[1., 1.], [5., 5.], [20., 20.], [25., 25.]] {
            assert!(contains(&ring, p));
        }
        let ring = footprint(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M1 1H25V10H10V25H1Z" fill="none" stroke="red"/><circle cx="5" cy="5" r="1" fill="none" stroke="red"/></svg>"#,
        );
        assert!(contains(&ring, [5., 20.]));
        assert!(!contains(&ring, [20., 20.]));
    }

    #[test]
    fn clip_instances_apply_group_and_object_bbox_transforms_and_ignore_unused_defs() {
        let ring = footprint(&format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><defs><clipPath id="used" transform="translate(1 2)"><path transform="translate(2 1)" d="M0 0H5V5H0Z"/></clipPath><clipPath id="unused"><rect width="30" height="30"/></clipPath></defs><g transform="translate(4 3)" clip-path="url(#used)">{IMAGE}</g><g opacity="0"><rect width="30" height="30"/></g></svg>"##
        ));
        assert!((polygon_area(&ring) - 25.).abs() < 1e-6);
        assert!(contains(&ring, [7., 6.]));
        assert!(contains(&ring, [12., 11.]));
        assert!(!contains(&ring, [1., 1.]));
        let ring = footprint(&format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><defs><clipPath id="used" clipPathUnits="objectBoundingBox"><path d="M.25 .25H.75V.75H.25Z"/></clipPath></defs><g clip-path="url(#used)">{IMAGE}</g></svg>"##
        ));
        assert!((polygon_area(&ring) - 100.).abs() < 1e-5);
        assert!(contains(&ring, [5., 5.]));
        assert!(contains(&ring, [15., 15.]));
        assert!(!contains(&ring, [1., 1.]));
    }

    #[test]
    fn multiple_clipped_figures_never_discard_a_disconnected_piece() {
        let ring = footprint(&format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><defs><clipPath id="used"><path d="M1 1H5V5H1Z M15 15H19V19H15Z"/></clipPath></defs><g clip-path="url(#used)">{IMAGE}</g></svg>"##
        ));
        assert!(contains(&ring, [1., 1.]));
        assert!(contains(&ring, [19., 19.]));
        assert!(polygon_area(&ring) > 32.);
    }

    #[test]
    fn viewport_clipping_and_self_crossings_never_reduce_artwork_to_a_hole() {
        let ring = footprint(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><path d="M-10 -10L25 25L-10 25L25 -10Z"/><circle cx="26" cy="26" r="1"/></svg>"#,
        );
        assert!(contains(&ring, [0., 0.]));
        assert!(contains(&ring, [25., 25.]));
        assert!(contains(&ring, [0., 25.]));
        assert!(ring
            .iter()
            .all(|p| p[0] >= 0. && p[1] >= 0. && p[0] <= 30. && p[1] <= 30.));
        assert!(!has_self_intersection(&ring));
    }
}
