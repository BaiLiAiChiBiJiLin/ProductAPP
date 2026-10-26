//! Explicit cleanup of legacy SQLite records and software-managed SVG files.
//! File work is queued transactionally so an interrupted cleanup can be retried.
use super::{config::Environment, store::Result};
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

pub fn snapshot(db: &Connection) -> Result<String> {
    let mut digest = Sha256::new();
    for table in ["batches", "schematic_reviews", "production_imposition_jobs"] {
        digest.update(table.as_bytes());
        let mut stmt = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY id"))
            .map_err(|e| e.to_string())?;
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            for col in 0..columns {
                let value = row.get_ref(col).map_err(|e| e.to_string())?;
                let bytes = format!("{value:?}");
                digest.update(bytes.len().to_le_bytes());
                digest.update(bytes.as_bytes());
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn ensure_queue(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS cloud_local_cleanup_files(path TEXT PRIMARY KEY)")
        .map_err(|e| e.to_string())
}

pub fn pending(db: &Connection) -> Result<usize> {
    ensure_queue(db)?;
    db.query_row("SELECT COUNT(*) FROM cloud_local_cleanup_files", [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

fn collect(value: &Value, paths: &mut BTreeSet<String>, assets: &mut BTreeSet<String>) {
    match value {
        Value::Object(o) => {
            if let Some(path) = o
                .get("storagePath")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
            {
                paths.insert(path.into());
            }
            if o.contains_key("svg") || o.contains_key("storagePath") {
                if let Some(id) = o.get("id").and_then(Value::as_str) {
                    assets.insert(id.into());
                }
            }
            for v in o.values() {
                collect(v, paths, assets);
            }
        }
        Value::Array(a) => {
            for v in a {
                collect(v, paths, assets);
            }
        }
        _ => {}
    }
}

// Caller holds a SQLite immediate transaction; never recursively delete directories.
pub fn stage(db: &Connection) -> Result<usize> {
    ensure_queue(db)?;
    let mut paths = BTreeSet::new();
    let mut assets = BTreeSet::new();
    let mut removed = 0;
    for (table, column) in [
        ("batches", "payload"),
        ("schematic_reviews", "payload"),
        ("production_imposition_jobs", "images"),
        ("assets", "payload"),
    ] {
        let mut stmt = db
            .prepare(&format!("SELECT {column} FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let value: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|_| "本机旧记录格式错误，未执行删除")?;
            collect(&value, &mut paths, &mut assets);
            removed += 1;
        }
    }
    for path in paths {
        // Only paths from the selected legacy records enter the durable queue.
        db.execute(
            "INSERT OR IGNORE INTO cloud_local_cleanup_files(path) VALUES(?1)",
            [path],
        )
        .map_err(|e| e.to_string())?;
    }
    for table in [
        "schematic_review_resources",
        "schematic_review_payment_states",
        "production_imposition_jobs",
        "schematic_reviews",
        "batches",
    ] {
        db.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| e.to_string())?;
    }
    for table in [
        "batch_thumbnail_cache",
        "shared_transfer_outbox",
        "shared_transfer_receipts",
        "batch_asset_directories",
        "assets",
    ] {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            db.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    for id in assets {
        db.execute("DELETE FROM assets WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

pub fn drain(db: &Connection, env: &Environment) -> Result<()> {
    ensure_queue(db)?;
    let mut stmt = db
        .prepare("SELECT path FROM cloud_local_cleanup_files")
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for path in paths {
        let file = Path::new(&path);
        if file
            .try_exists()
            .map_err(|_| "本地旧文件不可访问，恢复连接后可重试清理")?
        {
            // Shared files are never part of local cleanup, even if an old record points there.
            let actual = std::fs::canonicalize(file).map_err(|_| "无法检查本地旧文件")?;
            let shared = std::fs::canonicalize(&env.storage_root)
                .map_err(|_| "无法核对共享目录，暂不删除本地文件")?;
            if !actual.starts_with(shared) {
                crate::asset_storage::remove_saved_file(db, file)?;
            }
        }
        db.execute(
            "DELETE FROM cloud_local_cleanup_files WHERE path=?1",
            [&path],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
