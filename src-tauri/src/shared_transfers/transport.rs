use super::{
    files::{self, FileEntry, Result, FILE_PREFIX},
    store::{self, Data, RecordIds},
};
use rusqlite::{
    params, Connection, DatabaseName, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
};

pub const DEV_ROOT: &str = r"\\192.168.0.66\电商文件\printFlow\dev\historyProduction";
pub const PRODUCTION_ROOT: &str = r"\\192.168.0.66\电商文件\printFlow\production\historyProduction";
pub fn root_for_environment(development: bool) -> &'static str {
    if development {
        DEV_ROOT
    } else {
        PRODUCTION_ROOT
    }
}
const ACTIVE: &str = "('preparing','publishing','published','received')";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u8,
    pub task_id: String,
    pub sender: String,
    pub recipient: String,
    pub batch_name: String,
    pub created_at: String,
    pub asset_count: usize,
    pub review_count: usize,
    pub job_count: usize,
    pub files: Vec<FileEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    task_id: String,
    recipient: String,
    manifest_json: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub imported: usize,
    pub finalized: usize,
    pub errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub asset_count: usize,
    pub review_count: usize,
    pub job_count: usize,
}

pub fn username(value: &str) -> Result<&str> {
    let name = value.trim();
    let reserved = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name.chars().count() > 30
        || name.starts_with('.')
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&reserved.as_str())
        || ["COM", "LPT"].iter().any(|prefix| {
            reserved.strip_prefix(prefix).is_some_and(|n| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)
            })
        })
    {
        return Err("请在用户信息中填写有效用户名（不能包含路径符号或 Windows 保留名称）".into());
    }
    Ok(name)
}

pub fn register(root: &Path, name: &str) -> Result<PathBuf> {
    let name = username(name)?;
    fs::create_dir_all(root).map_err(|e| format!("无法访问共享历史目录：{e}"))?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let folder = root.join(name);
    fs::create_dir_all(&folder).map_err(|e| format!("无法创建用户共享目录：{e}"))?;
    let folder = fs::canonicalize(folder).map_err(|e| e.to_string())?;
    if folder.parent() != Some(root.as_path()) {
        return Err("用户目录超出共享根目录".into());
    }
    let profile = folder.join(".printflow-user.json");
    if profile.exists() {
        let value: Value = files::read_json(&profile)?;
        if value["username"].as_str() != Some(name) {
            return Err("该共享目录已使用其他大小写的用户名，请保持用户名一致".into());
        }
    } else {
        let result = files::write_json(&profile, &json!({"username":name,"schemaVersion":1}));
        if let Err(error) = result {
            let other: Value = files::read_json(&profile).map_err(|_| error.clone())?;
            if other["username"].as_str() != Some(name) {
                return Err(error);
            }
        }
    }
    fs::create_dir_all(folder.join("inbox")).map_err(|e| e.to_string())?;
    Ok(folder)
}

pub fn users(root: &Path, current: &str) -> Result<Vec<String>> {
    register(root, current)?;
    let mut users = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if username(&name).is_ok()
            && name != current
            && entry.path().join(".printflow-user.json").is_file()
        {
            users.push(name);
        }
    }
    users.sort();
    Ok(users)
}

pub fn preview(conn: &Connection, batch: &str) -> Result<Preview> {
    let data = store::snapshot(conn, batch)?;
    Ok(Preview {
        asset_count: data.batch["payload"].as_array().map_or(0, Vec::len),
        review_count: data.reviews.len(),
        job_count: data.jobs.len(),
    })
}

struct Builder<'a> {
    folder: &'a Path,
    files: Vec<FileEntry>,
    paths: HashMap<PathBuf, String>,
    cleanup: HashSet<String>,
}
impl Builder<'_> {
    fn add(&mut self, path: &Path, required: bool) -> Result<Option<String>> {
        if !path.is_file() {
            if required {
                return Err(format!("转移资源不存在：{}", path.display()));
            }
            return Ok(None);
        }
        let original = path.to_string_lossy().into_owned();
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        if let Some(name) = self.paths.get(&path) {
            return Ok(Some(format!("{FILE_PREFIX}{name}")));
        }
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let extension =
            if extension.bytes().all(|b| b.is_ascii_alphanumeric()) && extension.len() <= 8 {
                extension
            } else {
                "bin".into()
            };
        let name = format!("resource-{:06}.{extension}", self.files.len() + 1);
        let file = files::stream_to(
            File::open(&path).map_err(|e| e.to_string())?,
            &self.folder.join(&name),
        )?;
        self.cleanup.insert(original);
        self.paths.insert(path, name.clone());
        self.files.push(file);
        Ok(Some(format!("{FILE_PREFIX}{name}")))
    }

    fn rewrite(&mut self, value: &mut Value, key: &str) -> Result<()> {
        match value {
            Value::String(text)
                if !text.is_empty()
                    && (["storagePath", "filePath"].contains(&key)
                        || (["output", "noteImage", "src", "attributeImages"].contains(&key)
                            && Path::new(text).is_absolute())) =>
            {
                if let Some(reference) = self.add(Path::new(text), key != "output")? {
                    *text = reference;
                } else if key == "output" {
                    *text = Path::new(text)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                }
            }
            Value::Object(values) => {
                for (field, entry) in values {
                    self.rewrite(entry, if key == "attributeImages" { key } else { field })?;
                }
            }
            Value::Array(values) => {
                for entry in values {
                    self.rewrite(entry, key)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

pub fn send(
    conn: &Connection,
    root: &Path,
    staging: &Path,
    batch: &str,
    sender: &str,
    recipient: &str,
    progress: &mut dyn FnMut(&str, usize, usize),
) -> Result<Manifest> {
    username(sender)?;
    username(recipient)?;
    if sender == recipient {
        return Err("不能转移给自己".into());
    }
    register(root, sender)?;
    let target = register(root, recipient)?;
    fs::create_dir_all(staging).map_err(|e| e.to_string())?;
    let _worker = files::inbox_lock(staging)?;
    store::ensure_store(conn)?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    store::ensure_editable(&tx, "batch", batch)?;
    let data = store::snapshot(&tx, batch)?;
    let ids = store::ids(&data);
    let shared_asset: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM batches b,json_each(b.payload) a JOIN json_each(?2) moved ON json_extract(a.value,'$.id')=moved.value WHERE b.id<>?1)",params![batch,serde_json::to_string(&ids.assets).unwrap()],|r| r.get(0)).map_err(|e| e.to_string())?;
    if shared_asset {
        return Err("关联图片还被其他历史批次共用，不能单独转移当前批次；请先处理重复批次".into());
    }
    for asset in &ids.assets {
        store::ensure_editable(&tx, "asset", asset)?;
    }
    for review in &ids.reviews {
        store::ensure_editable(&tx, "review", review)?;
    }
    for job in &ids.jobs {
        store::ensure_editable(&tx, "job", job)?;
    }
    for review in &data.reviews {
        validate_review_refs(&tx, store::text(review, "id")?, &review["payload"])?;
    }
    let task: String = tx
        .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO shared_transfer_outbox(task_id,batch_id,sender,recipient,status,record_ids) VALUES(?1,?2,?3,?4,'preparing',?5)",params![task,batch,sender,recipient,serde_json::to_string(&ids).unwrap()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let result = build_and_publish(
        conn, root, staging, &task, &target, data, sender, recipient, progress,
    );
    if result.is_err() {
        // Once publication starts, its outcome can be unknown on disconnect.
        // Keep it frozen; refresh resumes/verifies it instead of permitting edits.
        conn.execute("UPDATE shared_transfer_outbox SET status='failed' WHERE task_id=?1 AND status='preparing'",[&task]).map_err(|e| e.to_string())?;
    }
    result
}

fn build_and_publish(
    conn: &Connection,
    _root: &Path,
    staging: &Path,
    task: &str,
    target: &Path,
    mut data: Data,
    sender: &str,
    recipient: &str,
    progress: &mut dyn FnMut(&str, usize, usize),
) -> Result<Manifest> {
    files::task_id(task)?;
    fs::create_dir_all(staging).map_err(|e| e.to_string())?;
    let folder = staging.join(format!("send-{task}"));
    fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let mut builder = Builder {
        folder: &folder,
        files: vec![],
        paths: HashMap::new(),
        cleanup: HashSet::new(),
    };
    progress("prepare", 0, 1);
    builder.rewrite(&mut data.batch, "")?;
    for record in data.reviews.iter_mut().chain(&mut data.jobs) {
        builder.rewrite(record, "")?;
    }
    let packet = Connection::open(folder.join("package.sqlite")).map_err(|e| e.to_string())?;
    store::store_packet(&packet, &data)?;
    for review in &data.reviews {
        let id = store::text(review, "id")?;
        let mut stmt = conn
            .prepare("SELECT rowid,resource_id FROM schematic_review_resources WHERE record_id=?1")
            .map_err(|e| e.to_string())?;
        let resources: Vec<(i64, String)> = stmt
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        for (rowid, resource_id) in resources {
            let name = format!("resource-{:06}.bin", builder.files.len() + 1);
            let blob = conn
                .blob_open(
                    DatabaseName::Main,
                    "schematic_review_resources",
                    "content",
                    rowid,
                    true,
                )
                .map_err(|e| e.to_string())?;
            builder
                .files
                .push(files::stream_to(blob, &folder.join(&name))?);
            packet
                .execute(
                    "INSERT INTO resources VALUES(?1,?2,?3)",
                    params![id, resource_id, name],
                )
                .map_err(|e| e.to_string())?;
        }
    }
    // Reject packets the receiver cannot read before publishing/freezing ownership.
    let _ = store::load_packet(&packet)?;
    packet.close().map_err(|(_, e)| e.to_string())?;
    builder
        .files
        .push(files::describe(&folder.join("package.sqlite"))?);
    let manifest = Manifest {
        schema_version: 1,
        task_id: task.into(),
        sender: sender.into(),
        recipient: recipient.into(),
        batch_name: data.batch["metadata"]["customerName"]
            .as_str()
            .unwrap_or("图片批次")
            .into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        asset_count: data.batch["payload"].as_array().map_or(0, Vec::len),
        review_count: data.reviews.len(),
        job_count: data.jobs.len(),
        files: builder.files,
    };
    validate_manifest(&manifest, recipient)?;
    files::write_json(&folder.join("manifest.json"), &manifest)?;
    let pending = target.join("inbox").join(format!(".pending-{task}"));
    fs::create_dir(&pending).map_err(|e| e.to_string())?;
    for (index, file) in manifest.files.iter().enumerate() {
        progress("send", index, manifest.files.len());
        files::copy_verified(&folder, &pending, file)?;
    }
    files::write_json(&pending.join("manifest.json"), &manifest)?;
    conn.execute("UPDATE shared_transfer_outbox SET status='publishing',manifest=?2,cleanup_paths=?3 WHERE task_id=?1",params![task,serde_json::to_string(&manifest).unwrap(),serde_json::to_string(&builder.cleanup).unwrap()]).map_err(|e| e.to_string())?;
    let published = target.join("inbox").join(format!("task-{task}"));
    files::move_new(&pending, &published)?;
    let check: Manifest = files::read_json(&published.join("manifest.json"))?;
    if serde_json::to_string(&check).unwrap() != serde_json::to_string(&manifest).unwrap() {
        return Err("发布结果校验失败，请刷新确认转移状态".into());
    }
    conn.execute(
        "UPDATE shared_transfer_outbox SET status='published' WHERE task_id=?1",
        [task],
    )
    .map_err(|e| e.to_string())?;
    progress("sent", manifest.files.len(), manifest.files.len());
    Ok(manifest)
}

fn validate_manifest(manifest: &Manifest, user: &str) -> Result<()> {
    files::task_id(&manifest.task_id)?;
    username(&manifest.sender)?;
    if manifest.schema_version != 1
        || manifest.recipient != user
        || manifest.files.len() > 10000
        || manifest.asset_count == 0
    {
        return Err("转移数据包版本或接收用户不匹配".into());
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        files::safe_name(&file.name)?;
        if !names.insert(&file.name)
            || file.bytes > 512 * 1024 * 1024
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("转移资源清单无效".into());
        }
        total = total.checked_add(file.bytes).ok_or("数据包过大")?;
    }
    if total > 12 * 1024 * 1024 * 1024 || !names.contains(&"package.sqlite".to_string()) {
        return Err("数据包过大或缺少数据库".into());
    }
    Ok(())
}

pub fn receive(
    conn: &Connection,
    root: &Path,
    local_root: &Path,
    username: &str,
    custom_ids: &mut dyn FnMut(&[String]) -> Result<HashMap<String, String>>,
    progress: &mut dyn FnMut(&str, usize, usize),
) -> Result<SyncResult> {
    let user = register(root, username)?;
    let lock = files::inbox_lock(&user)?;
    store::ensure_store(conn)?;
    fs::create_dir_all(local_root).map_err(|e| e.to_string())?;
    let mut result = SyncResult::default();
    let mut incoming = fs::read_dir(user.join("inbox"))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect::<Vec<_>>();
    incoming.sort_by_key(|e| e.file_name());
    for entry in incoming {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("task-") || !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let outcome = receive_one(
            conn,
            &entry.path(),
            local_root,
            username,
            custom_ids,
            progress,
            &lock,
        );
        match outcome {
            Ok(imported) => result.imported += usize::from(imported),
            Err(error) => result.errors.push(format!("{name}：{error}")),
        }
    }
    Ok(result)
}

fn receive_one(
    conn: &Connection,
    package: &Path,
    local_root: &Path,
    user: &str,
    custom_ids: &mut dyn FnMut(&[String]) -> Result<HashMap<String, String>>,
    progress: &mut dyn FnMut(&str, usize, usize),
    lock: &files::InboxLock,
) -> Result<bool> {
    let canonical_package = fs::canonicalize(package).map_err(|e| e.to_string())?;
    let canonical_parent =
        fs::canonicalize(package.parent().ok_or("数据包目录无效")?).map_err(|e| e.to_string())?;
    if canonical_package.parent() != Some(canonical_parent.as_path()) {
        return Err("数据包目录超出用户收件目录".into());
    }
    let manifest: Manifest = files::read_json(&package.join("manifest.json"))?;
    validate_manifest(&manifest, user)?;
    if package.file_name().and_then(|s| s.to_str()) != Some(&format!("task-{}", manifest.task_id)) {
        return Err("转移任务目录不匹配".into());
    }
    let already: Option<String> = conn
        .query_row(
            "SELECT batch_id FROM shared_transfer_receipts WHERE task_id=?1 AND recipient=?2",
            params![manifest.task_id, user],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if already.is_some() {
        acknowledge(package, &manifest, lock)?;
        return Ok(false);
    }
    // Per-task directory is deterministic. Interrupted copies are verified/reused.
    let safe_batch: String = manifest
        .batch_name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(35)
        .collect();
    let folder = local_root.join(format!(
        "接收_{}_{}",
        safe_batch.trim_matches([' ', '.']),
        manifest.task_id
    ));
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    if fs::canonicalize(&folder)
        .map_err(|e| e.to_string())?
        .parent()
        != Some(
            fs::canonicalize(local_root)
                .map_err(|e| e.to_string())?
                .as_path(),
        )
    {
        return Err("接收文件目录超出历史保存目录".into());
    }
    let mut file_map = HashMap::new();
    for (index, file) in manifest.files.iter().enumerate() {
        lock.check()?;
        progress("receive", index, manifest.files.len());
        files::copy_verified(package, &folder, file)?;
        file_map.insert(
            file.name.clone(),
            folder.join(&file.name).to_string_lossy().into_owned(),
        );
    }
    let packet = Connection::open_with_flags(
        folder.join("package.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    packet
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
        .map_err(|e| e.to_string())?;
    let mut data = store::load_packet(&packet)?;
    if data.batch["payload"].as_array().map_or(0, Vec::len) != manifest.asset_count
        || data.reviews.len() != manifest.review_count
        || data.jobs.len() != manifest.job_count
    {
        return Err("数据包记录数量校验失败".into());
    }
    let custom = custom_ids(&store::custom_names(&data))?;
    let id_map = store::remap(&mut data, &manifest.task_id, &file_map, &custom)?;
    lock.check()?;
    import_data(conn, &packet, &data, &manifest, &folder, &file_map, &id_map)?;
    acknowledge(package, &manifest, lock)?;
    progress("received", manifest.files.len(), manifest.files.len());
    Ok(true)
}

fn import_data(
    conn: &Connection,
    packet: &Connection,
    data: &Data,
    manifest: &Manifest,
    folder: &Path,
    files: &HashMap<String, String>,
    ids: &HashMap<String, String>,
) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_transfer_receipts WHERE task_id=?1)",
            [&manifest.task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if existing {
        return Ok(());
    }
    let batch_id = store::text(&data.batch, "id")?;
    for asset in data.batch["payload"].as_array().ok_or("批次图片数据无效")? {
        validate_asset(asset, files, true)?;
        tx.execute(
            "INSERT INTO assets(id,payload) VALUES(?1,?2)",
            params![store::text(asset, "id")?, asset.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO batches(id,saved_at,payload,metadata) VALUES(?1,?2,?3,?4)",
        params![
            batch_id,
            store::text(&data.batch, "savedAt")?,
            data.batch["payload"].to_string(),
            data.batch["metadata"].to_string()
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO batch_asset_directories(batch_id,directory) VALUES(?1,?2)",
        params![batch_id, folder.to_string_lossy().as_ref()],
    )
    .map_err(|e| e.to_string())?;
    for review in &data.reviews {
        let id = store::text(review, "id")?;
        let payload = &review["payload"];
        if payload["schemaVersion"].as_u64() != Some(1)
            || !payload["pages"].is_array()
            || payload["assets"].as_array().map_or(true, Vec::is_empty)
        {
            return Err("审核快照数据无效".into());
        }
        // Extra historical assets can be needed by a snapshot even when they
        // no longer appear in the source batch's current image list.
        for asset in payload["assets"].as_array().unwrap() {
            validate_asset(asset, files, false)?;
            tx.execute(
                "INSERT INTO assets(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO NOTHING",
                params![store::text(asset, "id")?, asset.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO schematic_reviews(id,saved_at,summary,payload) VALUES(?1,?2,?3,?4)",
            params![
                id,
                store::text(review, "savedAt")?,
                review["summary"].to_string(),
                payload.to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        let payment = store::text(review, "paymentStatus")?;
        if !["paid", "unpaid"].contains(&payment) {
            return Err("付款状态无效".into());
        }
        tx.execute(
            "INSERT INTO schematic_review_payment_states VALUES(?1,?2)",
            params![id, payment],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut stmt = packet
        .prepare("SELECT record_id,resource_id,file_name FROM resources")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (record, resource, name) = row.map_err(|e| e.to_string())?;
        let record = ids.get(&record).ok_or("审核资源关联丢失")?;
        if !data
            .reviews
            .iter()
            .any(|r| r["id"].as_str() == Some(record.as_str()))
        {
            return Err("审核资源关联无效".into());
        }
        let path = files.get(&name).ok_or("审核资源文件丢失")?;
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let size = i32::try_from(size).map_err(|_| "审核资源过大")?;
        tx.execute("INSERT INTO schematic_review_resources(record_id,resource_id,content) VALUES(?1,?2,?3)",params![record,resource,rusqlite::blob::ZeroBlob(size)]).map_err(|e| e.to_string())?;
        let rowid = tx.last_insert_rowid();
        let mut blob = tx
            .blob_open(
                DatabaseName::Main,
                "schematic_review_resources",
                "content",
                rowid,
                false,
            )
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut blob).map_err(|e| e.to_string())?;
    }
    for review in &data.reviews {
        let id = store::text(review, "id")?;
        if review["payload"]["id"].as_str() != Some(id)
            || review["summary"]["id"].as_str() != Some(id)
        {
            return Err("审核记录标识不一致".into());
        }
        validate_review_refs(&tx, id, &review["payload"])?;
        let assets: HashSet<&str> = review["payload"]["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|a| a["id"].as_str())
            .collect();
        for page in review["payload"]["pages"].as_array().unwrap() {
            for item in page["items"].as_array().ok_or("审核页面图片数据无效")? {
                if !assets.contains(store::text(item, "assetId")?) {
                    return Err("审核页面图片关联丢失".into());
                }
            }
        }
    }
    for job in &data.jobs {
        let images = job["images"].as_array().ok_or("生产图片数据无效")?;
        if images.is_empty() || images.len() != job["imageCount"].as_u64().unwrap_or(0) as usize {
            return Err("生产图片数量无效".into());
        }
        if !["paid", "unpaid"].contains(&store::text(job, "paymentStatus")?) {
            return Err("生产付款状态无效".into());
        }
        let review_id = store::text(job, "sourceReviewId")?;
        let review = data
            .reviews
            .iter()
            .find(|r| r["id"].as_str() == Some(review_id))
            .ok_or("生产拼版关联审核记录丢失")?;
        let assets: HashSet<&str> = review["payload"]["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|a| a["id"].as_str())
            .collect();
        for image in images {
            if !assets.contains(store::text(image, "id")?) {
                return Err("生产图片关联丢失".into());
            }
            validate_file_path(store::text(image, "filePath")?, files)?;
            for key in ["widthMm", "heightMm"] {
                if !image[key]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0)
                {
                    return Err("生产图片尺寸无效".into());
                }
            }
        }
        tx.execute("INSERT INTO production_imposition_jobs(id,source_review_id,customer_name,output,submitted_at,payment_status,status,image_count,images) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![store::text(job,"id")?,store::text(job,"sourceReviewId")?,job["customerName"].as_str().unwrap_or(""),job["output"].as_str().unwrap_or(""),store::text(job,"submittedAt")?,store::text(job,"paymentStatus")?,store::text(job,"status")?,images.len(),job["images"].to_string()]).map_err(|e| e.to_string())?;
    }
    tx.execute("INSERT INTO shared_transfer_receipts(task_id,recipient,imported_at,batch_id) VALUES(?1,?2,?3,?4)",params![manifest.task_id,manifest.recipient,chrono::Utc::now().to_rfc3339(),batch_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn validate_asset(
    asset: &Value,
    files: &HashMap<String, String>,
    require_saved: bool,
) -> Result<()> {
    store::text(asset, "id")?;
    if !asset["name"].is_string() || !asset["svg"].is_string() || !asset["productId"].is_string() {
        return Err("图片资产数据无效".into());
    }
    if !asset["width"]
        .as_f64()
        .is_some_and(|n| n.is_finite() && n > 0.0)
        || !asset["height"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0)
    {
        return Err("图片尺寸数据无效".into());
    }
    if let Some(path) = asset["storagePath"].as_str().filter(|s| !s.is_empty()) {
        validate_file_path(path, files)?;
    } else if require_saved || asset["svg"].as_str().unwrap_or("").is_empty() {
        return Err("图片资产缺少已保存源文件".into());
    }
    Ok(())
}

fn validate_file_path(path: &str, files: &HashMap<String, String>) -> Result<()> {
    if !files.values().any(|value| value == path) || !Path::new(path).is_file() {
        return Err("图片文件未完整转移到本地".into());
    }
    Ok(())
}

fn validate_review_refs(conn: &Connection, review: &str, value: &Value) -> Result<()> {
    match value {
        Value::String(s) => {
            if let Some(resource) = s.strip_prefix("printflow-review:") {
                let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM schematic_review_resources WHERE record_id=?1 AND resource_id=?2)",params![review,resource],|r| r.get(0)).map_err(|e| e.to_string())?;
                if !exists {
                    return Err(format!("审核图片资源缺失：{resource}"));
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_review_refs(conn, review, item)?;
            }
        }
        Value::Object(items) => {
            for item in items.values() {
                validate_review_refs(conn, review, item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn acknowledge(package: &Path, manifest: &Manifest, lock: &files::InboxLock) -> Result<()> {
    lock.check()?;
    let receipt = Receipt {
        task_id: manifest.task_id.clone(),
        recipient: manifest.recipient.clone(),
        manifest_json: serde_json::to_string(manifest).unwrap(),
    };
    let path = package.join("received.json");
    if path.exists() {
        let existing: Receipt = files::read_json(&path)?;
        if existing.task_id != receipt.task_id
            || existing.recipient != receipt.recipient
            || existing.manifest_json != receipt.manifest_json
        {
            return Err("接收确认与数据包不匹配".into());
        }
        return Ok(());
    }
    files::write_json(&path, &receipt)
}

pub fn finalize(conn: &Connection, root: &Path) -> Result<(usize, Vec<String>)> {
    store::ensure_store(conn)?;
    let mut finalized = 0;
    let mut cleanup = Vec::new();
    let mut stmt = conn.prepare(&format!("SELECT task_id,batch_id,recipient,status,manifest,record_ids,cleanup_paths FROM shared_transfer_outbox WHERE status IN {ACTIVE}")).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (task, batch, recipient, status, manifest_json, ids_json, paths_json) in rows {
        if status == "preparing" {
            continue;
        }
        files::task_id(&task)?;
        username(&recipient)?;
        let manifest: Manifest = serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;
        let inbox = register(root, &recipient)?.join("inbox");
        let package = inbox.join(format!("task-{task}"));
        if status == "publishing" && !package.is_dir() {
            let pending = inbox.join(format!(".pending-{task}"));
            let check: Manifest = files::read_json(&pending.join("manifest.json"))?;
            if serde_json::to_string(&check).unwrap() != manifest_json {
                return Err("待发布数据包校验失败".into());
            }
            for file in &check.files {
                files::verify(&pending, file)?;
            }
            files::move_new(&pending, &package)?;
        }
        if status == "publishing" {
            conn.execute(
                "UPDATE shared_transfer_outbox SET status='published' WHERE task_id=?1",
                [&task],
            )
            .map_err(|e| e.to_string())?;
        }
        let receipt_path = package.join("received.json");
        if !receipt_path.is_file() {
            continue;
        }
        let receipt: Receipt = files::read_json(&receipt_path)?;
        if receipt.task_id != task
            || receipt.recipient != recipient
            || receipt.manifest_json != serde_json::to_string(&manifest).unwrap()
        {
            return Err("转移接收确认无效".into());
        }
        let ids: RecordIds = serde_json::from_str(&ids_json).map_err(|e| e.to_string())?;
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let current: String = tx
            .query_row(
                "SELECT status FROM shared_transfer_outbox WHERE task_id=?1",
                [&task],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if current == "complete" {
            continue;
        }
        for job in &ids.jobs {
            tx.execute("DELETE FROM production_imposition_jobs WHERE id=?1", [job])
                .map_err(|e| e.to_string())?;
        }
        for review in &ids.reviews {
            for (table, column) in [
                ("schematic_review_resources", "record_id"),
                ("schematic_review_payment_states", "record_id"),
                ("schematic_reviews", "id"),
            ] {
                tx.execute(&format!("DELETE FROM {table} WHERE {column}=?1"), [review])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.execute("DELETE FROM batches WHERE id=?1", [&batch])
            .map_err(|e| e.to_string())?;
        for asset in &ids.assets {
            tx.execute("DELETE FROM assets WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM batches b,json_each(b.payload) a WHERE json_extract(a.value,'$.id')=?1) AND NOT EXISTS(SELECT 1 FROM schematic_reviews r,json_each(r.payload,'$.assets') a WHERE json_extract(a.value,'$.id')=?1) AND NOT EXISTS(SELECT 1 FROM production_imposition_jobs j,json_each(j.images) i WHERE json_extract(i.value,'$.id')=?1)",[asset]).map_err(|e| e.to_string())?;
        }
        let cache_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_thumbnail_cache')",[],|r| r.get(0)).map_err(|e| e.to_string())?;
        if cache_exists {
            tx.execute(
                "DELETE FROM batch_thumbnail_cache WHERE batch_id=?1",
                [&batch],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE shared_transfer_outbox SET status='complete' WHERE task_id=?1",
            [&task],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        cleanup
            .extend(serde_json::from_str::<Vec<String>>(&paths_json).map_err(|e| e.to_string())?);
        finalized += 1;
    }
    Ok((finalized, cleanup))
}

pub fn recover_preparing(conn: &Connection, staging: &Path) -> Result<()> {
    fs::create_dir_all(staging).map_err(|e| e.to_string())?;
    // A second live window/process can still be exporting. Never infer that a
    // task is abandoned from its age; use the actual exclusive worker handle.
    if let Ok(_worker) = files::inbox_lock(staging) {
        store::ensure_store(conn)?;
        conn.execute(
            "UPDATE shared_transfer_outbox SET status='failed' WHERE status='preparing'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
