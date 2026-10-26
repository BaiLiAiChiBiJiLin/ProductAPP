//! Shared business storage. SQLite remains local-only; cloud snapshots use
//! MySQL transactions and immutable SMB resources, never a shared SQLite file.
mod batches;
pub mod config;
mod local_cleanup;
mod migration;
mod resources;
mod reviews;
mod schema_upgrade;
pub mod store;
use mysql::{prelude::Queryable, TxOpts};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use store::{error, required, text, Result};
use tauri::Manager;

#[tauri::command]
pub fn storage_mode() -> Result<config::Mode> {
    config::mode()
}

#[tauri::command]
pub async fn cloud_resource(
    app: tauri::AppHandle,
    command: String,
    args: Value,
) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = config::load()?.ok_or("未启用共享存储")?;
        let mut conn = store::connect(&env)?;
        let user = current_user(&app, &env, &mut conn)?;
        let reference = if command == "load_batch_asset_svg" {
            let batch = batches::get(&mut conn, required(&args, "batchId")?, &user, false)?;
            batch.value["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|a| a["id"] == args["assetId"])
                .and_then(|a| a["storagePath"].as_str())
                .ok_or("批次图片不存在")?
                .to_owned()
        } else if command == "load_schematic_review_resource" {
            let review = reviews::get(&mut conn, required(&args, "id")?, false)?;
            let resource = required(&args, "resourceId")?;
            let mut refs = std::collections::BTreeSet::new();
            resources::references(&review.value, &mut refs);
            if !refs.contains(resource) {
                return Err("资源不属于当前审核快照".into());
            }
            format!("{}{resource}", resources::TEXT)
        } else {
            return Err("不支持的资源请求".into());
        };
        Ok(tauri::ipc::Response::new(resources::read(
            &mut conn, &env, &reference,
        )?))
    })
    .await
    .map_err(|_| "资源读取任务异常结束")?
}

fn identity_path(app: &tauri::AppHandle, env: &config::Environment) -> Result<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法读取用户配置目录")?;
    fs::create_dir_all(&root).map_err(|_| "无法创建用户配置目录")?;
    Ok(root.join(format!(
        "cloud-user-v2-{}.json",
        &resources::hash(format!("{}:{}", env.database.host, env.database.name).as_bytes())[..16]
    )))
}
fn current_user(
    app: &tauri::AppHandle,
    env: &config::Environment,
    conn: &mut impl Queryable,
) -> Result<String> {
    let value: Value = serde_json::from_slice(
        &fs::read(identity_path(app, env)?).map_err(|_| "请先设置用户名并连接云数据库")?,
    )
    .map_err(|_| "用户配置无效，请重新设置用户名")?;
    let id = required(&value, "id")?;
    conn.exec_first(
        "SELECT CAST(id AS CHAR) FROM `user` WHERE id=? AND active=TRUE",
        (id,),
    )
    .map_err(error)?
    .ok_or("当前用户不存在或已停用，请重新设置用户名".into())
}
fn register(
    app: &tauri::AppHandle,
    env: &config::Environment,
    conn: &mut impl Queryable,
    name: &str,
) -> Result<Value> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 30 || name.chars().any(char::is_control) {
        return Err("请填写 1 至 30 个字符的用户名".into());
    }
    let path = identity_path(app, env)?;
    let previous = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["id"].as_str().map(str::to_owned));
    let existing: Option<String> = conn
        .exec_first(
            "SELECT CAST(id AS CHAR) FROM `user` WHERE name=? AND active=TRUE",
            (name,),
        )
        .map_err(error)?;
    let id = match (previous, existing) {
        (Some(id), Some(existing)) if id != existing => {
            return Err("该用户名已被其他用户使用，请换一个名称".into())
        }
        (Some(id), _) => {
            let present: Option<String> = conn
                .exec_first(
                    "SELECT CAST(id AS CHAR) FROM `user` WHERE id=? AND active=TRUE",
                    (&id,),
                )
                .map_err(error)?;
            if present.is_none() {
                return Err("已绑定的云端用户不可用，请联系管理员".into());
            }
            conn.exec_drop("UPDATE `user` SET name=? WHERE id=?", (name, &id))
                .map_err(error)?;
            id
        }
        (None, Some(id)) => id,
        (None, None) => {
            conn.exec_drop("INSERT INTO `user`(name) VALUES(?)", (name,))
                .map_err(error)?;
            conn.query_first::<u64, _>("SELECT LAST_INSERT_ID()")
                .map_err(error)?
                .ok_or("无法取得用户编号")?
                .to_string()
        }
    };
    let value = json!({"id":id,"name":name});
    fs::write(path, value.to_string()).map_err(|_| "无法保存本机用户绑定")?;
    Ok(json!(env.storage_root.to_string_lossy()))
}

#[tauri::command]
pub async fn cloud_operation(
    app: tauri::AppHandle,
    command: String,
    args: Value,
    expected_version: Option<u64>,
    request_id: Option<String>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = config::load()?.ok_or("当前未启用共享模式")?;
        let mut conn = store::connect(&env)?;
        if command == "initialize_shared_user" {
            return register(&app, &env, &mut conn, required(&args, "userName")?);
        }
        let user = current_user(&app, &env, &mut conn)?;
        let mut args = args;
        if command == "save_batch" {
            let mut assets: Vec<crate::assets::Asset> =
                serde_json::from_value(args["assets"].clone()).map_err(|_| "图片资产格式错误")?;
            crate::finish_matching::fill(&mut assets, &crate::finish_catalog_path(&app)?)?;
            args["assets"] = serde_json::to_value(assets).map_err(|_| "图片资产格式错误")?;
        }
        if command == "preview_cloud_migration" {
            return migration::preview(&crate::database(&app)?);
        }
        if command == "migrate_local_data" {
            return store::exclusive(&mut conn, |conn| {
                migration::migrate_and_cleanup(conn, &env, &user, &crate::database(&app)?, &args)
            });
        }
        if command == "delete_local_data" {
            return migration::delete_local(&env, &crate::database(&app)?, &args);
        }
        if command == "cleanup_cloud_resources" {
            return store::exclusive(&mut conn, |conn| resources::cleanup(conn, &env));
        }
        if let Some(kind) = match command.as_str() {
            "list_batches" => Some("batch"),
            "list_schematic_reviews" => Some("review"),
            "list_pending_impositions" => Some("job"),
            _ => None,
        } {
            let mut result = store::list(&mut conn, kind, &user, &args)?;
            resources::manifest_paths(&mut conn, &env, &mut result)?;
            return Ok(result);
        }
        if !mutating(&command) {
            return dispatch(
                &mut conn,
                &env,
                &user,
                &command,
                &args,
                expected_version.unwrap_or(0),
                "",
            );
        }
        store::exclusive(&mut conn, |conn| {
            execute_request(
                conn,
                &env,
                &user,
                &command,
                &args,
                expected_version.unwrap_or(0),
                request_id,
            )
        })
    })
    .await
    .map_err(|_| "云端操作任务异常结束")?
}

pub fn mutating(command: &str) -> bool {
    matches!(
        command,
        "save_batch"
            | "delete_batch"
            | "delete_asset"
            | "send_shared_batch"
            | "save_schematic_review"
            | "delete_schematic_review"
            | "update_schematic_review_payment_status"
            | "submit_schematic_review_to_imposition"
            | "return_imposition_to_review"
            | "update_imposition_image_quantity"
            | "update_imposition_image_quantities"
            | "save_cloud_pools"
    )
}

pub fn dispatch(
    conn: &mut impl Queryable,
    env: &config::Environment,
    user: &str,
    command: &str,
    args: &Value,
    expected: u64,
    request: &str,
) -> Result<Value> {
    match command {
        "save_batch" => batches::save(conn, env, user, args, expected),
        "load_batch" => batches::load(conn, env, user, required(args, "id")?),
        "load_batch_asset_svg" => batches::artwork(conn, env, user, args),
        "load_batch_thumbnails" => batches::thumbnails(conn, env, user, required(args, "id")?),
        "delete_batch" => {
            let id = required(args, "id")?;
            let batch = batches::get(conn, id, user, true)?;
            store::check_version(Some(&batch), expected)?;
            store::remove(conn, "batch", id)?;
            Ok(Value::Null)
        }
        "delete_asset" => {
            let id = required(args, "batchId")?;
            let Some(batch) = store::read(conn, "batch", id, true)? else {
                if expected == 0 {
                    return Ok(json!({"version":0}));
                }
                return Err("历史批次已删除，请刷新列表".into());
            };
            store::owned(&batch, user)?;
            store::check_version(Some(&batch), expected)?;
            let mut value = batch.value;
            value["assets"]
                .as_array_mut()
                .ok_or("批次内容错误")?
                .retain(|a| a["id"] != args["id"]);
            if value["assets"].as_array().unwrap().is_empty() {
                store::remove(conn, "batch", id)?;
                Ok(json!({"version":0}))
            } else {
                batches::save(conn, env, user, &value, expected)
            }
        }
        "list_shared_transfer_users" => {
            let names: Vec<String> = conn
                .exec(
                    "SELECT name FROM `user` WHERE active=TRUE AND id<>? ORDER BY name",
                    (user,),
                )
                .map_err(error)?;
            Ok(json!(names))
        }
        "shared_transfer_directory" => Ok(json!(env.storage_root.to_string_lossy())),
        "preview_shared_batch_transfer" => {
            let batch = batches::get(conn, required(args, "batchId")?, user, false)?;
            Ok(
                json!({"assetCount":batch.summary["assetCount"],"reviewCount":0,"jobCount":0,"shared":true,"version":batch.version}),
            )
        }
        "send_shared_batch" => batches::transfer(conn, user, args, expected, request),
        "refresh_shared_transfers" => {
            Ok(json!({"imported":0,"finalized":0,"errors":[],"shared":true}))
        }
        "save_schematic_review" => reviews::save(conn, env, args, expected),
        "load_schematic_review" => reviews::load(conn, env, user, required(args, "id")?),
        "load_schematic_review_resource" => reviews::resource(
            conn,
            env,
            required(args, "id")?,
            required(args, "resourceId")?,
        ),
        "delete_schematic_review" => reviews::delete(conn, required(args, "id")?, expected),
        "update_schematic_review_payment_status" => reviews::payment(
            conn,
            required(args, "id")?,
            required(args, "paymentStatus")?,
        ),
        "submit_schematic_review_to_imposition" => reviews::submit(
            conn,
            env,
            required(args, "id")?,
            required(args, "paymentStatus")?,
            expected,
        ),
        "load_imposition_job" => {
            let record = store::read(conn, "job", required(args, "id")?, false)?
                .ok_or("生产拼版记录不存在")?;
            let mut value = record.value;
            resources::hydrate(conn, env, &mut value, true)?;
            value["version"] = json!(record.version);
            Ok(value)
        }
        "return_imposition_to_review"
        | "update_imposition_image_quantity"
        | "update_imposition_image_quantities" => {
            let value = reviews::change_job(
                conn,
                args,
                expected,
                command == "return_imposition_to_review",
            )?;
            Ok(value)
        }
        "load_cloud_pools" => {
            let record = store::read(conn, "pools", "shared", false)?;
            Ok(record
                .map(|r| json!({"pools":r.value,"version":r.version}))
                .unwrap_or(json!({"pools":[],"version":0})))
        }
        "save_cloud_pools" => {
            let old = store::read(conn, "pools", "shared", true)?;
            store::check_version(old.as_ref(), expected)?;
            validate_pools(&args["pools"])?;
            store::write(
                conn,
                "pools",
                "shared",
                None,
                expected + 1,
                &args["pools"],
                &json!({"savedAt":store::now()}),
            )?;
            Ok(json!({"version":expected+1}))
        }
        "load_storage_settings" => Ok(
            json!({"historyDirectory":env.storage_root,"defaultHistoryDirectory":env.storage_root,"shared":true,"configPath":config::path()?}),
        ),
        "check_shared_storage" => {
            fs::create_dir_all(&env.storage_root)
                .map_err(|_| "共享目录不可写，请检查网络和共享权限")?;
            let probe = env
                .storage_root
                .join(format!(".printflow-probe-{}", store::uuid(conn)?));
            let result = (|| -> Result<Value> {
                use std::io::Write;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&probe)
                    .map_err(|_| "共享目录不可写")?;
                file.write_all(b"PrintFlow")
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "共享目录写入失败")?;
                drop(file);
                if fs::read(&probe).map_err(|_| "共享目录读取失败")? != b"PrintFlow" {
                    return Err("共享目录内容校验失败".into());
                }
                Ok(json!({"ok":true}))
            })();
            let cleanup =
                fs::remove_file(&probe).map_err(|_| "共享目录测试文件无法删除，请检查删除权限");
            let result = result?;
            cleanup?;
            Ok(result)
        }
        "save_storage_settings" => {
            Err("共享模式的存储目录由 config.toml 统一配置，修改后请重启软件".into())
        }
        _ => Err(format!("共享模式不支持此操作：{command}")),
    }
}

fn validate_pools(value: &Value) -> Result<()> {
    let pools = value.as_array().ok_or("拼版池数据无效")?;
    let mut ids = std::collections::HashSet::new();
    let mut images = std::collections::HashSet::new();
    for pool in pools {
        if !ids.insert(required(pool, "id")?) || text(pool, "name").trim().is_empty() {
            return Err("拼版池名称或 ID 无效".into());
        }
        for image in pool["imageKeys"].as_array().ok_or("拼版池图片列表无效")? {
            if !images.insert(image.as_str().ok_or("拼版池图片标识无效")?) {
                return Err("同一图片不能同时属于多个拼版池".into());
            }
        }
    }
    Ok(())
}

fn execute_request(
    conn: &mut mysql::PooledConn,
    env: &config::Environment,
    user: &str,
    command: &str,
    args: &Value,
    expected: u64,
    request_id: Option<String>,
) -> Result<Value> {
    let request = request_id.ok_or("保存请求缺少唯一标识")?;
    if request.len() != 36 || !request.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("保存请求标识无效".into());
    }
    let digest = resources::hash(format!("{command}:{}:{args}", expected).as_bytes());
    let mut tx = conn.start_transaction(TxOpts::default()).map_err(error)?;
    // A duplicate request waits for the first transaction and replays its
    // committed result, including after a lost network response.
    tx.exec_drop(
        "INSERT IGNORE INTO pf_requests(request_key,user_id,digest,response) VALUES(?,?,?,'null')",
        (&request, user, &digest),
    )
    .map_err(error)?;
    let (owner, known, response): (String, String, String) = tx
        .exec_first(
            "SELECT CAST(user_id AS CHAR),digest,CAST(response AS CHAR) FROM pf_requests WHERE request_key=? FOR UPDATE",
            (&request,),
        )
        .map_err(error)?
        .ok_or("保存请求不可用")?;
    if owner != user || known != digest {
        return Err("保存请求内容不一致，请重新打开记录".into());
    }
    if response != "null" {
        let mut response = store::json_value(response)?;
        tx.commit().map_err(error)?;
        finish_request_cleanup(conn, env, &request, &mut response)?;
        resources::hydrate(conn, env, &mut response, true)?;
        return Ok(response);
    }
    // Persist the cleanup candidates with the deletion so a lost response or
    // unavailable share can be retried after the database transaction commits.
    let cleanup_ids: Vec<String> = if command == "delete_batch" {
        tx.exec(
            "SELECT r.hash FROM pf_resource_refs f JOIN pf_resources r ON r.id=f.resource_id JOIN pf_records b ON b.id=f.record_id WHERE b.kind='batch' AND b.record_key=?",
            (required(args, "id")?,),
        )
        .map_err(error)?
    } else {
        Vec::new()
    };
    let result = dispatch(&mut tx, env, user, command, args, expected, &request)?;
    // Wrap null results so a completed deletion is distinct from pending.
    let mut envelope = json!({"result":result});
    if !cleanup_ids.is_empty() {
        envelope["cleanupResources"] = json!(cleanup_ids);
    }
    tx.exec_drop(
        "UPDATE pf_requests SET response=? WHERE request_key=?",
        (envelope.to_string(), &request),
    )
    .map_err(error)?;
    tx.commit().map_err(error)?;
    finish_request_cleanup(conn, env, &request, &mut envelope)?;
    resources::hydrate(conn, env, &mut envelope, true)?;
    Ok(envelope)
}

fn finish_request_cleanup(
    conn: &mut impl Queryable,
    env: &config::Environment,
    request: &str,
    response: &mut Value,
) -> Result<()> {
    if let Some(ids) = response.get("cleanupResources") {
        let ids: Vec<String> =
            serde_json::from_value(ids.clone()).map_err(|_| "删除文件清理记录无效")?;
        resources::cleanup_deleted_batch(conn, env, &ids)
            .map_err(|e| format!("批次记录已删除，但文件清理尚未完成：{e}。恢复连接后重试删除，或在设置中清理未引用文件"))?;
        conn.exec_drop(
            "UPDATE pf_requests SET response=JSON_REMOVE(response,'$.cleanupResources') WHERE request_key=?",
            (request,),
        )
        .map_err(error)?;
    }
    response
        .as_object_mut()
        .map(|v| v.remove("cleanupResources"));
    Ok(())
}

#[cfg(test)]
mod tests;
