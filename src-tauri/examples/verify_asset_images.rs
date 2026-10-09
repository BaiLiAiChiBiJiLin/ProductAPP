//! cargo test --example verify_asset_images
fn main() {
    let Some(path) = std::env::args().nth(1) else { return };
    let started = std::time::Instant::now();
    let assets = app_lib::assets::import_with_stage(std::path::Path::new(&path), "", "auto", "pixel-audit", |_, _, _| {}, |_| {}).expect("import failed");
    let images: Vec<_> = assets.iter().flat_map(|asset| asset.source_images.iter().flatten()).collect();
    assert!(!assets.is_empty() && !images.is_empty());
    assert!(images.iter().all(|image| image.width_px > 0 && image.height_px > 0));
    assert!(images.iter().all(|image| image.width_mm.unwrap_or(0.0) > 0.0 && image.height_mm.unwrap_or(0.0) > 0.0));
    println!("assets={} raster_images={} metadata_bytes={} elapsed={:?}", assets.len(), images.len(), serde_json::to_vec(&images).unwrap().len(), started.elapsed());
    for image in images.iter().take(4) { println!("{} {} {}x{} px, {:.3}x{:.3} mm", image.node_id, image.format, image.width_px, image.height_px, image.width_mm.unwrap(), image.height_mm.unwrap()); }
}

#[cfg(test)]
mod tests {
    use app_lib::assets::{Asset, import_with_stage};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Cursor;

    fn raster(width: u32, height: u32, format: image::ImageFormat) -> String {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([180, 60, 30]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        let mime = if format == image::ImageFormat::Png { "png" } else { "jpeg" };
        format!("data:image/{mime};base64,{}", STANDARD.encode(bytes.into_inner()))
    }

    fn import(source: &str, mode: &str) -> Vec<Asset> {
        let file = std::env::temp_dir().join(format!("asset-images-{}-{}.svg", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::write(&file, source).unwrap();
        let result = import_with_stage(&file, "", mode, "pixel-test", |_, _, _| {}, |_| {});
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
        std::fs::remove_file(file).unwrap();
        result.unwrap()
    }

    #[test]
    fn split_assets_keep_each_rasters_original_pixels_and_bytes() {
        let png = raster(37, 59, image::ImageFormat::Png);
        let jpeg = raster(71, 43, image::ImageFormat::Jpeg);
        let source = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 1000 1000">
          <defs><clipPath id="cut"><rect width="5" height="8"/></clipPath></defs>
          <g id="图层_1"><g id="multi" transform="translate(100 100) scale(2)">
            <image id="photo" width="10" height="20" clip-path="url(#cut)" href="{png}"/>
            <image id="back" x="40" width="20" height="10" transform="rotate(10)" href="{jpeg}"/>
          </g><g id="vector"><rect x="300" y="300" width="50" height="80" fill="none" stroke="red"/></g></g>
        </svg>"##);
        let assets = import(&source, "auto");
        assert_eq!(assets.len(), 2);
        let images = assets[0].source_images.as_ref().unwrap();
        assert_eq!(images.len(), 2);
        assert_eq!((&*images[0].node_id, images[0].width_px, images[0].height_px, &*images[0].format), ("photo", 37, 59, "PNG"));
        assert_eq!((&*images[1].node_id, images[1].width_px, images[1].height_px, &*images[1].format), ("back", 71, 43, "JPEG"));
        // preserveAspectRatio=meet fits each raster to its authored rectangle;
        // the parent scales by 2 and the root maps 10 user units to 1 mm.
        // ClipPath and rotation must not replace the full-image edge lengths.
        assert!((images[0].width_mm.unwrap() - 2.0).abs() < 0.001);
        assert!((images[0].height_mm.unwrap() - 2.0 * 59.0 / 37.0).abs() < 0.001);
        assert!((images[1].width_mm.unwrap() - 2.0 * 71.0 / 43.0).abs() < 0.001);
        assert!((images[1].height_mm.unwrap() - 2.0).abs() < 0.001);
        assert!(assets[0].svg.contains(&png) && assets[0].svg.contains(&jpeg));
        assert!(assets[1].source_images.as_ref().unwrap().is_empty());

        // Same compact JSON payload used by batch history. No SVG is needed
        // to recover the metadata after a database save/load.
        let mut saved = assets[0].clone();
        saved.svg.clear();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE assets(payload TEXT)", []).unwrap();
        conn.execute("INSERT INTO assets VALUES(?1)", [serde_json::to_string(&saved).unwrap()]).unwrap();
        let json: String = conn.query_row("SELECT payload FROM assets", [], |row| row.get(0)).unwrap();
        assert!(json.contains("\"sourceImages\"") && json.contains("\"widthPx\":37"));
        let restored: Asset = serde_json::from_str(&json).unwrap();
        let restored_images = restored.source_images.as_ref().unwrap();
        assert_eq!(restored_images.len(), images.len());
        for (restored, original) in restored_images.iter().zip(images) {
            assert_eq!((&restored.node_id, &restored.format, restored.width_px, restored.height_px),
                (&original.node_id, &original.format, original.width_px, original.height_px));
            assert!((restored.width_mm.unwrap() - original.width_mm.unwrap()).abs() < 1e-12);
            assert!((restored.height_mm.unwrap() - original.height_mm.unwrap()).abs() < 1e-12);
        }
        assert_eq!(restored.source_group_width_mm, saved.source_group_width_mm);
    }

    #[test]
    fn legacy_unknown_is_distinct_from_a_new_vector_asset() {
        let old: Asset = serde_json::from_value(serde_json::json!({ "id":"old", "name":"old", "productId":"", "width":10, "height":20, "svg":"<svg/>" })).unwrap();
        assert!(old.source_images.is_none());
        let pixels_only: app_lib::assets::SourceImage = serde_json::from_value(serde_json::json!({"nodeId":"old", "widthPx":100, "heightPx":200, "format":"PNG"})).unwrap();
        assert!(pixels_only.width_mm.is_none() && pixels_only.height_mm.is_none());
        let assets = import(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="10" height="20"/></svg>"#, "whole");
        assert_eq!(assets[0].source_images, Some(Vec::new()));
    }

    #[test]
    fn nested_vector_svg_does_not_report_its_viewport_as_raster_pixels() {
        let nested = STANDARD.encode(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="200"/></svg>"#);
        let assets = import(&format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><image width="10" height="20" href="data:image/svg+xml;base64,{nested}"/></svg>"#), "whole");
        let images = assets[0].source_images.as_ref().unwrap();
        assert!(images.is_empty());
    }

    #[test]
    fn image_mm_keeps_edge_lengths_under_rotation_mirror_and_nonuniform_scale() {
        let png = raster(37, 59, image::ImageFormat::Png);
        let source = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 1000 500"><g transform="translate(500 200) rotate(30)"><g transform="matrix(-2 0 0 3 0 0)"><image id="transformed" width="40" height="20" preserveAspectRatio="none" href="{png}"/></g></g></svg>"#);
        let assets = import(&source, "whole");
        let image = &assets[0].source_images.as_ref().unwrap()[0];
        assert!((image.width_mm.unwrap() - 16.0).abs() < 0.001);
        assert!((image.height_mm.unwrap() - 12.0).abs() < 0.001);
        assert_eq!((image.width_px, image.height_px), (37, 59));
        assert_eq!(assets[0].svg, source);
    }
}
