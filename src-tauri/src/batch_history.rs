use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use super::{Asset, BatchRecord};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchListQuery {
    pub page: Option<usize>,
    pub page_size: Option<usize>,
    pub search: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub id: String,
    pub saved_at: String,
    pub customer_name: String,
    pub asset_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchListResult {
    pub records: Vec<BatchSummary>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

/// SQL filters and pages summaries only. Never send asset arrays or SVG content
/// while browsing history; artwork is fetched only when opening a batch.
pub fn list(conn: &Connection, query: &BatchListQuery) -> Result<BatchListResult, String> {
    let page_size = query.page_size.unwrap_or(12).clamp(1, 100);
    let search = query.search.as_deref().unwrap_or("").trim();
    let parse = |value: &Option<String>| value.as_deref().filter(|value| !value.is_empty())
        .map(|value| chrono::DateTime::parse_from_rfc3339(value).map_err(|_| "保存时间格式无效".to_string())).transpose();
    let from = parse(&query.date_from)?;
    let to = parse(&query.date_to)?;
    if matches!((from, to), (Some(start), Some(end)) if start >= end) { return Err("保存时间范围无效".into()); }
    let from = from.map(|date| date.to_rfc3339());
    let to = to.map(|date| date.to_rfc3339());
    let customer = "COALESCE(NULLIF(trim(json_extract(metadata, '$.customerName')), ''), '图片批次')";
    let condition = format!("WHERE (?1 = '' OR instr(lower({customer}), lower(?1)) > 0)
        AND (?2 IS NULL OR julianday(saved_at) >= julianday(?2)) AND (?3 IS NULL OR julianday(saved_at) < julianday(?3))");
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    let total: usize = tx.query_row(&format!("SELECT COUNT(*) FROM batches {condition}"), params![search, from, to], |row| row.get(0)).map_err(|error| error.to_string())?;
    let page = query.page.unwrap_or(1).clamp(1, total.saturating_sub(1) / page_size + 1);
    let records = {
        let mut stmt = tx.prepare(&format!("SELECT id,saved_at,{customer},json_array_length(payload) FROM batches {condition}
            ORDER BY saved_at DESC,rowid DESC LIMIT ?4 OFFSET ?5")).map_err(|error| error.to_string())?;
        let rows = stmt.query_map(params![search, from, to, page_size, (page - 1) * page_size], |row| Ok(BatchSummary {
            id: row.get(0)?, saved_at: row.get(1)?, customer_name: row.get(2)?, asset_count: row.get(3)?,
        })).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    tx.commit().map_err(|error| error.to_string())?;
    Ok(BatchListResult { records, total, page, page_size })
}

fn read_record(conn: &Connection, id: &str) -> Result<BatchRecord, String> {
    let row: Option<(String, String, String)> = conn.query_row(
        "SELECT saved_at,payload,metadata FROM batches WHERE id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let (saved_at, payload, metadata) = row.ok_or("历史批次不存在或已被删除")?;
    Ok(BatchRecord {
        id: id.to_owned(), saved_at,
        assets: serde_json::from_str(&payload).map_err(|error| format!("历史图片清单读取失败：{error}"))?,
        metadata: serde_json::from_str(&metadata).map_err(|error| format!("历史批次属性读取失败：{error}"))?,
    })
}

/// Never hydrate an entire batch into one WebView IPC response. Original SVGs
/// are read separately so native serialization does not multiply batch memory.
pub(super) fn manifest(conn: &Connection, id: &str) -> Result<BatchRecord, String> {
    let mut record = read_record(conn, id)?;
    for asset in &mut record.assets {
        asset.svg = String::new();
        asset.preview_url = String::new();
        asset.thumbnail_url = String::new();
    }
    Ok(record)
}

pub(super) fn artwork(conn: &Connection, batch_id: &str, asset_id: &str) -> Result<Vec<u8>, String> {
    // Resolve only assets belonging to this saved batch; the frontend does not
    // provide an arbitrary file path. Inline SVGs from older records still work.
    let asset: Asset = read_record(conn, batch_id)?.assets.into_iter()
        .find(|asset| asset.id == asset_id).ok_or("图片不属于当前历史批次")?;
    let bytes = if asset.svg.is_empty() {
        if asset.storage_path.is_empty() { return Err(format!("图片 {} 缺少原始文件", asset.name)); }
        std::fs::read(&asset.storage_path).map_err(|error| format!("图片 {} 读取失败：{error}", asset.name))?
    } else { asset.svg.into_bytes() };
    if bytes.is_empty() { return Err(format!("图片 {} 的原始文件为空", asset.name)); }
    Ok(bytes)
}

/// Delete saved history and its unreferenced artwork. Review snapshots alone
/// do not prevent deletion; later production submission can report missing files.
pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    let payload: Option<String> = conn.query_row("SELECT payload FROM batches WHERE id=?1", [id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    let Some(payload) = payload else { return Ok(()) };
    let assets: Vec<Asset> = serde_json::from_str(&payload).unwrap_or_default();
    let mut referenced = std::collections::HashSet::new();
    let mut stmt = conn.prepare("SELECT payload FROM batches WHERE id<>?1").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok(other) = row.and_then(|value| serde_json::from_str::<Vec<Asset>>(&value).map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))) { for asset in other { referenced.insert(asset.id); } }
    }
    conn.execute("DELETE FROM batches WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    crate::batch_thumbnails::remove(conn, id)?;
    for asset in assets {
        if referenced.contains(&asset.id) { continue; }
        if crate::production_imposition::asset_referenced(conn, &asset.id)? { continue; }
        conn.execute("DELETE FROM assets WHERE id=?1", [&asset.id]).map_err(|e| e.to_string())?;
        if let Err(error) = crate::asset_storage::remove_saved_file(conn, std::path::Path::new(&asset.storage_path)) {
            log::warn!("删除批次资源文件失败：{error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database(assets: serde_json::Value) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT,metadata TEXT);").unwrap();
        conn.execute("INSERT INTO batches VALUES('ds','2026-10-07',?1,'{}')", [assets.to_string()]).unwrap();
        conn
    }

    fn asset(id: &str) -> serde_json::Value {
        json!({"id":id,"name":"原图.svg","productId":"a","width":42.789,"height":59.789,
            "svg":"","storagePath":"missing.svg","attributes":{"QT":"0"},"note":"保留备注","productGroupId":"group-1"})
    }

    #[test]
    fn history_search_pages_all_rows_and_returns_only_bounded_summaries() {
        let conn = database(json!([]));
        conn.execute("DELETE FROM batches", []).unwrap();
        for index in 0..37 {
            let payload = json!([{"svg":"x".repeat(64 * 1024),"noteImage":"must-not-be-returned"}]).to_string();
            let metadata = json!({"customerName":format!("客户-{index}")}).to_string();
            conn.execute("INSERT INTO batches VALUES(?1,'2026-10-09T02:16:00.000Z',?2,?3)", params![format!("id-{index}"),payload,metadata]).unwrap();
        }
        let first = list(&conn, &BatchListQuery::default()).unwrap();
        assert_eq!((first.total, first.page, first.records.len()), (37, 1, 12));
        assert_eq!(first.records[0].id, "id-36");
        let second = list(&conn, &BatchListQuery { page: Some(2), ..Default::default() }).unwrap();
        assert_eq!(second.records[0].id, "id-24");
        assert!(!second.records.iter().any(|a| first.records.iter().any(|b| a.id == b.id)));
        let last = list(&conn, &BatchListQuery { page: Some(99), ..Default::default() }).unwrap();
        assert_eq!((last.page, last.records.len()), (4, 1));
        conn.execute("DELETE FROM batches WHERE id='id-0'", []).unwrap();
        assert_eq!(list(&conn, &BatchListQuery { page: Some(4), ..Default::default() }).unwrap().page, 3);
        let encoded = serde_json::to_string(&first).unwrap();
        assert!(!encoded.contains("svg") && !encoded.contains("noteImage") && encoded.len() < 5000);
        assert_eq!(list(&conn, &BatchListQuery { search: Some("客户-36".into()), ..Default::default() }).unwrap().total, 1);
    }

    #[test]
    fn history_filters_name_and_full_local_days_together_and_treats_search_as_literal() {
        let conn = database(json!([]));
        conn.execute("DELETE FROM batches", []).unwrap();
        for (id, time, name) in [
            ("before", "2026-10-08T15:59:59.999Z", "客户甲"),
            ("start", "2026-10-08T16:00:00.000Z", "客户甲"),
            ("end", "2026-10-09T15:59:59.999Z", "客户甲"),
            ("outside", "2026-10-09T16:00:00.000Z", "客户甲"),
            ("other", "2026-10-09T10:00:00.000Z", "客户乙"),
            ("literal", "2026-10-09T10:00:00.000Z", "DS_100%"),
        ] {
            conn.execute("INSERT INTO batches VALUES(?1,?2,'[]',?3)", params![id,time,json!({"customerName":name}).to_string()]).unwrap();
        }
        let query = BatchListQuery { search: Some("客户甲".into()), date_from: Some("2026-10-09T00:00:00+08:00".into()), date_to: Some("2026-10-10T00:00:00+08:00".into()), ..Default::default() };
        let result = list(&conn, &query).unwrap();
        assert_eq!(result.records.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), ["end", "start"]);
        assert_eq!(list(&conn, &BatchListQuery { search: Some(" ds_100% ".into()), ..Default::default() }).unwrap().total, 1);
        assert_eq!(list(&conn, &BatchListQuery { search: Some("%' OR 1=1 --".into()), ..Default::default() }).unwrap().total, 0);
        assert!(list(&conn, &BatchListQuery { date_from: Some("invalid".into()), ..Default::default() }).is_err());
        assert!(list(&conn, &BatchListQuery { date_from: query.date_to, date_to: query.date_from, ..Default::default() }).is_err());
    }

    #[test]
    fn opening_84_asset_batch_does_not_read_artwork_or_return_svg_payloads() {
        let mut assets = (0..84).map(|index| asset(&format!("image-{index}"))).collect::<Vec<_>>();
        // Legacy inline content must also stay out of the manifest response.
        assets[0]["svg"] = json!("x".repeat(1024 * 1024));
        let conn = database(json!(assets));
        let loaded = manifest(&conn, "ds").unwrap();
        assert_eq!(loaded.assets.len(), 84);
        assert!(loaded.assets.iter().all(|asset| asset.svg.is_empty()));
        assert!(serde_json::to_vec(&loaded).unwrap().len() < 100 * 1024);
        assert_eq!(loaded.assets[0].note, "保留备注");
        assert_eq!(loaded.assets[0].product_group_id, "group-1");
        assert_eq!(loaded.assets[0].attributes["QT"], "0");
        assert!(manifest(&conn, "unknown").is_err());
    }

    #[test]
    fn artwork_reads_exact_original_bytes_and_reports_missing_files() {
        let path = std::env::temp_dir().join(format!("printflow-history-{}-{}.svg", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let original = "<svg><text>原图文字 Ω</text></svg>".as_bytes();
        std::fs::write(&path, original).unwrap();
        let mut saved = asset("one"); saved["storagePath"] = json!(path.to_string_lossy());
        let conn = database(json!([saved]));
        assert_eq!(artwork(&conn, "ds", "one").unwrap(), original);
        assert!(artwork(&conn, "ds", "not-in-batch").is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(artwork(&conn, "ds", "one").unwrap_err().contains("读取失败"));
    }

    #[test]
    fn legacy_inline_artwork_is_loaded_without_a_source_file() {
        let mut saved = asset("inline"); saved["svg"] = json!("<svg>旧版原图</svg>");
        let conn = database(json!([saved]));
        assert_eq!(artwork(&conn, "ds", "inline").unwrap(), "<svg>旧版原图</svg>".as_bytes());
    }
}
