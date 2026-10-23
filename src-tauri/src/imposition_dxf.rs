//! Companion cutting geometry for the already staged contour PDF page.
//! SVG transforms/viewports are normalized by usvg; DXF uses bottom-left mm.
use std::{
    fmt::Write,
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tiny_skia::{PathSegment, Point, Rect, Transform};

#[path = "imposition_dxf_format.rs"]
mod format;

type XY = [f64; 2];
// Only a subpath explicitly closed by SVG Z may snap its almost-identical end
// back to its start. This removes f32 transform noise, not real open geometry.
const CLOSURE_TOLERANCE_MM: f64 = 0.0001;

#[tauri::command]
pub async fn export_imposition_dxf(
    output: String,
    page_id: String,
    width_mm: f64,
    height_mm: f64,
) -> Result<(), String> {
    let staged = crate::staged_artwork::path(&page_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Even two parallel PDF layouts must not concurrently parse large SVGs
        // for DXF. No raster resources are decoded by this conversion.
        static CONVERT: Mutex<()> = Mutex::new(());
        let _guard = CONVERT.lock().map_err(|_| "DXF 导出调度器异常")?;
        let output = crate::imposition_pdf::checked_export_output(&output, "dxf")?;
        let svg = fs::read_to_string(staged).map_err(|e| format!("读取轮廓 SVG 失败：{e}"))?;
        let dxf = render_dxf(&svg, width_mm, height_mm)?;
        crate::imposition_pdf::commit_dxf(&output, dxf.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone)]
struct ClipRect {
    rect: Rect,
    transform: Transform,
}

struct Dxf {
    entities: String,
    count: usize,
    scale: [f64; 2],
    height: f64,
}

impl Dxf {
    fn point(&self, transform: Transform, mut point: Point) -> XY {
        transform.map_point(&mut point);
        [
            point.x as f64 * self.scale[0],
            self.height - point.y as f64 * self.scale[1],
        ]
    }

    fn entity(&mut self, kind: &str, layer: &str, subclass: &str) {
        self.count += 1;
        write!(
            self.entities,
            "0\n{kind}\n5\n{:X}\n330\n{}\n100\nAcDbEntity\n8\n{layer}\n62\n1\n100\n{subclass}\n",
            0x1000 + self.count,
            format::MODEL_SPACE
        )
        .unwrap();
    }

    fn circle(&mut self, center: XY, radius: f64) {
        self.entity("CIRCLE", "HOLES", "AcDbCircle");
        write!(
            self.entities,
            "10\n{}\n20\n{}\n30\n0\n40\n{}\n",
            n(center[0]),
            n(center[1]),
            n(radius)
        )
        .unwrap();
    }

    fn contour(&mut self, controls: &[XY], closed: bool) -> Result<(), String> {
        if controls.len() < 4 {
            return Ok(());
        }
        if (controls.len() - 1) % 3 != 0 || !controls.iter().flatten().all(|v| v.is_finite()) {
            return Err("DXF 曲线控制点无效".into());
        }
        // Each cubic SVG Bezier is exactly one degree-three B-spline span.
        // Repeated interior knots preserve corners and the original controls;
        // there is no flattening, smoothing, or curve-fitting approximation.
        let spans = (controls.len() - 1) / 3;
        self.entity("SPLINE", "CUT", "AcDbSpline");
        write!(
            self.entities,
            "210\n0\n220\n0\n230\n1\n70\n{}\n71\n3\n72\n{}\n73\n{}\n74\n0\n42\n0.0000000001\n43\n0.0000000001\n",
            8 | u8::from(closed), // planar + closed; clamped, not periodic
            controls.len() + 4,
            controls.len()
        )
        .unwrap();
        for knot in 0..=spans {
            let multiplicity = if knot == 0 || knot == spans { 4 } else { 3 };
            for _ in 0..multiplicity {
                writeln!(self.entities, "40\n{knot}").unwrap();
            }
        }
        for p in controls {
            write!(self.entities, "10\n{}\n20\n{}\n30\n0\n", n(p[0]), n(p[1])).unwrap();
        }
        Ok(())
    }

    fn path(&mut self, path: &usvg::Path, clips: &[ClipRect]) -> Result<(), String> {
        if !path.is_visible() {
            return Ok(());
        }
        for clip in clips {
            let inverse = clip
                .transform
                .invert()
                .ok_or("轮廓裁剪变换不可逆，无法导出 DXF")?;
            let data = path
                .data()
                .clone()
                .transform(inverse.pre_concat(path.abs_transform()))
                .ok_or("DXF 轮廓变换无效")?;
            let b = data.compute_tight_bounds().ok_or("DXF 轮廓边界无效")?;
            let r = clip.rect;
            // Small floating-point noise at viewport edges is harmless. A truly
            // clipped contour must not silently turn into an extra cutting line.
            let tolerance = 0.02 / self.scale[0].min(self.scale[1]);
            if (b.left() as f64) < r.left() as f64 - tolerance
                || (b.top() as f64) < r.top() as f64 - tolerance
                || b.right() as f64 > r.right() as f64 + tolerance
                || b.bottom() as f64 > r.bottom() as f64 + tolerance
            {
                return Err(format!(
                    "轮廓 {} 被 SVG 裁剪边界截断，请整理完整切割轮廓后重试 DXF；PDF 不受影响",
                    path.id()
                ));
            }
        }
        let mut controls = Vec::new();
        for segment in path.data().segments() {
            match segment {
                PathSegment::MoveTo(p) => {
                    self.contour(&controls, false)?;
                    controls = vec![self.point(path.abs_transform(), p)];
                }
                PathSegment::LineTo(p) => {
                    add_line(&mut controls, self.point(path.abs_transform(), p))
                }
                PathSegment::QuadTo(a, b) => {
                    let start = *controls.last().ok_or("DXF 曲线缺少起点")?;
                    let a = self.point(path.abs_transform(), a);
                    let b = self.point(path.abs_transform(), b);
                    controls.extend([lerp(start, a, 2.0 / 3.0), lerp(b, a, 2.0 / 3.0), b]);
                }
                PathSegment::CubicTo(a, b, c) => {
                    controls.extend([
                        self.point(path.abs_transform(), a),
                        self.point(path.abs_transform(), b),
                        self.point(path.abs_transform(), c),
                    ]);
                }
                PathSegment::Close => {
                    if let Some(&start) = controls.first() {
                        let end = controls.len() - 1;
                        let delta = [start[0] - controls[end][0], start[1] - controls[end][1]];
                        if delta[0].hypot(delta[1]) <= CLOSURE_TOLERANCE_MM {
                            controls[end] = start;
                            if end >= 3 {
                                controls[end - 1][0] += delta[0];
                                controls[end - 1][1] += delta[1];
                            }
                        } else {
                            add_line(&mut controls, start);
                        }
                    }
                    self.contour(&controls, true)?;
                    controls.clear();
                }
            }
        }
        self.contour(&controls, false)?;
        Ok(())
    }

    fn group(&mut self, group: &usvg::Group, inherited: &[ClipRect]) -> Result<(), String> {
        if !has_geometry(group) {
            return Ok(());
        }
        if group.mask().is_some() || !group.filters().is_empty() {
            return Err(
                "轮廓包含遮罩或滤镜，无法确定切割边界；请将切割线转为普通路径后重试 DXF".into(),
            );
        }
        let mut clips = inherited.to_vec();
        if let Some(clip) = group.clip_path() {
            clips.push(rect_clip(clip, group.abs_transform())?);
        }
        for node in group.children() {
            match node {
                usvg::Node::Group(child) => self.group(child, &clips)?,
                usvg::Node::Path(path) => self.path(path, &clips)?,
                usvg::Node::Text(text) => self.group(text.flattened(), &clips)?,
                usvg::Node::Image(_) => {
                    return Err("轮廓页包含图片，请将其改为图片类型后重试 DXF".into())
                }
            }
        }
        Ok(())
    }
}

// Filtering SVG layers leaves empty clipped groups behind. They have no cutting
// geometry and must not make an otherwise valid contour export fail.
fn has_geometry(group: &usvg::Group) -> bool {
    group.opacity().get() > 0.0
        && group.children().iter().any(|node| match node {
            usvg::Node::Group(child) => has_geometry(child),
            usvg::Node::Path(path) => path.is_visible(),
            usvg::Node::Text(text) => has_geometry(text.flattened()),
            usvg::Node::Image(image) => image.is_visible(),
        })
}

fn n(value: f64) -> String {
    let value = if value.abs() < 0.0000005 { 0.0 } else { value };
    format!("{value:.6}")
}
fn close(a: XY, b: XY) -> bool {
    (a[0] - b[0]).abs() < 1e-7 && (a[1] - b[1]).abs() < 1e-7
}
fn lerp(a: XY, b: XY, t: f64) -> XY {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn add_line(controls: &mut Vec<XY>, end: XY) {
    if let Some(&start) = controls.last() {
        if !close(start, end) {
            controls.extend([
                lerp(start, end, 1.0 / 3.0),
                lerp(start, end, 2.0 / 3.0),
                end,
            ]);
        }
    }
}

fn rect_clip(clip: &usvg::ClipPath, world: Transform) -> Result<ClipRect, String> {
    let error = || {
        format!(
            "轮廓使用复杂裁剪 {}，请整理为完整切割路径后重试 DXF",
            clip.id()
        )
    };
    if clip.clip_path().is_some() {
        return Err(error());
    }
    fn paths<'a>(group: &'a usvg::Group, out: &mut Vec<&'a usvg::Path>) -> Result<(), ()> {
        for node in group.children() {
            match node {
                usvg::Node::Path(p) => out.push(p),
                usvg::Node::Group(g) if g.clip_path().is_none() => paths(g, out)?,
                _ => return Err(()),
            }
        }
        Ok(())
    }
    let mut nodes = Vec::new();
    paths(clip.root(), &mut nodes).map_err(|_| error())?;
    if nodes.len() != 1 {
        return Err(error());
    }
    let path = nodes[0];
    let rect = path.data().bounds();
    let mut points = Vec::new();
    for segment in path.data().segments() {
        match segment {
            PathSegment::MoveTo(p) | PathSegment::LineTo(p) => points.push(p),
            PathSegment::Close => {}
            _ => return Err(error()),
        }
    }
    if points.len() == 5 && points[0] == points[4] {
        points.pop();
    }
    if points.len() != 4
        || !points.iter().enumerate().all(|(i, p)| {
            let next = points[(i + 1) % 4];
            (p.x == rect.left() || p.x == rect.right())
                && (p.y == rect.top() || p.y == rect.bottom())
                && (p.x == next.x || p.y == next.y)
        })
    {
        return Err(error());
    }
    Ok(ClipRect {
        rect,
        transform: world
            .pre_concat(clip.transform())
            .pre_concat(path.abs_transform()),
    })
}

fn render_dxf(svg: &str, width: f64, height: f64) -> Result<String, String> {
    if ![width, height]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0 && *v <= 10_000.0)
    {
        return Err("DXF 板材毫米宽高无效".into());
    }
    let doc = roxmltree::Document::parse(svg).map_err(|e| format!("DXF 轮廓 SVG 无效：{e}"))?;
    let mut holes = Vec::new();
    let mut ranges = Vec::new();
    for group in doc
        .descendants()
        .filter(|n| n.attribute("data-board-holes") == Some("true"))
    {
        for path in group.children().filter(|n| n.is_element()) {
            let read = |key| {
                path.attribute(key)
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .ok_or("版面孔缺少有效毫米圆心或半径，请重新打开导出窗口")
            };
            let x = read("data-hole-center-x-mm")?;
            let y = read("data-hole-center-y-mm")?;
            let r = read("data-hole-radius-mm")?;
            if r <= 0.0 {
                return Err("版面孔半径无效".into());
            }
            holes.push(([x, height - y], r));
        }
        ranges.push(group.range());
    }
    // Remove only generated board holes. User paths, defs/use and transforms
    // remain intact; the board circles are emitted separately as true CIRCLEs.
    let mut geometry = svg.to_string();
    for range in ranges.into_iter().rev() {
        geometry.replace_range(range, "");
    }
    let mut options = crate::assets::export_options()?;
    let has_image = Arc::new(AtomicBool::new(false));
    let image_flag = has_image.clone();
    options.image_href_resolver.resolve_data = Box::new(move |_, _, _| {
        image_flag.store(true, Ordering::Relaxed);
        None
    });
    let image_flag = has_image.clone();
    options.image_href_resolver.resolve_string = Box::new(move |_, _| {
        image_flag.store(true, Ordering::Relaxed);
        None
    });
    let tree =
        usvg::Tree::from_str(&geometry, &options).map_err(|e| format!("解析 DXF 轮廓失败：{e}"))?;
    if has_image.load(Ordering::Relaxed) {
        return Err("轮廓页包含图片，无法转换为切割路径；请将其改为图片类型后重试 DXF".into());
    }
    if ((tree.size().width() as f64 / tree.size().height() as f64) / (width / height) - 1.0).abs()
        > 0.0001
    {
        return Err("DXF 轮廓页面比例与板材尺寸不一致".into());
    }
    let mut out = Dxf {
        entities: String::new(),
        count: 0,
        scale: [
            width / tree.size().width() as f64,
            height / tree.size().height() as f64,
        ],
        height,
    };
    let board_clip = ClipRect {
        rect: Rect::from_xywh(0.0, 0.0, tree.size().width(), tree.size().height()).unwrap(),
        transform: Transform::identity(),
    };
    out.group(tree.root(), &[board_clip])?;
    for (center, radius) in holes {
        out.circle(center, radius);
    }
    if out.count == 0 {
        return Err("轮廓页没有可导出的 DXF 路径".into());
    }
    Ok(format::document(&out.entities, out.count, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_dxf(source: &str, width: f64, height: f64) -> Result<String, String> {
        super::render_dxf(source, width, height).map(|text| text.replace("\r\n", "\n"))
    }
    fn svg(body: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464">{body}</svg>"#
        )
    }
    #[test]
    fn native_splines_preserve_cubic_controls_closure_and_open_paths() {
        let dxf = read_dxf(&svg(r#"<path fill="none" stroke="black" d="M10 10C20 0 30 20 40 10L10 10Z M60 20L70 20L70 30Z M80 20Q85 5 90 20"/>"#), 300., 464.).unwrap();
        assert!(!dxf.contains("0\nLWPOLYLINE\n"));
        let splines: Vec<_> = dxf.split("0\nSPLINE\n").skip(1).collect();
        assert_eq!(splines.len(), 3, "each SVG subpath must remain one SPLINE");
        for (spline, (expected_count, flags)) in splines.iter().zip([(7, 9), (10, 9), (4, 8)]) {
            let lines: Vec<_> = spline
                .split("0\nENDSEC\n")
                .next()
                .unwrap()
                .lines()
                .collect();
            let pairs: Vec<_> = lines.chunks_exact(2).map(|p| (p[0], p[1])).collect();
            let value = |code| {
                pairs
                    .iter()
                    .find(|p| p.0 == code)
                    .unwrap()
                    .1
                    .parse::<usize>()
                    .unwrap()
            };
            assert_eq!(value("70"), flags);
            assert_eq!(value("71"), 3);
            assert_eq!(value("73"), expected_count);
            assert_eq!(value("72"), expected_count + 4);
            let xs: Vec<f64> = pairs
                .iter()
                .filter(|p| p.0 == "10")
                .map(|p| p.1.parse().unwrap())
                .collect();
            let ys: Vec<f64> = pairs
                .iter()
                .filter(|p| p.0 == "20")
                .map(|p| p.1.parse().unwrap())
                .collect();
            assert_eq!(xs.len(), expected_count);
            if flags & 1 != 0 {
                assert_eq!((xs[0], ys[0]), (*xs.last().unwrap(), *ys.last().unwrap()));
            } else {
                assert_ne!(xs[0], *xs.last().unwrap());
            }
        }
        let first: Vec<_> = splines[0]
            .lines()
            .collect::<Vec<_>>()
            .chunks_exact(2)
            .map(|p| (p[0], p[1]))
            .collect();
        let xs: Vec<f64> = first
            .iter()
            .filter(|p| p.0 == "10")
            .map(|p| p.1.parse().unwrap())
            .collect();
        let ys: Vec<f64> = first
            .iter()
            .filter(|p| p.0 == "20")
            .map(|p| p.1.parse().unwrap())
            .collect();
        for (index, expected) in [(1, [20., 464.]), (2, [30., 444.])] {
            assert!(
                (xs[index] - expected[0]).abs() < 0.0001
                    && (ys[index] - expected[1]).abs() < 0.0001,
                "native Bezier control was lost: {expected:?}"
            );
        }
    }
    #[test]
    fn closing_snap_removes_transform_noise_without_flattening_loops_or_open_paths() {
        let dxf = read_dxf(&svg(r#"<path fill="none" stroke="black" d="M10 10C15 5 15 15 10.00005 10Z M30 30C30 60 60 60 30 30Z M80 80C100 80 60 80 80 80"/>"#), 300., 464.).unwrap();
        let splines: Vec<_> = dxf.split("0\nSPLINE\n").skip(1).collect();
        assert_eq!(splines.len(), 3);
        for spline in &splines {
            assert!(
                spline.contains("73\n4\n74\n0"),
                "the original single cubic must not be split"
            );
            assert!(spline.contains("72\n8\n73\n4"));
        }
        assert!(splines[0].contains("70\n9\n"));
        assert!(splines[1].contains("70\n9\n"));
        // Identical end coordinates alone do not make an SVG path closed.
        assert!(splines[2].contains("70\n8\n"));
    }
    #[test]
    fn millimeters_qt_transforms_closed_paths_and_circles() {
        let source = svg(
            r##"<defs><g id="art"><svg width="40" height="20" viewBox="10 20 400 200"><path fill="none" stroke="red" d="M10 20H410V220H10Z"/></svg></g></defs><g transform="translate(30 40) rotate(90)"><use href="#art"/></g><g transform="translate(80 100)"><use href="#art"/></g><g data-board-holes="true"><path data-hole-center-x-mm="5.5" data-hole-center-y-mm="131.766" data-hole-radius-mm="1.5" d="M4 131.766 A1.5 1.5 0 1 0 7 131.766Z"/></g>"##,
        );
        let dxf = read_dxf(&source, 300.0, 464.0).unwrap();
        assert!(dxf.contains("$INSUNITS\n70\n4"));
        assert_eq!(dxf.matches("0\nSPLINE\n").count(), 2);
        let pairs: Vec<_> = dxf
            .lines()
            .collect::<Vec<_>>()
            .chunks(2)
            .map(|p| (p[0].to_owned(), p[1].to_owned()))
            .collect();
        let vertices: Vec<XY> = pairs
            .windows(2)
            .filter(|p| p[0].0 == "10" && p[1].0 == "20")
            .map(|p| [p[0].1.parse().unwrap(), p[1].1.parse().unwrap()])
            .collect();
        for expected in [[30.0, 424.0], [10.0, 384.0], [80.0, 364.0], [120.0, 344.0]] {
            assert!(
                vertices
                    .iter()
                    .any(|p| (p[0] - expected[0]).abs() < 0.0001
                        && (p[1] - expected[1]).abs() < 0.0001),
                "missing {expected:?}, got {vertices:?}"
            );
        }
        assert!(dxf.contains("0\nCIRCLE\n"));
        assert!(dxf.contains("10\n5.500000\n20\n332.234000\n30\n0\n40\n1.500000"));
        // Both imported curves and registration holes must remain red even
        // when a CAD importer overrides the layer's default color.
        assert_eq!(dxf.matches("62\n1\n100\nAcDbSpline\n").count(), 2);
        assert!(dxf.contains("62\n1\n100\nAcDbCircle\n"));
        for layer in ["0", "CUT", "HOLES"] {
            assert!(dxf.contains(&format!("2\n{layer}\n70\n0\n62\n1\n")));
        }
    }
    #[test]
    fn curves_and_separate_closed_subpaths_use_native_splines() {
        let dxf = read_dxf(&svg(r#"<path fill="none" stroke="black" d="M10 10C20 0 30 20 40 10L10 10Z M60 20L70 20L70 30Z"/>"#), 300.0, 464.0).unwrap();
        assert!(!dxf.contains("0\nLWPOLYLINE\n"));
        assert_eq!(dxf.matches("0\nSPLINE\n").count(), 2);
        assert_eq!(dxf.matches("70\n9\n71\n3\n").count(), 2);
    }
    #[test]
    fn cad_document_has_standard_tables_model_space_ownership_and_crlf() {
        let source = svg(r#"<path d="M10 10h20v20z"/>"#);
        let dxf = super::render_dxf(&source, 300., 464.).unwrap();
        assert!(!dxf.replace("\r\n", "").contains('\n'));
        let dxf = dxf.replace("\r\n", "\n");
        for table in [
            "VPORT",
            "LTYPE",
            "LAYER",
            "STYLE",
            "VIEW",
            "UCS",
            "APPID",
            "DIMSTYLE",
            "BLOCK_RECORD",
        ] {
            assert!(dxf.contains(&format!("0\nTABLE\n2\n{table}\n")));
        }
        for section in [
            "HEADER", "CLASSES", "TABLES", "BLOCKS", "ENTITIES", "OBJECTS",
        ] {
            assert!(dxf.contains(&format!("0\nSECTION\n2\n{section}\n")));
        }
        assert!(dxf.contains("330\n51\n100\nAcDbEntity\n8\nCUT"));
        assert!(dxf.contains("100\nAcDbBlockTableRecord\n2\n*Model_Space"));
        assert!(dxf.contains("$INSUNITS\n70\n4"));
    }
    #[test]
    fn honors_invisible_content_and_accepts_in_bounds_viewport_clipping() {
        let dxf = read_dxf(&svg(r#"<g opacity="0"><path d="M200 200h30v30z"/></g><g transform="translate(40 50) rotate(180)"><svg width="20" height="10" viewBox="0 0 20 10" overflow="hidden"><path d="M1 1h18v8h-18z"/></svg></g>"#), 300.0, 464.0).unwrap();
        assert_eq!(dxf.matches("0\nSPLINE\n").count(), 1);
        assert!(read_dxf(
            &svg(
                r#"<svg width="20" height="10" overflow="hidden"><path d="M1 1h30v8h-30z"/></svg>"#
            ),
            300.0,
            464.0
        )
        .is_err());
    }
    #[test]
    fn empty_clipped_groups_do_not_block_exports_and_curve_bounds_use_the_actual_curve() {
        let dxf = read_dxf(&svg(r##"<defs><clipPath id="unused"><circle cx="15" cy="15" r="10"/></clipPath></defs><g clip-path="url(#unused)"><g/></g><svg width="30" height="30" overflow="hidden"><path stroke="black" fill="none" d="M1 15C5 -5 25 -5 29 15"/></svg>"##), 300.0, 464.0).unwrap();
        assert_eq!(dxf.matches("0\nSPLINE\n").count(), 1);
    }
    #[test]
    fn images_assigned_to_contours_fail_without_raster_decoding_or_silent_loss() {
        let error = read_dxf(&svg(r#"<path d="M1 1h10v10z"/><image width="20" height="20" href="data:image/png;base64,aW52YWxpZA=="/>"#), 300.0, 464.0).unwrap_err();
        assert!(error.contains("轮廓页包含图片"));
    }
    #[test]
    fn rejects_bad_dimensions_empty_geometry_and_complex_clip_instead_of_cutting_hidden_lines() {
        assert!(read_dxf(&svg(""), 300.0, 464.0).is_err());
        assert!(read_dxf(&svg(""), f64::NAN, 464.0).is_err());
        assert!(read_dxf(&svg(r##"<defs><clipPath id="round"><circle cx="15" cy="15" r="10"/></clipPath></defs><g clip-path="url(#round)"><path d="M5 5h20v20H5z"/></g>"##), 300.0, 464.0).is_err());
    }

    /// Exercise production parsing and atomic publication on an external fixture.
    /// PRINTFLOW_DXF_INPUT is optional; PRINTFLOW_DXF_OUTPUT must be a new .dxf.
    #[test]
    #[ignore = "manual independent DXF-reader validation"]
    fn export_validation_fixture() {
        let source = match std::env::var("PRINTFLOW_DXF_INPUT") {
            Ok(path) => fs::read_to_string(path).unwrap(),
            Err(_) => svg(
                r#"<g transform="translate(60 80) rotate(90)"><path fill="none" stroke="black" d="M0 0H40V20H0Z M5 5C10 0 30 0 35 5L35 15Q20 20 5 15Z"/></g><g data-board-holes="true"><path data-hole-center-x-mm="5.5" data-hole-center-y-mm="131.766" data-hole-radius-mm="1.5"/><path data-hole-center-x-mm="5.5" data-hole-center-y-mm="332.234" data-hole-radius-mm="1.5"/></g>"#,
            ),
        };
        let output = std::env::var("PRINTFLOW_DXF_OUTPUT").expect("set PRINTFLOW_DXF_OUTPUT");
        let output = crate::imposition_pdf::checked_export_output(&output, "dxf").unwrap();
        let dxf = super::render_dxf(&source, 300.0, 464.0).unwrap();
        crate::imposition_pdf::commit_dxf(&output, dxf.as_bytes()).unwrap();
        assert!(crate::imposition_pdf::commit_dxf(&output, b"must not overwrite").is_err());
        assert_eq!(fs::read_to_string(output).unwrap(), dxf);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires installed CorelDRAW COM; temporarily opens a generated test document"]
    fn coreldraw_import_keeps_contours_and_millimetre_scale() {
        let dir = std::env::temp_dir().join(format!(
            "printflow-dxf-corel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let input = dir.join("curves.dxf");
        fs::write(&input, super::render_dxf(&svg(r#"<path stroke="black" fill="none" d="M10 10C20 0 30 20 40 10L10 10Z M60 20Q65 5 70 20L70 30Z"/>"#), 300., 464.).unwrap()).unwrap();
        // Use Corel's document API, preserve the existing active document, and
        // close only our imported test document without saving or quitting Corel.
        let script = r#"
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject CorelDRAW.Application
$previous = $null
$doc = $null
try {
    if ($app.Documents.Count -gt 0) { $previous = $app.ActiveDocument }
    $doc = $app.OpenDocument($env:PRINTFLOW_DXF_COREL_FIXTURE, 0)
    if ($null -eq $doc) { throw 'CorelDRAW returned no document' }
    $doc.Unit = 3
    if ($doc.ActivePage.Shapes.Count -ne 2) { throw 'CorelDRAW lost cutting contours' }
    foreach ($shape in $doc.ActivePage.Shapes) {
        foreach ($subpath in $shape.Curve.SubPaths) {
            if (-not $subpath.Closed) { throw 'CorelDRAW imported an open cutting contour' }
        }
    }
    if ([Math]::Abs($doc.ActivePage.Shapes.All().SizeWidth - 60) -gt 0.01) { throw 'CorelDRAW imported at the wrong millimetre scale' }
} finally {
    if ($doc) { $doc.Dirty = $false; $doc.Close() }
    if ($previous) { $previous.Activate() }
    [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
"#;
        let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let imported = std::process::Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("PRINTFLOW_DXF_COREL_FIXTURE", &input)
            .output()
            .unwrap();
        assert!(
            imported.status.success(),
            "CorelDRAW import failed: {}; fixtures: {}",
            String::from_utf8_lossy(&imported.stderr),
            dir.display()
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
