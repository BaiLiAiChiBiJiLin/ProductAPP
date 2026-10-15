#[path = "../../../src-tauri/src/shared_transfers/files.rs"]
pub mod files;
#[path = "../../../src-tauri/src/shared_transfers/store.rs"]
pub mod store;
#[path = "../../../src-tauri/src/shared_transfers/transport.rs"]
pub mod transport;
#[path = "../../../src-tauri/src/shared_transfers/cleanup.rs"]
pub mod cleanup;
pub mod validation;

#[cfg(test)]
mod regression_tests;
#[cfg(test)]
mod cleanup_tests;

pub fn database() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    initialize_database(&conn).unwrap();
    conn
}

pub fn initialize_database(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,saved_at TEXT NOT NULL,payload TEXT NOT NULL,metadata TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS batch_asset_directories(batch_id TEXT PRIMARY KEY,directory TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS schematic_reviews(id TEXT PRIMARY KEY,saved_at TEXT NOT NULL,summary TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS schematic_review_resources(record_id TEXT NOT NULL,resource_id TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(record_id,resource_id));
        CREATE TABLE IF NOT EXISTS schematic_review_payment_states(record_id TEXT PRIMARY KEY,payment_status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS production_imposition_jobs(id TEXT PRIMARY KEY,source_review_id TEXT NOT NULL UNIQUE,customer_name TEXT NOT NULL,output TEXT NOT NULL,submitted_at TEXT NOT NULL,payment_status TEXT NOT NULL,status TEXT NOT NULL,image_count INTEGER NOT NULL,images TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;
    store::ensure_store(conn)
}

pub const REVIEW_SVG: &[u8] = b"<svg xmlns='http://www.w3.org/2000/svg' width='50mm' height='70mm' viewBox='0 0 50 70'><rect width='50' height='70' fill='#1258df'/></svg>";

pub fn fixture(conn: &rusqlite::Connection, root: &std::path::Path) {
    use serde_json::json;
    use rusqlite::params;
    std::fs::create_dir_all(root).unwrap();
    let svg = root.join("original.svg");
    std::fs::write(&svg,b"<svg xmlns='http://www.w3.org/2000/svg' width='50mm' height='70mm'><path d='M0 0h50v70H0Z'/></svg>").unwrap();
    let note_file = root.join("note.png");
    std::fs::write(&note_file,b"original note bytes").unwrap();
    let output = root.join("customer-proof.pdf");
    std::fs::write(&output,b"exported proof bytes").unwrap();
    let assets = json!([
        {"id":"asset-a","name":"A","svg":"","storagePath":svg,"productId":"custom:1","productName":"Shaker","width":50.123,"height":70.456,
         "sourceGroupWidthMm":13.261709,"sourceGroupHeightMm":18.641483,"sourceImages":[{"pixelWidth":2048,"pixelHeight":4096}],
         "attributes":{"QT":"0","Epoxy Style":"Front Side Epoxy"},"attributesConfirmed":true,"productGroupId":"group-a","productGroupLeaderId":"asset-a","productGroupPosition":2,"productGroupColor":"#ffe7ba",
         "note":"不要把 asset-a 或 C:\\用户 这样的备注改掉","noteImages":[{"name":"Front","src":note_file},{"name":"","src":"data:image/png;base64,AA=="}]},
        {"id":"asset-b","name":"B","svg":"","storagePath":svg,"productId":"custom:1","productName":"Shaker","width":50.123,"height":70.456,"attributes":{"QT":""},
         "productGroupId":"group-a","productGroupLeaderId":"asset-a","productGroupPosition":3,"productGroupColor":"#ffe7ba"}
    ]);
    conn.execute("INSERT INTO batches VALUES('batch-a','2026-10-14T01:00:00Z',?1,?2)",params![assets.to_string(),json!({"customerName":"客户A","designer":"本地"}).to_string()]).unwrap();
    for asset in assets.as_array().unwrap() {
        conn.execute("INSERT INTO assets VALUES(?1,?2)",params![asset["id"].as_str().unwrap(),asset.to_string()]).unwrap();
    }
    for id in ["review-a","review-b"] {
        let mut review_assets = assets.clone();
        review_assets[0]["svg"] = json!("printflow-review:r0");
        review_assets[1]["svg"] = json!("printflow-review:r0");
        let snapshot = json!({"schemaVersion":1,"id":id,"sourceBatchId":"batch-a","sourceRecordId":if id=="review-b" {"review-a"} else {""},"savedAt":"2026-10-14T01:01:00Z","output":output,"format":"pdf",
            "assets":review_assets,"pages":[{"id":1,"width":210,"height":297,"items":[{"id":"canvas-front","assetId":"asset-a","x":12.25,"y":33.5,"width":50.123,"height":70.456,"rotation":30,"scaleX":0.75,"scaleY":0.75},{"id":"canvas-back","assetId":"asset-a","derivedFrom":"canvas-front","x":76.5,"y":33.5}],"imageGroups":[{"id":"canvas-group","itemIds":["canvas-front","canvas-back"],"color":"#ffe7ba","x":10,"y":30,"width":140,"height":90}],"headers":[{"id":"header-a","text":"Front / Back","x":10,"y":20}]}],
            "display":{"dimensionDisplayOverrides":[["canvas-front",{"decimalPlaces":2}]]},"defaultArrangementIds":["asset-a","asset-b"]});
        conn.execute("INSERT INTO schematic_reviews VALUES(?1,'2026-10-14T01:01:00Z',?2,?3)",params![id,json!({"id":id,"output":output,"savedAt":"2026-10-14T01:01:00Z","paymentStatus":"unpaid"}).to_string(),snapshot.to_string()]).unwrap();
        conn.execute("INSERT INTO schematic_review_payment_states VALUES(?1,'paid')",[id]).unwrap();
        conn.execute("INSERT INTO schematic_review_resources VALUES(?1,'r0',?2)",params![id,REVIEW_SVG]).unwrap();
    }
    let images = json!([{"id":"asset-a","filePath":svg,"widthMm":13.261709,"heightMm":18.641483,"productId":"custom:1","productName":"Shaker","attributes":{"QT":"0"},"productGroupLeaderId":"asset-a","noteImages":[{"src":note_file,"name":"Front"}]}]);
    conn.execute("INSERT INTO production_imposition_jobs VALUES('job-a','review-b','客户A',?1,'2026-10-14T01:02:00Z','paid','pending',1,?2)",params![output.to_string_lossy().as_ref(),images.to_string()]).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use serde_json::Value;

    struct Fixture { root: PathBuf, source: rusqlite::Connection, target: rusqlite::Connection }
    impl Fixture {
        fn new() -> Self {
            let id: String = database().query_row("SELECT lower(hex(randomblob(16)))",[],|r| r.get(0)).unwrap();
            let root = std::env::temp_dir().join(format!("printflow-transfer-test-{id}"));
            let source = database(); let target = database();
            fixture(&source,&root.join("source"));
            Self { root,source,target }
        }
        fn send(&self) -> transport::Manifest { transport::send(&self.source,&self.root.join("share"),&self.root.join("staging"),"batch-a","用户A","用户B",&mut |_,_,_| {}).unwrap() }
        fn receive(&self) -> transport::SyncResult { transport::receive(&self.target,&self.root.join("share"),&self.root.join("received"),"用户B",&mut |names| Ok(names.iter().map(|n| (n.clone(),"custom:99".into())).collect()),&mut |_,_,_| {}).unwrap() }
        fn count(&self, table: &str) -> i64 { self.target.query_row(&format!("SELECT count(*) FROM {table}"),[],|r| r.get(0)).unwrap() }
    }

    #[test]
    fn complete_handoff_preserves_all_three_stages_and_is_idempotent() {
        let f = Fixture::new(); let sent = f.send();
        assert_eq!((sent.asset_count,sent.review_count,sent.job_count),(2,2,1));
        assert!(store::ensure_editable(&f.source,"batch","batch-a").is_err());
        assert!(store::ensure_editable(&f.source,"review","review-a").is_err());
        assert!(store::ensure_editable(&f.source,"job","job-a").is_err());
        assert_eq!(f.receive().imported,1);
        assert_eq!(f.receive().imported,0);
        assert_eq!((f.count("batches"),f.count("schematic_reviews"),f.count("production_imposition_jobs"),f.count("shared_transfer_receipts")),(1,2,1,1));
        let payload: String = f.target.query_row("SELECT payload FROM batches",[],|r| r.get(0)).unwrap();
        let assets: Value = serde_json::from_str(&payload).unwrap();
        let new_id = assets[0]["id"].as_str().unwrap();
        assert_ne!(new_id,"asset-a");
        assert_eq!(assets[1]["productGroupLeaderId"],new_id);
        assert_eq!(assets[0]["productGroupId"],"group-a");
        assert_eq!(assets[0]["productGroupPosition"],2);
        assert_eq!(assets[1]["productGroupPosition"],3);
        assert_eq!(assets[0]["productId"],"custom:99");
        assert_eq!(assets[0]["width"],50.123);
        assert_eq!(assets[0]["sourceGroupWidthMm"],13.261709);
        assert_eq!(assets[0]["attributes"]["QT"],"0");
        assert_eq!(assets[1]["attributes"]["QT"],"");
        assert_eq!(assets[0]["note"],"不要把 asset-a 或 C:\\用户 这样的备注改掉");
        assert_eq!(std::fs::read(assets[0]["storagePath"].as_str().unwrap()).unwrap(),std::fs::read(f.root.join("source/original.svg")).unwrap());
        assert_eq!(std::fs::read(assets[0]["noteImages"][0]["src"].as_str().unwrap()).unwrap(),b"original note bytes");
        assert_eq!(assets[0]["noteImages"][0]["name"],"Front");
        let snapshots: Vec<String> = f.target.prepare("SELECT payload FROM schematic_reviews").unwrap().query_map([],|r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        for text in snapshots {
            let review: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(review["pages"][0]["items"][0]["id"],"canvas-front");
            assert_eq!(review["pages"][0]["items"][1]["derivedFrom"],"canvas-front");
            assert_eq!(review["pages"][0]["items"][0]["assetId"],new_id);
            assert_eq!(review["pages"][0]["imageGroups"][0]["itemIds"][0],"canvas-front");
            assert_eq!(review["display"]["dimensionDisplayOverrides"][0][0],"canvas-front");
            assert_eq!(review["defaultArrangementIds"][0],new_id);
        }
        let bytes: Vec<u8> = f.target.query_row("SELECT content FROM schematic_review_resources LIMIT 1",[],|r| r.get(0)).unwrap();
        assert_eq!(bytes,REVIEW_SVG);
        let payment: String = f.target.query_row("SELECT payment_status FROM schematic_review_payment_states LIMIT 1",[],|r| r.get(0)).unwrap();
        assert_eq!(payment,"paid");
        let images: String = f.target.query_row("SELECT images FROM production_imposition_jobs",[],|r| r.get(0)).unwrap();
        let images: Value = serde_json::from_str(&images).unwrap();
        assert_eq!(images[0]["id"],new_id);
        assert_eq!(images[0]["filePath"],assets[0]["storagePath"]);
        let (completed,paths) = transport::finalize(&f.source,&f.root.join("share")).unwrap();
        assert_eq!(completed,1); assert!(!paths.is_empty());
        assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM batches",[],|r| r.get(0)).unwrap(),0);
        assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM schematic_reviews",[],|r| r.get(0)).unwrap(),0);
        assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM production_imposition_jobs",[],|r| r.get(0)).unwrap(),0);
        assert_eq!(transport::finalize(&f.source,&f.root.join("share")).unwrap().0,0);
    }

    #[test]
    fn corrupt_package_is_rejected_without_deleting_source_or_importing_rows() {
        let f = Fixture::new(); let sent = f.send();
        let package = f.root.join("share/用户B/inbox").join(format!("task-{}",sent.task_id));
        let resource = sent.files.iter().find(|f| f.name.ends_with(".svg")).unwrap();
        std::fs::write(package.join(&resource.name),b"corrupt").unwrap();
        let received = f.receive();
        assert_eq!(received.imported,0); assert_eq!(received.errors.len(),1);
        assert_eq!(f.count("batches"),0); assert_eq!(f.count("schematic_reviews"),0);
        assert!(!package.join("received.json").exists());
        assert_eq!(transport::finalize(&f.source,&f.root.join("share")).unwrap().0,0);
        assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM batches",[],|r| r.get(0)).unwrap(),1);
    }

    #[test]
    fn user_paths_are_validated_and_directory_registration_is_repeatable() {
        let f = Fixture::new();
        for bad in ["../用户","用户/其他","CON","NUL.txt","..","COM1","用户."] { assert!(transport::register(&f.root.join("share"),bad).is_err()); }
        let one = transport::register(&f.root.join("share"),"用户A").unwrap();
        assert_eq!(one,transport::register(&f.root.join("share"),"用户A").unwrap());
        transport::register(&f.root.join("share"),"用户B").unwrap();
        assert_eq!(transport::users(&f.root.join("share"),"用户A").unwrap(),vec!["用户B"]);
    }

    #[test]
    fn same_transfer_cannot_be_sent_twice_while_waiting_for_receipt() {
        let f = Fixture::new(); f.send();
        let result = transport::send(&f.source,&f.root.join("share"),&f.root.join("staging"),"batch-a","用户A","用户B",&mut |_,_,_| {});
        assert!(result.is_err());
        assert_eq!(f.source.query_row::<i64,_,_>("SELECT count(*) FROM shared_transfer_outbox",[],|r| r.get(0)).unwrap(),1);
    }

    #[test]
    fn interrupted_publication_resumes_and_missing_ack_is_recreated_without_duplicates() {
        let f = Fixture::new(); let sent = f.send();
        let inbox = f.root.join("share/用户B/inbox");
        std::fs::rename(inbox.join(format!("task-{}",sent.task_id)),inbox.join(format!(".pending-{}",sent.task_id))).unwrap();
        f.source.execute("UPDATE shared_transfer_outbox SET status='publishing'",[]).unwrap();
        assert_eq!(transport::finalize(&f.source,&f.root.join("share")).unwrap().0,0);
        assert!(inbox.join(format!("task-{}",sent.task_id)).is_dir());
        assert_eq!(f.receive().imported,1);
        let receipt = inbox.join(format!("task-{}",sent.task_id)).join("received.json");
        std::fs::remove_file(&receipt).unwrap();
        assert_eq!(f.receive().imported,0);
        assert!(receipt.is_file());
        assert_eq!(f.count("batches"),1);
    }
}
