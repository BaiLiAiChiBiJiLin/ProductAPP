use serde::Deserialize;

pub const A4_PAGE_SIZE_PT: (f32, f32) = (595.2756, 841.8898);

/// This controls only the PDF's raster resources, never stored artwork or layout.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchematicPdfQuality {
    #[default]
    Standard,
    High,
    Original,
}

impl SchematicPdfQuality {
    pub fn conversion_options(self) -> svg2pdf::ConversionOptions {
        svg2pdf::ConversionOptions {
            raster_image_dpi: match self {
                Self::Standard => Some(200.0),
                Self::High => Some(300.0),
                Self::Original => None,
            },
            raster_image_page_size: Some(A4_PAGE_SIZE_PT),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_contract_defaults_to_standard_and_keeps_original_lossless() {
        assert_eq!(
            SchematicPdfQuality::default()
                .conversion_options()
                .raster_image_dpi,
            Some(200.0)
        );
        for (name, dpi) in [
            ("standard", Some(200.0)),
            ("high", Some(300.0)),
            ("original", None),
        ] {
            let quality: SchematicPdfQuality =
                serde_json::from_str(&format!("\"{name}\"")).unwrap();
            let options = quality.conversion_options();
            assert_eq!(options.raster_image_dpi, dpi);
            assert_eq!(options.raster_image_page_size, Some(A4_PAGE_SIZE_PT));
            assert!(options.embed_text);
        }
        assert!(serde_json::from_str::<SchematicPdfQuality>("\"unknown\"").is_err());
        // Other PDF exporters still use the library's original-image default.
        assert_eq!(svg2pdf::ConversionOptions::default().raster_image_dpi, None);
    }

    /// Exercise the application's actual flatten/font/convert/merge pipeline.
    /// The fixture is a read-only snapshot made with prepare-pdf-benchmark.mjs.
    #[test]
    #[ignore = "Requires a local real batch snapshot; writes three comparison PDFs"]
    fn compare_real_batch_pdf_quality() {
        let fixture = std::env::var("PRINTFLOW_PDF_FIXTURE")
            .unwrap_or_else(|_| "../.test-output/pdf-quality/pages.json".into());
        let directory = std::env::var("PRINTFLOW_PDF_COMPARISON_DIR")
            .unwrap_or_else(|_| "../.test-output/pdf-quality".into());
        let pages: Vec<String> = serde_json::from_slice(&std::fs::read(&fixture).unwrap()).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let mut results = Vec::new();
        for (name, quality) in [
            ("original", SchematicPdfQuality::Original),
            ("standard", SchematicPdfQuality::Standard),
            ("high", SchematicPdfQuality::High),
        ] {
            let output = std::path::Path::new(&directory).join(format!("{name}.pdf"));
            let started = std::time::Instant::now();
            tauri::async_runtime::block_on(crate::export_pdf_sources(
                output.to_string_lossy().into_owned(),
                pages.clone(),
                None,
                false,
                quality,
            ))
            .expect("real batch PDF export failed");
            let row = serde_json::json!({
                "quality": name, "pages": pages.len(),
                "bytes": std::fs::metadata(&output).unwrap().len(),
                "seconds": started.elapsed().as_secs_f64(),
            });
            eprintln!("{row}");
            results.push(row);
        }
        std::fs::write(
            std::path::Path::new(&directory).join("export-comparison.json"),
            serde_json::to_vec_pretty(&results).unwrap(),
        )
        .unwrap();
    }
}
