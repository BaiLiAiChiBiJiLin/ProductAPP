use super::files::{Result, FILE_PREFIX};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub fn ensure_store(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS shared_transfer_outbox (
        task_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        status TEXT NOT NULL, manifest TEXT NOT NULL DEFAULT '{}', record_ids TEXT NOT NULL, cleanup_paths TEXT NOT NULL DEFAULT '[]');
        CREATE UNIQUE INDEX IF NOT EXISTS shared_transfer_active_batch ON shared_transfer_outbox(batch_id) WHERE status IN ('preparing','publishing','published','received');
        CREATE TABLE IF NOT EXISTS shared_transfer_receipts (task_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, imported_at TEXT NOT NULL, batch_id TEXT NOT NULL);")
        .map_err(|e| e.to_string())
}

pub fn ensure_editable(conn: &Connection, kind: &str, id: &str) -> Result<()> {
    ensure_store(conn)?;
    let pending: bool = match kind {
        "batch" => conn.query_row("SELECT EXISTS(SELECT 1 FROM shared_transfer_outbox WHERE batch_id=?1 AND status IN ('preparing','publishing','published','received','complete'))", [id], |row| row.get(0)),
        "asset" | "review" | "job" => conn.query_row("SELECT EXISTS(SELECT 1 FROM shared_transfer_outbox o, json_each(o.record_ids, ?2) r WHERE r.value=?1 AND o.status IN ('preparing','publishing','published','received','complete'))", params![id, format!("$.{kind}s")], |row| row.get(0)),
        _ => return Err("转移记录类型无效".into()),
    }.map_err(|e| e.to_string())?;
    if pending {
        return Err("该记录正在转移或已转移，请刷新历史记录".into());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordIds {
    pub assets: Vec<String>,
    pub reviews: Vec<String>,
    pub jobs: Vec<String>,
}

#[derive(Clone, Default)]
pub struct Data {
    pub batch: Value,
    pub reviews: Vec<Value>,
    pub jobs: Vec<Value>,
}

pub fn snapshot(conn: &Connection, batch_id: &str) -> Result<Data> {
    let batch = conn
        .query_row(
            "SELECT saved_at,payload,metadata FROM batches WHERE id=?1",
            [batch_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("请先保存当前批次")?;
    let payload: Value = serde_json::from_str(&batch.1).map_err(|e| e.to_string())?;
    let metadata: Value = serde_json::from_str(&batch.2).map_err(|e| e.to_string())?;
    let ids: Vec<&str> = payload
        .as_array()
        .ok_or("批次图片数据无效")?
        .iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    if ids.is_empty() {
        return Err("当前批次没有可转移的图片".into());
    }
    let ids_json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    let mut reviews = Vec::new();
    let mut statement = conn.prepare("SELECT r.id,r.saved_at,r.summary,r.payload,COALESCE(p.payment_status,'unpaid') FROM schematic_reviews r LEFT JOIN schematic_review_payment_states p ON p.record_id=r.id
        WHERE json_valid(r.payload) AND (json_extract(r.payload,'$.sourceBatchId')=?1 OR EXISTS(SELECT 1 FROM json_each(r.payload,'$.assets') a JOIN json_each(?2) b ON json_extract(a.value,'$.id')=b.value))").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![batch_id, ids_json], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, saved_at, summary, payload, payment) = row.map_err(|e| e.to_string())?;
        let mut payload = parse(&payload)?;
        // Legacy review snapshots omitted durable paths; recover by asset ID,
        // as production submission does, while retaining the snapshot artwork.
        for asset in payload["assets"].as_array_mut().into_iter().flatten() {
            if asset["storagePath"].as_str().unwrap_or("").is_empty() {
                if let Some(asset_id) = asset["id"].as_str() {
                    let path: Option<String> = conn
                        .query_row(
                            "SELECT json_extract(payload,'$.storagePath') FROM assets WHERE id=?1",
                            [asset_id],
                            |r| r.get::<_, Option<String>>(0),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?
                        .flatten();
                    if let Some(path) = path.filter(|s| !s.is_empty()) {
                        asset["storagePath"] = Value::String(path);
                    }
                }
            }
        }
        reviews.push(json!({"id":id,"savedAt":saved_at,"summary":parse(&summary)?,"payload":payload,"paymentStatus":payment}));
    }
    drop(statement);
    let review_ids: Vec<&str> = reviews.iter().filter_map(|r| r["id"].as_str()).collect();
    let mut jobs = Vec::new();
    let mut statement = conn.prepare("SELECT id,source_review_id,customer_name,output,submitted_at,payment_status,status,image_count,images FROM production_imposition_jobs WHERE source_review_id IN (SELECT value FROM json_each(?1))").map_err(|e| e.to_string())?;
    let rows = statement.query_map([serde_json::to_string(&review_ids).unwrap()], |r| {
        Ok(json!({"id":r.get::<_,String>(0)?,"sourceReviewId":r.get::<_,String>(1)?,"customerName":r.get::<_,String>(2)?,"output":r.get::<_,String>(3)?,"submittedAt":r.get::<_,String>(4)?,"paymentStatus":r.get::<_,String>(5)?,"status":r.get::<_,String>(6)?,"imageCount":r.get::<_,usize>(7)?,"images":r.get::<_,String>(8)?}))
    }).map_err(|e| e.to_string())?;
    for row in rows {
        let mut job = row.map_err(|e| e.to_string())?;
        job["images"] = parse(job["images"].as_str().ok_or("生产图片数据无效")?)?;
        jobs.push(job);
    }
    Ok(Data {
        batch: json!({"id":batch_id,"savedAt":batch.0,"payload":payload,"metadata":metadata}),
        reviews,
        jobs,
    })
}

pub fn ids(data: &Data) -> RecordIds {
    let mut assets = HashSet::new();
    for values in std::iter::once(&data.batch["payload"])
        .chain(data.reviews.iter().map(|r| &r["payload"]["assets"]))
        .chain(data.jobs.iter().map(|r| &r["images"]))
    {
        for asset in values.as_array().into_iter().flatten() {
            if let Some(id) = asset["id"].as_str() {
                assets.insert(id.to_owned());
            }
        }
    }
    RecordIds {
        assets: assets.into_iter().collect(),
        reviews: data
            .reviews
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect(),
        jobs: data
            .jobs
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect(),
    }
}

fn parse(text: &str) -> Result<Value> {
    if text.len() > 64 * 1024 * 1024 {
        return Err("单条记录超过转移大小限制".into());
    }
    serde_json::from_str(text).map_err(|e| e.to_string())
}

pub fn store_packet(conn: &Connection, data: &Data) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE resources(record_id TEXT NOT NULL,resource_id TEXT NOT NULL,file_name TEXT NOT NULL,PRIMARY KEY(record_id,resource_id));").map_err(|e| e.to_string())?;
    for (kind, row) in std::iter::once(("batch", &data.batch))
        .chain(data.reviews.iter().map(|r| ("review", r)))
        .chain(data.jobs.iter().map(|r| ("job", r)))
    {
        let payload = serde_json::to_string(row).map_err(|e| e.to_string())?;
        if payload.len() > 64 * 1024 * 1024 {
            return Err("单条记录超过 64 MB 转移限制，请减少备注图片大小后重试".into());
        }
        conn.execute(
            "INSERT INTO records VALUES(?1,?2,?3)",
            params![kind, text(row, "id")?, payload],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn load_packet(conn: &Connection) -> Result<Data> {
    let mut data = Data::default();
    let mut stmt = conn
        .prepare("SELECT kind,payload FROM records")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    for row in rows {
        count += 1;
        if count > 10000 {
            return Err("转移记录数量过多".into());
        }
        let (kind, payload) = row.map_err(|e| e.to_string())?;
        let value = parse(&payload)?;
        match kind.as_str() {
            "batch" if data.batch.is_null() => data.batch = value,
            "review" => data.reviews.push(value),
            "job" => data.jobs.push(value),
            _ => return Err("数据包记录类型无效".into()),
        }
    }
    if !data.batch.is_object() {
        return Err("数据包缺少批次".into());
    }
    Ok(data)
}

pub fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("转移数据缺少 {key}"))
}

/// Remap only identity fields, never user note text, product option strings or SVG.
pub fn remap(
    data: &mut Data,
    task: &str,
    files: &HashMap<String, String>,
    custom: &HashMap<String, String>,
) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    map.insert(
        text(&data.batch, "id")?.to_owned(),
        format!("transfer-{task}-batch"),
    );
    collect_asset_ids(&data.batch["payload"], task, &mut map);
    for review in &data.reviews {
        let id = text(review, "id")?;
        map.insert(id.into(), format!("transfer-{task}-review-{}", map.len()));
        collect_asset_ids(&review["payload"]["assets"], task, &mut map);
    }
    for job in &data.jobs {
        let id = text(job, "id")?;
        map.insert(id.into(), format!("transfer-{task}-job-{}", map.len()));
        collect_asset_ids(&job["images"], task, &mut map);
    }
    fn transform(
        value: &mut Value,
        key: &str,
        map: &HashMap<String, String>,
        files: &HashMap<String, String>,
        custom: &HashMap<String, String>,
    ) -> Result<()> {
        match value {
            Value::String(s) => {
                if [
                    "storagePath",
                    "filePath",
                    "output",
                    "noteImage",
                    "src",
                    "attributeImages",
                ]
                .contains(&key)
                    && s.starts_with(FILE_PREFIX)
                {
                    *s = files
                        .get(&s[FILE_PREFIX.len()..])
                        .ok_or("数据包资源引用丢失")?
                        .clone();
                } else if [
                    "id",
                    "assetId",
                    "productGroupId",
                    "productGroupLeaderId",
                    "sourceRecordId",
                    "sourceReviewId",
                    "sourceBatchId",
                    "impositionJobId",
                    "defaultArrangementIds",
                ]
                .contains(&key)
                {
                    if let Some(new) = map.get(s) {
                        *s = new.clone();
                    }
                }
            }
            Value::Array(values) => {
                for entry in values {
                    transform(entry, key, map, files, custom)?;
                }
            }
            Value::Object(values) => {
                if values
                    .get("productId")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.starts_with("custom:"))
                {
                    if let Some(id) = values
                        .get("productName")
                        .and_then(Value::as_str)
                        .and_then(|name| custom.get(name))
                    {
                        values.insert("productId".into(), Value::String(id.clone()));
                    }
                }
                for (field, entry) in values {
                    transform(
                        entry,
                        if key == "attributeImages" { key } else { field },
                        map,
                        files,
                        custom,
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    transform(&mut data.batch, "", &map, files, custom)?;
    for value in data.reviews.iter_mut().chain(&mut data.jobs) {
        transform(value, "", &map, files, custom)?;
    }
    Ok(map)
}

fn collect_asset_ids(value: &Value, task: &str, map: &mut HashMap<String, String>) {
    for asset in value.as_array().into_iter().flatten() {
        if let Some(id) = asset["id"].as_str().filter(|s| !s.is_empty()) {
            let next = map.len();
            map.entry(id.into())
                .or_insert_with(|| format!("transfer-{task}-asset-{next}"));
        }
    }
}

pub fn custom_names(data: &Data) -> Vec<String> {
    fn visit(value: &Value, names: &mut HashSet<String>) {
        match value {
            Value::Object(values) => {
                if values
                    .get("productId")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.starts_with("custom:"))
                {
                    if let Some(name) = values
                        .get("productName")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                    {
                        names.insert(name.to_owned());
                    }
                }
                for value in values.values() {
                    visit(value, names);
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, names);
                }
            }
            _ => {}
        }
    }
    let mut names = HashSet::new();
    for value in std::iter::once(&data.batch)
        .chain(&data.reviews)
        .chain(&data.jobs)
    {
        visit(value, &mut names);
    }
    names.into_iter().collect()
}
