use super::{
    config::Environment,
    resources,
    store::{self, error, required, text, Record, Result},
};
use mysql::prelude::Queryable;
use serde_json::{json, Value};

pub fn get(conn: &mut impl Queryable, id: &str, user: &str, lock: bool) -> Result<Record> {
    let record = store::read(conn, "batch", id, lock)?.ok_or("历史批次不存在")?;
    store::owned(&record, user)?;
    Ok(record)
}

pub fn delete(conn: &mut impl Queryable, user: &str, id: &str, expected: u64) -> Result<Value> {
    let batch = store::read(conn, "batch", id, true)?;
    validate_delete(batch.as_ref(), user, expected)?;
    if batch.is_some() {
        store::remove(conn, "batch", id)?;
    }
    Ok(Value::Null)
}

fn validate_delete(batch: Option<&Record>, user: &str, expected: u64) -> Result<()> {
    let Some(batch) = batch else {
        // A batch can be cancelled locally before its first cloud save. Treat
        // that exact version-zero delete as idempotent, while still rejecting
        // stale or malformed deletion requests.
        return (expected == 0)
            .then_some(())
            .ok_or_else(|| "历史批次不存在".into());
    };
    store::owned(batch, user)?;
    store::check_version(Some(batch), expected)
}

#[cfg(test)]
mod deletion_tests {
    use super::*;

    #[test]
    fn cancelling_an_unsaved_batch_is_idempotent() {
        assert!(validate_delete(None, "alice", 0).is_ok());
        assert!(validate_delete(None, "alice", 1).is_err());
    }

    #[test]
    fn existing_batches_still_require_the_owner_and_current_version() {
        let batch = Record {
            value: Value::Null,
            summary: Value::Null,
            version: 2,
            owner: Some("alice".into()),
        };
        assert!(validate_delete(Some(&batch), "alice", 2).is_ok());
        assert!(validate_delete(Some(&batch), "bob", 2).is_err());
        assert!(validate_delete(Some(&batch), "alice", 0).is_err());
        assert!(validate_delete(Some(&batch), "alice", 1).is_err());
    }
}

pub fn save(
    conn: &mut impl Queryable,
    env: &Environment,
    user: &str,
    args: &Value,
    expected: u64,
) -> Result<Value> {
    let id = required(args, "id")?;
    let old = store::read(conn, "batch", id, true)?;
    if let Some(old) = &old {
        store::owned(old, user)?;
    }
    store::check_version(old.as_ref(), expected)?;
    let mut assets: Vec<crate::assets::Asset> =
        serde_json::from_value(args["assets"].clone()).map_err(|_| "图片资产格式错误")?;
    if assets.is_empty() {
        return Err("批次没有图片".into());
    }
    let first = std::path::Path::new(&assets[0].source_file_name)
        .file_stem()
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(&assets[0].name)
        .to_owned();
    let folder = old
        .as_ref()
        .and_then(|r| r.value["directory"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{}_{}_{}",
                resources::safe_name(&first),
                chrono::Utc::now()
                    .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
                    .format("%Y%m%d%H%M%S"),
                &resources::hash(id.as_bytes())[..10]
            )
        });
    let mut ids = std::collections::HashSet::new();
    for asset in &mut assets {
        if asset.id.is_empty() || !ids.insert(asset.id.clone()) {
            return Err("图片 ID 缺失或重复".into());
        }
        let bytes = artwork_bytes(asset, old.as_ref().map(|r| &r.value), |reference| {
            resources::read(conn, env, reference)
        })?;
        let resource = resources::put(conn, env, &format!("{folder}/assets"), &bytes, "svg")?;
        asset.storage_path = format!("{}{resource}", resources::FILE);
        asset.svg.clear();
        asset.preview_url.clear();
        asset.thumbnail_url.clear();
    }
    let version = expected + 1;
    let mut value = json!({"id":id,"savedAt":store::now(),"assets":assets,"metadata":args["metadata"],"directory":folder});
    resources::externalize(conn, env, &format!("{folder}/attachments"), &mut value)?;
    let summary = json!({"id":id,"savedAt":value["savedAt"],"customerName":value["metadata"]["customerName"].as_str().filter(|v|!v.trim().is_empty()).unwrap_or(&first),"assetCount":assets.len()});
    store::write(conn, "batch", id, Some(user), version, &value, &summary)?;
    Ok(
        json!({"assets":value["assets"],"metadata":value["metadata"],"batchId":id,"duplicate":false,"version":version}),
    )
}

fn artwork_bytes(
    asset: &crate::assets::Asset,
    previous: Option<&Value>,
    mut read_resource: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<Vec<u8>> {
    if asset.svg.is_empty() {
        if asset.storage_path.starts_with(resources::FILE) {
            read_resource(&asset.storage_path)
        } else {
            match std::fs::read(&asset.storage_path) {
                Ok(bytes) => Ok(bytes),
                Err(error) => {
                    if let Some(reference) = recovery_reference(asset, previous, error.kind()) {
                        return read_resource(&reference).map_err(|failure| {
                            format!("图片 {} 的源文件丢失，已保存的共享副本无法读取：{failure}。请恢复共享目录连接后重试", asset.name)
                        });
                    }
                    if error.kind() == std::io::ErrorKind::NotFound {
                        Err(format!("图片 {} 的源文件不可访问，未找到可恢复的共享副本。请检查共享目录连接；若文件已删除，请重新导入该图片", asset.name))
                    } else {
                        Err(format!("图片 {} 的源文件不可访问，请检查文件权限、占用及共享目录连接后重试：{error}", asset.name))
                    }
                }
            }
        }
    } else if asset.svg.starts_with(crate::staged_artwork::PREFIX) {
        crate::staged_artwork::read(&asset.svg).map(String::into_bytes)
    } else {
        Ok(asset.svg.as_bytes().to_vec())
    }
}

fn recovery_reference(
    asset: &crate::assets::Asset,
    previous: Option<&Value>,
    failure: std::io::ErrorKind,
) -> Option<String> {
    if failure != std::io::ErrorKind::NotFound || asset.id.is_empty() {
        return None;
    }
    let saved = previous?["assets"]
        .as_array()?
        .iter()
        .find(|saved| saved["id"].as_str() == Some(asset.id.as_str()))?;
    let saved: crate::assets::Asset = serde_json::from_value(saved.clone()).ok()?;
    // Artwork replacements receive new IDs. Also require the original artwork
    // metadata to match; product properties and notes may have newer edits.
    let same_artwork = saved.source_file_name == asset.source_file_name
        && saved.source_group_id == asset.source_group_id
        && saved.width == asset.width
        && saved.height == asset.height
        && saved.source_group_width_mm == asset.source_group_width_mm
        && saved.source_group_height_mm == asset.source_group_height_mm
        && saved.source_group_bounds == asset.source_group_bounds
        && saved.source_images == asset.source_images;
    (same_artwork && saved.storage_path.starts_with(resources::FILE)).then_some(saved.storage_path)
}

#[cfg(test)]
mod artwork_recovery_tests {
    use super::*;

    fn asset(path: &std::path::Path) -> crate::assets::Asset {
        serde_json::from_value(json!({
            "id": "asset-1", "name": "尺寸 · __printflow_measure_0",
            "productId": "p", "width": 10, "height": 20,
            "svg": "", "storagePath": path,
            "sourceFileName": "尺寸.svg", "sourceGroupId": "source-1"
        }))
        .unwrap()
    }

    fn saved_batch(asset: &crate::assets::Asset) -> Value {
        let mut saved = asset.clone();
        saved.storage_path = format!("{}{}", resources::FILE, "a".repeat(64));
        json!({ "assets": [saved] })
    }

    #[test]
    fn recovers_missing_source_from_the_same_saved_asset() {
        let root = tempfile::tempdir().unwrap();
        let mut incoming = asset(&root.path().join("missing.svg"));
        let old = saved_batch(&incoming);
        incoming.attributes.insert("QT".into(), "25".into());
        incoming.note = "latest edit".into();
        let svg = b"<svg>saved original</svg>";
        let bytes = artwork_bytes(&incoming, Some(&old), |reference| {
            assert_eq!(reference, format!("{}{}", resources::FILE, "a".repeat(64)));
            Ok(svg.to_vec())
        })
        .unwrap();
        assert_eq!(bytes, svg);
    }

    #[test]
    fn missing_new_or_replaced_artwork_is_not_substituted() {
        let root = tempfile::tempdir().unwrap();
        let original = asset(&root.path().join("missing.svg"));
        let old = saved_batch(&original);
        let mut replacement = original.clone();
        replacement.id = "replacement-2".into();
        for (incoming, previous) in [(&original, None), (&replacement, Some(&old))] {
            let failure = artwork_bytes(incoming, previous, |_| {
                panic!("must not reuse another image")
            })
            .unwrap_err();
            assert!(failure.contains(&incoming.name));
            assert!(failure.contains("请重新导入该图片"));
        }
    }

    #[test]
    fn mismatched_source_metadata_is_not_reused_even_with_the_same_id() {
        let root = tempfile::tempdir().unwrap();
        let original = asset(&root.path().join("missing.svg"));
        let old = saved_batch(&original);
        let mut changed_file = original.clone();
        changed_file.source_file_name = "different.svg".into();
        let mut changed_group = original.clone();
        changed_group.source_group_id = "other-group".into();
        let mut changed_size = original.clone();
        changed_size.width = 99.0;
        let mut changed_images = original.clone();
        changed_images.source_images = Some(vec![]);
        for incoming in [changed_file, changed_group, changed_size, changed_images] {
            assert!(artwork_bytes(&incoming, Some(&old), |_| panic!(
                "must not reuse changed artwork"
            ))
            .is_err());
        }
    }

    #[test]
    fn permissions_and_other_io_failures_do_not_trigger_recovery() {
        let root = tempfile::tempdir().unwrap();
        let incoming = asset(root.path());
        let old = saved_batch(&incoming);
        for failure in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::Other,
        ] {
            assert!(recovery_reference(&incoming, Some(&old), failure).is_none());
        }
        // Reading a directory fails with a non-NotFound error on Windows/Unix.
        let failure = artwork_bytes(&incoming, Some(&old), |_| {
            panic!("must not mask an I/O failure")
        })
        .unwrap_err();
        assert!(failure.contains("请检查文件权限"));
    }

    #[test]
    fn existing_and_inline_artwork_take_precedence_over_saved_copies() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.svg");
        std::fs::write(&path, b"<svg>current file</svg>").unwrap();
        let mut incoming = asset(&path);
        let old = saved_batch(&incoming);
        assert_eq!(
            artwork_bytes(&incoming, Some(&old), |_| panic!("source is available")).unwrap(),
            b"<svg>current file</svg>"
        );
        incoming.svg = "<svg>current inline</svg>".into();
        assert_eq!(
            artwork_bytes(&incoming, Some(&old), |_| panic!("inline source wins")).unwrap(),
            b"<svg>current inline</svg>"
        );
    }

    #[test]
    fn invalid_or_unreadable_shared_copies_fail_without_skipping_the_image() {
        let root = tempfile::tempdir().unwrap();
        let incoming = asset(&root.path().join("missing.svg"));
        let old = saved_batch(&incoming);
        let failure =
            artwork_bytes(&incoming, Some(&old), |_| Err("共享图片校验失败".into())).unwrap_err();
        assert!(failure.contains(&incoming.name));
        assert!(failure.contains("共享图片校验失败"));
        let local_old = json!({ "assets": [incoming] });
        assert!(artwork_bytes(&incoming, Some(&local_old), |_| panic!(
            "old local paths cannot recover"
        ))
        .is_err());
    }
}

pub fn load(conn: &mut impl Queryable, env: &Environment, user: &str, id: &str) -> Result<Value> {
    let record = get(conn, id, user, false)?;
    let mut value = record.value;
    resources::hydrate(conn, env, &mut value, true)?;
    value["version"] = json!(record.version);
    Ok(value)
}
pub fn artwork(
    conn: &mut impl Queryable,
    env: &Environment,
    user: &str,
    args: &Value,
) -> Result<Value> {
    let record = get(conn, required(args, "batchId")?, user, false)?;
    let asset = record.value["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|asset| asset["id"] == args["assetId"])
        .ok_or("批次图片不存在")?;
    Ok(json!(resources::read(
        conn,
        env,
        required(asset, "storagePath")?
    )?))
}
pub fn thumbnails(
    conn: &mut impl Queryable,
    env: &Environment,
    user: &str,
    id: &str,
) -> Result<Value> {
    let record = get(conn, id, user, false)?;
    let mut result = Vec::new();
    for asset in record.value["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .take(4)
    {
        let path = resources::path(conn, env, text(asset, "storagePath"))?;
        let url = crate::batch_thumbnails::load_path(&path).unwrap_or_default();
        result.push(json!({"assetId":asset["id"],"name":asset["name"],"url":url}));
    }
    Ok(json!(result))
}
pub fn transfer(
    conn: &mut impl Queryable,
    user: &str,
    args: &Value,
    expected: u64,
    request: &str,
) -> Result<Value> {
    let id = required(args, "batchId")?;
    let record = get(conn, id, user, true)?;
    store::check_version(Some(&record), expected)?;
    let recipient = required(args, "recipient")?;
    let target: String = conn
        .exec_first(
            "SELECT CAST(id AS CHAR) FROM `user` WHERE name=? AND active=TRUE",
            (recipient,),
        )
        .map_err(error)?
        .ok_or("接收用户不存在或已停用")?;
    if target == user {
        return Err("不能转移给自己".into());
    }
    conn.exec_drop(
        "UPDATE pf_records SET owner_id=?,version=version+1 WHERE kind='batch' AND record_key=?",
        (&target, id),
    )
    .map_err(error)?;
    let batch_number = store::record_id(conn, "batch", id)?;
    conn.exec_drop(
        "INSERT INTO pf_transfers(request_id,batch_id,batch_key,from_user,to_user) SELECT id,?,?,?,? FROM pf_requests WHERE request_key=?",
        (batch_number, id, user, &target, request),
    )
    .map_err(error)?;
    Ok(
        json!({"taskId":request,"recipient":recipient,"batchName":record.summary["customerName"],"assetCount":record.summary["assetCount"],"reviewCount":0,"jobCount":0,"shared":true}),
    )
}
