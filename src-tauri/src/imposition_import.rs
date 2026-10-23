//! Imports artwork into an isolated, temporary production job. The schematic
//! importer owns SVG splitting; this adapter stores files and returns only
//! metadata, never an entire batch of embedded image strings over IPC.
use crate::{assets, production_imposition::ProductionImage};
use serde::Serialize;
use std::{cell::RefCell, fs, path::Path};
use tauri::Emitter;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    request_id: String,
    phase: String,
    completed: usize,
    total: usize,
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryImpositionRecord {
    id: String,
    source_review_id: String,
    customer_name: String,
    output: String,
    submitted_at: String,
    payment_status: String,
    status: String,
    image_count: usize,
    temporary: bool,
    images: Vec<ProductionImage>,
}

fn image_metadata(asset: &assets::Asset, path: &Path) -> Result<ProductionImage, String> {
    let width = f64::from(asset.width);
    let height = f64::from(asset.height);
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(format!("图片 {} 的真实尺寸无效", asset.name));
    }
    // Match saved production assets: authored millimetres take precedence over
    // display-pixel dimensions, provided they describe the same aspect ratio.
    let (width_mm, height_mm) = if asset.source_group_width_mm > 0.0
        && asset.source_group_height_mm > 0.0
        && ((asset.source_group_width_mm / asset.source_group_height_mm) / (width / height))
            .ln()
            .abs()
            <= 0.08
    {
        (asset.source_group_width_mm, asset.source_group_height_mm)
    } else {
        (width * 25.4 / 96.0, height * 25.4 / 96.0)
    };
    serde_json::from_value(serde_json::json!({
        "id": asset.id, "name": asset.name, "sourceFileName": asset.source_file_name,
        "filePath": path.to_string_lossy(), "widthMm": width_mm, "heightMm": height_mm,
        "productId": "", "productName": "", "attributes": { "QT": "1" },
        "attributeImages": {}, "note": "", "noteImage": null, "noteImages": [],
        "productGroupId": "", "productGroupLeaderId": "", "productGroupPosition": 0,
    }))
    .map_err(|error| format!("创建临时拼版图片失败：{error}"))
}

fn import_to_directory(
    source: &Path,
    temporary_root: &Path,
    request_id: &str,
    progress: impl Fn(&str, usize, usize),
) -> Result<TemporaryImpositionRecord, String> {
    if !source
        .extension()
        .is_some_and(|value| value.eq_ignore_ascii_case("svg"))
    {
        return Err("仅支持 SVG 文件".into());
    }
    if !valid_request_id(request_id) {
        return Err("临时拼版请求标识无效".into());
    }
    fs::create_dir_all(temporary_root).map_err(|error| format!("创建临时图片目录失败：{error}"))?;
    let directory = temporary_root.join(request_id);
    // Refuse duplicate requests instead of replacing an existing temporary job.
    fs::create_dir(&directory).map_err(|error| format!("创建临时拼版目录失败：{error}"))?;
    let result = (|| {
        let metadata = RefCell::new(Vec::new());
        let write_error = RefCell::new(None);
        assets::import_with_stage(source, "", "auto", request_id, progress, |asset| {
            if write_error.borrow().is_some() {
                return;
            }
            // Importer ids consist exclusively of the validated request id and
            // a numeric suffix, so an SVG's authored ids cannot become paths.
            let path = directory.join(format!("{}.svg", asset.id));
            let stored = fs::write(&path, asset.svg.as_bytes())
                .map_err(|error| format!("保存临时 SVG 失败：{error}"))
                .and_then(|_| image_metadata(asset, &path));
            match stored {
                Ok(image) => metadata.borrow_mut().push(image),
                Err(error) => *write_error.borrow_mut() = Some(error),
            }
        })?;
        if let Some(error) = write_error.into_inner() {
            return Err(error);
        }
        let images = metadata.into_inner();
        if images.is_empty() {
            return Err("SVG 中没有可用于拼版的图片".into());
        }
        let name = source.file_stem().unwrap_or_default().to_string_lossy();
        Ok(TemporaryImpositionRecord {
            id: format!("imposition-import-{request_id}"),
            source_review_id: String::new(),
            customer_name: format!("{name} 临时文件"),
            output: String::new(),
            submitted_at: chrono::Local::now().to_rfc3339(),
            payment_status: "unpaid".into(),
            status: "pending".into(),
            image_count: images.len(),
            temporary: true,
            images,
        })
    })();
    if result.is_err() {
        // This directory was created above by this request; failure cannot
        // erase another job, an order asset, or the user's original SVG.
        if let Err(error) = fs::remove_dir_all(&directory) {
            log::warn!(
                "清理失败的临时拼版导入失败 {}: {error}",
                directory.display()
            );
        }
    }
    result
}

fn delete_from_directory(temporary_root: &Path, job_id: &str) -> Result<(), String> {
    let request_id = job_id
        .strip_prefix("imposition-import-")
        .filter(|id| valid_request_id(id))
        .ok_or("临时拼版标识无效")?;
    let directory = temporary_root.join(request_id);
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取临时拼版目录失败：{error}")),
    };
    let root = temporary_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    // Resolve and verify the exact absolute target before recursive removal.
    // Never accept a caller-provided path or follow a linked job directory.
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || target.parent() != Some(root.as_path())
    {
        return Err("临时拼版目录超出允许清理的范围".into());
    }
    fs::remove_dir_all(&target).map_err(|error| format!("删除临时拼版文件失败：{error}"))
}

#[tauri::command]
pub async fn delete_imposition_import(job_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        delete_from_directory(
            &crate::project_data_dir()
                .join("temp-assets")
                .join("imposition-imports"),
            &job_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn import_imposition_svg(
    app: tauri::AppHandle,
    path: String,
    request_id: String,
) -> Result<TemporaryImpositionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_to_directory(
            Path::new(&path),
            &crate::project_data_dir()
                .join("temp-assets")
                .join("imposition-imports"),
            &request_id,
            |phase, completed, total| {
                let _ = app.emit(
                    "imposition-import-progress",
                    ImportProgress {
                        request_id: request_id.clone(),
                        phase: phase.to_owned(),
                        completed,
                        total,
                    },
                );
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "printflow-imposition-import-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn source(&self, svg: &str) -> std::path::PathBuf {
            let path = self.0.join("产品.svg");
            fs::write(&path, svg).unwrap();
            path
        }
        fn import(
            &self,
            source: &Path,
            request: &str,
        ) -> Result<TemporaryImpositionRecord, String> {
            import_to_directory(source, &self.0.join("staging"), request, |_, _, _| {})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn deletion_removes_only_the_named_temporary_job_and_keeps_the_source() {
        let fixture = Fixture::new();
        let source = fixture.source(r#"<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm"><path d="M0 0H20V10H0Z" fill="red"/></svg>"#);
        let first = fixture.import(&source, "first").unwrap();
        let second = fixture.import(&source, "second").unwrap();
        let root = fixture.0.join("staging");
        delete_from_directory(&root, &first.id).unwrap();
        assert!(!root.join("first").exists());
        let second = serde_json::to_value(second).unwrap();
        assert!(Path::new(second["images"][0]["filePath"].as_str().unwrap()).exists());
        assert!(source.exists());
        // A repeated click or already-cleaned staging directory is harmless.
        delete_from_directory(&root, &first.id).unwrap();
    }

    #[test]
    fn deletion_rejects_regular_records_paths_and_invalid_request_ids() {
        let fixture = Fixture::new();
        let root = fixture.0.join("staging");
        fs::create_dir(&root).unwrap();
        for id in [
            "regular-job",
            "imposition-import-",
            "imposition-import-..",
            "imposition-import-../staging",
            "imposition-import-C:\\data",
            "imposition-import-test/name",
        ] {
            assert!(delete_from_directory(&root, id).is_err(), "{id}");
            assert!(root.exists());
        }
    }

    #[test]
    fn deletion_refuses_a_file_in_place_of_a_job_directory() {
        let fixture = Fixture::new();
        let root = fixture.0.join("staging");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), "preserve").unwrap();
        assert!(delete_from_directory(&root, "imposition-import-file").is_err());
        assert_eq!(fs::read_to_string(root.join("file")).unwrap(), "preserve");
    }

    #[test]
    fn single_svg_preserves_physical_dimensions_and_only_returns_metadata() {
        let fixture = Fixture::new();
        let source = fixture.source(r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="60mm" viewBox="0 0 400 600"><path d="M0 0H400V600H0Z" fill="red"/></svg>"#);
        let record = fixture.import(&source, "single").unwrap();
        let json = serde_json::to_value(record).unwrap();
        assert_eq!(json["imageCount"], 1);
        assert_eq!(json["customerName"], "产品 临时文件");
        assert_eq!(json["temporary"], true);
        assert!((json["images"][0]["widthMm"].as_f64().unwrap() - 40.0).abs() < 0.001);
        assert!((json["images"][0]["heightMm"].as_f64().unwrap() - 60.0).abs() < 0.001);
        assert_eq!(json["images"][0]["attributes"]["QT"], "1");
        assert!(json["images"][0].get("svg").is_none());
        let stored = fs::read_to_string(json["images"][0]["filePath"].as_str().unwrap()).unwrap();
        assert!(stored.contains("M0 0H400V600H0Z"));
        assert!(source.exists());
    }

    #[test]
    fn large_grouped_svg_splits_into_independent_true_size_files() {
        let fixture = Fixture::new();
        let groups = (0..84)
            .map(|index| {
                format!(
                    r#"<g id="product-{index}"><path d="M{} {}h200v300h-200z" fill="red"/></g>"#,
                    (index % 12) * 500,
                    (index / 12) * 500
                )
            })
            .collect::<String>();
        let source = fixture.source(&format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="600mm" height="400mm" viewBox="0 0 6000 4000">{groups}</svg>"#));
        let record = fixture.import(&source, "large").unwrap();
        assert_eq!(record.image_count, 84);
        let value = serde_json::to_value(record).unwrap();
        for image in value["images"].as_array().unwrap() {
            assert!((image["widthMm"].as_f64().unwrap() - 20.0).abs() < 0.001);
            assert!((image["heightMm"].as_f64().unwrap() - 30.0).abs() < 0.001);
            let svg = fs::read_to_string(image["filePath"].as_str().unwrap()).unwrap();
            assert_eq!(svg.matches("<path ").count(), 1);
            let tree = usvg::Tree::from_str(&svg, &assets::options()).unwrap();
            assert!(!tree.root().children().is_empty());
        }
    }

    #[test]
    fn import_errors_remove_partial_job_without_touching_previous_or_source() {
        let fixture = Fixture::new();
        let source = fixture.source(r#"<svg xmlns="http://www.w3.org/2000/svg"><g>broken"#);
        assert!(fixture.import(&source, "broken").is_err());
        assert!(!fixture.0.join("staging/broken").exists());
        assert!(source.exists());
        let previous = fixture.0.join("staging/previous");
        fs::create_dir(&previous).unwrap();
        fs::write(previous.join("keep.svg"), "keep").unwrap();
        assert!(fixture.import(&source, "previous").is_err());
        assert!(previous.join("keep.svg").exists());
        assert!(fixture.import(&source, "../escape").is_err());
    }

    #[test]
    fn one_product_keeps_its_bitmap_gradient_and_cut_layers_together() {
        use base64::Engine;
        let fixture = Fixture::new();
        let bitmap = tiny_skia::Pixmap::new(2, 2).unwrap().encode_png().unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bitmap);
        let source = fixture.source(&format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="60mm" viewBox="0 0 400 600"><defs><linearGradient id="fill"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><g id="layer"><g id="product"><image id="picture" x="0" y="0" width="400" height="600" href="data:image/png;base64,{encoded}"/><path id="window" fill="url(#fill)" d="M0 0H400V600H0Z"/><path id="cut" fill="none" stroke="magenta" d="M0 0H400V600H0Z"/></g></g></svg>"##));
        let value = serde_json::to_value(fixture.import(&source, "layered").unwrap()).unwrap();
        assert_eq!(value["imageCount"], 1);
        let stored = fs::read_to_string(value["images"][0]["filePath"].as_str().unwrap()).unwrap();
        assert!(stored.contains("id=\"picture\""));
        assert!(stored.contains("id=\"window\""));
        assert!(stored.contains("id=\"cut\""));
        assert!(stored.contains("<linearGradient"));
    }

    #[test]
    #[ignore = "Set PRINTFLOW_IMPORT_TEST_SVG to validate an existing production SVG without changing it"]
    fn real_production_svg_import() {
        let source =
            std::env::var_os("PRINTFLOW_IMPORT_TEST_SVG").expect("PRINTFLOW_IMPORT_TEST_SVG");
        let source = Path::new(&source);
        let expected: usize = std::env::var("PRINTFLOW_IMPORT_TEST_COUNT")
            .unwrap_or_else(|_| "1".into())
            .parse()
            .unwrap();
        let fixture = Fixture::new();
        let before = fs::metadata(source).unwrap();
        let started = std::time::Instant::now();
        let result = fixture.import(source, "real-production").unwrap();
        assert_eq!(result.image_count, expected);
        let value = serde_json::to_value(result).unwrap();
        // Optional real-data solver fixture: use the production splitter and
        // outline extractor, without retaining the source's embedded artwork
        // in a checked-in fixture or changing the original file.
        if let Some(output) = std::env::var_os("PRINTFLOW_IMPORT_TEST_REQUEST") {
            let quantity: usize = std::env::var("PRINTFLOW_IMPORT_TEST_QT")
                .unwrap_or_else(|_| "1".into())
                .parse()
                .unwrap();
            let mut items = Vec::new();
            for image in value["images"].as_array().unwrap() {
                let geometry = tauri::async_runtime::block_on(
                    crate::imposition_algorithms::load_imposition_geometry(
                        image["filePath"].as_str().unwrap().to_owned(),
                        image["widthMm"].as_f64().unwrap(),
                        image["heightMm"].as_f64().unwrap(),
                    ),
                )
                .unwrap();
                let geometry = serde_json::to_value(geometry).unwrap();
                let mut item = image.clone();
                item["quantity"] = serde_json::json!(quantity);
                item["polygon"] = geometry["polygon"].clone();
                item["lineOnly"] = geometry["lineOnly"].clone();
                // Retain split artwork only when explicitly requested in Temp.
                let asset = Path::new(&output)
                    .with_file_name(format!("nesting-source-{}.svg", items.len()));
                fs::copy(image["filePath"].as_str().unwrap(), &asset).unwrap();
                item["filePath"] = serde_json::json!(asset);
                items.push(item);
            }
            let request = serde_json::json!({
                "plateWidthMm": 300, "plateHeightMm": 464,
                "effectiveWidthMm": 285, "effectiveHeightMm": 440,
                "effectiveRightMm": 5, "spacingMm": 3,
                "objective": "least-cutting", "items": items
            });
            fs::write(output, serde_json::to_vec(&request).unwrap()).unwrap();
        }
        for image in value["images"].as_array().unwrap() {
            let svg = fs::read_to_string(image["filePath"].as_str().unwrap()).unwrap();
            assert!(!usvg::Tree::from_str(&svg, &assets::options())
                .unwrap()
                .root()
                .children()
                .is_empty());
            assert!(image["widthMm"].as_f64().unwrap() > 0.0);
            assert!(image["heightMm"].as_f64().unwrap() > 0.0);
        }
        assert_eq!(
            fs::metadata(source).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
        eprintln!(
            "real SVG import: {expected} assets, {} bytes, {} ms",
            before.len(),
            started.elapsed().as_millis()
        );
    }
}
