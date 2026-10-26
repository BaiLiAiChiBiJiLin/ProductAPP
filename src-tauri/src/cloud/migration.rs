//! Resumable migration; local cleanup occurs only after every record succeeds.
use super::{
    batches,
    config::Environment,
    resources, reviews,
    store::{self, error, required, text, Result},
};
use mysql::{prelude::Queryable, PooledConn, TxOpts};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;

fn ids(db: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = db
        .prepare(&format!("SELECT id FROM {table} ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
pub fn preview(db: &Connection) -> Result<Value> {
    crate::schematic_review::ensure_store(db)?;
    Ok(
        json!({"batches":ids(db,"batches")?.len(),"reviews":ids(db,"schematic_reviews")?.len(),"jobs":ids(db,"production_imposition_jobs")?.len(),"snapshot":super::local_cleanup::snapshot(db)?,"pendingFiles":super::local_cleanup::pending(db)?}),
    )
}

fn checked_transaction<'a>(db: &'a Connection, args: &Value) -> Result<rusqlite::Transaction<'a>> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let state = preview(&tx)?;
    if args["snapshot"].as_str().is_none() || args["snapshot"] != state["snapshot"] {
        return Err("本机旧数据已变化，请重新点击检查本机旧数据后再操作".into());
    }
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_with_legacy_transfers() -> Connection {
        let db = reviews::memory().unwrap();
        for status in ["preparing", "publishing", "published", "received"] {
            db.execute("INSERT INTO shared_transfer_outbox(task_id,batch_id,sender,recipient,status,record_ids) VALUES(?1,?1,'old-sender','old-recipient',?2,'{}')", [status, status]).unwrap();
        }
        db.execute("INSERT INTO shared_transfer_receipts VALUES('receipt','old-recipient','old-time','old-batch')", []).unwrap();
        db
    }

    #[test]
    fn legacy_transfers_do_not_block_migration_snapshot_or_get_cleaned_up() {
        let db = local_with_legacy_transfers();
        let state = preview(&db).unwrap();
        let tx = checked_transaction(&db, &json!({"snapshot":state["snapshot"]})).unwrap();
        super::super::local_cleanup::stage(&tx).unwrap();
        tx.commit().unwrap();
        let count: usize = db.query_row("SELECT COUNT(*) FROM shared_transfer_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 4, "cloud migration must leave old transfer records alone");
        let count: usize = db.query_row("SELECT COUNT(*) FROM shared_transfer_receipts", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn legacy_transfer_status_changes_do_not_invalidate_business_snapshot() {
        let db = local_with_legacy_transfers();
        let state = preview(&db).unwrap();
        db.execute("UPDATE shared_transfer_outbox SET status='complete'", []).unwrap();
        let tx = checked_transaction(&db, &json!({"snapshot":state["snapshot"]})).unwrap();
        drop(tx);
        db.execute("INSERT INTO batches VALUES('new','now','[]','{}')", []).unwrap();
        assert!(checked_transaction(&db, &json!({"snapshot":state["snapshot"]})).err().unwrap().contains("旧数据已变化"));
    }
}

pub fn delete_local(env: &Environment, db: &Connection, args: &Value) -> Result<Value> {
    if args["confirmed"] != true {
        return Err("请先确认删除本机旧数据".into());
    }
    let tx = checked_transaction(db, args)?;
    let removed = super::local_cleanup::stage(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    let error = super::local_cleanup::drain(db, env).err();
    Ok(
        json!({"removed":removed,"localRecordsDeleted":true,"errors":error.into_iter().collect::<Vec<_>>()}),
    )
}

pub fn migrate_and_cleanup(
    conn: &mut PooledConn,
    env: &Environment,
    user: &str,
    db: &Connection,
    args: &Value,
) -> Result<Value> {
    let tx = checked_transaction(db, args)?;
    // Hold the local write lock across migration so another instance cannot
    // add or change records between the preview and destructive cleanup.
    let result = run(conn, env, user, &tx, args);
    let mut result = match result {
        Ok(value) => value,
        Err(error) => {
            // Preserve the installation ID even when some cloud writes succeeded.
            tx.commit().map_err(|e| e.to_string())?;
            return Err(error);
        }
    };
    let complete = result["errors"].as_array().is_some_and(|e| e.is_empty());
    if complete {
        super::local_cleanup::stage(&tx)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    result["localRecordsDeleted"] = json!(complete);
    if complete {
        if let Err(error) = super::local_cleanup::drain(db, env) {
            result["errors"]
                .as_array_mut()
                .unwrap()
                .push(json!(format!("迁移已完成，本地文件待清理：{error}")));
        }
    }
    Ok(result)
}
fn mapped(installation: &str, kind: &str, id: &str) -> String {
    format!(
        "m-{kind}-{}",
        &resources::hash(format!("{installation}:{kind}:{id}").as_bytes())[..32]
    )
}
fn replace(value: &mut Value, map: &HashMap<String, String>) {
    match value {
        Value::String(s) => {
            if let Some(new) = map.get(s) {
                *s = new.clone();
            }
        }
        Value::Array(a) => {
            for v in a {
                replace(v, map);
            }
        }
        Value::Object(o) => {
            let old = std::mem::take(o);
            for (k, mut v) in old {
                replace(&mut v, map);
                o.insert(map.get(&k).cloned().unwrap_or(k), v);
            }
        }
        _ => {}
    }
}
pub fn run(
    conn: &mut PooledConn,
    env: &Environment,
    user: &str,
    db: &Connection,
    args: &Value,
) -> Result<Value> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    )
    .map_err(|e| e.to_string())?;
    let existing: Option<String> = db
        .query_row(
            "SELECT value FROM app_settings WHERE key='cloud_migration_installation'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let installation = if let Some(id) = existing {
        id
    } else {
        let id = store::uuid(conn)?;
        db.execute(
            "INSERT INTO app_settings(key,value) VALUES('cloud_migration_installation',?1)",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        id
    };
    let mut map = HashMap::new();
    let batches = ids(db, "batches")?;
    let reviews = ids(db, "schematic_reviews")?;
    let jobs = ids(db, "production_imposition_jobs")?;
    for (kind, values) in [("batch", &batches), ("review", &reviews)] {
        for id in values {
            map.insert(id.clone(), mapped(&installation, kind, id));
        }
    }
    for id in &jobs {
        let review: String = db
            .query_row(
                "SELECT source_review_id FROM production_imposition_jobs WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        map.insert(
            id.clone(),
            reviews::job_id(&mapped(&installation, "review", &review)),
        );
    }
    // Snapshot-only assets must be mapped too, including every page/reference.
    for table in ["batches", "schematic_reviews"] {
        let mut stmt = db
            .prepare(&format!("SELECT payload FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let v = store::json_value(row.map_err(|e| e.to_string())?)?;
            let assets = if table == "batches" { &v } else { &v["assets"] };
            for a in assets.as_array().into_iter().flatten() {
                let id = text(a, "id");
                if !id.is_empty() {
                    map.insert(id.into(), mapped(&installation, "asset", id));
                }
            }
        }
    }
    let mut imported = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();
    for (kind, values) in [("batch", batches), ("review", reviews), ("job", jobs)] {
        for id in values {
            let result = (|| -> Result<bool> {
                let mut tx = conn.start_transaction(TxOpts::default()).map_err(error)?;
                let done:Option<String>=tx.exec_first("SELECT cloud_key FROM pf_migrations WHERE installation_key=? AND kind=? AND local_key=?",(&installation,kind,&id)).map_err(error)?;
                if done.is_some() {
                    tx.commit().map_err(error)?;
                    return Ok(false);
                }
                let cloud_id = map.get(&id).ok_or("迁移映射缺失")?.clone();
                match kind {
                    "batch" => {
                        let mut record = crate::batch_history::manifest(db, &id)?;
                        for asset in &mut record.assets {
                            asset.svg = String::from_utf8(crate::batch_history::artwork(
                                db, &id, &asset.id,
                            )?)
                            .map_err(|_| "本地 SVG 编码无效")?;
                        }
                        let mut value = serde_json::to_value(record).map_err(|e| e.to_string())?;
                        replace(&mut value, &map);
                        batches::save(&mut tx, env, user, &value, 0)?;
                        let mut saved = store::read(&mut tx, "batch", &cloud_id, true)?
                            .ok_or("迁移批次未保存")?;
                        saved.value["savedAt"] = value["savedAt"].clone();
                        saved.summary["savedAt"] = value["savedAt"].clone();
                        store::write(
                            &mut tx,
                            "batch",
                            &cloud_id,
                            Some(user),
                            1,
                            &saved.value,
                            &saved.summary,
                        )?;
                    }
                    "review" => {
                        // Migration copies the saved snapshot even for active production
                        // jobs; the normal edit loader correctly rejects those records.
                        let (payload,payment):(String,String)=db.query_row("SELECT r.payload,COALESCE(p.payment_status,'unpaid') FROM schematic_reviews r LEFT JOIN schematic_review_payment_states p ON p.record_id=r.id WHERE r.id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
                        let mut value = store::json_value(payload)?;
                        value["paymentStatus"] = json!(payment);
                        reviews::expand_local(db, &id, &mut value)?;
                        replace(&mut value, &map);
                        reviews::save(&mut tx, env, &json!({"record":value}), 0)?;
                    }
                    "job" => {
                        let mut value:Value=db.query_row("SELECT source_review_id,customer_name,output,submitted_at,payment_status,status,image_count,images FROM production_imposition_jobs WHERE id=?1",[&id],|r|{
                            Ok(json!({"id":id,"sourceReviewId":r.get::<_,String>(0)?,"customerName":r.get::<_,String>(1)?,"output":r.get::<_,String>(2)?,"submittedAt":r.get::<_,String>(3)?,"paymentStatus":r.get::<_,String>(4)?,"status":r.get::<_,String>(5)?,"imageCount":r.get::<_,i64>(6)?,"images":r.get::<_,String>(7)?}))
                        }).map_err(|e|e.to_string())?;
                        value["images"] = store::json_value(
                            value["images"].as_str().ok_or("生产图片无效")?.into(),
                        )?;
                        replace(&mut value, &map);
                        let reviewid = required(&value, "sourceReviewId")?.to_owned();
                        let mut review = reviews::get(&mut tx, &reviewid, true)?;
                        reviews::externalize_images(&mut tx, env, &cloud_id, &mut value["images"])?;
                        resources::externalize(
                            &mut tx,
                            env,
                            &format!("迁移/{cloud_id}"),
                            &mut value,
                        )?;
                        let mut summary = value.clone();
                        summary.as_object_mut().unwrap().remove("images");
                        store::write(&mut tx, "job", &cloud_id, None, 1, &value, &summary)?;
                        review.summary["returned"] = json!(text(&value, "status") == "returned");
                        if text(&value, "status") == "pending" {
                            review.summary["impositionJobId"] = json!(cloud_id);
                        }
                        store::write(
                            &mut tx,
                            "review",
                            &reviewid,
                            None,
                            review.version,
                            &review.value,
                            &review.summary,
                        )?;
                    }
                    _ => unreachable!(),
                }
                let number = store::record_id(&mut tx, kind, &cloud_id)?;
                tx.exec_drop("INSERT INTO pf_migrations(installation_key,kind,local_key,cloud_id,cloud_key) VALUES(?,?,?,?,?)",(&installation,kind,&id,number,&cloud_id)).map_err(error)?;
                tx.commit().map_err(error)?;
                Ok(true)
            })();
            match result {
                Ok(true) => imported += 1,
                Ok(false) => skipped += 1,
                Err(e) => errors.push(format!("{kind} {id}: {e}")),
            }
        }
    }
    // Import this user's local pools only once; merge without overwriting public pools.
    if errors.is_empty() && args["pools"].is_array() {
        let mut tx = conn.start_transaction(TxOpts::default()).map_err(error)?;
        let done:Option<String>=tx.exec_first("SELECT cloud_key FROM pf_migrations WHERE installation_key=? AND kind='pools' AND local_key=?",(&installation,user)).map_err(error)?;
        if done.is_none() {
            let old = store::read(&mut tx, "pools", "shared", true)?;
            let mut pools = old
                .as_ref()
                .map(|r| r.value.as_array().cloned().unwrap_or_default())
                .unwrap_or_default();
            for pool in args["pools"].as_array().unwrap() {
                let mut pool = pool.clone();
                pool["id"] = json!(mapped(&installation, "pool", required(&pool, "id")?));
                let keys = pool["imageKeys"]
                    .as_array()
                    .ok_or("本地拼版池无效")?
                    .iter()
                    .filter_map(|v| v.as_str())
                    .filter_map(|key| key.split_once("::"))
                    .filter_map(|(job, asset)| {
                        Some(json!(format!("{}::{}", map.get(job)?, map.get(asset)?)))
                    })
                    .collect::<Vec<_>>();
                pool["imageKeys"] = json!(keys);
                pools.push(pool);
            }
            let pools = json!(pools);
            super::validate_pools(&pools)?;
            store::write(
                &mut tx,
                "pools",
                "shared",
                None,
                old.map_or(1, |r| r.version + 1),
                &pools,
                &json!({"savedAt":store::now()}),
            )?;
            let number = store::record_id(&mut tx, "pools", "shared")?;
            tx.exec_drop("INSERT INTO pf_migrations(installation_key,kind,local_key,cloud_id,cloud_key) VALUES(?,'pools',?,?,'shared')",(&installation,user,number)).map_err(error)?;
        }
        tx.commit().map_err(error)?;
    }
    Ok(json!({"imported":imported,"skipped":skipped,"errors":errors}))
}
