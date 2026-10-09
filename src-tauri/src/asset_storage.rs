//! Durable SVG storage. Paths belong to a batch, independently of the current setting.
use crate::assets::Asset;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSettings {
    pub history_directory: String,
    pub default_history_directory: String,
}

fn ensure_store(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS batch_asset_directories (batch_id TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE);")
        .map_err(|error| error.to_string())
}

pub fn settings(conn: &Connection, default: &Path) -> Result<StorageSettings, String> {
    ensure_store(conn)?;
    let directory: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key='history_directory'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let default = default.to_string_lossy().into_owned();
    Ok(StorageSettings { history_directory: directory.unwrap_or_else(|| default.clone()), default_history_directory: default })
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|error| format!("无法访问 {}：{error}", path.display()))?;
    // Show normal drive/UNC paths in settings and asset details on Windows.
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { return Ok(PathBuf::from(format!(r"\\{rest}"))); }
        if let Some(rest) = text.strip_prefix(r"\\?\") { return Ok(PathBuf::from(rest)); }
    }
    Ok(path)
}

fn stamp() -> String {
    format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos())
}

pub fn save_settings(conn: &Connection, default: &Path, directory: &str, temporary: &Path) -> Result<StorageSettings, String> {
    let path = Path::new(directory.trim());
    if !path.is_absolute() { return Err("请选择或输入完整的保存目录路径".into()); }
    fs::create_dir_all(path).map_err(|error| format!("无法创建保存目录：{error}"))?;
    let path = canonical(path)?;
    if canonical(temporary).ok().is_some_and(|temp| path.starts_with(temp)) {
        return Err("历史记录不能保存在临时图片目录中".into());
    }
    let probe = path.join(format!(".printflow-write-check-{}", stamp()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&probe)?;
        file.write_all(b"PrintFlow")?;
        file.sync_all()
    })();
    let _ = fs::remove_file(&probe);
    result.map_err(|error| format!("保存目录不可写：{error}"))?;
    ensure_store(conn)?;
    conn.execute("INSERT INTO app_settings(key,value) VALUES('history_directory',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [path.to_string_lossy().as_ref()])
        .map_err(|error| error.to_string())?;
    settings(conn, default)
}

pub fn safe_file_name(id: &str) -> String {
    id.chars().map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') { ch } else { '_' }).collect()
}

fn batch_folder_name(name: &str) -> String {
    let name: String = name.trim().chars().map(|ch| if ch.is_control() || "<>:\"/\\|?*".contains(ch) { '_' } else { ch }).take(60).collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() { return "未命名批次".into(); }
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix).is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")));
    if reserved { format!("_{name}") } else { name.into() }
}

/// Call inside the batch's save transaction. Never reuse another batch's folder,
/// even if the customer names match or the user has already created that folder.
pub fn batch_directory(conn: &Connection, default: &Path, batch_id: &str, name: &str) -> Result<PathBuf, String> {
    batch_directory_at(conn, default, batch_id, name, &chrono::Local::now().format("%Y%m%d%H%M").to_string())
}

fn batch_directory_at(conn: &Connection, default: &Path, batch_id: &str, name: &str, timestamp: &str) -> Result<PathBuf, String> {
    ensure_store(conn)?;
    let existing: Option<String> = conn.query_row("SELECT directory FROM batch_asset_directories WHERE batch_id=?1", [batch_id], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    if let Some(existing) = existing {
        let directory = PathBuf::from(existing);
        fs::create_dir_all(&directory).map_err(|error| format!("无法访问批次保存目录：{error}"))?;
        return canonical(&directory);
    }
    let root = PathBuf::from(settings(conn, default)?.history_directory);
    fs::create_dir_all(&root).map_err(|error| format!("无法创建历史记录目录：{error}"))?;
    let root = canonical(&root)?;
    let name = format!("{}_{timestamp}", batch_folder_name(name));
    for index in 1..=10000 {
        let directory = root.join(if index == 1 { name.clone() } else { format!("{name} ({index})") });
        let registered: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM batch_asset_directories WHERE directory=?1)", [directory.to_string_lossy().as_ref()], |row| row.get(0)).map_err(|error| error.to_string())?;
        if registered { continue; }
        match fs::create_dir(&directory) {
            Ok(()) => {
                conn.execute("INSERT INTO batch_asset_directories(batch_id,directory) VALUES(?1,?2)", params![batch_id, directory.to_string_lossy().as_ref()])
                    .map_err(|error| error.to_string())?;
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建批次目录：{error}")),
        }
    }
    Err("同名批次目录过多，请修改客户名称".into())
}

/// Copy bytes without parsing/rasterizing SVG or changing image/size metadata.
/// Keep temporary sources until the caller commits the database transaction.
pub fn persist(mut assets: Vec<Asset>, directory: &Path) -> Result<Vec<Asset>, String> {
    for asset in &mut assets {
        if asset.id.is_empty() { return Err("图片资源缺少 ID".into()); }
        let destination = directory.join(format!("{}.svg", safe_file_name(&asset.id)));
        let source = Path::new(&asset.storage_path);
        if asset.svg.is_empty() && canonical(source).ok() == canonical(&destination).ok() && destination.is_file() {
            asset.storage_path = destination.to_string_lossy().into_owned();
            continue;
        }
        let staging = directory.join(format!(".pending-{}", stamp()));
        let result = (|| -> Result<(), String> {
            if asset.svg.is_empty() {
                fs::copy(source, &staging).map_err(|error| format!("读取图片 {} 失败：{error}", asset.name))?;
            } else {
                fs::write(&staging, asset.svg.as_bytes()).map_err(|error| error.to_string())?;
            }
            if fs::metadata(&staging).map_err(|error| error.to_string())?.len() == 0 { return Err(format!("图片 {} 内容为空", asset.name)); }
            // Imported artwork is immutable. Do not overwrite a different saved
            // original, which may also be referenced by a production job.
            if destination.exists() {
                if fs::read(&destination).map_err(|error| error.to_string())? != fs::read(&staging).map_err(|error| error.to_string())? {
                    return Err(format!("图片 {} 的资源 ID 与已保存文件冲突", asset.name));
                }
            } else {
                fs::rename(&staging, &destination).map_err(|error| format!("保存图片失败：{error}"))?;
            }
            Ok(())
        })();
        let _ = fs::remove_file(&staging);
        result?;
        asset.storage_path = destination.to_string_lossy().into_owned();
    }
    Ok(assets)
}

pub fn is_saved_file(conn: &Connection, file: &Path) -> Result<bool, String> {
    if !file.is_file() || file.extension().map_or(true, |extension| extension != "svg") { return Ok(false); }
    let file = canonical(file)?;
    let Some(parent) = file.parent() else { return Ok(false); };
    // Compatibility with the old flat layout. New locations are explicitly
    // registered per batch, so changing the preference never invalidates them.
    if parent.file_name().is_some_and(|name| name == "assets")
        && parent.parent().and_then(Path::file_name).is_some_and(|name| name == "printflow-data") { return Ok(true); }
    ensure_store(conn)?;
    let registered: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM batch_asset_directories WHERE directory=?1)", [parent.to_string_lossy().as_ref()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if registered { return Ok(true); }
    let mut statement = conn.prepare("SELECT directory FROM batch_asset_directories").map_err(|error| error.to_string())?;
    let directories = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    for directory in directories {
        if canonical(Path::new(&directory.map_err(|error| error.to_string())?)).ok().as_deref() == Some(parent) { return Ok(true); }
    }
    Ok(false)
}

pub fn remove_saved_file(conn: &Connection, file: &Path) -> Result<(), String> {
    if !is_saved_file(conn, file)? { return Ok(()); }
    ensure_store(conn)?;
    fs::remove_file(file).map_err(|error| error.to_string())?;
    if let Some(parent) = file.parent() {
        // Only an empty registered batch directory; never recursive deletion.
        let owned: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM batch_asset_directories WHERE directory=?1)", [parent.to_string_lossy().as_ref()], |row| row.get(0)).map_err(|error| error.to_string())?;
        if owned { let _ = fs::remove_dir(parent); }
    }
    Ok(())
}

pub fn remove_temporary_files(paths: &[String], directory: &Path) {
    let Ok(directory) = canonical(directory) else { return };
    for path in paths {
        if let Ok(path) = canonical(Path::new(path)) {
            if path.parent() == Some(directory.as_path()) && path.extension().is_some_and(|extension| extension == "svg") { let _ = fs::remove_file(path); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture { root: PathBuf, default: PathBuf, temp: PathBuf, database: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("printflow-storage-test-{}", stamp()));
            let default = root.join("printflow-data/assets");
            let temp = root.join("printflow-data/temp-assets");
            fs::create_dir_all(&temp).unwrap();
            let database = root.join("test.sqlite");
            Self { root, default, temp, database }
        }
        fn conn(&self) -> Connection { Connection::open(&self.database).unwrap() }
        fn asset(&self, id: &str) -> Asset {
            let path = self.temp.join(format!("{id}.svg"));
            fs::write(&path, "<svg width=\"44.477mm\" height=\"192.807mm\"><image href=\"data:image/png;base64,AA==\"/></svg>").unwrap();
            serde_json::from_value(json!({"id":id,"name":"原图","productId":"p","width":123.456,"height":456.789,"svg":"",
                "storagePath":path.to_string_lossy(),"sourceGroupWidthMm":44.477,"sourceGroupHeightMm":192.807,
                "sourceImages":[{"nodeId":"image1","widthPx":2000,"heightPx":3000,"widthMm":44.477,"heightMm":192.807,"format":"PNG"}],
                "attributes":{"QT":"0","Finish":"Matte"},"note":"保留","productGroupId":"组1","productGroupPosition":3})).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let root = fs::canonicalize(&self.root).unwrap();
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            assert!(root.starts_with(temp) && root.file_name().unwrap().to_string_lossy().starts_with("printflow-storage-test-"));
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn setting_survives_restart_and_rejects_invalid_locations_without_changing_it() {
        let f = Fixture::new();
        let conn = f.conn();
        assert_eq!(settings(&conn, &f.default).unwrap().history_directory, f.default.to_string_lossy());
        let selected = f.root.join("自选目录");
        save_settings(&conn, &f.default, selected.to_str().unwrap(), &f.temp).unwrap();
        for path in ["relative/path", f.database.to_str().unwrap(), f.temp.to_str().unwrap()] {
            assert!(save_settings(&conn, &f.default, path, &f.temp).is_err());
        }
        drop(conn);
        assert_eq!(settings(&f.conn(), &f.default).unwrap().history_directory, selected.to_string_lossy());
        assert_eq!(fs::read_dir(selected).unwrap().count(), 0);
    }

    #[test]
    fn changed_root_only_applies_to_new_batches_and_preserves_bytes_metadata_and_paths() {
        let f = Fixture::new();
        let conn = f.conn();
        let asset = f.asset("one");
        let original = fs::read(&asset.storage_path).unwrap();
        let directory = batch_directory_at(&conn, &f.default, "batch-1", "客户甲", "202610091016").unwrap();
        assert_eq!(directory, f.default.join("客户甲_202610091016"));
        let saved = persist(vec![asset.clone()], &directory).unwrap().remove(0);
        let mut before = serde_json::to_value(&asset).unwrap();
        before["storagePath"] = json!(saved.storage_path);
        assert_eq!(before, serde_json::to_value(&saved).unwrap());
        assert_eq!(fs::read(&saved.storage_path).unwrap(), original);
        assert!(Path::new(&asset.storage_path).is_file(), "source must survive until database commit");
        let selected = f.root.join("另一个保存位置");
        save_settings(&conn, &f.default, selected.to_str().unwrap(), &f.temp).unwrap();
        drop(conn);
        let conn = f.conn();
        assert_eq!(batch_directory(&conn, &f.default, "batch-1", "修改后的客户名").unwrap(), directory);
        assert_eq!(batch_directory_at(&conn, &f.default, "batch-2", "客户甲", "202610091017").unwrap(), selected.join("客户甲_202610091017"));
        assert!(is_saved_file(&conn, Path::new(&saved.storage_path)).unwrap());
        assert_eq!(fs::read(&saved.storage_path).unwrap(), original);
        assert_eq!(persist(vec![saved.clone()], &directory).unwrap()[0].storage_path, saved.storage_path);
    }

    #[test]
    fn same_names_never_share_folders_and_windows_names_cannot_escape_root() {
        let f = Fixture::new(); let conn = f.conn();
        assert_eq!(batch_directory_at(&conn, &f.default, "a", "客户甲", "202610091016").unwrap(), f.default.join("客户甲_202610091016"));
        assert_eq!(batch_directory_at(&conn, &f.default, "b", "客户甲", "202610091016").unwrap(), f.default.join("客户甲_202610091016 (2)"));
        for (i, name) in ["../逃出目录", "CON", "lpt1.txt", "a/b:c?*", ". "].iter().enumerate() {
            let path = batch_directory(&conn, &f.default, &format!("id-{i}"), name).unwrap();
            assert_eq!(path.parent(), Some(f.default.as_path()));
            assert!(!path.file_name().unwrap().to_string_lossy().contains(['/', '\\', ':', '?', '*']));
        }
    }

    #[test]
    fn failed_copy_rolls_back_database_and_keeps_temporary_sources() {
        let f = Fixture::new(); let conn = f.conn();
        let asset = f.asset("one"); let mut missing = asset.clone(); missing.id = "missing".into(); missing.storage_path = "missing.svg".into();
        settings(&conn, &f.default).unwrap();
        {
            let tx = conn.unchecked_transaction().unwrap();
            let directory = batch_directory(&tx, &f.default, "batch", "客户").unwrap();
            assert!(persist(vec![asset.clone(), missing], &directory).is_err());
        }
        assert!(Path::new(&asset.storage_path).is_file());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM batch_asset_directories", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let directory = batch_directory_at(&conn, &f.default, "batch", "客户", "202610091016").unwrap();
        assert!(persist(vec![asset], &directory).is_ok(), "retry must work after an interrupted save");
    }

    #[test]
    fn temporary_cleanup_preserves_saved_custom_legacy_and_unrelated_files() {
        let f = Fixture::new(); let conn = f.conn();
        let custom = f.root.join("自选");
        save_settings(&conn, &f.default, custom.to_str().unwrap(), &f.temp).unwrap();
        let directory = batch_directory_at(&conn, &f.default, "batch", "客户", "202610091016").unwrap();
        let asset = f.asset("one"); let unrelated = f.asset("unrelated");
        let saved = persist(vec![asset.clone()], &directory).unwrap().remove(0);
        remove_temporary_files(&[asset.storage_path.clone(), saved.storage_path.clone()], &f.temp);
        assert!(!Path::new(&asset.storage_path).exists());
        assert!(Path::new(&unrelated.storage_path).exists());
        assert!(Path::new(&saved.storage_path).exists());
        let outside = custom.join("not-owned.svg"); fs::write(&outside, "keep").unwrap();
        assert!(!is_saved_file(&conn, &outside).unwrap());
        assert!(is_saved_file(&conn, Path::new(&saved.storage_path)).unwrap());
        assert!(directory.exists());
        assert_eq!(batch_directory_at(&conn, &f.default, "new-batch", "客户", "202610091016").unwrap(), custom.join("客户_202610091016 (2)"));
        fs::create_dir_all(&f.default).unwrap();
        let legacy = f.default.join("old.svg"); fs::write(&legacy, "<svg/>").unwrap();
        assert!(is_saved_file(&conn, &legacy).unwrap());
        remove_temporary_files(&[legacy.to_string_lossy().into_owned(), outside.to_string_lossy().into_owned()], &f.temp);
        assert!(legacy.exists()); assert!(outside.exists()); assert!(f.default.exists());
    }
}
