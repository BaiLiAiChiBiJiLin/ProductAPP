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
    let mut product_ids = HashSet::new();
    let mut max_product_id = 0;
    for product in &products {
        let id = product["id"].as_str().ok_or_else(|| error("缺少产品 ID"))?;
        let number = product_number(id).ok_or_else(|| error("产品 ID 格式错误"))?;
        if !product_ids.insert(id) {
            return Err(error("产品 ID 重复"));
        }
        max_product_id = max_product_id.max(number);
    }
    if bundle.main["nextProductId"]
        .as_u64()
        .filter(|n| *n > max_product_id)
        .is_none()
    {
        return Err(error("产品 ID 计数器无效"));
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
        validate_rules(bundle, product)?;
    }
    Ok(())
}
fn product_number(id: &str) -> Option<u64> {
    let number = id.strip_prefix('P')?;
    if number.is_empty() || number.starts_with('0') || !number.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    number
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n < 9_007_199_254_740_991)
}
fn migrate_product_ids(main: &mut Value) -> Result<bool, String> {
    let mut used = HashSet::new();
    let mut next = main["nextProductId"].as_u64().unwrap_or(1).max(1);
    let products = array(main, "categories")?
        .iter()
        .map(|c| array(c, "products"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .chain(array(main, "uncategorizedProducts")?);
    for product in products {
        if let Some(id) = product.get("id") {
            let id = id.as_str().ok_or_else(|| error("产品 ID 格式错误"))?;
            let number = product_number(id).ok_or_else(|| error("产品 ID 格式错误"))?;
            if !used.insert(id.to_owned()) {
                return Err(error("产品 ID 重复"));
            }
            next = next.max(number + 1);
        }
    }
    let mut changed = false;
    let mut lists: Vec<&mut Value> = main["categories"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .map(|c| &mut c["products"])
        .collect();
    // The uncategorized list is handled separately to avoid borrowing main twice.
    for list in &mut lists {
        for product in list.as_array_mut().unwrap() {
            if product.get("id").is_none() {
                product["id"] = Value::String(format!("P{next}"));
                next += 1;
                changed = true;
            }
        }
    }
    for product in main["uncategorizedProducts"].as_array_mut().unwrap() {
        if product.get("id").is_none() {
            product["id"] = Value::String(format!("P{next}"));
            next += 1;
            changed = true;
        }
    }
    if main["nextProductId"].as_u64() != Some(next) {
        main["nextProductId"] = Value::from(next);
        changed = true;
    }
    Ok(changed)
}
fn validate_rules(bundle: &Bundle, product: &Value) -> Result<(), String> {
    let Some(rules) = product.get("optionRules") else {
        return Ok(());
    };
    let exists = |name: &str, id: &str| -> bool {
        let Some(option) = product["productOptions"]
            .as_array()
            .and_then(|options| options.iter().find(|option| option["name"] == name))
        else {
            return false;
        };
        let catalog = DEFINITIONS
            .iter()
            .find(|(_, known, _)| *known == name)
            .map(|(file, _, _)| &bundle.catalogs[*file])
            .unwrap_or(option);
        catalog["values"].as_array().is_some_and(|values| {
            values.iter().any(|value| {
                value["id"] == id
                    || value["colors"]
                        .as_array()
                        .is_some_and(|colors| colors.iter().any(|color| color["id"] == id))
            })
        })
    };
    let mut sources = HashSet::new();
    for rule in rules
        .as_array()
        .ok_or_else(|| error("联动规则必须是数组"))?
    {
        let name = rule["when"]["option"]
            .as_str()
            .ok_or_else(|| error("联动触发属性无效"))?;
        let id = rule["when"]["valueId"]
            .as_str()
            .ok_or_else(|| error("联动触发值无效"))?;
        if !exists(name, id) || !sources.insert((name, id)) {
            return Err(error("联动触发值不存在或重复"));
        }
        let groups = array(rule, "hide")?;
        if groups.is_empty() {
            return Err(error("联动隐藏目标不能为空"));
        }
        let mut targets = HashSet::new();
        for group in groups {
            let target = group["option"]
                .as_str()
                .ok_or_else(|| error("联动目标属性无效"))?;
            let ids = array(group, "valueIds")?;
            let mut unique = HashSet::new();
            if target == name
                || !targets.insert(target)
                || ids.is_empty()
                || ids.iter().any(|id| {
                    !id.as_str()
                        .is_some_and(|id| exists(target, id) && unique.insert(id))
                })
            {
                return Err(error("联动隐藏选项无效或重复"));
            }
        }
    }
    Ok(())
}
fn read(root: &Path) -> Result<Snapshot, String> {
    fs::create_dir_all(root).map_err(error)?;
    let mut catalogs = serde_json::Map::new();
    let mut main = Value::Null;
    let mut originals = Vec::new();
    for (index, (name, seed)) in FILES.iter().enumerate() {
        let path = root.join(name);
        if !path.exists() {
            fs::write(&path, seed).map_err(error)?;
        }
        let bytes = fs::read(&path).map_err(error)?;
        originals.push(bytes.clone());
        let value: Value = serde_json::from_slice(&bytes).map_err(error)?;
        if index == 0 {
            main = value;
        } else {
            catalogs.insert((*name).to_owned(), value);
        }
    }
    let migrated = migrate_product_ids(&mut main)?;
    let bundle = Bundle {
        main,
        catalogs: Value::Object(catalogs),
    };
    validate(&bundle)?;
    if migrated {
        let backup = root.join("product-options.clean.json.before-product-ids.bak");
        if !backup.exists() {
            fs::write(&backup, &originals[0]).map_err(error)?;
        }
        let mut bytes = serde_json::to_vec_pretty(&bundle.main).map_err(error)?;
        bytes.push(b'\n');
        let pending = root.join("product-options.clean.json.pending");
        fs::write(&pending, &bytes).map_err(error)?;
        fs::rename(&pending, root.join(FILES[0].0)).map_err(error)?;
        originals[0] = bytes;
    }
    let mut hash = Sha256::new();
    for ((name, _), bytes) in FILES.iter().zip(originals) {
        hash.update(name.as_bytes());
        hash.update(bytes);
    }
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
    fn legacy_ids_migrate_once_and_rules_roundtrip() {
        let root = std::env::temp_dir().join(format!(
            "printflow-rules-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let original = read(&root).unwrap();
        let mut legacy = original.bundle.main.clone();
        legacy.as_object_mut().unwrap().remove("nextProductId");
        for category in legacy["categories"].as_array_mut().unwrap() {
            for product in category["products"].as_array_mut().unwrap() {
                product.as_object_mut().unwrap().remove("id");
            }
        }
        for product in legacy["uncategorizedProducts"].as_array_mut().unwrap() {
            product.as_object_mut().unwrap().remove("id");
        }
        fs::write(root.join(FILES[0].0), serde_json::to_vec(&legacy).unwrap()).unwrap();
        let migrated = read(&root).unwrap();
        assert_eq!(
            migrated.bundle.main["categories"][0]["products"][0]["id"],
            "P1"
        );
        assert_eq!(migrated.bundle.main["nextProductId"], 66);
        assert_eq!(migrated.version, read(&root).unwrap().version);
        assert!(root
            .join("product-options.clean.json.before-product-ids.bak")
            .exists());
        let mut edited = migrated.bundle.clone();
        edited.main["categories"][0]["products"][0]["optionRules"] = json!([{"when":{"option":"Technique","valueId":"G2"},"hide":[{"option":"Holo Film","valueIds":["M1","M2"]}]}]);
        let saved = save(&root, edited.clone(), &migrated.version).unwrap();
        assert_eq!(read(&root).unwrap().bundle.main, edited.main);
        edited.main["categories"][0]["products"][0]["optionRules"][0]["hide"][0]["valueIds"] =
            json!(["M999"]);
        assert!(save(&root, edited, &saved.version).is_err());
        let mut invalid = saved.bundle;
        invalid.main["categories"][0]["products"][1]["id"] = json!("P1");
        assert!(validate(&invalid).is_err());
        fs::remove_dir_all(root).unwrap();
    }
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
