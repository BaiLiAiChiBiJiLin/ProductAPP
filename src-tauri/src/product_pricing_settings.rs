//! Explicit product price tables. Product options and quantity discounts remain independent.
use serde::{Deserialize, Deserializer, Serialize};
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
const FILE_NAME: &str = "product-pricing.json";
const SEED: &str =
    include_str!("../../src/modules/settings/product-pricing/data/product-pricing.json");
const MIGRATION_BASES: &str =
    include_str!("../../src/modules/settings/product-pricing/data/migration-bases.json");
const QUANTITY_SEED: &str =
    include_str!("../../src/modules/settings/quantity-pricing/data/quantity-pricing.json");
const PRODUCT_FILES: [(&str, &str); 10] = crate::product_option_settings::FILES;
const ENTITY_KEYS: [&str; 12] = [
    "sizeBandId",
    "productId",
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
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SizeBand {
    size_band_id: String,
    label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodyPrice {
    product_price_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    technique_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    holo_film_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    material_id: Option<String>,
    size_band_id: String,
    unit_price: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BasePrice {
    base_price_id: String,
    size_band_id: String,
    unit_price: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttributePrice {
    attribute_price_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    technique_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    holo_film_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    material_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    size_band_id: Option<String>,
    unit_price: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessoryPrice {
    accessory_price_id: String,
    accessory_style_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    accessory_color_id: Option<String>,
    unit_price: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedAttributePrice {
    shared_attribute_price_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    technique_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    holo_film_id: Option<String>,
    // None explicitly means the size-independent band for fixed-price products.
    #[serde(deserialize_with = "required_nullable_string")]
    size_band_id: Option<String>,
    unit_price: String,
}

fn required_nullable_string<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PrintPricing {
    Included,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AccessoryPricing {
    Style,
    Color,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PricingMode {
    Fixed,
    Table,
    Standee,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RangeKind {
    Fixed,
    Area,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceRange {
    range_id: String,
    min_mm: String,
    max_mm: String,
    kind: RangeKind,
    amount: String,
    coefficient: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Panel {
    panel_id: String,
    label: String,
    piece_bands: Vec<PriceRange>,
    base_bands: Vec<PriceRange>,
    base_adjustment: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DimensionPrice {
    product_price_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    technique_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    holo_film_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    material_id: Option<String>,
    base_unit_price: String,
    panels: Vec<Panel>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductPricing {
    product_id: String,
    print_pricing: PrintPricing,
    pricing_mode: PricingMode,
    #[serde(deserialize_with = "required_nullable_string")]
    fixed_unit_price: Option<String>,
    base_prices: Vec<BasePrice>,
    attribute_prices: Vec<AttributePrice>,
    legacy_body_prices: Vec<BodyPrice>,
    dimension_prices: Vec<DimensionPrice>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    schema_version: u32,
    currency: String,
    accessory_pricing: AccessoryPricing,
    accessory_prices: Vec<AccessoryPrice>,
    #[serde(
        default,
        deserialize_with = "shared_attribute_price_rows",
        skip_serializing_if = "Option::is_none"
    )]
    shared_attribute_prices: Option<Vec<SharedAttributePrice>>,
    products: Vec<ProductPricing>,
}

fn shared_attribute_price_rows<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<SharedAttributePrice>>, D::Error> {
    // Missing means schema 4. Explicit null is never a valid shared price table.
    Vec::<SharedAttributePrice>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Bundle {
    main: Value,
    catalogs: HashMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    document: Document,
    bundle: Bundle,
    quantity_pricing: Value,
    version: String,
    directory: String,
}

fn error(e: impl std::fmt::Display) -> String {
    format!("产品定价：{e}")
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.trim() == value
}

fn valid_money(value: &str) -> bool {
    let mut parts = value.split('.');
    let integer = parts.next().unwrap_or("");
    let decimal = parts.next();
    !integer.is_empty()
        && integer.len() <= 9
        && integer.bytes().all(|c| c.is_ascii_digit())
        && (integer == "0" || !integer.starts_with('0'))
        && decimal.is_none_or(|part| {
            !part.is_empty() && part.len() <= 18 && part.bytes().all(|c| c.is_ascii_digit())
        })
        && parts.next().is_none()
}

// Decimal strings fit exactly in i128 after scaling by 10^18 (9 integer digits).
fn decimal(value: &str) -> Option<i128> {
    if !valid_money(value) {
        return None;
    }
    let (integer, fraction) = value.split_once('.').unwrap_or((value, ""));
    Some(
        integer.parse::<i128>().ok()? * 1_000_000_000_000_000_000
            + if fraction.is_empty() {
                0
            } else {
                fraction.parse::<i128>().ok()? * 10_i128.pow((18 - fraction.len()) as u32)
            },
    )
}
fn valid_adjustment(value: &str) -> bool {
    valid_money(value.strip_prefix('-').unwrap_or(value))
}
fn validate_dimensions(
    technique: &Option<String>,
    film: &Option<String>,
    material: &Option<String>,
) -> Result<(), String> {
    if [technique, film, material]
        .iter()
        .any(|id| id.as_ref().is_some_and(|id| !valid_id(id)))
    {
        return Err(error("工艺、膜、材质 ID 格式无效"));
    }
    Ok(())
}
fn insert_id<'a>(id: &'a str, ids: &mut HashSet<&'a str>, label: &str) -> Result<(), String> {
    if !valid_id(id) || !ids.insert(id) {
        return Err(error(format!("{label} ID 为空或重复")));
    }
    Ok(())
}
fn validate_ranges<'a>(ranges: &'a [PriceRange], ids: &mut HashSet<&'a str>) -> Result<(), String> {
    let mut intervals = Vec::new();
    for range in ranges {
        insert_id(&range.range_id, ids, "尺寸区间")?;
        let min = decimal(&range.min_mm)
            .filter(|n| *n > 0)
            .ok_or_else(|| error("尺寸下限必须是正十进制字符串"))?;
        let max = decimal(&range.max_mm)
            .filter(|n| *n >= min)
            .ok_or_else(|| error("尺寸上限无效或小于下限"))?;
        if !valid_money(&range.amount)
            || !valid_money(&range.coefficient)
            || range.kind == RangeKind::Fixed && decimal(&range.coefficient) != Some(0)
        {
            return Err(error("区间金额无效，固定价格的面积系数必须为 0"));
        }
        intervals.push((min, max));
    }
    intervals.sort_unstable();
    if intervals.windows(2).any(|rows| rows[0].1 >= rows[1].0) {
        return Err(error("尺寸闭区间不能重叠"));
    }
    Ok(())
}
fn validate(document: &Document) -> Result<(), String> {
    if ![4, 5].contains(&document.schema_version) || document.currency != "USD" {
        return Err(error("仅支持版本 4、5 和 USD 币种"));
    }
    if (document.schema_version == 5) != document.shared_attribute_prices.is_some() {
        return Err(error("公共属性价格与产品定价版本不符"));
    }
    let mut products = HashSet::new();
    let mut row_ids = HashSet::new();
    let mut panel_ids = HashSet::new();
    let mut range_ids = HashSet::new();
    let mut accessories = HashSet::new();
    let mut shared_keys = HashSet::new();
    for row in document.shared_attribute_prices.iter().flatten() {
        insert_id(&row.shared_attribute_price_id, &mut row_ids, "价格行")?;
        validate_dimensions(&row.technique_id, &row.holo_film_id, &None)?;
        if row.technique_id.is_some() == row.holo_film_id.is_some()
            || row.size_band_id.as_ref().is_some_and(|id| !valid_id(id))
            || !shared_keys.insert((&row.technique_id, &row.holo_film_id, &row.size_band_id))
        {
            return Err(error(
                "公共属性价格必须仅关联一个工艺或全息膜，属性与尺寸不能重复",
            ));
        }
        if !valid_adjustment(&row.unit_price) {
            return Err(error("公共属性加价金额格式无效"));
        }
    }
    for row in &document.accessory_prices {
        insert_id(&row.accessory_price_id, &mut row_ids, "价格行")?;
        if !valid_id(&row.accessory_style_id)
            || row
                .accessory_color_id
                .as_ref()
                .is_some_and(|id| !valid_id(id))
            || !accessories.insert((&row.accessory_style_id, &row.accessory_color_id))
        {
            return Err(error("公共配件关联无效或重复"));
        }
        if !valid_money(&row.unit_price) {
            return Err(error("配件金额格式无效"));
        }
        if document.accessory_pricing == AccessoryPricing::Style && row.accessory_color_id.is_some()
            || document.accessory_pricing == AccessoryPricing::Color
                && row.accessory_color_id.is_none()
        {
            return Err(error("公共配件颜色引用与计价方式不符"));
        }
    }
    for product in &document.products {
        insert_id(&product.product_id, &mut products, "产品")?;
        match product.pricing_mode {
            PricingMode::Fixed => {
                if !product.base_prices.is_empty()
                    || !product.legacy_body_prices.is_empty()
                    || !product.dimension_prices.is_empty()
                    || product
                        .fixed_unit_price
                        .as_ref()
                        .is_some_and(|amount| !valid_money(amount))
                {
                    return Err(error("固定价只能包含固定单价（空值表示未定价）"));
                }
            }
            PricingMode::Table => {
                if product.fixed_unit_price.is_some() || !product.dimension_prices.is_empty() {
                    return Err(error("尺寸表不能包含固定价或立牌配方"));
                }
            }
            PricingMode::Standee => {
                if product.fixed_unit_price.is_some()
                    || !product.base_prices.is_empty()
                    || !product.attribute_prices.is_empty()
                    || !product.legacy_body_prices.is_empty()
                {
                    return Err(error("立牌配方不能包含固定价或尺寸档价格"));
                }
            }
        }
        let mut base_sizes = HashSet::new();
        for row in &product.base_prices {
            insert_id(&row.base_price_id, &mut row_ids, "价格行")?;
            if !valid_id(&row.size_band_id) || !base_sizes.insert(&row.size_band_id) {
                return Err(error("主体基本价的尺寸无效或重复"));
            }
            if !valid_money(&row.unit_price) {
                return Err(error("主体基本金额格式无效"));
            }
        }
        let mut attributes = HashSet::new();
        for row in &product.attribute_prices {
            if document.schema_version == 5
                && (row.technique_id.is_some() || row.holo_film_id.is_some())
            {
                return Err(error(
                    "工艺和全息膜必须配置在公共价格中，产品内只保留材质加价",
                ));
            }
            insert_id(&row.attribute_price_id, &mut row_ids, "价格行")?;
            validate_dimensions(&row.technique_id, &row.holo_film_id, &row.material_id)?;
            if [&row.technique_id, &row.holo_film_id, &row.material_id]
                .iter()
                .filter(|id| id.is_some())
                .count()
                != 1
                || row.size_band_id.as_ref().is_some_and(|id| !valid_id(id))
                || !attributes.insert((
                    &row.technique_id,
                    &row.holo_film_id,
                    &row.material_id,
                    &row.size_band_id,
                ))
            {
                return Err(error("属性加价须明确且仅包含一种属性，属性与尺寸不能重复"));
            }
            if !valid_adjustment(&row.unit_price) {
                return Err(error("属性加价金额格式无效"));
            }
            if product.pricing_mode == PricingMode::Table && row.size_band_id.is_none()
                || product.pricing_mode == PricingMode::Fixed && row.size_band_id.is_some()
            {
                return Err(error("属性加价尺寸引用与计价方式不符"));
            }
        }
        let mut bodies = HashSet::new();
        for row in &product.legacy_body_prices {
            insert_id(&row.product_price_id, &mut row_ids, "价格行")?;
            validate_dimensions(&row.technique_id, &row.holo_film_id, &row.material_id)?;
            if !valid_id(&row.size_band_id)
                || !bodies.insert((
                    &row.technique_id,
                    &row.holo_film_id,
                    &row.material_id,
                    &row.size_band_id,
                ))
            {
                return Err(error("主体价格维度无效或重复"));
            }
            if !valid_money(&row.unit_price) {
                return Err(error("主体金额格式无效"));
            }
        }
        let mut recipes = HashSet::new();
        for row in &product.dimension_prices {
            insert_id(&row.product_price_id, &mut row_ids, "价格行")?;
            validate_dimensions(&row.technique_id, &row.holo_film_id, &row.material_id)?;
            if !recipes.insert((&row.technique_id, &row.holo_film_id, &row.material_id))
                || !valid_money(&row.base_unit_price)
            {
                return Err(error("立牌配方维度重复或基础金额无效"));
            }
            if row.panels.is_empty() {
                return Err(error("尺寸配方至少需要一个面板"));
            }
            for panel in &row.panels {
                insert_id(&panel.panel_id, &mut panel_ids, "立牌面板")?;
                if !valid_id(&panel.label) || !valid_adjustment(&panel.base_adjustment) {
                    return Err(error("面板名称或底座调整金额无效"));
                }
                validate_ranges(&panel.piece_bands, &mut range_ids)?;
                validate_ranges(&panel.base_bands, &mut range_ids)?;
            }
        }
    }
    Ok(())
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| error(format!("产品配置的 {key} 必须是数组")))
}

fn entity_id<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    if value.get("id").is_some()
        || ENTITY_KEYS
            .iter()
            .any(|candidate| *candidate != key && value.get(*candidate).is_some())
    {
        return Err(error("产品选项必须使用明确的所属实体 ID 字段"));
    }
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .ok_or_else(|| error(format!("产品配置缺少有效的 {key}")))
}

fn product_index(bundle: &Bundle) -> Result<HashMap<&str, &Value>, String> {
    let mut products = HashMap::new();
    let mut rows = Vec::new();
    for category in array(&bundle.main, "categories")? {
        rows.extend(array(category, "products")?);
    }
    rows.extend(array(&bundle.main, "uncategorizedProducts")?);
    for product in rows {
        let id = entity_id(product, "productId")?;
        if products.insert(id, product).is_some() {
            return Err(error("产品配置包含重复的 productId"));
        }
        let mut options = HashSet::new();
        for option in array(product, "productOptions")? {
            let name = option["name"]
                .as_str()
                .ok_or_else(|| error("产品选项名称无效"))?;
            if !options.insert(name) || !option["deleted"].is_boolean() {
                return Err(error("产品选项开关格式错误或名称重复"));
            }
            if let Some(disabled) = option.get("disabledValues") {
                for reference in disabled
                    .as_array()
                    .ok_or_else(|| error("禁用选项必须是数组"))?
                {
                    let object = reference
                        .as_object()
                        .filter(|object| object.len() == 1)
                        .ok_or_else(|| error("禁用引用必须明确所属实体"))?;
                    let (key, id) = object.iter().next().unwrap();
                    if key == "productId"
                        || !ENTITY_KEYS.contains(&key.as_str())
                        || id.as_str().is_none_or(|id| !valid_id(id))
                    {
                        return Err(error("禁用引用必须明确所属选项实体"));
                    }
                }
            }
        }
    }
    Ok(products)
}

fn option<'a>(product: &'a Value, name: &str) -> Option<&'a Value> {
    product["productOptions"]
        .as_array()?
        .iter()
        .find(|option| option["name"].as_str() == Some(name))
}
fn active(option: Option<&Value>) -> bool {
    option.is_some_and(|option| option["deleted"] == false)
}
fn enabled(option: &Value, key: &str, id: &str) -> bool {
    !option["disabledValues"]
        .as_array()
        .is_some_and(|values| values.iter().any(|value| value[key].as_str() == Some(id)))
}
fn catalog<'a>(
    bundle: &'a Bundle,
    file: &str,
    key: &str,
) -> Result<HashMap<&'a str, &'a Value>, String> {
    let value = bundle
        .catalogs
        .get(file)
        .ok_or_else(|| error(format!("缺少 {file}")))?;
    let mut values = HashMap::new();
    for value in array(value, "values")? {
        let id = entity_id(value, key)?;
        if values.insert(id, value).is_some() {
            return Err(error(format!("{file} 的 {key} 重复")));
        }
    }
    Ok(values)
}

fn validate_selections(
    product: &Value,
    dimensions: [(&str, &str, &Option<String>, &HashMap<&str, &Value>); 3],
) -> Result<(), String> {
    for (name, key, id, values) in dimensions {
        let current_option = option(product, name);
        let valid = if active(current_option) {
            id.as_deref().is_some_and(|id| {
                values.contains_key(id) && enabled(current_option.unwrap(), key, id)
            })
        } else {
            id.is_none()
        };
        if !valid {
            return Err(error(format!(
                "{} 的 {name} 引用不存在、未启用或与开关不符",
                product["productId"].as_str().unwrap_or("")
            )));
        }
    }
    Ok(())
}
fn validate_links(document: &Document, bundle: &Bundle) -> Result<(), String> {
    let products = product_index(bundle)?;
    let techniques = catalog(bundle, "techniques.json", "techniqueId")?;
    let films = catalog(bundle, "holo-films.json", "holoFilmId")?;
    let materials = catalog(bundle, "materials.json", "materialId")?;
    let styles = catalog(bundle, "accessory-styles.json", "accessoryStyleId")?;
    let sizes = catalog(bundle, "sizes.json", "sizeBandId")?;
    for row in document.shared_attribute_prices.iter().flatten() {
        if row
            .technique_id
            .as_ref()
            .is_some_and(|id| !techniques.contains_key(id.as_str()))
            || row
                .holo_film_id
                .as_ref()
                .is_some_and(|id| !films.contains_key(id.as_str()))
            || row
                .size_band_id
                .as_ref()
                .is_some_and(|id| !sizes.contains_key(id.as_str()))
        {
            return Err(error("公共属性价格引用的属性或尺寸不存在"));
        }
    }
    for pricing in &document.products {
        let product = products
            .get(pricing.product_id.as_str())
            .ok_or_else(|| error(format!("产品 {} 已不存在", pricing.product_id)))?;
        let size_option = option(product, "Size");
        let size_enabled = |id: &str| {
            sizes.contains_key(id)
                && active(size_option)
                && enabled(size_option.unwrap(), "sizeBandId", id)
        };
        for row in &pricing.base_prices {
            if !size_enabled(&row.size_band_id) {
                return Err(error("主体基本价引用的尺寸档未关联此产品"));
            }
        }
        for row in &pricing.attribute_prices {
            if row
                .size_band_id
                .as_ref()
                .is_some_and(|id| !size_enabled(id))
            {
                return Err(error("属性加价引用的尺寸档未关联此产品"));
            }
            for (name, key, id, values) in [
                ("Technique", "techniqueId", &row.technique_id, &techniques),
                ("Holo Film", "holoFilmId", &row.holo_film_id, &films),
                ("Material", "materialId", &row.material_id, &materials),
            ] {
                if let Some(id) = id {
                    let selected_option = option(product, name);
                    if !active(selected_option)
                        || !values.contains_key(id.as_str())
                        || !enabled(selected_option.unwrap(), key, id)
                    {
                        return Err(error(format!("属性加价的 {name} 引用不存在或未启用")));
                    }
                }
            }
        }
        for row in &pricing.legacy_body_prices {
            if !size_enabled(&row.size_band_id) {
                return Err(error("主体价引用的尺寸档未关联此产品"));
            }
            validate_selections(
                product,
                [
                    ("Technique", "techniqueId", &row.technique_id, &techniques),
                    ("Holo Film", "holoFilmId", &row.holo_film_id, &films),
                    ("Material", "materialId", &row.material_id, &materials),
                ],
            )?;
        }
        for row in &pricing.dimension_prices {
            validate_selections(
                product,
                [
                    ("Technique", "techniqueId", &row.technique_id, &techniques),
                    ("Holo Film", "holoFilmId", &row.holo_film_id, &films),
                    ("Material", "materialId", &row.material_id, &materials),
                ],
            )?;
        }
    }
    // A shared price is a catalog entry, independent of any one product's switches.
    for row in &document.accessory_prices {
        let style = styles
            .get(row.accessory_style_id.as_str())
            .ok_or_else(|| error("公共配件样式不存在"))?;
        if let Some(color_id) = &row.accessory_color_id {
            let mut found = false;
            let mut ids = HashSet::new();
            for color in array(style, "colors")? {
                let id = entity_id(color, "accessoryColorId")?;
                if !ids.insert(id) {
                    return Err(error("配件颜色 ID 重复"));
                }
                if id == color_id {
                    found = true;
                }
            }
            if !found {
                return Err(error("配件颜色不属于指定样式"));
            }
        }
    }
    Ok(())
}

fn read_bytes(path: &Path, fallback: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && fallback.is_some() => {
            fallback.unwrap().as_bytes().to_vec()
        }
        Err(e) => return Err(error(e)),
    };
    if bytes.len() > MAX_BYTES {
        return Err(error(format!("{} 超过 4MB", path.display())));
    }
    Ok(bytes)
}
fn hash_file(hash: &mut Sha256, name: &str, bytes: &[u8]) {
    hash.update((name.len() as u64).to_le_bytes());
    hash.update(name.as_bytes());
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionTwoProduct {
    product_id: String,
    print_pricing: PrintPricing,
    pricing_mode: PricingMode,
    #[serde(deserialize_with = "required_nullable_string")]
    fixed_unit_price: Option<String>,
    size_band_ids: Vec<String>,
    body_prices: Vec<BodyPrice>,
    dimension_prices: Vec<DimensionPrice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionTwoDocument {
    schema_version: u32,
    currency: String,
    size_bands: Vec<SizeBand>,
    accessory_pricing: AccessoryPricing,
    accessory_prices: Vec<AccessoryPrice>,
    products: Vec<VersionTwoProduct>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationProductBases {
    product_id: String,
    base_prices: Vec<BasePrice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MigrationBases {
    schema_version: u32,
    products: Vec<MigrationProductBases>,
}

fn migration_bases() -> Result<MigrationBases, String> {
    let manifest: MigrationBases = serde_json::from_str(MIGRATION_BASES).map_err(error)?;
    if manifest.schema_version != 1 {
        return Err(error("主体基本价迁移依据版本无效"));
    }
    let mut products = HashSet::new();
    let mut ids = HashSet::new();
    for product in &manifest.products {
        insert_id(&product.product_id, &mut products, "迁移依据产品")?;
        let mut sizes = HashSet::new();
        for row in &product.base_prices {
            insert_id(&row.base_price_id, &mut ids, "迁移依据基本价")?;
            insert_id(&row.size_band_id, &mut sizes, "迁移依据尺寸")?;
            if !valid_money(&row.unit_price) {
                return Err(error("主体基本价迁移依据金额无效"));
            }
        }
    }
    Ok(manifest)
}

fn all_price_ids(document: &Document) -> HashSet<String> {
    let mut ids: HashSet<String> = document
        .accessory_prices
        .iter()
        .map(|row| row.accessory_price_id.clone())
        .collect();
    for product in &document.products {
        ids.extend(
            product
                .base_prices
                .iter()
                .map(|row| row.base_price_id.clone()),
        );
        ids.extend(
            product
                .attribute_prices
                .iter()
                .map(|row| row.attribute_price_id.clone()),
        );
        ids.extend(
            product
                .legacy_body_prices
                .iter()
                .map(|row| row.product_price_id.clone()),
        );
        ids.extend(
            product
                .dimension_prices
                .iter()
                .map(|row| row.product_price_id.clone()),
        );
    }
    ids
}

fn format_decimal(value: i128) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let value = value.abs();
    let scale = 1_000_000_000_000_000_000_i128;
    let whole = value / scale;
    let fraction = format!("{:018}", value % scale);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    }
}

fn split_combined_prices(
    mut document: Document,
    manifest: &MigrationBases,
    bundle: Option<&Bundle>,
) -> Result<Document, String> {
    validate(&document)?;
    let mut occupied = all_price_ids(&document);
    let products = bundle.map(product_index).transpose()?;
    for product in &mut document.products {
        if product.pricing_mode == PricingMode::Table {
            let source = manifest
                .products
                .iter()
                .find(|row| row.product_id == product.product_id);
            let old_rows = std::mem::take(&mut product.legacy_body_prices);
            for row in old_rows {
                let Some(basis) = source.and_then(|source| {
                    source
                        .base_prices
                        .iter()
                        .find(|price| price.size_band_id == row.size_band_id)
                }) else {
                    product.legacy_body_prices.push(row);
                    continue;
                };
                let count = [&row.technique_id, &row.holo_film_id, &row.material_id]
                    .iter()
                    .filter(|id| id.is_some())
                    .count();
                if count > 1 || count == 0 && decimal(&row.unit_price) != decimal(&basis.unit_price)
                {
                    // No guessed baseline or approximate split: unresolved rows remain explicit.
                    product.legacy_body_prices.push(row);
                    continue;
                }
                if !product
                    .base_prices
                    .iter()
                    .any(|price| price.size_band_id == row.size_band_id)
                {
                    let mut base = basis.clone();
                    reserve_migrated_id(&mut base.base_price_id, &mut occupied);
                    product.base_prices.push(base);
                }
                if count == 1 {
                    product.attribute_prices.push(AttributePrice {
                        attribute_price_id: row.product_price_id,
                        technique_id: row.technique_id,
                        holo_film_id: row.holo_film_id,
                        material_id: row.material_id,
                        size_band_id: Some(row.size_band_id),
                        unit_price: format_decimal(
                            decimal(&row.unit_price).unwrap() - decimal(&basis.unit_price).unwrap(),
                        ),
                    });
                }
            }
        } else if product.pricing_mode == PricingMode::Fixed && product.fixed_unit_price.is_some() {
            let Some((bundle, source)) = bundle.zip(
                products
                    .as_ref()
                    .and_then(|products| products.get(product.product_id.as_str()).copied()),
            ) else {
                continue;
            };
            for (name, file, key) in [
                ("Technique", "techniques.json", "techniqueId"),
                ("Holo Film", "holo-films.json", "holoFilmId"),
                ("Material", "materials.json", "materialId"),
            ] {
                let Some(option) = option(source, name).filter(|option| active(Some(option)))
                else {
                    continue;
                };
                let values = bundle
                    .catalogs
                    .get(file)
                    .ok_or_else(|| error(format!("缺少 {file}")))?;
                for value in array(values, "values")? {
                    let id = entity_id(value, key)?;
                    if !enabled(option, key, id) {
                        continue;
                    }
                    let mut attribute_price_id =
                        format!("attribute-{}-{key}-{id}", product.product_id);
                    reserve_migrated_id(&mut attribute_price_id, &mut occupied);
                    product.attribute_prices.push(AttributePrice {
                        attribute_price_id,
                        technique_id: (key == "techniqueId").then(|| id.to_string()),
                        holo_film_id: (key == "holoFilmId").then(|| id.to_string()),
                        material_id: (key == "materialId").then(|| id.to_string()),
                        size_band_id: None,
                        unit_price: "0".into(),
                    });
                }
            }
        }
    }
    validate(&document)?;
    Ok(document)
}

fn validate_legacy_sizes(sizes: &[SizeBand]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for size in sizes {
        insert_id(&size.size_band_id, &mut ids, "旧尺寸档")?;
        if !valid_id(&size.label) {
            return Err(error("尺寸档名称不能为空或含首尾空白"));
        }
    }
    Ok(())
}

fn upgrade_v2(
    old: VersionTwoDocument,
    manifest: &MigrationBases,
    bundle: Option<&Bundle>,
) -> Result<Document, String> {
    if old.schema_version != 2 || old.currency != "USD" {
        return Err(error("旧价表版本或币种无效"));
    }
    validate_legacy_sizes(&old.size_bands)?;
    for product in &old.products {
        let mut ids = HashSet::new();
        for size in &product.size_band_ids {
            insert_id(size, &mut ids, "旧产品尺寸档")?;
        }
        if product.pricing_mode != PricingMode::Table && !product.size_band_ids.is_empty() {
            return Err(error("固定价和立牌配方不能包含尺寸档"));
        }
    }
    let document = Document {
        schema_version: 4,
        currency: old.currency,
        accessory_pricing: old.accessory_pricing,
        accessory_prices: old.accessory_prices,
        shared_attribute_prices: None,
        products: old
            .products
            .into_iter()
            .map(|product| ProductPricing {
                product_id: product.product_id,
                print_pricing: product.print_pricing,
                pricing_mode: product.pricing_mode,
                fixed_unit_price: product.fixed_unit_price,
                base_prices: vec![],
                attribute_prices: vec![],
                legacy_body_prices: product.body_prices,
                dimension_prices: product.dimension_prices,
            })
            .collect(),
    };
    split_combined_prices(document, manifest, bundle)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyBodyPrice {
    product_price_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    technique_id: Option<String>,
    size_band_id: String,
    unit_price: String,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum LegacyAccessoryPricing {
    Included,
    Style,
    Color,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyProduct {
    product_id: String,
    print_pricing: PrintPricing,
    body_prices: Vec<LegacyBodyPrice>,
    accessory_pricing: LegacyAccessoryPricing,
    accessory_prices: Vec<AccessoryPrice>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDocument {
    schema_version: u32,
    currency: String,
    size_bands: Vec<SizeBand>,
    products: Vec<LegacyProduct>,
}

fn reserve_migrated_id(id: &mut String, ids: &mut HashSet<String>) {
    if ids.insert(id.clone()) {
        return;
    }
    let base = id.clone();
    let mut n = 1;
    loop {
        let candidate = format!("migrated-{base}-{n}");
        if ids.insert(candidate.clone()) {
            *id = candidate;
            return;
        }
        n += 1;
    }
}
fn upgrade_legacy(
    legacy: LegacyDocument,
    seed: &Document,
    manifest: &MigrationBases,
    bundle: Option<&Bundle>,
) -> Result<Document, String> {
    if legacy.schema_version != 1 || legacy.currency != "USD" {
        return Err(error("旧价表版本或币种无效"));
    }
    validate_legacy_sizes(&legacy.size_bands)?;
    let mut document = Document {
        schema_version: 4,
        currency: legacy.currency,
        accessory_pricing: seed.accessory_pricing.clone(),
        accessory_prices: vec![],
        shared_attribute_prices: None,
        products: vec![],
    };
    let mut legacy_row_ids = HashSet::new();
    for old in legacy.products {
        // Validate discarded product-specific accessory rows before replacing them with the shared policy.
        let mut accessory_keys = HashSet::new();
        if old.accessory_pricing == LegacyAccessoryPricing::Included
            && !old.accessory_prices.is_empty()
        {
            return Err(error("旧价表包含重复配件收费"));
        }
        for row in &old.accessory_prices {
            if !valid_id(&row.accessory_price_id)
                || !legacy_row_ids.insert(row.accessory_price_id.clone())
                || !valid_id(&row.accessory_style_id)
                || row
                    .accessory_color_id
                    .as_ref()
                    .is_some_and(|id| !valid_id(id))
                || !accessory_keys.insert((&row.accessory_style_id, &row.accessory_color_id))
                || !valid_money(&row.unit_price)
                || old.accessory_pricing == LegacyAccessoryPricing::Style
                    && row.accessory_color_id.is_some()
                || old.accessory_pricing == LegacyAccessoryPricing::Color
                    && row.accessory_color_id.is_none()
            {
                return Err(error("旧价表配件行无效"));
            }
        }
        let mut body_prices = Vec::new();
        for row in old.body_prices {
            if !legacy_row_ids.insert(row.product_price_id.clone()) {
                return Err(error("旧价表价格行 ID 重复"));
            }
            body_prices.push(BodyPrice {
                product_price_id: row.product_price_id,
                technique_id: row.technique_id,
                holo_film_id: None,
                material_id: None,
                size_band_id: row.size_band_id,
                unit_price: row.unit_price,
            });
        }
        document.products.push(ProductPricing {
            product_id: old.product_id,
            print_pricing: old.print_pricing,
            pricing_mode: PricingMode::Table,
            fixed_unit_price: None,
            base_prices: vec![],
            attribute_prices: vec![],
            legacy_body_prices: body_prices,
            dimension_prices: vec![],
        });
    }
    validate(&document)?;
    document.accessory_prices = seed.accessory_prices.clone();
    for row in &mut document.accessory_prices {
        reserve_migrated_id(&mut row.accessory_price_id, &mut legacy_row_ids);
    }
    let mut document = split_combined_prices(document, manifest, bundle)?;
    let mut occupied = all_price_ids(&document);
    // Existing products own their edited/deleted cells; only entirely absent products are added.
    for product in &seed.products {
        if !document
            .products
            .iter()
            .any(|existing| existing.product_id == product.product_id)
        {
            let mut added = product.clone();
            for row in &mut added.base_prices {
                reserve_migrated_id(&mut row.base_price_id, &mut occupied);
            }
            for row in &mut added.attribute_prices {
                reserve_migrated_id(&mut row.attribute_price_id, &mut occupied);
            }
            for row in &mut added.legacy_body_prices {
                reserve_migrated_id(&mut row.product_price_id, &mut occupied);
            }
            for row in &mut added.dimension_prices {
                reserve_migrated_id(&mut row.product_price_id, &mut occupied);
            }
            document.products.push(added);
        }
    }
    validate(&document)?;
    Ok(document)
}
fn backup_legacy(directory: &Path, bytes: &[u8], version: u64) -> Result<(), String> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = directory.join(format!("product-pricing.v{version}-{digest}.json"));
    if path.exists() {
        if fs::read(&path).map_err(error)? != bytes {
            return Err(error("旧价表备份内容不符，未覆盖原文件"));
        }
        return Ok(());
    }
    let mut pending = tempfile::NamedTempFile::new_in(directory).map_err(error)?;
    pending.write_all(bytes).map_err(error)?;
    pending.flush().map_err(error)?;
    pending.as_file().sync_all().map_err(error)?;
    match pending.persist_noclobber(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if fs::read(&path).map_err(error)? == bytes {
                Ok(())
            } else {
                Err(error("旧价表备份冲突，未覆盖原文件"))
            }
        }
        Err(e) => Err(error(e.error)),
    }
}
fn decode_document(directory: &Path, bytes: &[u8], bundle: &Bundle) -> Result<Document, String> {
    let version: Value = serde_json::from_slice(bytes).map_err(error)?;
    let document = if version["schemaVersion"] == 1 {
        let legacy: LegacyDocument = serde_json::from_slice(bytes).map_err(error)?;
        let seed: Document = serde_json::from_str(SEED).map_err(error)?;
        validate(&seed)?;
        let migrated = upgrade_legacy(legacy, &seed, &migration_bases()?, Some(bundle))?;
        backup_legacy(directory, bytes, 1)?;
        migrated
    } else if version["schemaVersion"] == 2 {
        let legacy: VersionTwoDocument = serde_json::from_slice(bytes).map_err(error)?;
        let migrated = upgrade_v2(legacy, &migration_bases()?, Some(bundle))?;
        backup_legacy(directory, bytes, 2)?;
        migrated
    } else if version["schemaVersion"] == 3 {
        validate_legacy_sizes(
            &serde_json::from_value::<Vec<SizeBand>>(version["sizeBands"].clone())
                .map_err(error)?,
        )?;
        for product in array(&version, "products")? {
            let selected: Vec<String> =
                serde_json::from_value(product["sizeBandIds"].clone()).map_err(error)?;
            let mut ids = HashSet::new();
            for size in &selected {
                insert_id(size, &mut ids, "旧产品尺寸档")?;
            }
            if product["pricingMode"] != "table" && !selected.is_empty() {
                return Err(error("固定价和立牌配方不能包含尺寸档"));
            }
        }
        let mut migrated = version;
        migrated["schemaVersion"] = serde_json::json!(4);
        migrated.as_object_mut().unwrap().remove("sizeBands");
        for product in migrated["products"]
            .as_array_mut()
            .ok_or_else(|| error("products 必须是数组"))?
        {
            product
                .as_object_mut()
                .ok_or_else(|| error("产品定价必须是对象"))?
                .remove("sizeBandIds");
        }
        let migrated: Document = serde_json::from_value(migrated).map_err(error)?;
        validate(&migrated)?;
        backup_legacy(directory, bytes, 3)?;
        migrated
    } else {
        serde_json::from_slice(bytes).map_err(error)?
    };
    validate(&document)?;
    Ok(document)
}

fn read_existing(root: &Path) -> Result<Snapshot, String> {
    let directory = root.join("settings/product-pricing");
    let bytes = read_bytes(&directory.join(FILE_NAME), None)?;
    let mut hash = Sha256::new();
    hash_file(&mut hash, FILE_NAME, &bytes);
    let mut bundle = Bundle {
        main: Value::Null,
        catalogs: HashMap::new(),
    };
    for (file, seed) in PRODUCT_FILES {
        let path = root.join("settings/product-options").join(file);
        let (bytes, exists) = match fs::read(&path) {
            Ok(bytes) => (bytes, true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (seed.as_bytes().to_vec(), false),
            Err(e) => return Err(error(e)),
        };
        if bytes.len() > MAX_BYTES {
            return Err(error(format!("{} 超过 4MB", path.display())));
        }
        hash.update([u8::from(exists)]);
        hash_file(&mut hash, file, &bytes);
        let value: Value = serde_json::from_slice(&bytes).map_err(error)?;
        if !value.is_object() {
            return Err(error(format!("{file} 必须是对象")));
        }
        if file == "product-options.clean.json" {
            bundle.main = value;
            if !exists {
                crate::product_option_settings::remove_seed_size_options(&mut bundle.main);
            }
        } else {
            bundle.catalogs.insert(file.into(), value);
        }
    }
    crate::product_option_settings::strip_deprecated_option_rules(&mut bundle.main)?;
    crate::product_option_settings::complete_additional_attribute_options(&mut bundle.main)?;
    let has_default_quantity = bundle.catalogs["standee-quantities.json"]["values"]
        .as_array()
        .is_some_and(|values| {
            values
                .iter()
                .any(|value| value["standeeQuantityId"] == "SQ1")
        });
    crate::product_option_settings::complete_standee_quantity_options(
        &mut bundle.main,
        has_default_quantity,
    )?;
    let options_root = root.join("settings/product-options");
    let size_source = crate::product_option_settings::size_migration_source(&options_root)?;
    crate::product_option_settings::complete_size_options(
        &mut bundle.main,
        bundle.catalogs.get_mut("sizes.json").unwrap(),
        &size_source,
        !options_root.join("sizes.json").exists(),
    )?;
    product_index(&bundle)?;
    let document = decode_document(&directory, &bytes, &bundle)?;
    let bytes = read_bytes(
        &root.join("settings/quantity-pricing/quantity-pricing.json"),
        Some(QUANTITY_SEED),
    )?;
    hash_file(&mut hash, "quantity-pricing.json", &bytes);
    let quantity_pricing: Value = serde_json::from_slice(&bytes).map_err(error)?;
    if !quantity_pricing.is_object() {
        return Err(error("价格阶梯必须是对象"));
    }
    // References may become stale after editing options; retain them for explicit cleanup.
    Ok(Snapshot {
        document,
        bundle,
        quantity_pricing,
        version: format!("{:x}", hash.finalize()),
        directory: directory.to_string_lossy().into_owned(),
    })
}

fn read(root: &Path) -> Result<Snapshot, String> {
    let directory = root.join("settings/product-pricing");
    fs::create_dir_all(&directory).map_err(error)?;
    let path = directory.join(FILE_NAME);
    if !path.exists() {
        let document: Document = serde_json::from_str(SEED).map_err(error)?;
        validate(&document)?;
        let mut pending = tempfile::NamedTempFile::new_in(&directory).map_err(error)?;
        pending.write_all(SEED.as_bytes()).map_err(error)?;
        pending.flush().map_err(error)?;
        pending.as_file().sync_all().map_err(error)?;
        match pending.persist_noclobber(path) {
            Ok(_) => (),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(error(e.error)),
        }
    }
    read_existing(root)
}

fn save(root: &Path, document: Document, expected: &str) -> Result<Snapshot, String> {
    validate(&document)?;
    let mut bytes = serde_json::to_vec_pretty(&document).map_err(error)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(error("配置超过 4MB"));
    }
    let current = read_existing(root)?;
    let conflict = || error("产品定价、产品选项或价格阶梯已被修改，请保留草稿并刷新后重新保存");
    if current.version != expected {
        return Err(conflict());
    }
    // Persist the destination before deleting size metadata from the price file.
    // The option lock is independent; no option path acquires this pricing lock.
    crate::product_option_settings::persist_missing_size_options(
        &root.join("settings/product-options"),
    )?;
    let after_options = read_existing(root)?;
    if after_options.document != current.document
        || after_options.bundle != current.bundle
        || after_options.quantity_pricing != current.quantity_pricing
    {
        return Err(conflict());
    }
    let expected = after_options.version.as_str();
    validate_links(&document, &after_options.bundle)?;
    let directory = root.join("settings/product-pricing");
    let mut pending = tempfile::NamedTempFile::new_in(&directory).map_err(error)?;
    pending.write_all(&bytes).map_err(error)?;
    pending.flush().map_err(error)?;
    pending.as_file().sync_all().map_err(error)?;
    if read_existing(root)?.version != expected {
        return Err(conflict());
    }
    if current.document.schema_version == 4 && document.schema_version == 5 {
        // Public-price consolidation retains the original local rows for recovery.
        let original = read_bytes(&directory.join(FILE_NAME), None)?;
        let original_document: Value = serde_json::from_slice(&original).map_err(error)?;
        if original_document["schemaVersion"] == 4 {
            backup_legacy(&directory, &original, 4)?;
        }
        if read_existing(root)?.version != expected {
            return Err(conflict());
        }
    }
    pending
        .persist(directory.join(FILE_NAME))
        .map_err(|e| error(format!("保存失败，原配置已保留：{}", e.error)))?;
    read_existing(root)
}

#[tauri::command]
pub async fn load_product_pricing_settings() -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = LOCK.lock().map_err(error)?;
        read(&crate::project_data_dir())
    })
    .await
    .map_err(error)?
}

#[tauri::command]
pub async fn save_product_pricing_settings(
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
        serde_json::from_value(json!({"schemaVersion":4,"currency":"USD",
            "accessoryPricing":"style",
            "accessoryPrices":[{"accessoryPriceId":"a1","accessoryStyleId":"P8","accessoryColorId":null,"unitPrice":"0.30"}],
            "products":[{"productId":"P31","printPricing":"included","pricingMode":"table","fixedUnitPrice":null,
                "basePrices":[],"attributePrices":[],"legacyBodyPrices":[{"productPriceId":"b1","techniqueId":"G11","holoFilmId":null,"materialId":null,"sizeBandId":"s2","unitPrice":"3.020408163265306"}],"dimensionPrices":[]}]})).unwrap()
    }
    fn bundle() -> Bundle {
        Bundle {
            main: json!({"categories":[{"products":[{"productId":"P31","productOptions":[
            {"name":"Technique","deleted":false},{"name":"Holo Film","deleted":true},{"name":"Material","deleted":true},
            {"name":"Accessories Style","deleted":true,"disabledValues":[{"accessoryStyleId":"P8"}]},{"name":"Size","deleted":false}]}]}],"uncategorizedProducts":[]}),
            catalogs: HashMap::from([
                ("sizes.json".into(), json!({"values":[{"sizeBandId":"s2"}]})),
                (
                    "techniques.json".into(),
                    json!({"values":[{"techniqueId":"G11"}]}),
                ),
                (
                    "holo-films.json".into(),
                    json!({"values":[{"holoFilmId":"M1"}]}),
                ),
                (
                    "materials.json".into(),
                    json!({"values":[{"materialId":"C1"}]}),
                ),
                (
                    "accessory-styles.json".into(),
                    json!({"values":[{"accessoryStyleId":"P8","colors":[{"accessoryColorId":"P-C1"}]},{"accessoryStyleId":"P9","colors":[{"accessoryColorId":"P-C2"}]}]}),
                ),
            ]),
        }
    }
    fn assembly() -> Document {
        let mut document = sample();
        let product = &mut document.products[0];
        product.pricing_mode = PricingMode::Standee;
        product.legacy_body_prices.clear();
        product.dimension_prices = serde_json::from_value(json!([{"productPriceId":"d1","techniqueId":"G11","holoFilmId":null,"materialId":null,"baseUnitPrice":"2.41","panels":[
            {"panelId":"panel1","label":"立牌片","baseAdjustment":"-2.68","pieceBands":[
                {"rangeId":"r1","minMm":"35","maxMm":"49","kind":"fixed","amount":"2.41","coefficient":"0"},
                {"rangeId":"r2","minMm":"50","maxMm":"380","kind":"area","amount":"0.4638","coefficient":"0.000279155"}],
             "baseBands":[{"rangeId":"r3","minMm":"35","maxMm":"380","kind":"area","amount":"0.4638","coefficient":"0.000279155"}]}]}])).unwrap();
        document
    }
    fn legacy() -> Value {
        json!({"schemaVersion":1,"currency":"USD","sizeBands":[{"sizeBandId":"s2","label":"我的尺寸"}],
        "products":[{"productId":"P31","printPricing":"included","bodyPrices":[{"productPriceId":"edited","techniqueId":"G11","sizeBandId":"s2","unitPrice":"7.123456789012345678"}],
            "accessoryPricing":"style","accessoryPrices":[{"accessoryPriceId":"old-a","accessoryStyleId":"P8","accessoryColorId":null,"unitPrice":"0"}]}]})
    }
    fn write(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn price_path(root: &Path) -> std::path::PathBuf {
        root.join("settings/product-pricing/product-pricing.json")
    }

    fn write_legacy_product_options(root: &Path) {
        let mut main: Value = serde_json::from_str(PRODUCT_FILES[0].1).unwrap();
        crate::product_option_settings::remove_seed_size_options(&mut main);
        for product in main["categories"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .flat_map(|category| category["products"].as_array_mut().unwrap())
        {
            if product["productId"] == "P31" {
                for option in product["productOptions"].as_array_mut().unwrap() {
                    if option["name"] == "Holo Film" {
                        option["deleted"] = json!(true);
                    }
                }
            }
        }
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &serde_json::to_vec(&main).unwrap(),
        );
    }
    fn read_sample(root: &Path) -> Snapshot {
        write_legacy_product_options(root);
        let mut old = serde_json::to_value(sample()).unwrap();
        old["schemaVersion"] = json!(3);
        old["sizeBands"] = json!([{"sizeBandId":"s2","label":"2 英寸"}]);
        old["products"][0]["sizeBandIds"] = json!(["s2"]);
        write(
            root,
            "settings/product-pricing/product-pricing.json",
            &serde_json::to_vec(&old).unwrap(),
        );
        read(root).unwrap()
    }

    fn separate_sample() -> Document {
        let mut document = sample();
        let product = &mut document.products[0];
        product.legacy_body_prices.clear();
        product.base_prices = vec![BasePrice {
            base_price_id: "base1".into(),
            size_band_id: "s2".into(),
            unit_price: "2.5".into(),
        }];
        product.attribute_prices = vec![AttributePrice {
            attribute_price_id: "attribute1".into(),
            technique_id: Some("G11".into()),
            holo_film_id: None,
            material_id: None,
            size_band_id: Some("s2".into()),
            unit_price: "0.520408163265306".into(),
        }];
        document
    }

    fn version_two() -> Value {
        let mut value = serde_json::to_value(sample()).unwrap();
        value["schemaVersion"] = json!(2);
        value["sizeBands"] = json!([{"sizeBandId":"s2","label":"2 英寸"}]);
        value["products"][0]["sizeBandIds"] = json!(["s2"]);
        let product = value["products"][0].as_object_mut().unwrap();
        let rows = product.remove("legacyBodyPrices").unwrap();
        product.insert("bodyPrices".into(), rows);
        product.remove("basePrices");
        product.remove("attributePrices");
        value
    }

    fn shared_sample() -> Document {
        let mut document = separate_sample();
        let attribute = document.products[0].attribute_prices.remove(0);
        document.schema_version = 5;
        document.shared_attribute_prices = Some(vec![SharedAttributePrice {
            shared_attribute_price_id: attribute.attribute_price_id,
            technique_id: attribute.technique_id,
            holo_film_id: attribute.holo_film_id,
            size_band_id: attribute.size_band_id,
            unit_price: attribute.unit_price,
        }]);
        document
    }

    #[test]
    fn schema_five_shared_prices_require_explicit_keys_unique_dimensions_and_catalog_links() {
        let document = shared_sample();
        validate(&document).unwrap();
        validate_links(&document, &bundle()).unwrap();
        let encoded = serde_json::to_value(&document).unwrap();
        assert_eq!(
            encoded["sharedAttributePrices"][0]["unitPrice"],
            "0.520408163265306"
        );
        for field in [
            "sharedAttributePriceId",
            "techniqueId",
            "holoFilmId",
            "sizeBandId",
            "unitPrice",
        ] {
            let mut missing = encoded.clone();
            missing["sharedAttributePrices"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(serde_json::from_value::<Document>(missing).is_err());
        }
        let mut missing = document.clone();
        missing.shared_attribute_prices = None;
        assert!(validate(&missing).is_err());
        let mut null = encoded.clone();
        null["sharedAttributePrices"] = Value::Null;
        assert!(serde_json::from_value::<Document>(null).is_err());
        let mut unknown = encoded;
        unknown["sharedAttributePrices"][0]["productId"] = json!("P31");
        assert!(serde_json::from_value::<Document>(unknown).is_err());
        let mut duplicate = document.clone();
        let mut duplicate_row = duplicate.shared_attribute_prices.as_ref().unwrap()[0].clone();
        duplicate_row.shared_attribute_price_id = "second-row".into();
        duplicate
            .shared_attribute_prices
            .as_mut()
            .unwrap()
            .push(duplicate_row);
        assert!(validate(&duplicate).is_err());
        let mut local_override = document.clone();
        local_override.products[0].attribute_prices =
            separate_sample().products[0].attribute_prices.clone();
        assert!(validate(&local_override).is_err());
        let mut disabled = bundle();
        disabled.main["categories"][0]["products"][0]["productOptions"][0]["deleted"] = json!(true);
        validate_links(&document, &disabled).unwrap();
        let mut stale = document;
        stale.shared_attribute_prices.as_mut().unwrap()[0].size_band_id =
            Some("missing-size".into());
        assert!(validate_links(&stale, &bundle()).is_err());
        stale.shared_attribute_prices.as_mut().unwrap()[0].size_band_id = None;
        validate(&stale).unwrap();
        validate_links(&stale, &bundle()).unwrap();
    }

    #[test]
    fn first_shared_price_save_preserves_version_four_bytes_and_roundtrips_exact_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read_sample(root);
        let old = save(root, separate_sample(), &loaded.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let next = shared_sample();
        let saved = save(root, next.clone(), &old.version).unwrap();
        assert_eq!(saved.document, next);
        assert_eq!(read(root).unwrap().document, next);
        let backup = fs::read_dir(price_path(root).parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().contains("v4"))
            .unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        let mut edited = next;
        edited.shared_attribute_prices.as_mut().unwrap()[0].unit_price =
            "0.123456789012345678".into();
        let updated = save(root, edited.clone(), &saved.version).unwrap();
        assert_eq!(updated.document, edited);
        assert_eq!(fs::read(backup).unwrap(), original);
        assert!(save(root, edited, &old.version)
            .unwrap_err()
            .contains("已被修改"));
    }

    fn basis() -> MigrationBases {
        serde_json::from_value(json!({"schemaVersion":1,"products":[{
            "productId":"P31","basePrices":[{"basePriceId":"base-P31-s2","sizeBandId":"s2","unitPrice":"2.5"}]
        }]})).unwrap()
    }

    #[test]
    fn schema_three_separates_basic_and_one_attribute_price_with_exact_signed_amounts() {
        let mut document = separate_sample();
        validate(&document).unwrap();
        validate_links(&document, &bundle()).unwrap();
        document.products[0].attribute_prices[0].unit_price = "-0.000000000000000001".into();
        validate(&document).unwrap();
        for invalid in [
            "-01",
            "--1",
            "-1e2",
            "-1000000000",
            "-0.1234567890123456789",
        ] {
            document.products[0].attribute_prices[0].unit_price = invalid.into();
            assert!(validate(&document).is_err(), "{invalid}");
        }
        let mut document = separate_sample();
        document.products[0].base_prices[0].unit_price = "-1".into();
        assert!(validate(&document).is_err());
        let mut document = separate_sample();
        document.products[0].attribute_prices[0].holo_film_id = Some("M1".into());
        assert!(validate(&document).is_err());
        document.products[0].attribute_prices[0].holo_film_id = None;
        document.products[0].attribute_prices[0].technique_id = None;
        assert!(validate(&document).is_err());
        let mut document = separate_sample();
        document.products[0].attribute_prices[0].size_band_id = None;
        assert!(validate(&document).is_err());
        let mut document = separate_sample();
        let mut duplicate = document.products[0].base_prices[0].clone();
        duplicate.base_price_id = "base2".into();
        document.products[0].base_prices.push(duplicate);
        assert!(validate(&document).is_err());
        let mut document = separate_sample();
        let mut duplicate = document.products[0].attribute_prices[0].clone();
        duplicate.attribute_price_id = "attribute2".into();
        document.products[0].attribute_prices.push(duplicate);
        assert!(validate(&document).is_err());
        let mut document = separate_sample();
        document.products[0].base_prices[0].base_price_id = "attribute1".into();
        assert!(validate(&document).is_err());
    }

    #[test]
    fn schema_three_requires_explicit_attribute_ids_and_rejects_old_or_generic_fields() {
        for key in [
            "techniqueId",
            "holoFilmId",
            "materialId",
            "sizeBandId",
            "unitPrice",
        ] {
            let mut value = serde_json::to_value(separate_sample()).unwrap();
            value["products"][0]["attributePrices"][0]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(serde_json::from_value::<Document>(value).is_err(), "{key}");
        }
        for pointer in ["/products/0/basePrices/0", "/products/0/attributePrices/0"] {
            let mut value = serde_json::to_value(separate_sample()).unwrap();
            value.pointer_mut(pointer).unwrap()["id"] = json!("P1");
            assert!(serde_json::from_value::<Document>(value).is_err());
        }
        let mut value = serde_json::to_value(separate_sample()).unwrap();
        value["products"][0]["bodyPrices"] = json!([]);
        assert!(serde_json::from_value::<Document>(value).is_err());
        let mut document = separate_sample();
        document.products[0].base_prices[0].size_band_id = "other-product-size".into();
        assert!(validate_links(&document, &bundle()).is_err());
    }

    #[test]
    fn attribute_references_validate_only_their_own_enabled_dimension() {
        let mut source = bundle();
        source.main["categories"][0]["products"][0]["productOptions"][1]["deleted"] = json!(false);
        let mut document = separate_sample();
        validate_links(&document, &source).unwrap();
        document.products[0].attribute_prices.push(AttributePrice {
            attribute_price_id: "film1".into(),
            technique_id: None,
            holo_film_id: Some("M1".into()),
            material_id: None,
            size_band_id: Some("s2".into()),
            unit_price: "0".into(),
        });
        validate_links(&document, &source).unwrap();
        source.main["categories"][0]["products"][0]["optionRules"] = json!([
            {"when":{"option":"Technique","value":{"techniqueId":"G11"}},
            "hide":[{"option":"Holo Film","values":[{"holoFilmId":"M1"}]}]}
        ]);
        validate_links(&document, &source).unwrap();
        source.main["categories"][0]["products"][0]["productOptions"][1]["disabledValues"] =
            json!([{"holoFilmId":"M1"}]);
        assert!(validate_links(&document, &source).is_err());
        document.products[0].attribute_prices.pop();
        validate_links(&document, &source).unwrap();
    }

    #[test]
    fn v2_migration_uses_only_audited_bases_and_preserves_edited_exact_totals() {
        let mut old = version_two();
        old["products"][0]["bodyPrices"][0]["unitPrice"] = json!("2.000000000000000001");
        old["products"][0]["bodyPrices"][0]["productPriceId"] = json!("base-P31-s2");
        let document = upgrade_v2(serde_json::from_value(old).unwrap(), &basis(), None).unwrap();
        let product = &document.products[0];
        assert_eq!(
            product.base_prices[0].base_price_id,
            "migrated-base-P31-s2-1"
        );
        assert_eq!(product.base_prices[0].unit_price, "2.5");
        assert_eq!(
            product.attribute_prices[0].attribute_price_id,
            "base-P31-s2"
        );
        assert_eq!(
            product.attribute_prices[0].unit_price,
            "-0.499999999999999999"
        );
        assert!(product.legacy_body_prices.is_empty());
        assert_eq!(document.products.len(), 1);
        let mut old = version_two();
        old["products"][0]["bodyPrices"] = json!([]);
        let empty = upgrade_v2(serde_json::from_value(old).unwrap(), &basis(), None).unwrap();
        assert!(empty.products[0].base_prices.is_empty());
        assert!(empty.products[0].attribute_prices.is_empty());
    }

    #[test]
    fn v2_unknown_sizes_and_multiple_attributes_remain_explicit_legacy_rows() {
        let mut old = version_two();
        let mut unknown = old["products"][0]["bodyPrices"][0].clone();
        unknown["productPriceId"] = json!("unknown");
        unknown["sizeBandId"] = json!("custom");
        let mut multiple = old["products"][0]["bodyPrices"][0].clone();
        multiple["productPriceId"] = json!("multiple");
        multiple["holoFilmId"] = json!("M1");
        old["products"][0]["bodyPrices"]
            .as_array_mut()
            .unwrap()
            .extend([unknown.clone(), multiple.clone()]);
        let document = upgrade_v2(serde_json::from_value(old).unwrap(), &basis(), None).unwrap();
        let product = &document.products[0];
        assert_eq!(product.base_prices.len(), 1);
        assert_eq!(product.attribute_prices.len(), 1);
        assert_eq!(
            serde_json::to_value(&product.legacy_body_prices).unwrap(),
            json!([unknown, multiple])
        );
        let mut old = version_two();
        old["products"][0]["bodyPrices"][0]["techniqueId"] = Value::Null;
        old["products"][0]["bodyPrices"][0]["unitPrice"] = json!("2.500");
        let document =
            upgrade_v2(serde_json::from_value(old.clone()).unwrap(), &basis(), None).unwrap();
        assert!(document.products[0].legacy_body_prices.is_empty());
        assert!(document.products[0].attribute_prices.is_empty());
        old["products"][0]["bodyPrices"][0]["unitPrice"] = json!("2.6");
        let document = upgrade_v2(serde_json::from_value(old).unwrap(), &basis(), None).unwrap();
        assert_eq!(document.products[0].legacy_body_prices[0].unit_price, "2.6");
        assert!(document.products[0].base_prices.is_empty());
    }

    #[test]
    fn fixed_migration_adds_explicit_zero_attributes_only_when_priced() {
        let mut old = version_two();
        old["products"][0]["pricingMode"] = json!("fixed");
        old["products"][0]["fixedUnitPrice"] = json!("0");
        old["products"][0]["bodyPrices"] = json!([]);
        old["products"][0]["sizeBandIds"] = json!([]);
        let document = upgrade_v2(
            serde_json::from_value(old.clone()).unwrap(),
            &basis(),
            Some(&bundle()),
        )
        .unwrap();
        assert_eq!(document.products[0].attribute_prices.len(), 1);
        assert_eq!(
            document.products[0].attribute_prices[0].attribute_price_id,
            "attribute-P31-techniqueId-G11"
        );
        assert_eq!(document.products[0].attribute_prices[0].unit_price, "0");
        assert_eq!(document.products[0].attribute_prices[0].size_band_id, None);
        validate_links(&document, &bundle()).unwrap();
        old["products"][0]["fixedUnitPrice"] = Value::Null;
        let document = upgrade_v2(
            serde_json::from_value(old).unwrap(),
            &basis(),
            Some(&bundle()),
        )
        .unwrap();
        assert!(document.products[0].attribute_prices.is_empty());
    }

    #[test]
    fn v2_read_backs_up_original_bytes_and_waits_for_save_before_replacing() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut old = version_two();
        let audited = migration_bases().unwrap();
        let basis = &audited
            .products
            .iter()
            .find(|p| p.product_id == "P31")
            .unwrap()
            .base_prices[0];
        old["sizeBands"][0]["sizeBandId"] = json!(basis.size_band_id);
        old["products"][0]["sizeBandIds"] = json!([basis.size_band_id]);
        old["products"][0]["bodyPrices"][0]["sizeBandId"] = json!(basis.size_band_id);
        let raw = serde_json::to_vec_pretty(&old).unwrap();
        write(root, "settings/product-pricing/product-pricing.json", &raw);
        let loaded = read(root).unwrap();
        assert_eq!(loaded.document.schema_version, 4);
        assert_eq!(loaded.document.products.len(), 1);
        assert!(loaded.document.products[0].legacy_body_prices.is_empty());
        assert_eq!(fs::read(price_path(root)).unwrap(), raw);
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v2-{:x}.json",
            Sha256::digest(&raw)
        ));
        assert_eq!(fs::read(&backup).unwrap(), raw);
        let repeated = read(root).unwrap();
        assert_eq!(repeated.version, loaded.version);
        assert_eq!(repeated.document, loaded.document);
        let saved = save(root, loaded.document.clone(), &loaded.version).unwrap();
        assert_ne!(saved.version, loaded.version);
        assert_eq!(saved.document, loaded.document);
        assert_eq!(fs::read(&backup).unwrap(), raw);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(price_path(root)).unwrap()).unwrap()
                ["schemaVersion"],
            4
        );
        assert!(save(root, saved.document, &loaded.version)
            .unwrap_err()
            .contains("已被修改"));
    }
    #[test]
    fn v1_shared_accessory_ids_are_reserved_before_creating_audited_bases() {
        let mut defaults = sample();
        defaults.accessory_prices[0].accessory_price_id = "base-P31-s2".into();
        let upgraded = upgrade_legacy(
            serde_json::from_value(legacy()).unwrap(),
            &defaults,
            &basis(),
            None,
        )
        .unwrap();
        assert_eq!(
            upgraded.accessory_prices[0].accessory_price_id,
            "base-P31-s2"
        );
        assert_eq!(
            upgraded.products[0].base_prices[0].base_price_id,
            "migrated-base-P31-s2-1"
        );
        assert_eq!(
            upgraded.products[0].attribute_prices[0].attribute_price_id,
            "edited"
        );
        assert_eq!(
            upgraded.products[0].attribute_prices[0].unit_price,
            "4.623456789012345678"
        );
    }

    #[test]
    fn seed_roundtrip_preserves_precision_and_persists_size_ownership_before_save() {
        let directory = tempfile::tempdir().unwrap();
        let loaded = read(directory.path()).unwrap();
        validate_links(&loaded.document, &loaded.bundle).unwrap();
        assert_eq!(loaded.document.schema_version, 4);
        assert!(!directory.path().join("settings/product-options").exists());
        let mut edited = loaded.document;
        let product = edited
            .products
            .iter_mut()
            .find(|product| !product.base_prices.is_empty())
            .unwrap();
        product.base_prices[0].unit_price = "3.020408163265306".into();
        let saved = save(directory.path(), edited.clone(), &loaded.version).unwrap();
        assert_eq!(saved.document, edited);
        assert_eq!(read_existing(directory.path()).unwrap().document, edited);
        let wire = serde_json::to_value(saved).unwrap();
        assert!(wire["quantityPricing"]["categoryRules"].is_array());
        assert_eq!(
            wire["bundle"]["catalogs"].as_object().unwrap().len(),
            PRODUCT_FILES.len() - 1
        );
        assert!(directory
            .path()
            .join("settings/product-options/sizes.json")
            .exists());
        assert!(!directory.path().join("settings/quantity-pricing").exists());
    }
    #[test]
    fn amounts_and_dimensions_use_exact_bounded_decimals() {
        for value in [
            "0",
            "0.00",
            "123456789.123456789012345678",
            "0.000000000000000001",
        ] {
            assert!(valid_money(value));
        }
        for value in [
            "",
            "-1",
            "+1",
            "01",
            ".5",
            "1.",
            "1e2",
            "NaN",
            "1.2.3",
            "1000000000",
            "0.1234567890123456789",
            " 1",
        ] {
            assert!(!valid_money(value), "{value}");
        }
        assert!(valid_adjustment("-2.68"));
        assert!(valid_adjustment("-0"));
        assert!(!valid_adjustment("--1"));
        assert_ne!(decimal("49.000000000000000001"), decimal("49"));
        let mut document = assembly();
        validate(&document).unwrap();
        document.products[0].dimension_prices[0].panels[0].piece_bands[1].min_mm =
            "49.000000000000000001".into();
        validate(&document).unwrap();
        document.products[0].dimension_prices[0].panels[0].piece_bands[1].min_mm = "49".into();
        assert!(validate(&document).is_err());
        document.products[0].dimension_prices[0].panels[0].piece_bands[1].min_mm = "0".into();
        assert!(validate(&document).is_err());
        let mut document = assembly();
        document.products[0].dimension_prices[0].panels[0].piece_bands[0].coefficient = "1".into();
        assert!(validate(&document).is_err());
    }
    #[test]
    fn fixed_null_is_unpriced_and_modes_cannot_mix() {
        let mut document = sample();
        let product = &mut document.products[0];
        product.pricing_mode = PricingMode::Fixed;
        assert!(validate(&document).is_err());
        document.products[0].legacy_body_prices.clear();
        validate(&document).unwrap();
        document.products[0].fixed_unit_price = Some("0".into());
        validate(&document).unwrap();
        document.products[0].fixed_unit_price = Some("".into());
        assert!(validate(&document).is_err());
        let mut document = sample();
        document.products[0].legacy_body_prices.clear();
        validate(&document).unwrap();
        let mut document = assembly();
        document.products[0].base_prices.push(BasePrice {
            base_price_id: "illegal-base".into(),
            size_band_id: "s2".into(),
            unit_price: "0".into(),
        });
        assert!(validate(&document).is_err());
        let mut document = assembly();
        document.products[0].dimension_prices[0].panels.clear();
        assert!(validate(&document).is_err());
    }
    #[test]
    fn schema_requires_all_explicit_nullable_fields_and_rejects_unknowns() {
        for key in ["techniqueId", "holoFilmId", "materialId", "unitPrice"] {
            let mut value = serde_json::to_value(sample()).unwrap();
            value["products"][0]["legacyBodyPrices"][0]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(serde_json::from_value::<Document>(value).is_err(), "{key}");
        }
        let mut value = serde_json::to_value(sample()).unwrap();
        value["products"][0]
            .as_object_mut()
            .unwrap()
            .remove("fixedUnitPrice");
        assert!(serde_json::from_value::<Document>(value).is_err());
        let mut value = serde_json::to_value(sample()).unwrap();
        value["accessoryPrices"][0]
            .as_object_mut()
            .unwrap()
            .remove("accessoryColorId");
        assert!(serde_json::from_value::<Document>(value).is_err());
        let mut value = serde_json::to_value(sample()).unwrap();
        value["products"][0]["legacyBodyPrices"][0]["unitPrice"] = json!(3.02);
        assert!(serde_json::from_value::<Document>(value).is_err());
        for pointer in [
            "",
            "/products/0",
            "/products/0/dimensionPrices/0",
            "/products/0/dimensionPrices/0/panels/0",
            "/products/0/dimensionPrices/0/panels/0/pieceBands/0",
            "/accessoryPrices/0",
        ] {
            let mut value = serde_json::to_value(assembly()).unwrap();
            value.pointer_mut(pointer).unwrap()["id"] = json!("ambiguous");
            assert!(
                serde_json::from_value::<Document>(value).is_err(),
                "{pointer}"
            );
        }
    }
    #[test]
    fn duplicate_ids_and_three_dimensional_price_keys_are_rejected() {
        let mut document = sample();
        document.accessory_prices[0].accessory_price_id = "b1".into();
        assert!(validate(&document).is_err());
        let mut document = sample();
        let mut row = document.products[0].legacy_body_prices[0].clone();
        row.product_price_id = "b2".into();
        document.products[0].legacy_body_prices.push(row);
        assert!(validate(&document).is_err());
        document.products[0].legacy_body_prices[1].holo_film_id = Some("M1".into());
        validate(&document).unwrap();
        let mut document = assembly();
        let row = document.products[0].dimension_prices[0].panels[0].piece_bands[0].clone();
        document.products[0].dimension_prices[0].panels[0]
            .base_bands
            .push(row);
        assert!(validate(&document).is_err());
        let mut document = assembly();
        let panel = document.products[0].dimension_prices[0].panels[0].clone();
        document.products[0].dimension_prices[0].panels.push(panel);
        assert!(validate(&document).is_err());
    }
    #[test]
    fn enabled_three_entity_dimensions_and_product_sizes_are_verified() {
        validate_links(&sample(), &bundle()).unwrap();
        for (index, key, id) in [
            (0, "techniqueId", "G11"),
            (1, "holoFilmId", "M1"),
            (2, "materialId", "C1"),
        ] {
            let mut source = bundle();
            let mut document = sample();
            source.main["categories"][0]["products"][0]["productOptions"][index]["deleted"] =
                json!(false);
            match index {
                1 => document.products[0].legacy_body_prices[0].holo_film_id = Some(id.into()),
                2 => document.products[0].legacy_body_prices[0].material_id = Some(id.into()),
                _ => (),
            };
            validate_links(&document, &source).unwrap();
            source.main["categories"][0]["products"][0]["productOptions"][index]
                ["disabledValues"] = json!([{key:id}]);
            assert!(validate_links(&document, &source).is_err());
        }
        let mut source = bundle();
        source.catalogs.get_mut("holo-films.json").unwrap()["values"][0] =
            json!({"techniqueId":"M1"});
        assert!(validate_links(&sample(), &source).is_err());
        let mut source = bundle();
        source.main["categories"][0]["products"][0]["productOptions"][4]["disabledValues"] =
            json!([{"sizeBandId":"s2"}]);
        assert!(validate_links(&sample(), &source).is_err());
        let mut document = sample();
        document.products[0].legacy_body_prices[0].technique_id = None;
        assert!(validate_links(&document, &bundle()).is_err());
    }
    #[test]
    fn enabled_dimensions_require_selection_and_disabled_values_remain_invalid() {
        let mut source = bundle();
        source.main["categories"][0]["products"][0]["productOptions"][1]["deleted"] = json!(false);
        source.main["categories"][0]["products"][0]["optionRules"] = json!([
            {"when":{"option":"Technique","value":{"techniqueId":"G11"}},
             "hide":[{"option":"Holo Film","values":[{"holoFilmId":"M1"}]}]}
        ]);
        let mut document = sample();
        assert!(validate_links(&document, &source).is_err());
        document.products[0].legacy_body_prices[0].holo_film_id = Some("M1".into());
        validate_links(&document, &source).unwrap();
        source.catalogs.get_mut("holo-films.json").unwrap()["values"] =
            json!([{"holoFilmId":"M1"},{"holoFilmId":"M2"}]);
        document.products[0].legacy_body_prices[0].holo_film_id = None;
        assert!(validate_links(&document, &source).is_err());
        document.products[0].legacy_body_prices[0].holo_film_id = Some("M2".into());
        validate_links(&document, &source).unwrap();
        source.main["categories"][0]["products"][0]["productOptions"][1]["disabledValues"] =
            json!([{"holoFilmId":"M2"}]);
        assert!(validate_links(&document, &source).is_err());
        document.products[0].legacy_body_prices[0].holo_film_id = None;
        assert!(validate_links(&document, &source).is_err());
        source.main["categories"][0]["products"][0]["productOptions"][1]["disabledValues"] =
            json!([{"holoFilmId":"M1"},{"holoFilmId":"M2"}]);
        assert!(validate_links(&document, &source).is_err());
        source.main["categories"][0]["products"][0]["productOptions"][1]["deleted"] = json!(true);
        validate_links(&document, &source).unwrap();
    }
    #[test]
    fn legacy_rules_do_not_change_enabled_price_dimensions() {
        let mut source = bundle();
        let product = &mut source.main["categories"][0]["products"][0];
        product["productOptions"][1]["deleted"] = json!(false);
        product["optionRules"] = json!([
            {"when":{"option":"Technique","value":{"techniqueId":"G11"}},
             "hide":[{"option":"Holo Film","values":[{"holoFilmId":"M1"}]}]},
            {"when":{"option":"Holo Film","value":{"holoFilmId":"M1"}},
             "hide":[{"option":"Technique","values":[{"techniqueId":"G11"}]}]}
        ]);
        let mut document = sample();
        document.products[0].legacy_body_prices[0].holo_film_id = Some("M1".into());
        validate_links(&document, &source).unwrap();
        source.main["categories"][0]["products"][0]["productOptions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"Print Option","deleted":false}));
        source.catalogs.insert(
            "print-options.json".into(),
            json!({"values":[{"printOptionId":"Y1","isDefault":true}]}),
        );
        source.main["categories"][0]["products"][0]["optionRules"] = json!([
            {"when":{"option":"Print Option","value":{"printOptionId":"Y1"}},
             "hide":[{"option":"Holo Film","values":[{"holoFilmId":"M1"}]}]}
        ]);
        document.products[0].legacy_body_prices[0].holo_film_id = None;
        assert!(validate_links(&document, &source).is_err());
        document.products[0].legacy_body_prices[0].holo_film_id = Some("M1".into());
        validate_links(&document, &source).unwrap();
        source.main["categories"][0]["products"][0]["optionRules"] = json!("deprecated");
        validate_links(&document, &source).unwrap();
    }
    #[test]
    fn common_accessories_ignore_product_switches_but_require_real_parent_child() {
        validate_links(&sample(), &bundle()).unwrap();
        let mut document = sample();
        document.accessory_pricing = AccessoryPricing::Color;
        document.accessory_prices[0].accessory_color_id = Some("P-C1".into());
        validate(&document).unwrap();
        validate_links(&document, &bundle()).unwrap();
        document.accessory_prices[0].accessory_color_id = Some("P-C2".into());
        assert!(validate_links(&document, &bundle()).is_err());
        document.accessory_prices[0].accessory_color_id = None;
        assert!(validate(&document).is_err());
    }
    #[test]
    fn legacy_migration_preserves_user_ids_when_new_defaults_conflict() {
        let mut defaults = sample();
        let mut added = defaults.products[0].clone();
        added.product_id = "P36".into();
        added.legacy_body_prices[0].product_price_id = "edited".into();
        defaults.products.push(added);
        // Seed rows are unique but can independently collide with user-authored IDs.
        defaults.accessory_prices[0].accessory_price_id = "edited-accessory".into();
        let mut old = legacy();
        let mut second = old["products"][0]["bodyPrices"][0].clone();
        second["productPriceId"] = json!("edited-accessory");
        second["techniqueId"] = json!("G12");
        old["products"][0]["bodyPrices"]
            .as_array_mut()
            .unwrap()
            .push(second);
        validate(&defaults).unwrap();
        let upgraded = upgrade_legacy(
            serde_json::from_value(old).unwrap(),
            &defaults,
            &migration_bases().unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(
            upgraded.products[0].legacy_body_prices[0].product_price_id,
            "edited"
        );
        assert_eq!(
            upgraded.products[0].legacy_body_prices[1].product_price_id,
            "edited-accessory"
        );
        assert_eq!(
            upgraded.accessory_prices[0].accessory_price_id,
            "migrated-edited-accessory-1"
        );
        assert_eq!(
            upgraded.products[1].legacy_body_prices[0].product_price_id,
            "migrated-edited-1"
        );
        validate(&upgraded).unwrap();
    }
    #[test]
    fn legacy_load_backs_up_original_and_preserves_edits_and_deleted_cells() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write_legacy_product_options(root);
        let raw = serde_json::to_vec_pretty(&legacy()).unwrap();
        write(root, "settings/product-pricing/product-pricing.json", &raw);
        let loaded = read(root).unwrap();
        assert_eq!(fs::read(price_path(root)).unwrap(), raw);
        let current = loaded
            .document
            .products
            .iter()
            .find(|p| p.product_id == "P31")
            .unwrap();
        assert_eq!(current.legacy_body_prices.len(), 1);
        assert_eq!(
            current.legacy_body_prices[0].unit_price,
            "7.123456789012345678"
        );
        let seed: Document = serde_json::from_str(SEED).unwrap();
        assert_eq!(loaded.document.accessory_prices, seed.accessory_prices);
        assert!(loaded
            .document
            .products
            .iter()
            .any(|p| p.product_id == "P36"));
        assert!(loaded.bundle.catalogs["sizes.json"]["values"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["sizeBandId"] == "s2" && value["labelZh"] == "我的尺寸"));
        let files: Vec<_> = fs::read_dir(price_path(root).parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 2);
        let backup = files
            .iter()
            .find(|path| path.file_name().unwrap() != FILE_NAME)
            .unwrap();
        assert_eq!(fs::read(backup).unwrap(), raw);
        let repeated = read(root).unwrap();
        assert_eq!(repeated.version, loaded.version);
        assert_eq!(repeated.document, loaded.document);
        let mut only_preserved = loaded.document;
        only_preserved.products.retain(|p| p.product_id == "P31");
        let saved = save(root, only_preserved, &loaded.version).unwrap();
        assert_eq!(saved.document.schema_version, 4);
        assert_ne!(saved.version, loaded.version);
        assert_eq!(fs::read(backup).unwrap(), raw);
    }
    #[test]
    fn legacy_empty_product_matrix_stays_empty_and_existing_backup_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut old = legacy();
        old["products"][0]["bodyPrices"] = json!([]);
        let raw = serde_json::to_vec(&old).unwrap();
        write(root, "settings/product-pricing/product-pricing.json", &raw);
        let loaded = read(root).unwrap();
        assert!(loaded
            .document
            .products
            .iter()
            .find(|p| p.product_id == "P31")
            .unwrap()
            .legacy_body_prices
            .is_empty());
        let backup = fs::read_dir(price_path(root).parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap() != FILE_NAME)
            .unwrap();
        fs::write(&backup, b"existing backup").unwrap();
        assert!(read(root).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"existing backup");
        assert_eq!(fs::read(price_path(root)).unwrap(), raw);
    }
    #[test]
    fn pricing_snapshots_drop_legacy_option_rules_without_changing_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read_sample(root);
        let saved = save(root, sample(), &loaded.version).unwrap();
        let mut main = saved.bundle.main.clone();
        main["categories"][0]["products"][0]["optionRules"] = json!("deprecated");
        let mut uncategorized = main["categories"][0]["products"][0].clone();
        uncategorized["productId"] = json!("P999");
        main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(uncategorized);
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &serde_json::to_vec(&main).unwrap(),
        );
        let loaded = read(root).unwrap();
        assert!(loaded.bundle.main["categories"][0]["products"][0]
            .get("optionRules")
            .is_none());
        assert!(loaded.bundle.main["uncategorizedProducts"][0]
            .get("optionRules")
            .is_none());
        assert_eq!(loaded.document, sample());
        let saved = save(root, sample(), &loaded.version).unwrap();
        assert_eq!(saved.document, sample());
        assert!(saved.bundle.main["categories"][0]["products"][0]
            .get("optionRules")
            .is_none());
        assert!(saved.bundle.main["uncategorizedProducts"][0]
            .get("optionRules")
            .is_none());
    }
    #[test]
    fn stale_references_load_but_need_cleanup_before_save() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read_sample(root);
        let saved = save(root, sample(), &loaded.version).unwrap();
        let mut main = saved.bundle.main;
        for category in main["categories"].as_array_mut().unwrap() {
            category["products"]
                .as_array_mut()
                .unwrap()
                .retain(|p| p["productId"] != "P31");
        }
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &serde_json::to_vec(&main).unwrap(),
        );
        let loaded = read(root).unwrap();
        assert_eq!(loaded.document, sample());
        assert!(save(root, sample(), &loaded.version).is_err());
        let mut clean = sample();
        clean.products.clear();
        save(root, clean, &loaded.version).unwrap();
    }
    #[test]
    fn all_dependency_versions_prevent_stale_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read_sample(root);
        let saved = save(root, sample(), &loaded.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        assert!(save(root, loaded.document, &loaded.version)
            .unwrap_err()
            .contains("已被修改"));
        let mut version = saved.version;
        for (file, seed) in PRODUCT_FILES {
            let mut bytes = seed.as_bytes().to_vec();
            bytes.push(b'\n');
            write(root, &format!("settings/product-options/{file}"), &bytes);
            assert!(save(root, sample(), &version)
                .unwrap_err()
                .contains("已被修改"));
            assert_eq!(fs::read(price_path(root)).unwrap(), original);
            version = read_existing(root).unwrap().version;
        }
        let mut bytes = QUANTITY_SEED.as_bytes().to_vec();
        bytes.push(b'\n');
        write(
            root,
            "settings/quantity-pricing/quantity-pricing.json",
            &bytes,
        );
        assert!(save(root, sample(), &version)
            .unwrap_err()
            .contains("已被修改"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
    }
    #[test]
    fn pricing_reads_old_eight_option_files_without_changing_prices_or_creating_new_catalogs() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut main: Value = serde_json::from_str(PRODUCT_FILES[0].1).unwrap();
        for category in main["categories"].as_array_mut().unwrap() {
            for product in category["products"].as_array_mut().unwrap() {
                product["productOptions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|option| {
                        option["name"] != "Tinplate Sticker Film"
                            && option["name"] != "Tinplate Material"
                    });
            }
        }
        for product in main["uncategorizedProducts"].as_array_mut().unwrap() {
            product["productOptions"]
                .as_array_mut()
                .unwrap()
                .retain(|option| {
                    option["name"] != "Tinplate Sticker Film"
                        && option["name"] != "Tinplate Material"
                });
        }
        let original = serde_json::to_vec(&main).unwrap();
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &original,
        );
        for (file, seed) in &PRODUCT_FILES[1..8] {
            write(
                root,
                &format!("settings/product-options/{file}"),
                seed.as_bytes(),
            );
        }
        let loaded = read(root).unwrap();
        let expected: Document = serde_json::from_str(SEED).unwrap();
        assert_eq!(loaded.document, expected);
        let product = product_index(&loaded.bundle).unwrap()["P31"];
        for (file, name) in [
            ("tinplate-sticker-films.json", "Tinplate Sticker Film"),
            ("tinplate-materials.json", "Tinplate Material"),
        ] {
            assert!(!root.join("settings/product-options").join(file).exists());
            assert_eq!(loaded.bundle.catalogs[file]["values"], json!([]));
            assert_eq!(option(product, name).unwrap()["deleted"], true);
        }
        assert_eq!(
            fs::read(root.join("settings/product-options/product-options.clean.json")).unwrap(),
            original
        );
        let saved = save(root, loaded.document, &loaded.version).unwrap();
        assert_eq!(saved.document, expected);
        assert_eq!(read(root).unwrap().document, expected);
        assert_eq!(
            fs::read(root.join("settings/product-options/product-options.clean.json")).unwrap(),
            original
        );
        for (file, _) in &PRODUCT_FILES[8..] {
            assert!(!root.join("settings/product-options").join(file).exists());
        }
    }
    #[test]
    fn new_attribute_identity_keys_are_distinct_from_priced_entity_keys() {
        for (key, id) in [
            ("tinplateStickerFilmId", "TF1"),
            ("tinplateMaterialId", "TM1"),
        ] {
            let mut source = bundle();
            source.catalogs.get_mut("techniques.json").unwrap()["values"][0][key] = json!(id);
            assert!(validate_links(&sample(), &source).is_err());
            let mut source = bundle();
            source.main["categories"][0]["products"][0][key] = json!(id);
            assert!(validate_links(&sample(), &source).is_err());
        }
    }
    #[test]
    fn pricing_reads_legacy_options_without_writing_and_tracks_new_catalog_presence() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut main: Value = serde_json::from_str(PRODUCT_FILES[0].1).unwrap();
        for category in main["categories"].as_array_mut().unwrap() {
            for product in category["products"].as_array_mut().unwrap() {
                product["productOptions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|option| option["name"] != "Standee Quantity");
            }
        }
        let bytes = serde_json::to_vec(&main).unwrap();
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &bytes,
        );
        let loaded = read(root).unwrap();
        let standees = loaded.bundle.main["categories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|category| category["name"] == "standees")
            .unwrap();
        for product in standees["products"].as_array().unwrap() {
            let quantity = option(product, "Standee Quantity").unwrap();
            assert_eq!(quantity["deleted"], false);
            assert_eq!(
                quantity["defaultValue"],
                serde_json::json!({"standeeQuantityId":"SQ1"})
            );
        }
        assert_eq!(
            fs::read(root.join("settings/product-options/product-options.clean.json")).unwrap(),
            bytes
        );
        assert!(!root
            .join("settings/product-options/standee-quantities.json")
            .exists());
        assert_eq!(read_existing(root).unwrap().version, loaded.version);
        write(
            root,
            "settings/product-options/standee-quantities.json",
            PRODUCT_FILES[6].1.as_bytes(),
        );
        assert!(save(root, sample(), &loaded.version)
            .unwrap_err()
            .contains("已被修改"));
        let with_catalog = read_existing(root).unwrap();
        assert_eq!(with_catalog.bundle.main, loaded.bundle.main);
        fs::remove_file(root.join("settings/product-options/standee-quantities.json")).unwrap();
        assert!(save(root, sample(), &with_catalog.version)
            .unwrap_err()
            .contains("已被修改"));
    }
    #[test]
    fn malformed_existing_price_is_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        write(
            directory.path(),
            "settings/product-pricing/product-pricing.json",
            b"{bad",
        );
        assert!(read(directory.path()).is_err());
        assert_eq!(fs::read(price_path(directory.path())).unwrap(), b"{bad");
    }
    #[cfg(windows)]
    #[test]
    fn failed_atomic_save_preserves_original_and_cleans_staging_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let loaded = read_sample(directory.path());
        let path = price_path(directory.path());
        let original = fs::read(&path).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(save(directory.path(), sample(), &loaded.version).is_err());
        drop(lock);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 2);
    }
    #[test]
    fn schema_four_has_no_size_definitions_and_preserves_v3_custom_size_and_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read_sample(root);
        let raw = fs::read(price_path(root)).unwrap();
        assert_eq!(loaded.document, sample());
        assert!(!root.join("settings/product-options/sizes.json").exists());
        let wire = serde_json::to_value(&loaded.document).unwrap();
        assert!(wire.get("sizeBands").is_none());
        assert!(wire["products"][0].get("sizeBandIds").is_none());
        let mut invalid = wire.clone();
        invalid["sizeBands"] = json!([]);
        assert!(serde_json::from_value::<Document>(invalid).is_err());
        let mut invalid = wire;
        invalid["products"][0]["sizeBandIds"] = json!([]);
        assert!(serde_json::from_value::<Document>(invalid).is_err());
        let saved = save(root, loaded.document.clone(), &loaded.version).unwrap();
        assert_eq!(saved.document, loaded.document);
        assert!(root.join("settings/product-options/sizes.json").exists());
        let persisted_catalog: Value = serde_json::from_slice(
            &fs::read(root.join("settings/product-options/sizes.json")).unwrap(),
        )
        .unwrap();
        assert!(persisted_catalog["values"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["sizeBandId"] == "s2" && value["labelZh"] == "2 英寸"));
        let p31 = product_index(&saved.bundle).unwrap()["P31"];
        assert!(active(option(p31, "Size")));
        assert!(enabled(option(p31, "Size").unwrap(), "sizeBandId", "s2"));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v3-{:x}.json",
            Sha256::digest(&raw)
        ));
        assert_eq!(fs::read(backup).unwrap(), raw);
        let reread = read(root).unwrap();
        assert_eq!(reread.document, sample());
        validate_links(&reread.document, &reread.bundle).unwrap();
    }

    #[test]
    fn disabled_or_removed_product_sizes_retain_prices_until_explicit_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read_sample(root);
        let saved = save(root, loaded.document, &loaded.version).unwrap();
        let price_bytes = fs::read(price_path(root)).unwrap();
        let mut main = saved.bundle.main;
        let product = main["categories"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .flat_map(|category| category["products"].as_array_mut().unwrap())
            .find(|product| product["productId"] == "P31")
            .unwrap();
        let size = product["productOptions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|option| option["name"] == "Size")
            .unwrap();
        size["disabledValues"] = json!([{"sizeBandId":"s2"}]);
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &serde_json::to_vec(&main).unwrap(),
        );
        let stale = read_existing(root).unwrap();
        assert_eq!(stale.document, sample());
        assert!(save(root, stale.document.clone(), &stale.version)
            .unwrap_err()
            .contains("尺寸档未关联"));
        assert_eq!(fs::read(price_path(root)).unwrap(), price_bytes);
        let mut cleaned = stale.document;
        cleaned.products[0].legacy_body_prices.clear();
        save(root, cleaned, &stale.version).unwrap();
    }

    #[test]
    fn failing_size_backup_keeps_legacy_price_bytes_and_sizes_catalog_absent() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        read_sample(root);
        let raw = fs::read(price_path(root)).unwrap();
        let mut main: Value = serde_json::from_str(PRODUCT_FILES[0].1).unwrap();
        crate::product_option_settings::remove_seed_size_options(&mut main);
        let main_bytes = serde_json::to_vec(&main).unwrap();
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &main_bytes,
        );
        let backup = format!(
            "settings/product-options/product-options.clean.before-sizes-{:x}.json.bak",
            Sha256::digest(&main_bytes)
        );
        write(root, &backup, b"tampered");
        let loaded = read_existing(root).unwrap();
        assert!(save(root, loaded.document, &loaded.version)
            .unwrap_err()
            .contains("尺寸升级备份内容不符"));
        assert_eq!(fs::read(price_path(root)).unwrap(), raw);
        assert!(!root.join("settings/product-options/sizes.json").exists());
    }
}
