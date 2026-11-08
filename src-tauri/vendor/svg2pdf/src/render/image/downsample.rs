//! Resolution planning is independent of PDF rendering, whose isolated groups
//! intentionally reset their coordinate systems. Source image sizes never change
//! in the SVG tree; only the emitted PDF image samples are reduced.
use std::{collections::HashMap, sync::Arc};

use usvg::{Group, ImageKind, Node, Transform, Tree};

use crate::ConversionOptions;

pub(super) fn resource(kind: &ImageKind) -> Option<(u8, &Arc<Vec<u8>>)> {
    match kind {
        ImageKind::JPEG(bytes) => Some((0, bytes)),
        ImageKind::PNG(bytes) => Some((1, bytes)),
        ImageKind::GIF(bytes) => Some((2, bytes)),
        ImageKind::WEBP(bytes) => Some((3, bytes)),
        ImageKind::SVG(_) => None,
    }
}

type Scales = HashMap<(u8, usize), f32>;

pub(crate) fn image_scales(tree: &Tree, options: ConversionOptions) -> Scales {
    let mut scales = Scales::new();
    let Some(dpi) = options
        .raster_image_dpi
        .filter(|dpi| dpi.is_finite() && *dpi > 0.0)
    else {
        return scales;
    };
    let (width, height) = options
        .raster_image_page_size
        .unwrap_or((tree.size().width() * 0.75, tree.size().height() * 0.75));
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return scales;
    }
    let root = Transform::from_scale(
        width / tree.size().width() * dpi / 72.0,
        height / tree.size().height() * dpi / 72.0,
    );
    collect(tree.root(), root, &mut scales);
    scales
}

fn retain_original(group: &Group, scales: &mut Scales) {
    for node in group.children() {
        if let Node::Image(image) = node {
            if let Some((format, bytes)) = resource(image.kind()) {
                scales.insert((format, Arc::as_ptr(bytes) as usize), 1.0);
            }
        }
        if let Node::Group(group) = node {
            retain_original(group, scales);
        }
        node.subroots(|subroot| retain_original(subroot, scales));
    }
}

fn collect(group: &Group, outer: Transform, scales: &mut Scales) {
    for node in group.children() {
        match node {
            Node::Group(group) => collect(group, outer, scales),
            Node::Image(image) if image.is_visible() => {
                let transform = outer.pre_concat(image.abs_transform());
                if let ImageKind::SVG(tree) = image.kind() {
                    collect(tree.root(), transform, scales);
                } else if let Some((format, bytes)) = resource(image.kind()) {
                    // Length of transformed source pixel axes handles rotation,
                    // mirroring, skew and non-uniform page scaling. A uniform
                    // sampling scale retains enough pixels for either axis.
                    let scale = transform
                        .sx
                        .hypot(transform.ky)
                        .max(transform.kx.hypot(transform.sy))
                        .clamp(0.0, 1.0);
                    if scale.is_finite() && scale > 0.0 {
                        let key = (format, Arc::as_ptr(bytes) as usize);
                        scales
                            .entry(key)
                            .and_modify(|value| *value = value.max(scale))
                            .or_insert(scale);
                    }
                }
            }
            _ => {}
        }
        // Pattern and mask roots have independent coordinate systems and can be
        // referenced at several scales. Conservatively keep their source pixels.
        // Nested SVG images above are handled with their actual placement.
        if !matches!(node, Node::Image(_)) {
            node.subroots(|subroot| retain_original(subroot, scales));
        }
    }
}

pub(super) fn target_size(width: u32, height: u32, scale: f32) -> Option<(u32, u32)> {
    if !scale.is_finite() || scale <= 0.0 || scale >= 1.0 {
        return None;
    }
    let target = (
        ((width as f64 * scale as f64).ceil() as u32).clamp(1, width),
        ((height as f64 * scale as f64).ceil() as u32).clamp(1, height),
    );
    (target != (width, height)).then_some(target)
}

/// Streaming area filter. At most one source row and three destination rows are
/// resident, even for an interlaced 16-bit PNG. Colors are accumulated with
/// premultiplied alpha, then unpremultiplied before writing the PDF color plane.
pub(super) struct AreaSampler {
    width: u32,
    target_width: u32,
    target_height: u32,
    channels: usize,
    bytes: usize,
    alpha: bool,
    ratio_x: f64,
    ratio_y: f64,
    source_y: u32,
    target_y: u32,
    horizontal: Vec<f64>,
    sum: Vec<f64>,
    output: Vec<u8>,
}

impl AreaSampler {
    pub(super) fn new(
        width: u32,
        height: u32,
        target: (u32, u32),
        channels: usize,
        bytes: usize,
        alpha: bool,
    ) -> Self {
        let samples = target.0 as usize * channels;
        Self {
            width,
            target_width: target.0,
            target_height: target.1,
            channels,
            bytes,
            alpha,
            ratio_x: width as f64 / target.0 as f64,
            ratio_y: height as f64 / target.1 as f64,
            source_y: 0,
            target_y: 0,
            horizontal: vec![0.0; samples],
            sum: vec![0.0; samples],
            output: vec![0; samples * bytes],
        }
    }

    pub(super) fn row<E>(
        &mut self,
        row: &[u8],
        mut emit: impl FnMut(&[u8]) -> Result<(), E>,
    ) -> Result<(), E> {
        let max = if self.bytes == 2 { 65535.0 } else { 255.0 };
        self.horizontal.fill(0.0);
        for x in 0..self.target_width {
            let left = x as f64 * self.ratio_x;
            let right = (x + 1) as f64 * self.ratio_x;
            let output = x as usize * self.channels;
            for source_x in (left.floor() as u32)..(right.ceil() as u32).min(self.width) {
                let weight =
                    (right.min(source_x as f64 + 1.0) - left.max(source_x as f64)) / self.ratio_x;
                let source = source_x as usize * self.channels * self.bytes;
                let sample = |channel: usize| -> f64 {
                    let at = source + channel * self.bytes;
                    if self.bytes == 2 {
                        u16::from_be_bytes([row[at], row[at + 1]]) as f64
                    } else {
                        row[at] as f64
                    }
                };
                let alpha = if self.alpha {
                    sample(self.channels - 1) / max
                } else {
                    1.0
                };
                for channel in 0..self.channels {
                    let value = if self.alpha && channel == self.channels - 1 {
                        alpha
                    } else {
                        sample(channel) * alpha
                    };
                    self.horizontal[output + channel] += value * weight;
                }
            }
        }
        let start = self.source_y as f64;
        let end = start + 1.0;
        while self.target_y < self.target_height {
            let top = self.target_y as f64 * self.ratio_y;
            let bottom = (self.target_y + 1) as f64 * self.ratio_y;
            let weight = end.min(bottom) - start.max(top);
            if weight > 0.0 {
                for (sum, horizontal) in self.sum.iter_mut().zip(&self.horizontal) {
                    *sum += horizontal * weight;
                }
            }
            if end + 1e-9 < bottom {
                break;
            }
            for x in 0..self.target_width as usize {
                let base = x * self.channels;
                let alpha_sum = if self.alpha {
                    self.sum[base + self.channels - 1]
                } else {
                    self.ratio_y
                };
                for channel in 0..self.channels {
                    let value = if self.alpha && channel == self.channels - 1 {
                        alpha_sum / self.ratio_y * max
                    } else if alpha_sum > 0.0 {
                        self.sum[base + channel] / alpha_sum
                    } else {
                        0.0
                    };
                    let value = value.round().clamp(0.0, max) as u16;
                    let offset = (base + channel) * self.bytes;
                    if self.bytes == 2 {
                        self.output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
                    } else {
                        self.output[offset] = value as u8;
                    }
                }
            }
            emit(&self.output)?;
            self.sum.fill(0.0);
            self.target_y += 1;
            if end <= bottom + 1e-9 {
                break;
            }
        }
        self.source_y += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_bytes() -> Arc<Vec<u8>> {
        let mut output = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut output, 800, 600);
            encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            let pixels: Vec<u8> = (0..800 * 600)
                .flat_map(|index| {
                    [
                        255,
                        (index % 256) as u8,
                        0,
                        if index % 2 == 0 { 128 } else { 255 },
                    ]
                })
                .collect();
            writer.write_image_data(&pixels).unwrap();
        }
        Arc::new(output)
    }

    fn parse(svg: &str, bytes: Arc<Vec<u8>>) -> Tree {
        parse_kind(svg, ImageKind::PNG(bytes))
    }

    fn parse_kind(svg: &str, kind: ImageKind) -> Tree {
        let mut options = usvg::Options::default();
        options.image_href_resolver.resolve_string = Box::new(move |_, _| Some(kind.clone()));
        Tree::from_str(svg, &options).unwrap()
    }

    fn jpeg_bytes(width: u32, height: u32, quality: u8) -> Arc<Vec<u8>> {
        let mut seed = 42u32;
        let image = image::RgbImage::from_fn(width, height, |_, _| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            image::Rgb([(seed >> 16) as u8, (seed >> 8) as u8, seed as u8])
        });
        let mut output = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&image)
            .unwrap();
        Arc::new(output)
    }

    #[test]
    fn jpeg_downsampling_keeps_dct_and_original_logical_placement() {
        let bytes = jpeg_bytes(800, 600, 95);
        let tree = parse_kind(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><image href="image.jpg" width="200" height="150"/></svg>"#,
            ImageKind::JPEG(bytes.clone()),
        );
        let small = crate::to_pdf(
            &tree,
            ConversionOptions {
                compress: false,
                ..options()
            },
            Default::default(),
        )
        .unwrap();
        let text = String::from_utf8_lossy(&small);
        assert!(text.contains("/Width 200"));
        assert!(text.contains("/Height 150"));
        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("800 0 0 -600 0 600 cm"));
        assert!(small.len() < bytes.len());
    }

    #[test]
    fn small_jpeg_is_not_upscaled_or_reencoded() {
        let bytes = jpeg_bytes(16, 12, 50);
        let tree = parse_kind(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><image href="image.jpg" width="200" height="150"/></svg>"#,
            ImageKind::JPEG(bytes.clone()),
        );
        let pdf = crate::to_pdf(&tree, options(), Default::default()).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Width 16"));
        assert!(pdf
            .windows(bytes.len())
            .any(|chunk| chunk == bytes.as_slice()));
    }

    #[test]
    fn already_small_jpeg_payload_is_not_made_larger() {
        let bytes = jpeg_bytes(800, 600, 1);
        let tree = parse_kind(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><image href="image.jpg" width="360" height="270"/></svg>"#,
            ImageKind::JPEG(bytes.clone()),
        );
        let pdf = crate::to_pdf(
            &tree,
            ConversionOptions {
                raster_image_dpi: Some(288.0),
                ..options()
            },
            Default::default(),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Width 800"));
        assert!(pdf
            .windows(bytes.len())
            .any(|chunk| chunk == bytes.as_slice()));
    }

    fn options() -> ConversionOptions {
        ConversionOptions {
            raster_image_dpi: Some(144.0),
            raster_image_page_size: Some((200.0, 150.0)),
            ..ConversionOptions::default()
        }
    }

    #[test]
    fn physical_page_rotation_mirror_and_opacity_keep_the_required_density() {
        let bytes = image_bytes();
        let key = (1, Arc::as_ptr(&bytes) as usize);
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g transform="translate(300 250) rotate(90) scale(-1 1)" opacity="0.7"><image href="image.png" width="200" height="150"/></g></svg>"#;
        let tree = parse(svg, bytes);
        assert!((image_scales(&tree, options())[&key] - 0.25).abs() < 1e-6);
        assert!(image_scales(&tree, ConversionOptions::default()).is_empty());
    }

    #[test]
    fn a_shared_source_uses_its_largest_placement_before_rendering() {
        let bytes = image_bytes();
        let key = (1, Arc::as_ptr(&bytes) as usize);
        let tree = parse(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><image href="image.png" width="80" height="60"/><image href="image.png" width="400" height="300"/></svg>"#,
            bytes,
        );
        assert_eq!(image_scales(&tree, options())[&key], 0.5);
    }

    #[test]
    fn nested_svg_includes_its_outer_image_placement() {
        let bytes = image_bytes();
        let key = (1, Arc::as_ptr(&bytes) as usize);
        let inner = parse(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><image href="image.png" width="200" height="150"/></svg>"#,
            bytes,
        );
        let mut parser = usvg::Options::default();
        parser.image_href_resolver.resolve_string =
            Box::new(move |_, _| Some(ImageKind::SVG(inner.clone())));
        let tree = Tree::from_str(r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><image href="inner.svg" width="100" height="75"/></svg>"#, &parser).unwrap();
        assert_eq!(image_scales(&tree, options())[&key], 0.0625);
    }

    #[test]
    fn image_samples_shrink_but_pdf_placement_and_vectors_do_not() {
        let bytes = image_bytes();
        let original_bytes = bytes.clone();
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><path d="M0 0L400 300" stroke="blue"/><image href="image.png" width="200" height="150"/></svg>"#;
        let tree = parse(svg, bytes);
        let small = crate::to_pdf(
            &tree,
            ConversionOptions {
                compress: false,
                ..options()
            },
            Default::default(),
        )
        .unwrap();
        let original = crate::to_pdf(
            &tree,
            ConversionOptions {
                compress: false,
                ..ConversionOptions::default()
            },
            Default::default(),
        )
        .unwrap();
        let small_text = String::from_utf8_lossy(&small);
        let original_text = String::from_utf8_lossy(&original);
        assert!(small_text.contains("/Width 200"));
        assert!(small_text.contains("/Height 150"));
        assert!(small_text.contains("/SMask"));
        assert!(original_text.contains("/Width 800"));
        assert!(original_text.contains("/Height 600"));
        assert!(small_text.contains("800 0 0 -600 0 600 cm"));
        assert!(original_text.contains("800 0 0 -600 0 600 cm"));
        // Both conversion passes only read the Arc backing the source image.
        assert_eq!(&**original_bytes, &*image_bytes());
    }

    #[test]
    fn does_not_upscale_or_discard_last_pixel() {
        assert_eq!(target_size(100, 201, 0.5), Some((50, 101)));
        assert_eq!(target_size(100, 201, 2.0), None);
        assert_eq!(target_size(1, 1, 0.1), None);
    }

    #[test]
    fn alpha_filter_does_not_mix_hidden_black_into_visible_red() {
        let mut sampler = AreaSampler::new(2, 2, (1, 1), 4, 1, true);
        let mut rows = Vec::new();
        let row = [255, 0, 0, 255, 0, 0, 0, 0];
        for _ in 0..2 {
            sampler
                .row(&row, |row| {
                    rows.push(row.to_vec());
                    Ok::<_, ()>(())
                })
                .unwrap();
        }
        assert_eq!(rows, vec![vec![255, 0, 0, 128]]);
    }

    #[test]
    fn area_filter_preserves_sixteen_bit_gray_and_non_integer_coverage() {
        let mut sampler = AreaSampler::new(3, 3, (2, 2), 1, 2, false);
        let mut rows = Vec::new();
        for value in [0u16, 30000, 60000] {
            let row: Vec<u8> = [value; 3].into_iter().flat_map(u16::to_be_bytes).collect();
            sampler
                .row(&row, |row| {
                    rows.push(row.to_vec());
                    Ok::<_, ()>(())
                })
                .unwrap();
        }
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            [10000u16; 2]
                .into_iter()
                .flat_map(u16::to_be_bytes)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            rows[1],
            [50000u16; 2]
                .into_iter()
                .flat_map(u16::to_be_bytes)
                .collect::<Vec<_>>()
        );
    }
}
