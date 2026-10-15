//! Synthetic, isolated send/receive/finalize check using the real transfer modules.
//! SQLite databases remain local even when the package exchange uses an SMB path.
use crate::{fixture, initialize_database, store, transport, REVIEW_SVG};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::{Path, PathBuf}};

type Result<T> = std::result::Result<T, String>;

pub fn fresh_local_root() -> Result<PathBuf> {
    let seed = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let id: String = seed.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let root = std::env::temp_dir().join(format!("printflow-handoff-{}-{id}", std::process::id()));
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn open_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // Match the application's local SQLite mode; no database is opened over SMB.
    conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
    initialize_database(&conn)?;
    Ok(conn)
}

fn check(condition: bool, message: &str) -> Result<()> {
    if condition { Ok(()) } else { Err(message.into()) }
}

fn counts(conn: &Connection) -> Result<Value> {
    let mut output = serde_json::Map::new();
    for table in ["batches", "assets", "schematic_reviews", "schematic_review_resources", "production_imposition_jobs", "shared_transfer_receipts"] {
        let count: u64 = conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).map_err(|e| e.to_string())?;
        output.insert(table.into(), json!(count));
    }
    Ok(Value::Object(output))
}

fn receive(conn: &Connection, shared: &Path, local: &Path) -> Result<transport::SyncResult> {
    transport::receive(conn, shared, local, "合成接收者", &mut |names| {
        Ok(names.iter().map(|name| (name.clone(), "custom:99".into())).collect::<HashMap<_, _>>())
    }, &mut |_, _, _| {})
}

pub fn run(local: &Path, shared: &Path) -> Result<Value> {
    // Never operate inside an existing shared task folder or existing database.
    check(local.is_dir(), "local validation root must already exist")?;
    check(!shared.exists(), "shared test root already exists; choose a fresh probe-handoff directory")?;
    let source_path = local.join("sender.sqlite");
    let target_path = local.join("recipient.sqlite");
    check(!source_path.exists() && !target_path.exists(), "validation databases already exist")?;
    fs::create_dir(shared).map_err(|e| format!("cannot create isolated shared test directory: {e}"))?;
    let source = open_database(&source_path)?;
    let target = open_database(&target_path)?;
    fixture(&source, &local.join("source"));
    let source_before = counts(&source)?;
    let original_review: String = source.query_row("SELECT payload FROM schematic_reviews WHERE id='review-a'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let original_review: Value = serde_json::from_str(&original_review).map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    let manifest = transport::send(&source, shared, &local.join("staging"), "batch-a", "合成发送者", "合成接收者", &mut |_, _, _| {})?;
    check((manifest.asset_count, manifest.review_count, manifest.job_count) == (2, 2, 1), "unexpected exported counts")?;
    let package = shared.join("合成接收者/inbox").join(format!("task-{}", manifest.task_id));
    for file in &manifest.files { crate::files::verify(&package, file)?; }
    let received = receive(&target, shared, &local.join("received"))?;
    check(received.imported == 1 && received.errors.is_empty(), &format!("receive failed: {:?}", received.errors))?;
    check(package.join("received.json").is_file(), "receiver did not publish acknowledgement")?;
    drop(target);
    drop(source);

    // Simulate two application restarts with independent disk-backed databases.
    let source = open_database(&source_path)?;
    let target = open_database(&target_path)?;
    let repeated = receive(&target, shared, &local.join("received"))?;
    check(repeated.imported == 0 && repeated.errors.is_empty(), "reopened receiver duplicated the task")?;
    let target_after = counts(&target)?;
    check(target_after == json!({"batches":1,"assets":2,"schematic_reviews":2,"schematic_review_resources":2,"production_imposition_jobs":1,"shared_transfer_receipts":1}), "recipient row counts differ")?;
    let payload: String = target.query_row("SELECT payload FROM batches", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let assets: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    let asset_id = assets[0]["id"].as_str().ok_or("received asset ID missing")?;
    check(asset_id != "asset-a" && assets[1]["productGroupLeaderId"] == asset_id, "group identity mapping differs")?;
    check(assets[0]["sourceGroupWidthMm"] == 13.261709 && assets[0]["attributes"]["QT"] == "0" && assets[1]["attributes"]["QT"] == "", "dimensions or QT changed")?;
    check(assets[0]["productId"] == "custom:99" && assets[0]["productGroupPosition"] == 2, "custom product or order changed")?;
    for asset in assets.as_array().ok_or("received assets missing")? {
        let path = Path::new(asset["storagePath"].as_str().ok_or("received path missing")?);
        check(path.starts_with(local.join("received")), "received asset path points outside local recipient storage")?;
        check(fs::read(path).map_err(|e| e.to_string())? == fs::read(local.join("source/original.svg")).map_err(|e| e.to_string())?, "SVG bytes changed")?;
    }
    let note_path = assets[0]["noteImages"][0]["src"].as_str().ok_or("note file missing")?;
    check(fs::read(note_path).map_err(|e| e.to_string())? == b"original note bytes", "note bytes changed")?;
    let (review_id, review): (String, String) = target.query_row("SELECT id,payload FROM schematic_reviews WHERE json_extract(payload,'$.sourceRecordId')=''", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
    let review: Value = serde_json::from_str(&review).map_err(|e| e.to_string())?;
    let mut expected_pages = original_review["pages"].clone();
    for item in expected_pages[0]["items"].as_array_mut().ok_or("fixture canvas missing")? { item["assetId"] = json!(asset_id); }
    check(review["pages"] == expected_pages && review["display"] == original_review["display"], "canvas layout changed")?;
    for asset in review["assets"].as_array().ok_or("review assets missing")? {
        let resource = asset["svg"].as_str().and_then(|s| s.strip_prefix("printflow-review:")).ok_or("review SVG reference missing")?;
        let svg: Vec<u8> = target.query_row("SELECT content FROM schematic_review_resources WHERE record_id=?1 AND resource_id=?2", params![review_id, resource], |r| r.get(0)).map_err(|e| e.to_string())?;
        check(svg == REVIEW_SVG, "review SVG blob changed")?;
    }
    let images: String = target.query_row("SELECT images FROM production_imposition_jobs", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let images: Value = serde_json::from_str(&images).map_err(|e| e.to_string())?;
    check(images[0]["id"] == asset_id && images[0]["filePath"] == assets[0]["storagePath"], "production resource reference changed")?;
    let (finalized, cleanup) = transport::finalize(&source, shared)?;
    check(finalized == 1 && !cleanup.is_empty(), "sender did not finalize")?;
    for (kind, id) in [("batch", "batch-a"), ("asset", "asset-a"), ("review", "review-a"), ("job", "job-a")] {
        check(store::ensure_editable(&source, kind, id).is_err(), "completed old record became editable")?;
    }
    drop(source);
    drop(target);
    let source = open_database(&source_path)?;
    let target = open_database(&target_path)?;
    let finalized_again = transport::finalize(&source, shared)?.0;
    check(finalized_again == 0, "reopened sender finalized twice")?;
    let source_after = counts(&source)?;
    check(source_after == json!({"batches":0,"assets":0,"schematic_reviews":0,"schematic_review_resources":0,"production_imposition_jobs":0,"shared_transfer_receipts":0}), "sender records not fully finalized")?;
    check(counts(&target)? == target_after, "reopened recipient records changed")?;
    Ok(json!({
        "status":"passed", "executedAtUtc":chrono::Utc::now().to_rfc3339(),
        "scope":"single Windows machine; sender and recipient are simulated by separate local databases",
        "databaseMode":"two local disk-backed SQLite databases", "sharedRoot":shared, "localRoot":local,
        "taskId":manifest.task_id, "packageFiles":manifest.files.len(), "packageBytes":manifest.files.iter().map(|f| f.bytes).sum::<u64>(),
        "senderBefore":source_before, "senderAfter":source_after, "recipientAfter":target_after,
        "imported":received.imported, "importedAfterReopen":repeated.imported,
        "finalized":finalized, "finalizedAfterReopen":finalized_again,
        "verified":["package SHA-256 and lengths", "asset IDs and group leader mapping", "source SVG bytes", "physical dimensions", "QT zero/blank", "custom product mapping", "named note image bytes", "review SVG BLOB references", "canvas geometry and display overrides", "production file paths", "stale source edit rejection", "database reopen idempotency"],
        "sourceFileCleanup":"Not performed by this harness; finalize returned cleanup candidates, synthetic source files are retained for inspection.",
        "untested":["two physical PCs", "network disconnect", "server restart", "desktop UI", "real user data"],
        "elapsedMs":started.elapsed().as_millis()
    }))
}
