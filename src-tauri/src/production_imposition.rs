use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{BTreeMap, HashSet}, fs, path::Path};
use tauri::Manager;
use crate::schematic_review::PaymentStatus;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionImage {
    id: String,
    name: String,
    source_file_name: String,
    file_path: String,
    width_mm: f64,
    height_mm: f64,
    product_id: String,
    product_name: String,
    attributes: BTreeMap<String, String>,
    attribute_images: BTreeMap<String, String>,
    note: String,
    note_image: Option<String>,
    product_group_id: String,
    product_group_leader_id: String,
    product_group_position: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpositionSummary {
    pub id: String,
    source_review_id: String,
    customer_name: String,
    output: String,
    submitted_at: String,
    pub payment_status: PaymentStatus,
    status: String,
    image_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpositionRecord {
    #[serde(flatten)]
    summary: ImpositionSummary,
    images: Vec<ProductionImage>,
}

// Production data is independent from the editable schematic snapshot. No
// canvas geometry, display text overrides, rulers or visual scales go here.
pub(super) fn ensure_store(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS production_imposition_jobs (
        id TEXT PRIMARY KEY, source_review_id TEXT NOT NULL UNIQUE,
        customer_name TEXT NOT NULL, output TEXT NOT NULL, submitted_at TEXT NOT NULL,
        payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid')),
        status TEXT NOT NULL DEFAULT 'pending',
        image_count INTEGER NOT NULL, images TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS production_imposition_pending ON production_imposition_jobs(status, submitted_at DESC);")
        .map_err(|error| error.to_string())
}

pub(super) fn ensure_review_editable(conn: &Connection, id: &str) -> Result<(), String> {
    let submitted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM production_imposition_jobs WHERE source_review_id = ?1 AND status != 'returned')", [id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if submitted { return Err("该记录已进入生产拼版，不能再编辑或删除".into()); }
    Ok(())
}

const SUMMARY_COLUMNS: &str = "id, source_review_id, customer_name, output, submitted_at, payment_status, status, image_count";
fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImpositionSummary> {
    let status: String = row.get(5)?;
    let payment_status = PaymentStatus::from_text(&status).map_err(|error| rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, std::io::Error::other(error).into()))?;
    Ok(ImpositionSummary { id: row.get(0)?, source_review_id: row.get(1)?, customer_name: row.get(2)?, output: row.get(3)?, submitted_at: row.get(4)?, payment_status, status: row.get(6)?, image_count: row.get(7)? })
}

fn text(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or("").to_owned() }
fn source_text(conn: &Connection, review_id: &str, value: &str) -> Result<String, String> {
    if let Some(resource_id) = value.strip_prefix("printflow-review:") {
        let bytes = crate::schematic_review::load_resource(conn, review_id, resource_id)?;
        String::from_utf8(bytes).map_err(|error| error.to_string())
    } else { Ok(value.to_owned()) }
}

fn physical_dimensions(asset: &Value) -> Result<(f64, f64), String> {
    let width = asset["width"].as_f64().filter(|value| value.is_finite() && *value > 0.0).ok_or("图片真实宽度无效")?;
    let height = asset["height"].as_f64().filter(|value| value.is_finite() && *value > 0.0).ok_or("图片真实高度无效")?;
    let width_mm = asset["sourceGroupWidthMm"].as_f64().unwrap_or(0.0);
    let height_mm = asset["sourceGroupHeightMm"].as_f64().unwrap_or(0.0);
    // Use the same source measurement as schematic rulers, with no display rounding.
    if width_mm > 0.0 && height_mm > 0.0 && ((width_mm / height_mm) / (width / height)).ln().abs() <= 0.08 {
        Ok((width_mm, height_mm))
    } else { Ok((width * 25.4 / 96.0, height * 25.4 / 96.0)) }
}

fn saved_file_path(conn: &Connection, asset: &Value) -> Result<String, String> {
    let is_saved = |value: &str| crate::asset_storage::is_saved_file(conn, Path::new(value));
    let path = text(asset, "storagePath");
    if is_saved(&path)? { return Ok(path); }
    // Older review snapshots removed storagePath. Recover the saved batch path
    // by resource ID without loading its artwork or replacing exported properties.
    let path: Option<String> = conn.query_row("SELECT json_extract(payload, '$.storagePath') FROM assets WHERE id = ?1", [text(asset, "id")], |row| row.get(0)).optional().map_err(|error| error.to_string())?.flatten();
    if let Some(path) = path { if is_saved(&path)? { return Ok(path); } }
    Err(format!("图片 {} 的已保存批次文件不存在，无法进入生产拼版", text(asset, "name")))
}

pub(super) fn asset_referenced(conn: &Connection, asset_id: &str) -> Result<bool, String> {
    ensure_store(conn)?;
    // Duplicate batch detection can map a newly imported ID to an older saved
    // file. Protect both the logical resource ID and the shared durable path.
    conn.query_row("SELECT EXISTS(SELECT 1 FROM production_imposition_jobs, json_each(images) image
        WHERE json_extract(image.value, '$.id') = ?1 OR json_extract(image.value, '$.filePath') =
        (SELECT json_extract(payload, '$.storagePath') FROM assets WHERE id = ?1))", [asset_id], |row| row.get(0)).map_err(|error| error.to_string())
}

fn image_reference(conn: &Connection, review_id: &str, value: &str, directory: &Path, stem: &str) -> Result<String, String> {
    let content = source_text(conn, review_id, value)?;
    // Remote product images stay references; embedded originals become durable files.
    let Some(data) = content.strip_prefix("data:") else { return Ok(content); };
    let (header, body) = data.split_once(',').ok_or("产品属性图片数据无效")?;
    let extension = match header.split(';').next().unwrap_or("") {
        "image/png" => "png", "image/jpeg" => "jpg", "image/svg+xml" => "svg",
        "image/webp" => "webp", "image/gif" => "gif", _ => return Err("不支持的产品属性图片格式".into()),
    };
    if !header.ends_with(";base64") { return Err("产品属性图片编码无效".into()); }
    let bytes = STANDARD.decode(body).map_err(|error| format!("读取产品属性图片失败：{error}"))?;
    let path = directory.join(format!("{stem}.{extension}"));
    fs::write(&path, bytes).map_err(|error| format!("保存生产图片失败：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn production_images(conn: &Connection, review_id: &str, snapshot: &Value, directory: &Path) -> Result<Vec<ProductionImage>, String> {
    let used: HashSet<&str> = snapshot["pages"].as_array().into_iter().flatten()
        .flat_map(|page| page["items"].as_array().into_iter().flatten())
        .filter_map(|item| item["assetId"].as_str()).collect();
    let assets = snapshot["assets"].as_array().ok_or("示意图记录缺少图片")?;
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    for asset in assets {
        let id = asset["id"].as_str().ok_or("示意图图片缺少标识")?;
        if !used.contains(id) || !seen.insert(id) { continue; }
        let (width_mm, height_mm) = physical_dimensions(asset)?;
        let file_path = saved_file_path(conn, asset)?;
        let index = images.len() + 1;
        let mut attributes = BTreeMap::new();
        for (key, value) in asset["attributes"].as_object().into_iter().flatten() {
            attributes.insert(key.clone(), source_text(conn, review_id, value.as_str().ok_or("产品属性值无效")?)?);
        }
        let mut attribute_images = BTreeMap::new();
        for (image_index, (key, value)) in asset["attributeImages"].as_object().into_iter().flatten().enumerate() {
            let value = value.as_str().ok_or("产品属性图片无效")?;
            if !value.is_empty() { attribute_images.insert(key.clone(), image_reference(conn, review_id, value, directory, &format!("{index}-attribute-{image_index}"))?); }
        }
        let note_image = asset["noteImage"].as_str().filter(|value| !value.is_empty()).map(|value| image_reference(conn, review_id, value, directory, &format!("{index}-note"))).transpose()?;
        images.push(ProductionImage { id: id.into(), name: text(asset, "name"), source_file_name: text(asset, "sourceFileName"), file_path, width_mm, height_mm,
            product_id: text(asset, "productId"), product_name: text(asset, "productName"), attributes, attribute_images, note: source_text(conn, review_id, &text(asset, "note"))?, note_image,
            product_group_id: text(asset, "productGroupId"), product_group_leader_id: text(asset, "productGroupLeaderId"), product_group_position: asset["productGroupPosition"].as_u64().unwrap_or(0) });
    }
    if images.is_empty() { return Err("示意图中没有可进入生产拼版的图片".into()); }
    if used.len() != seen.len() { return Err("示意图中存在丢失的原图，无法进入生产拼版".into()); }
    Ok(images)
}

fn submit_review(conn: &Connection, root: &Path, id: &str, payment_status: PaymentStatus) -> Result<ImpositionSummary, String> {
    crate::schematic_review::ensure_store(conn)?;
    // Serialize stage transitions, including retries from different windows.
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    if let Some(existing) = transaction.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM production_imposition_jobs WHERE source_review_id = ?1 AND status != 'returned'"), [id], summary_row).optional().map_err(|error| error.to_string())? {
        return Ok(existing); // Active submissions are idempotent; returned reviews can submit again.
    }
    let payload: String = transaction.query_row("SELECT payload FROM schematic_reviews WHERE id = ?1", [id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.ok_or("示意图记录不存在")?;
    let snapshot: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    drop(payload);
    let (job_id, submitted_at): (String, String) = transaction.query_row("SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
    fs::create_dir_all(root).map_err(|error| format!("创建生产图片目录失败：{error}"))?;
    let directory = root.join(&job_id);
    fs::create_dir(&directory).map_err(|error| format!("创建生产任务目录失败：{error}"))?;
    let result = (|| {
        let images = production_images(&transaction, id, &snapshot, &directory)?;
        let summary = ImpositionSummary { id: job_id, source_review_id: id.into(), customer_name: source_text(&transaction, id, &text(&snapshot["metadata"], "customerName"))?, output: text(&snapshot, "output"), submitted_at, payment_status, status: "pending".into(), image_count: images.len() };
        transaction.execute("INSERT INTO production_imposition_jobs (id, source_review_id, customer_name, output, submitted_at, payment_status, status, image_count, images) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8) ON CONFLICT(source_review_id) DO UPDATE SET id = excluded.id, customer_name = excluded.customer_name, output = excluded.output, submitted_at = excluded.submitted_at, payment_status = excluded.payment_status, status = excluded.status, image_count = excluded.image_count, images = excluded.images",
            params![summary.id, id, summary.customer_name, summary.output, summary.submitted_at, payment_status.as_str(), images.len(), serde_json::to_string(&images).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO schematic_review_payment_states (record_id, payment_status) VALUES (?1, ?2) ON CONFLICT(record_id) DO UPDATE SET payment_status = excluded.payment_status", params![id, payment_status.as_str()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(summary)
    })();
    // Rollback may only clean the freshly created, generated job directory.
    if result.is_err() { let _ = fs::remove_dir_all(&directory); }
    result
}

fn return_job(conn: &Connection, id: &str) -> Result<(), String> {
    crate::schematic_review::ensure_store(conn)?;
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let status: String = transaction.query_row("SELECT j.status FROM production_imposition_jobs j JOIN schematic_reviews r ON r.id = j.source_review_id WHERE j.id = ?1", [id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?.ok_or("生产拼版记录不存在")?;
    if status != "pending" && status != "returned" { return Err("只有待拼版记录可以回退".into()); }
    transaction.execute("UPDATE production_imposition_jobs SET status = 'returned' WHERE id = ?1 AND status = 'pending'", [id]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn return_imposition_to_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || return_job(&super::database(&app)?, &id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_imposition_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|error| format!("读取拼版图片失败：{error}"))?;
        let mime = match Path::new(&path).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => return Err("拼版图片格式不支持".into()),
        };
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
    }).await.map_err(|error| error.to_string())?
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpositionListQuery { page: Option<usize>, page_size: Option<usize>, search: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpositionListResult { records: Vec<ImpositionSummary>, total: usize, page: usize, page_size: usize }
fn list_jobs(conn: &Connection, query: &ImpositionListQuery) -> Result<ImpositionListResult, String> {
    ensure_store(conn)?;
    let page_size = query.page_size.unwrap_or(20).clamp(1, 100);
    let search = query.search.as_deref().unwrap_or("").trim();
    let condition = "WHERE status = 'pending' AND (?1 = '' OR instr(lower(customer_name || ' ' || output), lower(?1)) > 0)";
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let total: usize = transaction.query_row(&format!("SELECT COUNT(*) FROM production_imposition_jobs {condition}"), [search], |row| row.get(0)).map_err(|error| error.to_string())?;
    let page = query.page.unwrap_or(1).clamp(1, total.saturating_sub(1) / page_size + 1);
    let records = {
        let mut stmt = transaction.prepare(&format!("SELECT {SUMMARY_COLUMNS} FROM production_imposition_jobs {condition} ORDER BY submitted_at DESC, rowid DESC LIMIT ?2 OFFSET ?3")).map_err(|error| error.to_string())?;
        let rows = stmt.query_map(params![search, page_size, (page - 1) * page_size], summary_row).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ImpositionListResult { records, total, page, page_size })
}

fn load_job(conn: &Connection, id: &str) -> Result<ImpositionRecord, String> {
    ensure_store(conn)?;
    let (summary, images) = conn.query_row(&format!("SELECT {SUMMARY_COLUMNS}, images FROM production_imposition_jobs WHERE id = ?1"), [id], |row| Ok((summary_row(row)?, row.get::<_, String>(8)?))).optional().map_err(|error| error.to_string())?.ok_or("生产拼版记录不存在")?;
    Ok(ImpositionRecord { summary, images: serde_json::from_str(&images).map_err(|error| error.to_string())? })
}

#[tauri::command]
pub async fn submit_schematic_review_to_imposition(app: tauri::AppHandle, id: String, payment_status: PaymentStatus) -> Result<ImpositionSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().app_data_dir().map_err(|error| error.to_string())?.join("production-imposition");
        submit_review(&super::database(&app)?, &root, &id, payment_status)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_pending_impositions(app: tauri::AppHandle, query: Option<ImpositionListQuery>) -> Result<ImpositionListResult, String> {
    tauri::async_runtime::spawn_blocking(move || list_jobs(&super::database(&app)?, &query.unwrap_or_default())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_imposition_job(app: tauri::AppHandle, id: String) -> Result<ImpositionRecord, String> {
    tauri::async_runtime::spawn_blocking(move || load_job(&super::database(&app)?, &id)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn directory() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("printflow-imposition-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }
    fn fixture(conn: &Connection, root: &Path, id: &str) -> Value {
        let assets_dir = root.join("printflow-data/assets");
        fs::create_dir_all(&assets_dir).unwrap();
        let path = assets_dir.join("asset.svg");
        fs::write(&path, "<svg>batch original</svg>").unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, payload TEXT NOT NULL)").unwrap();
        conn.execute("INSERT OR REPLACE INTO assets VALUES ('asset', ?1)", [json!({"storagePath":path.to_string_lossy(),"attributes":{"QT":"999"}}).to_string()]).unwrap();
        json!({"schemaVersion":1,"id":id,"savedAt":"2026-10-06T10:00:00Z","output":"ds.pdf","format":"pdf",
            "metadata":{"customerName":"ds"},"pages":[{"items":[{"id":"one","assetId":"asset","x":230,"w":900,"rulerHeightRange":[0.2,0.8]}, {"id":"back","assetId":"asset","derivedFrom":"one"}]}],
            "display":{"visualScales":[["one",3]],"textFontSize":40},
            "assets":[{"id":"asset","name":"front.svg","sourceFileName":"ds.svg","svg":"<svg>review original</svg>","storagePath":path.to_string_lossy(),"width":200.125,"height":300.5,"sourceGroupWidthMm":42.756789,"sourceGroupHeightMm":64.202384,
                "productId":"photo","productName":"照片夹","attributes":{"QT":"0","Finish":"Front Side Epoxy"},"note":"原备注","productGroupId":"g","productGroupLeaderId":"asset","productGroupPosition":1,"attributeImages":{"Accessories Color":"data:image/png;base64,aGVsbG8="}},
                {"id":"unused","svg":"<svg>not exported</svg>"}]})
    }

    #[test]
    fn deleting_history_removes_its_files_and_unsubmitted_review_reports_missing_source() {
        let root = directory();
        let conn = Connection::open_in_memory().unwrap();
        let mut snapshot = fixture(&conn, &root, "retained-review");
        let default = root.join("printflow-data/assets");
        let folder = crate::asset_storage::batch_directory(&conn, &default, "retained-batch", "ds").unwrap();
        let file = folder.join("asset.svg");
        fs::copy(default.join("asset.svg"), &file).unwrap();
        snapshot["assets"][0]["storagePath"] = json!(file.to_string_lossy());
        conn.execute("UPDATE assets SET payload=?1 WHERE id='asset'", [snapshot["assets"][0].to_string()]).unwrap();
        conn.execute_batch("CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT,metadata TEXT);
            CREATE TABLE batch_thumbnail_cache(batch_id TEXT PRIMARY KEY,signature TEXT,payload TEXT);").unwrap();
        conn.execute("INSERT INTO batches VALUES('retained-batch','2026-10-09',?1,'{}')", [json!([snapshot["assets"][0]]).to_string()]).unwrap();
        conn.execute("INSERT INTO batch_thumbnail_cache VALUES('retained-batch','version','[]')", []).unwrap();
        crate::schematic_review::save_record(&conn, snapshot).unwrap();

        // History deletion is intentional even when an unsubmitted review
        // depends on its files. Production must then report the missing source.
        let deletion = crate::batch_history::delete(&conn, "retained-batch");
        let transfer = submit_review(&conn, &root.join("jobs"), "retained-review", PaymentStatus::Unpaid);
        let second_deletion = crate::batch_history::delete(&conn, "retained-batch");
        let bytes = fs::read(&file).ok();
        let folder_exists = folder.exists();
        let batches: i64 = conn.query_row("SELECT count(*) FROM batches", [], |row| row.get(0)).unwrap();
        let assets: i64 = conn.query_row("SELECT count(*) FROM assets", [], |row| row.get(0)).unwrap();
        let previews: i64 = conn.query_row("SELECT count(*) FROM batch_thumbnail_cache", [], |row| row.get(0)).unwrap();
        let reviews: i64 = conn.query_row("SELECT count(*) FROM schematic_reviews", [], |row| row.get(0)).unwrap();
        let resolved = fs::canonicalize(&root).unwrap();
        assert!(resolved.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(resolved.file_name().unwrap().to_string_lossy().starts_with("printflow-imposition-test-"));
        fs::remove_dir_all(resolved).unwrap();
        assert!(deletion.is_ok() && second_deletion.is_ok());
        assert_eq!(bytes, None);
        assert!(!folder_exists);
        assert_eq!((batches, assets, previews, reviews), (0, 0, 0, 1));
        assert!(transfer.err().is_some_and(|error| error.contains("已保存批次文件不存在")));
    }

    #[test]
    fn custom_batch_directory_remains_usable_after_settings_change() {
        let root = directory();
        let conn = Connection::open_in_memory().unwrap();
        let mut value = fixture(&conn, &root, "custom-directory");
        let default = root.join("printflow-data/assets");
        let custom = root.join("客户文件");
        crate::asset_storage::save_settings(&conn, &default, custom.to_str().unwrap(), &root.join("temp-assets")).unwrap();
        let folder = crate::asset_storage::batch_directory(&conn, &default, "batch-1", "客户甲").unwrap();
        let path = folder.join("asset.svg");
        fs::copy(default.join("asset.svg"), &path).unwrap();
        value["assets"][0]["storagePath"] = json!(path.to_string_lossy());
        conn.execute("UPDATE assets SET payload=?1 WHERE id='asset'", [value["assets"][0].to_string()]).unwrap();
        crate::schematic_review::save_record(&conn, value).unwrap();
        crate::asset_storage::save_settings(&conn, &default, root.join("新的保存目录").to_str().unwrap(), &root.join("temp-assets")).unwrap();
        let job = submit_review(&conn, &root.join("jobs"), "custom-directory", PaymentStatus::Unpaid).unwrap();
        let record = load_job(&conn, &job.id).unwrap();
        assert_eq!(record.images[0].file_path, path.to_string_lossy());
        assert_eq!(fs::read_to_string(&record.images[0].file_path).unwrap(), "<svg>batch original</svg>");
        assert_eq!(record.images[0].attributes["QT"], "0");
        assert!(asset_referenced(&conn, "asset").unwrap());
        let resolved = fs::canonicalize(&root).unwrap();
        assert!(resolved.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(resolved.file_name().unwrap().to_string_lossy().starts_with("printflow-imposition-test-"));
        fs::remove_dir_all(resolved).unwrap();
    }

    #[test]
    fn transfer_keeps_saved_batch_paths_exact_dimensions_and_properties_without_canvas_data() {
        let root = directory();
        let db = root.join("store.sqlite");
        fs::create_dir_all(&root).unwrap();
        let job_id;
        let original;
        {
            let conn = Connection::open(&db).unwrap();
            original = fixture(&conn, &root, "review-one");
            crate::schematic_review::save_record(&conn, original.clone()).unwrap();
            let snapshot: String = conn.query_row("SELECT payload FROM schematic_reviews", [], |row| row.get(0)).unwrap();
            let job = submit_review(&conn, &root.join("attachments"), "review-one", PaymentStatus::Paid).unwrap();
            job_id = job.id.clone();
            assert_eq!(job.image_count, 1); // Omit unused pool assets and duplicate back views.
            let data = load_job(&conn, &job.id).unwrap();
            assert_eq!(data.summary.customer_name, "ds");
            let image = &data.images[0];
            assert_eq!(image.file_path, original["assets"][0]["storagePath"].as_str().unwrap());
            assert_eq!((image.width_mm, image.height_mm), (42.756789, 64.202384));
            assert_eq!(image.attributes["QT"], "0"); // Use exported properties, not later batch edits.
            assert_eq!(image.product_name, "照片夹");
            assert_eq!(image.product_group_position, 1);
            assert_eq!(fs::read(&image.attribute_images["Accessories Color"]).unwrap(), b"hello");
            assert_eq!(fs::read_to_string(&image.file_path).unwrap(), "<svg>batch original</svg>");
            let compact = serde_json::to_value(&data).unwrap();
            for key in ["pages", "display", "layoutBounds", "visualScales", "rulerHeightRange", "svg", "x", "w"] {
                assert!(compact.get(key).is_none());
                assert!(compact["images"][0].get(key).is_none());
            }
            assert!(asset_referenced(&conn, "asset").unwrap());
            assert!(!asset_referenced(&conn, "unused").unwrap());
            conn.execute("INSERT INTO assets VALUES ('duplicate-batch-id', ?1)", [json!({"storagePath":image.file_path}).to_string()]).unwrap();
            assert!(asset_referenced(&conn, "duplicate-batch-id").unwrap());
            assert!(crate::schematic_review::load_record(&conn, "review-one").is_err());
            assert!(crate::schematic_review::delete_record(&conn, "review-one").is_err());
            assert_eq!(conn.query_row("SELECT payload FROM schematic_reviews", [], |row| row.get::<_, String>(0)).unwrap(), snapshot);
            let again = submit_review(&conn, &root.join("attachments"), "review-one", PaymentStatus::Unpaid).unwrap();
            assert_eq!(again.id, job.id);
            assert_eq!(again.payment_status, PaymentStatus::Paid);
            assert_eq!(list_jobs(&conn, &ImpositionListQuery::default()).unwrap().total, 1);
        }
        {
            let conn = Connection::open(&db).unwrap();
            let job = load_job(&conn, &job_id).unwrap();
            assert_eq!(job.summary.payment_status, PaymentStatus::Paid);
            assert_eq!(job.images[0].file_path, original["assets"][0]["storagePath"]);
            assert_eq!(conn.query_row("SELECT payment_status FROM schematic_review_payment_states WHERE record_id='review-one'", [], |row| row.get::<_, String>(0)).unwrap(), "paid");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_reviews_recover_saved_paths_without_reading_svg_and_failed_transfers_roll_back() {
        let root = directory();
        let conn = Connection::open_in_memory().unwrap();
        let mut value = fixture(&conn, &root, "legacy");
        value["assets"][0].as_object_mut().unwrap().remove("storagePath");
        value["assets"][0]["svg"] = json!("x".repeat(100_000));
        crate::schematic_review::save_record(&conn, value).unwrap();
        conn.execute("UPDATE schematic_review_resources SET content='not valid svg'", []).unwrap();
        let job = submit_review(&conn, &root.join("attachments"), "legacy", PaymentStatus::Unpaid).unwrap();
        assert_eq!(job.payment_status, PaymentStatus::Unpaid);
        assert_eq!(load_job(&conn, &job.id).unwrap().images.len(), 1);

        let mut invalid = fixture(&conn, &root, "invalid");
        invalid["assets"][0]["width"] = json!(0);
        crate::schematic_review::save_record(&conn, invalid).unwrap();
        assert!(submit_review(&conn, &root.join("attachments"), "invalid", PaymentStatus::Paid).is_err());
        assert_eq!(list_jobs(&conn, &ImpositionListQuery::default()).unwrap().total, 1);
        assert_eq!(crate::schematic_review::load_record(&conn, "invalid").unwrap()["paymentStatus"], "unpaid");
        crate::schematic_review::save_record(&conn, fixture(&conn, &root, "db-failure")).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_paid BEFORE UPDATE ON schematic_review_payment_states BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(submit_review(&conn, &root.join("attachments"), "db-failure", PaymentStatus::Paid).is_err());
        assert_eq!(list_jobs(&conn, &ImpositionListQuery::default()).unwrap().total, 1);
        assert_eq!(crate::schematic_review::load_record(&conn, "db-failure").unwrap()["paymentStatus"], "unpaid");
        assert_eq!(fs::read_dir(root.join("attachments")).unwrap().count(), 1);
        conn.execute_batch("DROP TRIGGER reject_paid").unwrap();
        fs::remove_file(root.join("printflow-data/assets/asset.svg")).unwrap();
        assert!(submit_review(&conn, &root.join("attachments"), "db-failure", PaymentStatus::Paid).unwrap_err().contains("已保存批次文件不存在"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn returned_review_survives_reopen_and_can_submit_again_without_stale_returns() {
        let root = directory();
        fs::create_dir_all(&root).unwrap();
        let db = root.join("store.sqlite");
        let original;
        let first_id;
        {
            let conn = Connection::open(&db).unwrap();
            original = fixture(&conn, &root, "return-review");
            crate::schematic_review::save_record(&conn, original.clone()).unwrap();
            let job = submit_review(&conn, &root.join("attachments"), "return-review", PaymentStatus::Paid).unwrap();
            first_id = job.id;
            conn.execute_batch("CREATE TRIGGER reject_return BEFORE UPDATE OF status ON production_imposition_jobs BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
            assert!(return_job(&conn, &first_id).is_err());
            assert_eq!(list_jobs(&conn, &ImpositionListQuery::default()).unwrap().total, 1);
            assert!(crate::schematic_review::load_record(&conn, "return-review").is_err());
            conn.execute_batch("DROP TRIGGER reject_return").unwrap();
            return_job(&conn, &first_id).unwrap();
            return_job(&conn, &first_id).unwrap(); // Retrying the same return is harmless.
            assert_eq!(list_jobs(&conn, &ImpositionListQuery::default()).unwrap().total, 0);
        }
        {
            let conn = Connection::open(&db).unwrap();
            let rows = serde_json::to_value(crate::schematic_review::list_records(&conn, &Default::default()).unwrap()).unwrap();
            assert_eq!(rows["records"][0]["returned"], true);
            assert!(rows["records"][0].get("impositionJobId").is_none());
            assert_eq!(rows["records"][0]["paymentStatus"], "paid");
            let restored = crate::schematic_review::load_record(&conn, "return-review").unwrap();
            assert_eq!(restored["pages"], original["pages"]);
            assert_eq!(restored["display"], original["display"]);
            let job = submit_review(&conn, &root.join("attachments"), "return-review", PaymentStatus::Unpaid).unwrap();
            assert_ne!(job.id, first_id);
            assert_eq!(job.payment_status, PaymentStatus::Unpaid);
            assert!(return_job(&conn, &first_id).is_err()); // A stale window cannot return a new submission.
            assert_eq!(list_jobs(&conn, &ImpositionListQuery::default()).unwrap().total, 1);
            let rows = serde_json::to_value(crate::schematic_review::list_records(&conn, &Default::default()).unwrap()).unwrap();
            assert_eq!(rows["records"][0]["returned"], false);
            assert_eq!(rows["records"][0]["impositionJobId"], job.id);
            assert!(crate::schematic_review::load_record(&conn, "return-review").is_err());
            return_job(&conn, &job.id).unwrap();
            crate::schematic_review::delete_record(&conn, "return-review").unwrap();
            assert!(load_job(&conn, &job.id).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_list_is_paginated_and_does_not_load_images_or_review_payloads() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_store(&conn).unwrap();
        for index in 0..45 {
            conn.execute("INSERT INTO production_imposition_jobs VALUES (?1, ?1, ?2, 'proof100%_final.pdf', '2026-10-08T00:00:00Z', 'unpaid', 'pending', 1, 'not JSON')", params![format!("job-{index}"), if index % 2 == 0 { "筛选客户" } else { "Other" }]).unwrap();
        }
        let first = list_jobs(&conn, &ImpositionListQuery::default()).unwrap();
        assert_eq!((first.total, first.page, first.page_size, first.records.len()), (45, 1, 20, 20));
        assert_eq!(first.records[0].id, "job-44");
        let last = list_jobs(&conn, &ImpositionListQuery { page: Some(99), ..Default::default() }).unwrap();
        assert_eq!((last.page, last.records.len()), (3, 5));
        assert_eq!(list_jobs(&conn, &ImpositionListQuery { search: Some("筛选客户".into()), ..Default::default() }).unwrap().total, 23);
        assert_eq!(list_jobs(&conn, &ImpositionListQuery { search: Some("' OR 1=1 --".into()), ..Default::default() }).unwrap().total, 0);
        assert_eq!(list_jobs(&conn, &ImpositionListQuery { page_size: Some(usize::MAX), ..Default::default() }).unwrap().page_size, 100);
    }
}
