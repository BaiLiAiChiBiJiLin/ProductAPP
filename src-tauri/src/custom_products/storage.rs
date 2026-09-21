//! Local custom-product presets. Kept separate from the remote catalog cache.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProduct {
    pub id: Option<i64>,
    pub name: String,
    pub size: String,
    pub print_option: String,
    pub finish: String,
    #[serde(default)]
    pub accessory_color: String,
    #[serde(default)]
    pub accessory_color_image: String,
    pub qt: u32,
}

pub(super) fn connect(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS custom_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )").map_err(|e| e.to_string())?;
    Ok(conn)
}

pub(super) fn read(conn: &Connection) -> Result<Vec<CustomProduct>, String> {
    let mut stmt = conn.prepare("SELECT payload FROM custom_products ORDER BY updated_at DESC, id DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.map(|row| serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())).collect()
}

/// Seed only an empty preset library, once. Never overwrite user edits on upgrade.
pub(super) fn seed(conn: &mut Connection, json: &str) -> Result<(), String> {
    let products: Vec<CustomProduct> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS preset_metadata(key TEXT PRIMARY KEY)").map_err(|e| e.to_string())?;
    let initialized: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM preset_metadata WHERE key='bundled-initialized')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !initialized {
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM custom_products", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if count == 0 {
            for product in products {
                let payload = serde_json::to_string(&product).map_err(|e| e.to_string())?;
                tx.execute("INSERT INTO custom_products(id,payload) VALUES(?1,?2)", params![product.id, payload]).map_err(|e| e.to_string())?;
            }
        }
        tx.execute("INSERT INTO preset_metadata(key) VALUES('bundled-initialized')", []).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn write(conn: &mut Connection, mut product: CustomProduct) -> Result<CustomProduct, String> {
    product.name = product.name.trim().to_string();
    if product.name.is_empty() { return Err("请填写产品名称".into()); }
    if product.qt == 0 || product.qt > 2_147_483_647 { return Err("QT 必须是 1 至 2147483647 的整数".into()); }
    for field in [&mut product.size, &mut product.print_option, &mut product.finish, &mut product.accessory_color] {
        *field = field.trim().to_string();
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = if let Some(id) = product.id {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM custom_products WHERE id=?1)", [id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if !exists { return Err("该自定义产品不存在，请新增后保存".into()); }
        id
    } else {
        tx.execute("INSERT INTO custom_products(payload) VALUES('{}')", []).map_err(|e| e.to_string())?;
        tx.last_insert_rowid()
    };
    product.id = Some(id);
    let payload = serde_json::to_string(&product).map_err(|e| e.to_string())?;
    tx.execute("UPDATE custom_products SET payload=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2", params![payload, id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(product)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> CustomProduct {
        CustomProduct { id: None, name: "自定义立牌".into(), size: "10cm".into(), print_option: "双面同图".into(), finish: "亮面".into(), accessory_color: "金色".into(), accessory_color_image: String::new(), qt: 5 }
    }
    #[test]
    fn bundled_presets_seed_once_and_keep_user_changes() {
        let path = std::env::temp_dir().join(format!("preset-seed-{}.sqlite", std::process::id()));
        let mut conn = connect(&path).unwrap();
        let mut product = sample(); product.id = Some(43);
        let json = serde_json::to_string(&vec![product.clone()]).unwrap();
        seed(&mut conn, &json).unwrap();
        assert_eq!(read(&conn).unwrap(), vec![product.clone()]);
        product.qt = 99;
        write(&mut conn, product.clone()).unwrap();
        seed(&mut conn, &json).unwrap();
        assert_eq!(read(&conn).unwrap(), vec![product]);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn presets_survive_reopen_and_updates_keep_id() {
        let path = std::env::temp_dir().join(format!("printflow-custom-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let saved = { let mut conn = connect(&path).unwrap(); write(&mut conn, sample()).unwrap() };
        {
            let mut conn = connect(&path).unwrap();
            assert_eq!(read(&conn).unwrap(), vec![saved.clone()]);
            let mut updated = saved.clone(); updated.qt = 9;
            assert_eq!(write(&mut conn, updated.clone()).unwrap().id, saved.id);
            assert_eq!(read(&conn).unwrap(), vec![updated]);
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn invalid_presets_are_rejected_without_partial_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE custom_products(id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").unwrap();
        let mut invalid = sample(); invalid.qt = 0;
        assert!(write(&mut conn, invalid).is_err());
        let mut invalid = sample(); invalid.name = "  ".into();
        assert!(write(&mut conn, invalid).is_err());
        let mut invalid = sample(); invalid.id = Some(999);
        assert!(write(&mut conn, invalid).is_err());
        assert!(read(&conn).unwrap().is_empty());
    }
}
