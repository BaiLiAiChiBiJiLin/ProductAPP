use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const RESOURCE_PREFIX: &str = "printflow-review:";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaymentStatus {
    #[default]
    Unpaid,
    Paid,
}

impl PaymentStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self { Self::Unpaid => "unpaid", Self::Paid => "paid" }
    }
    pub(super) fn from_text(value: &str) -> Result<Self, String> {
        match value {
            "unpaid" => Ok(Self::Unpaid),
            "paid" => Ok(Self::Paid),
            _ => Err("付款状态无效".into()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    id: String,
    saved_at: String,
    output: String,
    format: String,
    customer_name: String,
    page_count: usize,
    image_count: usize,
    #[serde(default)]
    payment_status: PaymentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    imposition_job_id: Option<String>,
    #[serde(default)]
    returned: bool,
}

pub(super) fn ensure_store(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schematic_reviews (
        id TEXT PRIMARY KEY, saved_at TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS schematic_review_resources (
        record_id TEXT NOT NULL, resource_id TEXT NOT NULL, content BLOB NOT NULL,
        PRIMARY KEY (record_id, resource_id)
    ); CREATE TABLE IF NOT EXISTS schematic_review_payment_states (
        record_id TEXT PRIMARY KEY, payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid'))
    ); CREATE INDEX IF NOT EXISTS schematic_reviews_saved_at ON schematic_reviews(saved_at DESC);")
        .map_err(|error| error.to_string())?;
    crate::production_imposition::ensure_store(conn)
}

fn required_text(record: &Value, key: &str) -> Result<String, String> {
    record[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned)
        .ok_or_else(|| format!("示意图记录缺少 {key}"))
}

// Keep large artwork out of both the JSON manifest and the WebView IPC response.
// Resources live in the same SQLite transaction as their immutable revision.
fn externalize(conn: &Connection, id: &str, value: &mut Value, count: &mut usize, staged: &mut HashMap<String, String>) -> Result<bool, String> {
    let mut changed = false;
    match value {
        Value::String(text) if text.starts_with(crate::staged_artwork::PREFIX) || text.len() > 64 * 1024 => {
            if let Some(reference) = staged.get(text) { *text = reference.clone(); return Ok(true); }
            let temporary = text.starts_with(crate::staged_artwork::PREFIX).then(|| text.clone());
            let content = if temporary.is_some() { crate::staged_artwork::read(text)? } else { std::mem::take(text) };
            *count += 1;
            let resource_id = format!("r{count}");
            conn.execute("INSERT INTO schematic_review_resources (record_id, resource_id, content) VALUES (?1, ?2, ?3)",
                params![id, resource_id, content.as_bytes()]).map_err(|error| error.to_string())?;
            *text = format!("{RESOURCE_PREFIX}{resource_id}");
            if let Some(key) = temporary { staged.insert(key, text.clone()); }
            changed = true;
        }
        Value::Array(values) => for entry in values { changed |= externalize(conn, id, entry, count, staged)?; },
        Value::Object(values) => for entry in values.values_mut() { changed |= externalize(conn, id, entry, count, staged)?; },
        _ => {}
    }
    Ok(changed)
}

pub(super) fn save_record(conn: &Connection, mut record: Value) -> Result<(), String> {
    ensure_store(conn)?;
    let id = required_text(&record, "id")?;
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM schematic_reviews WHERE id = ?1)", [&id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if exists { return Ok(()); }
    if record["schemaVersion"].as_u64() != Some(1) { return Err("不支持的示意图记录版本".into()); }
    let pages = record["pages"].as_array().filter(|pages| !pages.is_empty()).ok_or("示意图记录缺少页面")?;
    let page_count = pages.len();
    let image_count = pages.iter().flat_map(|page| page["items"].as_array().into_iter().flatten())
        .filter(|item| item["derivedFrom"].as_str().unwrap_or("").is_empty()).count();
    let summary = ReviewSummary {
        id: required_text(&record, "id")?, saved_at: required_text(&record, "savedAt")?,
        output: required_text(&record, "output")?, format: required_text(&record, "format")?,
        customer_name: record["metadata"]["customerName"].as_str().unwrap_or("").to_owned(),
        page_count, image_count,
        payment_status: record.get("paymentStatus").map(|value| serde_json::from_value(value.clone()).map_err(|error| error.to_string())).transpose()?.unwrap_or_default(),
        imposition_job_id: None,
        returned: false,
    };
    // Store independent SVG contents so deleting or editing a source batch
    // cannot change a previously exported revision. Keep all other JSON fields.
    let assets = record["assets"].as_array_mut().filter(|assets| !assets.is_empty()).ok_or("示意图记录缺少图片")?;
    for asset in assets {
        if asset["svg"].as_str().unwrap_or("").is_empty() {
            let path = asset["storagePath"].as_str().filter(|value| !value.is_empty()).ok_or("示意图记录缺少图片内容")?;
            let svg = std::fs::read_to_string(path).map_err(|error| format!("保存示意图图片失败：{error}"))?;
            if svg.is_empty() { return Err("示意图图片内容为空".into()); }
            asset["svg"] = Value::String(svg);
        }
        let object = asset.as_object_mut().ok_or("示意图图片数据无效")?;
        // Keep saved batch paths for the production stage. The independent SVG
        // snapshot still permits review restoration when a source file is lost.
        object.insert("previewUrl".into(), Value::String(String::new()));
        object.insert("thumbnailUrl".into(), Value::String(String::new()));
    }
    externalize(&transaction, &id, &mut record, &mut 0, &mut HashMap::new())?;
    let payload = serde_json::to_string(&record).map_err(|error| error.to_string())?;
    let summary_json = serde_json::to_string(&summary).map_err(|error| error.to_string())?;
    // A retry with the same ID is harmless; saved revisions stay immutable.
    transaction.execute("INSERT INTO schematic_reviews (id, saved_at, summary, payload) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO NOTHING",
        params![summary.id, summary.saved_at, summary_json, payload]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO schematic_review_payment_states (record_id, payment_status) VALUES (?1, ?2)",
        params![summary.id, summary.payment_status.as_str()]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewListQuery {
    page: Option<usize>,
    page_size: Option<usize>,
    search: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewListResult {
    records: Vec<ReviewSummary>,
    total: usize,
    page: usize,
    page_size: usize,
}

pub(super) fn list_records(conn: &Connection, query: &ReviewListQuery) -> Result<ReviewListResult, String> {
    ensure_store(conn)?;
    let page_size = query.page_size.unwrap_or(20).clamp(1, 100);
    let search = query.search.as_deref().unwrap_or("").trim();
    let date_from = query.date_from.as_deref().filter(|value| !value.is_empty());
    let date_to = query.date_to.as_deref().filter(|value| !value.is_empty());
    if matches!((date_from, date_to), (Some(start), Some(end)) if start >= end) { return Err("保存时间范围无效".into()); }
    // All filtering and LIMIT/OFFSET happen in SQLite. Never read snapshot payloads
    // or artwork for a list request; COUNT and rows share a consistent read transaction.
    let condition = "WHERE (?1 = '' OR instr(lower(COALESCE(json_extract(summary, '$.customerName'), '') || ' ' || COALESCE(json_extract(summary, '$.output'), '')), lower(?1)) > 0)
        AND (?2 IS NULL OR saved_at >= ?2) AND (?3 IS NULL OR saved_at < ?3)";
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let total = transaction.query_row(&format!("SELECT COUNT(*) FROM schematic_reviews {condition}"), params![search, date_from, date_to], |row| row.get::<_, usize>(0)).map_err(|error| error.to_string())?;
    let last_page = total.saturating_sub(1) / page_size + 1;
    let page = query.page.unwrap_or(1).clamp(1, last_page);
    let records = {
        let mut stmt = transaction.prepare(&format!("SELECT r.summary, COALESCE(p.payment_status, 'unpaid'), CASE WHEN j.status != 'returned' THEN j.id END, COALESCE(j.status = 'returned', 0) FROM schematic_reviews r
            LEFT JOIN schematic_review_payment_states p ON p.record_id = r.id
            LEFT JOIN production_imposition_jobs j ON j.source_review_id = r.id {condition}
            ORDER BY r.saved_at DESC, r.rowid DESC LIMIT ?4 OFFSET ?5")).map_err(|error| error.to_string())?;
        let rows = stmt.query_map(params![search, date_from, date_to, page_size, (page - 1) * page_size], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, bool>(3)?))).map_err(|error| error.to_string())?;
        rows.map(|row| {
            let (json, payment_status, job_id, returned) = row.map_err(|error| error.to_string())?;
            let mut summary: ReviewSummary = serde_json::from_str(&json).map_err(|error| error.to_string())?;
            summary.payment_status = PaymentStatus::from_text(&payment_status)?;
            summary.imposition_job_id = job_id;
            summary.returned = returned;
            Ok(summary)
        }).collect::<Result<Vec<ReviewSummary>, String>>()?
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ReviewListResult { records, total, page, page_size })
}

pub(super) fn delete_record(conn: &Connection, id: &str) -> Result<(), String> {
    ensure_store(conn)?;
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    crate::production_imposition::ensure_review_editable(&transaction, id)?;
    transaction.execute("DELETE FROM production_imposition_jobs WHERE source_review_id = ?1 AND status = 'returned'", [id]).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM schematic_review_payment_states WHERE record_id = ?1", [id]).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM schematic_review_resources WHERE record_id = ?1", [id]).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM schematic_reviews WHERE id = ?1", [id]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn update_payment_status(conn: &Connection, id: &str, payment_status: PaymentStatus) -> Result<(), String> {
    ensure_store(conn)?;
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    crate::production_imposition::ensure_review_editable(&transaction, id)?;
    // Mutable payment metadata stays separate from the immutable artwork snapshot.
    // INSERT ... SELECT also ensures missing/deleted records cannot gain orphan states.
    let changed = transaction.execute("INSERT INTO schematic_review_payment_states (record_id, payment_status)
        SELECT id, ?2 FROM schematic_reviews WHERE id = ?1
        ON CONFLICT(record_id) DO UPDATE SET payment_status = excluded.payment_status", params![id, payment_status.as_str()])
        .map_err(|error| error.to_string())?;
    if changed == 0 { return Err("示意图记录不存在".into()); }
    transaction.commit().map_err(|error| error.to_string())
}

pub(super) fn load_record(conn: &Connection, id: &str) -> Result<Value, String> {
    ensure_store(conn)?;
    crate::production_imposition::ensure_review_editable(conn, id)?;
    let (payload, payment_status): (String, String) = conn.query_row("SELECT r.payload, COALESCE(p.payment_status, 'unpaid') FROM schematic_reviews r
        LEFT JOIN schematic_review_payment_states p ON p.record_id = r.id WHERE r.id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(|error| error.to_string())?.ok_or("示意图记录不存在")?;
    let mut record: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    drop(payload);
    // Migrate older inline snapshots without changing their artwork or layout.
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let mut count = transaction.query_row("SELECT COUNT(*) FROM schematic_review_resources WHERE record_id = ?1", [id], |row| row.get::<_, usize>(0)).map_err(|error| error.to_string())?;
    if externalize(&transaction, id, &mut record, &mut count, &mut HashMap::new())? {
        let manifest = serde_json::to_string(&record).map_err(|error| error.to_string())?;
        transaction.execute("UPDATE schematic_reviews SET payload = ?1 WHERE id = ?2", params![manifest, id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    record["paymentStatus"] = Value::String(PaymentStatus::from_text(&payment_status)?.as_str().into());
    Ok(record)
}

pub(super) fn load_resource(conn: &Connection, id: &str, resource_id: &str) -> Result<Vec<u8>, String> {
    conn.query_row("SELECT content FROM schematic_review_resources WHERE record_id = ?1 AND resource_id = ?2", params![id, resource_id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?.ok_or("示意图原始图片不存在".into())
}

#[tauri::command]
pub async fn load_schematic_review_resource(app: tauri::AppHandle, id: String, resource_id: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || load_resource(&super::database(&app)?, &id, &resource_id).map(tauri::ipc::Response::new))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_schematic_review(app: tauri::AppHandle, record: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_record(&super::database(&app)?, record)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_schematic_reviews(app: tauri::AppHandle, query: Option<ReviewListQuery>) -> Result<ReviewListResult, String> {
    tauri::async_runtime::spawn_blocking(move || list_records(&super::database(&app)?, &query.unwrap_or_default())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_schematic_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_record(&super::database(&app)?, &id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_schematic_review_payment_status(app: tauri::AppHandle, id: String, payment_status: PaymentStatus) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update_payment_status(&super::database(&app)?, &id, payment_status)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_schematic_review(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || load_record(&super::database(&app)?, &id)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_payment_status_defaults_unpaid_and_survives_reopen_without_loading_artwork() {
        let path = std::env::temp_dir().join(format!("printflow-review-payment-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let original = record("legacy-payment");
        let summary = json!({"id":"legacy-payment", "savedAt":original["savedAt"], "output":"test.pdf", "format":"pdf", "customerName":"旧客户", "pageCount":1, "imageCount":1});
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE schematic_reviews (id TEXT PRIMARY KEY, saved_at TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL);").unwrap();
            conn.execute("INSERT INTO schematic_reviews VALUES (?1, ?2, ?3, ?4)", params!["legacy-payment", original["savedAt"].as_str().unwrap(), summary.to_string(), original.to_string()]).unwrap();
            assert_eq!(list_records(&conn, &ReviewListQuery::default()).unwrap().records[0].payment_status, PaymentStatus::Unpaid);
            update_payment_status(&conn, "legacy-payment", PaymentStatus::Paid).unwrap();
            assert_eq!(load_record(&conn, "legacy-payment").unwrap()["paymentStatus"], "paid");
            let (saved_summary, payload): (String, String) = conn.query_row("SELECT summary, payload FROM schematic_reviews WHERE id='legacy-payment'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
            assert_eq!(saved_summary, summary.to_string());
            assert_eq!(payload, original.to_string());
            save_record(&conn, original.clone()).unwrap(); // A stale snapshot retry cannot reset payment.
            assert_eq!(load_record(&conn, "legacy-payment").unwrap()["paymentStatus"], "paid");
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(list_records(&conn, &ReviewListQuery::default()).unwrap().records[0].payment_status, PaymentStatus::Paid);
            // Payment updates and paginated summaries work even when a snapshot cannot be parsed.
            conn.execute("UPDATE schematic_reviews SET payload='not JSON' WHERE id='legacy-payment'", []).unwrap();
            update_payment_status(&conn, "legacy-payment", PaymentStatus::Unpaid).unwrap();
            assert_eq!(list_records(&conn, &ReviewListQuery::default()).unwrap().records[0].payment_status, PaymentStatus::Unpaid);
            delete_record(&conn, "legacy-payment").unwrap();
            assert!(update_payment_status(&conn, "legacy-payment", PaymentStatus::Paid).is_err());
            let count: usize = conn.query_row("SELECT COUNT(*) FROM schematic_review_payment_states", [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn payment_changes_leave_other_records_and_large_resources_untouched() {
        let conn = Connection::open_in_memory().unwrap();
        let mut value = record("payment-first");
        value["assets"][0]["svg"] = json!("x".repeat(100_000));
        save_record(&conn, value).unwrap();
        save_record(&conn, record("payment-second")).unwrap();
        let snapshot = load_record(&conn, "payment-first").unwrap();
        let artwork = load_resource(&conn, "payment-first", "r1").unwrap();
        update_payment_status(&conn, "payment-first", PaymentStatus::Paid).unwrap();
        let paid = load_record(&conn, "payment-first").unwrap();
        assert_eq!(paid["pages"], snapshot["pages"]);
        assert_eq!(paid["display"], snapshot["display"]);
        assert_eq!(paid["assets"], snapshot["assets"]);
        assert_eq!(paid["savedAt"], snapshot["savedAt"]);
        assert_eq!(paid["paymentStatus"], "paid");
        assert_eq!(load_resource(&conn, "payment-first", "r1").unwrap(), artwork);
        assert_eq!(load_record(&conn, "payment-second").unwrap()["paymentStatus"], "unpaid");
        assert!(serde_json::from_str::<PaymentStatus>("\"invalid\"").is_err());
    }

    #[test]
    fn list_pages_filter_in_sql_with_bounded_results_and_literal_search() {
        let conn = Connection::open_in_memory().unwrap();
        for index in 0..45 {
            let mut value = record(&format!("record-{index}"));
            value["metadata"]["customerName"] = json!(if index % 2 == 0 { "筛选客户" } else { "Other" });
            if index == 0 { value["output"] = json!("C:/report100%_final.pdf"); }
            save_record(&conn, value).unwrap();
        }
        let first = list_records(&conn, &ReviewListQuery::default()).unwrap();
        assert_eq!((first.total, first.page, first.page_size, first.records.len()), (45, 1, 20, 20));
        assert_eq!(first.records[0].id, "record-44");
        let last = list_records(&conn, &ReviewListQuery { page: Some(99), ..Default::default() }).unwrap();
        assert_eq!((last.page, last.records.len()), (3, 5));
        let filtered = list_records(&conn, &ReviewListQuery { page: Some(2), search: Some("筛选客户".into()), ..Default::default() }).unwrap();
        assert_eq!((filtered.total, filtered.records.len()), (23, 3));
        let literal = list_records(&conn, &ReviewListQuery { search: Some("100%_FINAL".into()), ..Default::default() }).unwrap();
        assert_eq!(literal.total, 1);
        assert_eq!(literal.records[0].id, "record-0");
        let missing = list_records(&conn, &ReviewListQuery { page: Some(99), search: Some("' OR 1=1 --".into()), ..Default::default() }).unwrap();
        assert_eq!((missing.page, missing.total, missing.records.len()), (1, 0, 0));
        let capped = list_records(&conn, &ReviewListQuery { page: Some(usize::MAX), page_size: Some(usize::MAX), ..Default::default() }).unwrap();
        assert_eq!((capped.page, capped.page_size, capped.records.len()), (1, 100, 45));
    }

    #[test]
    fn date_filter_includes_selected_local_day_and_excludes_following_midnight() {
        let conn = Connection::open_in_memory().unwrap();
        // October 6 in UTC+8 is [October 5 16:00Z, October 6 16:00Z).
        for (index, saved_at) in ["2026-10-05T15:59:59.999Z", "2026-10-05T16:00:00.000Z", "2026-10-06T15:59:59.999Z", "2026-10-06T16:00:00.000Z"].iter().enumerate() {
            let mut value = record(&format!("day-{index}")); value["savedAt"] = json!(saved_at);
            save_record(&conn, value).unwrap();
        }
        let query = ReviewListQuery { date_from: Some("2026-10-05T16:00:00.000Z".into()), date_to: Some("2026-10-06T16:00:00.000Z".into()), ..Default::default() };
        let page = list_records(&conn, &query).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.records.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), vec!["day-2", "day-1"]);
    }

    #[test]
    fn delete_cleans_only_the_selected_snapshot_resources_atomically() {
        let conn = Connection::open_in_memory().unwrap();
        let path = std::env::temp_dir().join(format!("printflow-review-delete-{}-{}.pdf", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::write(&path, b"exported document").unwrap();
        let mut value = record("delete-me");
        value["output"] = json!(path.to_string_lossy());
        value["assets"][0]["svg"] = json!("x".repeat(100_000));
        save_record(&conn, value.clone()).unwrap();
        value["id"] = json!("keep"); save_record(&conn, value).unwrap();
        conn.execute_batch("CREATE TRIGGER block_delete BEFORE DELETE ON schematic_reviews BEGIN SELECT RAISE(ABORT, 'blocked'); END;").unwrap();
        assert!(delete_record(&conn, "delete-me").is_err());
        assert_eq!(load_resource(&conn, "delete-me", "r1").unwrap().len(), 100_000);
        conn.execute_batch("DROP TRIGGER block_delete;").unwrap();
        delete_record(&conn, "delete-me").unwrap();
        delete_record(&conn, "delete-me").unwrap(); // Retry is harmless.
        assert!(load_record(&conn, "delete-me").is_err());
        assert!(load_resource(&conn, "delete-me", "r1").is_err());
        assert_eq!(load_resource(&conn, "keep", "r1").unwrap().len(), 100_000);
        assert_eq!(std::fs::read(&path).unwrap(), b"exported document");
        assert_eq!(list_records(&conn, &ReviewListQuery::default()).unwrap().total, 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn large_snapshot_resources_are_atomic_independent_and_legacy_records_migrate() {
        let conn = Connection::open_in_memory().unwrap();
        let svg = format!("<svg>{}</svg>", "原始🌸".repeat(20_000));
        let mut original = record("large");
        original["assets"][0]["svg"] = json!(svg);
        original["pages"][0]["items"][0]["backSvg"] = json!(svg);
        save_record(&conn, original.clone()).unwrap();
        let manifest = load_record(&conn, "large").unwrap();
        assert!(manifest.to_string().len() < 4096);
        for reference in [&manifest["assets"][0]["svg"], &manifest["pages"][0]["items"][0]["backSvg"]] {
            let resource_id = reference.as_str().unwrap().strip_prefix(RESOURCE_PREFIX).unwrap();
            assert_eq!(load_resource(&conn, "large", resource_id).unwrap(), svg.as_bytes());
            assert!(load_resource(&conn, "other-record", resource_id).is_err());
        }
        // Retrying cannot mutate artwork already saved under this revision ID.
        original["assets"][0]["svg"] = json!("changed");
        save_record(&conn, original.clone()).unwrap();
        assert_eq!(load_record(&conn, "large").unwrap(), manifest);
        original["id"] = json!("legacy");
        original["assets"][0]["svg"] = json!(svg);
        conn.execute("INSERT INTO schematic_reviews VALUES ('legacy', 'date', '{}', ?1)", [original.to_string()]).unwrap();
        let migrated = load_record(&conn, "legacy").unwrap();
        assert!(migrated.to_string().len() < 4096);
        assert_eq!(load_record(&conn, "legacy").unwrap(), migrated);
        let mut invalid = record("invalid-resources");
        invalid["assets"][0]["svg"] = json!(svg);
        invalid["pages"][0]["items"][0]["backSvg"] = json!("printflow-export:missing");
        assert!(save_record(&conn, invalid).is_err());
        let count: usize = conn.query_row("SELECT COUNT(*) FROM schematic_review_resources WHERE record_id='invalid-resources'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(load_record(&conn, "invalid-resources").is_err());
    }

    fn record(id: &str) -> Value {
        json!({"schemaVersion":1,"id":id,"savedAt":"2026-10-06T10:00:00Z","output":"test.pdf","format":"pdf",
            "metadata":{"customerName":"测试客户"},"pages":[{"items":[{"id":"one","x":23,"rulerHeightRange":[0.2,0.8]}, {"id":"back","derivedFrom":"one"}]}],
            "display":{"visualScales":[["one",1.5]],"dimensionDisplayOverrides":[["one",{"decimalPlaces":0,"precision":"default"}]]},
            "assets":[{"id":"asset","svg":"<svg>original</svg>","previewUrl":"blob:expired","storagePath":"old.svg"}]})
    }

    #[test]
    fn saved_revision_survives_reopen_and_keeps_independent_assets_and_adjustments() {
        let dir = std::env::temp_dir().join(format!("printflow-review-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.sqlite");
        let source = dir.join("source.svg");
        std::fs::write(&source, "<svg>original</svg>").unwrap();
        let mut original = record("first");
        original["assets"][0]["svg"] = json!("");
        original["assets"][0]["storagePath"] = json!(source.to_string_lossy());
        { let conn = Connection::open(&path).unwrap(); save_record(&conn, original.clone()).unwrap(); }
        std::fs::remove_file(source).unwrap();
        {
            let conn = Connection::open(&path).unwrap();
            let restored = load_record(&conn, "first").unwrap();
            assert_eq!(restored["pages"], original["pages"]);
            assert_eq!(restored["display"], original["display"]);
            assert_eq!(restored["assets"][0]["svg"], "<svg>original</svg>");
            assert_eq!(restored["assets"][0]["storagePath"], original["assets"][0]["storagePath"]);
            assert_eq!(restored["assets"][0]["previewUrl"], "");
            let mut updated = record("first"); updated["pages"][0]["items"][0]["x"] = json!(99);
            save_record(&conn, updated).unwrap();
            assert_eq!(load_record(&conn, "first").unwrap(), restored);
            save_record(&conn, record("second")).unwrap();
            let summaries = list_records(&conn, &ReviewListQuery::default()).unwrap().records;
            assert_eq!(summaries.len(), 2); assert_eq!(summaries[0].id, "second");
            assert_eq!(summaries[0].image_count, 1); assert_eq!(summaries[0].page_count, 1);
            assert!(load_record(&conn, "missing").is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_artwork_does_not_create_a_partial_record() {
        let conn = Connection::open_in_memory().unwrap();
        let mut invalid = record("invalid"); invalid["assets"][0]["svg"] = json!("");
        invalid["assets"][0]["storagePath"] = json!("");
        assert!(save_record(&conn, invalid).is_err());
        assert!(list_records(&conn, &ReviewListQuery::default()).unwrap().records.is_empty());
    }
}
