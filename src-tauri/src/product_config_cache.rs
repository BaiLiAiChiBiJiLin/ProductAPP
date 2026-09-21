//! Derive the finish catalog without building/cloning the large JSON object tree.
use serde_json::value::RawValue;
use std::{fs, io::{BufWriter, Write}, path::Path};

fn collect<'a>(raw: &'a RawValue, matches: &mut Vec<&'a RawValue>) -> serde_json::Result<()> {
    match raw.get().as_bytes().first() {
        Some(b'{') => {
            // A custom map visitor retains source order, unlike a sorted JSON map.
            struct Entries;
            impl<'de> serde::de::Visitor<'de> for Entries {
                type Value = Vec<(String, &'de RawValue)>;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("an object") }
                fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                    let mut entries = Vec::new();
                    while let Some(entry) = map.next_entry()? { entries.push(entry); }
                    Ok(entries)
                }
            }
            let mut deserializer = serde_json::Deserializer::from_str(raw.get());
            let entries = serde::Deserializer::deserialize_map(&mut deserializer, Entries)?;
            if entries.iter().any(|(key, _)| key == "preview3D") { matches.push(raw); }
            for (_, child) in entries { collect(child, matches)?; }
        }
        Some(b'[') => {
            for child in serde_json::from_str::<Vec<&RawValue>>(raw.get())? { collect(child, matches)?; }
        }
        _ => {}
    }
    Ok(())
}

pub fn refresh(path: &Path, bytes: &[u8]) -> Result<usize, String> {
    let raw: &RawValue = serde_json::from_slice(bytes).map_err(|e| format!("产品选项 JSON 无效：{e}"))?;
    let mut matches = Vec::new();
    collect(raw, &mut matches).map_err(|e| format!("工艺数据提取失败：{e}"))?;
    let parent = path.parent().ok_or("产品选项缓存目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let product_temp = path.with_extension("json.tmp");
    let finish_path = parent.join("finish.json");
    let finish_temp = parent.join("finish.json.tmp");
    let result = (|| -> std::io::Result<()> {
        fs::write(&product_temp, bytes)?;
        let mut output = BufWriter::new(fs::File::create(&finish_temp)?);
        output.write_all(b"[\n")?;
        for (index, item) in matches.iter().enumerate() {
            if index > 0 { output.write_all(b",\n")?; }
            output.write_all(item.get().as_bytes())?;
        }
        output.write_all(b"\n]\n")?;
        output.flush()?;
        output.get_ref().sync_all()?;
        drop(output);
        // Stage both complete files first; readers never see a partial catalog.
        fs::rename(&finish_temp, &finish_path)?;
        fs::rename(&product_temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(product_temp);
        let _ = fs::remove_file(finish_temp);
    }
    result.map_err(|e| format!("产品配置/工艺缓存写入失败：{e}"))?;
    Ok(matches.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "uses the local product-configs.json fixture"]
    fn real_catalog_matches_recursive_reference() {
        fn reference(value: &serde_json::Value, output: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    if map.contains_key("preview3D") { output.push(value.to_string()); }
                    for child in map.values() { reference(child, output); }
                }
                serde_json::Value::Array(items) => for child in items { reference(child, output); },
                _ => {}
            }
        }
        let bytes = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../printflow-data/cache/product-configs.json")).unwrap();
        let raw: &RawValue = serde_json::from_slice(&bytes).unwrap();
        let mut matches = Vec::new();
        collect(raw, &mut matches).unwrap();
        let mut actual: Vec<String> = matches.iter().map(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).unwrap().to_string()).collect();
        let mut expected = Vec::new();
        reference(&serde_json::from_slice(&bytes).unwrap(), &mut expected);
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
        println!("real catalog: {} bytes, {} preview3D objects", bytes.len(), actual.len());
    }

    #[test]
    fn extracts_whole_objects_in_source_order_including_nested_null_and_false() {
        let raw: &RawValue = serde_json::from_str(r#"{"z":{"name":"中文","preview3D":null,"child":{"preview3D":false}},"a":[{"preview3D":{}},"preview3D",{}]}"#).unwrap();
        let mut matches = Vec::new();
        collect(raw, &mut matches).unwrap();
        let values: Vec<serde_json::Value> = matches.iter().map(|v| serde_json::from_str(v.get()).unwrap()).collect();
        assert_eq!(values.len(), 3);
        assert_eq!(values[0]["name"], "中文");
        assert_eq!(values[0]["child"], values[1]);
        assert_eq!(values[1]["preview3D"], false);
        assert_eq!(values[2]["preview3D"], serde_json::json!({}));
    }

    #[test]
    fn refresh_replaces_both_caches_and_invalid_json_preserves_them() {
        let dir = std::env::temp_dir().join(format!("printflow-config-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("product-configs.json");
        let input = br#"[{"preview3D":null,"name":"new"}]"#;
        assert_eq!(refresh(&path, input).unwrap(), 1);
        assert_eq!(fs::read(&path).unwrap(), input);
        let finish = fs::read(dir.join("finish.json")).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&finish).unwrap(), serde_json::json!([{"preview3D":null,"name":"new"}]));
        assert!(refresh(&path, b"{broken").is_err());
        assert_eq!(fs::read(&path).unwrap(), input);
        assert_eq!(fs::read(dir.join("finish.json")).unwrap(), finish);
        assert_eq!(refresh(&path, b"{}").unwrap(), 0);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(dir.join("finish.json")).unwrap()).unwrap(), serde_json::json!([]));
        fs::remove_dir_all(dir).unwrap();
    }
}
