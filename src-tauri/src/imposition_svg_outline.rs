//! Bounded SVG curve sampling in final millimetre coordinates.
//!
//! The caller supplies the complete transform, including any referring group
//! and clip-path transforms. A clip subtree's absolute transform alone does
//! not include the transform of the artwork that references it.

use tiny_skia::{PathSegment, Transform};

const CURVE_TOLERANCE_MM: f64 = 0.03;
const MAX_INTERMEDIATE_POINTS: usize = 65_536;
const MAX_RING_POINTS: usize = 4_096;
const MAX_CURVE_DEPTH: usize = 32;
const POINT_EPSILON_MM: f64 = 1e-9;

type Point = [f64; 2];

fn distance_to_segment(point: Point, start: Point, end: Point) -> f64 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let length_squared = dx * dx + dy * dy;
    if length_squared == 0.0 {
        return (point[0] - start[0]).hypot(point[1] - start[1]);
    }
    let t = (((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared)
        .clamp(0.0, 1.0);
    (point[0] - start[0] - t * dx).hypot(point[1] - start[1] - t * dy)
}

fn midpoint(left: Point, right: Point) -> Point {
    [
        left[0] * 0.5 + right[0] * 0.5,
        left[1] * 0.5 + right[1] * 0.5,
    ]
}

fn same_point(left: Point, right: Point) -> bool {
    (left[0] - right[0]).hypot(left[1] - right[1]) <= POINT_EPSILON_MM
}

struct Sampler {
    emitted: usize,
}

impl Sampler {
    fn push(&mut self, points: &mut Vec<Point>, point: Point) -> Result<(), String> {
        if point.iter().any(|value| !value.is_finite()) {
            return Err("SVG 轮廓变换后包含无效坐标".into());
        }
        self.emitted += 1;
        if self.emitted > MAX_INTERMEDIATE_POINTS {
            return Err(format!(
                "SVG 曲线采样超过安全上限（{MAX_INTERMEDIATE_POINTS} 点），未使用不完整轮廓"
            ));
        }
        points.push(point);
        Ok(())
    }

    fn quadratic(
        &mut self,
        points: &mut Vec<Point>,
        curve: [Point; 3],
        depth: usize,
    ) -> Result<(), String> {
        let [start, control, end] = curve;
        if distance_to_segment(control, start, end) <= CURVE_TOLERANCE_MM {
            return self.push(points, end);
        }
        if depth >= MAX_CURVE_DEPTH {
            return Err("SVG 曲线过于复杂，无法在允许误差内提取完整轮廓".into());
        }
        let left = midpoint(start, control);
        let right = midpoint(control, end);
        let centre = midpoint(left, right);
        self.quadratic(points, [start, left, centre], depth + 1)?;
        self.quadratic(points, [centre, right, end], depth + 1)
    }

    fn cubic(
        &mut self,
        points: &mut Vec<Point>,
        curve: [Point; 4],
        depth: usize,
    ) -> Result<(), String> {
        let [start, control_a, control_b, end] = curve;
        if distance_to_segment(control_a, start, end) <= CURVE_TOLERANCE_MM
            && distance_to_segment(control_b, start, end) <= CURVE_TOLERANCE_MM
        {
            return self.push(points, end);
        }
        if depth >= MAX_CURVE_DEPTH {
            return Err("SVG 曲线过于复杂，无法在允许误差内提取完整轮廓".into());
        }
        let left = midpoint(start, control_a);
        let middle = midpoint(control_a, control_b);
        let right = midpoint(control_b, end);
        let left_middle = midpoint(left, middle);
        let right_middle = midpoint(middle, right);
        let centre = midpoint(left_middle, right_middle);
        self.cubic(points, [start, left, left_middle, centre], depth + 1)?;
        self.cubic(points, [centre, right_middle, right, end], depth + 1)
    }
}

fn finish_ring(
    points: &mut Vec<Point>,
    rings: &mut Vec<Vec<Point>>,
    closed: bool,
) -> Result<(), String> {
    if !closed {
        points.clear();
        return Ok(());
    }
    let mut ring = Vec::with_capacity(points.len());
    for point in points.drain(..) {
        if ring.last().is_some_and(|last| same_point(*last, point)) {
            continue;
        }
        // Remove redundant points only when they lie on the replacement
        // segment. Collinear backtracking can contain real curve extrema.
        while ring.len() >= 2
            && distance_to_segment(ring[ring.len() - 1], ring[ring.len() - 2], point)
                <= POINT_EPSILON_MM
        {
            ring.pop();
        }
        ring.push(point);
    }
    if ring.len() > 1 && same_point(ring[0], *ring.last().unwrap()) {
        ring.pop();
    }
    // Simplify the cyclic seam as well as the sequential portion. Removal
    // here is bounded by the original point count, with no quadratic scan.
    while ring.len() >= 3 {
        if distance_to_segment(ring[ring.len() - 1], ring[ring.len() - 2], ring[0])
            <= POINT_EPSILON_MM
        {
            ring.pop();
        } else {
            break;
        }
    }
    let mut first = 0;
    while ring.len().saturating_sub(first) >= 3
        && distance_to_segment(ring[first], *ring.last().unwrap(), ring[first + 1])
            <= POINT_EPSILON_MM
    {
        first += 1;
    }
    if first > 0 {
        ring.drain(..first);
    }
    if ring.len() > MAX_RING_POINTS {
        return Err(format!(
            "SVG 轮廓简化后仍超过安全上限（{MAX_RING_POINTS} 点），未使用不完整轮廓"
        ));
    }
    if ring.len() >= 3 {
        rings.push(ring);
    }
    Ok(())
}

/// Sample each closed subpath using a complete transform into millimetres.
/// Filled open subpaths are implicitly closed, matching SVG fill semantics;
/// open stroke-only subpaths do not describe a safe enclosing polygon.
pub(super) fn sample_path(
    path: &usvg::Path,
    final_transform: Transform,
) -> Result<Vec<Vec<Point>>, String> {
    let map = |point: tiny_skia::Point| -> Result<Point, String> {
        // Apply the f32 SVG matrix using f64 arithmetic so subdivision and
        // small tolerances remain stable with large source viewBox offsets.
        let x = point.x as f64;
        let y = point.y as f64;
        let point = [
            final_transform.sx as f64 * x
                + final_transform.kx as f64 * y
                + final_transform.tx as f64,
            final_transform.ky as f64 * x
                + final_transform.sy as f64 * y
                + final_transform.ty as f64,
        ];
        if point.iter().any(|value| !value.is_finite()) {
            return Err("SVG 轮廓变换后包含无效坐标".into());
        }
        Ok(point)
    };
    let mut sampler = Sampler { emitted: 0 };
    let mut rings = Vec::new();
    let mut points = Vec::new();
    let mut current = [0.0, 0.0];
    let mut start = current;
    let fill_closes_path = path.fill().is_some();
    for segment in path.data().segments() {
        match segment {
            PathSegment::MoveTo(point) => {
                finish_ring(&mut points, &mut rings, fill_closes_path)?;
                current = map(point)?;
                start = current;
                sampler.push(&mut points, current)?;
            }
            PathSegment::LineTo(point) => {
                if points.is_empty() {
                    sampler.push(&mut points, current)?;
                }
                current = map(point)?;
                sampler.push(&mut points, current)?;
            }
            PathSegment::QuadTo(control, point) => {
                if points.is_empty() {
                    sampler.push(&mut points, current)?;
                }
                let end = map(point)?;
                sampler.quadratic(&mut points, [current, map(control)?, end], 0)?;
                current = end;
            }
            PathSegment::CubicTo(control_a, control_b, point) => {
                if points.is_empty() {
                    sampler.push(&mut points, current)?;
                }
                let end = map(point)?;
                sampler.cubic(
                    &mut points,
                    [current, map(control_a)?, map(control_b)?, end],
                    0,
                )?;
                current = end;
            }
            PathSegment::Close => {
                finish_ring(&mut points, &mut rings, true)?;
                current = start;
            }
        }
    }
    finish_ring(&mut points, &mut rings, fill_closes_path)?;
    Ok(rings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_path(group: &usvg::Group) -> &usvg::Path {
        for node in group.children() {
            match node {
                usvg::Node::Path(path) => return path,
                usvg::Node::Group(group) => return first_path(group),
                _ => {}
            }
        }
        panic!("test SVG has no path");
    }

    fn sample(data: &str, attrs: &str) -> Result<Vec<Vec<Point>>, String> {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="{data}" {attrs}/></svg>"#
        );
        let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).unwrap();
        sample_path(first_path(tree.root()), Transform::identity())
    }

    #[test]
    fn dense_collinear_paths_keep_the_complete_ring() {
        let mut data = String::from("M0 0");
        for index in 1..=6_000 {
            data.push_str(&format!("L{} 0", index as f64 / 100.0));
        }
        data.push_str("L60 10L0 10Z");
        let rings = sample(&data, "").unwrap();
        assert_eq!(
            rings,
            vec![vec![[0.0, 0.0], [60.0, 0.0], [60.0, 10.0], [0.0, 10.0]]]
        );
    }

    #[test]
    fn excessive_non_collinear_ring_errors_instead_of_truncating() {
        let mut data = String::from("M0 0");
        for index in 1..=5_000 {
            data.push_str(&format!("L{} {}", index as f64 / 100.0, index % 2));
        }
        data.push_str("L50 10L0 10Z");
        assert!(sample(&data, "").unwrap_err().contains("4096"));
    }

    #[test]
    fn quadratic_and_cubic_extrema_survive_sampling() {
        let rings = sample(
            "M0 0Q5 10 10 0L10 -1L0 -1Z M20 0C20 20 30 20 30 0L30 -1L20 -1Z",
            "",
        )
        .unwrap();
        assert_eq!(rings.len(), 2);
        let quadratic_max = rings[0]
            .iter()
            .map(|p| p[1])
            .fold(f64::NEG_INFINITY, f64::max);
        let cubic_max = rings[1]
            .iter()
            .map(|p| p[1])
            .fold(f64::NEG_INFINITY, f64::max);
        assert!((quadratic_max - 5.0).abs() <= CURVE_TOLERANCE_MM);
        assert!((cubic_max - 15.0).abs() <= CURVE_TOLERANCE_MM);
        assert!(rings[1].contains(&[20.0, -1.0]));
    }

    #[test]
    fn collinear_bezier_overshoot_is_not_reduced_to_its_endpoints() {
        let rings = sample("M0 0C30 0 30 0 10 0L10 10L0 10Z", "").unwrap();
        let maximum = rings[0]
            .iter()
            .map(|p| p[0])
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(maximum > 23.0, "lost collinear curve maximum: {maximum}");
    }

    #[test]
    fn only_filled_open_subpaths_are_implicitly_closed() {
        assert_eq!(sample("M0 0L10 0L0 10", "").unwrap().len(), 1);
        assert!(sample("M0 0L10 0L0 10", r#"fill="none" stroke="black""#)
            .unwrap()
            .is_empty());
        let rings = sample(
            "M0 0L10 0L0 10Z M20 0L30 0L20 10Z",
            r#"fill="none" stroke="black""#,
        )
        .unwrap();
        assert_eq!(rings.len(), 2);
        assert_eq!(rings[1], vec![[20.0, 0.0], [30.0, 0.0], [20.0, 10.0]]);
    }

    #[test]
    fn complete_clip_transform_includes_its_referring_group() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><clipPath id="c" transform="translate(2 3)"><path transform="translate(4 5)" d="M0 0H5V5H0Z"/></clipPath></defs><g transform="translate(10 20) scale(2)" clip-path="url(#c)"><rect width="20" height="20"/></g></svg>"##;
        let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap();
        fn clipped_group(group: &usvg::Group) -> Option<&usvg::Group> {
            if group.clip_path().is_some() {
                return Some(group);
            }
            group.children().iter().find_map(|node| match node {
                usvg::Node::Group(group) => clipped_group(group),
                _ => None,
            })
        }
        let group = clipped_group(tree.root()).unwrap();
        let clip = group.clip_path().unwrap();
        let path = first_path(clip.root());
        let transform = group
            .abs_transform()
            .pre_concat(clip.transform())
            .pre_concat(path.abs_transform());
        assert_eq!(
            sample_path(path, transform).unwrap(),
            vec![vec![[22.0, 36.0], [32.0, 36.0], [32.0, 46.0], [22.0, 46.0]]]
        );
    }
}
