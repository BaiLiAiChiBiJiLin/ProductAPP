//! Upgrade v1 with numeric primary/relationship IDs, preserving snapshot keys.
use super::store::{error, Result};
use mysql::prelude::Queryable;

const TABLES: [&str; 8] = [
    "user",
    "pf_schema",
    "pf_records",
    "pf_resources",
    "pf_resource_refs",
    "pf_requests",
    "pf_transfers",
    "pf_migrations",
];

pub fn initialize(conn: &mut impl Queryable) -> Result<()> {
    let lock: Option<u8> = conn
        .query_first("SELECT GET_LOCK(CONCAT(DATABASE(), ':printflow-write'),10)")
        .map_err(error)?;
    if lock != Some(1) {
        return Err("其他电脑正在更新数据库结构，请稍后重试".into());
    }
    let result = initialize_locked(conn);
    let _ = conn.query_drop("DO RELEASE_LOCK(CONCAT(DATABASE(), ':printflow-write'))");
    result
}

fn initialize_locked(conn: &mut impl Queryable) -> Result<()> {
    let exists: u64 = conn.query_first("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='pf_schema'").map_err(error)?.unwrap_or(0);
    let version = if exists > 0 {
        conn.query_first::<u32, _>("SELECT version FROM pf_schema WHERE id=1")
            .map_err(error)?
    } else {
        None
    };
    if version == Some(1) {
        upgrade_v1(conn)?;
    } else if version.is_some() && !matches!(version, Some(2) | Some(3)) {
        return Err("云数据库结构版本不兼容，请更新软件".into());
    } else {
        for sql in include_str!("schema.sql")
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            conn.query_drop(sql).map_err(error)?;
        }
    }
    // Custom product choices belong to each installation's local SQLite store.
    // Snapshot product names/attributes are self-contained and remain untouched.
    conn.query_drop("DROP TABLE IF EXISTS pf_custom_products")
        .map_err(error)?;
    conn.query_drop("UPDATE pf_schema SET version=3 WHERE id=1")
        .map_err(error)?;
    // Atomic rename already committed the complete v2 schema. Old tables are
    // safe to remove, including leftovers if a previous process stopped here.
    for table in TABLES {
        conn.query_drop(format!("DROP TABLE IF EXISTS `{table}_numeric_v1_backup`"))
            .map_err(error)?;
    }
    Ok(())
}

fn upgrade_v1(conn: &mut impl Queryable) -> Result<()> {
    for table in TABLES {
        conn.query_drop(format!("DROP TABLE IF EXISTS `{table}_numeric_v2`"))
            .map_err(error)?;
    }
    let mut schema = include_str!("schema.sql").to_owned();
    // Table identifiers only, never match columns or snapshot data.
    schema = schema.replace("`user`", "`user_numeric_v2`");
    for table in TABLES.iter().filter(|t| **t != "user") {
        schema = schema.replace(
            &format!("EXISTS {table} ("),
            &format!("EXISTS {table}_numeric_v2 ("),
        );
        schema = schema.replace(
            &format!("INTO {table}("),
            &format!("INTO {table}_numeric_v2("),
        );
    }
    for sql in schema.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        conn.query_drop(sql).map_err(error)?;
    }
    for sql in include_str!("upgrade_v1.sql")
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        conn.query_drop(sql).map_err(error)?;
    }
    // Refuse the swap if any join silently lost a row.
    for table in TABLES.iter().filter(|t| **t != "pf_schema") {
        let before: u64 = conn
            .query_first(format!("SELECT COUNT(*) FROM `{table}`"))
            .map_err(error)?
            .unwrap_or(0);
        let after: u64 = conn
            .query_first(format!("SELECT COUNT(*) FROM `{table}_numeric_v2`"))
            .map_err(error)?
            .unwrap_or(0);
        if before != after {
            return Err(format!("数字编号转换核对失败（{table}），原表已保留"));
        }
    }
    let lost_owners: u64 = conn.query_first("SELECT COUNT(*) FROM pf_records old JOIN pf_records_numeric_v2 n ON n.kind=old.kind AND n.record_key=old.id WHERE old.owner_id IS NOT NULL AND n.owner_id IS NULL").map_err(error)?.unwrap_or(0);
    if lost_owners != 0 {
        return Err("数字编号转换发现无效用户归属，原表已保留".into());
    }
    let names = TABLES
        .iter()
        .map(|t| format!("`{t}` TO `{t}_numeric_v1_backup`, `{t}_numeric_v2` TO `{t}`"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.query_drop(format!("RENAME TABLE {names}"))
        .map_err(error)?;
    Ok(())
}
