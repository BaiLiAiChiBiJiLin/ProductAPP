use super::{
    config::Environment,
    resources,
    store::{self, required, text, Record, Result},
};
use mysql::prelude::Queryable;
use serde_json::{json, Value};

pub fn memory() -> Result<rusqlite::Connection> {
    let db = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE assets(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT,metadata TEXT); CREATE TABLE batch_asset_directories(batch_id TEXT PRIMARY KEY,directory TEXT NOT NULL UNIQUE); CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
    crate::shared_transfers::store::ensure_store(&db)?;
    crate::schematic_review::ensure_store(&db)?;
    Ok(db)
}
pub(super) fn expand_local(db: &rusqlite::Connection, id: &str, value: &mut Value) -> Result<()> {
    match value {
        Value::String(s) if s.starts_with(resources::TEXT) => {
            *s = String::from_utf8(crate::schematic_review::load_resource(
                db,
                id,
                s.strip_prefix(resources::TEXT).unwrap(),
            )?)
            .map_err(|_| "审核资源编码错误")?;
        }
        Value::Object(map) => {
            for v in map.values_mut() {
                expand_local(db, id, v)?;
            }
        }
        Value::Array(values) => {
            for v in values {
                expand_local(db, id, v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn job_id(id: &str) -> String {
    format!("job-{}", &resources::hash(id.as_bytes())[..32])
}
pub fn get(conn: &mut impl Queryable, id: &str, lock: bool) -> Result<Record> {
    store::read(conn, "review", id, lock)?.ok_or("示意图审核记录不存在".into())
}
pub fn save(
    conn: &mut impl Queryable,
    env: &Environment,
    args: &Value,
    expected: u64,
) -> Result<Value> {
    let mut value = args["record"].clone();
    let id = required(&value, "id")?.to_owned();
    let old = store::read(conn, "review", &id, true)?;
    store::check_version(old.as_ref(), expected)?;
    if let Some(job) = store::read(conn, "job", &job_id(&id), true)? {
        if text(&job.value, "status") != "returned" {
            return Err("此审核已进入生产拼版，请先退回后再编辑".into());
        }
    }
    // This is the same domain validator/normalizer as local mode, but the
    // disposable in-memory database is never a data source or a sync replica.
    resources::hydrate(conn, env, &mut value, true)?;
    if let Some(old) = &old {
        value["paymentStatus"] = old.value["paymentStatus"].clone();
    }
    let db = memory()?;
    crate::schematic_review::save_record(&db, value)?;
    let mut value = crate::schematic_review::load_record(&db, &id)?;
    expand_local(&db, &id, &mut value)?;
    let folder =
        if let Some(batch) = store::read(conn, "batch", text(&value, "sourceBatchId"), false)? {
            text(&batch.value, "directory").to_owned()
        } else {
            format!("审核_{}", &resources::hash(id.as_bytes())[..16])
        };
    // Every snapshot keeps its own version of original and derived/back artwork.
    // Canonical SVGs can share immutable bytes with the batch without sharing mutable metadata.
    for asset in value["assets"].as_array_mut().into_iter().flatten() {
        let content = if text(asset, "svg").starts_with(crate::staged_artwork::PREFIX) {
            crate::staged_artwork::read(text(asset, "svg"))?
        } else {
            text(asset, "svg").to_owned()
        };
        let resource = resources::put(
            conn,
            env,
            &format!("{folder}/assets"),
            content.as_bytes(),
            "svg",
        )?;
        asset["storagePath"] = json!(format!("{}{resource}", resources::FILE));
    }
    resources::externalize(conn, env, &format!("{folder}/reviews"), &mut value)?;
    let summary_text: String = db
        .query_row(
            "SELECT summary FROM schematic_reviews WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut summary = store::json_value(summary_text)?;
    summary["output"] = value["output"].clone();
    summary["returned"] = json!(false);
    store::write(conn, "review", &id, None, expected + 1, &value, &summary)?;
    Ok(json!({"version":expected+1}))
}
pub fn load(conn: &mut impl Queryable, env: &Environment, user: &str, id: &str) -> Result<Value> {
    let record = get(conn, id, false)?;
    let mut value = record.value;
    resources::hydrate(conn, env, &mut value, false)?;
    value["version"] = json!(record.version);
    // Public editing must not grant write access to another user's private batch.
    let owned = store::read(conn, "batch", text(&value, "sourceBatchId"), false)?
        .is_some_and(|b| b.owner.as_deref() == Some(user));
    value["detachedFromBatch"] = json!(!owned);
    Ok(value)
}
pub fn resource(
    conn: &mut impl Queryable,
    env: &Environment,
    id: &str,
    resource: &str,
) -> Result<Value> {
    let record = get(conn, id, false)?;
    let mut refs = std::collections::BTreeSet::new();
    resources::references(&record.value, &mut refs);
    if !refs.contains(resource) {
        return Err("资源不属于当前审核快照".into());
    }
    Ok(json!(resources::read(
        conn,
        env,
        &format!("{}{resource}", resources::TEXT)
    )?))
}
pub fn payment(conn: &mut impl Queryable, id: &str, status: &str) -> Result<Value> {
    if !matches!(status, "paid" | "unpaid") {
        return Err("付款状态无效".into());
    }
    let mut record = get(conn, id, true)?;
    record.value["paymentStatus"] = json!(status);
    record.summary["paymentStatus"] = json!(status);
    // Payment is independent from the artwork revision; re-export preserves it.
    store::write(
        conn,
        "review",
        id,
        None,
        record.version,
        &record.value,
        &record.summary,
    )?;
    if let Some(mut job) = store::read(conn, "job", &job_id(id), true)? {
        job.value["paymentStatus"] = json!(status);
        job.summary["paymentStatus"] = json!(status);
        store::write(
            conn,
            "job",
            &job_id(id),
            None,
            job.version,
            &job.value,
            &job.summary,
        )?;
    }
    Ok(Value::Null)
}
pub fn delete(conn: &mut impl Queryable, id: &str, expected: u64) -> Result<Value> {
    let record = get(conn, id, true)?;
    store::check_version(Some(&record), expected)?;
    if let Some(job) = store::read(conn, "job", &job_id(id), true)? {
        if text(&job.value, "status") != "returned" {
            return Err("请先将生产任务退回，再删除审核记录".into());
        }
        store::remove(conn, "job", &job_id(id))?;
    }
    store::remove(conn, "review", id)?;
    Ok(Value::Null)
}

pub fn submit(
    conn: &mut impl Queryable,
    env: &Environment,
    id: &str,
    status: &str,
    expected: u64,
) -> Result<Value> {
    let mut review = get(conn, id, true)?;
    store::check_version(Some(&review), expected)?;
    let jobid = job_id(id);
    let old = store::read(conn, "job", &jobid, true)?;
    if let Some(job) = &old {
        if text(&job.value, "status") != "returned" {
            return Ok(job.summary.clone());
        }
    }
    if !matches!(status, "paid" | "unpaid") {
        return Err("付款状态无效".into());
    }
    let mut snapshot = review.value.clone();
    resources::hydrate(conn, env, &mut snapshot, true)?;
    let db = memory()?;
    for asset in snapshot["assets"].as_array().into_iter().flatten() {
        let path = std::path::Path::new(text(asset, "storagePath"));
        let directory = std::fs::canonicalize(path.parent().ok_or("原图路径无效")?)
            .map_err(|_| "共享图片不可访问")?;
        // Reuse the existing dimension and original-file validation exactly.
        let directory = directory
            .to_string_lossy()
            .replace(r"\\?\UNC\", r"\\")
            .trim_start_matches(r"\\?\")
            .to_owned();
        db.execute(
            "INSERT OR IGNORE INTO batch_asset_directories(batch_id,directory) VALUES(?1,?2)",
            rusqlite::params![directory, directory],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR REPLACE INTO assets(id,payload) VALUES(?1,?2)",
            rusqlite::params![text(asset, "id"), asset.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    let version = old.as_ref().map_or(1, |r| r.version + 1);
    let temporary = tempfile::tempdir().map_err(|_| "无法创建生产临时目录")?;
    let directory = temporary.path().to_path_buf();
    let images = crate::production_imposition::production_images(&db, id, &snapshot, &directory)?;
    let images = serde_json::to_value(images).map_err(|_| "生产图片格式错误")?;
    let mut job = json!({"id":jobid,"sourceReviewId":id,"customerName":snapshot["metadata"]["customerName"],"output":review.value["output"],"submittedAt":store::now(),"paymentStatus":status,"status":"pending","imageCount":images.as_array().unwrap().len(),"images":images});
    // Notes/accessory paths produced by the local domain converter also become shared references.
    externalize_images(conn, env, &jobid, &mut job["images"])?;
    resources::externalize(conn, env, &format!("生产资源/{jobid}"), &mut job)?;
    let mut summary = job.clone();
    summary.as_object_mut().unwrap().remove("images");
    store::write(conn, "job", &jobid, None, version, &job, &summary)?;
    review.value["paymentStatus"] = json!(status);
    review.summary["paymentStatus"] = json!(status);
    review.summary["impositionJobId"] = json!(jobid);
    review.summary["returned"] = json!(false);
    store::write(
        conn,
        "review",
        id,
        None,
        review.version,
        &review.value,
        &review.summary,
    )?;
    Ok(summary)
}
pub(super) fn externalize_images(
    conn: &mut impl Queryable,
    env: &Environment,
    folder: &str,
    v: &mut Value,
) -> Result<()> {
    match v {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "attributeImages" {
                    for image in value
                        .as_object_mut()
                        .into_iter()
                        .flat_map(|o| o.values_mut())
                    {
                        if let Some(path) = image
                            .as_str()
                            .filter(|p| std::path::Path::new(p).is_absolute())
                        {
                            *image = Value::String(resources::file(
                                conn,
                                env,
                                &format!("生产资源/{folder}"),
                                path,
                            )?);
                        }
                    }
                } else if matches!(key.as_str(), "filePath" | "noteImage" | "src") {
                    if let Some(path) = value
                        .as_str()
                        .filter(|p| std::path::Path::new(p).is_absolute())
                    {
                        *value = Value::String(resources::file(
                            conn,
                            env,
                            &format!("生产资源/{folder}"),
                            path,
                        )?);
                    }
                } else {
                    externalize_images(conn, env, folder, value)?;
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                externalize_images(conn, env, folder, value)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn change_job(
    conn: &mut impl Queryable,
    args: &Value,
    expected: u64,
    returning: bool,
) -> Result<Value> {
    let id = required(args, if returning { "id" } else { "jobId" })?;
    let mut job = store::read(conn, "job", id, true)?.ok_or("生产拼版记录不存在")?;
    store::check_version(Some(&job), expected)?;
    if text(&job.value, "status") != "pending" {
        return Err("生产任务已经退回，请刷新列表".into());
    }
    if returning {
        job.value["status"] = json!("returned");
        job.summary["status"] = json!("returned");
        let review_id = text(&job.value, "sourceReviewId");
        let mut review = get(conn, review_id, true)?;
        review.summary["returned"] = json!(true);
        review
            .summary
            .as_object_mut()
            .unwrap()
            .remove("impositionJobId");
        store::write(
            conn,
            "review",
            review_id,
            None,
            review.version,
            &review.value,
            &review.summary,
        )?;
    } else {
        let quantity = args["quantity"]
            .as_u64()
            .filter(|q| *q <= 10_000)
            .ok_or("QT 数量必须在 0 至 10000 之间")?;
        let ids = if let Some(ids) = args["imageIds"].as_array() {
            ids.clone()
        } else {
            vec![args["imageId"].clone()]
        };
        let images = job.value["images"]
            .as_array_mut()
            .ok_or("生产图片记录不完整")?;
        if ids.is_empty()
            || ids
                .iter()
                .any(|id| !images.iter().any(|img| &img["id"] == id))
        {
            return Err("生产图片不存在，修改未保存".into());
        }
        for image in images {
            if ids.contains(&image["id"]) {
                image["attributes"]["QT"] = json!(quantity.to_string());
            }
        }
    }
    store::write(
        conn,
        "job",
        id,
        None,
        expected + 1,
        &job.value,
        &job.summary,
    )?;
    job.value["version"] = json!(expected + 1);
    Ok(job.value)
}
