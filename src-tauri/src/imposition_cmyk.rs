//! Production CMYK + White/C2/M2/Y2/K2. Each distinct source/size is converted
//! once; QT copies share the resulting nine-color image XObject.
use flate2::{write::ZlibEncoder, Compression};
use lcms2::{Intent, PixelFormat, Profile, Transform};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io::Write};
use tauri::Emitter;

pub(crate) const ICC: &[u8] = include_bytes!("../resources/color/250icm.icc");
pub(crate) const INKS: [&[u8]; 9] = [
    b"Cyan", b"Magenta", b"Yellow", b"Black", b"White", b"C2", b"M2", b"Y2", b"K2",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offset {
    pub x_mm: f64,
    pub y_mm: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    pub key: String,
    pub label: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub front_id: String,
    pub back_id: Option<String>,
    pub window_id: Option<String>,
    #[serde(default)]
    pub back_offset: Offset,
    #[serde(default)]
    pub window_offset: Offset,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placement {
    pub source_key: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hole {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    pub width_mm: f64,
    pub height_mm: f64,
    pub dpi: u32,
    pub different_back: bool,
    pub auto_align: bool,
    pub sources: Vec<Source>,
    pub placements: Vec<Placement>,
    pub holes: Vec<Hole>,
}
impl Job {
    pub(crate) fn load(id: &str) -> Result<Self, String> {
        let text = std::fs::read_to_string(crate::staged_artwork::path(id)?)
            .map_err(|e| format!("读取 CMYK 导出任务失败：{e}"))?;
        let job: Self =
            serde_json::from_str(&text).map_err(|e| format!("CMYK 导出参数无效：{e}"))?;
        job.validate()?;
        Ok(job)
    }
    pub(crate) fn ids(&self) -> Vec<String> {
        self.sources
            .iter()
            .flat_map(|s| {
                std::iter::once(&s.front_id)
                    .chain(s.back_id.iter())
                    .chain(s.window_id.iter())
            })
            .cloned()
            .collect()
    }
    fn validate(&self) -> Result<(), String> {
        if !(300..=400).contains(&self.dpi)
            || !valid_size(self.width_mm, self.height_mm)
            || self.sources.is_empty()
            || self.placements.is_empty()
        {
            return Err("CMYK 需要有效板材、图片和 300 至 400 ppi 分辨率".into());
        }
        let mut keys = HashSet::new();
        for source in &self.sources {
            if !keys.insert(&source.key)
                || !valid_size(source.width_mm, source.height_mm)
                || self.different_back && source.back_id.is_none()
                || ![
                    source.back_offset.x_mm,
                    source.back_offset.y_mm,
                    source.window_offset.x_mm,
                    source.window_offset.y_mm,
                ]
                .iter()
                .all(|n| n.is_finite() && n.abs() <= 10000.)
            {
                return Err(format!(
                    "{}：CMYK 图片尺寸、正背图层或对齐参数无效",
                    source.label
                ));
            }
            dimensions(source.width_mm, source.height_mm, self.dpi)?;
        }
        for id in self.ids() {
            crate::staged_artwork::path(&id)?;
        }
        for p in &self.placements {
            let source = self
                .sources
                .iter()
                .find(|s| s.key == p.source_key)
                .ok_or("CMYK 放置引用了不存在的图片")?;
            if ![p.x, p.y, p.width, p.height, p.rotation]
                .iter()
                .all(|n| n.is_finite())
                || (p.width - source.width_mm).abs() > 0.00001
                || (p.height - source.height_mm).abs() > 0.00001
            {
                return Err(format!("{}：CMYK 放置尺寸与原图缓存不一致", source.label));
            }
            let (sin, cos) = p.rotation.to_radians().sin_cos();
            let w = cos.abs() * p.width + sin.abs() * p.height;
            let h = sin.abs() * p.width + cos.abs() * p.height;
            if p.x < -0.01
                || p.y < -0.01
                || p.x + w > self.width_mm + 0.01
                || p.y + h > self.height_mm + 0.01
            {
                return Err(format!(
                    "{}：图片超出板材范围，请调整后导出 CMYK",
                    source.label
                ));
            }
        }
        if self
            .holes
            .iter()
            .any(|h| ![h.x, h.y, h.radius].iter().all(|v| v.is_finite()) || h.radius <= 0.)
        {
            return Err("CMYK 版面孔参数无效".into());
        }
        Ok(())
    }
}
fn valid_size(w: f64, h: f64) -> bool {
    [w, h]
        .iter()
        .all(|n| n.is_finite() && *n > 0. && *n <= 10000.)
}
fn dimensions(w: f64, h: f64, dpi: u32) -> Result<(u32, u32), String> {
    let w = (w / 25.4 * dpi as f64).round().max(1.) as u32;
    let h = (h / 25.4 * dpi as f64).round().max(1.) as u32;
    if w as u64 * h as u64 > i32::MAX as u64 / 16 {
        return Err("CMYK 单张图片像素过大，请降低分辨率或拆分图片".into());
    }
    Ok((w, h))
}

#[tauri::command]
pub async fn export_imposition_cmyk_pdf(
    app: tauri::AppHandle,
    output: String,
    id: String,
    job_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let job = Job::load(&job_id)?;
        let output = crate::imposition_pdf::checked_export_output(&output, "pdf")?;
        let total = job.sources.len();
        crate::imposition_pdf_runtime::export_cmyk_isolated(
            &output,
            job_id,
            &job,
            |index, phase| {
                let _ = app.emit(
                    "imposition-pdf-export-progress",
                    serde_json::json!({"id":id,"phase":phase,"pageIndex":index,"pageCount":total}),
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Layer {
    tree: usvg::Tree,
    offset: Offset,
}
// Filtered SVGs retain named empty groups. usvg assigns these a 1×1 layer
// box at the origin; beside artwork at large coordinates this can expand
// isolated clip layers so far that resvg's safety bounds discard the artwork.
// Remove only empty group containers, keeping all paths, clipping and defs.
fn without_empty_groups(svg: &str) -> Result<String, String> {
    let doc = roxmltree::Document::parse(svg).map_err(|e| format!("CMYK SVG 解析失败：{e}"))?;
    fn empty(node: roxmltree::Node<'_, '_>) -> bool {
        node.has_tag_name(("http://www.w3.org/2000/svg", "g"))
            && node.children().all(|n| {
                n.is_comment()
                    || n.is_text() && n.text().unwrap_or("").trim().is_empty()
                    || n.is_element() && empty(n)
            })
    }
    let mut result = String::with_capacity(svg.len());
    let mut end = 0;
    for n in doc.descendants().filter(|n| n.is_element() && empty(*n)) {
        let range = n.range();
        if range.start < end {
            continue;
        }
        result.push_str(&svg[end..range.start]);
        end = range.end;
    }
    result.push_str(&svg[end..]);
    Ok(result)
}
fn layer(id: &str, client: &reqwest::blocking::Client, offset: Offset) -> Result<Layer, String> {
    let text =
        std::fs::read_to_string(crate::staged_artwork::path(id)?).map_err(|e| e.to_string())?;
    let embedded = crate::embed_external_raster_images(text, client, &mut Default::default())?;
    let tree = crate::imposition_pdf::parse_board_svg(&without_empty_groups(&embedded)?)?;
    if tree.root().children().is_empty() {
        return Err("所选图层没有可绘制内容".into());
    }
    Ok(Layer { tree, offset })
}
fn raster_center(pixmap: &tiny_skia::Pixmap) -> Result<(f64, f64), String> {
    let mut bounds = (pixmap.width(), pixmap.height(), 0, 0);
    let mut found = false;
    for (i, p) in pixmap.pixels().iter().enumerate() {
        if p.alpha() == 0 {
            continue;
        }
        let x = i as u32 % pixmap.width();
        let y = i as u32 / pixmap.width();
        bounds.0 = bounds.0.min(x);
        bounds.1 = bounds.1.min(y);
        bounds.2 = bounds.2.max(x + 1);
        bounds.3 = bounds.3.max(y + 1);
        found = true;
    }
    if !found {
        return Err("所选图片为空或完全超出产品区域".into());
    }
    Ok((
        (bounds.0 + bounds.2) as f64 / 2.,
        (bounds.1 + bounds.3) as f64 / 2.,
    ))
}
fn render_layer(
    layer: &Layer,
    w: u32,
    h: u32,
    mm: (f64, f64),
    reference: Option<(f64, f64)>,
) -> Result<tiny_skia::Pixmap, String> {
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("CMYK 图片缓冲区分配失败")?;
    let transform = tiny_skia::Transform::from_scale(
        w as f32 / layer.tree.size().width(),
        h as f32 / layer.tree.size().height(),
    );
    resvg::render(&layer.tree, transform, &mut pixmap.as_mut());
    // Visible, clipped alpha bounds are the registration reference. Authored
    // geometry bounds include invisible areas outside Corel's clip paths.
    let current = raster_center(&pixmap)?;
    let delta = reference.map_or((0., 0.), |r| (r.0 - current.0, r.1 - current.1));
    let dx = delta.0 + layer.offset.x_mm * w as f64 / mm.0;
    let dy = delta.1 + layer.offset.y_mm * h as f64 / mm.1;
    if dx != 0. || dy != 0. {
        let mut shifted = tiny_skia::Pixmap::new(w, h).ok_or("CMYK 对齐缓冲区分配失败")?;
        let paint = tiny_skia::PixmapPaint {
            quality: tiny_skia::FilterQuality::Bilinear,
            ..Default::default()
        };
        shifted.draw_pixmap(
            0,
            0,
            pixmap.as_ref(),
            &paint,
            tiny_skia::Transform::from_translate(dx as f32, dy as f32),
            None,
        );
        raster_center(&shifted)?;
        return Ok(shifted);
    }
    Ok(pixmap)
}
pub(crate) struct Converted {
    pub width: u32,
    pub height: u32,
    pub inks: Vec<u8>,
    pub mask: Vec<u8>,
    pub layers: Option<std::sync::Arc<SourceLayers>>,
}
pub(crate) struct LayerChannels {
    /// Four straight CMYK ink planes followed by alpha, all losslessly zipped.
    pub planes: [Vec<u8>; 5],
}
pub(crate) struct SourceLayers {
    pub image: LayerChannels,
    pub window: Option<LayerChannels>,
}
struct LayerEncoder([ZlibEncoder<Vec<u8>>; 5]);
impl LayerEncoder {
    fn new() -> Self {
        Self(std::array::from_fn(|_| {
            ZlibEncoder::new(Vec::new(), Compression::new(3))
        }))
    }
    fn row(&mut self, cmyk: &[[u8; 4]], alpha: &[u8]) -> Result<(), String> {
        let mut plane = vec![0; alpha.len()];
        for c in 0..4 {
            for (x, value) in plane.iter_mut().enumerate() {
                *value = if alpha[x] == 0 { 0 } else { cmyk[x][c] };
            }
            self.0[c].write_all(&plane).map_err(|e| e.to_string())?;
        }
        self.0[4].write_all(alpha).map_err(|e| e.to_string())
    }
    fn finish(self) -> Result<LayerChannels, String> {
        let mut planes: [Vec<u8>; 5] = Default::default();
        for (c, encoder) in self.0.into_iter().enumerate() {
            planes[c] = encoder.finish().map_err(|e| e.to_string())?;
        }
        Ok(LayerChannels { planes })
    }
}
fn straight_rgb(p: &[u8]) -> [u8; 3] {
    if p[3] == 0 {
        return [255; 3];
    }
    std::array::from_fn(|c| ((p[c] as u32 * 255 + p[3] as u32 / 2) / p[3] as u32).min(255) as u8)
}
fn doubled_alpha(alpha: u8) -> u8 {
    let alpha = alpha as u32;
    (alpha + (alpha * (255 - alpha) + 127) / 255) as u8
}
/// Composite independent CMYK layers over the unprinted substrate. Layer
/// pixels stay straight (unmatted); only the document's process/spot preview
/// is flattened. This is the order used by a CMYK Photoshop document.
fn layered_cmyk(top: [u8; 4], alpha: u8, window: [u8; 4], window_alpha: u8) -> [u8; 4] {
    std::array::from_fn(|c| {
        let bottom = (window[c] as u32 * window_alpha as u32 + 127) / 255;
        ((top[c] as u32 * alpha as u32 + bottom * (255 - alpha as u32) + 127) / 255) as u8
    })
}
// Keep the existing matte-white conversion for documents without windows.
fn rgb_over_white(top: &[u8]) -> [u8; 3] {
    std::array::from_fn(|c| top[c].saturating_add(255 - top[3]))
}
fn eroded_alpha(pixels: &[u8], width: usize, height: usize, x: usize, y: usize) -> u8 {
    if x == 0 || y == 0 || x + 1 == width || y + 1 == height {
        return 0;
    }
    let mut alpha = 255;
    for yy in y - 1..=y + 1 {
        for xx in x - 1..=x + 1 {
            alpha = alpha.min(pixels[(yy * width + xx) * 4 + 3]);
        }
    }
    alpha
}

fn convert_source(
    job: &Job,
    source: &Source,
    client: &reqwest::blocking::Client,
    transform: &Transform<[u8; 3], [u8; 4]>,
    report: impl Fn(&str),
) -> Result<Converted, String> {
    report("resources");
    let (w, h) = dimensions(source.width_mm, source.height_mm, job.dpi)?;
    let preserve_layers = job.sources.iter().any(|s| s.window_id.is_some());
    let needed = w as usize * h as usize * if preserve_layers { 40 } else { 20 };
    if crate::imposition_pdf_runtime::worker_memory()
        .is_some_and(|free| free < needed.saturating_add(64 * 1024 * 1024))
    {
        return Err("当前可用内存不足以处理该图片，请释放内存或选择 300 ppi 后重试".into());
    }
    report("cmyk-align");
    let front_layer = layer(&source.front_id, client, Offset::default())?;
    let front = render_layer(
        &front_layer,
        w,
        h,
        (source.width_mm, source.height_mm),
        None,
    )?;
    let reference = if job.auto_align {
        Some(raster_center(&front)?)
    } else {
        None
    };
    drop(front_layer);
    let back = if let Some(id) = &source.back_id {
        let b = layer(id, client, source.back_offset.clone())?;
        Some(render_layer(
            &b,
            w,
            h,
            (source.width_mm, source.height_mm),
            reference,
        )?)
    } else {
        None
    };
    let window = if let Some(id) = &source.window_id {
        let b = layer(id, client, source.window_offset.clone())?;
        Some(render_layer(
            &b,
            w,
            h,
            (source.width_mm, source.height_mm),
            reference,
        )?)
    } else {
        None
    };
    let back = back.as_ref().unwrap_or(&front);
    // Every picture needs an independent layer if any product on the board
    // has a window, including products without their own window.
    let mut image_layer = preserve_layers.then(LayerEncoder::new);
    let mut window_layer = window.as_ref().map(|_| LayerEncoder::new());
    let white_pixels = back.data();
    let mut inks = ZlibEncoder::new(Vec::new(), Compression::new(3));
    let mut mask = ZlibEncoder::new(Vec::new(), Compression::new(3));
    let w = w as usize;
    let h = h as usize;
    let mut front_rgb = vec![[0; 3]; w];
    let mut back_rgb = vec![[0; 3]; w];
    let mut window_rgb = vec![[255; 3]; w];
    let mut front_cmyk = vec![[0; 4]; w];
    let mut back_cmyk = vec![[0; 4]; w];
    let mut window_cmyk = vec![[0; 4]; w];
    let mut image_alpha = vec![0; w];
    let mut window_alpha = vec![0; w];
    let mut row = vec![0; w * 9];
    let mut mask_row = vec![0; w];
    report("cmyk-color");
    for y in 0..h {
        for x in 0..w {
            let p = (y * w + x) * 4;
            let front_pixel = &front.data()[p..p + 4];
            front_rgb[x] = if preserve_layers {
                straight_rgb(front_pixel)
            } else {
                rgb_over_white(front_pixel)
            };
            image_alpha[x] = front_pixel[3];
            if job.different_back {
                let back_pixel = &back.data()[p..p + 4];
                back_rgb[x] = if preserve_layers {
                    straight_rgb(back_pixel)
                } else {
                    rgb_over_white(back_pixel)
                };
            }
            if let Some(window) = &window {
                let pixel = &window.data()[p..p + 4];
                window_rgb[x] = straight_rgb(pixel);
                window_alpha[x] = doubled_alpha(pixel[3]);
            }
        }
        transform.transform_pixels(&front_rgb, &mut front_cmyk);
        if job.different_back {
            transform.transform_pixels(&back_rgb, &mut back_cmyk);
        }
        if window.is_some() {
            transform.transform_pixels(&window_rgb, &mut window_cmyk);
        }
        if let Some(encoder) = &mut image_layer {
            encoder.row(&front_cmyk, &image_alpha)?;
        }
        if let Some(encoder) = &mut window_layer {
            encoder.row(&window_cmyk, &window_alpha)?;
        }
        for x in 0..w {
            let p = (y * w + x) * 4;
            let union = front.data()[p + 3]
                .max(back.data()[p + 3])
                .max(window.as_ref().map_or(0, |v| v.data()[p + 3]));
            mask_row[x] = if union > 0 { 255 } else { 0 };
            let front_inks = if preserve_layers {
                layered_cmyk(
                    front_cmyk[x],
                    image_alpha[x],
                    window_cmyk[x],
                    window_alpha[x],
                )
            } else {
                front_cmyk[x]
            };
            let back_inks = if job.different_back {
                if preserve_layers {
                    layered_cmyk(
                        back_cmyk[x],
                        back.data()[p + 3],
                        window_cmyk[x],
                        window_alpha[x],
                    )
                } else {
                    back_cmyk[x]
                }
            } else {
                front_inks
            };
            row[x * 9..x * 9 + 4].copy_from_slice(&front_inks);
            row[x * 9 + 4] = eroded_alpha(white_pixels, w, h, x, y);
            row[x * 9 + 5..x * 9 + 9].copy_from_slice(&back_inks);
            if union == 0 {
                row[x * 9..x * 9 + 9].fill(0);
            }
        }
        inks.write_all(&row).map_err(|e| e.to_string())?;
        mask.write_all(&mask_row).map_err(|e| e.to_string())?;
        if y % 256 == 0 {
            report("cmyk-color");
        }
    }
    report("cmyk-zip");
    Ok(Converted {
        width: w as u32,
        height: h as u32,
        inks: inks.finish().map_err(|e| e.to_string())?,
        mask: mask.finish().map_err(|e| e.to_string())?,
        layers: image_layer
            .map(|image| -> Result<_, String> {
                Ok(std::sync::Arc::new(SourceLayers {
                    image: image.finish()?,
                    window: window_layer.map(LayerEncoder::finish).transpose()?,
                }))
            })
            .transpose()?,
    })
}

fn color_transform() -> Result<Transform<[u8; 3], [u8; 4]>, String> {
    let rgb = Profile::new_srgb();
    let cmyk = Profile::new_icc(ICC).map_err(|e| format!("250.icm 色彩配置无法加载：{e}"))?;
    Transform::new(
        &rgb,
        PixelFormat::RGB_8,
        &cmyk,
        PixelFormat::CMYK_8,
        Intent::RelativeColorimetric,
    )
    .map_err(|e| e.to_string())
}
fn source_memory(source: &Source, dpi: u32, preserve_layers: bool) -> Result<usize, String> {
    let (w, h) = dimensions(source.width_mm, source.height_mm, dpi)?;
    let file = [
        &source.front_id,
        source.back_id.as_ref().unwrap_or(&source.front_id),
        source.window_id.as_ref().unwrap_or(&source.front_id),
    ]
    .iter()
    .map(|id| {
        crate::staged_artwork::path(id)
            .ok()
            .and_then(|p| std::fs::metadata(p).ok())
            .map_or(0, |m| m.len() as usize)
    })
    .max()
    .unwrap_or(0);
    Ok((w as usize * h as usize)
        .saturating_mul(if preserve_layers { 40 } else { 24 })
        .saturating_add(file.saturating_mul(32))
        .saturating_add(96 * 1024 * 1024))
}
pub(crate) fn render_job(
    job: &Job,
    workers: usize,
    report: impl Fn(usize, &str),
) -> Result<Vec<u8>, String> {
    job.validate()?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut pdf = crate::imposition_cmyk_pdf::Document::new()?;
    let workers = workers.clamp(1, crate::imposition_pdf_runtime::automatic_workers());
    let preserve_layers = job.sources.iter().any(|s| s.window_id.is_some());
    let mut index = 0;
    while index < job.sources.len() {
        // Re-evaluate pressure between batches. Reserve for decoded originals,
        // clip intermediates and compressed data already retained in the PDF.
        let mut end = index;
        let mut reserved = 0usize;
        let available = crate::imposition_pdf_runtime::worker_memory()
            .unwrap_or(0)
            .saturating_sub(128 * 1024 * 1024);
        for source in &job.sources[index..] {
            let needed = source_memory(source, job.dpi, preserve_layers)?;
            if end > index
                && (end - index >= workers || reserved.saturating_add(needed) > available)
            {
                break;
            }
            reserved = reserved.saturating_add(needed);
            end += 1;
        }
        let converted = std::thread::scope(|scope| {
            let (sender, receiver) = std::sync::mpsc::channel();
            let mut handles = vec![];
            for i in index..end {
                let sender = sender.clone();
                let client = &client;
                handles.push(scope.spawn(move || {
                    let transform = color_transform()?;
                    convert_source(job, &job.sources[i], client, &transform, |phase| {
                        let _ = sender.send((i + 1, phase.to_owned()));
                    })
                    .map_err(|e| format!("{}：{e}", job.sources[i].label))
                }));
            }
            drop(sender);
            // Only this coordinator calls the UI reporter; source workers can
            // finish in any order without changing PDF resource/placement order.
            for (i, phase) in receiver {
                report(i, &phase);
            }
            handles
                .into_iter()
                .map(|h| {
                    h.join()
                        .map_err(|_| "CMYK 图片处理线程异常，已停止本版式导出".to_owned())?
                })
                .collect::<Result<Vec<_>, String>>()
        })?;
        for (source, data) in job.sources[index..end].iter().zip(converted) {
            pdf.add_source(&source.key, data)?;
        }
        index = end;
    }
    report(job.sources.len(), "merge");
    pdf.finish(job, |_| report(0, "cmyk-photoshop"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn white_contract_is_one_pixel_and_retains_holes() {
        let mut pixels = vec![255; 7 * 7 * 4];
        assert_eq!(eroded_alpha(&pixels, 7, 7, 0, 3), 0);
        assert_eq!(eroded_alpha(&pixels, 7, 7, 1, 3), 255);
        pixels[(3 * 7 + 3) * 4 + 3] = 0;
        assert_eq!(eroded_alpha(&pixels, 7, 7, 2, 2), 0);
        assert_eq!(eroded_alpha(&pixels, 7, 7, 1, 1), 255);
    }
    #[test]
    fn transparent_colors_are_composited_without_dark_fringe() {
        assert_eq!(rgb_over_white(&[128, 0, 0, 128]), [255, 127, 127]);
        assert_eq!(straight_rgb(&[128, 0, 0, 128]), [255, 0, 0]);
        assert_eq!(straight_rgb(&[0, 0, 0, 0]), [255; 3]);
        assert_eq!(doubled_alpha(128), 192);
        assert_eq!(doubled_alpha(255), 255);
        assert_eq!(doubled_alpha(0), 0);
        assert_eq!(
            layered_cmyk([200, 0, 0, 0], 128, [0, 100, 0, 0], 192),
            [100, 37, 0, 0]
        );
    }
    #[test]
    fn production_icc_is_the_confirmed_profile() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            format!("{:x}", Sha256::digest(ICC)),
            "d3601f736c48c67ffcdfd75fc7b0977d7115619ece89f39194fac091cffae16a"
        );
        assert_eq!(&ICC[16..20], b"CMYK");
        Profile::new_icc(ICC).unwrap();
    }
    #[test]
    fn nested_viewports_with_far_origin_clips_keep_artwork_after_layer_filtering() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="42mm" height="76mm" viewBox="0 0 42 76">
          <svg width="42" height="76" viewBox="0 0 160 292" preserveAspectRatio="none">
            <svg width="160" height="292" viewBox="4952 1587 373 681">
              <defs><clipPath id="shape"><rect x="5000" y="1640" width="250" height="560"/></clipPath></defs>
              <g id="retained-layer"><g id="empty-filtered-layer"><g/></g>
                <g clip-path="url(#shape)"><g/><rect x="4857" y="1634" width="621" height="621" fill="blue"/><g/></g>
              </g>
            </svg>
          </svg>
        </svg>"##;
        let mut fixture = Fixture::new();
        let id = fixture.stage(svg);
        let client = reqwest::blocking::Client::new();
        let layer = layer(&id, &client, Offset::default()).unwrap();
        let raster = render_layer(&layer, 420, 760, (42., 76.), None).unwrap();
        assert!(raster.pixels().iter().filter(|p| p.alpha() > 0).count() > 100_000);
        assert_eq!(
            raster.pixel(0, 0).unwrap().alpha(),
            0,
            "viewport clipping is retained"
        );
        assert!(without_empty_groups(svg)
            .unwrap()
            .contains("clip-path=\"url(#shape)\""));
    }
    struct Fixture {
        ids: Vec<String>,
    }
    impl Fixture {
        fn new() -> Self {
            Self { ids: vec![] }
        }
        fn stage(&mut self, svg: &str) -> String {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let id = format!(
                "cafe-{:x}-{:x}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            std::fs::write(crate::staged_artwork::path(&id).unwrap(), svg).unwrap();
            self.ids.push(id.clone());
            id
        }
        fn job(&mut self, different: bool, window: bool) -> Job {
            let svg = |body: &str| {
                format!(
                    r#"<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10">{body}</svg>"#
                )
            };
            let front = self.stage(&svg(
                r#"<rect x="2" y="2" width="6" height="6" fill="red"/>"#,
            ));
            let back = if different {
                Some(self.stage(&svg(
                    r#"<rect x="3" y="2" width="6" height="6" fill="blue"/>"#,
                )))
            } else {
                None
            };
            let window = if window {
                Some(self.stage(&svg(
                    r#"<rect x="1" y="1" width="8" height="8" fill="green" opacity="0.5"/>"#,
                )))
            } else {
                None
            };
            Job {
                width_mm: 300.,
                height_mm: 464.,
                dpi: 400,
                different_back: different,
                auto_align: true,
                sources: vec![Source {
                    key: "sample".into(),
                    label: "sample.svg".into(),
                    width_mm: 10.,
                    height_mm: 10.,
                    front_id: front,
                    back_id: back,
                    window_id: window,
                    back_offset: Offset::default(),
                    window_offset: Offset::default(),
                }],
                placements: vec![
                    Placement {
                        source_key: "sample".into(),
                        x: 10.,
                        y: 20.,
                        width: 10.,
                        height: 10.,
                        rotation: 0.,
                    },
                    Placement {
                        source_key: "sample".into(),
                        x: 40.,
                        y: 20.,
                        width: 10.,
                        height: 10.,
                        rotation: 90.,
                    },
                ],
                holes: vec![Hole {
                    x: 5.,
                    y: 20.,
                    radius: 1.5,
                }],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for id in &self.ids {
                let _ = std::fs::remove_file(crate::staged_artwork::path(id).unwrap());
            }
        }
    }
    fn inflate(bytes: &[u8]) -> Vec<u8> {
        use std::io::Read;
        let mut out = vec![];
        flate2::read::ZlibDecoder::new(bytes)
            .read_to_end(&mut out)
            .unwrap();
        out
    }
    #[test]
    fn same_and_different_back_keep_real_ink_data_white_and_window_separate() {
        let rgb = Profile::new_srgb();
        let icc = Profile::new_icc(ICC).unwrap();
        let transform = Transform::new(
            &rgb,
            PixelFormat::RGB_8,
            &icc,
            PixelFormat::CMYK_8,
            Intent::RelativeColorimetric,
        )
        .unwrap();
        let client = reqwest::blocking::Client::new();
        for different in [false, true] {
            for window in [false, true] {
                let mut f = Fixture::new();
                let job = f.job(different, window);
                let data =
                    convert_source(&job, &job.sources[0], &client, &transform, |_| {}).unwrap();
                let inks = inflate(&data.inks);
                let mask = inflate(&data.mask);
                let w = data.width as usize;
                let sample = |fraction: f64| {
                    ((fraction * data.height as f64) as usize * w + (fraction * w as f64) as usize)
                        * 9
                };
                let middle = sample(0.5);
                let edge = sample(0.15);
                assert_eq!(inks.len(), w * data.height as usize * 9);
                assert_eq!(inks[middle + 4], 255, "White interior is full strength");
                assert_eq!(inks[edge + 4], 0, "window cannot add White");
                assert_eq!(mask[edge / 9], if window { 255 } else { 0 });
                if window {
                    let layers = data
                        .layers
                        .as_ref()
                        .expect("window documents retain editable layers");
                    let image_alpha = inflate(&layers.image.planes[4]);
                    let window = layers.window.as_ref().unwrap();
                    let window_alpha = inflate(&window.planes[4]);
                    assert_eq!(
                        image_alpha[edge / 9],
                        0,
                        "window never enters picture layer"
                    );
                    assert_eq!(image_alpha[middle / 9], 255);
                    assert_eq!(
                        window_alpha[edge / 9],
                        192,
                        "two half-transparent windows merge in both modes"
                    );
                    assert_eq!(
                        window_alpha[middle / 9],
                        192,
                        "window under picture is retained"
                    );
                    for c in 0..4 {
                        let image = inflate(&layers.image.planes[c]);
                        assert_eq!(image[edge / 9], 0);
                        let mut red = [[0; 4]];
                        transform.transform_pixels(&[[255, 0, 0]], &mut red);
                        assert_eq!(
                            image[middle / 9],
                            red[0][c],
                            "picture keeps its original CMYK"
                        );
                        let win = inflate(&window.planes[c]);
                        assert_eq!(
                            inks[edge + c],
                            ((win[edge / 9] as u32 * 192 + 127) / 255) as u8
                        );
                    }
                } else {
                    assert!(data.layers.is_none());
                }
                if different {
                    assert_ne!(&inks[middle..middle + 4], &inks[middle + 5..middle + 9]);
                } else {
                    assert_eq!(&inks[middle..middle + 4], &inks[middle + 5..middle + 9]);
                }
            }
        }
    }
    #[test]
    fn pictures_without_own_window_are_retained_in_a_mixed_layered_board() {
        let mut f = Fixture::new();
        let mut job = f.job(false, true);
        let mut no_window = job.sources[0].clone();
        no_window.key = "without-window".into();
        no_window.window_id = None;
        job.sources.push(no_window);
        let data = convert_source(
            &job,
            &job.sources[1],
            &reqwest::blocking::Client::new(),
            &color_transform().unwrap(),
            |_| {},
        )
        .unwrap();
        let layers = data.layers.as_ref().unwrap();
        assert!(layers.window.is_none());
        assert!(inflate(&layers.image.planes[4]).contains(&255));
    }
    #[test]
    fn invalid_missing_back_and_out_of_board_placements_are_rejected() {
        let mut f = Fixture::new();
        let mut job = f.job(false, false);
        job.different_back = true;
        assert!(job.validate().unwrap_err().contains("正背图层"));
        job.different_back = false;
        job.placements[0].x = 299.;
        assert!(job.validate().unwrap_err().contains("超出板材"));
    }
    #[test]
    #[ignore = "Exports four real nine-ink PDF fixtures or an externally staged job"]
    fn export_validation_fixture() {
        let output = std::env::var("PRINTFLOW_CMYK_OUTPUT").expect("PRINTFLOW_CMYK_OUTPUT");
        if let Ok(id) = std::env::var("PRINTFLOW_CMYK_JOB_ID") {
            let job = Job::load(&id).unwrap();
            let start = std::time::Instant::now();
            let pdf = render_job(
                &job,
                std::env::var("PRINTFLOW_CMYK_WORKERS")
                    .ok()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(1),
                |i, p| eprintln!("{i} {p}"),
            )
            .unwrap();
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&output)
                .unwrap();
            file.write_all(&pdf).unwrap();
            eprintln!(
                "CMYK: {} sources, {} copies, {} bytes, {:?}",
                job.sources.len(),
                job.placements.len(),
                pdf.len(),
                start.elapsed()
            );
        } else {
            for (i, (different, window)) in
                [(false, false), (true, false), (false, true), (true, true)]
                    .iter()
                    .enumerate()
            {
                let mut f = Fixture::new();
                let job = f.job(*different, *window);
                let pdf = render_job(&job, 2, |_, _| {}).unwrap();
                let path = std::path::Path::new(&output).join(format!("mode-{}.pdf", i + 1));
                let mut file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(path)
                    .unwrap();
                file.write_all(&pdf).unwrap();
            }
        }
    }
}
