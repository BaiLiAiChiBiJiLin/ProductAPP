//! One compact catalog index shared by every batch; SVG/image data is never copied.
use std::{collections::HashMap, fs, path::Path, sync::{Mutex, OnceLock}, time::SystemTime};
use crate::assets::Asset;
type Cache = Option<(std::path::PathBuf, Option<SystemTime>, HashMap<String, String>)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
fn key(value: &str) -> String { value.chars().filter(|c| !c.is_whitespace() && *c != '_' && *c != '-').flat_map(char::to_lowercase).collect() }
fn excluded(name: &str) -> bool {
    let name = key(name);
    matches!(name.as_str(), "product" | "productname" | "productid" | "产品" | "产品名" | "产品名称" | "qt" | "quantity" | "数量")
        || name.contains("accessor") || name.contains("配件") || name.contains("image") || name.contains("图片") || name.contains("数量")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_matches_and_persists_without_overwriting_explicit_finish() {
        let path = std::env::temp_dir().join(format!("finish-test-{}.json", std::process::id()));
        fs::write(&path, r#"[{"name":"Epoxy","labelZh":"滴胶"}]"#).unwrap();
        let mut assets: Vec<Asset> = serde_json::from_str(r#"[{"id":"a","name":"a","productId":"p","width":1,"height":1,"svg":"","attributes":{"Technique":"滴胶","QT":"Epoxy"}},{"id":"b","name":"b","productId":"p","width":1,"height":1,"svg":"","attributes":{"Finish":"Custom","Technique":"滴胶"}},{"id":"c","name":"c","productId":"p","width":1,"height":1,"svg":"","attributes":{"Accessories Color":"滴胶","QT":"Epoxy"}}]"#).unwrap();
        fill(&mut assets, &path).unwrap();
        assert_eq!(assets[0].attributes["Finish"], "Epoxy");
        assert_eq!(assets[1].attributes["Finish"], "Custom");
        assert!(!assets[2].attributes.contains_key("Finish"));
        let _ = fs::remove_file(path);
    }
}
pub fn fill(assets: &mut [Asset], path: &Path) -> Result<(), String> {
    if assets.iter().all(|a| a.attributes.iter().any(|(k,v)| key(k) == "finish" && !v.trim().is_empty())) { return Ok(()); }
    let modified = fs::metadata(path).map_err(|e| format!("工艺缓存读取失败：{e}"))?.modified().ok();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().map_err(|e| e.to_string())?;
    if cache.as_ref().is_none_or(|(p,m,_)| p != path || *m != modified) {
        let records: Vec<super::FinishCacheRecord> = serde_json::from_reader(std::io::BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
        let mut index = HashMap::new();
        for record in records {
            if let Some(name) = record.name.filter(|n| !n.trim().is_empty()) {
                index.insert(key(&name), name.clone());
                if let Some(label) = record.label_zh.filter(|n| !n.trim().is_empty()) { index.insert(key(&label), name); }
            }
        }
        *cache = Some((path.to_owned(), modified, index));
    }
    let index = &cache.as_ref().unwrap().2;
    for asset in assets {
        if asset.attributes.iter().any(|(k,v)| key(k) == "finish" && !v.trim().is_empty()) { continue; }
        let mut matches = Vec::new();
        for (name, value) in &asset.attributes {
            if excluded(name) || value.len() > 1024 || value.starts_with("data:") || value.starts_with("http") { continue; }
            if let Some(found) = index.get(&key(value)) { if !matches.contains(found) { matches.push(found.clone()); } }
        }
        if !matches.is_empty() { asset.attributes.insert("Finish".into(), matches.join(" / ")); }
    }
    Ok(())
}
