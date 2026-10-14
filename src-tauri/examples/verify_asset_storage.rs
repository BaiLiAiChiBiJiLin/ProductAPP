//! cargo test --example verify_asset_storage
pub use app_lib::assets;
use assets::Asset;
#[derive(serde::Serialize)]
struct BatchRecord {
    id: String,
    saved_at: String,
    assets: Vec<Asset>,
    metadata: serde_json::Value,
}
#[path = "../src/asset_storage.rs"]
mod asset_storage;
#[path = "../src/batch_history.rs"]
mod batch_history;
#[path = "../src/batch_thumbnails.rs"]
mod batch_thumbnails;
#[allow(dead_code)]
#[path = "../src/production_imposition.rs"]
mod production_imposition;
#[allow(dead_code)]
#[path = "../src/schematic_review.rs"]
mod schematic_review;
#[allow(dead_code)]
#[path = "../src/staged_artwork.rs"]
mod staged_artwork;
// Native commands are compiled but never called by these isolated DB/file tests.
fn database(_: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    Err("测试禁止访问用户数据库".into())
}
fn main() {}

#[test]
fn named_note_images_persist_through_batch_save_reopen_and_clear() {
    use rusqlite::{params, Connection};
    use serde_json::json;
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT,metadata TEXT)").unwrap();
    let images = json!([
        {"src":"data:image/png;base64,YQ==","name":"正面"},
        {"src":"data:image/png;base64,Yg==","name":""},
        {"src":"data:image/png;base64,Yw==","name":"背面"}
    ]);
    let base = json!({"id":"asset","name":"test","productId":"p","width":10,"height":10,"svg":"<svg/>","note":"文字","noteImage":"data:image/png;base64,YQ=="});
    for (batch_id, image_list) in [("legacy", None), ("named", Some(images.clone())), ("cleared", Some(json!([])))] {
        let mut input = base.clone();
        if let Some(value) = image_list { input["noteImages"] = value; }
        let asset: Asset = serde_json::from_value(input).unwrap();
        conn.execute("INSERT INTO batches VALUES(?1,'2026-10-14',?2,'{}')", params![batch_id, serde_json::to_string(&vec![asset]).unwrap()]).unwrap();
    }
    let legacy = serde_json::to_value(&batch_history::manifest(&conn, "legacy").unwrap().assets[0]).unwrap();
    assert!(legacy.get("noteImages").is_none());
    assert_eq!(legacy["noteImage"], base["noteImage"]);
    let named = serde_json::to_value(&batch_history::manifest(&conn, "named").unwrap().assets[0]).unwrap();
    assert_eq!(named["noteImages"], images);
    assert_eq!(named["note"], "文字");
    let cleared = serde_json::to_value(&batch_history::manifest(&conn, "cleared").unwrap().assets[0]).unwrap();
    assert_eq!(cleared["noteImages"], json!([]));
}

#[test]
fn history_opens_old_and_new_roots_after_restart_with_exact_artwork_and_properties() {
    use rusqlite::Connection;
    use serde_json::json;
    use std::{fs, path::Path};
    let root = std::env::temp_dir().join(format!(
        "printflow-history-storage-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let db = root.join("test.sqlite");
    let default = root.join("printflow-data/assets");
    let svg = "<svg width=\"44.477mm\" height=\"192.807mm\"><text>原文件 Ω</text></svg>";
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE batches(id TEXT PRIMARY KEY,saved_at TEXT,payload TEXT,metadata TEXT)",
        )
        .unwrap();
        for id in ["old", "new"] {
            if id == "new" {
                asset_storage::save_settings(
                    &conn,
                    &default,
                    root.join("自选目录").to_str().unwrap(),
                    &root.join("temp-assets"),
                )
                .unwrap();
            }
            let tx = conn.unchecked_transaction().unwrap();
            let folder = asset_storage::batch_directory(&tx, &default, id, "同名客户").unwrap();
            let asset: Asset = serde_json::from_value(json!({"id":id,"name":"原图","productId":"p","width":42.0,"height":85.0,"svg":svg,"sourceGroupWidthMm":44.477,"sourceGroupHeightMm":192.807,"attributes":{"QT":"0"}})).unwrap();
            let mut saved = asset_storage::persist(vec![asset], &folder).unwrap();
            saved[0].svg.clear();
            tx.execute(
                "INSERT INTO batches VALUES(?1,'2026-10-09',?2,'{}')",
                rusqlite::params![id, serde_json::to_string(&saved).unwrap()],
            )
            .unwrap();
            tx.commit().unwrap();
        }
    }
    {
        let conn = Connection::open(db).unwrap();
        for id in ["old", "new"] {
            let record = batch_history::manifest(&conn, id).unwrap();
            assert_eq!(record.assets[0].source_group_width_mm, 44.477);
            assert_eq!(record.assets[0].attributes["QT"], "0");
            let expected = if id == "old" {
                &default
            } else {
                &root.join("自选目录")
            };
            assert!(Path::new(&record.assets[0].storage_path).starts_with(expected));
            assert_eq!(
                batch_history::artwork(&conn, id, id).unwrap(),
                svg.as_bytes()
            );
        }
    }
    let resolved = fs::canonicalize(&root).unwrap();
    assert!(resolved.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
    assert!(resolved
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("printflow-history-storage-test-"));
    fs::remove_dir_all(resolved).unwrap();
}
