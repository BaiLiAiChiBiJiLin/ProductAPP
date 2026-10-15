//! Remove only delivered originals that no remaining local record references.
//! A candidate list is never authority to delete outside managed storage roots.
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;

fn canonical_if_present(path: &Path) -> Result<Option<PathBuf>> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("检查转移清理路径失败 {}：{error}", path.display())),
    }
}

fn has_table(conn: &Connection, table: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn referenced_paths(
    value: &Value,
    candidates: &HashSet<PathBuf>,
    protected: &mut HashSet<PathBuf>,
) -> Result<()> {
    match value {
        Value::String(text) if Path::new(text).is_absolute() => {
            if let Some(path) = canonical_if_present(Path::new(text))? {
                if candidates.contains(&path) {
                    protected.insert(path);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                referenced_paths(value, candidates, protected)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                referenced_paths(value, candidates, protected)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// `managed_roots` is supplied by native code, never directly by a UI request.
/// All candidates are original source references returned by completed handoffs.
/// Return the number of files removed. Missing files are harmless. Inspection or
/// deletion errors are returned to the caller for logging and recovery.
pub fn remove_unreferenced(
    conn: &Connection,
    candidates: &[String],
    managed_roots: &[PathBuf],
) -> Result<usize> {
    // Prevent another local SQLite writer from creating references between the
    // reference scan and deletion. The transaction does not modify business rows.
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut root_paths = managed_roots.to_vec();
    if has_table(&tx, "batch_asset_directories")? {
        let mut statement = tx
            .prepare("SELECT directory FROM batch_asset_directories")
            .map_err(|e| e.to_string())?;
        let directories = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for directory in directories {
            root_paths.push(PathBuf::from(directory.map_err(|e| e.to_string())?));
        }
    }
    let mut roots = HashSet::new();
    for root in root_paths {
        if !root.is_absolute() {
            continue;
        }
        if let Some(root) = canonical_if_present(&root)? {
            if root.is_dir() {
                roots.insert(root);
            }
        }
    }
    let mut eligible = HashSet::new();
    for value in candidates {
        let path = Path::new(value);
        if !path.is_absolute() {
            continue;
        }
        if let Some(path) = canonical_if_present(path)? {
            if path.is_file()
                && roots
                    .iter()
                    .any(|root| path.starts_with(root) && path != *root)
            {
                eligible.insert(path);
            }
        }
    }
    if eligible.is_empty() {
        return Ok(0);
    }
    let mut protected = HashSet::new();
    for (table, column) in [
        ("assets", "payload"),
        ("batches", "payload"),
        ("schematic_reviews", "payload"),
        ("production_imposition_jobs", "images"),
    ] {
        if !has_table(&tx, table)? {
            continue;
        }
        let mut statement = tx
            .prepare(&format!("SELECT {column} FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let text = row.map_err(|e| e.to_string())?;
            // Invalid old JSON is not evidence that its files are unreferenced.
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| format!("无法检查 {table} 的剩余文件引用：{e}"))?;
            referenced_paths(&value, &eligible, &mut protected)?;
        }
    }
    if has_table(&tx, "production_imposition_jobs")? {
        let mut statement = tx
            .prepare("SELECT output FROM production_imposition_jobs")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            referenced_paths(
                &Value::String(row.map_err(|e| e.to_string())?),
                &eligible,
                &mut protected,
            )?;
        }
    }
    let mut removed = 0;
    let mut empty_parents = HashSet::new();
    for path in eligible.difference(&protected) {
        // Resolve once more before touching disk to detect a redirected junction.
        let Some(current) = canonical_if_present(path)? else {
            continue;
        };
        if current != *path {
            return Err(format!("转移清理期间文件路径发生变化：{}", path.display()));
        }
        match fs::remove_file(path) {
            Ok(()) => {
                removed += 1;
                if let Some(parent) = path.parent() {
                    empty_parents.insert(parent.to_owned());
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("删除已转移文件失败 {}：{error}", path.display())),
        }
    }
    for parent in empty_parents {
        let mut current = parent;
        // Leave explicitly managed roots in place; only remove empty descendants.
        while !roots.contains(&current) && roots.iter().any(|root| current.starts_with(root)) {
            match fs::remove_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => break,
                Err(error) => {
                    return Err(format!("清理空转移目录失败 {}：{error}", current.display()))
                }
            }
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent.to_owned();
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}
