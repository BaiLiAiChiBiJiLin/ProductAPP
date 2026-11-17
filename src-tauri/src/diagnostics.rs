//! Device-local, bounded diagnostic events and a deliberately limited support
//! export. Never copy recovery payloads, configuration files or raw log lines.
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_EVENTS: i64 = 5_000;
const MAX_RECOVERY_ROWS: usize = 250;
const MAX_ASSETS: usize = 2_000;
const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const EVENTS: &[&str] = &[
    "app_started",
    "sync_queued",
    "sync_submit",
    "sync_ack",
    "sync_committed",
    "sync_error",
    "transfer_submit",
    "transfer_ack",
    "transfer_committed",
    "transfer_error",
    "sync_recovered",
    "diagnostic_export",
    "history_open",
    "history_opened",
    "history_error",
];
const COMMANDS: &[&str] = &[
    "save_batch",
    "delete_batch",
    "delete_asset",
    "send_shared_batch",
    "save_schematic_review",
    "delete_schematic_review",
    "update_schematic_review_payment_status",
    "submit_schematic_review_to_imposition",
    "return_imposition_to_review",
    "update_imposition_image_quantity",
    "update_imposition_image_quantities",
    "save_cloud_pools",
    "read_or_setup",
    "load_batch",
];
const KINDS: &[&str] = &[
    "connection",
    "conflict",
    "source",
    "permission",
    "configuration",
    "data",
    "unknown",
    "local-storage",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundleResult {
    path: String,
    bytes: u64,
    warnings: Vec<String>,
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn unique_id() -> String {
    digest(&format!(
        "{}:{:?}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
    ))[..32]
        .to_owned()
}
fn session_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(unique_id)
}
fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn identifier(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    (!value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:#".contains(&c)))
    .then(|| value.to_owned())
}
fn display_name(value: &Value) -> Option<String> {
    let value = value.as_str()?.trim();
    (!value.is_empty()
        && value.chars().count() <= 100
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || " #._-·（）()@+".contains(c)))
    .then(|| value.to_owned())
}
fn enum_field(value: &Value, allowed: &[&str]) -> Option<String> {
    value
        .as_str()
        .filter(|v| allowed.contains(v))
        .map(str::to_owned)
}
fn insert_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}
fn insert_number(map: &mut Map<String, Value>, key: &str, value: &Value) {
    if let Some(value) = value.as_u64() {
        map.insert(key.into(), json!(value));
    }
}
fn insert_bool(map: &mut Map<String, Value>, key: &str, value: &Value) {
    if let Some(value) = value.as_bool() {
        map.insert(key.into(), json!(value));
    }
}

fn sanitize_event(value: &Value) -> Option<Value> {
    let event = enum_field(&value["event"], EVENTS)?;
    let mut out = Map::new();
    out.insert("event".into(), json!(event));
    for key in ["batchId", "requestId", "revision", "recoveredBatchId"] {
        insert_string(&mut out, key, identifier(&value[key]));
    }
    for key in ["userName", "recipient"] {
        insert_string(&mut out, key, display_name(&value[key]));
    }
    insert_string(&mut out, "command", enum_field(&value["command"], COMMANDS));
    insert_string(
        &mut out,
        "errorKind",
        enum_field(&value["errorKind"], KINDS),
    );
    insert_string(
        &mut out,
        "stage",
        enum_field(
            &value["stage"],
            &["request", "acknowledgement", "journal", "queue"],
        ),
    );
    insert_string(
        &mut out,
        "result",
        enum_field(&value["result"], &["ok", "failed", "cancelled"]),
    );
    insert_string(&mut out, "appVersion", identifier(&value["appVersion"]));
    for key in [
        "expectedVersion",
        "resultVersion",
        "attempts",
        "elapsedMs",
        "assetCount",
    ] {
        insert_number(&mut out, key, &value[key]);
    }
    for key in ["retryable", "replayed"] {
        insert_bool(&mut out, key, &value[key]);
    }
    Some(Value::Object(out))
}

fn event_connection(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|_| "无法创建本地诊断目录")?;
    let conn =
        Connection::open(root.join("diagnostics.sqlite")).map_err(|_| "无法打开本地诊断记录")?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|_| "无法设置诊断记录等待时间")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS diagnostic_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS diagnostic_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
        .map_err(|_| "无法初始化本地诊断记录")?;
    Ok(conn)
}
fn append(root: &Path, event: &Value) -> Result<(), String> {
    let mut event = sanitize_event(event).ok_or("不支持的诊断事件")?;
    let mut conn = event_connection(root)?;
    let tx = conn.transaction().map_err(|_| "无法开始诊断记录事务")?;
    tx.execute(
        "INSERT OR IGNORE INTO diagnostic_identity(key,value) VALUES('deviceId',?)",
        [unique_id()],
    )
    .map_err(|_| "无法保存诊断设备标识")?;
    let device: String = tx
        .query_row(
            "SELECT value FROM diagnostic_identity WHERE key='deviceId'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "无法读取诊断设备标识")?;
    event["deviceId"] = json!(device);
    event["sessionId"] = json!(session_id());
    event["timestamp"] = json!(timestamp());
    tx.execute(
        "INSERT INTO diagnostic_events(payload) VALUES(?)",
        [event.to_string()],
    )
    .map_err(|_| "无法追加诊断事件")?;
    tx.execute("DELETE FROM diagnostic_events WHERE seq <= (SELECT COALESCE(MAX(seq),0) FROM diagnostic_events)-?", [MAX_EVENTS]).map_err(|_| "无法轮换诊断事件")?;
    tx.commit().map_err(|_| "无法提交诊断事件".to_owned())
}

pub fn record_startup(root: &Path, version: &str) -> Result<(), String> {
    append(root, &json!({"event":"app_started", "appVersion":version}))
}

#[tauri::command]
pub async fn append_diagnostic_event(event: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || append(&crate::project_data_dir(), &event))
        .await
        .map_err(|_| "诊断事件记录任务异常结束")?
}

fn source_summary(root: &Path, value: &Value) -> Value {
    let Some(path) = value.as_str().filter(|v| !v.is_empty()) else {
        return Value::Null;
    };
    let source = Path::new(path);
    let temporary = root.join("temp-assets");
    let is_local_temp = source.parent() == Some(temporary.as_path())
        && source.extension().and_then(|v| v.to_str()) == Some("svg")
        && !path.starts_with("\\\\")
        && !path.contains("..")
        && !path.contains("://");
    let location = if path.starts_with("printflow-") {
        "shared-reference"
    } else if path.starts_with("\\\\") {
        "network"
    } else if is_local_temp {
        "temporary"
    } else {
        "other"
    };
    let mut result =
        json!({"pathHash":&digest(path)[..16],"location":location,"checked":is_local_temp});
    if is_local_temp {
        match fs::metadata(source) {
            Ok(metadata) => {
                result["exists"] = json!(true);
                result["bytes"] = json!(metadata.len());
            }
            Err(error) => {
                result["exists"] = json!(false);
                result["errorKind"] = json!(if error.kind() == std::io::ErrorKind::NotFound {
                    "not-found"
                } else {
                    "unavailable"
                });
            }
        }
    }
    result
}

fn error_summary(value: &Value) -> Value {
    let text = value.as_str().unwrap_or_default();
    if text.is_empty() {
        return Value::Null;
    }
    let (kind, summary) = if text.contains("记录已被其他用户修改")
        || text.contains("云端记录已过期")
        || text.contains("请求内容不一致")
    {
        ("conflict", "云端版本冲突")
    } else if text.contains("已转移或不属于当前用户") {
        ("permission", "批次已转移或归属不匹配")
    } else if text.contains("源文件") || text.contains("图片校验") {
        ("source", "图片源文件不可访问或校验失败")
    } else if text.contains("本地同步") || text.contains("QuotaExceeded") {
        ("local-storage", "本地同步记录存储失败")
    } else if text.contains("连接") || text.contains("超时") || text.contains("offline") {
        ("connection", "连接或请求失败")
    } else {
        ("unknown", "其他错误，原始错误文本未导出")
    };
    json!({"kind":kind,"summary":summary})
}

fn asset_summary(root: &Path, value: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "productId", "sourceGroupId"] {
        insert_string(&mut out, key, identifier(&value[key]));
    }
    for key in ["width", "height"] {
        if value[key].as_f64().is_some_and(f64::is_finite) {
            out.insert(key.into(), value[key].clone());
        }
    }
    out.insert(
        "hasInlineSvg".into(),
        json!(value["svg"].as_str().is_some_and(|v| !v.is_empty())),
    );
    out.insert("source".into(), source_summary(root, &value["storagePath"]));
    if let Some(images) = value["sourceImages"].as_array() {
        out.insert("sourceImageCount".into(), json!(images.len()));
    }
    Value::Object(out)
}
fn args_summary(root: &Path, value: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "batchId", "jobId"] {
        insert_string(&mut out, key, identifier(&value[key]));
    }
    if let Some(assets) = value["assets"].as_array() {
        out.insert("assetCount".into(), json!(assets.len()));
        out.insert(
            "assets".into(),
            json!(assets
                .iter()
                .take(MAX_ASSETS)
                .map(|asset| asset_summary(root, asset))
                .collect::<Vec<_>>()),
        );
        if assets.len() > MAX_ASSETS {
            out.insert("assetsTruncated".into(), json!(true));
        }
    }
    insert_string(&mut out, "recipient", display_name(&value["recipient"]));
    Value::Object(out)
}
fn queue_summary(root: &Path, value: &Value) -> Value {
    let mut out = Map::new();
    for key in ["revision", "key"] {
        insert_string(&mut out, key, identifier(&value[key]));
    }
    insert_string(&mut out, "command", enum_field(&value["command"], COMMANDS));
    for key in ["attempts", "nextAttemptAt"] {
        insert_number(&mut out, key, &value[key]);
    }
    for key in ["blocked", "deletionRequested"] {
        insert_bool(&mut out, key, &value[key]);
    }
    out.insert("error".into(), error_summary(&value["error"]));
    out.insert("args".into(), args_summary(root, &value["args"]));
    Value::Object(out)
}
fn journal_summary(root: &Path, value: &Value) -> Value {
    let versions: Map<String, Value> = value["versions"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, version)| {
            identifier(&json!(key))
                .filter(|_| version.as_u64().is_some())
                .map(|key| (key, version.clone()))
        })
        .take(2_000)
        .collect();
    let pending: Vec<Value> = value["pending"]
        .as_object()
        .into_iter()
        .flatten()
        .take(250)
        .map(|(key, request)| {
            let mut out = Map::new();
            insert_string(&mut out, "recordKey", identifier(&json!(key)));
            insert_string(&mut out, "requestId", identifier(&request["requestId"]));
            insert_string(
                &mut out,
                "command",
                enum_field(&request["command"], COMMANDS),
            );
            insert_number(&mut out, "expectedVersion", &request["expectedVersion"]);
            out.insert("args".into(), args_summary(root, &request["args"]));
            Value::Object(out)
        })
        .collect();
    json!({"versions":versions,"pending":pending})
}

fn recovery_snapshot(root: &Path, warnings: &mut Vec<String>) -> Value {
    let path = root.join("cloud-sync.sqlite");
    if !path.exists() {
        warnings.push("本机尚无同步恢复数据库".into());
        return json!([]);
    }
    let result = (|| -> rusqlite::Result<Value> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(Duration::from_secs(2))?;
        conn.execute_batch("BEGIN DEFERRED")?;
        let mut stmt = conn.prepare(
            "SELECT scope,key,
            CASE WHEN length(CAST(payload AS BLOB)) <= ?1 THEN payload ELSE NULL END
            FROM local_sync_state WHERE (scope='cloud-sync-queue' AND key='batches')
                OR key='write-journal' OR scope='cloud-sync-recovery' LIMIT 251",
        )?;
        let mut rows = stmt.query([MAX_PAYLOAD_BYTES as i64])?;
        let mut out = Vec::new();
        let mut input_bytes = 0;
        while let Some(row) = rows.next()? {
            if out.len() >= MAX_RECOVERY_ROWS {
                warnings.push("同步恢复概要超过上限，已截取前 250 项".into());
                break;
            }
            let scope: String = row.get(0)?;
            let key: String = row.get(1)?;
            let Some(payload) = row.get::<_, Option<String>>(2)? else {
                warnings.push("一项恢复记录过大，已略过其内容".into());
                continue;
            };
            input_bytes += payload.len();
            if input_bytes > MAX_SNAPSHOT_BYTES {
                warnings.push("本地恢复记录较多，已限制诊断概要大小；近期事件仍会导出".into());
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                warnings.push("一项本地恢复记录格式无效，未导出原文".into());
                continue;
            };
            let data = if scope == "cloud-sync-queue" && key == "batches" {
                json!({"kind":"queue","entries":value.as_array().into_iter().flatten().take(250).map(|v| queue_summary(root,v)).collect::<Vec<_>>()})
            } else if key == "write-journal" {
                json!({"kind":"write-journal","summary":journal_summary(root,&value)})
            } else if scope == "cloud-sync-recovery" {
                json!({"kind":"recovery-backup","recoveredBatchId":identifier(&value["recoveredBatchId"]),"original":queue_summary(root,&value["original"])})
            } else {
                continue;
            };
            out.push(json!({"scopeHash":&digest(&scope)[..16],"keyHash":&digest(&key)[..16],"data":data}));
        }
        Ok(json!(out))
    })();
    result.unwrap_or_else(|_| {
        warnings.push("本地同步数据库暂不可读取，其他诊断信息已继续收集".into());
        json!([])
    })
}

fn exported_events(root: &Path, warnings: &mut Vec<String>) -> Vec<Value> {
    if !root.join("diagnostics.sqlite").exists() {
        return Vec::new();
    }
    let result = (|| -> rusqlite::Result<Vec<Value>> {
        let conn = Connection::open_with_flags(
            root.join("diagnostics.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(Duration::from_secs(2))?;
        let mut stmt = conn.prepare(
            "SELECT payload FROM diagnostic_events
            WHERE length(CAST(payload AS BLOB)) <= 8192 ORDER BY seq LIMIT 5000",
        )?;
        let mut events = Vec::new();
        for payload in stmt.query_map([], |row| row.get::<_, String>(0))? {
            let Ok(value) = serde_json::from_str::<Value>(&payload?) else {
                continue;
            };
            if let Some(mut clean) = sanitize_event(&value) {
                for key in ["deviceId", "sessionId"] {
                    if let Some(id) = identifier(&value[key]) {
                        clean[key] = json!(id);
                    }
                }
                if let Some(date) = value["timestamp"]
                    .as_str()
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                {
                    clean["timestamp"] = json!(date.to_rfc3339());
                }
                events.push(clean);
            }
        }
        Ok(events)
    })();
    result.unwrap_or_else(|_| {
        warnings.push("本地诊断事件暂不可读取".into());
        Vec::new()
    })
}

fn runtime_summary(log_dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(log_dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.starts_with("printflow") && v.ends_with(".log"))
        })
        .collect();
    paths.sort();
    let mut results = Vec::new();
    for path in paths.iter().rev().take(3) {
        let Ok(file) = File::open(path) else {
            continue;
        };
        for line in BufReader::new(file.take(2 * 1024 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if !line.contains("printflow::cloud") {
                continue;
            }
            let Some(marker) = line.find("command=") else {
                continue;
            };
            let fields: Vec<_> = line[marker..].split_whitespace().collect();
            if fields.len() != 4 {
                continue;
            }
            let Some(command) = fields[0]
                .strip_prefix("command=")
                .filter(|v| COMMANDS.contains(v))
            else {
                continue;
            };
            let Some(stage) = fields[1].strip_prefix("stage=").filter(|v| {
                [
                    "configuration",
                    "connection",
                    "identity",
                    "write",
                    "prepare",
                ]
                .contains(v)
            }) else {
                continue;
            };
            let Some(elapsed) = fields[2]
                .strip_prefix("elapsed_ms=")
                .and_then(|v| v.parse::<u64>().ok())
            else {
                continue;
            };
            let Some(outcome) = fields[3]
                .strip_prefix("outcome=")
                .filter(|v| ["ok", "failed"].contains(v))
            else {
                continue;
            };
            results.push(
                json!({"command":command,"stage":stage,"elapsedMs":elapsed,"outcome":outcome}),
            );
            if results.len() >= 1_000 {
                return results;
            }
        }
    }
    results
}

fn context_summary(value: &Value) -> Value {
    let mut out = Map::new();
    insert_string(&mut out, "userName", display_name(&value["userName"]));
    insert_string(
        &mut out,
        "environment",
        enum_field(
            &value["environment"],
            &["development", "production", "dev", "local", "browser"],
        ),
    );
    insert_bool(&mut out, "shared", &value["shared"]);
    let mut event_status = Map::new();
    for key in ["pending", "failed", "dropped"] {
        insert_number(&mut event_status, key, &value["diagnosticEvents"][key]);
    }
    if !event_status.is_empty() {
        out.insert("diagnosticEvents".into(), Value::Object(event_status));
    }
    if let Some(tasks) = value["tasks"].as_array() {
        out.insert(
            "tasks".into(),
            json!(tasks
                .iter()
                .take(250)
                .map(|task| {
                    let mut clean = Map::new();
                    insert_string(&mut clean, "id", identifier(&task["id"]));
                    insert_string(
                        &mut clean,
                        "operation",
                        enum_field(&task["operation"], COMMANDS),
                    );
                    insert_string(
                        &mut clean,
                        "state",
                        enum_field(
                            &task["state"],
                            &["idle", "queued", "syncing", "error", "blocked"],
                        ),
                    );
                    insert_string(
                        &mut clean,
                        "errorKind",
                        enum_field(&task["errorKind"], KINDS),
                    );
                    for key in ["attempts", "assetCount"] {
                        insert_number(&mut clean, key, &task[key]);
                    }
                    for key in ["blocked", "deletionRequested", "retryable"] {
                        insert_bool(&mut clean, key, &task[key]);
                    }
                    Value::Object(clean)
                })
                .collect::<Vec<_>>()),
        );
    }
    Value::Object(out)
}

fn export(
    root: &Path,
    log_dir: &Path,
    path: &Path,
    context: &Value,
) -> Result<DiagnosticBundleResult, String> {
    if !path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("zip"))
    {
        return Err("诊断包必须保存为 ZIP 文件".into());
    }
    let mut warnings = Vec::new();
    if context["warnings"]
        .as_array()
        .is_some_and(|items| !items.is_empty())
    {
        warnings.push("部分前端状态未能收集，仍已导出可用的本地诊断信息".into());
    }
    let recovery = recovery_snapshot(root, &mut warnings);
    let events = exported_events(root, &mut warnings);
    let runtime = runtime_summary(log_dir);
    let manifest = json!({"schemaVersion":1,"createdAt":timestamp(),"appVersion":env!("CARGO_PKG_VERSION"),
        "os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"context":context_summary(context),
        "eventLimit":MAX_EVENTS,"eventCount":events.len(),"warnings":warnings,
        "excludes":["passwords","configuration files","original artwork","note images","raw databases","raw request args","request fingerprints","raw runtime logs"]});
    let parent = path
        .parent()
        .filter(|v| !v.as_os_str().is_empty())
        .ok_or("诊断包保存路径无效")?;
    if !parent.is_dir() {
        return Err("诊断包保存目录不存在".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "无法创建诊断包，请检查目录权限和磁盘空间")?;
    {
        let mut zip = zip::ZipWriter::new(temporary.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let events_jsonl = events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        for (name, data) in [
            ("manifest.json", serde_json::to_string_pretty(&manifest).unwrap()),
            ("sync-summary.json", serde_json::to_string_pretty(&recovery).unwrap()),
            ("events.jsonl", events_jsonl),
            ("runtime-summary.json", serde_json::to_string_pretty(&runtime).unwrap()),
            ("README.txt", "PrintFlow 诊断包\n包含本机同步概要、版本和请求编号、近期事件与运行阶段。\n不含账号密码、配置文件、原图、备注图片、完整数据库或原始请求内容。\n网络文件仅记录路径摘要，不访问共享目录。\n事件从新版安装启动后开始记录；既往操作无法完整追溯。\n本包为诊断概要，不能用于恢复或导入业务数据。\n".into()),
        ] {
            zip.start_file(name,options).map_err(|_| "无法创建诊断包条目")?;
            zip.write_all(data.as_bytes()).map_err(|_| "诊断包写入失败，请检查磁盘空间")?;
        }
        zip.finish().map_err(|_| "诊断包未完成")?;
    }
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|_| "诊断包未能写入磁盘")?;
    temporary
        .persist(path)
        .map_err(|_| "诊断包保存失败，请检查文件占用和目录权限")?;
    let bytes = fs::metadata(path).map_err(|_| "无法读取诊断包大小")?.len();
    Ok(DiagnosticBundleResult {
        path: path.to_string_lossy().into_owned(),
        bytes,
        warnings,
    })
}

#[tauri::command]
pub async fn export_diagnostic_bundle(
    path: String,
    context: Value,
) -> Result<DiagnosticBundleResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let log_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("logs");
        export(
            &crate::project_data_dir(),
            &log_dir,
            Path::new(&path),
            &context,
        )
    })
    .await
    .map_err(|_| "诊断包导出任务异常结束")?
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use super::*;

    fn archive_text(path: &Path) -> String {
        let mut zip = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        assert_eq!(zip.len(), 5);
        let mut all = String::new();
        for index in 0..zip.len() {
            zip.by_index(index)
                .unwrap()
                .read_to_string(&mut all)
                .unwrap();
        }
        all
    }
    fn recovery_db(root: &Path) -> Connection {
        let conn = Connection::open(root.join("cloud-sync.sqlite")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE local_sync_state(scope TEXT,key TEXT,payload TEXT);").unwrap();
        conn
    }

    #[test]
    fn bundle_excludes_credentials_artwork_fingerprints_and_raw_logs() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        fs::create_dir(&logs).unwrap();
        fs::write(
            root.path().join("config.toml"),
            "password=TOP_SECRET_CONFIG",
        )
        .unwrap();
        fs::write(logs.join("printflow.log"), "arbitrary password=TOP_SECRET_LOG\n[printflow::cloud] command=save_batch stage=write elapsed_ms=35 outcome=failed\n[password=TOP_SECRET_PREFIX][printflow::cloud] command=save_batch stage=write elapsed_ms=36 outcome=ok\n").unwrap();
        let conn = recovery_db(root.path());
        let source = json!({"id":"asset-1","width":12,"height":20,"svg":"<svg>TOP_SECRET_SVG</svg>","noteImages":["data:image/png;base64,TOP_SECRET_NOTE"],"storagePath":"\\\\server\\TOP_SECRET_PATH\\art.svg"});
        let queue = json!([{"revision":"rev1","command":"save_batch","args":{"id":"batch-1","assets":[source],"password":"TOP_SECRET_ARGS"},"error":"password=TOP_SECRET_ERROR","attempts":843}]);
        conn.execute(
            "INSERT INTO local_sync_state VALUES(?,?,?)",
            params!["cloud-sync-queue", "batches", queue.to_string()],
        )
        .unwrap();
        let journal = json!({"versions":{"batch:batch-1":4},"pending":{"batch:batch-1":{"requestId":"req-1","command":"save_batch","expectedVersion":4,"fingerprint":"TOP_SECRET_FINGERPRINT","args":{"id":"batch-1","assets":[source]}}}});
        conn.execute(
            "INSERT INTO local_sync_state VALUES(?,?,?)",
            params![
                "[\"TOP_SECRET_SCOPE\"]",
                "write-journal",
                journal.to_string()
            ],
        )
        .unwrap();
        append(root.path(), &json!({"event":"sync_submit","batchId":"batch-1","requestId":"req-1","expectedVersion":4,"password":"TOP_SECRET_EVENT","args":source})).unwrap();
        let path = root.path().join("diagnostics.zip");
        let result = export(root.path(),&logs,&path,&json!({"userName":"张三","password":"TOP_SECRET_CONTEXT","tasks":[{"id":"batch-1","error":"TOP_SECRET_CONTEXT_ERROR","args":source}]})).unwrap();
        assert!(result.bytes > 0);
        let text = archive_text(&path);
        assert!(!text.contains("TOP_SECRET"));
        assert!(!text.contains("<svg"));
        assert!(!text.contains("data:image"));
        assert!(text.contains("req-1"));
        assert!(text.contains("843"));
        assert!(text.contains("expectedVersion"));
        assert!(text.contains("elapsedMs"));
        assert!(text.contains("张三"));
    }

    #[test]
    fn missing_or_corrupt_database_still_exports_and_never_creates_recovery_database() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("missing.zip");
        let result = export(root.path(), root.path(), &path, &json!({})).unwrap();
        assert!(!result.warnings.is_empty());
        assert!(!root.path().join("cloud-sync.sqlite").exists());
        fs::write(
            root.path().join("cloud-sync.sqlite"),
            b"BROKEN_PRIVATE_DATABASE",
        )
        .unwrap();
        let result = export(
            root.path(),
            root.path(),
            &root.path().join("corrupt.zip"),
            &json!({}),
        )
        .unwrap();
        assert!(!result.warnings.is_empty());
        assert!(!archive_text(&root.path().join("corrupt.zip")).contains("BROKEN_PRIVATE_DATABASE"));
    }

    #[test]
    fn live_wal_snapshot_contains_committed_work_but_not_uncommitted_changes() {
        let root = tempfile::tempdir().unwrap();
        let conn = recovery_db(root.path());
        let first =
            json!([{"revision":"revision-committed","args":{"id":"batch-live","assets":[]}}]);
        conn.execute(
            "INSERT INTO local_sync_state VALUES('cloud-sync-queue','batches',?)",
            [first.to_string()],
        )
        .unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        conn.execute(
            "UPDATE local_sync_state SET payload=?",
            [json!([{"revision":"revision-not-committed","args":{"assets":[]}}]).to_string()],
        )
        .unwrap();
        let path = root.path().join("live.zip");
        export(root.path(), root.path(), &path, &json!({})).unwrap();
        let text = archive_text(&path);
        assert!(text.contains("revision-committed"));
        assert!(!text.contains("revision-not-committed"));
        conn.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn event_store_is_bounded_and_retains_session_and_device_identity() {
        let root = tempfile::tempdir().unwrap();
        record_startup(root.path(), "1.2.3").unwrap();
        let conn = event_connection(root.path()).unwrap();
        conn.execute(
            "INSERT INTO diagnostic_events(seq,payload) VALUES(?,?)",
            params![MAX_EVENTS + 10, "{}"],
        )
        .unwrap();
        append(root.path(),&json!({"event":"transfer_ack","batchId":"batch-1","requestId":"request-2","recipient":"李四","replayed":true})).unwrap();
        let events = exported_events(root.path(), &mut vec![]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"], "transfer_ack");
        assert!(events[0]["deviceId"].as_str().is_some());
        assert!(events[0]["sessionId"].as_str().is_some());
        assert!(append(root.path(), &json!({"event":"password=SECRET"})).is_err());
    }

    #[test]
    fn oversized_recovery_payload_is_skipped_before_loading_or_parsing_it() {
        let root = tempfile::tempdir().unwrap();
        let conn = recovery_db(root.path());
        conn.execute(
            "INSERT INTO local_sync_state VALUES('cloud-sync-queue','batches',zeroblob(?))",
            [MAX_PAYLOAD_BYTES + 1],
        )
        .unwrap();
        let path = root.path().join("oversized.zip");
        let result = export(
            root.path(),
            root.path(),
            &path,
            &json!({"warnings":["RAW_PRIVATE_ERROR"]}),
        )
        .unwrap();
        assert!(result.warnings.iter().any(|value| value.contains("过大")));
        assert!(result.bytes < 10_000);
        assert!(!archive_text(&path).contains("RAW_PRIVATE_ERROR"));
    }
}
