use std::io::Cursor;
use std::sync::Arc;

use crate::ConversionError::InvalidImage;
use image::{ColorType, DynamicImage, ImageFormat, Luma, Rgb, Rgba};
use miniz_oxide::deflate::{compress_to_vec_zlib, CompressionLevel};
use pdf_writer::{Chunk, Content, Filter, Finish, Ref};
use usvg::{ImageKind, Rect, Size, Transform, Tree};

use crate::render::tree_to_xobject;
use crate::util::context::Context;
use crate::util::helper::{ContentExt, NameExt, TransformExt};
use crate::util::resources::ResourceContainer;
use crate::Result;

pub(crate) mod downsample;
mod png;

/// Render an image into a content stream.
pub fn render(
    is_visible: bool,
    kind: &ImageKind,
    view_box: Option<Rect>,
    chunk: &mut Chunk,
    content: &mut Content,
    ctx: &mut Context,
    rc: &mut ResourceContainer,
) -> Result<()> {
    if !is_visible {
        return Ok(());
    }

    let load_with_format = |content, format| {
        image::load_from_memory_with_format(content, format).map_err(|_| InvalidImage)
    };

    // Will return the name of the image (in the Resources dictionary) and the dimensions of the
    // actual image (i.e. the actual image size, not the size in the PDF, which will always be 1x1
    // because that's how ImageXObjects are scaled by default.
    let resource = downsample::resource(kind);
    let key = resource.map(|(format, bytes)| (format, Arc::as_ptr(bytes) as usize));
    let scale = key
        .and_then(|key| ctx.image_scales.get(&key))
        .copied()
        .unwrap_or(1.0);
    let cached = key.and_then(|key| ctx.images.get(&key).map(|(_, id, size)| (*id, *size)));
    let (image_ref, image_size) = if let Some(cached) = cached {
        cached
    } else {
        match kind {
            ImageKind::JPEG(content) => {
                // PDF keeps the original JPEG stream. Read its header only.
                let decoder =
                    image::codecs::jpeg::JpegDecoder::new(Cursor::new(content.as_slice()))
                        .map_err(|_| InvalidImage)?;
                use image::ImageDecoder;
                let (width, height) = decoder.dimensions();
                let color = decoder.color_type();
                // The original path can embed huge JPEGs without decoding. Keep
                // that ability when an export-only optimization would require a
                // large full-frame buffer (the decoder has no reduced-size API).
                const MAX_JPEG_DECODE_BYTES: u64 = 128 * 1024 * 1024;
                if let Some((target_width, target_height)) =
                    downsample::target_size(width, height, scale)
                        .filter(|_| decoder.total_bytes() <= MAX_JPEG_DECODE_BYTES)
                {
                    let image = DynamicImage::from_decoder(decoder).map_err(|_| InvalidImage)?;
                    let resized = resize_decoded_image(image, target_width, target_height);
                    let mut encoded = Vec::new();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 90)
                        .encode_image(&resized)
                        .map_err(|_| InvalidImage)?;
                    // A low-quality source JPEG can already be smaller than a
                    // high-quality reduced copy. Never increase its payload.
                    let (samples, sample_width, sample_height, sample_color) =
                        if encoded.len() < content.len() {
                            (
                                encoded.as_slice(),
                                target_width,
                                target_height,
                                resized.color(),
                            )
                        } else {
                            (content.as_slice(), width, height, color)
                        };
                    let (id, _) = write_raster_image(
                        chunk,
                        ctx,
                        samples,
                        Filter::DctDecode,
                        sample_width,
                        sample_height,
                        sample_color,
                        None,
                    );
                    (
                        id,
                        Size::from_wh(width as f32, height as f32).ok_or(InvalidImage)?,
                    )
                } else {
                    write_raster_image(
                        chunk,
                        ctx,
                        content,
                        Filter::DctDecode,
                        width,
                        height,
                        color,
                        None,
                    )
                }
            }
            ImageKind::PNG(content) => png::write_png(chunk, ctx, content, scale)?,
            ImageKind::GIF(content) => {
                let image = load_with_format(content, ImageFormat::Gif)?;
                create_resized_image(chunk, ctx, image, scale)
            }
            ImageKind::WEBP(content) => {
                let image = load_with_format(content, ImageFormat::WebP)?;
                create_resized_image(chunk, ctx, image, scale)
            }
            // SVGs just get rendered recursively.
            ImageKind::SVG(tree) => create_svg_image(tree, chunk, ctx)?,
        }
    };
    if let (Some(key), Some((_, bytes))) = (key, resource) {
        ctx.images
            .entry(key)
            .or_insert_with(|| (bytes.clone(), image_ref, image_size));
    }
    let image_name = rc.add_x_object(image_ref);

    let view_box = view_box
        .unwrap_or(Rect::from_xywh(0.0, 0.0, image_size.width(), image_size.height()).unwrap());

    content.save_state_checked()?;

    // Account for the x/y of the viewbox.
    content.transform(Transform::from_translate(view_box.x(), view_box.y()).to_pdf_transform());

    // Scale the image from 1x1 to the actual dimensions.
    content.transform(
        Transform::from_row(
            view_box.width(),
            0.0,
            0.0,
            -view_box.height(),
            0.0,
            view_box.height(),
        )
        .to_pdf_transform(),
    );
    content.x_object(image_name.to_pdf_name());
    content.restore_state();

    Ok(())
}

fn create_resized_image(
    chunk: &mut Chunk,
    ctx: &mut Context,
    image: DynamicImage,
    scale: f32,
) -> (Ref, Size) {
    let size = Size::from_wh(image.width() as f32, image.height() as f32).unwrap();
    let image = if let Some((width, height)) =
        downsample::target_size(image.width(), image.height(), scale)
    {
        resize_decoded_image(image, width, height)
    } else {
        image
    };
    let (id, _) = create_transparent_image(chunk, ctx, &image);
    (id, size)
}

fn resize_decoded_image(image: DynamicImage, width: u32, height: u32) -> DynamicImage {
    // JPEG/GIF/WebP decode to 8-bit samples. Keep grayscale and RGB buffers in
    // their compact format; area filtering needs only destination-sized rows.
    let (source_width, source_height) = (image.width(), image.height());
    let image = match image.color() {
        ColorType::L8 | ColorType::La8 | ColorType::Rgb8 | ColorType::Rgba8 => image,
        _ => DynamicImage::ImageRgba8(image.into_rgba8()),
    };
    let color = image.color();
    let channels = color.channel_count() as usize;
    let source = image.into_bytes();
    let mut sampler = downsample::AreaSampler::new(
        source_width,
        source_height,
        (width, height),
        channels,
        1,
        color.has_alpha(),
    );
    let mut output = Vec::with_capacity(width as usize * height as usize * channels);
    for row in source.chunks_exact(source_width as usize * channels) {
        sampler
            .row(row, |row| {
                output.extend_from_slice(row);
                Ok::<_, std::convert::Infallible>(())
            })
            .unwrap();
    }
    match color {
        ColorType::L8 => {
            DynamicImage::ImageLuma8(image::GrayImage::from_raw(width, height, output).unwrap())
        }
        ColorType::La8 => DynamicImage::ImageLumaA8(
            image::GrayAlphaImage::from_raw(width, height, output).unwrap(),
        ),
        ColorType::Rgb8 => {
            DynamicImage::ImageRgb8(image::RgbImage::from_raw(width, height, output).unwrap())
        }
        _ => DynamicImage::ImageRgba8(image::RgbaImage::from_raw(width, height, output).unwrap()),
    }
}

fn create_transparent_image(
    chunk: &mut Chunk,
    ctx: &mut Context,
    image: &DynamicImage,
) -> (Ref, Size) {
    let color = image.color();
    let bits = color.bits_per_pixel();
    let channels = color.channel_count() as u16;

    let encoded_image: Vec<u8> = match (channels, bits / channels > 8) {
        (1 | 2, false) => image.to_luma8().pixels().flat_map(|&Luma(c)| c).collect(),
        (1 | 2, true) => image
            .to_luma16()
            .pixels()
            .flat_map(|&Luma(x)| x)
            .flat_map(|x| x.to_be_bytes())
            .collect(),
        (3 | 4, false) => image.to_rgb8().pixels().flat_map(|&Rgb(c)| c).collect(),
        (3 | 4, true) => image
            .to_rgb16()
            .pixels()
            .flat_map(|&Rgb(c)| c)
            .flat_map(|x| x.to_be_bytes())
            .collect(),
        _ => panic!("unknown number of channels={channels}"),
    };

    let encoded_mask: Option<Vec<u8>> = if color.has_alpha() {
        if bits / channels > 8 {
            let image = image.to_rgba16();

            if image.pixels().any(|&Rgba([.., a])| a != u16::MAX) {
                Some(
                    image
                        .pixels()
                        .flat_map(|&Rgba([.., a])| a.to_be_bytes())
                        .collect(),
                )
            } else {
                None
            }
        } else {
            let image = image.to_rgba8();

            if image.pixels().any(|&Rgba([.., a])| a != u8::MAX) {
                Some(image.pixels().map(|&Rgba([.., a])| a).collect())
            } else {
                None
            }
        }
    } else {
        None
    };

    let compression_level = CompressionLevel::DefaultLevel as u8;
    let compressed_image = compress_to_vec_zlib(&encoded_image, compression_level);
    let compressed_mask = encoded_mask.map(|m| compress_to_vec_zlib(&m, compression_level));

    create_raster_image(
        chunk,
        ctx,
        &compressed_image,
        Filter::FlateDecode,
        image,
        compressed_mask.as_deref(),
    )
}

fn create_raster_image(
    chunk: &mut Chunk,
    ctx: &mut Context,
    samples: &[u8],
    filter: Filter,
    dynamic_image: &DynamicImage,
    alpha_mask: Option<&[u8]>,
) -> (Ref, Size) {
    write_raster_image(
        chunk,
        ctx,
        samples,
        filter,
        dynamic_image.width(),
        dynamic_image.height(),
        dynamic_image.color(),
        alpha_mask,
    )
}

pub(super) fn write_raster_image(
    chunk: &mut Chunk,
    ctx: &mut Context,
    samples: &[u8],
    filter: Filter,
    width: u32,
    height: u32,
    color: ColorType,
    alpha_mask: Option<&[u8]>,
) -> (Ref, Size) {
    let alpha_mask = alpha_mask.map(|mask_bytes| {
        let soft_mask_id = ctx.alloc_ref();
        let mut s_mask = chunk.image_xobject(soft_mask_id, mask_bytes);
        s_mask.filter(filter);
        s_mask.width(width as i32);
        s_mask.height(height as i32);
        s_mask.color_space().device_gray();
        s_mask.bits_per_component(calculate_bits_per_component(color));
        soft_mask_id
    });

    let image_size = Size::from_wh(width as f32, height as f32).unwrap();
    let image_ref = ctx.alloc_ref();

    let mut image_x_object = chunk.image_xobject(image_ref, samples);
    image_x_object.filter(filter);
    image_x_object.width(width as i32);
    image_x_object.height(height as i32);

    let color_space = image_x_object.color_space();
    if color.has_color() {
        color_space.device_rgb();
    } else {
        color_space.device_gray();
    }

    image_x_object.bits_per_component(calculate_bits_per_component(color));
    if let Some(soft_mask_id) = alpha_mask {
        image_x_object.s_mask(soft_mask_id);
    }
    image_x_object.finish();
    (image_ref, image_size)
}

fn calculate_bits_per_component(color_type: ColorType) -> i32 {
    (color_type.bits_per_pixel() / color_type.channel_count() as u16) as i32
}

fn create_svg_image(tree: &Tree, chunk: &mut Chunk, ctx: &mut Context) -> Result<(Ref, Size)> {
    let image_ref = tree_to_xobject(tree, chunk, ctx)?;
    Ok((image_ref, tree.size()))
}
