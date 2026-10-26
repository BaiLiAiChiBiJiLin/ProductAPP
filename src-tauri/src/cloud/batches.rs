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
        let bytes = if asset.svg.is_empty() {
            if asset.storage_path.starts_with(resources::FILE) {
                resources::read(conn, env, &asset.storage_path)?
            } else {
                std::fs::read(&asset.storage_path)
                    .map_err(|_| format!("图片 {} 的源文件不可访问", asset.name))?
            }
        } else if asset.svg.starts_with(crate::staged_artwork::PREFIX) {
            crate::staged_artwork::read(&asset.svg)?.into_bytes()
        } else {
            asset.svg.as_bytes().to_vec()
        };
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
