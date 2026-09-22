use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;

#[derive(Serialize)]
pub struct ProductName { pub id: i64, pub name: String }

pub fn list(conn: &Connection) -> Result<Vec<ProductName>, String> {
    let mut stmt = conn.prepare("SELECT MIN(id), trim(json_extract(payload, '$.name')) AS name FROM custom_products WHERE name <> '' GROUP BY name ORDER BY MIN(id)").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(ProductName { id: row.get(0)?, name: row.get(1)? })).map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

pub fn add(conn: &mut Connection, name: &str) -> Result<ProductName, String> {
    let name = name.trim();
    if name.is_empty() { return Err("请填写产品名称".into()); }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    if list(&tx)?.iter().any(|item| item.name == name) { return Err("该产品名称已存在，请直接选择".into()); }
    tx.execute("INSERT INTO custom_products(payload) VALUES(?1)", params![serde_json::json!({ "name": name }).to_string()]).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ProductName { id, name: name.into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_only_and_legacy_duplicates_are_not_exposed() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE custom_products(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)").unwrap();
        for _ in 0..2 { conn.execute("INSERT INTO custom_products(payload) VALUES(?1)", [r#"{"name":"摇摇乐","qt":99,"accessoryColor":"gold"}"#]).unwrap(); }
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(add(&mut conn, " 摇摇乐 ").is_err());
        let saved = add(&mut conn, " 照片夹 ").unwrap();
        let raw: String = conn.query_row("SELECT payload FROM custom_products WHERE id=?1", [saved.id], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&raw).unwrap(), serde_json::json!({"name":"照片夹"}));
    }
}
