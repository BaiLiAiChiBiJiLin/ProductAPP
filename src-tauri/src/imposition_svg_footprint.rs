//! Occupied geometry must include image clips, not merely printable strokes.
//! A hanging-hole circle alone is never the outline of the clipped artwork.

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
            Node::Group(group) => collect(group, mm, active_clip, rings)?,
            Node::Path(path)
                if path.is_visible()
                    && (path.fill().is_some_and(|fill| fill.opacity().get() > 0.0)
                        || path
                            .stroke()
                            .is_some_and(|stroke| stroke.opacity().get() > 0.0)) =>
            {
                let paths = sample_path(path, mm.pre_concat(path.abs_transform()))?;
                if let Some(clip) = active_clip.filter(|clip| area(clip) < area(&paths)) {
                    append_unique(rings, clip)?;
                } else {
                    append_unique(rings, &paths)?;
                }
            }
            Node::Image(image) if image.is_visible() => {
                if let Some(clip) = active_clip {
                    append_unique(rings, clip)?;
                }
                // Unclipped bitmap artwork continues to use its explicit SVG
                // cut outline; an image rectangle is not a product silhouette.
            }
            Node::Text(text) => collect(text.flattened(), mm, active_clip, rings)?,
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

pub fn extract(tree: &usvg::Tree, width_mm: f64, height_mm: f64) -> Result<Ring, String> {
    let mm = Transform::from_scale(
        width_mm as f32 / tree.size().width(),
        height_mm as f32 / tree.size().height(),
    );
    let mut rings = Vec::new();
    collect(tree.root(), mm, None, &mut rings)?;
    let mut rings: Vec<_> = rings
        .into_iter()
        .map(|ring| clip_to_frame(ring, width_mm, height_mm))
        // Signed area can cancel on visible self-crossing paths. Their support
        // still belongs in the envelope; never drop it and keep only a hole.
        .filter(|ring| ring.len() >= 3)
        .collect();
    rings.sort_by(|a, b| polygon_area(b).total_cmp(&polygon_area(a)));
    rings.dedup();
    let largest = rings
        .first()
        .ok_or("SVG 中没有可用于异形拼版的闭合路径或图片裁剪轮廓")?;
    if largest.len() <= 2048
        && polygon_area(largest) > 1e-8
        && !has_self_intersection(largest)
        && rings.iter().skip(1).all(|ring| encloses(largest, ring))
    {
        return Ok(largest.clone());
    }
    // Some files omit the outer cut path but contain a clipped figure plus a
    // separate hanging-hole ring. One contour cannot represent disconnected
    // pieces: enclose all components instead of keeping only the little hole.
    // Complete enclosing cut paths keep their original concavities above.
    Ok(convex_envelope(&rings))
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMAGE: &str = r#"<image width="20" height="20" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rCkAAAAASUVORK5CYII="/>"#;

    fn footprint(svg: &str) -> Ring {
        let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap();
        extract(&tree, 30.0, 30.0).unwrap()
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
