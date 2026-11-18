//! Reduce PNGs by reading scanlines; never allocate their full pixel canvas.
use std::{
    io::Read,
    time::{Duration, Instant},
};

pub(crate) struct ReducedPng {
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

const MAX_EDGE: u32 = 65_536;
const MAX_PIXELS: u64 = 1024 * 1024 * 1024;
const ADAM7: [(u32, u32, u32, u32); 7] = [
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
];

pub(crate) fn reduce(source: impl Read, edge: u32) -> Result<ReducedPng, String> {
    let start = Instant::now();
    let mut decoder = png::Decoder::new_with_limits(
        source,
        png::Limits {
            bytes: 16 * 1024 * 1024,
        },
    );
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| "PNG 预览头部读取失败")?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("PNG 尺寸超过逐行预览预算".into());
    }
    let ratio = (edge.clamp(1, 4096) as f64 / width.max(height) as f64).min(1.0);
    let out_width = (width as f64 * ratio).round().max(1.0) as u32;
    let out_height = (height as f64 * ratio).round().max(1.0) as u32;
    let xs: Vec<u32> = (0..out_width)
        .map(|x| {
            (((u64::from(x) * 2 + 1) * u64::from(width)) / (u64::from(out_width) * 2))
                .min(u64::from(width - 1)) as u32
        })
        .collect();
    let ys: Vec<u32> = (0..out_height)
        .map(|y| {
            (((u64::from(y) * 2 + 1) * u64::from(height)) / (u64::from(out_height) * 2))
                .min(u64::from(height - 1)) as u32
        })
        .collect();
    let (color, depth) = reader.output_color_type();
    if depth != png::BitDepth::Eight {
        return Err("PNG 预览颜色深度不支持".into());
    }
    let channels = match color {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err("PNG 预览调色板未展开".into()),
    };
    let mut rgba = vec![0u8; out_width as usize * out_height as usize * 4];
    let mut remaining = out_width as usize * out_height as usize;
    let passes: &[(u32, u32, u32, u32)] = if reader.info().interlaced {
        &ADAM7
    } else {
        &[(0, 0, 1, 1)]
    };
    for &(start_x, start_y, step_x, step_y) in passes {
        if start_x >= width || start_y >= height {
            continue;
        }
        for source_y in (start_y..height).step_by(step_y as usize) {
            if start.elapsed() > Duration::from_secs(90) {
                return Err("PNG 预览处理超时".into());
            }
            let row = reader
                .next_row()
                .map_err(|_| "PNG 预览扫描行读取失败")?
                .ok_or("PNG 预览扫描行不完整")?;
            let Ok(out_y) = ys.binary_search(&source_y) else {
                continue;
            };
            for (out_x, &source_x) in xs.iter().enumerate() {
                if source_x < start_x || (source_x - start_x) % step_x != 0 {
                    continue;
                }
                let offset = ((source_x - start_x) / step_x) as usize * channels;
                let pixel = row
                    .data()
                    .get(offset..offset + channels)
                    .ok_or("PNG 预览扫描行长度无效")?;
                let value = match color {
                    png::ColorType::Grayscale => [pixel[0], pixel[0], pixel[0], 255],
                    png::ColorType::GrayscaleAlpha => [pixel[0], pixel[0], pixel[0], pixel[1]],
                    png::ColorType::Rgb => [pixel[0], pixel[1], pixel[2], 255],
                    png::ColorType::Rgba => [pixel[0], pixel[1], pixel[2], pixel[3]],
                    png::ColorType::Indexed => unreachable!(),
                };
                let output = (out_y * out_width as usize + out_x) * 4;
                rgba[output..output + 4].copy_from_slice(&value);
                remaining -= 1;
            }
        }
    }
    if remaining != 0
        || reader
            .next_row()
            .map_err(|_| "PNG 预览尾部校验失败")?
            .is_some()
    {
        return Err("PNG 预览像素不完整".into());
    }
    reader.finish().map_err(|_| "PNG 预览文件不完整")?;
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, out_width, out_height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder
            .write_header()
            .map_err(|_| "PNG 预览编码失败")?
            .write_image_data(&rgba)
            .map_err(|_| "PNG 预览像素编码失败")?;
    }
    Ok(ReducedPng { width, height, png })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    pub(crate) fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().unwrap();
        {
            let mut stream = writer.stream_writer().unwrap();
            let row: Vec<u8> = [200, 40, 60, 255].repeat(width as usize);
            for _ in 0..height {
                stream.write_all(&row).unwrap();
            }
            stream.finish().unwrap();
        }
        writer.finish().unwrap();
        bytes
    }

    #[test]
    fn a_6400_square_png_uses_scanlines_and_returns_a_small_complete_image() {
        let bytes = solid_png(6400, 6400);
        let reduced = reduce(Cursor::new(bytes), 256).unwrap();
        assert_eq!((reduced.width, reduced.height), (6400, 6400));
        let bitmap = tiny_skia::Pixmap::decode_png(&reduced.png).unwrap();
        assert_eq!((bitmap.width(), bitmap.height()), (256, 256));
        assert!(bitmap
            .data()
            .chunks_exact(4)
            .all(|pixel| pixel == [200, 40, 60, 255]));
    }

    fn append_chunk(png: &mut Vec<u8>, name: &[u8; 4], bytes: &[u8]) {
        png.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        png.extend_from_slice(name);
        png.extend_from_slice(bytes);
        let mut crc = u32::MAX;
        for &byte in name.iter().chain(bytes) {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        png.extend_from_slice(&(!crc).to_be_bytes());
    }

    #[test]
    fn interlaced_rgba_rows_keep_pixel_positions_and_transparency() {
        let (width, height) = (37u32, 29u32);
        let pixel = |x: u32, y: u32| [x as u8 * 6, y as u8 * 8, 90, ((x + y) * 3) as u8];
        let mut raw = Vec::new();
        // Encode the seven Adam7 passes without a full frame buffer.
        for &(sx, sy, dx, dy) in &ADAM7 {
            if sx >= width || sy >= height {
                continue;
            }
            for y in (sy..height).step_by(dy as usize) {
                raw.push(0); // unfiltered row
                for x in (sx..width).step_by(dx as usize) {
                    raw.extend_from_slice(&pixel(x, y));
                }
            }
        }
        let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        zlib.write_all(&raw).unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut header = Vec::new();
        header.extend_from_slice(&width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 1]);
        append_chunk(&mut png, b"IHDR", &header);
        append_chunk(&mut png, b"IDAT", &zlib.finish().unwrap());
        append_chunk(&mut png, b"IEND", &[]);
        for edge in [1, 17, 512] {
            let reduced = reduce(Cursor::new(&png), edge).unwrap();
            let bitmap = image::load_from_memory(&reduced.png).unwrap().into_rgba8();
            for (x, y, actual) in bitmap.enumerate_pixels() {
                let sx = ((u64::from(x) * 2 + 1) * u64::from(width)
                    / (u64::from(bitmap.width()) * 2)) as u32;
                let sy = ((u64::from(y) * 2 + 1) * u64::from(height)
                    / (u64::from(bitmap.height()) * 2)) as u32;
                assert_eq!(actual.0, pixel(sx, sy), "edge={edge}, x={x}, y={y}");
            }
        }
    }

    #[test]
    fn palette_transparency_and_16_bit_gray_expand_before_sampling() {
        for gray in [false, true] {
            let mut bytes = Vec::new();
            let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
            if gray {
                encoder.set_color(png::ColorType::GrayscaleAlpha);
                encoder.set_depth(png::BitDepth::Sixteen);
            } else {
                encoder.set_color(png::ColorType::Indexed);
                encoder.set_depth(png::BitDepth::One);
                encoder.set_palette(vec![20, 40, 60, 100, 120, 140]);
                encoder.set_trns(vec![255, 128]);
            }
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(if gray {
                    &[60, 0, 255, 0, 90, 0, 128, 0]
                } else {
                    &[0b01000000]
                })
                .unwrap();
            writer.finish().unwrap();
            let reduced = reduce(Cursor::new(bytes), 512).unwrap();
            let bitmap = image::load_from_memory(&reduced.png).unwrap().into_rgba8();
            let expected = if gray {
                vec![60, 60, 60, 255, 90, 90, 90, 128]
            } else {
                vec![20, 40, 60, 255, 100, 120, 140, 128]
            };
            assert_eq!(bitmap.into_raw(), expected);
        }
    }

    #[test]
    fn incomplete_or_corrupt_pngs_never_return_partial_previews() {
        let bytes = solid_png(8, 8);
        for cut in [8, bytes.len() / 2, bytes.len() - 8] {
            assert!(reduce(Cursor::new(&bytes[..cut]), 256).is_err());
        }
        let mut corrupt = bytes;
        let len = corrupt.len();
        corrupt[len - 1] ^= 1;
        assert!(reduce(Cursor::new(corrupt), 256).is_err());
    }
}
