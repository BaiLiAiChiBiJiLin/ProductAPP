//! Lossless PNG conversion with row-sized RGB/alpha buffers. The upstream path
//! held decoded RGBA, cloned RGBA, RGB and mask planes at the same time.
use std::io::{Cursor, Read, Seek, SeekFrom, Write};

use flate2::{write::ZlibEncoder, Compression};
use image::ColorType;
use pdf_writer::{Chunk, Filter, Ref};
use png::{BitDepth, Transformations};
use usvg::Size;

use crate::{util::context::Context, ConversionError::InvalidImage, Result};

struct Planes {
    color: ZlibEncoder<Vec<u8>>,
    alpha: Option<ZlibEncoder<Vec<u8>>>,
    color_row: Vec<u8>,
    alpha_row: Vec<u8>,
    channels: usize,
    bytes: usize,
    has_alpha: bool,
    transparent: bool,
}

impl Planes {
    fn row(&mut self, row: &[u8]) -> Result<()> {
        self.color_row.clear();
        self.alpha_row.clear();
        if self.has_alpha {
            let stride = self.channels * self.bytes;
            for pixel in row.chunks_exact(stride) {
                let split = stride - self.bytes;
                self.color_row.extend_from_slice(&pixel[..split]);
                self.alpha_row.extend_from_slice(&pixel[split..]);
                self.transparent |= pixel[split..].iter().any(|b| *b != 255);
            }
            self.color
                .write_all(&self.color_row)
                .map_err(|_| InvalidImage)?;
            self.alpha
                .as_mut()
                .unwrap()
                .write_all(&self.alpha_row)
                .map_err(|_| InvalidImage)?;
        } else {
            self.color.write_all(row).map_err(|_| InvalidImage)?;
        }
        Ok(())
    }
}

pub(super) fn write_png(chunk: &mut Chunk, ctx: &mut Context, data: &[u8]) -> Result<(Ref, Size)> {
    let mut decoder = png::Decoder::new(Cursor::new(data));
    // Expand palette/low-bit grayscale/tRNS, but retain 16-bit precision.
    decoder.set_transformations(Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(|_| InvalidImage)?;
    let info = reader.info();
    let (width, height, interlaced) = (info.width, info.height, info.interlaced);
    if width > i32::MAX as u32 || height > i32::MAX as u32 {
        return Err(InvalidImage);
    }
    let (color, depth) = reader.output_color_type();
    let channels = color.samples();
    let bytes = if depth == BitDepth::Sixteen { 2 } else { 1 };
    let (has_alpha, output_color) = match (color, bytes) {
        (png::ColorType::Grayscale, 1) => (false, ColorType::L8),
        (png::ColorType::Grayscale, 2) => (false, ColorType::L16),
        (png::ColorType::GrayscaleAlpha, 1) => (true, ColorType::La8),
        (png::ColorType::GrayscaleAlpha, 2) => (true, ColorType::La16),
        (png::ColorType::Rgb, 1) => (false, ColorType::Rgb8),
        (png::ColorType::Rgb, 2) => (false, ColorType::Rgb16),
        (png::ColorType::Rgba, 1) => (true, ColorType::Rgba8),
        (png::ColorType::Rgba, 2) => (true, ColorType::Rgba16),
        _ => return Err(InvalidImage),
    };
    let mut planes = Planes {
        color: ZlibEncoder::new(Vec::new(), Compression::default()),
        alpha: has_alpha.then(|| ZlibEncoder::new(Vec::new(), Compression::default())),
        color_row: Vec::new(),
        alpha_row: Vec::new(),
        channels,
        bytes,
        has_alpha,
        transparent: false,
    };
    if interlaced {
        // Spool the seven Adam7 passes, then assemble one final row at a time.
        // A 131 MP RGBA image otherwise needs a 500 MiB contiguous frame.
        // tempfile's anonymous file is closed/deleted on every return path.
        let mut spool = tempfile::tempfile().map_err(|_| InvalidImage)?;
        let passes = [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ];
        let stride = channels * bytes;
        let mut offsets = [0u64; 7];
        let mut row_sizes = [0usize; 7];
        let mut offset = 0u64;
        for (pass, &(x, y, dx, dy)) in passes.iter().enumerate() {
            offsets[pass] = offset;
            let columns = width.saturating_sub(x).div_ceil(dx);
            if columns == 0 {
                continue;
            }
            let row_size = columns as usize * stride;
            row_sizes[pass] = row_size;
            for _ in 0..height.saturating_sub(y).div_ceil(dy) {
                let row = reader
                    .next_row()
                    .map_err(|_| InvalidImage)?
                    .ok_or(InvalidImage)?;
                if row.data().len() != row_size {
                    return Err(InvalidImage);
                }
                spool.write_all(row.data()).map_err(|_| InvalidImage)?;
                offset += row_size as u64;
            }
        }
        if reader.next_row().map_err(|_| InvalidImage)?.is_some() {
            return Err(InvalidImage);
        }
        let mut row = vec![0; width as usize * stride];
        let mut pass_row = Vec::new();
        for y in 0..height {
            for (pass, &(start_x, start_y, dx, dy)) in passes.iter().enumerate() {
                let row_size = row_sizes[pass];
                if row_size == 0 || y < start_y || (y - start_y) % dy != 0 {
                    continue;
                }
                let index = (y - start_y) / dy;
                spool
                    .seek(SeekFrom::Start(
                        offsets[pass] + index as u64 * row_size as u64,
                    ))
                    .map_err(|_| InvalidImage)?;
                pass_row.resize(row_size, 0);
                spool.read_exact(&mut pass_row).map_err(|_| InvalidImage)?;
                for (i, pixel) in pass_row.chunks_exact(stride).enumerate() {
                    let x = start_x as usize + i * dx as usize;
                    row[x * stride..(x + 1) * stride].copy_from_slice(pixel);
                }
            }
            planes.row(&row)?;
        }
    } else {
        let mut rows = 0;
        while let Some(row) = reader.next_row().map_err(|_| InvalidImage)? {
            planes.row(row.data())?;
            rows += 1;
        }
        if rows != height {
            return Err(InvalidImage);
        }
    }
    let color = planes.color.finish().map_err(|_| InvalidImage)?;
    let alpha = planes
        .alpha
        .map(|a| a.finish())
        .transpose()
        .map_err(|_| InvalidImage)?;
    Ok(super::write_raster_image(
        chunk,
        ctx,
        &color,
        Filter::FlateDecode,
        width,
        height,
        output_color,
        alpha.as_deref().filter(|_| planes.transparent),
    ))
}
