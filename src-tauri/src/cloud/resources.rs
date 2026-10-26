use super::{
    config::Environment,
    store::{error, Result},
};
use mysql::prelude::Queryable;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub const FILE: &str = "printflow-file:";
pub const TEXT: &str = "printflow-review:";
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_id(id: &str) -> Result<()> {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("共享资源标识无效".into());
    }
    Ok(())
}
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("共享资源路径无效".into());
    }
    Ok(root.join(path))
}
pub fn path(conn: &mut impl Queryable, env: &Environment, reference: &str) -> Result<PathBuf> {
    let id = reference
        .strip_prefix(FILE)
        .or_else(|| reference.strip_prefix(TEXT))
        .ok_or("不是共享资源引用")?;
    valid_id(id)?;
    let relative: String = conn
        .exec_first("SELECT relative_path FROM pf_resources WHERE hash=?", (id,))
        .map_err(error)?
        .ok_or("共享资源记录不存在")?;
    let path = resolve(&env.storage_root, &relative)?;
    // A junction/symlink must not redirect reads or cleanup outside the root.
    let root =
        fs::canonicalize(&env.storage_root).map_err(|_| "共享目录不可访问，请检查局域网连接")?;
    let actual = fs::canonicalize(&path).map_err(|_| "共享图片文件不存在或不可访问")?;
    if !actual.starts_with(root) {
        return Err("共享图片路径超出存储目录".into());
    }
    Ok(path)
}
pub fn read(conn: &mut impl Queryable, env: &Environment, reference: &str) -> Result<Vec<u8>> {
    let bytes = fs::read(path(conn, env, reference)?).map_err(|_| "读取共享图片失败")?;
    let id = reference
        .strip_prefix(FILE)
        .or_else(|| reference.strip_prefix(TEXT))
        .unwrap();
    if hash(&bytes) != id {
        return Err("共享图片校验失败，文件可能被外部修改".into());
    }
    Ok(bytes)
}
pub fn put(
    conn: &mut impl Queryable,
    env: &Environment,
    folder: &str,
    bytes: &[u8],
    extension: &str,
) -> Result<String> {
    if bytes.is_empty() {
        return Err("不能保存空图片资源".into());
    }
    // Raw SVG artwork must keep an SVG extension even when first encountered
    // as a back/layer string; the content ID can later be used by a main asset.
    let extension = if bytes.windows(4).any(|w| w == b"<svg") {
        "svg"
    } else {
        extension
    };
    let id = hash(bytes);
    let existing: Option<String> = conn
        .exec_first(
            "SELECT relative_path FROM pf_resources WHERE hash=? FOR UPDATE",
            (&id,),
        )
        .map_err(error)?;
    if existing.is_some() {
        if read(conn, env, &format!("{FILE}{id}"))? != bytes {
            return Err("共享资源内容冲突".into());
        }
        return Ok(id);
    }
    if !extension.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return Err("资源扩展名无效".into());
    }
    let relative = format!("{folder}/{id}.{extension}");
    let destination = resolve(&env.storage_root, &relative)?;
    fs::create_dir_all(destination.parent().unwrap())
        .map_err(|_| "无法创建共享批次目录，请检查共享文件夹权限")?;
    let root = fs::canonicalize(&env.storage_root).map_err(|_| "共享目录不可访问")?;
    if !fs::canonicalize(destination.parent().unwrap())
        .map_err(|_| "共享目录不可访问")?
        .starts_with(root)
    {
        return Err("共享目录超出配置范围".into());
    }
    let staging = destination.with_extension(format!(
        "pending-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let written = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|_| "无法写入共享图片")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "共享图片写入未完成")?;
        drop(file);
        if hash(&fs::read(&staging).map_err(|_| "共享图片校验读取失败")?) != id {
            return Err("共享图片写入校验失败".into());
        }
        if destination.exists() {
            if hash(&fs::read(&destination).map_err(|_| "共享图片不可读")?) != id {
                return Err("共享图片文件冲突".into());
            }
        } else {
            fs::rename(&staging, &destination).map_err(|_| "共享图片发布失败，请重试")?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&staging);
    written?;
    conn.exec_drop("INSERT INTO pf_resources(hash,relative_path,bytes) VALUES(?,?,?) ON DUPLICATE KEY UPDATE hash=VALUES(hash)",(&id,&relative,bytes.len() as u64)).map_err(error)?;
    Ok(id)
}
pub fn file(
    conn: &mut impl Queryable,
    env: &Environment,
    folder: &str,
    path: &str,
) -> Result<String> {
    if path.starts_with(FILE) {
        read(conn, env, path)?;
        return Ok(path.into());
    }
    let source = Path::new(path);
    let bytes = fs::read(source).map_err(|_| "需归档的图片或导出文件不存在")?;
    let extension = source.extension().and_then(|s| s.to_str()).unwrap_or("bin");
    Ok(format!(
        "{FILE}{}",
        put(conn, env, folder, &bytes, extension)?
    ))
}
pub fn externalize(
    conn: &mut impl Queryable,
    env: &Environment,
    folder: &str,
    value: &mut Value,
) -> Result<()> {
    match value {
        Value::String(s) if s.starts_with(crate::staged_artwork::PREFIX) => {
            let content = crate::staged_artwork::read(s)?;
            *s = format!(
                "{TEXT}{}",
                put(conn, env, folder, content.as_bytes(), "txt")?
            );
        }
        Value::String(s)
            if !s.starts_with(TEXT)
                && !s.starts_with(FILE)
                && (s.contains("<svg") || s.starts_with("data:image/") || s.len() > 64 * 1024) =>
        {
            *s = format!("{TEXT}{}", put(conn, env, folder, s.as_bytes(), "txt")?);
        }
        Value::Object(map) => {
            for (key, v) in map {
                if matches!(key.as_str(), "storagePath" | "filePath" | "output") {
                    if let Some(s) = v.as_str().filter(|s| !s.is_empty() && !s.starts_with(FILE)) {
                        *v = Value::String(file(conn, env, &format!("{folder}/files"), s)?);
                    }
                } else {
                    externalize(conn, env, folder, v)?;
                }
            }
        }
        Value::Array(values) => {
            for v in values {
                externalize(conn, env, folder, v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn hydrate(
    conn: &mut impl Queryable,
    env: &Environment,
    value: &mut Value,
    texts: bool,
) -> Result<()> {
    match value {
        Value::String(s) if s.starts_with(FILE) => {
            *s = path(conn, env, s)?.to_string_lossy().into_owned()
        }
        Value::String(s) if texts && s.starts_with(TEXT) => {
            *s = String::from_utf8(read(conn, env, s)?).map_err(|_| "审核图片内容编码无效")?
        }
        Value::Object(map) => {
            for v in map.values_mut() {
                hydrate(conn, env, v, texts)?;
            }
        }
        Value::Array(values) => {
            for v in values {
                hydrate(conn, env, v, texts)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn references(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::String(s) => {
            if let Some(id) = s.strip_prefix(FILE).or_else(|| s.strip_prefix(TEXT)) {
                ids.insert(id.into());
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                references(v, ids);
            }
        }
        Value::Array(values) => {
            for v in values {
                references(v, ids);
            }
        }
        _ => {}
    }
}
pub fn update_refs(conn: &mut impl Queryable, kind: &str, id: &str, value: &Value) -> Result<()> {
    let mut refs = BTreeSet::new();
    references(value, &mut refs);
    release_refs(conn, kind, id)?;
    let record_number = super::store::record_id(conn, kind, id)?;
    for resource in refs {
        valid_id(&resource)?;
        let exists: Option<String> = conn
            .exec_first(
                "SELECT hash FROM pf_resources WHERE hash=? FOR UPDATE",
                (&resource,),
            )
            .map_err(error)?;
        if exists.is_none() {
            return Err("引用了不存在的共享图片资源".into());
        }
        conn.exec_drop(
            "UPDATE pf_resources SET released_at=NULL WHERE hash=?",
            (&resource,),
        )
        .map_err(error)?;
        conn.exec_drop(
            "INSERT INTO pf_resource_refs(record_id,resource_id) SELECT ?,id FROM pf_resources WHERE hash=?",
            (record_number, resource),
        )
        .map_err(error)?;
    }
    Ok(())
}
pub fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(50)
        .collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        "未命名批次".into()
    } else {
        name.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape_root() {
        for path in ["../secret", "C:/outside", "/outside", "a/../b"] {
            assert!(resolve(Path::new("C:/share"), path).is_err());
        }
        assert_eq!(
            resolve(Path::new("C:/share"), "batch/assets/a.svg").unwrap(),
            PathBuf::from("C:/share/batch/assets/a.svg")
        );
    }
    #[test]
    fn references_cover_nested_back_artwork_and_notes() {
        let mut ids = BTreeSet::new();
        references(
            &serde_json::json!({"assets":[{"svg":"printflow-review:one","backSvg":"printflow-review:two","storagePath":"printflow-file:three","noteImages":[{"src":"printflow-review:four"}]}]}),
            &mut ids,
        );
        assert_eq!(ids.len(), 4);
    }
}

pub fn release_refs(conn: &mut impl Queryable, kind: &str, id: &str) -> Result<()> {
    let record: Option<u64> = conn
        .exec_first(
            "SELECT id FROM pf_records WHERE kind=? AND record_key=?",
            (kind, id),
        )
        .map_err(error)?;
    if let Some(record) = record {
        conn.exec_drop("UPDATE pf_resources SET released_at=CURRENT_TIMESTAMP(3) WHERE id IN (SELECT resource_id FROM pf_resource_refs WHERE record_id=?)",(record,)).map_err(error)?;
        conn.exec_drop("DELETE FROM pf_resource_refs WHERE record_id=?", (record,))
            .map_err(error)?;
    }
    Ok(())
}

// Runs after the deletion commits, still under the schema-wide write lock.
// Never delete files before commit: rollback would leave live records broken.
pub fn cleanup_deleted_batch(
    conn: &mut impl Queryable,
    env: &Environment,
    ids: &[String],
) -> Result<usize> {
    let mut removed = 0;
    for id in ids {
        valid_id(id)?;
        let relative: Option<String> = conn.exec_first(
            "SELECT relative_path FROM pf_resources r WHERE hash=? AND NOT EXISTS(SELECT 1 FROM pf_resource_refs f WHERE f.resource_id=r.id)",
            (id,),
        ).map_err(error)?;
        let Some(relative) = relative else { continue };
        let root = fs::canonicalize(&env.storage_root).map_err(|_| "共享目录不可访问")?;
        let file = resolve(&env.storage_root, &relative)?;
        match fs::canonicalize(&file) {
            Ok(actual) => {
                if !actual.starts_with(&root) {
                    return Err("清理路径超出共享目录".into());
                }
                fs::remove_file(&file).map_err(|_| "删除共享文件失败，请检查权限或文件占用")?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法检查待删除文件".into()),
        }
        // Remove only empty ancestors inside the configured root, never a tree.
        let mut parent = file.parent();
        while let Some(dir) = parent {
            let Ok(actual) = fs::canonicalize(dir) else {
                break;
            };
            if actual == root || !actual.starts_with(&root) {
                break;
            }
            if fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
        conn.exec_drop("DELETE FROM pf_resources WHERE hash=?", (id,))
            .map_err(error)?;
        removed += 1;
    }
    Ok(removed)
}

// Called only while holding the schema-wide write lock. Retain unreferenced
// files for 24 hours so open editors and failed saves can recover.
pub fn cleanup(conn: &mut impl Queryable, env: &Environment) -> Result<Value> {
    // Resume explicitly requested deletions immediately, even after app restart.
    let pending: Vec<(String, String)> = conn.query("SELECT request_key,CAST(JSON_EXTRACT(response,'$.cleanupResources') AS CHAR) FROM pf_requests WHERE JSON_CONTAINS_PATH(response,'one','$.cleanupResources')").map_err(error)?;
    let mut removed = 0;
    for (request, ids) in pending {
        let ids: Vec<String> = serde_json::from_str(&ids).map_err(|_| "删除文件清理记录无效")?;
        removed += cleanup_deleted_batch(conn, env, &ids)?;
        conn.exec_drop(
            "UPDATE pf_requests SET response=JSON_REMOVE(response,'$.cleanupResources') WHERE request_key=?",
            (request,),
        )
        .map_err(error)?;
    }
    let rows:Vec<(String,String)>=conn.query("SELECT hash,relative_path FROM pf_resources r WHERE COALESCE(released_at,created_at)<CURRENT_TIMESTAMP(3)-INTERVAL 1 DAY AND NOT EXISTS(SELECT 1 FROM pf_resource_refs f WHERE f.resource_id=r.id)").map_err(error)?;
    let root = fs::canonicalize(&env.storage_root).map_err(|_| "共享目录不可访问")?;
    for (id, relative) in rows {
        let file = resolve(&env.storage_root, &relative)?;
        if file.exists() {
            if !fs::canonicalize(&file)
                .map_err(|_| "资源不可访问")?
                .starts_with(&root)
            {
                return Err("清理路径超出共享目录".into());
            }
            fs::remove_file(&file).map_err(|_| "清理共享文件失败，可稍后重试")?;
        }
        conn.exec_drop("DELETE FROM pf_resources WHERE hash=?", (&id,))
            .map_err(error)?;
        removed += 1;
    }
    let known: Vec<String> = conn
        .query("SELECT relative_path FROM pf_resources")
        .map_err(error)?;
    let known: BTreeSet<PathBuf> = known
        .iter()
        .map(|p| resolve(&env.storage_root, p))
        .collect::<Result<_>>()?;
    fn visit(dir: &Path, known: &BTreeSet<PathBuf>, removed: &mut usize) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(|_| "无法扫描共享目录")? {
            let entry = entry.map_err(|_| "无法扫描共享目录")?;
            let ty = entry.file_type().map_err(|_| "无法读取资源类型")?;
            if ty.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ty.is_dir() {
                visit(&path, known, removed)?;
                let _ = fs::remove_dir(&path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.split('.').next().unwrap_or("");
            let old = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86400);
            if old && valid_id(stem).is_ok() && !known.contains(&path) {
                fs::remove_file(&path).map_err(|_| "清理未完成资源失败，可稍后重试")?;
                *removed += 1;
            }
        }
        Ok(())
    }
    visit(&env.storage_root, &known, &mut removed)?;
    Ok(serde_json::json!({"removed":removed}))
}

// Listing only needs addresses. A missing SMB connection should not hide the
// cloud rows; opening artwork still uses path/read and validates the file.
pub fn manifest_paths(
    conn: &mut impl Queryable,
    env: &Environment,
    value: &mut Value,
) -> Result<()> {
    match value {
        Value::String(s) if s.starts_with(FILE) => {
            let id = s.strip_prefix(FILE).unwrap();
            valid_id(id)?;
            let relative: String = conn
                .exec_first("SELECT relative_path FROM pf_resources WHERE hash=?", (id,))
                .map_err(error)?
                .ok_or("共享资源记录不存在")?;
            *s = resolve(&env.storage_root, &relative)?
                .to_string_lossy()
                .into_owned();
        }
        Value::Object(map) => {
            for v in map.values_mut() {
                manifest_paths(conn, env, v)?;
            }
        }
        Value::Array(values) => {
            for v in values {
                manifest_paths(conn, env, v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
