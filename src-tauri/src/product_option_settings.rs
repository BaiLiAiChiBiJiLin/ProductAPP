//! Editable local product definitions. Kept separate from the remote production cache.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, path::Path, sync::Mutex};

static LOCK: Mutex<()> = Mutex::new(());
const FILES: [(&str, &str); 6] = [
    (
        "product-options.clean.json",
        include_str!("../../src/modules/settings/product-options/data/product-options.clean.json"),
    ),
    (
        "print-options.json",
        include_str!("../../src/modules/settings/product-options/data/print-options.json"),
    ),
    (
        "techniques.json",
        include_str!("../../src/modules/settings/product-options/data/techniques.json"),
    ),
    (
        "holo-films.json",
        include_str!("../../src/modules/settings/product-options/data/holo-films.json"),
    ),
    (
        "materials.json",
        include_str!("../../src/modules/settings/product-options/data/materials.json"),
    ),
    (
        "accessory-styles.json",
        include_str!("../../src/modules/settings/product-options/data/accessory-styles.json"),
    ),
];
const DEFINITIONS: [(&str, &str, &str); 5] = [
    ("print-options.json", "Print Option", "Y"),
    ("techniques.json", "Technique", "G"),
    ("holo-films.json", "Holo Film", "M"),
    ("materials.json", "Material", "C"),
    ("accessory-styles.json", "Accessories Style", "P"),
];

#[derive(Clone, Serialize, Deserialize)]
pub struct Bundle {
    main: Value,
    catalogs: Value,
}
#[derive(Serialize)]
pub struct Snapshot {
    bundle: Bundle,
    version: String,
    directory: String,
}
fn error(e: impl std::fmt::Display) -> String {
    format!("产品配置：{e}")
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value[key]
        .as_array()
        .ok_or_else(|| error(format!("{key} 必须是数组")))
}
fn string(value: &Value, key: &str) -> Result<(), String> {
    value[key]
        .as_str()
        .map(|_| ())
        .ok_or_else(|| error(format!("{key} 必须是文字")))
}
fn value_ids(
    values: &[Value],
    prefix: &str,
    ids: &mut HashSet<String>,
    colors: bool,
) -> Result<(u64, u64), String> {
    let (mut max, mut color_max) = (0, 0);
    for value in values {
        let id = value["id"].as_str().ok_or_else(|| error("缺少选项 ID"))?;
        let number = id
            .strip_prefix(prefix)
            .and_then(|n| {
                if n.starts_with('0') {
                    None
                } else {
                    n.parse::<u64>().ok()
                }
            })
            .filter(|n| *n > 0)
            .ok_or_else(|| error("选项 ID 格式错误"))?;
        if !ids.insert(id.to_owned()) {
            return Err(error("选项 ID 重复"));
        }
        max = max.max(number);
        string(value, "name")?;
        for key in ["labelZh", "image"] {
            if value.get(key).is_some() {
                string(value, key)?;
            }
        }
        if value["name"].as_str().unwrap().trim().is_empty()
            || value["sortOrder"].as_u64().filter(|n| *n > 0).is_none()
        {
            return Err(error("名称或序号无效"));
        }
        if value.get("isDefault").is_some_and(|v| !v.is_boolean()) {
            return Err(error("默认开关必须是布尔值"));
        }
        for key in [
            "deleted",
            "hidden",
            "isHidden",
            "isDeleted",
            "showInEditor",
            "editorVisible",
            "linkedParent",
            "parentValues",
        ] {
            if value.get(key).is_some() {
                return Err(error("公共选项值不能保存产品开关或旧关联字段"));
            }
        }
        if let Some(children) = value.get("colors") {
            if !colors {
                return Err(error("仅配件样式可包含颜色"));
            }
            let (n, _) = value_ids(
                children.as_array().ok_or_else(|| error("颜色必须是数组"))?,
                "P-C",
                ids,
                false,
            )?;
            color_max = color_max.max(n);
        }
    }
    Ok((max, color_max))
}
fn validate(bundle: &Bundle) -> Result<(), String> {
    let categories = array(&bundle.main, "categories")?;
    let mut products = array(&bundle.main, "uncategorizedProducts")?
        .iter()
        .collect::<Vec<_>>();
    let mut names = HashSet::new();
    for category in categories {
        string(category, "name")?;
        string(category, "title")?;
        string(category, "titleZh")?;
        let name = category["name"].as_str().unwrap();
        if name.is_empty() || !names.insert(name) {
            return Err(error("类别标识为空或重复"));
        }
        products.extend(array(category, "products")?);
    }
    for (file, name, prefix) in DEFINITIONS {
        let catalog = &bundle.catalogs[file];
        if catalog["name"] != name {
            return Err(error(format!("公共选项 {file} 名称不匹配")));
        }
        string(catalog, "labelZh")?;
        for key in ["label", "defaultValue"] {
            if catalog.get(key).is_some() {
                string(catalog, key)?;
            }
        }
        let mut ids = HashSet::new();
        let (max, color_max) =
            value_ids(array(catalog, "values")?, prefix, &mut ids, prefix == "P")?;
        if catalog["nextId"].as_u64().filter(|n| *n > max).is_none()
            || (prefix == "P"
                && catalog["nextColorId"]
                    .as_u64()
                    .filter(|n| *n > color_max)
                    .is_none())
        {
            return Err(error("ID 计数器必须大于已有 ID"));
        }
        for product in &products {
            string(product, "title")?;
            string(product, "titleZh")?;
            if product["title"].as_str().unwrap().trim().is_empty() {
                return Err(error("产品名称不能为空"));
            }
            let options = array(product, "productOptions")?;
            let matches = options
                .iter()
                .filter(|option| option["name"] == name)
                .collect::<Vec<_>>();
            if options.len() < 5 || matches.len() != 1 {
                return Err(error("产品必须包含五类公共选项开关"));
            }
            let option = matches[0];
            if !option["deleted"].is_boolean()
                || option
                    .as_object()
                    .unwrap()
                    .keys()
                    .any(|key| !["name", "deleted", "disabledValues"].contains(&key.as_str()))
            {
                return Err(error("产品选项仅允许名称、开关和禁用值 ID"));
            }
            if let Some(disabled) = option.get("disabledValues") {
                for id in disabled
                    .as_array()
                    .ok_or_else(|| error("禁用 ID 必须是数组"))?
                {
                    if !id.as_str().is_some_and(|id| ids.contains(id)) {
                        return Err(error("禁用 ID 未在公共选项中找到"));
                    }
                }
            }
        }
    }
    for product in products {
        let mut names = HashSet::new();
        for option in array(product, "productOptions")? {
            let name = option["name"]
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .ok_or_else(|| error("选项名称为空"))?;
            if !names.insert(name) {
                return Err(error("产品选项名称重复"));
            }
            if !DEFINITIONS.iter().any(|(_, known, _)| *known == name) {
                string(option, "labelZh")?;
                if !option["deleted"].is_boolean() {
                    return Err(error("自定义选项缺少开关"));
                }
                let mut ids = HashSet::new();
                let (max, _) = value_ids(array(option, "values")?, "X", &mut ids, false)?;
                if option["nextId"].as_u64().filter(|n| *n > max).is_none() {
                    return Err(error("自定义选项计数器无效"));
                }
                if let Some(disabled) = option.get("disabledValues") {
                    if disabled
                        .as_array()
                        .ok_or_else(|| error("禁用 ID 必须是数组"))?
                        .iter()
                        .any(|id| !id.as_str().is_some_and(|id| ids.contains(id)))
                    {
                        return Err(error("自定义选项禁用 ID 无效"));
                    }
                }
            }
        }
    }
    Ok(())
}
fn read(root: &Path) -> Result<Snapshot, String> {
    fs::create_dir_all(root).map_err(error)?;
    let mut catalogs = serde_json::Map::new();
    let mut main = Value::Null;
    let mut hash = Sha256::new();
    for (index, (name, seed)) in FILES.iter().enumerate() {
        let path = root.join(name);
        if !path.exists() {
            fs::write(&path, seed).map_err(error)?;
        }
        let bytes = fs::read(&path).map_err(error)?;
        hash.update(name.as_bytes());
        hash.update(&bytes);
        let value: Value = serde_json::from_slice(&bytes).map_err(error)?;
        if index == 0 {
            main = value;
        } else {
            catalogs.insert((*name).to_owned(), value);
        }
    }
    let bundle = Bundle {
        main,
        catalogs: Value::Object(catalogs),
    };
    validate(&bundle)?;
    Ok(Snapshot {
        bundle,
        version: format!("{:x}", hash.finalize()),
        directory: root.to_string_lossy().into_owned(),
    })
}
fn save(root: &Path, bundle: Bundle, expected: &str) -> Result<Snapshot, String> {
    validate(&bundle)?;
    if serde_json::to_vec(&bundle).map_err(error)?.len() > 16 * 1024 * 1024 {
        return Err(error("配置超过 16MB"));
    }
    let current = read(root)?;
    if current.version != expected {
        return Err(error(
            "配置文件已被其他窗口修改，请保留需要的修改内容，刷新后重新编辑并保存",
        ));
    }
    // Stage all files before replacing any; roll back every replaced file on failure.
    let mut originals = Vec::new();
    for (index, (name, _)) in FILES.iter().enumerate() {
        let data = if index == 0 {
            &bundle.main
        } else {
            &bundle.catalogs[*name]
        };
        originals.push(fs::read(root.join(name)).map_err(error)?);
        let mut bytes = serde_json::to_vec_pretty(data).map_err(error)?;
        bytes.push(b'\n');
        fs::write(root.join(format!("{name}.pending")), bytes).map_err(error)?;
    }
    for (index, (name, _)) in FILES.iter().enumerate() {
        if let Err(failure) = fs::rename(root.join(format!("{name}.pending")), root.join(name)) {
            let mut rollback_failed = Vec::new();
            for prior in 0..index {
                if let Err(e) = fs::write(root.join(FILES[prior].0), &originals[prior]) {
                    rollback_failed.push(e.to_string());
                }
            }
            return Err(error(format!(
                "保存失败：{failure}；回滚结果：{}",
                if rollback_failed.is_empty() {
                    "已恢复原配置".into()
                } else {
                    rollback_failed.join("；")
                }
            )));
        }
    }
    read(root)
}
#[tauri::command]
pub async fn load_product_option_settings() -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = LOCK.lock().map_err(error)?;
        read(&crate::project_data_dir().join("settings/product-options"))
    })
    .await
    .map_err(error)?
}
#[tauri::command]
pub async fn save_product_option_settings(
    bundle: Bundle,
    expected_version: String,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(error)?;
        save(
            &crate::project_data_dir().join("settings/product-options"),
            bundle,
            &expected_version,
        )
    })
    .await
    .map_err(error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn roundtrip_conflict_and_invalid_data() {
        let root = std::env::temp_dir().join(format!(
            "printflow-options-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let first = read(&root).unwrap();
        assert_eq!(
            first.bundle.catalogs["accessory-styles.json"]["values"]
                .as_array()
                .unwrap()
                .len(),
            27
        );
        let mut edited = first.bundle.clone();
        edited.main["categories"][0]["products"][0]["titleZh"] = json!("测试贴纸");
        let saved = save(&root, edited.clone(), &first.version).unwrap();
        assert_ne!(saved.version, first.version);
        assert_eq!(read(&root).unwrap().bundle.main, edited.main);
        assert!(save(&root, first.bundle, &first.version).is_err());
        edited.catalogs["print-options.json"]["values"][0]["deleted"] = json!(true);
        assert!(save(&root, edited, &saved.version).is_err());
        assert_eq!(read(&root).unwrap().version, saved.version);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn locked_file_rolls_back_previously_replaced_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!(
            "printflow-options-rollback-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let original = read(&root).unwrap();
        let mut edited = original.bundle.clone();
        edited.main["categories"][0]["products"][0]["titleZh"] = json!("不会留下的修改");
        // Permit reads/writes, but disallow replacement of the second file.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(root.join("print-options.json"))
            .unwrap();
        let failure = save(&root, edited, &original.version).err().unwrap();
        assert!(failure.contains("已恢复原配置"), "{failure}");
        drop(held);
        assert_eq!(read(&root).unwrap().version, original.version);
        fs::remove_dir_all(root).unwrap();
    }
}
