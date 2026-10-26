use super::*;
use mysql::{prelude::Queryable, OptsBuilder, Pool};
use serde_json::json;

#[test]
fn stale_revisions_and_invalid_pool_membership_are_rejected() {
    let r = store::Record {
        value: Value::Null,
        summary: Value::Null,
        version: 4,
        owner: Some("alice".into()),
    };
    assert!(store::check_version(Some(&r), 3).is_err());
    assert!(store::owned(&r, "bob").is_err());
    assert!(store::check_version(None, 1).is_err());
    assert!(validate_pools(&json!([{"id":"a","name":"A","imageKeys":["one"]},{"id":"b","name":"B","imageKeys":["one"]}])).is_err());
}

fn request(
    conn: &mut mysql::PooledConn,
    env: &config::Environment,
    user: &str,
    command: &str,
    args: Value,
    version: u64,
) -> Result<Value> {
    let id = store::uuid(conn)?;
    store::exclusive(conn, |conn| {
        execute_request(conn, env, user, command, &args, version, Some(id))
    })
    .map(|v| v["result"].clone())
}

// Explicit opt-in. Runs against a disposable database on loopback only, never RDS.
#[test]
#[ignore = "requires a disposable loopback MySQL/MariaDB server and PRINTFLOW_MYSQL_TEST_PASSWORD"]
fn two_users_shared_business_roundtrip() {
    let password =
        std::env::var("PRINTFLOW_MYSQL_TEST_PASSWORD").expect("explicit test password required");
    let options = OptsBuilder::default()
        .ip_or_hostname(Some("127.0.0.1"))
        .tcp_port(33317)
        .user(Some("root"))
        .pass(Some(password.clone()));
    let pool = Pool::new(options.clone()).unwrap();
    let mut admin = pool.get_conn().unwrap();
    let db = format!(
        "pf_test_{}",
        store::uuid(&mut admin).unwrap().replace('-', "")
    );
    admin
        .query_drop(format!(
            "CREATE DATABASE {db} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
        ))
        .unwrap();
    struct DatabaseGuard {
        pool: Pool,
        name: String,
    }
    impl Drop for DatabaseGuard {
        fn drop(&mut self) {
            let _ = self
                .pool
                .get_conn()
                .and_then(|mut c| c.query_drop(format!("DROP DATABASE {}", self.name)));
        }
    }
    let _guard = DatabaseGuard {
        pool,
        name: db.clone(),
    };
    let pool = Pool::new(options.db_name(Some(db.clone()))).unwrap();
    let mut conn = pool.get_conn().unwrap();
    verify_numeric_upgrade(&mut conn);
    store::initialize(&mut conn).unwrap();
    store::initialize(&mut conn).unwrap();
    let root = tempfile::tempdir().unwrap();
    let env = config::Environment {
        database: config::Database {
            host: "127.0.0.1".into(),
            port: 33317,
            name: db,
            username: "root".into(),
            password,
            ca_certificate: std::env::var_os("PRINTFLOW_MYSQL_TEST_CA").map(PathBuf::from),
        },
        storage_root: root.path().join("shared"),
    };
    if env.database.ca_certificate.is_some() {
        let mut untrusted = env.clone();
        untrusted.database.ca_certificate = None;
        assert!(
            store::connect(&untrusted).is_err(),
            "self-signed TLS must not be trusted by default"
        );
        let mut tls = store::connect(&env).expect("configured CA should permit verified TLS");
        let cipher: Option<(String, String)> = tls
            .query_first("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
            .unwrap();
        assert!(!cipher.unwrap().1.is_empty());
    }
    let alice = "1";
    let bob = "2";
    conn.exec_drop(
        "INSERT INTO `user`(id,name) VALUES(?, 'Alice'),(?, 'Bob')",
        (alice, bob),
    )
    .unwrap();
    let svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40mm\" height=\"60mm\" viewBox=\"0 0 40 60\"><rect width=\"40\" height=\"60\" fill=\"red\"/></svg>";
    let asset = json!({"id":"asset-1","name":"图案","sourceFileName":"客户原图.svg","productId":"p1","productName":"立牌","width":151.1811,"height":226.77165,"sourceGroupWidthMm":40.0,"sourceGroupHeightMm":60.0,"svg":svg,"attributes":{"QT":"0"},"noteImages":[{"name":"背面参考","src":"data:image/png;base64,AQID"}]});
    let batch = json!({"id":"batch-1","assets":[asset],"metadata":{"customerName":"客户甲"}});
    let saved = request(&mut conn, &env, alice, "save_batch", batch.clone(), 0).unwrap();
    assert_eq!(saved["version"], 1);
    let responses: Vec<String> = conn
        .query("SELECT CAST(response AS CHAR) FROM pf_requests")
        .unwrap();
    assert!(
        responses
            .iter()
            .all(|s| !s.contains("data:image/") && !s.contains("<svg")),
        "replay records must contain references, never image bodies"
    );
    let file = saved["assets"][0]["storagePath"].as_str().unwrap();
    assert_eq!(std::fs::read_to_string(file).unwrap(), svg);
    assert!(batches::load(&mut conn, &env, bob, "batch-1").is_err());
    assert_eq!(
        store::list(
            &mut conn,
            "batch",
            bob,
            &json!({"query":{"page":1,"pageSize":12}})
        )
        .unwrap()["total"],
        0
    );
    let output = root.path().join("导出.svg");
    std::fs::write(&output, svg).unwrap();
    let snapshot = json!({"schemaVersion":1,"id":"review-1","sourceBatchId":"batch-1","savedAt":"2026-10-24T01:02:03.000Z","output":output,"format":"svg","paymentStatus":"unpaid","assets":[asset],"pages":[{"id":1,"items":[{"id":"item-1","assetId":"asset-1","x":123.45,"y":67.89,"width":99.9,"height":88.8,"rotation":90,"backSvg":"<svg><path d='M0 0L1 1'/></svg>","label":"背面"}]}],"activePage":1,"metadata":{"customerName":"客户甲"},"layoutBounds":{"width":1000,"height":1400},"arrangementSort":"upload","defaultArrangementIds":["asset-1"],"display":{"notes":{"item-1":"原样恢复"},"zoom":1.25,"rulers":false}});
    request(
        &mut conn,
        &env,
        alice,
        "save_schematic_review",
        json!({"record":snapshot}),
        0,
    )
    .unwrap();
    let restored = reviews::load(&mut conn, &env, bob, "review-1").unwrap();
    assert_eq!(restored["detachedFromBatch"], true);
    let mut restored = restored;
    resources::hydrate(&mut conn, &env, &mut restored, true).unwrap();
    for field in [
        "pages",
        "display",
        "metadata",
        "layoutBounds",
        "arrangementSort",
        "defaultArrangementIds",
    ] {
        assert_eq!(restored[field], snapshot[field], "{field}");
    }
    assert_eq!(restored["assets"][0]["svg"], svg);
    assert_eq!(
        restored["assets"][0]["noteImages"],
        snapshot["assets"][0]["noteImages"]
    );
    let before = store::read(&mut conn, "batch", "batch-1", false)
        .unwrap()
        .unwrap()
        .value;
    request(
        &mut conn,
        &env,
        alice,
        "send_shared_batch",
        json!({"batchId":"batch-1","recipient":"Bob"}),
        1,
    )
    .unwrap();
    assert!(batches::load(&mut conn, &env, alice, "batch-1").is_err());
    assert!(batches::load(&mut conn, &env, bob, "batch-1").is_ok());
    assert_eq!(
        before,
        store::read(&mut conn, "batch", "batch-1", false)
            .unwrap()
            .unwrap()
            .value
    );
    assert_eq!(
        store::list(&mut conn, "review", alice, &json!({})).unwrap()["total"],
        1
    );
    let job = request(
        &mut conn,
        &env,
        alice,
        "submit_schematic_review_to_imposition",
        json!({"id":"review-1","paymentStatus":"paid"}),
        1,
    )
    .unwrap();
    let jobid = job["id"].as_str().unwrap();
    let loaded = dispatch(
        &mut conn,
        &env,
        bob,
        "load_imposition_job",
        &json!({"id":jobid}),
        0,
        "",
    )
    .unwrap();
    assert_eq!(loaded["images"][0]["widthMm"], 40.0);
    assert_eq!(loaded["images"][0]["heightMm"], 60.0);
    assert_eq!(
        std::fs::read(loaded["images"][0]["noteImage"].as_str().unwrap()).unwrap(),
        vec![1, 2, 3]
    );
    request(
        &mut conn,
        &env,
        bob,
        "update_imposition_image_quantity",
        json!({"jobId":jobid,"imageId":"asset-1","quantity":7}),
        1,
    )
    .unwrap();
    assert!(request(
        &mut conn,
        &env,
        alice,
        "update_imposition_image_quantity",
        json!({"jobId":jobid,"imageId":"asset-1","quantity":9}),
        1
    )
    .is_err());
    assert!(request(
        &mut conn,
        &env,
        alice,
        "delete_schematic_review",
        json!({"id":"review-1"}),
        1
    )
    .is_err());
    // Deleting the private batch does not remove public review/job artwork.
    request(
        &mut conn,
        &env,
        bob,
        "delete_batch",
        json!({"id":"batch-1"}),
        2,
    )
    .unwrap();
    assert!(
        PathBuf::from(file).exists(),
        "public review/job artwork must survive batch deletion"
    );
    conn.query_drop("UPDATE pf_resources SET created_at=CURRENT_TIMESTAMP-INTERVAL 2 DAY,released_at=CURRENT_TIMESTAMP-INTERVAL 2 DAY").unwrap();
    store::exclusive(&mut conn, |c| resources::cleanup(c, &env)).unwrap();
    assert!(reviews::load(&mut conn, &env, alice, "review-1").is_ok());
    assert!(dispatch(
        &mut conn,
        &env,
        alice,
        "load_imposition_job",
        &json!({"id":jobid}),
        0,
        ""
    )
    .is_ok());
    request(
        &mut conn,
        &env,
        bob,
        "return_imposition_to_review",
        json!({"id":jobid}),
        2,
    )
    .unwrap();
    request(
        &mut conn,
        &env,
        bob,
        "save_schematic_review",
        json!({"record":snapshot}),
        1,
    )
    .unwrap();
    // An exact retry after a lost response must not save twice.
    let args = json!({"pools":[{"id":"pool1","name":"生产池","imageKeys":[]}]});
    let retry = store::uuid(&mut conn).unwrap();
    let one = store::exclusive(&mut conn, |c| {
        execute_request(
            c,
            &env,
            alice,
            "save_cloud_pools",
            &args,
            0,
            Some(retry.clone()),
        )
    })
    .unwrap();
    let two = store::exclusive(&mut conn, |c| {
        execute_request(
            c,
            &env,
            alice,
            "save_cloud_pools",
            &args,
            0,
            Some(retry.clone()),
        )
    })
    .unwrap();
    assert_eq!(one, two);
    // Two independent connections editing the same revision: exactly one wins.
    let outcomes = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            let mut c = pool.get_conn().unwrap();
            request(&mut c, &env, alice, "save_cloud_pools", args.clone(), 1)
        });
        let second = scope.spawn(|| {
            let mut c = pool.get_conn().unwrap();
            request(&mut c, &env, bob, "save_cloud_pools", args.clone(), 1)
        });
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    // A failed publish leaves no record; the owned source SVG is untouched.
    let missing = json!({"id":"missing","assets":[{"id":"missing-asset","name":"missing","productId":"p","width":1,"height":1,"svg":"","storagePath":root.path().join("absent.svg")}],"metadata":{}});
    assert!(request(&mut conn, &env, alice, "save_batch", missing, 0).is_err());
    assert!(store::read(&mut conn, "batch", "missing", false)
        .unwrap()
        .is_none());
    request(
        &mut conn,
        &env,
        bob,
        "delete_schematic_review",
        json!({"id":"review-1"}),
        2,
    )
    .unwrap();
    conn.query_drop("UPDATE pf_resources SET created_at=CURRENT_TIMESTAMP-INTERVAL 2 DAY,released_at=CURRENT_TIMESTAMP-INTERVAL 2 DAY").unwrap();
    let cleaned = store::exclusive(&mut conn, |c| resources::cleanup(c, &env)).unwrap();
    assert!(cleaned["removed"].as_u64().unwrap() > 0);
    let corrupt = root
        .path()
        .join("shared")
        .join(format!("{}.pending-test", resources::hash(b"aborted")));
    std::fs::create_dir_all(corrupt.parent().unwrap()).unwrap();
    std::fs::write(&corrupt, b"aborted").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&corrupt)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(
                std::time::SystemTime::now() - std::time::Duration::from_secs(172800),
            ),
        )
        .unwrap();
    store::exclusive(&mut conn, |c| resources::cleanup(c, &env)).unwrap();
    assert!(!corrupt.exists());
    // Batch deletion removes its exclusive artwork immediately, but never unrelated files.
    let isolated = json!({"id":"delete-only","assets":[{"id":"delete-art","name":"delete","productId":"p","width":10,"height":10,"svg":"<svg><text>delete-only</text></svg>"}],"metadata":{"customerName":"delete-only"}});
    let saved = request(&mut conn, &env, alice, "save_batch", isolated, 0).unwrap();
    let deleted_file = PathBuf::from(saved["assets"][0]["storagePath"].as_str().unwrap());
    let folder = deleted_file.parent().unwrap().to_path_buf();
    let unrelated = env.storage_root.join("keep.txt");
    std::fs::write(&unrelated, "not managed by this batch").unwrap();
    let deletion_id = store::uuid(&mut conn).unwrap();
    // Lose the share after saving. Database deletion can commit, but must not report full success.
    let offline = root.path().join("offline-share");
    std::fs::rename(&env.storage_root, &offline).unwrap();
    let delete_args = json!({"id":"delete-only"});
    let attempt = store::exclusive(&mut conn, |c| {
        execute_request(
            c,
            &env,
            alice,
            "delete_batch",
            &delete_args,
            1,
            Some(deletion_id.clone()),
        )
    });
    assert!(
        attempt.is_err(),
        "unavailable share must report pending cleanup"
    );
    assert!(store::read(&mut conn, "batch", "delete-only", false)
        .unwrap()
        .is_none());
    std::fs::rename(&offline, &env.storage_root).unwrap();
    for _ in 0..2 {
        store::exclusive(&mut conn, |c| {
            execute_request(
                c,
                &env,
                alice,
                "delete_batch",
                &delete_args,
                1,
                Some(deletion_id.clone()),
            )
        })
        .unwrap();
    }
    assert!(
        !deleted_file.exists(),
        "deleting a batch must immediately delete exclusive artwork"
    );
    assert!(!folder.exists(), "empty batch folder must be removed");
    assert!(unrelated.exists());
    let remaining: u64 = conn
        .exec_first(
            "SELECT COUNT(*) FROM pf_resources WHERE hash=?",
            (resources::hash(b"<svg><text>delete-only</text></svg>"),),
        )
        .unwrap()
        .unwrap();
    assert_eq!(remaining, 0);
    // After restart, settings cleanup resumes the durable deletion immediately
    // without the normal 24-hour orphan-file retention window.
    let isolated = json!({"id":"delete-maintenance","assets":[{"id":"maintenance-art","name":"delete","productId":"p","width":10,"height":10,"svg":"<svg><text>delete-maintenance</text></svg>"}],"metadata":{}});
    let saved = request(&mut conn, &env, alice, "save_batch", isolated, 0).unwrap();
    let file = PathBuf::from(saved["assets"][0]["storagePath"].as_str().unwrap());
    std::fs::rename(&env.storage_root, &offline).unwrap();
    assert!(request(
        &mut conn,
        &env,
        alice,
        "delete_batch",
        json!({"id":"delete-maintenance"}),
        1
    )
    .is_err());
    std::fs::rename(&offline, &env.storage_root).unwrap();
    store::exclusive(&mut conn, |c| resources::cleanup(c, &env)).unwrap();
    assert!(!file.exists());
    let pending: u64 = conn.query_first("SELECT COUNT(*) FROM pf_requests WHERE JSON_CONTAINS_PATH(response,'one','$.cleanupResources')").unwrap().unwrap();
    assert_eq!(pending, 0);
    // Migration preserves geometry and is repeatable even after ownership transfer.
    let local = reviews::memory().unwrap();
    let mut local_custom = asset.clone();
    local_custom["productId"] = json!("custom:7788");
    local_custom["productName"] = json!("仅本机使用的产品名称");
    local.execute("INSERT INTO batches(id,saved_at,payload,metadata) VALUES('legacy','2026-01-01T00:00:00.000Z',?1,'{}')",[json!([local_custom]).to_string()]).unwrap();
    let mut legacy = snapshot.clone();
    legacy["id"] = json!("legacy-review");
    legacy["sourceBatchId"] = json!("legacy");
    crate::schematic_review::save_record(&local, legacy).unwrap();
    let note_path = root.path().join("local-note.png");
    std::fs::write(&note_path, [1, 2, 3]).unwrap();
    let mut local_images = loaded["images"].clone();
    local_images[0]["filePath"] = json!(output);
    local_images[0]["noteImage"] = json!(note_path);
    local_images[0]["noteImages"][0]["src"] = json!(note_path);
    local.execute("INSERT INTO production_imposition_jobs(id,source_review_id,customer_name,output,submitted_at,payment_status,status,image_count,images) VALUES('legacy-job','legacy-review','客户甲',?1,'2026-01-01T00:00:00.000Z','paid','pending',1,?2)",rusqlite::params![output.to_string_lossy(),local_images.to_string()]).unwrap();
    let local_pools = json!({"pools":[{"id":"local-pool","name":"旧拼版池","color":"blue","imageKeys":["legacy-job::asset-1"]}]});
    let migration = store::exclusive(&mut conn, |c| {
        migration::run(c, &env, alice, &local, &local_pools)
    })
    .unwrap();
    assert_eq!(migration["errors"], json!([]));
    assert_eq!(migration["imported"], 3);
    let migrated_batch: String = conn
        .query_first(
            "SELECT cloud_key FROM pf_migrations WHERE kind='batch' AND local_key='legacy'",
        )
        .unwrap()
        .unwrap();
    let migrated = store::read(&mut conn, "batch", &migrated_batch, false)
        .unwrap()
        .unwrap();
    assert_eq!(migrated.value["assets"][0]["productId"], "custom:7788");
    assert_eq!(
        migrated.value["assets"][0]["productName"],
        "仅本机使用的产品名称"
    );
    request(
        &mut conn,
        &env,
        alice,
        "send_shared_batch",
        json!({"batchId":migrated_batch,"recipient":"Bob"}),
        1,
    )
    .unwrap();
    let migrated_job: String = conn
        .query_first(
            "SELECT cloud_key FROM pf_migrations WHERE kind='job' AND local_key='legacy-job'",
        )
        .unwrap()
        .unwrap();
    let job = dispatch(
        &mut conn,
        &env,
        bob,
        "load_imposition_job",
        &json!({"id":migrated_job}),
        0,
        "",
    )
    .unwrap();
    assert_eq!(
        std::fs::read(job["images"][0]["noteImages"][0]["src"].as_str().unwrap()).unwrap(),
        vec![1, 2, 3]
    );
    let pools = store::read(&mut conn, "pools", "shared", false)
        .unwrap()
        .unwrap()
        .value;
    let migrated_pool = pools
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "旧拼版池")
        .unwrap();
    assert_eq!(
        migrated_pool["imageKeys"][0],
        format!(
            "{}::{}",
            migrated_job,
            job["images"][0]["id"].as_str().unwrap()
        )
    );
    let again = store::exclusive(&mut conn, |c| {
        migration::run(c, &env, alice, &local, &local_pools)
    })
    .unwrap();
    assert_eq!(again["imported"], 0);
    assert_eq!(again["skipped"], 3);
    assert!(batches::load(&mut conn, &env, alice, &migrated_batch).is_err());
    assert!(batches::load(&mut conn, &env, bob, &migrated_batch).is_ok());
    assert_eq!(
        local
            .query_row("SELECT COUNT(*) FROM batches", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

fn verify_numeric_upgrade(conn: &mut mysql::PooledConn) {
    for sql in include_str!("fixtures/schema_v1.sql")
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        conn.query_drop(sql).unwrap();
    }
    conn.query_drop("INSERT INTO pf_schema VALUES(1,1)")
        .unwrap();
    conn.query_drop(
        "INSERT INTO `user`(id,name) VALUES('old-alice','Old Alice'),('old-bob','Old Bob')",
    )
    .unwrap();
    for (kind, id, owner, source) in [
        ("batch", "old-batch", Some("old-alice"), None),
        ("review", "old-review", None, None),
        ("job", "old-job", None, Some("old-review")),
        ("pools", "shared", None, None),
    ] {
        conn.exec_drop("INSERT INTO pf_records(kind,id,owner_id,version,name,saved_at,source_review_id,summary,payload) VALUES(?,?,?,1,'','2026-01-01',?,'{}','{}')", (kind,id,owner,source)).unwrap();
    }
    let hash = resources::hash(b"unchanged");
    conn.exec_drop(
        "INSERT INTO pf_resources(id,relative_path,bytes) VALUES(?,'old/file.svg',9)",
        (&hash,),
    )
    .unwrap();
    conn.exec_drop(
        "INSERT INTO pf_resource_refs VALUES('batch','old-batch',?),('review','old-review',?)",
        (&hash, &hash),
    )
    .unwrap();
    conn.query_drop("INSERT INTO pf_requests(id,user_id,digest,response) VALUES('00000000-0000-0000-0000-000000000001','old-alice',REPEAT('a',64),'{\"result\":null}')").unwrap();
    conn.query_drop("INSERT INTO pf_transfers(id,batch_id,from_user,to_user) VALUES('00000000-0000-0000-0000-000000000001','already-deleted-batch','old-alice','old-bob')").unwrap();
    conn.query_drop("INSERT INTO pf_migrations VALUES('installation','batch','local-batch','old-batch'),('installation','batch','deleted-batch','deleted-record'),('installation','pools','old-alice','shared')").unwrap();
    store::initialize(conn).unwrap();
    store::initialize(conn).unwrap();
    let obsolete: u64 = conn.query_first("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='pf_custom_products'").unwrap().unwrap();
    assert_eq!(obsolete, 0);
    // Upgrade an existing numeric v2 installation too, preserving saved choices.
    let custom = json!({"assets":[{"productId":"custom:77","productName":"旧本机自定义产品","attributes":{"Size":"80mm","QT":"0"}}]});
    conn.exec_drop(
        "UPDATE pf_records SET payload=? WHERE record_key='old-batch'",
        (custom.to_string(),),
    )
    .unwrap();
    conn.query_drop(
        "CREATE TABLE pf_custom_products(id BIGINT UNSIGNED PRIMARY KEY,name VARCHAR(190))",
    )
    .unwrap();
    conn.query_drop("INSERT INTO pf_custom_products VALUES(77,'云端旧名称')")
        .unwrap();
    conn.query_drop("UPDATE pf_schema SET version=2 WHERE id=1")
        .unwrap();
    store::initialize(conn).unwrap();
    store::initialize(conn).unwrap();
    assert_eq!(
        store::read(conn, "batch", "old-batch", false)
            .unwrap()
            .unwrap()
            .value,
        custom
    );
    let version: u32 = conn
        .query_first("SELECT version FROM pf_schema WHERE id=1")
        .unwrap()
        .unwrap();
    assert_eq!(version, 3);
    let types: Vec<String> = conn.query("SELECT data_type FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='id'").unwrap();
    assert_eq!(types.len(), 8);
    assert!(types.iter().all(|v| v == "bigint" || v == "int"));
    let owner: String = conn.query_first("SELECT u.name FROM pf_records r JOIN `user` u ON r.owner_id=u.id WHERE record_key='old-batch'").unwrap().unwrap();
    assert_eq!(owner, "Old Alice");
    let source: String = conn.query_first("SELECT r.record_key FROM pf_records j JOIN pf_records r ON r.id=j.source_review_id WHERE j.record_key='old-job'").unwrap().unwrap();
    assert_eq!(source, "old-review");
    let refs: u64 = conn.query_first("SELECT COUNT(*) FROM pf_resource_refs f JOIN pf_records r ON r.id=f.record_id JOIN pf_resources a ON a.id=f.resource_id").unwrap().unwrap();
    assert_eq!(refs, 2);
    let recipient: String = conn
        .query_first("SELECT u.name FROM pf_transfers t JOIN `user` u ON u.id=t.to_user")
        .unwrap()
        .unwrap();
    assert_eq!(recipient, "Old Bob");
    let migrations: u64 = conn
        .query_first("SELECT COUNT(*) FROM pf_migrations")
        .unwrap()
        .unwrap();
    assert_eq!(migrations, 3);
    let pool_owner: String = conn.query_first("SELECT u.name FROM pf_migrations m JOIN `user` u ON CAST(u.id AS CHAR)=m.local_key WHERE m.kind='pools'").unwrap().unwrap();
    assert_eq!(pool_owner, "Old Alice");
    for table in [
        "pf_resource_refs",
        "pf_transfers",
        "pf_requests",
        "pf_migrations",
        "pf_records",
        "pf_resources",
        "user",
    ] {
        conn.query_drop(format!("DELETE FROM `{table}`")).unwrap();
        conn.query_drop(format!("ALTER TABLE `{table}` AUTO_INCREMENT=1"))
            .unwrap();
    }
}
