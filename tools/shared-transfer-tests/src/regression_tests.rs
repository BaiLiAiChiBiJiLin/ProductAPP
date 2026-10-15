use crate::{database, files, fixture, store, transport, validation, REVIEW_SVG};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf};

#[test]
fn shared_asset_ids_cannot_freeze_another_batch_during_handoff() {
    let f = Fixture::new();
    f.source.execute("INSERT INTO batches SELECT 'batch-other',saved_at,payload,metadata FROM batches WHERE id='batch-a'", []).unwrap();
    let error = transport::send(&f.source,&f.root.join("share"),&f.root.join("staging"),"batch-a","用户A","用户B",&mut |_,_,_| {}).err().unwrap();
    assert!(error.contains("其他历史批次共用"));
    assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM shared_transfer_outbox",[],|r|r.get(0)).unwrap(),0);
    assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM batches",[],|r|r.get(0)).unwrap(),2);
    store::ensure_editable(&f.source,"asset","asset-a").unwrap();
}

#[test]
fn legacy_review_paths_recover_from_local_assets_before_delivery() {
    let f = Fixture::new();
    f.source.execute("UPDATE schematic_reviews SET payload=json_remove(payload,'$.assets[0].storagePath','$.assets[1].storagePath')",[]).unwrap();
    f.send();
    let received = f.receive();
    assert!(received.errors.is_empty()); assert_eq!(received.imported,1);
    let path: String = f.target.query_row("SELECT json_extract(payload,'$.assets[0].storagePath') FROM schematic_reviews LIMIT 1",[],|r|r.get(0)).unwrap();
    assert!(std::path::Path::new(&path).is_file());
    assert!(std::path::Path::new(&path).starts_with(f.root.join("received")));
}

#[test]
fn retransferring_keeps_ids_bounded_and_all_records_readable() {
    let f = Fixture::new(); f.send(); assert_eq!(f.receive().imported,1);
    let batch: String = f.target.query_row("SELECT id FROM batches",[],|r|r.get(0)).unwrap();
    transport::send(&f.target,&f.root.join("share"),&f.root.join("staging-b"),&batch,"用户B","用户C",&mut |_,_,_| {}).unwrap();
    let third = database();
    let result = transport::receive(&third,&f.root.join("share"),&f.root.join("received-c"),"用户C",&mut |_| Ok(HashMap::new()),&mut |_,_,_| {}).unwrap();
    assert!(result.errors.is_empty()); assert_eq!(result.imported,1);
    let max_id: usize = third.query_row("SELECT max(length(id)) FROM assets",[],|r|r.get(0)).unwrap();
    assert!(max_id<80);
    assert_eq!(third.query_row::<usize,_,_>("SELECT count(*) FROM schematic_reviews",[],|r|r.get(0)).unwrap(),2);
    assert_eq!(third.query_row::<usize,_,_>("SELECT count(*) FROM production_imposition_jobs",[],|r|r.get(0)).unwrap(),1);
}

struct Fixture { root: PathBuf, source: Connection, target: Connection }
impl Fixture {
    fn new() -> Self {
        let root = validation::fresh_local_root().unwrap();
        let source = database();
        let target = database();
        fixture(&source, &root.join("source"));
        Self { root, source, target }
    }
    fn send(&self) -> transport::Manifest {
        transport::send(&self.source, &self.root.join("share"), &self.root.join("staging"), "batch-a", "用户A", "用户B", &mut |_, _, _| {}).unwrap()
    }
    fn receive(&self) -> transport::SyncResult {
        transport::receive(&self.target, &self.root.join("share"), &self.root.join("received"), "用户B", &mut |_| Ok(HashMap::new()), &mut |_, _, _| {}).unwrap()
    }
    fn preparing(&self) {
        fs::create_dir_all(self.root.join("staging")).unwrap();
        self.source.execute("INSERT INTO shared_transfer_outbox(task_id,batch_id,sender,recipient,status,record_ids) VALUES(?1,'batch-a','用户A','用户B','preparing',?2)",
            params!["0123456789abcdef0123456789abcdef", json!({"assets":["asset-a","asset-b"],"reviews":["review-a","review-b"],"jobs":["job-a"]}).to_string()]).unwrap();
    }
    fn status(&self) -> String {
        self.source.query_row("SELECT status FROM shared_transfer_outbox ORDER BY rowid LIMIT 1", [], |r| r.get(0)).unwrap()
    }
    fn assert_no_import(&self) {
        for table in ["assets", "batches", "schematic_reviews", "schematic_review_resources", "production_imposition_jobs", "shared_transfer_receipts"] {
            let count: i64 = self.target.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(count, 0, "unexpected target rows in {table}");
        }
    }
}

#[test]
#[cfg(windows)]
fn live_worker_handle_keeps_preparing_frozen_until_released() {
    let f = Fixture::new();
    f.preparing();
    let worker = files::inbox_lock(&f.root.join("staging")).unwrap();
    transport::recover_preparing(&f.source, &f.root.join("staging")).unwrap();
    assert_eq!(f.status(), "preparing");
    assert!(store::ensure_editable(&f.source, "batch", "batch-a").is_err());
    drop(worker);
    transport::recover_preparing(&f.source, &f.root.join("staging")).unwrap();
    assert_eq!(f.status(), "failed");
}

#[test]
fn abandoned_preparing_can_be_retried_without_duplicate_imports() {
    let f = Fixture::new();
    f.preparing();
    transport::recover_preparing(&f.source, &f.root.join("staging")).unwrap();
    assert_eq!(f.status(), "failed");
    store::ensure_editable(&f.source, "batch", "batch-a").unwrap();
    let sent = f.send();
    assert_ne!(sent.task_id, "0123456789abcdef0123456789abcdef");
    assert_eq!(f.receive().imported, 1);
    assert_eq!(f.receive().imported, 0);
    assert_eq!(transport::finalize(&f.source, &f.root.join("share")).unwrap().0, 1);
}

#[test]
fn completed_handoff_blocks_stale_batch_asset_review_and_job_writes() {
    let f = Fixture::new();
    f.send();
    assert_eq!(f.receive().imported, 1);
    assert_eq!(transport::finalize(&f.source, &f.root.join("share")).unwrap().0, 1);
    assert_eq!(f.status(), "complete");
    for (kind, id) in [("batch", "batch-a"), ("asset", "asset-a"), ("asset", "asset-b"), ("review", "review-a"), ("review", "review-b"), ("job", "job-a")] {
        assert!(store::ensure_editable(&f.source, kind, id).is_err(), "stale {kind}/{id} became editable");
    }
    store::ensure_editable(&f.source, "batch", "unrelated").unwrap();
}

#[test]
fn missing_shared_file_has_no_ack_and_preserves_sender() {
    let f = Fixture::new();
    let sent = f.send();
    let package = f.root.join("share/用户B/inbox").join(format!("task-{}", sent.task_id));
    let svg = sent.files.iter().find(|file| file.name.ends_with(".svg")).unwrap();
    fs::remove_file(package.join(&svg.name)).unwrap();
    let received = f.receive();
    assert_eq!(received.imported, 0);
    assert_eq!(received.errors.len(), 1);
    f.assert_no_import();
    assert!(!package.join("received.json").exists());
    assert_eq!(transport::finalize(&f.source, &f.root.join("share")).unwrap().0, 0);
    assert_eq!(f.source.query_row::<i64, _, _>("SELECT count(*) FROM batches", [], |r| r.get(0)).unwrap(), 1);
    assert!(f.root.join("source/original.svg").is_file());
}

#[test]
fn missing_source_svg_does_not_publish_or_lock_the_batch_forever() {
    let f = Fixture::new();
    fs::remove_file(f.root.join("source/original.svg")).unwrap();
    let result = transport::send(&f.source, &f.root.join("share"), &f.root.join("staging"), "batch-a", "用户A", "用户B", &mut |_, _, _| {});
    assert!(result.is_err());
    assert_eq!(f.status(), "failed");
    store::ensure_editable(&f.source, "batch", "batch-a").unwrap();
    assert_eq!(f.receive().imported, 0);
    f.assert_no_import();
}

#[test]
fn review_blob_svg_resolves_and_canvas_layout_stays_unchanged() {
    let f = Fixture::new();
    let original: String = f.source.query_row("SELECT payload FROM schematic_reviews WHERE id='review-a'", [], |r| r.get(0)).unwrap();
    let original: Value = serde_json::from_str(&original).unwrap();
    f.send();
    assert_eq!(f.receive().imported, 1);
    let (new_id, imported): (String, String) = f.target.query_row("SELECT id,payload FROM schematic_reviews WHERE json_extract(payload,'$.sourceRecordId')=''", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let imported: Value = serde_json::from_str(&imported).unwrap();
    assert_ne!(new_id, "review-a");
    let mut expected_pages = original["pages"].clone();
    for item in expected_pages[0]["items"].as_array_mut().unwrap() {
        item["assetId"] = imported["assets"][0]["id"].clone();
    }
    assert_eq!(imported["pages"], expected_pages);
    assert_eq!(imported["display"], original["display"]);
    for asset in imported["assets"].as_array().unwrap() {
        let resource_id = asset["svg"].as_str().unwrap().strip_prefix("printflow-review:").unwrap();
        let svg: Vec<u8> = f.target.query_row("SELECT content FROM schematic_review_resources WHERE record_id=?1 AND resource_id=?2", params![new_id, resource_id], |r| r.get(0)).unwrap();
        assert_eq!(svg, REVIEW_SVG);
    }
}

#[test]
fn missing_review_blob_reference_is_rejected_before_ack() {
    let f = Fixture::new();
    f.source.execute("UPDATE schematic_reviews SET payload=json_set(payload,'$.assets[0].svg','printflow-review:missing') WHERE id='review-a'", []).unwrap();
    let outcome = transport::send(&f.source, &f.root.join("share"), &f.root.join("staging"), "batch-a", "用户A", "用户B", &mut |_, _, _| {});
    if let Ok(sent) = outcome {
        let received = f.receive();
        assert_eq!(received.imported, 0, "a dangling review SVG reference was accepted");
        assert_eq!(received.errors.len(), 1);
        assert!(!f.root.join("share/用户B/inbox").join(format!("task-{}", sent.task_id)).join("received.json").exists());
    }
    f.assert_no_import();
    assert_eq!(transport::finalize(&f.source, &f.root.join("share")).unwrap().0, 0);
}

#[test]
fn receiver_rejects_dangling_review_blob_even_with_valid_file_checksums() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    let mut sent = f.send();
    let package = f.root.join("share/用户B/inbox").join(format!("task-{}", sent.task_id));
    let packet_path = package.join("package.sqlite");
    let packet = Connection::open(&packet_path).unwrap();
    packet.execute("DELETE FROM resources WHERE record_id='review-a' AND resource_id='r0'", []).unwrap();
    packet.close().unwrap();
    // Deliberately construct a logically invalid but byte-consistent synthetic package.
    let bytes = fs::read(&packet_path).unwrap();
    let entry = sent.files.iter_mut().find(|entry| entry.name == "package.sqlite").unwrap();
    entry.bytes = bytes.len() as u64;
    entry.sha256 = format!("{:x}", Sha256::digest(&bytes));
    fs::write(package.join("manifest.json"), serde_json::to_vec(&sent).unwrap()).unwrap();
    let received = f.receive();
    assert_eq!(received.imported, 0);
    assert_eq!(received.errors.len(), 1);
    assert!(!package.join("received.json").exists());
    f.assert_no_import();
}

#[test]
fn disk_databases_reopen_without_duplicate_import_or_finalization() {
    let local = validation::fresh_local_root().unwrap();
    let report = validation::run(&local, &local.join("share")).unwrap();
    assert_eq!(report["imported"], 1);
    assert_eq!(report["importedAfterReopen"], 0);
    assert_eq!(report["finalized"], 1);
    assert_eq!(report["finalizedAfterReopen"], 0);
    assert_eq!(report["databaseMode"], "two local disk-backed SQLite databases");
}

#[test]
fn shared_root_follows_tauri_environment_mode() {
    assert_eq!(transport::root_for_environment(true), r"\\192.168.0.66\电商文件\printFlow\dev\historyProduction");
    assert_eq!(transport::root_for_environment(false), r"\\192.168.0.66\电商文件\printFlow\production\historyProduction");
}
