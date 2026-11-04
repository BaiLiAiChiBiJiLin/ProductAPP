//! Category-scoped quantity discounts, independent of product option definitions.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::Path, sync::Mutex};

static LOCK: Mutex<()> = Mutex::new(());
const FILE_NAME: &str = "quantity-pricing.json";
const SEED: &str =
    include_str!("../../src/modules/settings/quantity-pricing/data/quantity-pricing.json");
const PRODUCT_SEED: &str =
    include_str!("../../src/modules/settings/product-options/data/product-options.clean.json");
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuantityTier {
    quantity_tier_id: String,
    min_qty: u64,
    // The field must be present; null explicitly means there is no upper limit.
    #[serde(deserialize_with = "required_nullable_quantity")]
    max_qty: Option<u64>,
    discount_percent: f64,
}

fn required_nullable_quantity<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    Option::<u64>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryRule {
    category_id: String,
    tiers: Vec<QuantityTier>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    schema_version: u32,
    category_rules: Vec<CategoryRule>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricingCategory {
    category_id: String,
    title: String,
    title_zh: String,
    product_count: usize,
}

#[derive(Debug, Serialize)]
pub struct Snapshot {
    document: Document,
    categories: Vec<PricingCategory>,
    version: String,
    directory: String,
}

#[derive(Deserialize)]
struct ProductCategories {
    categories: Vec<ProductCategory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductCategory {
    name: String,
    title: String,
    title_zh: String,
    products: Vec<Value>,
}

fn error(e: impl std::fmt::Display) -> String {
    format!("价格阶梯：{e}")
}

fn validate(document: &Document) -> Result<(), String> {
    if document.schema_version != 1 {
        return Err(error("不支持的配置版本"));
    }
    let mut category_ids = HashSet::new();
    let mut tier_ids = HashSet::new();
    for rule in &document.category_rules {
        if rule.category_id.trim().is_empty()
            || rule.category_id.trim() != rule.category_id
            || !category_ids.insert(&rule.category_id)
        {
            return Err(error("产品大类标识不能为空或重复"));
        }
        for (index, tier) in rule.tiers.iter().enumerate() {
            if tier.quantity_tier_id.trim().is_empty()
                || tier.quantity_tier_id.trim() != tier.quantity_tier_id
                || !tier_ids.insert(&tier.quantity_tier_id)
            {
                return Err(error("阶梯标识不能为空或重复"));
            }
            if tier.min_qty == 0
                || tier.min_qty > MAX_SAFE_INTEGER
                || tier
                    .max_qty
                    .is_some_and(|max| max < tier.min_qty || max > MAX_SAFE_INTEGER)
            {
                return Err(error(format!(
                    "{} 第 {} 行数量范围无效",
                    rule.category_id,
                    index + 1
                )));
            }
            let discount = tier.discount_percent;
            if !discount.is_finite()
                || !(0.0..=100.0).contains(&discount)
                || (discount * 100.0 - (discount * 100.0).round()).abs() >= 0.00000001
            {
                return Err(error(format!(
                    "{} 第 {} 行折扣必须为 0–100，最多两位小数",
                    rule.category_id,
                    index + 1
                )));
            }
        }
        let mut ordered: Vec<_> = rule.tiers.iter().collect();
        ordered.sort_by_key(|tier| tier.min_qty);
        for adjacent in ordered.windows(2) {
            if adjacent[0]
                .max_qty
                .is_none_or(|max| max >= adjacent[1].min_qty)
            {
                return Err(error(format!(
                    "{} 的数量区间不能重叠，无上限区间必须在最后",
                    rule.category_id
                )));
            }
        }
    }
    Ok(())
}

fn product_categories(data_root: &Path) -> Result<(Vec<PricingCategory>, Vec<u8>), String> {
    let path = data_root.join("settings/product-options/product-options.clean.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PRODUCT_SEED.as_bytes().to_vec(),
        Err(e) => return Err(error(e)),
    };
    let product_document: ProductCategories = serde_json::from_slice(&bytes).map_err(error)?;
    let mut ids = HashSet::new();
    let categories = product_document
        .categories
        .into_iter()
        .map(|category| {
            if category.name.trim().is_empty() || !ids.insert(category.name.clone()) {
                return Err(error("产品配置的大类标识为空或重复"));
            }
            Ok(PricingCategory {
                category_id: category.name,
                title: category.title,
                title_zh: category.title_zh,
                product_count: category.products.len(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((categories, bytes))
}

fn validate_category_links(
    document: &Document,
    categories: &[PricingCategory],
) -> Result<(), String> {
    let category_ids: HashSet<_> = categories
        .iter()
        .map(|category| category.category_id.as_str())
        .collect();
    for rule in &document.category_rules {
        if !category_ids.contains(rule.category_id.as_str()) {
            return Err(error(format!(
                "产品大类 {} 已不存在，请移除失效关联后保存",
                rule.category_id
            )));
        }
    }
    Ok(())
}

fn version(pricing_bytes: &[u8], product_bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(FILE_NAME.as_bytes());
    hash.update(pricing_bytes);
    hash.update(b"product-options.clean.json");
    hash.update(product_bytes);
    format!("{:x}", hash.finalize())
}

fn ensure_price_file(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(error)?;
    let path = directory.join(FILE_NAME);
    if path.exists() {
        return Ok(());
    }
    let mut pending = tempfile::NamedTempFile::new_in(directory).map_err(error)?;
    pending.write_all(SEED.as_bytes()).map_err(error)?;
    pending.flush().map_err(error)?;
    pending.as_file().sync_all().map_err(error)?;
    match pending.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(error(e.error)),
    }
}

fn read_existing(data_root: &Path) -> Result<Snapshot, String> {
    let directory = data_root.join("settings/quantity-pricing");
    let bytes = fs::read(directory.join(FILE_NAME)).map_err(error)?;
    if bytes.len() > MAX_BYTES {
        return Err(error("配置超过 4MB"));
    }
    let document: Document = serde_json::from_slice(&bytes).map_err(error)?;
    validate(&document)?;
    let (categories, product_bytes) = product_categories(data_root)?;
    // Stale category links remain visible on load so the UI can explicitly remove them.
    Ok(Snapshot {
        document,
        categories,
        version: version(&bytes, &product_bytes),
        directory: directory.to_string_lossy().into_owned(),
    })
}

fn read(data_root: &Path) -> Result<Snapshot, String> {
    ensure_price_file(&data_root.join("settings/quantity-pricing"))?;
    read_existing(data_root)
}

fn save(data_root: &Path, document: Document, expected: &str) -> Result<Snapshot, String> {
    validate(&document)?;
    let mut bytes = serde_json::to_vec_pretty(&document).map_err(error)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(error("配置超过 4MB"));
    }
    let current = read_existing(data_root)?;
    if current.version != expected {
        return Err(error(
            "价格阶梯或产品大类已被修改，请保留草稿并刷新后重新保存",
        ));
    }
    validate_category_links(&document, &current.categories)?;
    let directory = data_root.join("settings/quantity-pricing");
    let mut pending = tempfile::NamedTempFile::new_in(&directory).map_err(error)?;
    pending.write_all(&bytes).map_err(error)?;
    pending.flush().map_err(error)?;
    pending.as_file().sync_all().map_err(error)?;
    // Check again after staging, so a category edit or another save is not overwritten.
    if read_existing(data_root)?.version != expected {
        return Err(error(
            "价格阶梯或产品大类已被修改，请保留草稿并刷新后重新保存",
        ));
    }
    pending
        .persist(directory.join(FILE_NAME))
        .map_err(|e| error(format!("保存失败，原配置已保留：{}", e.error)))?;
    read_existing(data_root)
}

#[tauri::command]
pub async fn load_quantity_pricing_settings() -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = LOCK.lock().map_err(error)?;
        read(&crate::project_data_dir())
    })
    .await
    .map_err(error)?
}

#[tauri::command]
pub async fn save_quantity_pricing_settings(
    document: Document,
    expected_version: String,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(error)?;
        save(&crate::project_data_dir(), document, &expected_version)
    })
    .await
    .map_err(error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "categoryRules": [{"categoryId": "keychains", "tiers": [
                {"quantityTierId": "keychain-1", "minQty": 1, "maxQty": 5, "discountPercent": 0},
                {"quantityTierId": "keychain-2", "minQty": 6, "maxQty": null, "discountPercent": 100}
            ]}]
        })).unwrap()
    }

    fn write_categories(root: &Path, value: Value) {
        let directory = root.join("settings/product-options");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("product-options.clean.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn seed_and_actual_categories_load_and_prices_roundtrip() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let seeded = read(root).unwrap();
        assert!(seeded
            .categories
            .iter()
            .any(|category| category.category_id == "keychains"));
        assert!(!root.join("settings/product-options").exists());
        let path = root.join("settings/quantity-pricing").join(FILE_NAME);
        let initial_bytes = fs::read(&path).unwrap();
        assert_eq!(initial_bytes, SEED.as_bytes());
        let saved = save(root, sample(), &seeded.version).unwrap();
        assert_eq!(saved.document, sample());
        assert_ne!(saved.version, seeded.version);
        assert_eq!(read(root).unwrap().document, sample());
        let saved_bytes = fs::read(&path).unwrap();

        write_categories(
            root,
            json!({"categories": [{"name": "keychains", "title": "Custom name", "titleZh": "新大类显示名", "products": [{}, {}]}]}),
        );
        let loaded = read(root).unwrap();
        assert_eq!(
            loaded.categories,
            vec![PricingCategory {
                category_id: "keychains".into(),
                title: "Custom name".into(),
                title_zh: "新大类显示名".into(),
                product_count: 2
            }]
        );
        assert_eq!(loaded.document, sample());
        assert_eq!(fs::read(&path).unwrap(), saved_bytes);
    }

    #[test]
    fn validates_inclusive_boundaries_unlimited_and_discounts_without_monotonic_requirement() {
        let mut document = sample();
        validate(&document).unwrap();
        document.category_rules[0].tiers.reverse();
        validate(&document).unwrap();
        document.category_rules[0].tiers[0].discount_percent = 12.34;
        document.category_rules[0].tiers[1].discount_percent = 55.0;
        validate(&document).unwrap();
        // A gap is explicit and valid; quantity matching returns no tier in that gap.
        document.category_rules[0].tiers[0].min_qty = 7;
        validate(&document).unwrap();
        for discount in [-1.0, 100.01, 1.234, f64::NAN] {
            let mut invalid = sample();
            invalid.category_rules[0].tiers[0].discount_percent = discount;
            assert!(validate(&invalid).is_err());
        }
        for min in [0, MAX_SAFE_INTEGER + 1] {
            let mut invalid = sample();
            invalid.category_rules[0].tiers[0].min_qty = min;
            assert!(validate(&invalid).is_err());
        }
        let mut invalid = sample();
        invalid.category_rules[0].tiers[1].min_qty = 5;
        assert!(validate(&invalid).is_err());
        invalid = sample();
        invalid.category_rules[0].tiers[0].max_qty = None;
        assert!(validate(&invalid).is_err());
        invalid = sample();
        invalid.category_rules[0].tiers[1].max_qty = Some(5);
        assert!(validate(&invalid).is_err());
    }

    #[test]
    fn rejects_duplicate_ids_unknown_fields_and_missing_required_values() {
        let mut invalid = sample();
        invalid
            .category_rules
            .push(invalid.category_rules[0].clone());
        assert!(validate(&invalid).is_err());
        invalid = sample();
        let mut other = invalid.category_rules[0].clone();
        other.category_id = "standees".into();
        invalid.category_rules.push(other);
        assert!(validate(&invalid).is_err());
        for key in ["minQty", "maxQty", "quantityTierId", "discountPercent"] {
            let mut value = serde_json::to_value(sample()).unwrap();
            value["categoryRules"][0]["tiers"][0]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(
                serde_json::from_value::<Document>(value).is_err(),
                "missing {key}"
            );
        }
        let mut value = serde_json::to_value(sample()).unwrap();
        value["categoryRules"][0]["productId"] = json!("P1");
        assert!(serde_json::from_value::<Document>(value).is_err());
        let mut value = serde_json::to_value(sample()).unwrap();
        value["categoryRules"][0]["tiers"][0]["discountFormula"] = json!("qty * 2");
        assert!(serde_json::from_value::<Document>(value).is_err());
        let mut value = serde_json::to_value(sample()).unwrap();
        value["categoryRules"][0]["tiers"][0]["minQty"] = json!(1.5);
        assert!(serde_json::from_value::<Document>(value).is_err());
    }

    #[test]
    fn orphan_rules_remain_readable_but_must_be_removed_before_save() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        save(root, sample(), &loaded.version).unwrap();
        write_categories(root, json!({"categories": []}));
        let orphaned = read(root).unwrap();
        assert!(orphaned.categories.is_empty());
        assert_eq!(orphaned.document, sample());
        assert!(save(root, sample(), &orphaned.version)
            .unwrap_err()
            .contains("已不存在"));
        let clean = Document {
            schema_version: 1,
            category_rules: vec![],
        };
        assert_eq!(
            save(root, clean.clone(), &orphaned.version)
                .unwrap()
                .document,
            clean
        );
    }

    #[test]
    fn stale_prices_or_category_versions_never_overwrite_current_file() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let original = read(root).unwrap();
        let saved = save(root, sample(), &original.version).unwrap();
        let price_path = root.join("settings/quantity-pricing").join(FILE_NAME);
        let bytes = fs::read(&price_path).unwrap();
        assert!(save(root, original.document, &original.version)
            .unwrap_err()
            .contains("已被修改"));
        assert_eq!(fs::read(&price_path).unwrap(), bytes);
        write_categories(
            root,
            json!({"categories": [{"name": "keychains", "title": "Renamed", "titleZh": "钥匙扣", "products": []}]}),
        );
        assert!(save(root, sample(), &saved.version)
            .unwrap_err()
            .contains("已被修改"));
        assert_eq!(fs::read(&price_path).unwrap(), bytes);
        let fresh = read(root).unwrap();
        save(root, sample(), &fresh.version).unwrap();
    }

    #[test]
    fn malformed_existing_file_is_not_replaced_with_seed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings/quantity-pricing");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join(FILE_NAME), b"{bad json").unwrap();
        assert!(read(directory.path()).is_err());
        assert_eq!(fs::read(path.join(FILE_NAME)).unwrap(), b"{bad json");
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_keeps_original_and_cleans_staging_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let path = root.join("settings/quantity-pricing").join(FILE_NAME);
        let bytes = fs::read(&path).unwrap();
        // Allow reads for the version check but deny deletion/replacement.
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(save(root, sample(), &loaded.version).is_err());
        drop(lock);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
}
