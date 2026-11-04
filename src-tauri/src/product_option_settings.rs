//! Editable local product definitions. Kept separate from the remote production cache.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::Path,
    sync::Mutex,
};

static LOCK: Mutex<()> = Mutex::new(());
pub(crate) const FILES: [(&str, &str); 10] = [
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
    (
        "standee-quantities.json",
        include_str!("../../src/modules/settings/product-options/data/standee-quantities.json"),
    ),
    (
        "sizes.json",
        include_str!("../../src/modules/settings/product-options/data/sizes.json"),
    ),
    (
        "tinplate-sticker-films.json",
        include_str!("../../src/modules/settings/product-options/data/tinplate-sticker-films.json"),
    ),
    (
        "tinplate-materials.json",
        include_str!("../../src/modules/settings/product-options/data/tinplate-materials.json"),
    ),
];
const SIZE_MIGRATION: &str =
    include_str!("../../src/modules/settings/product-options/data/size-migration.json");
const DEFINITIONS: [(&str, &str, &str, &str); 9] = [
    ("sizes.json", "Size", "sizeBandId", "S"),
    ("print-options.json", "Print Option", "printOptionId", "Y"),
    ("techniques.json", "Technique", "techniqueId", "G"),
    ("holo-films.json", "Holo Film", "holoFilmId", "M"),
    (
        "tinplate-sticker-films.json",
        "Tinplate Sticker Film",
        "tinplateStickerFilmId",
        "TF",
    ),
    ("materials.json", "Material", "materialId", "C"),
    (
        "tinplate-materials.json",
        "Tinplate Material",
        "tinplateMaterialId",
        "TM",
    ),
    (
        "accessory-styles.json",
        "Accessories Style",
        "accessoryStyleId",
        "P",
    ),
    (
        "standee-quantities.json",
        "Standee Quantity",
        "standeeQuantityId",
        "SQ",
    ),
];
const OPTION_ID_KEYS: [&str; 11] = [
    "sizeBandId",
    "printOptionId",
    "techniqueId",
    "holoFilmId",
    "materialId",
    "accessoryStyleId",
    "accessoryColorId",
    "customOptionValueId",
    "standeeQuantityId",
    "tinplateStickerFilmId",
    "tinplateMaterialId",
];
const ADDITIONAL_ATTRIBUTES: [(&str, &str); 2] = [
    ("tinplate-sticker-films.json", "Tinplate Sticker Film"),
    ("tinplate-materials.json", "Tinplate Material"),
];
fn may_be_missing_legacy_catalog(name: &str) -> bool {
    ["standee-quantities.json", "sizes.json"].contains(&name)
        || ADDITIONAL_ATTRIBUTES.iter().any(|(file, _)| *file == name)
}
type EntityId = (String, String);

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
fn entity_id<'a>(value: &'a Value, expected_key: &str) -> Result<&'a str, String> {
    if value.get("id").is_some()
        || OPTION_ID_KEYS
            .iter()
            .chain(std::iter::once(&"productId"))
            .any(|key| *key != expected_key && value.get(*key).is_some())
    {
        return Err(error(
            "实体必须只使用其明确的 ID 字段，不能使用通用 id 或混用实体",
        ));
    }
    value[expected_key]
        .as_str()
        .ok_or_else(|| error(format!("缺少或无效的 {expected_key}")))
}
fn reference(value: &Value) -> Result<EntityId, String> {
    let object = value
        .as_object()
        .filter(|object| object.len() == 1)
        .ok_or_else(|| error("选项引用必须是仅含一个实体 ID 字段的对象"))?;
    let (key, id) = object.iter().next().unwrap();
    if !OPTION_ID_KEYS.contains(&key.as_str()) {
        return Err(error("选项引用的实体 ID 字段无效"));
    }
    Ok((
        key.clone(),
        id.as_str()
            .ok_or_else(|| error("引用 ID 必须是文字"))?
            .to_owned(),
    ))
}
fn id_number(id: &str, prefix: &str) -> Option<u64> {
    let number = id.strip_prefix(prefix)?;
    if number.is_empty() || number.starts_with('0') || !number.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    number
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n < 9_007_199_254_740_991)
}
fn value_ids(
    values: &[Value],
    id_key: &str,
    prefix: &str,
    ids: &mut HashSet<EntityId>,
    colors: bool,
) -> Result<(u64, u64), String> {
    let (mut max, mut color_max) = (0, 0);
    let mut piece_counts = HashSet::new();
    for value in values {
        let id = entity_id(value, id_key)?;
        let number = if id_key == "sizeBandId" {
            if id.is_empty() || id.trim() != id {
                return Err(error("尺寸 ID 格式错误"));
            }
            id_number(id, prefix).unwrap_or(0)
        } else {
            id_number(id, prefix).ok_or_else(|| error("选项 ID 格式错误"))?
        };
        if !ids.insert((id_key.to_owned(), id.to_owned())) {
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
        if id_key == "standeeQuantityId" {
            let count = value["pieceCount"]
                .as_u64()
                .filter(|count| (1..=4).contains(count))
                .ok_or_else(|| error("主体片数必须是 1 到 4 的整数"))?;
            if !piece_counts.insert(count) {
                return Err(error("主体片数不能重复"));
            }
        } else if value.get("pieceCount").is_some() {
            return Err(error("只有主体片数选项可保存 pieceCount"));
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
                "accessoryColorId",
                "P-C",
                ids,
                false,
            )?;
            color_max = color_max.max(n);
        }
    }
    Ok((max, color_max))
}
fn validate_default(catalog: &Value, id_key: &str) -> Result<(), String> {
    if let Some(default) = catalog.get("defaultValue") {
        let (key, id) = reference(default)?;
        if key != id_key
            || !array(catalog, "values")?
                .iter()
                .any(|value| value[id_key].as_str() == Some(id.as_str()))
        {
            return Err(error("默认值必须引用当前选项组中的实体"));
        }
    }
    Ok(())
}
fn validate_disabled(option: &Value, ids: &HashSet<EntityId>) -> Result<(), String> {
    if let Some(disabled) = option.get("disabledValues") {
        let mut unique = HashSet::new();
        for value in disabled
            .as_array()
            .ok_or_else(|| error("禁用值必须是实体引用数组"))?
        {
            let entity = reference(value)?;
            if !ids.contains(&entity) || !unique.insert(entity) {
                return Err(error("禁用值引用不存在、所属实体错误或重复"));
            }
        }
    }
    Ok(())
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
        let id = entity_id(product, "productId")?;
        let number = id_number(id, "P").ok_or_else(|| error("产品 ID 格式错误"))?;
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
    for (file, name, id_key, prefix) in DEFINITIONS {
        let catalog = &bundle.catalogs[file];
        if catalog["name"] != name {
            return Err(error(format!("公共选项 {file} 名称不匹配")));
        }
        string(catalog, "labelZh")?;
        if catalog.get("label").is_some() {
            string(catalog, "label")?;
        }
        let mut ids = HashSet::new();
        let (max, color_max) = value_ids(
            array(catalog, "values")?,
            id_key,
            prefix,
            &mut ids,
            id_key == "accessoryStyleId",
        )?;
        validate_default(catalog, id_key)?;
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
            if options.len() < DEFINITIONS.len() || matches.len() != 1 {
                return Err(error("产品必须包含九类公共选项开关"));
            }
            let option = matches[0];
            if !option["deleted"].is_boolean()
                || option.as_object().unwrap().keys().any(|key| {
                    !["name", "deleted", "disabledValues"].contains(&key.as_str())
                        && !(name == "Standee Quantity" && key == "defaultValue")
                })
            {
                return Err(error("产品选项仅允许名称、开关和禁用实体引用"));
            }
            validate_disabled(option, &ids)?;
            if let Some(default) = option.get("defaultValue") {
                let entity = reference(default)?;
                if entity.0 != id_key || !ids.contains(&entity) {
                    return Err(error("产品主体片数默认值必须引用公共主体片数实体"));
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
            if !DEFINITIONS.iter().any(|(_, known, _, _)| *known == name) {
                string(option, "labelZh")?;
                if !option["deleted"].is_boolean() {
                    return Err(error("自定义选项缺少开关"));
                }
                let mut ids = HashSet::new();
                let (max, _) = value_ids(
                    array(option, "values")?,
                    "customOptionValueId",
                    "X",
                    &mut ids,
                    false,
                )?;
                if option["nextId"].as_u64().filter(|n| *n > max).is_none() {
                    return Err(error("自定义选项计数器无效"));
                }
                validate_default(option, "customOptionValueId")?;
                validate_disabled(option, &ids)?;
            }
        }
    }
    Ok(())
}
/// Retired option links are discarded at load/save boundaries, regardless of their old shape.
pub(crate) fn strip_deprecated_option_rules(main: &mut Value) -> Result<(), String> {
    fn strip(products: &mut Value) -> Result<(), String> {
        for product in products
            .as_array_mut()
            .ok_or_else(|| error("products 必须是数组"))?
        {
            product
                .as_object_mut()
                .ok_or_else(|| error("产品数据必须是对象"))?
                .remove("optionRules");
        }
        Ok(())
    }
    for category in main["categories"]
        .as_array_mut()
        .ok_or_else(|| error("categories 必须是数组"))?
    {
        strip(&mut category["products"])?;
    }
    strip(&mut main["uncategorizedProducts"])
}
/// New attributes start disabled; existing switches and product option order are user data.
pub(crate) fn complete_additional_attribute_options(main: &mut Value) -> Result<bool, String> {
    fn complete(products: &mut Value) -> Result<bool, String> {
        let mut changed = false;
        for product in products
            .as_array_mut()
            .ok_or_else(|| error("products 必须是数组"))?
        {
            let options = product["productOptions"]
                .as_array_mut()
                .ok_or_else(|| error("productOptions 必须是数组"))?;
            for (_, name) in ADDITIONAL_ATTRIBUTES {
                if !options.iter().any(|option| option["name"] == name) {
                    options.push(serde_json::json!({"name":name,"deleted":true}));
                    changed = true;
                }
            }
        }
        Ok(changed)
    }
    let mut changed = false;
    for category in main["categories"]
        .as_array_mut()
        .ok_or_else(|| error("categories 必须是数组"))?
    {
        changed |= complete(&mut category["products"])?;
    }
    changed |= complete(&mut main["uncategorizedProducts"])?;
    Ok(changed)
}
fn upgrade_additional_attributes(bundle: &mut Bundle) -> Result<(), String> {
    let catalogs = bundle
        .catalogs
        .as_object_mut()
        .ok_or_else(|| error("公共选项目录必须是对象"))?;
    for (file, _) in ADDITIONAL_ATTRIBUTES {
        if !catalogs.contains_key(file) {
            let seed = FILES.iter().find(|(name, _)| *name == file).unwrap().1;
            catalogs.insert(file.to_owned(), serde_json::from_str(seed).map_err(error)?);
        }
    }
    complete_additional_attribute_options(&mut bundle.main)?;
    Ok(())
}
/// Older product files have five switches. Fill only the newly introduced one;
/// an existing switch (including an explicit disabled state) is user data.
pub(crate) fn complete_standee_quantity_options(
    main: &mut Value,
    has_default_quantity: bool,
) -> Result<bool, String> {
    fn complete(
        products: &mut Value,
        deleted: bool,
        has_default_quantity: bool,
    ) -> Result<bool, String> {
        let mut changed = false;
        for product in products
            .as_array_mut()
            .ok_or_else(|| error("products 必须是数组"))?
        {
            let options = product["productOptions"]
                .as_array_mut()
                .ok_or_else(|| error("productOptions 必须是数组"))?;
            if !options
                .iter()
                .any(|option| option["name"] == "Standee Quantity")
            {
                let mut option =
                    serde_json::json!({"name": "Standee Quantity", "deleted": deleted});
                if has_default_quantity {
                    option["defaultValue"] = serde_json::json!({"standeeQuantityId": "SQ1"});
                }
                options.push(option);
                changed = true;
            }
        }
        Ok(changed)
    }
    let mut changed = false;
    for category in main["categories"]
        .as_array_mut()
        .ok_or_else(|| error("categories 必须是数组"))?
    {
        let deleted = category["name"] != "standees";
        changed |= complete(&mut category["products"], deleted, has_default_quantity)?;
    }
    changed |= complete(
        &mut main["uncategorizedProducts"],
        true,
        has_default_quantity,
    )?;
    Ok(changed)
}

pub(crate) fn remove_seed_size_options(main: &mut Value) {
    if let Some(categories) = main["categories"].as_array_mut() {
        for category in categories {
            if let Some(products) = category["products"].as_array_mut() {
                for product in products {
                    if let Some(options) = product["productOptions"].as_array_mut() {
                        options.retain(|option| option["name"] != "Size");
                    }
                }
            }
        }
    }
    if let Some(products) = main["uncategorizedProducts"].as_array_mut() {
        for product in products {
            if let Some(options) = product["productOptions"].as_array_mut() {
                options.retain(|option| option["name"] != "Size");
            }
        }
    }
}

pub(crate) fn main_needs_size_upgrade(main: &Value) -> bool {
    main["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|category| category["products"].as_array().into_iter().flatten())
        .chain(
            main["uncategorizedProducts"]
                .as_array()
                .into_iter()
                .flatten(),
        )
        .any(|product| {
            !product["productOptions"]
                .as_array()
                .is_some_and(|options| options.iter().any(|option| option["name"] == "Size"))
        })
}

/// Read only. Size membership is moved out of legacy pricing before that file is upgraded.
pub(crate) fn size_migration_source(options_root: &Path) -> Result<Value, String> {
    let mut manifest: Value = serde_json::from_str(SIZE_MIGRATION).map_err(error)?;
    let path = options_root
        .parent()
        .unwrap_or(options_root)
        .join("product-pricing/product-pricing.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(manifest),
        Err(e) => return Err(error(e)),
    };
    let legacy: Value = serde_json::from_slice(&bytes).map_err(error)?;
    if !matches!(legacy["schemaVersion"].as_u64(), Some(1..=3)) {
        return Ok(manifest);
    }
    let bands = array(&legacy, "sizeBands")?;
    let mut ids = HashSet::new();
    for band in bands {
        let id = entity_id(band, "sizeBandId")?;
        if id.is_empty() || id.trim() != id || !ids.insert(id) {
            return Err(error("旧定价尺寸 ID 无效或重复"));
        }
        string(band, "label")?;
    }
    let target_bands = manifest["sizeBands"]
        .as_array_mut()
        .ok_or_else(|| error("尺寸迁移清单无效"))?;
    for band in bands {
        if let Some(existing) = target_bands
            .iter_mut()
            .find(|existing| existing["sizeBandId"] == band["sizeBandId"])
        {
            *existing = band.clone();
        } else {
            target_bands.push(band.clone());
        }
    }
    let target_products = manifest["products"]
        .as_array_mut()
        .ok_or_else(|| error("尺寸迁移清单无效"))?;
    for product in array(&legacy, "products")? {
        let selected = if legacy["schemaVersion"] == 1 {
            Value::Array(
                bands
                    .iter()
                    .map(|band| band["sizeBandId"].clone())
                    .collect(),
            )
        } else {
            Value::Array(array(product, "sizeBandIds")?.clone())
        };
        let item = serde_json::json!({"productId":product["productId"],"sizeBandIds":selected});
        if let Some(existing) = target_products
            .iter_mut()
            .find(|existing| existing["productId"] == item["productId"])
        {
            *existing = item;
        } else {
            target_products.push(item);
        }
    }
    Ok(manifest)
}

pub(crate) fn complete_size_options(
    main: &mut Value,
    catalog: &mut Value,
    source: &Value,
    catalog_missing: bool,
) -> Result<bool, String> {
    let bands = array(source, "sizeBands")?;
    if catalog_missing {
        let mut values = Vec::new();
        let mut max_id = 0;
        for (index, band) in bands.iter().enumerate() {
            let id = entity_id(band, "sizeBandId")?;
            max_id = max_id.max(id_number(id, "S").unwrap_or(0));
            values.push(serde_json::json!({"sizeBandId":id,"name":band["label"],"labelZh":band["label"],"sortOrder":index+1,"isDefault":false}));
        }
        *catalog = serde_json::json!({"name":"Size","label":"Size","labelZh":"尺寸","nextId":max_id+1,"values":values});
    }
    let ids: Vec<String> = array(catalog, "values")?
        .iter()
        .map(|value| entity_id(value, "sizeBandId").map(str::to_owned))
        .collect::<Result<_, _>>()?;
    let mapping: HashMap<&str, &Vec<Value>> = array(source, "products")?
        .iter()
        .map(|product| {
            Ok((
                product["productId"]
                    .as_str()
                    .ok_or_else(|| error("尺寸迁移产品 ID 无效"))?,
                array(product, "sizeBandIds")?,
            ))
        })
        .collect::<Result<_, String>>()?;
    fn complete(
        products: &mut Value,
        ids: &[String],
        mapping: &HashMap<&str, &Vec<Value>>,
    ) -> Result<bool, String> {
        let mut changed = false;
        for product in products
            .as_array_mut()
            .ok_or_else(|| error("products 必须是数组"))?
        {
            let allowed = mapping.get(product["productId"].as_str().unwrap_or(""));
            let options = product["productOptions"]
                .as_array_mut()
                .ok_or_else(|| error("productOptions 必须是数组"))?;
            if options.iter().any(|option| option["name"] == "Size") {
                continue;
            }
            let selected: HashSet<&str> = allowed
                .into_iter()
                .flat_map(|values| values.iter())
                .filter_map(Value::as_str)
                .collect();
            let disabled: Vec<_> = ids
                .iter()
                .filter(|id| !selected.contains(id.as_str()))
                .map(|id| serde_json::json!({"sizeBandId":id}))
                .collect();
            options.insert(0, serde_json::json!({"name":"Size","deleted":selected.is_empty(),"disabledValues":disabled}));
            changed = true;
        }
        Ok(changed)
    }
    let mut changed = catalog_missing;
    for category in main["categories"]
        .as_array_mut()
        .ok_or_else(|| error("categories 必须是数组"))?
    {
        changed |= complete(&mut category["products"], &ids, &mapping)?;
    }
    changed |= complete(&mut main["uncategorizedProducts"], &ids, &mapping)?;
    Ok(changed)
}

fn backup_before_size_upgrade(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let main: Value = serde_json::from_slice(bytes).map_err(error)?;
    if !main_needs_size_upgrade(&main) {
        return Ok(());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = root.join(format!(
        "product-options.clean.before-sizes-{digest}.json.bak"
    ));
    if path.exists() {
        return if fs::read(path).map_err(error)? == bytes {
            Ok(())
        } else {
            Err(error("尺寸升级备份内容不符，未覆盖原配置"))
        };
    }
    let mut pending = tempfile::NamedTempFile::new_in(root).map_err(error)?;
    pending.write_all(bytes).map_err(error)?;
    pending.flush().map_err(error)?;
    pending.as_file().sync_all().map_err(error)?;
    match pending.persist_noclobber(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if fs::read(path).map_err(error)? == bytes {
                Ok(())
            } else {
                Err(error("尺寸升级备份内容不符，未覆盖原配置"))
            }
        }
        Err(e) => Err(error(e.error)),
    }
}

/// Called before saving schema 4 pricing so its removed size metadata is already durable.
pub(crate) fn persist_missing_size_options(options_root: &Path) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(error)?;
    let main_path = options_root.join("product-options.clean.json");
    let needs_main = match fs::read(&main_path) {
        Ok(bytes) => {
            main_needs_size_upgrade(&serde_json::from_slice::<Value>(&bytes).map_err(error)?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(error(e)),
    };
    if !needs_main && options_root.join("sizes.json").exists() {
        return Ok(());
    }
    let current = read(options_root)?;
    save(options_root, current.bundle, &current.version)?;
    Ok(())
}

fn read(root: &Path) -> Result<Snapshot, String> {
    fs::create_dir_all(root).map_err(error)?;
    let mut catalogs = serde_json::Map::new();
    let mut main = Value::Null;
    let mut originals = Vec::new();
    for (index, (name, seed)) in FILES.iter().enumerate() {
        let path = root.join(name);
        if !path.exists() && !may_be_missing_legacy_catalog(name) {
            if index == 0 {
                let mut initial: Value = serde_json::from_str(seed).map_err(error)?;
                remove_seed_size_options(&mut initial);
                fs::write(&path, serde_json::to_vec_pretty(&initial).map_err(error)?)
                    .map_err(error)?;
            } else {
                fs::write(&path, seed).map_err(error)?;
            }
        }
        let (bytes, exists) = match fs::read(&path) {
            Ok(bytes) => (bytes, true),
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && may_be_missing_legacy_catalog(name) =>
            {
                (seed.as_bytes().to_vec(), false)
            }
            Err(e) => return Err(error(e)),
        };
        originals.push((bytes.clone(), exists));
        let value: Value = serde_json::from_slice(&bytes).map_err(error)?;
        if index == 0 {
            main = value;
        } else {
            catalogs.insert((*name).to_owned(), value);
        }
    }
    strip_deprecated_option_rules(&mut main)?;
    complete_additional_attribute_options(&mut main)?;
    let has_default_quantity = catalogs["standee-quantities.json"]["values"]
        .as_array()
        .is_some_and(|values| {
            values
                .iter()
                .any(|value| value["standeeQuantityId"] == "SQ1")
        });
    complete_standee_quantity_options(&mut main, has_default_quantity)?;
    let needs_sizes = main_needs_size_upgrade(&main);
    let sizes_missing = !root.join("sizes.json").exists();
    let source = if needs_sizes || sizes_missing {
        size_migration_source(root)?
    } else {
        serde_json::from_str(SIZE_MIGRATION).map_err(error)?
    };
    complete_size_options(
        &mut main,
        catalogs.get_mut("sizes.json").unwrap(),
        &source,
        sizes_missing,
    )?;
    let bundle = Bundle {
        main,
        catalogs: Value::Object(catalogs),
    };
    validate(&bundle)?;
    let mut hash = Sha256::new();
    for ((name, _), (bytes, exists)) in FILES.iter().zip(originals) {
        hash.update(name.as_bytes());
        hash.update([u8::from(exists)]);
        hash.update(bytes);
    }
    // Missing Size switches depend on the legacy price source until first saved.
    if needs_sizes || sizes_missing {
        hash.update(serde_json::to_vec(&source).map_err(error)?);
    }
    Ok(Snapshot {
        bundle,
        version: format!("{:x}", hash.finalize()),
        directory: root.to_string_lossy().into_owned(),
    })
}
fn backup_before_standee_upgrade(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut main: Value = serde_json::from_slice(bytes).map_err(error)?;
    if !complete_standee_quantity_options(&mut main, false)? {
        return Ok(());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = root.join(format!(
        "product-options.clean.before-standee-quantities-{digest}.json.bak"
    ));
    if path.exists() {
        if fs::read(&path).map_err(error)? != bytes {
            return Err(error("主体片数升级备份内容不符，未覆盖原配置"));
        }
        return Ok(());
    }
    let mut pending = tempfile::NamedTempFile::new_in(root).map_err(error)?;
    pending.write_all(bytes).map_err(error)?;
    pending.flush().map_err(error)?;
    pending.as_file().sync_all().map_err(error)?;
    match pending.persist_noclobber(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if fs::read(path).map_err(error)? == bytes {
                Ok(())
            } else {
                Err(error("主体片数升级备份内容不符，未覆盖原配置"))
            }
        }
        Err(e) => Err(error(e.error)),
    }
}
fn save(root: &Path, mut bundle: Bundle, expected: &str) -> Result<Snapshot, String> {
    strip_deprecated_option_rules(&mut bundle.main)?;
    upgrade_additional_attributes(&mut bundle)?;
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
        let original = match fs::read(root.join(name)) {
            Ok(bytes) => Some(bytes),
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && may_be_missing_legacy_catalog(name) =>
            {
                None
            }
            Err(e) => return Err(error(e)),
        };
        if index == 0 {
            backup_before_standee_upgrade(root, original.as_deref().unwrap())?;
            backup_before_size_upgrade(root, original.as_deref().unwrap())?;
        }
        originals.push(original);
        let mut bytes = serde_json::to_vec_pretty(data).map_err(error)?;
        bytes.push(b'\n');
        fs::write(root.join(format!("{name}.pending")), bytes).map_err(error)?;
    }
    if read(root)?.version != expected {
        return Err(error(
            "配置文件已被其他窗口修改，请保留需要的修改内容，刷新后重新编辑并保存",
        ));
    }
    for (index, (name, _)) in FILES.iter().enumerate() {
        if let Err(failure) = fs::rename(root.join(format!("{name}.pending")), root.join(name)) {
            let mut rollback_failed = Vec::new();
            for prior in 0..index {
                let restored = match &originals[prior] {
                    Some(bytes) => fs::write(root.join(FILES[prior].0), bytes),
                    None => fs::remove_file(root.join(FILES[prior].0)),
                };
                if let Err(e) = restored {
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
    fn eight_file_bundle() -> Bundle {
        let mut main: Value = serde_json::from_str(FILES[0].1).unwrap();
        for category in main["categories"].as_array_mut().unwrap() {
            for product in category["products"].as_array_mut().unwrap() {
                product["productOptions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|option| {
                        !ADDITIONAL_ATTRIBUTES
                            .iter()
                            .any(|(_, name)| option["name"] == *name)
                    });
            }
        }
        for product in main["uncategorizedProducts"].as_array_mut().unwrap() {
            product["productOptions"]
                .as_array_mut()
                .unwrap()
                .retain(|option| {
                    !ADDITIONAL_ATTRIBUTES
                        .iter()
                        .any(|(_, name)| option["name"] == *name)
                });
        }
        Bundle {
            main,
            catalogs: Value::Object(
                FILES[1..8]
                    .iter()
                    .map(|(name, seed)| ((*name).to_owned(), serde_json::from_str(seed).unwrap()))
                    .collect(),
            ),
        }
    }
    #[test]
    fn old_eight_files_gain_disabled_attributes_only_in_memory_until_saved() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut legacy = eight_file_bundle();
        legacy.main["categories"][0]["products"][0]["titleZh"] = json!("客户自定义产品");
        legacy.catalogs["materials.json"]["values"][0]["labelZh"] = json!("客户自定义材质名称");
        let uncategorized = legacy.main["categories"][0]["products"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        legacy.main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(uncategorized);
        let mut originals = Vec::new();
        for (index, (name, _)) in FILES[..8].iter().enumerate() {
            let value = if index == 0 {
                &legacy.main
            } else {
                &legacy.catalogs[*name]
            };
            let bytes = serde_json::to_vec(value).unwrap();
            fs::write(root.join(name), &bytes).unwrap();
            originals.push(bytes);
        }
        let loaded = read(root).unwrap();
        for (index, (name, _)) in FILES[..8].iter().enumerate() {
            assert_eq!(fs::read(root.join(name)).unwrap(), originals[index]);
        }
        for (file, _) in ADDITIONAL_ATTRIBUTES {
            assert!(!root.join(file).exists());
            assert_eq!(loaded.bundle.catalogs[file]["values"], json!([]));
            assert_eq!(loaded.bundle.catalogs[file]["nextId"], json!(1));
        }
        let mut expected = legacy.clone();
        upgrade_additional_attributes(&mut expected).unwrap();
        assert_eq!(loaded.bundle.main, expected.main);
        assert_eq!(loaded.bundle.catalogs, expected.catalogs);
        assert_eq!(read(root).unwrap().version, loaded.version);
        // A client sending the old eight-file shape receives the same migration on save.
        let saved = save(root, legacy, &loaded.version).unwrap();
        assert_eq!(saved.bundle.main, expected.main);
        assert_eq!(saved.bundle.catalogs, expected.catalogs);
        for (file, _) in FILES {
            assert!(root.join(file).is_file());
        }
        let reloaded = read(root).unwrap();
        assert_eq!(reloaded.bundle.main, expected.main);
        assert_eq!(reloaded.bundle.catalogs, expected.catalogs);
        assert_eq!(reloaded.version, saved.version);
    }
    #[test]
    fn additional_attributes_preserve_custom_values_switches_and_typed_references() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let original = read(root).unwrap();
        let mut edited = original.bundle;
        for (file, name, key, prefix) in [
            (
                "tinplate-sticker-films.json",
                "Tinplate Sticker Film",
                "tinplateStickerFilmId",
                "TF",
            ),
            (
                "tinplate-materials.json",
                "Tinplate Material",
                "tinplateMaterialId",
                "TM",
            ),
        ] {
            let first = format!("{prefix}1");
            let second = format!("{prefix}2");
            edited.catalogs[file]["values"] = json!([
                {key:first,"name":"客户自定义选项","sortOrder":1},
                {key:second,"name":"客户禁用的选项","sortOrder":2}
            ]);
            edited.catalogs[file]["defaultValue"] = json!({key:first});
            edited.catalogs[file]["nextId"] = json!(3);
            let option = edited.main["categories"][0]["products"][0]["productOptions"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|option| option["name"] == name)
                .unwrap();
            option["deleted"] = json!(false);
            option["disabledValues"] = json!([{key:second}]);
        }
        let expected = edited.clone();
        upgrade_additional_attributes(&mut edited).unwrap();
        assert_eq!(edited.main, expected.main);
        assert_eq!(edited.catalogs, expected.catalogs);
        let saved = save(root, edited, &original.version).unwrap();
        assert_eq!(saved.bundle.main, expected.main);
        assert_eq!(saved.bundle.catalogs, expected.catalogs);
        for (file, name, key, id, wrong_key) in [
            (
                "tinplate-sticker-films.json",
                "Tinplate Sticker Film",
                "tinplateStickerFilmId",
                "TF1",
                "holoFilmId",
            ),
            (
                "tinplate-materials.json",
                "Tinplate Material",
                "tinplateMaterialId",
                "TM1",
                "materialId",
            ),
        ] {
            for wrong_reference in [
                json!({"id":id}),
                json!({wrong_key:id}),
                json!({key:id,wrong_key:id}),
                json!({key:"missing"}),
            ] {
                let mut invalid = expected.clone();
                invalid.catalogs[file]["defaultValue"] = wrong_reference.clone();
                assert!(validate(&invalid).is_err());
                let mut invalid = expected.clone();
                let option = invalid.main["categories"][0]["products"][0]["productOptions"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|option| option["name"] == name)
                    .unwrap();
                option["disabledValues"] = json!([wrong_reference]);
                assert!(validate(&invalid).is_err());
            }
            let mut invalid = expected.clone();
            invalid.catalogs[file]["values"][0][wrong_key] = json!(id);
            assert!(validate(&invalid).is_err());
            let mut invalid = expected.clone();
            invalid.catalogs["techniques.json"]["values"][0][key] = json!(id);
            assert!(validate(&invalid).is_err());
            let mut invalid = expected.clone();
            invalid.catalogs[file]["values"][0][key] = json!("G1");
            assert!(validate(&invalid).is_err());
        }
        assert_eq!(read(root).unwrap().version, saved.version);
    }
    #[test]
    fn new_attribute_catalog_presence_changes_version_and_corrupt_files_are_not_replaced() {
        for (file, _) in ADDITIONAL_ATTRIBUTES {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let original = read(root).unwrap();
            assert!(!root.join(file).exists());
            let seed = FILES.iter().find(|(name, _)| *name == file).unwrap().1;
            fs::write(root.join(file), seed).unwrap();
            assert!(save(root, original.bundle, &original.version).is_err());
            assert_eq!(fs::read(root.join(file)).unwrap(), seed.as_bytes());
            fs::write(root.join(file), b"{broken").unwrap();
            assert!(read(root).is_err());
            assert_eq!(fs::read(root.join(file)).unwrap(), b"{broken");
        }
    }
    #[test]
    fn explicit_entities_and_references_roundtrip() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let original = read(root).unwrap();
        let mut edited = original.bundle.clone();
        // Identical text belongs to distinct entities; no prefix inference is needed.
        assert_eq!(
            edited.main["categories"][0]["products"][0]["productId"],
            "P1"
        );
        assert_eq!(
            edited.catalogs["accessory-styles.json"]["values"][0]["accessoryStyleId"],
            "P1"
        );
        let style = edited.catalogs["accessory-styles.json"]["values"]
            .as_array()
            .unwrap()
            .iter()
            .find(|style| {
                style["colors"]
                    .as_array()
                    .is_some_and(|colors| !colors.is_empty())
            })
            .unwrap();
        let style_ref = json!({"accessoryStyleId": style["accessoryStyleId"]});
        let color_ref = json!({"accessoryColorId": style["colors"][0]["accessoryColorId"]});
        edited.catalogs["techniques.json"]["defaultValue"] = json!({"techniqueId": "G11"});
        edited.main["categories"][0]["products"][0]["productOptions"][5]["disabledValues"] =
            json!([style_ref.clone(), color_ref.clone()]);
        let saved = save(root, edited.clone(), &original.version).unwrap();
        let reloaded = read(root).unwrap();
        assert_eq!(reloaded.bundle.main, edited.main);
        assert_eq!(reloaded.bundle.catalogs, edited.catalogs);
        assert_eq!(reloaded.version, saved.version);
    }
    #[test]
    fn retired_rules_are_discarded_on_load_and_save_without_changing_other_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let original = read(root).unwrap();
        let mut expected = original.bundle.clone();
        let uncategorized = expected.main["categories"][0]["products"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        expected.main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(uncategorized);
        expected.catalogs["techniques.json"]["defaultValue"] = json!({"techniqueId": "G11"});
        expected.main["categories"][0]["products"][0]["productOptions"][2]["deleted"] = json!(true);
        expected.main["categories"][0]["products"][0]["productOptions"][3]["disabledValues"] =
            json!([{"holoFilmId": "M2"}]);
        let saved = save(root, expected, &original.version).unwrap();
        let expected = saved.bundle;
        for rules in [
            json!([{"when": {"option": "Technique", "value": {"techniqueId": "G1"}}, "hide": [{"option": "Holo Film", "values": [{"holoFilmId": "M7"}]}]}]),
            json!([{"when": {"option": "Missing", "value": {"productId": "P999"}}, "hide": [{"option": "Holo Film", "values": [{"holoFilmId": "M999"}]}]}]),
            json!({"invalid": true}),
            json!(null),
            json!("obsolete"),
        ] {
            let mut legacy = expected.clone();
            legacy.main["categories"][0]["products"][0]["optionRules"] = rules.clone();
            legacy.main["uncategorizedProducts"][0]["optionRules"] = rules;
            let bytes = serde_json::to_vec(&legacy.main).unwrap();
            fs::write(root.join(FILES[0].0), &bytes).unwrap();
            let loaded = read(root).unwrap();
            assert_eq!(loaded.bundle.main, expected.main);
            assert_eq!(loaded.bundle.catalogs, expected.catalogs);
            assert_eq!(fs::read(root.join(FILES[0].0)).unwrap(), bytes);
            let result = save(root, legacy, &loaded.version).unwrap();
            assert_eq!(result.bundle.main, expected.main);
            assert_eq!(result.bundle.catalogs, expected.catalogs);
            let persisted: Value =
                serde_json::from_slice(&fs::read(root.join(FILES[0].0)).unwrap()).unwrap();
            assert_eq!(persisted, expected.main);
            assert!(persisted["categories"][0]["products"][0]
                .get("optionRules")
                .is_none());
            assert!(persisted["uncategorizedProducts"][0]
                .get("optionRules")
                .is_none());
        }
    }
    #[test]
    fn legacy_or_ambiguous_identity_is_rejected_without_rewriting_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let original = read(root).unwrap();
        for key in ["id", "accessoryStyleId"] {
            let mut invalid = original.bundle.clone();
            let product = invalid.main["categories"][0]["products"][0]
                .as_object_mut()
                .unwrap();
            product.insert(key.to_owned(), json!("P1"));
            assert!(validate(&invalid).is_err(), "{key}");
        }
        let mut legacy = original.bundle.main;
        let product = legacy["categories"][0]["products"][0]
            .as_object_mut()
            .unwrap();
        let product_id = product.remove("productId").unwrap();
        product.insert("id".to_owned(), product_id);
        let bytes = serde_json::to_vec(&legacy).unwrap();
        fs::write(root.join(FILES[0].0), &bytes).unwrap();
        assert!(read(root).is_err());
        assert_eq!(fs::read(root.join(FILES[0].0)).unwrap(), bytes);
        assert!(!root.join("product-options.clean.json.pending").exists());
    }
    #[test]
    fn references_must_match_their_catalog_and_existing_entities() {
        let directory = tempfile::tempdir().unwrap();
        let original = read(directory.path()).unwrap();
        for value in [
            json!("G1"),
            json!({"id": "G1"}),
            json!({"techniqueId": "G1", "materialId": "C1"}),
            json!({"materialId": "G1"}),
            json!({"productId": "P1"}),
            json!({"techniqueId": "G999"}),
        ] {
            let mut invalid = original.bundle.clone();
            invalid.main["categories"][0]["products"][0]["productOptions"][2]["disabledValues"] =
                json!([value.clone()]);
            assert!(validate(&invalid).is_err(), "disabled reference {value}");
            invalid = original.bundle.clone();
            invalid.catalogs["techniques.json"]["defaultValue"] = value.clone();
            assert!(validate(&invalid).is_err(), "default reference {value}");
        }
        let mut invalid = original.bundle.clone();
        invalid.main["categories"][0]["products"][1]["productId"] = json!("P1");
        assert!(validate(&invalid).is_err());
        invalid = original.bundle;
        let print = invalid.catalogs["print-options.json"]["values"][0]
            .as_object_mut()
            .unwrap();
        print.remove("printOptionId");
        print.insert("techniqueId".to_owned(), json!("Y1"));
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn custom_option_identity_is_scoped_by_product_and_option() {
        let directory = tempfile::tempdir().unwrap();
        let mut bundle = read(directory.path()).unwrap().bundle;
        let options = bundle.main["categories"][0]["products"][0]["productOptions"]
            .as_array_mut()
            .unwrap();
        for name in ["Custom A", "Custom B"] {
            options.push(json!({
                "name": name, "labelZh": name, "deleted": false, "nextId": 2,
                "values": [{"customOptionValueId": "X1", "name": "Choice", "sortOrder": 1}],
                "defaultValue": {"customOptionValueId": "X1"},
                "disabledValues": [{"customOptionValueId": "X1"}]
            }));
        }
        validate(&bundle).unwrap();
        bundle.main["categories"][0]["products"][0]["productOptions"][DEFINITIONS.len()]
            ["disabledValues"] = json!([{"techniqueId": "X1"}]);
        assert!(validate(&bundle).is_err());
    }
    fn legacy_main() -> Value {
        let mut main: Value = serde_json::from_str(FILES[0].1).unwrap();
        for category in main["categories"].as_array_mut().unwrap() {
            for product in category["products"].as_array_mut().unwrap() {
                product["productOptions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|option| option["name"] != "Standee Quantity");
            }
        }
        for product in main["uncategorizedProducts"].as_array_mut().unwrap() {
            product["productOptions"]
                .as_array_mut()
                .unwrap()
                .retain(|option| option["name"] != "Standee Quantity");
        }
        main
    }
    #[test]
    fn old_six_file_bundle_is_upgraded_in_memory_and_backed_up_on_save() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bytes = serde_json::to_vec(&legacy_main()).unwrap();
        fs::write(root.join(FILES[0].0), &bytes).unwrap();
        for (file, seed) in &FILES[1..6] {
            fs::write(root.join(file), seed).unwrap();
        }
        let loaded = read(root).unwrap();
        assert_eq!(fs::read(root.join(FILES[0].0)).unwrap(), bytes);
        assert!(!root.join("standee-quantities.json").exists());
        assert_eq!(read(root).unwrap().version, loaded.version);
        for category in loaded.bundle.main["categories"].as_array().unwrap() {
            for product in category["products"].as_array().unwrap() {
                let option = product["productOptions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|option| option["name"] == "Standee Quantity")
                    .unwrap();
                assert_eq!(option["deleted"], category["name"] != "standees");
                assert_eq!(option["defaultValue"], json!({"standeeQuantityId": "SQ1"}));
            }
        }
        let saved = save(root, loaded.bundle, &loaded.version).unwrap();
        for (file, _) in FILES {
            assert!(root.join(file).is_file());
        }
        assert_ne!(saved.version, loaded.version);
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let backup = root.join(format!(
            "product-options.clean.before-standee-quantities-{digest}.json.bak"
        ));
        assert_eq!(fs::read(backup).unwrap(), bytes);
        assert_eq!(read(root).unwrap().bundle.main, saved.bundle.main);
    }
    #[test]
    fn upgrade_preserves_switches_defaults_and_deleted_catalog_values() {
        let mut main = json!({"categories":[
            {"name":"standees","products":[
                {"productOptions":[]},
                {"productOptions":[{"name":"Standee Quantity","deleted":true,"defaultValue":{"standeeQuantityId":"SQ3"}}]},
                {"productOptions":[{"name":"Standee Quantity","deleted":false}]}
            ]},
            {"name":"other","products":[{"productOptions":[]}]}
        ],"uncategorizedProducts":[{"productOptions":[]}]});
        assert!(complete_standee_quantity_options(&mut main, true).unwrap());
        assert_eq!(
            main["categories"][0]["products"][1]["productOptions"][0],
            json!({"name":"Standee Quantity","deleted":true,"defaultValue":{"standeeQuantityId":"SQ3"}})
        );
        assert_eq!(
            main["categories"][0]["products"][2]["productOptions"][0],
            json!({"name":"Standee Quantity","deleted":false})
        );
        assert_eq!(
            main["uncategorizedProducts"][0]["productOptions"][0]["deleted"],
            true
        );
        assert!(!complete_standee_quantity_options(&mut main, true).unwrap());
        main["categories"][0]["products"][0]["productOptions"] = json!([]);
        complete_standee_quantity_options(&mut main, false).unwrap();
        assert!(main["categories"][0]["products"][0]["productOptions"][0]
            .get("defaultValue")
            .is_none());
    }
    #[test]
    fn standee_counts_are_explicit_unique_and_references_are_typed() {
        let directory = tempfile::tempdir().unwrap();
        let original = read(directory.path()).unwrap();
        for value in [json!(0), json!(5), json!(1.5), json!("1"), Value::Null] {
            let mut invalid = original.bundle.clone();
            invalid.catalogs["standee-quantities.json"]["values"][0]["pieceCount"] = value;
            assert!(validate(&invalid).is_err());
        }
        let mut invalid = original.bundle.clone();
        invalid.catalogs["standee-quantities.json"]["values"][1]["pieceCount"] = json!(1);
        assert!(validate(&invalid).is_err());
        invalid = original.bundle.clone();
        invalid.catalogs["techniques.json"]["values"][0]["pieceCount"] = json!(1);
        assert!(validate(&invalid).is_err());
        invalid = original.bundle.clone();
        invalid.catalogs["standee-quantities.json"]["values"][0]["techniqueId"] = json!("SQ1");
        assert!(validate(&invalid).is_err());
        for default in [
            json!({"standeeQuantityId":"SQ99"}),
            json!({"techniqueId":"SQ1"}),
            json!({"id":"SQ1"}),
        ] {
            let mut invalid = original.bundle.clone();
            invalid.main["categories"][0]["products"][0]["productOptions"][6]["defaultValue"] =
                default;
            assert!(validate(&invalid).is_err());
        }
        let mut valid = original.bundle;
        let product = &mut valid.main["categories"][0]["products"][0];
        product["productOptions"][6]["defaultValue"] = json!({"standeeQuantityId":"SQ2"});
        product["productOptions"][6]["disabledValues"] = json!([{"standeeQuantityId":"SQ2"}]);
        validate(&valid).unwrap();
    }
    #[test]
    fn new_catalog_appearance_and_tampered_migration_backup_do_not_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let first = read(root).unwrap();
        fs::write(root.join(FILES[6].0), FILES[6].1).unwrap();
        assert!(save(root, first.bundle, &first.version).is_err());
        let bytes = serde_json::to_vec(&legacy_main()).unwrap();
        fs::write(root.join(FILES[0].0), &bytes).unwrap();
        let loaded = read(root).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let backup = root.join(format!(
            "product-options.clean.before-standee-quantities-{digest}.json.bak"
        ));
        fs::write(&backup, b"do not replace").unwrap();
        assert!(save(root, loaded.bundle, &loaded.version)
            .err()
            .unwrap()
            .contains("备份内容不符"));
        assert_eq!(fs::read(root.join(FILES[0].0)).unwrap(), bytes);
        assert_eq!(fs::read(backup).unwrap(), b"do not replace");
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
    fn locked_new_catalog_rolls_back_created_optional_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        read(root).unwrap();
        fs::write(root.join(FILES[9].0), FILES[9].1).unwrap();
        let original = read(root).unwrap();
        let mut edited = original.bundle.clone();
        edited.main["categories"][0]["products"][0]["titleZh"] = json!("不能部分保存");
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(root.join(FILES[9].0))
            .unwrap();
        let failure = save(root, edited, &original.version).err().unwrap();
        assert!(failure.contains("已恢复原配置"), "{failure}");
        drop(held);
        assert!(!root.join(FILES[8].0).exists());
        assert_eq!(
            fs::read(root.join(FILES[9].0)).unwrap(),
            FILES[9].1.as_bytes()
        );
        assert_eq!(read(root).unwrap().version, original.version);
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
    #[test]
    fn size_upgrade_reads_custom_legacy_sizes_and_keeps_existing_product_switches() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("settings/product-options");
        let pricing = directory.path().join("settings/product-pricing");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&pricing).unwrap();
        let mut main: Value = serde_json::from_str(FILES[0].1).unwrap();
        remove_seed_size_options(&mut main);
        main["categories"][0]["products"][1]["productOptions"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({"name":"Size","deleted":true,"disabledValues":[]}));
        let original = serde_json::to_vec(&main).unwrap();
        fs::write(root.join(FILES[0].0), &original).unwrap();
        fs::write(pricing.join("product-pricing.json"), serde_json::to_vec(&json!({"schemaVersion":3,"sizeBands":[{"sizeBandId":"custom-size","label":"自定义 70 mm"}],"products":[{"productId":"P1","sizeBandIds":["custom-size"]},{"productId":"P2","sizeBandIds":["custom-size"]}]})).unwrap()).unwrap();
        let loaded = read(&root).unwrap();
        assert!(!root.join("sizes.json").exists());
        assert_eq!(fs::read(root.join(FILES[0].0)).unwrap(), original);
        let first = &loaded.bundle.main["categories"][0]["products"][0]["productOptions"][0];
        assert_eq!(first["name"], "Size");
        assert_eq!(first["deleted"], false);
        assert!(!first["disabledValues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| reference["sizeBandId"] == "custom-size"));
        assert_eq!(
            loaded.bundle.main["categories"][0]["products"][1]["productOptions"][0]["deleted"],
            true
        );
        assert!(loaded.bundle.catalogs["sizes.json"]["values"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |value| value["sizeBandId"] == "custom-size" && value["labelZh"] == "自定义 70 mm"
            ));
        let saved = save(&root, loaded.bundle, &loaded.version).unwrap();
        assert!(root.join("sizes.json").exists());
        let backup = root.join(format!(
            "product-options.clean.before-sizes-{:x}.json.bak",
            Sha256::digest(&original)
        ));
        assert_eq!(fs::read(backup).unwrap(), original);
        assert_eq!(read(&root).unwrap().bundle.main, saved.bundle.main);
    }

    #[test]
    fn size_upgrade_source_change_and_bad_backup_prevent_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("settings/product-options");
        let pricing = directory.path().join("settings/product-pricing");
        fs::create_dir_all(&pricing).unwrap();
        let first = read(&root).unwrap();
        fs::write(pricing.join("product-pricing.json"), serde_json::to_vec(&json!({"schemaVersion":2,"sizeBands":[{"sizeBandId":"changed-size","label":"已修改"}],"products":[{"productId":"P1","sizeBandIds":["changed-size"]}]})).unwrap()).unwrap();
        assert!(save(&root, first.bundle, &first.version).is_err());
        let current = read(&root).unwrap();
        let original = fs::read(root.join(FILES[0].0)).unwrap();
        let backup = root.join(format!(
            "product-options.clean.before-sizes-{:x}.json.bak",
            Sha256::digest(&original)
        ));
        fs::write(&backup, b"wrong backup").unwrap();
        assert!(save(&root, current.bundle, &current.version)
            .err()
            .unwrap()
            .contains("尺寸升级备份内容不符"));
        assert_eq!(fs::read(root.join(FILES[0].0)).unwrap(), original);
        assert!(!root.join("sizes.json").exists());
    }

    #[test]
    fn sizes_accept_legacy_ids_but_require_typed_unique_ids_and_new_sequence() {
        let directory = tempfile::tempdir().unwrap();
        let original = read(directory.path()).unwrap().bundle;
        let mut valid = original.clone();
        valid.catalogs["sizes.json"]["values"]
            .as_array_mut()
            .unwrap()
            .push(json!({"sizeBandId":"S99","name":"新尺寸","sortOrder":100,"isDefault":false}));
        valid.catalogs["sizes.json"]["nextId"] = json!(100);
        validate(&valid).unwrap();
        let mut invalid = valid.clone();
        invalid.catalogs["sizes.json"]["nextId"] = json!(99);
        assert!(validate(&invalid).is_err());
        for key in ["techniqueId", "id"] {
            let mut invalid = original.clone();
            invalid.catalogs["sizes.json"]["values"][0][key] = json!("board-1-in");
            assert!(validate(&invalid).is_err());
        }
        let mut invalid = original.clone();
        let value = invalid.catalogs["sizes.json"]["values"][0].clone();
        invalid.catalogs["sizes.json"]["values"]
            .as_array_mut()
            .unwrap()
            .push(value);
        assert!(validate(&invalid).is_err());
        let mut invalid = original;
        invalid.main["categories"][0]["products"][0]["productOptions"][0]["disabledValues"] =
            json!([{"techniqueId":"board-1-in"}]);
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn saved_size_configuration_loads_independently_of_unrelated_broken_pricing() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("settings/product-options");
        let loaded = read(&root).unwrap();
        let saved = save(&root, loaded.bundle, &loaded.version).unwrap();
        let pricing = directory.path().join("settings/product-pricing");
        fs::create_dir_all(&pricing).unwrap();
        fs::write(pricing.join("product-pricing.json"), b"{broken").unwrap();
        assert_eq!(read(&root).unwrap().version, saved.version);
    }
}
