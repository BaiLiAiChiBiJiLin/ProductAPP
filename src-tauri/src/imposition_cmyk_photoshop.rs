//! Photoshop round-trip data. A valid DeviceN PDF alone opens as four raster
//! channels in Photoshop. PieceInfo's Alph records restore its five spot inks.
//! Window documents also carry Layr records for independent picture/window layers.
//! Generated independently from the PSD block structure (no Photoshop runtime).
use crate::imposition_cmyk::{Converted, Job, SourceLayers, INKS};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use pdf_writer::{Filter, Finish, Name, Pdf, Ref};
use std::{
    collections::HashMap,
    io::{Read, Write},
};

pub(crate) struct Source {
    width: usize,
    height: usize,
    planes: [Vec<u8>; 9],
    layers: Option<std::sync::Arc<SourceLayers>>,
}
impl Source {
    pub(crate) fn new(data: &Converted) -> Result<Self, String> {
        // Deinterleave a unique source once, one scanline at a time. Keep only
        // compressed planes, shared by every QT, never nine full-board buffers.
        let mut input = ZlibDecoder::new(data.inks.as_slice());
        let mut encoders: [_; 9] =
            std::array::from_fn(|_| ZlibEncoder::new(Vec::new(), Compression::new(3)));
        let mut row = vec![0; data.width as usize * 9];
        let mut plane = vec![0; data.width as usize];
        for _ in 0..data.height {
            input.read_exact(&mut row).map_err(|e| e.to_string())?;
            for (c, encoder) in encoders.iter_mut().enumerate() {
                for (x, value) in plane.iter_mut().enumerate() {
                    *value = row[x * 9 + c];
                }
                encoder.write_all(&plane).map_err(|e| e.to_string())?;
            }
        }
        let mut planes: [Vec<u8>; 9] = Default::default();
        for (c, encoder) in encoders.into_iter().enumerate() {
            planes[c] = encoder.finish().map_err(|e| e.to_string())?;
        }
        Ok(Self {
            width: data.width as usize,
            height: data.height as usize,
            planes,
            layers: data.layers.clone(),
        })
    }
}

fn compressed(bytes: &[u8], invert: bool) -> Result<Vec<u8>, String> {
    let mut zip = ZlibEncoder::new(Vec::new(), Compression::new(3));
    for chunk in bytes.chunks(64 * 1024) {
        if invert {
            let row: Vec<_> = chunk.iter().map(|v| 255 - v).collect();
            zip.write_all(&row).map_err(|e| e.to_string())?;
        } else {
            zip.write_all(chunk).map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(|e| e.to_string())
}
fn new_ref(next: &mut i32) -> Ref {
    let r = Ref::new(*next);
    *next += 1;
    r
}
fn block(key: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = b"8BIM".to_vec();
    out.extend(key);
    out.extend((data.len() as u32).to_be_bytes());
    out.extend(data);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out
}
pub(crate) fn alpha_metadata() -> Vec<u8> {
    let mut alpha = Vec::new();
    alpha.extend(9u32.to_be_bytes());
    alpha.extend(5u32.to_be_bytes());
    for (i, name) in INKS[4..].iter().enumerate() {
        let mut record = Vec::new();
        record.extend((4 + i as u32).to_be_bytes());
        record.extend((-1i32).to_be_bytes());
        let mut unicode = (name.len() as u32).to_be_bytes().to_vec();
        for value in *name {
            unicode.extend((*value as u16).to_be_bytes());
        }
        record.extend(block(b"name", &unicode));
        record.extend(block(b"kind", b"8BIMspot"));
        record.extend(block(b"opac", &[255]));
        let mut color = 2u16.to_be_bytes().to_vec();
        for c in 0..4 {
            color.extend(
                if c == (if i == 0 { 3 } else { i - 1 }) {
                    0u16
                } else {
                    u16::MAX
                }
                .to_be_bytes(),
            );
        }
        record.extend(block(b"colr", &color));
        record.extend(block(b"id  ", &(i as u32 + 3).to_be_bytes()));
        alpha.extend((record.len() as u32).to_be_bytes());
        alpha.extend(record);
    }
    block(b"Alph", &alpha)
}
fn resolution(dpi: u32) -> Vec<u8> {
    let mut data = Vec::new();
    for _ in 0..2 {
        data.extend((dpi << 16).to_be_bytes());
        data.extend(1u16.to_be_bytes());
        data.extend(2u16.to_be_bytes());
    }
    let mut out = b"8BIM".to_vec();
    out.extend(1005u16.to_be_bytes());
    out.extend([0, 0]);
    out.extend(16u32.to_be_bytes());
    out.extend(data);
    out
}

fn board_plane(
    job: &Job,
    sources: &HashMap<String, Source>,
    channel: usize,
    width: usize,
    height: usize,
    layer: Option<usize>,
) -> Result<Vec<u8>, String> {
    let mut board = Vec::new();
    board
        .try_reserve_exact(width * height)
        .map_err(|_| "内存不足，无法生成 Photoshop 整板通道")?;
    board.resize(width * height, 0);
    let sx = width as f64 / job.width_mm;
    let sy = height as f64 / job.height_mm;
    for specification in &job.sources {
        let source = sources
            .get(&specification.key)
            .ok_or("Photoshop 图片通道缓存缺失")?;
        let plane = if let Some(index) = layer {
            let layers = source.layers.as_ref().ok_or("Photoshop 独立图层缓存缺失")?;
            if index == 0 {
                &layers.image.planes[channel]
            } else if let Some(window) = &layers.window {
                &window.planes[channel]
            } else {
                continue;
            }
        } else {
            &source.planes[channel]
        };
        let mut pixels = Vec::with_capacity(source.width * source.height);
        ZlibDecoder::new(plane.as_slice())
            .read_to_end(&mut pixels)
            .map_err(|e| e.to_string())?;
        if pixels.len() != source.width * source.height {
            return Err("Photoshop 图片通道长度无效".into());
        }
        for p in job
            .placements
            .iter()
            .filter(|p| p.source_key == specification.key)
        {
            let (sin, cos) = p.rotation.to_radians().sin_cos();
            let bw = cos.abs() * p.width + sin.abs() * p.height;
            let bh = sin.abs() * p.width + cos.abs() * p.height;
            let cx = p.x + bw / 2.;
            let cy = p.y + bh / 2.;
            let x0 = (p.x * sx).floor().max(0.) as usize;
            let x1 = ((p.x + bw) * sx).ceil().min(width as f64) as usize;
            let y0 = (p.y * sy).floor().max(0.) as usize;
            let y1 = ((p.y + bh) * sy).ceil().min(height as f64) as usize;
            for y in y0..y1 {
                let dy = (y as f64 + 0.5) / sy - cy;
                let mut ux = (cos * ((x0 as f64 + 0.5) / sx - cx) + sin * dy + p.width / 2.)
                    * source.width as f64
                    / p.width;
                let mut uy = (-sin * ((x0 as f64 + 0.5) / sx - cx) + cos * dy + p.height / 2.)
                    * source.height as f64
                    / p.height;
                let dx = cos / sx * source.width as f64 / p.width;
                let dy = -sin / sx * source.height as f64 / p.height;
                for x in x0..x1 {
                    if ux >= 0. && uy >= 0. && ux < source.width as f64 && uy < source.height as f64
                    {
                        let value = pixels[uy as usize * source.width + ux as usize];
                        // Nonzero channel overprint matches the PDF's OPM=1.
                        if value != 0 {
                            board[y * width + x] = value;
                        }
                    }
                    ux += dx;
                    uy += dy;
                }
            }
        }
    }
    // Registration marks belong to the picture layer, including its alpha,
    // and to the flattened K/K2 inks. Never add marks to the window layer.
    if match layer {
        None => channel == 3 || channel == 8,
        Some(0) => channel == 3 || channel == 4,
        _ => false,
    } {
        let bx = (0.2 * sx - 0.5).ceil().max(0.) as usize;
        let by = (0.2 * sy - 0.5).ceil().max(0.) as usize;
        for (y, row) in board.chunks_exact_mut(width).enumerate() {
            if y < by || y >= height.saturating_sub(by) {
                row.fill(255);
            } else {
                row[..bx.min(width)].fill(255);
                row[width.saturating_sub(bx)..].fill(255);
            }
        }
        for h in &job.holes {
            let x0 = ((h.x - h.radius) * sx).floor().max(0.) as usize;
            let x1 = ((h.x + h.radius) * sx).ceil().clamp(0., width as f64) as usize;
            let y0 = ((h.y - h.radius) * sy).floor().max(0.) as usize;
            let y1 = ((h.y + h.radius) * sy).ceil().clamp(0., height as f64) as usize;
            for y in y0..y1 {
                let dy = (y as f64 + 0.5) / sy - h.y;
                for x in x0..x1 {
                    let dx = (x as f64 + 0.5) / sx - h.x;
                    if dx * dx + dy * dy <= h.radius * h.radius {
                        board[y * width + x] = 255;
                    }
                }
            }
        }
    }
    Ok(board)
}

struct EditableLayer {
    name: &'static str,
    planes: [Vec<u8>; 5],
}

/// Photoshop's PDF Layr block uses bottom-to-top records. CMYK channel bytes
/// are inverted, alpha is not; each channel has its own ZIP stream (PSD ZIP=2).
/// Keep this independent of Alph, which describes the document's spot inks.
fn layer_metadata(
    width: usize,
    height: usize,
    layers: &[EditableLayer],
) -> Result<Vec<u8>, String> {
    if width > 30_000 || height > 30_000 {
        return Err("Photoshop 可编辑图层宽高不能超过 30000 像素，请拆分板材".into());
    }
    let mut records = (layers.len() as i16).to_be_bytes().to_vec();
    for layer in layers {
        records.extend(0i32.to_be_bytes());
        records.extend(0i32.to_be_bytes());
        records.extend((height as i32).to_be_bytes());
        records.extend((width as i32).to_be_bytes());
        records.extend(5u16.to_be_bytes());
        for c in 0..5 {
            records.extend((if c == 0 { -1i16 } else { c as i16 - 1 }).to_be_bytes());
            let channel = if c == 0 { 4 } else { c - 1 };
            let length = u32::try_from(layer.planes[channel].len() + 2)
                .map_err(|_| "Photoshop 单图层通道超过文件格式上限")?;
            records.extend(length.to_be_bytes());
        }
        records.extend(b"8BIMnorm");
        records.extend([255, 0, 0, 0]);
        let unicode: Vec<_> = layer.name.encode_utf16().collect();
        let mut name = (unicode.len() as u32).to_be_bytes().to_vec();
        for c in unicode {
            name.extend(c.to_be_bytes());
        }
        // Empty mask, blending ranges and padded Pascal name; luni supplies
        // the actual Unicode name without depending on Windows' code page.
        let mut extra = vec![0; 12];
        extra.extend(block(b"luni", &name));
        records.extend((extra.len() as u32).to_be_bytes());
        records.extend(extra);
    }
    let payload = layers
        .iter()
        .flat_map(|layer| &layer.planes)
        .try_fold(records.len(), |total, plane| {
            total.checked_add(plane.len() + 2)
        })
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("Photoshop 图层数据超过文件格式上限")?;
    let mut out = Vec::new();
    out.try_reserve_exact(payload as usize + 12 + 4 + 568)
        .map_err(|_| "内存不足，无法封装 Photoshop 独立图层")?;
    out.extend(b"8BIMLayr");
    out.extend(payload.to_be_bytes());
    out.extend(records);
    for layer in layers {
        for c in [4, 0, 1, 2, 3] {
            out.extend(2u16.to_be_bytes());
            out.extend(&layer.planes[c]);
        }
    }
    while out.len() % 4 != 0 {
        out.push(0);
    }
    Ok(out)
}

pub(crate) fn write_roundtrip(
    pdf: &mut Pdf,
    next: &mut i32,
    job: &Job,
    sources: &HashMap<String, Source>,
    report: impl Fn(usize),
) -> Result<Ref, String> {
    let width = (job.width_mm / 25.4 * job.dpi as f64).round().max(1.) as usize;
    let height = (job.height_mm / 25.4 * job.dpi as f64).round().max(1.) as usize;
    let pixels = width
        .checked_mul(height)
        .ok_or("Photoshop 整板像素尺寸超出范围")?;
    let has_windows = job.sources.iter().any(|s| s.window_id.is_some());
    if has_windows && (width > 30_000 || height > 30_000) {
        return Err("Photoshop 可编辑图层宽高不能超过 30000 像素，请拆分板材".into());
    }
    if pixels > 250_000_000
        || crate::imposition_pdf_runtime::worker_memory()
            .is_some_and(|free| free < pixels.saturating_mul(3).saturating_add(64 * 1024 * 1024))
    {
        return Err("可用内存不足以合成 Photoshop 通道，请释放内存或改为 300 ppi 后重试".into());
    }
    let composite = new_ref(next);
    let spots = new_ref(next);
    let resources = new_ref(next);
    let standard = new_ref(next);
    let private = new_ref(next);
    let mut process: [Vec<u8>; 4] = Default::default();
    let mut spot_refs = vec![];
    for c in 0..9 {
        report(c);
        let plane = board_plane(job, sources, c, width, height, None)?;
        if c < 4 {
            process[c] = compressed(&plane, false)?;
        } else {
            let id = new_ref(next);
            let data = compressed(&plane, true)?;
            let mut image = pdf.image_xobject(id, &data);
            image
                .width(width as i32)
                .height(height as i32)
                .bits_per_component(8)
                .filter(Filter::FlateDecode);
            image.color_space().device_gray();
            image.finish();
            spot_refs.push(id);
        }
    }
    // Merge four compressed scanline streams; never allocate full-board CMYK.
    let mut streams = process
        .iter()
        .map(|v| ZlibDecoder::new(v.as_slice()))
        .collect::<Vec<_>>();
    let mut rows = vec![vec![0; width]; 4];
    let mut interleaved = vec![0; width * 4];
    let mut zip = ZlibEncoder::new(Vec::new(), Compression::new(3));
    for _ in 0..height {
        for c in 0..4 {
            streams[c]
                .read_exact(&mut rows[c])
                .map_err(|e| e.to_string())?;
        }
        for x in 0..width {
            for c in 0..4 {
                interleaved[x * 4 + c] = rows[c][x];
            }
        }
        zip.write_all(&interleaved).map_err(|e| e.to_string())?;
    }
    let data = zip.finish().map_err(|e| e.to_string())?;
    let mut image = pdf.image_xobject(composite, &data);
    image
        .width(width as i32)
        .height(height as i32)
        .bits_per_component(8)
        .filter(Filter::FlateDecode);
    image.color_space().icc_based(Ref::new(6));
    image.finish();
    let mut spot_dict = pdf.indirect(spots).dict();
    for (i, r) in spot_refs.into_iter().enumerate() {
        spot_dict.pair(Name(format!("Im{}", i + 1).as_bytes()), r);
    }
    spot_dict.finish();
    pdf.stream(resources, &resolution(job.dpi));
    let mut editing = Vec::new();
    if has_windows {
        let mut layers = Vec::with_capacity(2);
        for (index, name) in [(1, "彩窗"), (0, "图片")] {
            let mut planes: [Vec<u8>; 5] = Default::default();
            for (c, data) in planes.iter_mut().enumerate() {
                if crate::imposition_pdf_runtime::worker_memory().is_some_and(|free| {
                    free < pixels.saturating_mul(3).saturating_add(64 * 1024 * 1024)
                }) {
                    return Err(
                        "可用内存不足以生成独立图层，请释放内存或改为 300 ppi 后重试".into(),
                    );
                }
                report(9 + index * 5 + c);
                let plane = board_plane(job, sources, c, width, height, Some(index))?;
                *data = compressed(&plane, c < 4)?;
            }
            layers.push(EditableLayer { name, planes });
        }
        editing = layer_metadata(width, height, &layers)?;
    }
    editing.extend(alpha_metadata());
    let editing_size = editing.len();
    pdf.stream(standard, &editing);
    drop(editing);
    let mut native = pdf.indirect(private).dict();
    native
        .pair(Name(b"RoundTrip"), true)
        .pair(Name(b"CompositeImage"), composite)
        .pair(Name(b"ImageResources"), resources)
        .pair(Name(b"StandardImageFileData"), standard)
        .pair(
            Name(b"StandardImageFileLength"),
            i32::try_from(editing_size).map_err(|_| "Photoshop 图层数据超过文件格式上限")?,
        );
    native
        .insert(Name(b"SpotChannels"))
        .dict()
        .pair(Name(b"N"), 5)
        .pair(Name(b"XObject"), spots);
    Ok(private)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editable_layers_keep_unicode_names_channel_order_and_zip_pixels() {
        let layers: Vec<_> = ["彩窗", "图片"]
            .into_iter()
            .map(|name| EditableLayer {
                name,
                planes: std::array::from_fn(|c| compressed(&[c as u8 * 40; 6], c < 4).unwrap()),
            })
            .collect();
        let data = layer_metadata(3, 2, &layers).unwrap();
        assert_eq!(&data[..8], b"8BIMLayr");
        assert_eq!(i16::from_be_bytes(data[12..14].try_into().unwrap()), 2);
        let mut offset = 14;
        let mut lengths = vec![];
        for name in ["彩窗", "图片"] {
            assert_eq!(
                i32::from_be_bytes(data[offset + 8..offset + 12].try_into().unwrap()),
                2
            );
            assert_eq!(
                i32::from_be_bytes(data[offset + 12..offset + 16].try_into().unwrap()),
                3
            );
            offset += 18;
            for expected in [-1i16, 0, 1, 2, 3] {
                assert_eq!(
                    i16::from_be_bytes(data[offset..offset + 2].try_into().unwrap()),
                    expected
                );
                lengths.push(
                    u32::from_be_bytes(data[offset + 2..offset + 6].try_into().unwrap()) as usize,
                );
                offset += 6;
            }
            offset += 12;
            let extra = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            let unicode: Vec<_> = name.encode_utf16().flat_map(u16::to_be_bytes).collect();
            assert!(data[offset..offset + extra]
                .windows(unicode.len())
                .any(|w| w == unicode));
            offset += extra;
        }
        for (i, length) in lengths.into_iter().enumerate() {
            assert_eq!(&data[offset..offset + 2], &[0, 2]);
            let mut pixels = vec![];
            ZlibDecoder::new(&data[offset + 2..offset + length])
                .read_to_end(&mut pixels)
                .unwrap();
            let c = [4, 0, 1, 2, 3][i % 5];
            assert_eq!(pixels, vec![if c == 4 { 160 } else { 255 - c * 40 }; 6]);
            offset += length;
        }
    }
    #[test]
    fn generated_spot_metadata_has_five_ordered_full_density_inks() {
        let data = alpha_metadata();
        assert_eq!(&data[..8], b"8BIMAlph");
        assert_eq!(data.len(), 568);
        assert_eq!(&data[12..20], &[0, 0, 0, 9, 0, 0, 0, 5]);
        for name in INKS[4..].iter() {
            let unicode: Vec<_> = name
                .iter()
                .flat_map(|v| (*v as u16).to_be_bytes())
                .collect();
            assert!(data.windows(unicode.len()).any(|w| w == unicode));
        }
    }
    #[test]
    fn roundtrip_planes_follow_canvas_rotation_and_marks_only_enter_black_inks() {
        use crate::imposition_cmyk::{Hole, Offset, Placement, Source as Specification};
        let job = Job {
            width_mm: 10.,
            height_mm: 12.,
            dpi: 300,
            different_back: false,
            auto_align: false,
            sources: vec![Specification {
                key: "art".into(),
                label: "art".into(),
                width_mm: 2.,
                height_mm: 1.,
                front_id: String::new(),
                back_id: None,
                window_id: None,
                back_offset: Offset::default(),
                window_offset: Offset::default(),
            }],
            placements: vec![Placement {
                source_key: "art".into(),
                x: 2.,
                y: 3.,
                width: 2.,
                height: 1.,
                rotation: 90.,
            }],
            holes: vec![Hole {
                x: 8.,
                y: 8.,
                radius: 0.5,
            }],
        };
        let data = Converted {
            width: 2,
            height: 1,
            inks: compressed(&[100; 18], false).unwrap(),
            mask: compressed(&[255; 2], false).unwrap(),
            layers: None,
            window_skipped: false,
        };
        let sources = HashMap::from([("art".into(), Source::new(&data).unwrap())]);
        for c in 0..9 {
            let plane = board_plane(&job, &sources, c, 100, 120, None).unwrap();
            assert_eq!(plane[40 * 100 + 25], 100, "rotated image channel {c}");
            assert_eq!(plane[25 * 100 + 40], 0, "unrotated frame must stay empty");
            assert_eq!(plane[80 * 100 + 80], if c == 3 || c == 8 { 255 } else { 0 });
            assert_eq!(plane[0], if c == 3 || c == 8 { 255 } else { 0 });
        }
    }
}
