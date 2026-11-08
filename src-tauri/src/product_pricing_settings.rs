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
const PRODUCT_FILES: [(&str, &str); 12] = crate::product_option_settings::FILES;
const ENTITY_KEYS: [&str; 15] = [
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
    "foilStampingId",
    "stickerHoloFilmId",
    "tinplateHoloFilmId",
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    standee_pricing: Option<Value>,
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
    #[serde(
        default,
        deserialize_with = "area_pricing_document",
        skip_serializing_if = "Option::is_none"
    )]
    area_pricing: Option<AreaPricingDocument>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AreaPricingDocument {
    schema_version: u32,
    accessory_pricing: AccessoryPricing,
    #[serde(
        default,
        deserialize_with = "area_limits",
        skip_serializing_if = "Option::is_none"
    )]
    // Historical settings are preserved on roundtrip, but no longer constrain pricing.
    limits: Option<AreaLimits>,
    #[serde(
        default,
        deserialize_with = "area_accessory_prices",
        skip_serializing_if = "Option::is_none"
    )]
    accessory_prices: Option<Vec<AreaAccessoryPrice>>,
    templates: Vec<AreaTemplate>,
    #[serde(
        default,
        deserialize_with = "area_product_rows",
        skip_serializing_if = "Option::is_none"
    )]
    products: Option<Vec<AreaProduct>>,
    #[serde(
        default,
        deserialize_with = "area_category_rows",
        skip_serializing_if = "Option::is_none"
    )]
    categories: Option<Vec<AreaCategory>>,
    #[serde(
        default,
        deserialize_with = "area_product_overrides",
        skip_serializing_if = "Option::is_none"
    )]
    product_overrides: Option<Vec<AreaProductOverride>>,
    #[serde(
        default,
        deserialize_with = "area_category_attribute_bindings",
        skip_serializing_if = "Option::is_none"
    )]
    category_attribute_bindings: Option<Vec<AreaCategoryAttributeBinding>>,
    #[serde(
        default,
        deserialize_with = "area_product_attribute_overrides",
        skip_serializing_if = "Option::is_none"
    )]
    product_attribute_overrides: Option<Vec<AreaProductAttributeOverride>>,
    #[serde(
        default,
        deserialize_with = "area_product_total_formulas",
        skip_serializing_if = "Option::is_none"
    )]
    product_total_formulas: Option<Vec<AreaProductTotalFormula>>,
    #[serde(
        default,
        deserialize_with = "area_attribute_rows",
        skip_serializing_if = "Option::is_none"
    )]
    attributes: Option<Vec<AreaAttribute>>,
    #[serde(
        default,
        deserialize_with = "additional_price_plans",
        skip_serializing_if = "Option::is_none"
    )]
    additional_price_plans: Option<Vec<AdditionalPricePlan>>,
    #[serde(
        default,
        deserialize_with = "category_additional_plan_bindings",
        skip_serializing_if = "Option::is_none"
    )]
    category_additional_plan_bindings: Option<Vec<CategoryAdditionalPlanBinding>>,
    #[serde(
        default,
        deserialize_with = "product_additional_plan_overrides",
        skip_serializing_if = "Option::is_none"
    )]
    product_additional_plan_overrides: Option<Vec<ProductAdditionalPlanOverride>>,
    #[serde(
        default,
        deserialize_with = "product_adjustments",
        skip_serializing_if = "Option::is_none"
    )]
    product_adjustments: Option<Vec<ProductAdjustment>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductAdjustment {
    product_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    amount: Option<String>,
}

fn product_adjustments<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<ProductAdjustment>>, D::Error> {
    Vec::<ProductAdjustment>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaDimensions {
    width: String,
    height: String,
    unit: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaLimits {
    min: AreaDimensions,
    max: AreaDimensions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaAccessoryPrice {
    accessory_price_id: String,
    accessory_style_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    accessory_color_id: Option<String>,
    #[serde(deserialize_with = "required_nullable_string")]
    unit_price: Option<String>,
}

fn area_limits<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<AreaLimits>, D::Error> {
    AreaLimits::deserialize(deserializer).map(Some)
}

fn area_accessory_prices<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaAccessoryPrice>>, D::Error> {
    Vec::<AreaAccessoryPrice>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaTemplate {
    area_template_id: String,
    name: String,
    unit: String,
    #[serde(
        default,
        deserialize_with = "template_match_by",
        skip_serializing_if = "Option::is_none"
    )]
    match_by: Option<TemplateMatchBy>,
    #[serde(
        default,
        deserialize_with = "area_boundary_mode",
        skip_serializing_if = "Option::is_none"
    )]
    boundary_mode: Option<AreaBoundaryMode>,
    tiers: Vec<AreaTier>,
    #[serde(
        default,
        deserialize_with = "exact_size_rules",
        skip_serializing_if = "Option::is_none"
    )]
    exact_sizes: Option<Vec<ExactSizeRule>>,
    #[serde(
        default,
        deserialize_with = "pricing_formulas",
        skip_serializing_if = "Option::is_none"
    )]
    formulas: Option<Vec<PricingFormulaDefinition>>,
    #[serde(
        default,
        deserialize_with = "present_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    base_price: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "area_tier_prices",
        skip_serializing_if = "Option::is_none"
    )]
    tier_prices: Option<Vec<AreaTierPrice>>,
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    formula: Option<String>,
    #[serde(
        default,
        deserialize_with = "standee_base_template",
        skip_serializing_if = "Option::is_none"
    )]
    standee_base: Option<StandeeBaseTemplate>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StandeeBaseTemplate {
    unit: String,
    #[serde(
        default,
        deserialize_with = "template_match_by",
        skip_serializing_if = "Option::is_none"
    )]
    match_by: Option<TemplateMatchBy>,
    #[serde(
        default,
        deserialize_with = "area_boundary_mode",
        skip_serializing_if = "Option::is_none"
    )]
    boundary_mode: Option<AreaBoundaryMode>,
    tiers: Vec<AreaTier>,
    #[serde(
        default,
        deserialize_with = "exact_size_rules",
        skip_serializing_if = "Option::is_none"
    )]
    exact_sizes: Option<Vec<ExactSizeRule>>,
    #[serde(
        default,
        deserialize_with = "pricing_formulas",
        skip_serializing_if = "Option::is_none"
    )]
    formulas: Option<Vec<PricingFormulaDefinition>>,
    #[serde(deserialize_with = "required_nullable_string")]
    base_price: Option<String>,
    tier_prices: Vec<AreaTierPrice>,
    formula: String,
}

fn standee_base_template<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<StandeeBaseTemplate>, D::Error> {
    StandeeBaseTemplate::deserialize(deserializer).map(Some)
}

fn present_nullable_string<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    required_nullable_string(deserializer).map(Some)
}

fn present_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn area_tier_prices<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaTierPrice>>, D::Error> {
    Vec::<AreaTierPrice>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum AreaBoundaryMode {
    UpperInclusive,
    LowerInclusive,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum TemplateMatchBy {
    Area,
    LongestSide,
    ExactSize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactSizeRule {
    area_tier_id: String,
    width: String,
    height: String,
    unit: String,
    allow_rotation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PricingFormulaDefinition {
    formula_id: String,
    name: String,
    formula: String,
}

fn exact_size_rules<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<ExactSizeRule>>, D::Error> {
    Vec::<ExactSizeRule>::deserialize(deserializer).map(Some)
}

fn pricing_formulas<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<PricingFormulaDefinition>>, D::Error> {
    Vec::<PricingFormulaDefinition>::deserialize(deserializer).map(Some)
}

fn template_match_by<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<TemplateMatchBy>, D::Error> {
    // Missing preserves area matching; an explicitly present value cannot be null.
    TemplateMatchBy::deserialize(deserializer).map(Some)
}

fn area_boundary_mode<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AreaBoundaryMode>, D::Error> {
    // Missing keeps historical upper-inclusive behavior without rewriting files.
    // An explicitly present value must be one of the two supported modes.
    AreaBoundaryMode::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaTier {
    area_tier_id: String,
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    min_area: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_bool",
        skip_serializing_if = "Option::is_none"
    )]
    min_inclusive: Option<bool>,
    #[serde(deserialize_with = "required_nullable_string")]
    max_area: Option<String>,
}

fn present_bool<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    bool::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaCharge {
    #[serde(deserialize_with = "required_nullable_string")]
    base_price: Option<String>,
    area_template_id: String,
    tier_prices: Vec<AreaTierPrice>,
    formula: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaTierPrice {
    area_tier_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    price: Option<String>,
    #[serde(
        default,
        deserialize_with = "tier_calculation",
        skip_serializing_if = "Option::is_none"
    )]
    calculation: Option<TierCalculation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TierCalculation {
    Fixed {},
    Area {
        #[serde(deserialize_with = "required_nullable_string")]
        base_price: Option<String>,
        area_unit: String,
    },
    Formula {
        #[serde(deserialize_with = "required_nullable_string")]
        base_price: Option<String>,
        formula_id: String,
    },
}

fn tier_calculation<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<TierCalculation>, D::Error> {
    TierCalculation::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaProduct {
    product_id: String,
    body: AreaCharge,
    total_formula: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaCategory {
    category_id: String,
    #[serde(
        default,
        deserialize_with = "area_category_charge",
        skip_serializing_if = "Option::is_none"
    )]
    body: Option<AreaCharge>,
    #[serde(
        default,
        deserialize_with = "present_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    area_template_id: Option<Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaProductOverride {
    product_id: String,
    area_template_id: String,
}

fn area_category_charge<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AreaCharge>, D::Error> {
    AreaCharge::deserialize(deserializer).map(Some)
}

fn area_product_overrides<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaProductOverride>>, D::Error> {
    Vec::<AreaProductOverride>::deserialize(deserializer).map(Some)
}

fn area_product_rows<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaProduct>>, D::Error> {
    Vec::<AreaProduct>::deserialize(deserializer).map(Some)
}

fn area_category_rows<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaCategory>>, D::Error> {
    Vec::<AreaCategory>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaAttribute {
    area_attribute_price_id: String,
    option_name: String,
    reference: Value,
    #[serde(
        default,
        deserialize_with = "area_category_charge",
        skip_serializing_if = "Option::is_none"
    )]
    charge: Option<AreaCharge>,
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    area_template_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    base_price: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "area_tier_prices",
        skip_serializing_if = "Option::is_none"
    )]
    tier_prices: Option<Vec<AreaTierPrice>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaProductTotalFormula {
    product_id: String,
    formula: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdditionalPricePlan {
    additional_price_plan_id: String,
    name: String,
    prices: Vec<AdditionalPlanPrice>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdditionalPlanPrice {
    area_attribute_price_id: String,
    option_name: String,
    reference: Value,
    area_template_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    base_price: Option<String>,
    tier_prices: Vec<AreaTierPrice>,
    #[serde(
        default,
        deserialize_with = "standee_base_price",
        skip_serializing_if = "Option::is_none"
    )]
    standee_base: Option<StandeeBasePrice>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StandeeBasePrice {
    #[serde(deserialize_with = "required_nullable_string")]
    base_price: Option<String>,
    tier_prices: Vec<AreaTierPrice>,
}

fn standee_base_price<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<StandeeBasePrice>, D::Error> {
    StandeeBasePrice::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CategoryAdditionalPlanBinding {
    category_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    additional_price_plan_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductAdditionalPlanOverride {
    product_id: String,
    #[serde(deserialize_with = "required_nullable_string")]
    additional_price_plan_id: Option<String>,
}

fn area_attribute_rows<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaAttribute>>, D::Error> {
    Vec::<AreaAttribute>::deserialize(deserializer).map(Some)
}

fn additional_price_plans<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AdditionalPricePlan>>, D::Error> {
    Vec::<AdditionalPricePlan>::deserialize(deserializer).map(Some)
}

fn category_additional_plan_bindings<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<CategoryAdditionalPlanBinding>>, D::Error> {
    Vec::<CategoryAdditionalPlanBinding>::deserialize(deserializer).map(Some)
}

fn product_additional_plan_overrides<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<ProductAdditionalPlanOverride>>, D::Error> {
    Vec::<ProductAdditionalPlanOverride>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaCategoryAttributeBinding {
    category_id: String,
    option_name: String,
    reference: Value,
    #[serde(deserialize_with = "required_nullable_string")]
    area_attribute_price_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AreaProductAttributeOverride {
    product_id: String,
    option_name: String,
    reference: Value,
    #[serde(deserialize_with = "required_nullable_string")]
    area_attribute_price_id: Option<String>,
}

fn area_category_attribute_bindings<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaCategoryAttributeBinding>>, D::Error> {
    Vec::<AreaCategoryAttributeBinding>::deserialize(deserializer).map(Some)
}

fn area_product_attribute_overrides<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaProductAttributeOverride>>, D::Error> {
    Vec::<AreaProductAttributeOverride>::deserialize(deserializer).map(Some)
}

fn area_product_total_formulas<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AreaProductTotalFormula>>, D::Error> {
    Vec::<AreaProductTotalFormula>::deserialize(deserializer).map(Some)
}

fn area_pricing_document<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AreaPricingDocument>, D::Error> {
    AreaPricingDocument::deserialize(deserializer).map(Some)
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

fn area_reference(attribute: &AreaAttribute) -> Result<(&str, &str, &str), String> {
    area_option_reference(&attribute.option_name, &attribute.reference)
}

fn area_option_reference<'a>(
    option_name: &str,
    reference: &'a Value,
) -> Result<(&'static str, &'a str, &'a str), String> {
    let reference = reference
        .as_object()
        .filter(|reference| reference.len() == 1)
        .ok_or_else(|| error("面积属性价格必须明确且仅包含一个所属实体 ID"))?;
    let (key, id) = reference.iter().next().unwrap();
    let file = match (option_name, key.as_str()) {
        ("Print Option", "printOptionId") => "print-options.json",
        ("Technique", "techniqueId") => "techniques.json",
        ("Holo Film", "holoFilmId") => "holo-films.json",
        ("Foil Stamping", "foilStampingId") => "foil-stamping.json",
        ("Sticker Holo Film", "stickerHoloFilmId") => "sticker-holo-films.json",
        ("Tinplate Holo Film", "tinplateHoloFilmId") => "tinplate-holo-films.json",
        ("Material", "materialId") => "materials.json",
        ("Tinplate Material", "tinplateMaterialId") => "tinplate-materials.json",
        ("Accessories Style", "accessoryStyleId" | "accessoryColorId") => "accessory-styles.json",
        _ => return Err(error("面积属性名称与所属实体 ID 不符")),
    };
    let id = id
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(|| error("面积属性实体 ID 无效"))?;
    Ok((file, key, id))
}

fn validate_formula_text(formula: &str) -> Result<(), String> {
    // Formulas are data. The frontend's whitelist parser validates and evaluates
    // them; the storage layer only accepts a bounded, nonempty string.
    if formula.trim().is_empty() || formula.chars().count() > 2_000 {
        return Err(error("面积计价公式不能为空或超过 2000 个字符"));
    }
    Ok(())
}

fn validate_area_charge(
    charge: &AreaCharge,
    templates: &HashMap<&str, &AreaTemplate>,
    schema_version: u32,
) -> Result<(), String> {
    let template = templates
        .get(charge.area_template_id.as_str())
        .ok_or_else(|| error("面积价格引用的档位模板不存在"))?;
    validate_area_price_values(
        &charge.base_price,
        &charge.tier_prices,
        &template.tiers,
        &charge.formula,
        &template.match_by,
        &template.exact_sizes,
        &template.formulas,
        schema_version,
    )
}

fn validate_area_price_values(
    base_price: &Option<String>,
    tier_prices: &[AreaTierPrice],
    tiers: &[AreaTier],
    formula: &str,
    match_by: &Option<TemplateMatchBy>,
    exact_sizes: &Option<Vec<ExactSizeRule>>,
    formulas: &Option<Vec<PricingFormulaDefinition>>,
    schema_version: u32,
) -> Result<(), String> {
    let valid_price = if schema_version == 7 {
        valid_adjustment
    } else {
        valid_money
    };
    if base_price.as_ref().is_some_and(|value| !valid_price(value)) {
        return Err(error("面积基本价格式无效，空值表示未定价"));
    }
    let allowed: HashSet<&str> = tiers
        .iter()
        .map(|tier| tier.area_tier_id.as_str())
        .chain(
            exact_sizes
                .iter()
                .flatten()
                .map(|rule| rule.area_tier_id.as_str()),
        )
        .collect();
    let formula_ids: HashSet<&str> = formulas
        .iter()
        .flatten()
        .map(|row| row.formula_id.as_str())
        .collect();
    let mut seen = HashSet::new();
    for tier in tier_prices {
        if !allowed.contains(tier.area_tier_id.as_str()) || !seen.insert(&tier.area_tier_id) {
            return Err(error("面积价格档位不属于指定模板或重复"));
        }
        if tier.price.as_ref().is_some_and(|value| !valid_price(value)) {
            return Err(error("面积档位价格格式无效，空值表示未定价"));
        }
        if let Some(calculation) = &tier.calculation {
            if schema_version != 7 {
                return Err(error("各档独立计价字段与面积定价版本不符"));
            }
            match calculation {
                TierCalculation::Fixed {} => (),
                TierCalculation::Area {
                    base_price,
                    area_unit,
                } => {
                    if !["in", "cm", "mm"].contains(&area_unit.as_str())
                        || base_price
                            .as_ref()
                            .is_some_and(|value| !valid_adjustment(value))
                    {
                        return Err(error("各档面积计价单位或基础费无效"));
                    }
                }
                TierCalculation::Formula {
                    base_price,
                    formula_id,
                } => {
                    if !formula_ids.contains(formula_id.as_str())
                        || base_price
                            .as_ref()
                            .is_some_and(|value| !valid_adjustment(value))
                    {
                        return Err(error("各档自定义公式不存在或基础费无效"));
                    }
                }
            }
        }
    }
    validate_formula_text(formula)?;
    if !matches!(
        match_by,
        Some(TemplateMatchBy::LongestSide | TemplateMatchBy::ExactSize)
    ) && formula.contains("最长边毫米")
    {
        return Err(error("只有最长边档位模板可以使用最长边毫米变量"));
    }
    Ok(())
}

// Scale dimensions to 10^-19 mm, so in/cm/mm comparisons stay integer-exact.
// The 10^-12 mm tolerance mirrors the quote engine's decimal unit conversions.
fn exact_dimension(value: &str, unit: &str) -> Option<i128> {
    let factor = match unit {
        "in" => 254,
        "cm" => 100,
        "mm" => 10,
        _ => return None,
    };
    decimal(value)
        .filter(|value| *value > 0)?
        .checked_mul(factor)
}

fn validate_price_rule_group<'a>(
    unit: &str,
    tiers: &'a [AreaTier],
    match_by: &Option<TemplateMatchBy>,
    boundary_mode: &Option<AreaBoundaryMode>,
    exact_sizes: &'a Option<Vec<ExactSizeRule>>,
    formulas: &Option<Vec<PricingFormulaDefinition>>,
    schema_version: u32,
    tier_ids: &mut HashSet<&'a str>,
) -> Result<(), String> {
    if schema_version != 7
        && (exact_sizes.is_some()
            || formulas.is_some()
            || *match_by == Some(TemplateMatchBy::ExactSize))
    {
        return Err(error("指定尺寸或独立公式字段与面积定价版本不符"));
    }
    if *match_by == Some(TemplateMatchBy::ExactSize) {
        if !["in", "cm", "mm"].contains(&unit)
            || !tiers.is_empty()
            || exact_sizes.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(error("指定尺寸模板必须有尺寸规则且不能包含区间"));
        }
    } else {
        validate_area_tiers(
            unit,
            tiers,
            match_by,
            boundary_mode,
            schema_version,
            tier_ids,
        )?;
    }
    let mut dimensions: Vec<(i128, i128, bool)> = Vec::new();
    for rule in exact_sizes.iter().flatten() {
        insert_id(&rule.area_tier_id, tier_ids, "指定尺寸")?;
        let width = exact_dimension(&rule.width, &rule.unit)
            .ok_or_else(|| error("指定尺寸宽度或单位无效"))?;
        let height = exact_dimension(&rule.height, &rule.unit)
            .ok_or_else(|| error("指定尺寸高度或单位无效"))?;
        let near = |a: i128, b: i128| (a - b).abs() <= 10_000_000;
        if dimensions.iter().any(|&(w, h, rotated)| {
            near(w, width) && near(h, height)
                || (rotated || rule.allow_rotation) && near(w, height) && near(h, width)
        }) {
            return Err(error("指定尺寸规则重复或旋转后冲突"));
        }
        dimensions.push((width, height, rule.allow_rotation));
    }
    let mut formula_ids = HashSet::new();
    for definition in formulas.iter().flatten() {
        insert_id(&definition.formula_id, &mut formula_ids, "计价公式")?;
        if !valid_id(&definition.name) {
            return Err(error("计价公式名称不能为空或含首尾空格"));
        }
        validate_formula_text(&definition.formula)?;
        if !matches!(
            match_by,
            Some(TemplateMatchBy::LongestSide | TemplateMatchBy::ExactSize)
        ) && definition.formula.contains("最长边毫米")
        {
            return Err(error("只有最长边或指定尺寸模板可以使用最长边毫米变量"));
        }
    }
    Ok(())
}

fn validate_area_tiers<'a>(
    unit: &str,
    tiers: &'a [AreaTier],
    match_by: &Option<TemplateMatchBy>,
    boundary_mode: &Option<AreaBoundaryMode>,
    schema_version: u32,
    tier_ids: &mut HashSet<&'a str>,
) -> Result<(), String> {
    if !["in", "cm", "mm"].contains(&unit) || tiers.is_empty() {
        return Err(error("面积档位模板单位或档位列表无效"));
    }
    let explicit = tiers
        .iter()
        .any(|tier| tier.min_area.is_some() || tier.min_inclusive.is_some());
    if explicit {
        if schema_version != 7
            || tiers
                .iter()
                .any(|tier| tier.min_area.is_none() || tier.min_inclusive.is_none())
        {
            return Err(error(
                "显式区间起点与包含设置必须成对填写，且不能与旧区间混用",
            ));
        }
        let upper_inclusive = *boundary_mode != Some(AreaBoundaryMode::LowerInclusive);
        let (unit_factor, tolerance) = if *match_by == Some(TemplateMatchBy::LongestSide) {
            (
                match unit {
                    "in" => 254_i128,
                    "cm" => 100,
                    _ => 10,
                },
                10_000_000_i128,
            )
        } else {
            (
                match unit {
                    "in" => 64_516_i128,
                    "cm" => 10_000,
                    _ => 100,
                },
                100_000_000_000_i128,
            )
        };
        let mut previous_max: Option<i128> = None;
        let mut previous_min: Option<i128> = None;
        for (index, tier) in tiers.iter().enumerate() {
            insert_id(&tier.area_tier_id, tier_ids, "面积档位")?;
            let min = decimal(tier.min_area.as_ref().unwrap())
                .ok_or_else(|| error("区间起点必须是非负十进制数"))?;
            let min_inclusive = tier.min_inclusive.unwrap();
            if previous_min.is_some_and(|previous| min < previous) {
                return Err(error("价格区间必须按起点排序"));
            }
            if let Some(previous) = previous_max {
                let difference = (min - previous) * unit_factor;
                let touching = difference.abs() <= tolerance;
                if min < previous || touching && upper_inclusive && min_inclusive {
                    return Err(error("价格区间必须按起点排序且不能重叠"));
                }
            }
            match &tier.max_area {
                Some(value) => {
                    let max = decimal(value)
                        .filter(|max| {
                            *max > 0
                                && (*max > min || *max == min && upper_inclusive && min_inclusive)
                        })
                        .ok_or_else(|| error("区间终点不得小于起点，相等时两端都必须包含"))?;
                    if (max - min) * unit_factor <= tolerance && !(upper_inclusive && min_inclusive)
                    {
                        return Err(error("区间过窄，开放端点后没有可匹配尺寸"));
                    }
                    previous_max = Some(max);
                }
                None if index + 1 == tiers.len() => (),
                None => return Err(error("无上限区间只能放在最后")),
            }
            previous_min = Some(min);
        }
        return Ok(());
    }
    let mut previous = 0;
    for (index, tier) in tiers.iter().enumerate() {
        insert_id(&tier.area_tier_id, tier_ids, "面积档位")?;
        match &tier.max_area {
            Some(value) => {
                let upper = decimal(value)
                    .filter(|upper| *upper > previous)
                    .ok_or_else(|| error("面积档位上限必须为递增的正十进制数"))?;
                previous = upper;
            }
            None if index + 1 == tiers.len() => (),
            None => return Err(error("面积无上限档位只能放在最后")),
        }
    }
    if tiers.last().unwrap().max_area.is_some() {
        return Err(error("面积模板最后一档必须为无上限"));
    }
    Ok(())
}

fn validate_area_pricing(area: &AreaPricingDocument) -> Result<(), String> {
    let valid_scope = match area.schema_version {
        1 => {
            area.products.is_some() && area.categories.is_none() && area.product_overrides.is_none()
        }
        2 => {
            area.categories.is_some()
                && area.products.is_none()
                && area.limits.is_none()
                && area.product_overrides.is_none()
        }
        3 | 4 | 5 | 6 | 7 => {
            area.categories.is_some()
                && area.products.is_none()
                && area.limits.is_none()
                && area.product_overrides.is_some()
        }
        _ => false,
    };
    let valid_bindings = if matches!(area.schema_version, 4 | 5) {
        area.category_attribute_bindings.is_some() && area.product_attribute_overrides.is_some()
    } else {
        area.category_attribute_bindings.is_none() && area.product_attribute_overrides.is_none()
    };
    let valid_plan_scope = if matches!(area.schema_version, 6 | 7) {
        area.attributes.is_none()
            && area.additional_price_plans.is_some()
            && area.category_additional_plan_bindings.is_some()
            && area.product_additional_plan_overrides.is_some()
    } else {
        area.attributes.is_some()
            && area.additional_price_plans.is_none()
            && area.category_additional_plan_bindings.is_none()
            && area.product_additional_plan_overrides.is_none()
    };
    let valid_total_formulas =
        matches!(area.schema_version, 5 | 6 | 7) == area.product_total_formulas.is_some();
    if !valid_scope
        || !valid_bindings
        || !valid_plan_scope
        || !valid_total_formulas
        || (area.schema_version == 7) != area.product_adjustments.is_some()
        || area.templates.is_empty()
    {
        return Err(error("面积定价版本无效或缺少档位模板"));
    }
    let mut accessory_ids = HashSet::new();
    let mut accessory_references = HashSet::new();
    for row in area.accessory_prices.iter().flatten() {
        insert_id(&row.accessory_price_id, &mut accessory_ids, "公共配件价格")?;
        if !valid_id(&row.accessory_style_id)
            || row
                .accessory_color_id
                .as_ref()
                .is_some_and(|id| !valid_id(id))
            || !accessory_references.insert((&row.accessory_style_id, &row.accessory_color_id))
        {
            return Err(error("公共配件价格必须关联明确的样式和颜色，且不能重复"));
        }
        if row
            .unit_price
            .as_ref()
            .is_some_and(|value| !valid_money(value))
        {
            return Err(error("公共配件单价格式无效，空值表示未定价"));
        }
    }
    let mut templates = HashMap::new();
    let mut tier_ids = HashSet::new();
    for template in &area.templates {
        if !matches!(area.schema_version, 6 | 7) && template.standee_base.is_some() {
            return Err(error("底座计价字段与面积定价版本不符"));
        }
        if !matches!(area.schema_version, 4 | 5 | 6 | 7) && template.match_by.is_some() {
            return Err(error("模板匹配依据与面积定价版本不符"));
        }
        let priced = template.base_price.is_some()
            && template.tier_prices.is_some()
            && template.formula.is_some();
        let unpriced = template.base_price.is_none()
            && template.tier_prices.is_none()
            && template.formula.is_none();
        if (area.schema_version >= 3 && !priced) || (area.schema_version < 3 && !unpriced) {
            return Err(error("面积模板价格字段与版本不符"));
        }
        if !valid_id(&template.area_template_id)
            || templates
                .insert(template.area_template_id.as_str(), template)
                .is_some()
            || template.name.trim().is_empty()
        {
            return Err(error("面积档位模板 ID、名称、单位或档位列表无效"));
        }
        validate_price_rule_group(
            &template.unit,
            &template.tiers,
            &template.match_by,
            &template.boundary_mode,
            &template.exact_sizes,
            &template.formulas,
            area.schema_version,
            &mut tier_ids,
        )?;
        if let Some(base) = &template.standee_base {
            validate_price_rule_group(
                &base.unit,
                &base.tiers,
                &base.match_by,
                &base.boundary_mode,
                &base.exact_sizes,
                &base.formulas,
                area.schema_version,
                &mut tier_ids,
            )?;
            validate_area_price_values(
                &base.base_price,
                &base.tier_prices,
                &base.tiers,
                &base.formula,
                &base.match_by,
                &base.exact_sizes,
                &base.formulas,
                area.schema_version,
            )?;
        }
    }
    if area.schema_version >= 3 {
        for template in &area.templates {
            validate_area_charge(
                &AreaCharge {
                    base_price: template.base_price.clone().unwrap(),
                    area_template_id: template.area_template_id.clone(),
                    tier_prices: template.tier_prices.clone().unwrap(),
                    formula: template.formula.clone().unwrap(),
                },
                &templates,
                area.schema_version,
            )?;
        }
    }
    let mut products = HashSet::new();
    for product in area.products.iter().flatten() {
        insert_id(&product.product_id, &mut products, "面积产品")?;
        validate_area_charge(&product.body, &templates, area.schema_version)?;
        validate_formula_text(&product.total_formula)?;
    }
    let mut categories = HashSet::new();
    for category in area.categories.iter().flatten() {
        insert_id(&category.category_id, &mut categories, "面积产品大类")?;
        match area.schema_version {
            2 if category.area_template_id.is_none() => validate_area_charge(
                category
                    .body
                    .as_ref()
                    .ok_or_else(|| error("大类主体价格缺失"))?,
                &templates,
                area.schema_version,
            )?,
            3 | 4 | 5 | 6 | 7 if category.body.is_none() => {
                let template_id = category
                    .area_template_id
                    .as_ref()
                    .ok_or_else(|| error("大类必须明确指定模板或空值"))?;
                if template_id
                    .as_ref()
                    .is_some_and(|id| !templates.contains_key(id.as_str()))
                {
                    return Err(error("大类关联的面积模板不存在"));
                }
            }
            _ => return Err(error("大类主体价格字段与版本不符")),
        }
    }
    let mut overridden_products = HashSet::new();
    for row in area.product_overrides.iter().flatten() {
        insert_id(&row.product_id, &mut overridden_products, "子类模板关联")?;
        if !templates.contains_key(row.area_template_id.as_str()) {
            return Err(error("子类关联的面积模板不存在"));
        }
    }
    let mut formula_products = HashSet::new();
    for row in area.product_total_formulas.iter().flatten() {
        insert_id(&row.product_id, &mut formula_products, "产品总价公式")?;
        validate_formula_text(&row.formula)?;
    }
    let mut adjustment_products = HashSet::new();
    for row in area.product_adjustments.iter().flatten() {
        insert_id(&row.product_id, &mut adjustment_products, "产品每套调整")?;
        if row
            .amount
            .as_ref()
            .is_some_and(|value| !valid_adjustment(value))
        {
            return Err(error("产品每套调整格式无效，空值表示未定价"));
        }
    }
    let mut attributes = HashSet::new();
    let mut references = HashSet::new();
    for attribute in area.attributes.iter().flatten() {
        if (matches!(area.schema_version, 4 | 5) || area.accessory_prices.is_some())
            && ["Print Option", "Accessories Style"].contains(&attribute.option_name.as_str())
        {
            return Err(error("印刷不单独计价，配件应使用公共固定单价"));
        }
        insert_id(
            &attribute.area_attribute_price_id,
            &mut attributes,
            "面积属性价格",
        )?;
        let (_, key, id) = area_reference(attribute)?;
        if matches!(area.schema_version, 4 | 5) {
            if attribute.charge.is_some()
                || !attribute.name.as_ref().is_some_and(|name| valid_id(name))
                || !attribute
                    .area_template_id
                    .as_ref()
                    .is_some_and(|id| templates.contains_key(id.as_str()))
            {
                return Err(error(
                    "附加价格方案必须包含名称、有效模板，且不能包含旧计价配置",
                ));
            }
            if area.schema_version == 5 {
                let template_id = attribute.area_template_id.as_ref().unwrap();
                validate_area_charge(
                    &AreaCharge {
                        base_price: attribute
                            .base_price
                            .clone()
                            .ok_or_else(|| error("附加价格方案必须明确基础费或空值"))?,
                        area_template_id: template_id.clone(),
                        tier_prices: attribute
                            .tier_prices
                            .clone()
                            .ok_or_else(|| error("附加价格方案缺少档位价格"))?,
                        formula: templates[template_id.as_str()].formula.clone().unwrap(),
                    },
                    &templates,
                    area.schema_version,
                )?;
            } else if attribute.base_price.is_some() || attribute.tier_prices.is_some() {
                return Err(error("附加价格方案金额字段与版本不符"));
            }
        } else {
            if !references.insert((key, id)) {
                return Err(error("同一属性的面积价格不能重复"));
            }
            if attribute.name.is_some()
                || attribute.area_template_id.is_some()
                || attribute.base_price.is_some()
                || attribute.tier_prices.is_some()
            {
                return Err(error("附加价格方案字段与版本不符"));
            }
            validate_area_charge(
                attribute
                    .charge
                    .as_ref()
                    .ok_or_else(|| error("面积属性价格缺失"))?,
                &templates,
                area.schema_version,
            )?;
        }
    }
    let plans: HashMap<&str, &AreaAttribute> = area
        .attributes
        .iter()
        .flatten()
        .map(|plan| (plan.area_attribute_price_id.as_str(), plan))
        .collect();
    let mut category_bindings = HashSet::new();
    for binding in area.category_attribute_bindings.iter().flatten() {
        let (_, key, id) = area_option_reference(&binding.option_name, &binding.reference)?;
        if !valid_id(&binding.category_id)
            || !category_bindings.insert((&binding.category_id, &binding.option_name, key, id))
        {
            return Err(error("附加价格大类关联无效或同一属性重复关联"));
        }
        validate_area_plan_binding(
            &binding.option_name,
            &binding.reference,
            binding.area_attribute_price_id.as_deref(),
            &plans,
        )?;
    }
    let mut product_bindings = HashSet::new();
    for binding in area.product_attribute_overrides.iter().flatten() {
        let (_, key, id) = area_option_reference(&binding.option_name, &binding.reference)?;
        if !valid_id(&binding.product_id)
            || !product_bindings.insert((&binding.product_id, &binding.option_name, key, id))
        {
            return Err(error("附加价格产品关联无效或同一属性重复关联"));
        }
        validate_area_plan_binding(
            &binding.option_name,
            &binding.reference,
            binding.area_attribute_price_id.as_deref(),
            &plans,
        )?;
    }
    let mut additional_plans = HashSet::new();
    for plan in area.additional_price_plans.iter().flatten() {
        insert_id(
            &plan.additional_price_plan_id,
            &mut additional_plans,
            "附加价格整套方案",
        )?;
        if !valid_id(&plan.name) {
            return Err(error("附加价格方案名称不能为空或含首尾空格"));
        }
        let mut row_ids = HashSet::new();
        let mut row_references = HashSet::new();
        for price in &plan.prices {
            insert_id(&price.area_attribute_price_id, &mut row_ids, "方案属性价格")?;
            if ["Print Option", "Accessories Style"].contains(&price.option_name.as_str()) {
                return Err(error("印刷不单独计价，配件应使用公共固定单价"));
            }
            let (_, key, id) = area_option_reference(&price.option_name, &price.reference)?;
            if !row_references.insert((&price.option_name, key, id)) {
                return Err(error("同一附加方案内的属性价格不能重复"));
            }
            let template = templates
                .get(price.area_template_id.as_str())
                .ok_or_else(|| error("附加方案引用的档位模板不存在"))?;
            validate_area_charge(
                &AreaCharge {
                    base_price: price.base_price.clone(),
                    area_template_id: price.area_template_id.clone(),
                    tier_prices: price.tier_prices.clone(),
                    formula: template.formula.clone().unwrap(),
                },
                &templates,
                area.schema_version,
            )?;
            if let Some(base_price) = &price.standee_base {
                let base = template
                    .standee_base
                    .as_ref()
                    .ok_or_else(|| error("附加方案底座价格引用的模板未配置底座档位"))?;
                validate_area_price_values(
                    &base_price.base_price,
                    &base_price.tier_prices,
                    &base.tiers,
                    &base.formula,
                    &base.match_by,
                    &base.exact_sizes,
                    &base.formulas,
                    area.schema_version,
                )?;
            }
        }
    }
    let mut additional_categories = HashSet::new();
    for binding in area.category_additional_plan_bindings.iter().flatten() {
        insert_id(
            &binding.category_id,
            &mut additional_categories,
            "整套附加方案大类关联",
        )?;
        if binding
            .additional_price_plan_id
            .as_ref()
            .is_some_and(|id| !additional_plans.contains(id.as_str()))
        {
            return Err(error("大类关联的整套附加价格方案不存在"));
        }
    }
    let mut additional_products = HashSet::new();
    for binding in area.product_additional_plan_overrides.iter().flatten() {
        insert_id(
            &binding.product_id,
            &mut additional_products,
            "整套附加方案产品关联",
        )?;
        if binding
            .additional_price_plan_id
            .as_ref()
            .is_some_and(|id| !additional_plans.contains(id.as_str()))
        {
            return Err(error("产品关联的整套附加价格方案不存在"));
        }
    }
    Ok(())
}

fn validate_area_plan_binding(
    option_name: &str,
    reference: &Value,
    plan_id: Option<&str>,
    plans: &HashMap<&str, &AreaAttribute>,
) -> Result<(), String> {
    if ["Print Option", "Accessories Style"].contains(&option_name) {
        return Err(error("印刷和公共固定配件不能关联面积附加价格方案"));
    }
    if let Some(plan_id) = plan_id {
        let plan = plans
            .get(plan_id)
            .ok_or_else(|| error("关联的附加价格方案不存在"))?;
        if plan.option_name != option_name || &plan.reference != reference {
            return Err(error("附加价格方案不属于指定属性"));
        }
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
    if let Some(area) = &document.area_pricing {
        validate_area_pricing(area)?;
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
    if let Some(area) = &document.area_pricing {
        return validate_area_links(area, bundle);
    }
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

fn validate_area_links(area: &AreaPricingDocument, bundle: &Bundle) -> Result<(), String> {
    let products = product_index(bundle)?;
    for product in area.products.iter().flatten() {
        if !products.contains_key(product.product_id.as_str()) {
            return Err(error(format!(
                "面积定价引用的产品 {} 已不存在",
                product.product_id
            )));
        }
    }
    let mut categories = HashSet::new();
    if let Some(prices) = &area.categories {
        for category in array(&bundle.main, "categories")? {
            let id = category["name"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or_else(|| error("产品大类缺少有效的关联标识"))?;
            if !categories.insert(id) {
                return Err(error("产品大类关联标识重复"));
            }
        }
        for category in prices {
            if !categories.contains(category.category_id.as_str()) {
                return Err(error(format!(
                    "面积定价引用的产品大类 {} 已不存在",
                    category.category_id
                )));
            }
        }
    }
    for product_id in area
        .product_overrides
        .iter()
        .flatten()
        .map(|row| row.product_id.as_str())
        .chain(
            area.product_attribute_overrides
                .iter()
                .flatten()
                .map(|row| row.product_id.as_str()),
        )
        .chain(
            area.product_total_formulas
                .iter()
                .flatten()
                .map(|row| row.product_id.as_str()),
        )
        .chain(
            area.product_additional_plan_overrides
                .iter()
                .flatten()
                .map(|row| row.product_id.as_str()),
        )
        .chain(
            area.product_adjustments
                .iter()
                .flatten()
                .map(|row| row.product_id.as_str()),
        )
    {
        if !products.contains_key(product_id) {
            return Err(error(format!("面积定价引用的产品 {} 已不存在", product_id)));
        }
        let categorized = array(&bundle.main, "categories")?.iter().any(|category| {
            category
                .get("products")
                .and_then(Value::as_array)
                .is_some_and(|members| {
                    members
                        .iter()
                        .any(|product| product["productId"].as_str() == Some(product_id))
                })
        });
        if !categorized {
            return Err(error(format!("产品 {} 尚未归属产品大类", product_id)));
        }
    }
    if let Some(prices) = &area.accessory_prices {
        let styles = catalog(bundle, "accessory-styles.json", "accessoryStyleId")?;
        for row in prices {
            let style = styles
                .get(row.accessory_style_id.as_str())
                .ok_or_else(|| error("公共配件价格引用的样式已不存在"))?;
            if let Some(color_id) = &row.accessory_color_id {
                let matches_style =
                    style
                        .get("colors")
                        .and_then(Value::as_array)
                        .is_some_and(|colors| {
                            colors.iter().any(|color| {
                                color["accessoryColorId"].as_str() == Some(color_id.as_str())
                            })
                        });
                if !matches_style {
                    return Err(error("公共配件价格引用的颜色已不存在或不属于指定样式"));
                }
            }
        }
    }
    for attribute in area.attributes.iter().flatten() {
        validate_area_reference_links(&attribute.option_name, &attribute.reference, bundle)?;
    }
    for plan in area.additional_price_plans.iter().flatten() {
        for price in &plan.prices {
            validate_area_reference_links(&price.option_name, &price.reference, bundle)?;
        }
    }
    for binding in area.category_additional_plan_bindings.iter().flatten() {
        if !categories.contains(binding.category_id.as_str()) {
            return Err(error(format!(
                "附加价格引用的产品大类 {} 已不存在",
                binding.category_id
            )));
        }
    }
    for binding in area.category_attribute_bindings.iter().flatten() {
        if !categories.contains(binding.category_id.as_str()) {
            return Err(error(format!(
                "附加价格引用的产品大类 {} 已不存在",
                binding.category_id
            )));
        }
        validate_area_reference_links(&binding.option_name, &binding.reference, bundle)?;
    }
    for binding in area.product_attribute_overrides.iter().flatten() {
        validate_area_reference_links(&binding.option_name, &binding.reference, bundle)?;
    }
    Ok(())
}

fn validate_area_reference_links(
    option_name: &str,
    reference: &Value,
    bundle: &Bundle,
) -> Result<(), String> {
    let (file, key, id) = area_option_reference(option_name, reference)?;
    let values = bundle
        .catalogs
        .get(file)
        .ok_or_else(|| error(format!("缺少 {file}")))?;
    let found = if key == "accessoryColorId" {
        array(values, "values")?.iter().any(|style| {
            style
                .get("colors")
                .and_then(Value::as_array)
                .is_some_and(|colors| colors.iter().any(|color| color[key].as_str() == Some(id)))
        })
    } else {
        catalog(bundle, file, key)?.contains_key(id)
    };
    if !found {
        return Err(error(format!(
            "面积价格引用的 {} {} 已不存在",
            option_name, id
        )));
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
        area_pricing: None,
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
                standee_pricing: None,
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
        area_pricing: None,
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
            standee_pricing: None,
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
    let retired_bytes = crate::product_option_settings::retired_film_catalog_bytes(
        &root.join("settings/product-options"),
    )?;
    hash.update([u8::from(retired_bytes.is_some())]);
    if let Some(bytes) = retired_bytes {
        hash_file(&mut hash, "tinplate-sticker-films.json", &bytes);
    }
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
        let mut value: Value = serde_json::from_slice(&bytes).map_err(error)?;
        crate::product_option_settings::upgrade_attribute_catalog_label(file, &mut value);
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
    crate::product_option_settings::complete_additional_attribute_options(
        &mut bundle.main,
        &serde_json::to_value(&bundle.catalogs).map_err(error)?,
    )?;
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
    let area_migrated = document.area_pricing.as_ref().is_some_and(|next| {
        current
            .document
            .area_pricing
            .as_ref()
            .is_none_or(|previous| previous.schema_version < next.schema_version)
    });
    if area_migrated {
        let original = read_bytes(&directory.join(FILE_NAME), None)?;
        backup_legacy(
            &directory,
            &original,
            u64::from(current.document.schema_version),
        )?;
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
    fn area_sample() -> AreaPricingDocument {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "accessoryPricing": "style",
            "templates": [{"areaTemplateId": "area-1", "name": "面积档位", "unit": "in",
                "tiers": [{"areaTierId": "tier-1", "maxArea": "10"}, {"areaTierId": "tier-2", "maxArea": null}]}],
            "products": [{"productId": "P31", "body": {
                "basePrice": null, "areaTemplateId": "area-1",
                "tierPrices": [{"areaTierId": "tier-1", "price": "0.13"}, {"areaTierId": "tier-2", "price": null}],
                "formula": "基本价 + 档位价格 * 面积平方毫米"
            }, "totalFormula": "(主体价 + 工艺价) * 折扣系数 * 数量"}],
            "attributes": [{"areaAttributePriceId": "attribute-1", "optionName": "Technique",
                "reference": {"techniqueId": "G11"}, "charge": {
                    "basePrice": "0", "areaTemplateId": "area-1", "tierPrices": [], "formula": "基本价"
                }}]
        })).unwrap()
    }

    fn category_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(area_sample()).unwrap();
        let mut body = raw["products"][0]["body"].clone();
        body["basePrice"] = json!("0.5");
        raw["schemaVersion"] = json!(2);
        raw["categories"] = json!([{"categoryId":"keychains", "body":body}]);
        raw.as_object_mut().unwrap().remove("products");
        serde_json::from_value(raw).unwrap()
    }

    fn category_area_bundle() -> Bundle {
        let mut source = bundle();
        source.main["categories"][0]["name"] = json!("keychains");
        source
    }

    fn priced_template_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(category_area_sample()).unwrap();
        let body = raw["categories"][0]["body"].clone();
        raw["schemaVersion"] = json!(3);
        for field in ["basePrice", "tierPrices", "formula"] {
            raw["templates"][0][field] = body[field].clone();
        }
        raw["categories"] = json!([{"categoryId":"keychains", "areaTemplateId":"area-1"}]);
        raw["productOverrides"] = json!([]);
        serde_json::from_value(raw).unwrap()
    }

    fn attribute_plan_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(priced_template_area_sample()).unwrap();
        raw["schemaVersion"] = json!(4);
        let template = json!({
            "areaTemplateId":"area-extra", "name":"工艺附加价格", "unit":"cm", "boundaryMode":"lower-inclusive",
            "tiers":[{"areaTierId":"extra-tier-1","maxArea":"10"},{"areaTierId":"extra-tier-2","maxArea":null}],
            "basePrice":"0", "tierPrices":[{"areaTierId":"extra-tier-1","price":"0"},{"areaTierId":"extra-tier-2","price":null}],
            "formula":"基本价 + 档位价格 * 面积平方毫米 / 100"
        });
        raw["templates"].as_array_mut().unwrap().push(template);
        raw["attributes"] = json!([
            {"areaAttributePriceId":"attribute-1", "name":"常规工艺", "optionName":"Technique",
                "reference":{"techniqueId":"G11"}, "areaTemplateId":"area-extra"},
            {"areaAttributePriceId":"attribute-2", "name":"特殊工艺", "optionName":"Technique",
                "reference":{"techniqueId":"G11"}, "areaTemplateId":"area-1"}
        ]);
        raw["categoryAttributeBindings"] = json!([
            {"categoryId":"keychains", "optionName":"Technique", "reference":{"techniqueId":"G11"}, "areaAttributePriceId":"attribute-1"}
        ]);
        raw["productAttributeOverrides"] = json!([
            {"productId":"P31", "optionName":"Technique", "reference":{"techniqueId":"G11"}, "areaAttributePriceId":"attribute-2"}
        ]);
        serde_json::from_value(raw).unwrap()
    }

    fn independent_attribute_plan_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(attribute_plan_area_sample()).unwrap();
        raw["schemaVersion"] = json!(5);
        raw["attributes"][0]["basePrice"] = Value::Null;
        raw["attributes"][0]["tierPrices"] = json!([
            {"areaTierId":"extra-tier-1","price":"0"},
            {"areaTierId":"extra-tier-2","price":null}
        ]);
        raw["attributes"][1]["areaTemplateId"] = json!("area-extra");
        raw["attributes"][1]["basePrice"] = json!("0.123456789012345678");
        raw["attributes"][1]["tierPrices"] = json!([
            {"areaTierId":"extra-tier-1","price":"0.234567890123456789"},
            {"areaTierId":"extra-tier-2","price":"0.03"}
        ]);
        raw["productTotalFormulas"] = json!([
            {"productId":"P31","formula":"(主体价 + 工艺价) * 折扣系数 * 数量"}
        ]);
        serde_json::from_value(raw).unwrap()
    }

    fn additional_batch_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(independent_attribute_plan_area_sample()).unwrap();
        let mut first = raw["attributes"][0].clone();
        let mut second = raw["attributes"][1].clone();
        first.as_object_mut().unwrap().remove("name");
        second.as_object_mut().unwrap().remove("name");
        second["areaAttributePriceId"] = first["areaAttributePriceId"].clone();
        let mut film = first.clone();
        film["areaAttributePriceId"] = json!("film-price");
        film["optionName"] = json!("Holo Film");
        film["reference"] = json!({"holoFilmId":"M1"});
        film["areaTemplateId"] = json!("area-1");
        film["basePrice"] = json!("0");
        film["tierPrices"] = json!([
            {"areaTierId":"tier-1","price":"0"},
            {"areaTierId":"tier-2","price":null}
        ]);
        raw["schemaVersion"] = json!(6);
        raw["additionalPricePlans"] = json!([
            {"additionalPricePlanId":"batch-default","name":"默认附加价格方案","prices":[first,film]},
            {"additionalPricePlanId":"batch-special","name":"特殊附加价格方案","prices":[second]}
        ]);
        raw["categoryAdditionalPlanBindings"] = json!([
            {"categoryId":"keychains","additionalPricePlanId":"batch-default"}
        ]);
        raw["productAdditionalPlanOverrides"] = json!([
            {"productId":"P31","additionalPricePlanId":"batch-special"}
        ]);
        for field in [
            "attributes",
            "categoryAttributeBindings",
            "productAttributeOverrides",
        ] {
            raw.as_object_mut().unwrap().remove(field);
        }
        serde_json::from_value(raw).unwrap()
    }

    fn standee_batch_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(additional_batch_area_sample()).unwrap();
        raw["templates"][1]["standeeBase"] = json!({
            "unit":"mm", "matchBy":"longest-side", "boundaryMode":"upper-inclusive",
            "tiers":[{"areaTierId":"base-tier-1","maxArea":"63"},{"areaTierId":"base-tier-2","maxArea":null}],
            "basePrice":"0", "tierPrices":[{"areaTierId":"base-tier-1","price":"2.14"},{"areaTierId":"base-tier-2","price":null}],
            "formula":"基本价 + 档位价格"
        });
        raw["additionalPricePlans"][0]["prices"][0]["standeeBase"] = json!({
            "basePrice":null,
            "tierPrices":[{"areaTierId":"base-tier-1","price":"0"},{"areaTierId":"base-tier-2","price":"0.000000000000000013"}]
        });
        serde_json::from_value(raw).unwrap()
    }

    fn flexible_price_rules_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(standee_batch_area_sample()).unwrap();
        raw["schemaVersion"] = json!(7);
        raw["productAdjustments"] = json!([{"productId":"P31", "amount":"-0.27"}]);
        raw["templates"][0]["exactSizes"] = json!([
            {"areaTierId":"exact-square", "width":"3", "height":"3", "unit":"in", "allowRotation":true}
        ]);
        raw["templates"][0]["tierPrices"]
            .as_array_mut()
            .unwrap()
            .push(json!(
                {"areaTierId":"exact-square", "price":"4.25", "calculation":{"kind":"fixed"}}
            ));
        raw["templates"][1]["formulas"] = json!([
            {"formulaId":"affine-piece", "name":"片材独立公式", "formula":"基本价 + 档位价格 * 面积平方毫米"}
        ]);
        raw["templates"][1]["tierPrices"][0]["calculation"] =
            json!({"kind":"area","basePrice":"-0.2","areaUnit":"mm"});
        raw["templates"][1]["standeeBase"]["formulas"] = json!([
            {"formulaId":"base-custom", "name":"底座独立公式", "formula":"基本价 + 档位价格"}
        ]);
        raw["additionalPricePlans"][0]["prices"][0]["tierPrices"][0]["price"] =
            json!("-0.000003685");
        raw["additionalPricePlans"][0]["prices"][0]["tierPrices"][0]["calculation"] =
            json!({"kind":"formula","basePrice":"-0.87902","formulaId":"affine-piece"});
        raw["additionalPricePlans"][0]["prices"][0]["standeeBase"]["tierPrices"][0]
            ["calculation"] = json!({"kind":"formula","basePrice":null,"formulaId":"base-custom"});
        serde_json::from_value(raw).unwrap()
    }

    #[test]
    fn flexible_rules_v7_roundtrip_preserves_prices_bindings_formulas_and_signed_parameters() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let legacy = standee_batch_area_sample();
        let mut document = initial.document.clone();
        document.area_pricing = Some(legacy.clone());
        let previous = save(root, document, &initial.version).unwrap();
        let old_bytes = fs::read(price_path(root)).unwrap();
        let mut upgraded = serde_json::to_value(&legacy).unwrap();
        upgraded["schemaVersion"] = json!(7);
        upgraded["productAdjustments"] = json!([]);
        let pure_upgrade: AreaPricingDocument = serde_json::from_value(upgraded).unwrap();
        let mut document = previous.document;
        document.area_pricing = Some(pure_upgrade.clone());
        let saved = save(root, document, &previous.version).unwrap();
        assert_eq!(
            read_existing(root).unwrap().document.area_pricing,
            Some(pure_upgrade)
        );
        let migrated = saved.document.area_pricing.as_ref().unwrap();
        assert_eq!(migrated.templates, legacy.templates);
        assert_eq!(
            migrated.additional_price_plans,
            legacy.additional_price_plans
        );
        assert_eq!(migrated.categories, legacy.categories);
        assert_eq!(migrated.product_overrides, legacy.product_overrides);
        assert_eq!(
            migrated.product_additional_plan_overrides,
            legacy.product_additional_plan_overrides
        );
        assert_eq!(
            migrated.product_total_formulas,
            legacy.product_total_formulas
        );
        assert!(fs::read_dir(price_path(root).parent().unwrap())
            .unwrap()
            .any(|entry| {
                let path = entry.unwrap().path();
                path.file_name().unwrap() != FILE_NAME && fs::read(path).unwrap() == old_bytes
            }));
        let mut document = saved.document;
        document.area_pricing = Some(flexible_price_rules_sample());
        let saved = save(root, document, &saved.version).unwrap();
        assert_eq!(read_existing(root).unwrap().document, saved.document);
        assert_eq!(saved.document.products, initial.document.products);
        let wire = serde_json::to_value(saved.document.area_pricing.unwrap()).unwrap();
        assert_eq!(
            wire["templates"][0]["tierPrices"][2]["calculation"],
            json!({"kind":"fixed"})
        );
        assert_eq!(
            wire["additionalPricePlans"][0]["prices"][0]["tierPrices"][0]["price"],
            "-0.000003685"
        );
        assert!(
            wire["additionalPricePlans"][0]["prices"][0]["standeeBase"]["tierPrices"][0]
                ["calculation"]["basePrice"]
                .is_null()
        );
    }

    #[test]
    fn flexible_rules_validate_exact_sizes_units_rotation_and_pure_fixed_groups() {
        let mut raw = serde_json::to_value(flexible_price_rules_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for (width, height, unit, rotated) in
            [("76.2", "76.2", "mm", false), ("7.62", "7.62", "cm", true)]
        {
            let mut collision = raw.clone();
            collision["templates"][0]["exactSizes"].as_array_mut().unwrap().push(json!({
                "areaTierId":"collision", "width":width,"height":height,"unit":unit,"allowRotation":rotated
            }));
            assert!(invalid(collision));
        }
        raw["templates"][0]["exactSizes"][0]["height"] = json!("2");
        let mut flipped = raw.clone();
        flipped["templates"][0]["exactSizes"].as_array_mut().unwrap().push(json!({
            "areaTierId":"flipped", "width":"2", "height":"3", "unit":"in", "allowRotation":false
        }));
        assert!(invalid(flipped.clone()));
        flipped["templates"][0]["exactSizes"][0]["allowRotation"] = json!(false);
        validate_area_pricing(&serde_json::from_value(flipped).unwrap()).unwrap();
        raw["templates"][0]["matchBy"] = json!("exact-size");
        assert!(
            invalid(raw.clone()),
            "pure exact must not retain interval rows"
        );
        raw["templates"][0]["tiers"] = json!([]);
        raw["templates"][0]["tierPrices"] = json!([raw["templates"][0]["tierPrices"][2].clone()]);
        raw["additionalPricePlans"][0]["prices"][1]["tierPrices"] = json!([]);
        raw["templates"][0]["formula"] = json!("档位价格 + 最长边毫米 * 0");
        validate_area_pricing(&serde_json::from_value(raw.clone()).unwrap()).unwrap();
        for (field, value) in [
            ("width", json!("0")),
            ("height", json!("-2")),
            ("unit", json!("px")),
            ("allowRotation", Value::Null),
        ] {
            let mut broken = raw.clone();
            broken["templates"][0]["exactSizes"][0][field] = value;
            assert!(invalid(broken), "{field}");
        }
        raw["templates"][0]["exactSizes"] = json!([]);
        assert!(invalid(raw));
    }

    #[test]
    fn flexible_rules_reject_bad_versions_parameters_formula_scope_and_adjustments() {
        let current = serde_json::to_value(flexible_price_rules_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for (pointer, value) in [
            ("/schemaVersion", json!(6)),
            ("/productAdjustments", Value::Null),
            ("/productAdjustments/0/amount", json!("NaN")),
            ("/productAdjustments/0/productId", json!("")),
            ("/templates/0/exactSizes", Value::Null),
            ("/templates/0/tierPrices/2/calculation", Value::Null),
            ("/templates/1/formulas", Value::Null),
            ("/templates/1/formulas/0/name", json!(" ")),
            ("/templates/1/formulas/0/formula", json!("")),
            (
                "/templates/1/tierPrices/0/calculation/areaUnit",
                json!("px"),
            ),
            (
                "/templates/1/tierPrices/0/calculation/basePrice",
                json!("--1"),
            ),
            (
                "/additionalPricePlans/0/prices/0/tierPrices/0/calculation/formulaId",
                json!("base-custom"),
            ),
            (
                "/additionalPricePlans/0/prices/0/standeeBase/tierPrices/0/calculation/formulaId",
                json!("affine-piece"),
            ),
        ] {
            let mut raw = current.clone();
            *raw.pointer_mut(pointer).unwrap() = value;
            assert!(invalid(raw), "{pointer}");
        }
        let mut raw = current.clone();
        raw.as_object_mut().unwrap().remove("productAdjustments");
        assert!(invalid(raw));
        let mut raw = current.clone();
        raw["productAdjustments"]
            .as_array_mut()
            .unwrap()
            .push(json!({"productId":"P31","amount":null}));
        assert!(invalid(raw));
        let mut raw = current.clone();
        raw["templates"][1]["formulas"]
            .as_array_mut()
            .unwrap()
            .push(current["templates"][1]["formulas"][0].clone());
        assert!(invalid(raw));
        let mut raw = current.clone();
        raw["templates"][0]["tierPrices"][2]["calculation"]["basePrice"] = json!("1");
        assert!(invalid(raw), "fixed calculation forbids unrelated fields");
        let mut area = flexible_price_rules_sample();
        area.product_adjustments.as_mut().unwrap()[0].product_id = "P-does-not-exist".into();
        assert!(validate_area_links(&area, &category_area_bundle()).is_err());
        area.product_adjustments.as_mut().unwrap()[0].product_id = "P31".into();
        area.product_adjustments.as_mut().unwrap()[0].amount = None;
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &category_area_bundle()).unwrap();
        for legacy in [
            area_sample(),
            category_area_sample(),
            priced_template_area_sample(),
            attribute_plan_area_sample(),
            independent_attribute_plan_area_sample(),
            additional_batch_area_sample(),
        ] {
            let mut raw = serde_json::to_value(legacy).unwrap();
            raw["templates"][0]["exactSizes"] = json!([]);
            assert!(invalid(raw));
        }
    }

    #[test]
    fn invalid_flexible_rule_save_preserves_previous_file() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut document = initial.document;
        document.area_pricing = Some(flexible_price_rules_sample());
        let saved = save(root, document, &initial.version).unwrap();
        let before = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document;
        invalid.area_pricing.as_mut().unwrap().templates[0]
            .exact_sizes
            .as_mut()
            .unwrap()[0]
            .width = "0".into();
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), before);
    }

    #[test]
    #[ignore = "Requires PRINTFLOW_PRICE_VALIDATION_FIXTURE pointing to a read-only pricing snapshot"]
    fn external_pricing_snapshot_roundtrips_without_changing_prices_or_formulas() {
        let path = std::env::var("PRINTFLOW_PRICE_VALIDATION_FIXTURE").unwrap();
        let bytes = fs::read(path).unwrap();
        let original: Value = serde_json::from_slice(&bytes).unwrap();
        let mut document: Document = serde_json::from_slice(&bytes).unwrap();
        validate(&document).unwrap();
        assert_eq!(serde_json::to_value(&document).unwrap(), original);
        if let Some(area) = &mut document.area_pricing {
            if area.schema_version == 6 {
                area.schema_version = 7;
                area.product_adjustments = Some(Vec::new());
            }
        }
        validate(&document).unwrap();
        let upgraded: Document =
            serde_json::from_slice(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(document, upgraded);
        let mut upgraded_wire = serde_json::to_value(upgraded).unwrap();
        if original["areaPricing"]["schemaVersion"] == 6 {
            upgraded_wire["areaPricing"]["schemaVersion"] = json!(6);
            upgraded_wire["areaPricing"]
                .as_object_mut()
                .unwrap()
                .remove("productAdjustments");
        }
        assert_eq!(upgraded_wire, original);
    }

    fn explicit_interval_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(flexible_price_rules_sample()).unwrap();
        raw["templates"][1]["tiers"] = json!([
            {"areaTierId":"extra-tier-1","minArea":"0","minInclusive":true,"maxArea":"10"},
            {"areaTierId":"extra-tier-2","minArea":"10","minInclusive":true,"maxArea":"20"}
        ]);
        raw["templates"][1]["standeeBase"]["tiers"] = json!([
            {"areaTierId":"base-tier-1","minArea":"0","minInclusive":true,"maxArea":"49"},
            {"areaTierId":"base-tier-2","minArea":"50","minInclusive":true,"maxArea":"380"}
        ]);
        serde_json::from_value(raw).unwrap()
    }

    #[test]
    fn explicit_intervals_roundtrip_finite_ranges_gaps_and_independent_prices_without_backfilling_old_rows(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let area = explicit_interval_sample();
        let mut document = initial.document;
        document.area_pricing = Some(area.clone());
        let saved = save(root, document, &initial.version).unwrap();
        assert_eq!(
            read_existing(root).unwrap().document.area_pricing,
            Some(area.clone())
        );
        let raw = serde_json::to_value(&area).unwrap();
        assert!(raw["templates"][0]["tiers"][0].get("minArea").is_none());
        assert!(raw["templates"][0]["tiers"][0]
            .get("minInclusive")
            .is_none());
        assert_eq!(
            raw["templates"][1]["standeeBase"]["tiers"][1]["maxArea"],
            "380"
        );
        let original = flexible_price_rules_sample();
        assert_eq!(
            area.templates[1].tier_prices,
            original.templates[1].tier_prices
        );
        assert_eq!(area.additional_price_plans, original.additional_price_plans);
        assert_eq!(area.product_total_formulas, original.product_total_formulas);
        let before = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document;
        invalid.area_pricing.as_mut().unwrap().templates[1]
            .standee_base
            .as_mut()
            .unwrap()
            .tiers[1]
            .min_area = Some("49".into());
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), before);
    }

    #[test]
    fn explicit_intervals_reject_incomplete_mixed_overlapping_or_legacy_fields() {
        let raw = serde_json::to_value(explicit_interval_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for (pointer, value) in [
            ("/templates/1/tiers/0/minArea", Value::Null),
            ("/templates/1/tiers/0/minArea", json!("-1")),
            ("/templates/1/tiers/0/minInclusive", Value::Null),
            ("/templates/1/tiers/0/minInclusive", json!("true")),
            ("/templates/1/tiers/0/maxArea", Value::Null),
            ("/templates/1/tiers/0/maxArea", json!("0")),
            ("/templates/1/tiers/1/minArea", json!("9")),
            (
                "/templates/1/tiers/1/minArea",
                json!("20.000000000000000001"),
            ),
            ("/templates/1/standeeBase/tiers/1/minArea", json!("49")),
            ("/templates/1/standeeBase/tiers/1/minArea", json!("48")),
        ] {
            let mut broken = raw.clone();
            *broken.pointer_mut(pointer).unwrap() = value;
            assert!(invalid(broken), "{pointer}");
        }
        for fields in [
            vec!["minArea"],
            vec!["minInclusive"],
            vec!["minArea", "minInclusive"],
        ] {
            let mut broken = raw.clone();
            for field in fields {
                broken["templates"][1]["tiers"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
            }
            assert!(invalid(broken));
        }
        for legacy in [
            area_sample(),
            category_area_sample(),
            priced_template_area_sample(),
            attribute_plan_area_sample(),
            independent_attribute_plan_area_sample(),
            additional_batch_area_sample(),
        ] {
            let mut broken = serde_json::to_value(legacy).unwrap();
            for tier in broken["templates"][0]["tiers"].as_array_mut().unwrap() {
                tier["minArea"] = json!("0");
                tier["minInclusive"] = json!(true);
            }
            assert!(invalid(broken));
        }
    }

    #[test]
    fn explicit_interval_endpoints_follow_group_closure_and_preserve_decimal_precision() {
        let mut area = explicit_interval_sample();
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[1].min_area = Some("49".into());
        base.tiers[1].min_inclusive = Some(false);
        validate_area_pricing(&area).unwrap();
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[1].min_inclusive = Some(true);
        base.boundary_mode = Some(AreaBoundaryMode::LowerInclusive);
        validate_area_pricing(&area).unwrap();
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.boundary_mode = Some(AreaBoundaryMode::UpperInclusive);
        base.tiers[0].min_area = Some("49".into());
        base.tiers[1].min_inclusive = Some(false);
        validate_area_pricing(&area).unwrap(); // [49,49] followed by (49,380].
        area.templates[1].standee_base.as_mut().unwrap().tiers[0].min_inclusive = Some(false);
        assert!(validate_area_pricing(&area).is_err());
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[0].min_inclusive = Some(true);
        base.tiers[0].min_area = Some("49.000000000000000001".into());
        assert!(validate_area_pricing(&area).is_err()); // Inverted bounds reject even below tolerance.
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[0].min_area = Some("0".into());
        base.tiers[1].min_area = Some("49.000000000002".into());
        base.tiers[1].min_inclusive = Some(true);
        validate_area_pricing(&area).unwrap();
        area.templates[1].standee_base.as_mut().unwrap().tiers[1].min_area =
            Some("49.0000000000005".into());
        assert!(validate_area_pricing(&area).is_err()); // Same 10^-12 mm touching tolerance as the quote engine.
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[1].min_area = Some("48.9999999999995".into());
        base.tiers[1].min_inclusive = Some(false);
        assert!(validate_area_pricing(&area).is_err()); // True overlap rejects even below tolerance with an open lower bound.
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[1].min_area = Some("50".into());
        base.tiers[1].max_area = None;
        validate_area_pricing(&area).unwrap();
        let base = area.templates[1].standee_base.as_mut().unwrap();
        base.tiers[0].min_area = Some("49".into());
        base.tiers[0].max_area = Some("49.0000000000005".into());
        validate_area_pricing(&area).unwrap();
        area.templates[1].standee_base.as_mut().unwrap().tiers[0].min_inclusive = Some(false);
        assert!(validate_area_pricing(&area).is_err());
    }

    #[test]
    fn standee_base_templates_and_additional_prices_save_roundtrip_without_changing_piece_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let area = standee_batch_area_sample();
        let mut next = initial.document.clone();
        next.area_pricing = Some(area.clone());
        let saved = save(root, next, &initial.version).unwrap();
        assert_eq!(saved.document.area_pricing, Some(area.clone()));
        let loaded = read_existing(root).unwrap();
        assert_eq!(loaded.document.area_pricing, Some(area.clone()));
        assert_eq!(loaded.document.products, initial.document.products);
        assert_eq!(
            loaded.document.accessory_prices,
            initial.document.accessory_prices
        );
        let raw = serde_json::to_value(&loaded.document).unwrap();
        assert_eq!(raw["areaPricing"]["schemaVersion"], 6);
        assert!(raw["areaPricing"]["templates"][0]
            .get("standeeBase")
            .is_none());
        assert_eq!(
            raw["areaPricing"]["templates"][1]["standeeBase"]["tierPrices"][0]["price"],
            "2.14"
        );
        assert!(
            raw["areaPricing"]["additionalPricePlans"][0]["prices"][0]["standeeBase"]["basePrice"]
                .is_null()
        );
        assert_eq!(
            raw["areaPricing"]["additionalPricePlans"][0]["prices"][0]["standeeBase"]["tierPrices"]
                [0]["price"],
            "0"
        );
        assert_eq!(
            raw["areaPricing"]["additionalPricePlans"][0]["prices"][0]["standeeBase"]["tierPrices"]
                [1]["price"],
            "0.000000000000000013"
        );
        // A new base section may remain absent on an existing additional price until configured.
        assert!(raw["areaPricing"]["additionalPricePlans"][1]["prices"][0]
            .get("standeeBase")
            .is_none());
        let baseline = additional_batch_area_sample();
        assert_eq!(
            area.templates[1].tier_prices,
            baseline.templates[1].tier_prices
        );
        assert_eq!(
            area.additional_price_plans.as_ref().unwrap()[0].prices[0].tier_prices,
            baseline.additional_price_plans.as_ref().unwrap()[0].prices[0].tier_prices
        );
    }

    #[test]
    fn standee_base_fields_validate_version_shape_and_independent_tiers() {
        let current = serde_json::to_value(standee_batch_area_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for (pointer, value) in [
            ("/templates/1/standeeBase", Value::Null),
            ("/templates/1/standeeBase/unit", json!("px")),
            ("/templates/1/standeeBase/matchBy", Value::Null),
            ("/templates/1/standeeBase/boundaryMode", json!("other")),
            ("/templates/1/standeeBase/tiers", json!([])),
            ("/templates/1/standeeBase/tiers/0/maxArea", json!("0")),
            (
                "/templates/1/standeeBase/tiers/0/areaTierId",
                json!("tier-1"),
            ),
            ("/templates/1/standeeBase/tiers/1/maxArea", json!("100")),
            ("/templates/1/standeeBase/basePrice", json!("-1")),
            ("/templates/1/standeeBase/tierPrices/0/price", json!("NaN")),
            (
                "/templates/1/standeeBase/tierPrices/0/areaTierId",
                json!("extra-tier-1"),
            ),
            ("/templates/1/standeeBase/formula", json!("")),
            ("/additionalPricePlans/0/prices/0/standeeBase", Value::Null),
            (
                "/additionalPricePlans/0/prices/0/standeeBase/basePrice",
                json!("-0.1"),
            ),
            (
                "/additionalPricePlans/0/prices/0/standeeBase/tierPrices/0/areaTierId",
                json!("extra-tier-1"),
            ),
            (
                "/additionalPricePlans/0/prices/0/standeeBase/tierPrices/0/price",
                json!("NaN"),
            ),
        ] {
            let mut raw = current.clone();
            *raw.pointer_mut(pointer).unwrap() = value;
            assert!(invalid(raw), "{pointer}");
        }
        for field in ["unit", "tiers", "basePrice", "tierPrices", "formula"] {
            let mut raw = current.clone();
            raw["templates"][1]["standeeBase"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(invalid(raw), "missing base template {field}");
        }
        for field in ["basePrice", "tierPrices"] {
            let mut raw = current.clone();
            raw["additionalPricePlans"][0]["prices"][0]["standeeBase"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(invalid(raw), "missing additional base {field}");
        }
        for field in ["standeeBase", "areaTemplateId", "name"] {
            let mut raw = current.clone();
            raw["templates"][1]["standeeBase"][field] = json!({});
            assert!(invalid(raw), "unexpected base field {field}");
        }
        let mut raw = current.clone();
        raw["templates"][1]["standeeBase"]["matchBy"] = json!("area");
        raw["templates"][1]["standeeBase"]["formula"] = json!("档位价格 * 最长边毫米");
        assert!(invalid(raw));
        for legacy in [
            area_sample(),
            category_area_sample(),
            priced_template_area_sample(),
            attribute_plan_area_sample(),
            independent_attribute_plan_area_sample(),
        ] {
            let mut raw = serde_json::to_value(legacy).unwrap();
            raw["templates"][0]["standeeBase"] = current["templates"][1]["standeeBase"].clone();
            assert!(invalid(raw), "legacy standeeBase");
        }
        let mut raw = current;
        raw["templates"][1]
            .as_object_mut()
            .unwrap()
            .remove("standeeBase");
        assert!(
            invalid(raw),
            "additional base without matching template base"
        );
    }

    #[test]
    fn invalid_standee_base_reference_save_preserves_existing_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut next = initial.document;
        next.area_pricing = Some(standee_batch_area_sample());
        let saved = save(root, next, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document.clone();
        invalid
            .area_pricing
            .as_mut()
            .unwrap()
            .additional_price_plans
            .as_mut()
            .unwrap()[0]
            .prices[0]
            .standee_base
            .as_mut()
            .unwrap()
            .tier_prices[0]
            .area_tier_id = "extra-tier-1".into();
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
        assert_eq!(read_existing(root).unwrap().document, saved.document);
    }

    #[test]
    fn additional_batches_roundtrip_independent_rows_and_templates_without_old_scopes() {
        let mut area = additional_batch_area_sample();
        area.templates[1].match_by = Some(TemplateMatchBy::LongestSide);
        area.templates[1].formula = Some("基本价 + 档位价格 * 最长边毫米".into());
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &category_area_bundle()).unwrap();
        let raw = serde_json::to_value(&area).unwrap();
        assert!(raw["additionalPricePlans"][0]["prices"][0]["basePrice"].is_null());
        assert_eq!(
            raw["additionalPricePlans"][0]["prices"][0]["tierPrices"][0]["price"],
            "0"
        );
        assert!(raw["additionalPricePlans"][0]["prices"][0]["tierPrices"][1]["price"].is_null());
        assert_eq!(
            raw["additionalPricePlans"][1]["prices"][0]["basePrice"],
            "0.123456789012345678"
        );
        assert_eq!(
            raw["additionalPricePlans"][1]["prices"][0]["tierPrices"][0]["price"],
            "0.234567890123456789"
        );
        assert_eq!(
            raw["additionalPricePlans"][0]["prices"][1]["areaTemplateId"],
            "area-1"
        );
        for field in [
            "attributes",
            "categoryAttributeBindings",
            "productAttributeOverrides",
        ] {
            assert!(raw.get(field).is_none());
        }
        for field in ["name", "formula", "charge"] {
            assert!(raw["additionalPricePlans"][0]["prices"][0]
                .get(field)
                .is_none());
        }
        assert_eq!(
            serde_json::from_value::<AreaPricingDocument>(raw).unwrap(),
            area
        );
        let first = area.additional_price_plans.as_ref().unwrap()[0].clone();
        area.additional_price_plans.as_mut().unwrap()[1].prices[0].base_price = Some("12".into());
        validate_area_pricing(&area).unwrap();
        assert_eq!(area.additional_price_plans.as_ref().unwrap()[0], first);
    }

    #[test]
    fn additional_batch_schema_requires_fields_and_rejects_legacy_scope_mixing() {
        let current = serde_json::to_value(additional_batch_area_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for field in [
            "additionalPricePlans",
            "categoryAdditionalPlanBindings",
            "productAdditionalPlanOverrides",
            "productTotalFormulas",
        ] {
            let mut raw = current.clone();
            raw.as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing {field}");
            let mut raw = current.clone();
            raw[field] = Value::Null;
            assert!(invalid(raw), "null {field}");
        }
        for field in [
            "attributes",
            "categoryAttributeBindings",
            "productAttributeOverrides",
        ] {
            let mut raw = current.clone();
            raw[field] = json!([]);
            assert!(invalid(raw), "mixed old scope {field}");
        }
        for legacy in [
            area_sample(),
            category_area_sample(),
            priced_template_area_sample(),
            attribute_plan_area_sample(),
            independent_attribute_plan_area_sample(),
        ] {
            let old = serde_json::to_value(legacy).unwrap();
            for field in [
                "additionalPricePlans",
                "categoryAdditionalPlanBindings",
                "productAdditionalPlanOverrides",
            ] {
                let mut raw = old.clone();
                raw[field] = json!([]);
                assert!(invalid(raw), "old schema accepts {field}");
            }
            let mut raw = old;
            raw.as_object_mut().unwrap().remove("attributes");
            assert!(invalid(raw), "old schema requires attributes");
        }
        for field in ["additionalPricePlanId", "name", "prices"] {
            let mut raw = current.clone();
            raw["additionalPricePlans"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(invalid(raw), "missing plan {field}");
            let mut raw = current.clone();
            raw["additionalPricePlans"][0][field] = Value::Null;
            assert!(invalid(raw), "null plan {field}");
        }
        for field in [
            "areaAttributePriceId",
            "optionName",
            "reference",
            "areaTemplateId",
            "basePrice",
            "tierPrices",
        ] {
            let mut raw = current.clone();
            raw["additionalPricePlans"][0]["prices"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(invalid(raw), "missing row {field}");
        }
        for (field, value) in [
            ("name", json!("旧属性方案")),
            ("formula", json!("基本价")),
            ("charge", json!({})),
            ("basePrice", json!("-1")),
            ("basePrice", json!("0.1234567890123456789")),
            ("basePrice", json!(0)),
            ("areaTemplateId", json!("missing")),
            ("tierPrices", Value::Null),
            ("reference", json!({"id":"G11"})),
            ("reference", json!({"holoFilmId":"G11"})),
        ] {
            let mut raw = current.clone();
            raw["additionalPricePlans"][0]["prices"][0][field] = value;
            assert!(invalid(raw), "invalid row {field}");
        }
        for (name, reference) in [
            ("Print Option", json!({"printOptionId":"Y1"})),
            ("Accessories Style", json!({"accessoryStyleId":"A1"})),
        ] {
            let mut raw = current.clone();
            raw["additionalPricePlans"][0]["prices"][0]["optionName"] = json!(name);
            raw["additionalPricePlans"][0]["prices"][0]["reference"] = reference;
            assert!(invalid(raw), "unpriced or fixed option {name}");
        }
    }

    #[test]
    fn additional_batches_validate_plan_scoped_identity_amounts_and_whole_bindings() {
        let area = additional_batch_area_sample();
        let mut invalid = area.clone();
        invalid.additional_price_plans.as_mut().unwrap()[1].additional_price_plan_id =
            "batch-default".into();
        assert!(validate_area_pricing(&invalid).is_err());
        for field in ["id", "reference"] {
            let mut invalid = area.clone();
            let plan = &mut invalid.additional_price_plans.as_mut().unwrap()[0];
            if field == "id" {
                plan.prices[1].area_attribute_price_id =
                    plan.prices[0].area_attribute_price_id.clone();
            } else {
                plan.prices[1].option_name = plan.prices[0].option_name.clone();
                plan.prices[1].reference = plan.prices[0].reference.clone();
            }
            assert!(validate_area_pricing(&invalid).is_err());
        }
        for value in ["-0.5", "0.1234567890123456789", "NaN"] {
            let mut invalid = area.clone();
            invalid.additional_price_plans.as_mut().unwrap()[0].prices[0].tier_prices[0].price =
                Some(value.into());
            assert!(validate_area_pricing(&invalid).is_err());
        }
        for id in ["tier-1", "missing", ""] {
            let mut invalid = area.clone();
            invalid.additional_price_plans.as_mut().unwrap()[0].prices[0].tier_prices[0]
                .area_tier_id = id.into();
            assert!(validate_area_pricing(&invalid).is_err());
        }
        let mut invalid = area.clone();
        let duplicate =
            invalid.additional_price_plans.as_ref().unwrap()[0].prices[0].tier_prices[0].clone();
        invalid.additional_price_plans.as_mut().unwrap()[0].prices[0]
            .tier_prices
            .push(duplicate);
        assert!(validate_area_pricing(&invalid).is_err());
        let current = serde_json::to_value(area).unwrap();
        let is_invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for (field, scope) in [
            ("categoryAdditionalPlanBindings", "categoryId"),
            ("productAdditionalPlanOverrides", "productId"),
        ] {
            for id in ["", "missing", " batch-default"] {
                let mut raw = current.clone();
                raw[field][0]["additionalPricePlanId"] = json!(id);
                assert!(is_invalid(raw));
            }
            let mut raw = current.clone();
            raw[field][0]["additionalPricePlanId"] = Value::Null;
            validate_area_pricing(&serde_json::from_value(raw.clone()).unwrap()).unwrap();
            assert!(serde_json::to_value(
                serde_json::from_value::<AreaPricingDocument>(raw).unwrap()
            )
            .unwrap()[field][0]["additionalPricePlanId"]
                .is_null());
            for property in [scope, "additionalPricePlanId"] {
                let mut raw = current.clone();
                raw[field][0].as_object_mut().unwrap().remove(property);
                assert!(is_invalid(raw));
            }
            let mut raw = current.clone();
            let duplicate = raw[field][0].clone();
            raw[field].as_array_mut().unwrap().push(duplicate);
            assert!(is_invalid(raw));
            let mut raw = current.clone();
            raw[field][0][scope] = json!(" ");
            assert!(is_invalid(raw));
            let mut raw = current.clone();
            raw[field][0]["optionName"] = json!("Technique");
            assert!(is_invalid(raw));
        }
    }

    #[test]
    fn additional_batch_links_require_existing_attributes_and_categorized_products() {
        let area = additional_batch_area_sample();
        let mut invalid = area.clone();
        invalid.additional_price_plans.as_mut().unwrap()[0].prices[0].reference =
            json!({"techniqueId":"G999"});
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("已不存在"));
        let mut invalid = area.clone();
        invalid.category_additional_plan_bindings.as_mut().unwrap()[0].category_id =
            "missing".into();
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("产品大类 missing 已不存在"));
        let mut invalid = area.clone();
        invalid.product_additional_plan_overrides.as_mut().unwrap()[0].product_id = "P999".into();
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        let mut area = area;
        area.product_total_formulas = Some(vec![]);
        let mut ungrouped = category_area_bundle();
        let product = ungrouped.main["categories"][0]["products"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        ungrouped.main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(product);
        assert!(validate_area_links(&area, &ungrouped)
            .unwrap_err()
            .contains("尚未归属产品大类"));
    }

    #[test]
    fn additional_batches_save_roundtrip_and_preserve_v5_backup_and_old_sections() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut prior = initial.document;
        prior.area_pricing = Some(independent_attribute_plan_area_sample());
        let legacy = save(root, prior, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut next = legacy.document.clone();
        next.area_pricing = Some(additional_batch_area_sample());
        let saved = save(root, next.clone(), &legacy.version).unwrap();
        assert_eq!(saved.document, next);
        assert_eq!(read_existing(root).unwrap().document, next);
        assert_eq!(saved.document.products, legacy.document.products);
        assert_eq!(
            saved.document.accessory_prices,
            legacy.document.accessory_prices
        );
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            legacy.document.schema_version
        ));
        assert_eq!(fs::read(&backup).unwrap(), original);
        let saved_again = save(root, saved.document, &saved.version).unwrap();
        assert_eq!(saved_again.document, next);
        assert_eq!(fs::read(&backup).unwrap(), original);
    }

    #[test]
    fn invalid_batch_save_preserves_file_and_stale_references_remain_loadable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut next = initial.document;
        next.area_pricing = Some(additional_batch_area_sample());
        let saved = save(root, next.clone(), &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document;
        invalid
            .area_pricing
            .as_mut()
            .unwrap()
            .additional_price_plans
            .as_mut()
            .unwrap()[0]
            .prices[0]
            .tier_prices[0]
            .area_tier_id = "tier-1".into();
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
        next.area_pricing
            .as_mut()
            .unwrap()
            .product_additional_plan_overrides
            .as_mut()
            .unwrap()[0]
            .product_id = "P999".into();
        let stale = serde_json::to_vec_pretty(&next).unwrap();
        fs::write(price_path(root), &stale).unwrap();
        let loaded = read_existing(root).unwrap();
        assert_eq!(loaded.document, next);
        assert!(save(root, loaded.document, &loaded.version)
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        assert_eq!(fs::read(price_path(root)).unwrap(), stale);
    }

    #[test]
    fn independent_attribute_prices_and_product_formulas_roundtrip_in_both_matching_modes() {
        for mode in [TemplateMatchBy::Area, TemplateMatchBy::LongestSide] {
            let mut area = independent_attribute_plan_area_sample();
            area.templates[1].formula = Some(
                if mode == TemplateMatchBy::LongestSide {
                    "基本价 + 档位价格 * 最长边毫米"
                } else {
                    "基本价 + 档位价格 * 面积平方毫米"
                }
                .into(),
            );
            area.templates[1].match_by = Some(mode);
            validate_area_pricing(&area).unwrap();
            validate_area_links(&area, &category_area_bundle()).unwrap();
            let raw = serde_json::to_value(&area).unwrap();
            assert!(raw["attributes"][0]["basePrice"].is_null());
            assert_eq!(raw["attributes"][0]["tierPrices"][0]["price"], "0");
            assert!(raw["attributes"][0]["tierPrices"][1]["price"].is_null());
            assert_eq!(raw["attributes"][1]["basePrice"], "0.123456789012345678");
            assert_eq!(
                raw["attributes"][1]["tierPrices"][0]["price"],
                "0.234567890123456789"
            );
            assert!(raw["attributes"][0].get("charge").is_none());
            assert!(raw["attributes"][0].get("formula").is_none());
            assert_eq!(
                serde_json::from_value::<AreaPricingDocument>(raw).unwrap(),
                area
            );
            let original_plan = area.attributes.as_mut().unwrap()[0].clone();
            area.attributes.as_mut().unwrap()[1].base_price = Some(Some("9.5".into()));
            area.templates[1].base_price = Some(Some("20".into()));
            validate_area_pricing(&area).unwrap();
            assert_eq!(area.attributes.as_mut().unwrap()[0], original_plan);
        }
    }

    #[test]
    fn independent_attribute_plan_schema_requires_complete_versioned_fields() {
        let current = serde_json::to_value(independent_attribute_plan_area_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for field in [
            "categoryAttributeBindings",
            "productAttributeOverrides",
            "productTotalFormulas",
        ] {
            let mut raw = current.clone();
            raw.as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing {field}");
            let mut raw = current.clone();
            raw[field] = Value::Null;
            assert!(invalid(raw), "null {field}");
        }
        for field in ["name", "areaTemplateId", "basePrice", "tierPrices"] {
            let mut raw = current.clone();
            raw["attributes"][0].as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing plan {field}");
        }
        for (field, value) in [
            ("name", Value::Null),
            ("name", json!(" ")),
            ("areaTemplateId", Value::Null),
            ("areaTemplateId", json!("missing")),
            ("basePrice", json!(0)),
            ("basePrice", json!("-0.5")),
            ("basePrice", json!("0.1234567890123456789")),
            ("tierPrices", Value::Null),
            ("formula", json!("基本价")),
            (
                "charge",
                json!({"basePrice":"0","areaTemplateId":"area-extra","tierPrices":[],"formula":"基本价"}),
            ),
        ] {
            let mut raw = current.clone();
            raw["attributes"][0][field] = value;
            assert!(invalid(raw), "invalid plan {field}");
        }
        for legacy in [
            area_sample(),
            category_area_sample(),
            priced_template_area_sample(),
            attribute_plan_area_sample(),
        ] {
            let old = serde_json::to_value(legacy).unwrap();
            for field in ["basePrice", "tierPrices"] {
                let mut raw = old.clone();
                raw["attributes"][0][field] = current["attributes"][0][field].clone();
                assert!(invalid(raw), "legacy plan with {field}");
            }
            let mut raw = old;
            raw["productTotalFormulas"] = json!([]);
            assert!(invalid(raw), "legacy with product formulas");
        }
    }

    #[test]
    fn independent_attribute_plan_prices_reject_invalid_tier_references_and_amounts() {
        let area = independent_attribute_plan_area_sample();
        for id in ["tier-1", "missing", ""] {
            let mut invalid = area.clone();
            invalid.attributes.as_mut().unwrap()[0]
                .tier_prices
                .as_mut()
                .unwrap()[0]
                .area_tier_id = id.into();
            assert!(validate_area_pricing(&invalid).is_err());
        }
        let mut invalid = area.clone();
        let duplicate = invalid.attributes.as_mut().unwrap()[0]
            .tier_prices
            .as_ref()
            .unwrap()[0]
            .clone();
        invalid.attributes.as_mut().unwrap()[0]
            .tier_prices
            .as_mut()
            .unwrap()
            .push(duplicate);
        assert!(validate_area_pricing(&invalid).is_err());
        for value in ["-0.5", "NaN", "0.1234567890123456789"] {
            let mut invalid = area.clone();
            invalid.attributes.as_mut().unwrap()[0]
                .tier_prices
                .as_mut()
                .unwrap()[0]
                .price = Some(value.into());
            assert!(validate_area_pricing(&invalid).is_err());
        }
        let mut invalid = area;
        invalid.attributes.as_mut().unwrap()[1].area_attribute_price_id =
            invalid.attributes.as_mut().unwrap()[0]
                .area_attribute_price_id
                .clone();
        assert!(validate_area_pricing(&invalid).is_err());
    }

    #[test]
    fn product_total_formulas_validate_identity_text_and_category_ownership() {
        let mut area = independent_attribute_plan_area_sample();
        // Keep the formula as the only reference to P31 to isolate ownership checks.
        area.product_attribute_overrides = Some(vec![]);
        for id in ["", " P31", "P31 "] {
            let mut invalid = area.clone();
            invalid.product_total_formulas.as_mut().unwrap()[0].product_id = id.into();
            assert!(validate_area_pricing(&invalid).is_err());
        }
        for formula in [String::new(), " ".into(), "价".repeat(2_001)] {
            let mut invalid = area.clone();
            invalid.product_total_formulas.as_mut().unwrap()[0].formula = formula;
            assert!(validate_area_pricing(&invalid).is_err());
        }
        let mut invalid = area.clone();
        let duplicate = invalid.product_total_formulas.as_ref().unwrap()[0].clone();
        invalid
            .product_total_formulas
            .as_mut()
            .unwrap()
            .push(duplicate);
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.product_total_formulas.as_mut().unwrap()[0].product_id = "P999".into();
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        let mut ungrouped = category_area_bundle();
        let product = ungrouped.main["categories"][0]["products"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        ungrouped.main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(product);
        assert!(validate_area_links(&area, &ungrouped)
            .unwrap_err()
            .contains("尚未归属产品大类"));

        let current = serde_json::to_value(&area).unwrap();
        for field in ["productId", "formula"] {
            let mut raw = current.clone();
            raw["productTotalFormulas"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(serde_json::from_value::<AreaPricingDocument>(raw).is_err());
            let mut raw = current.clone();
            raw["productTotalFormulas"][0][field] = Value::Null;
            assert!(serde_json::from_value::<AreaPricingDocument>(raw).is_err());
        }
        area.product_total_formulas = Some(vec![]);
        validate_area_pricing(&area).unwrap();
    }

    #[test]
    fn independent_attribute_plan_migration_roundtrips_and_preserves_v4_backup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut prior = initial.document;
        prior.area_pricing = Some(attribute_plan_area_sample());
        let legacy = save(root, prior, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut next = legacy.document.clone();
        next.area_pricing = Some(independent_attribute_plan_area_sample());
        let saved = save(root, next.clone(), &legacy.version).unwrap();
        assert_eq!(saved.document, next);
        assert_eq!(read_existing(root).unwrap().document, next);
        assert_eq!(saved.document.products, legacy.document.products);
        assert_eq!(
            saved.document.accessory_prices,
            legacy.document.accessory_prices
        );
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            legacy.document.schema_version
        ));
        assert_eq!(fs::read(&backup).unwrap(), original);
        let saved_again = save(root, saved.document, &saved.version).unwrap();
        assert_eq!(saved_again.document, next);
        assert_eq!(fs::read(&backup).unwrap(), original);
    }

    #[test]
    fn invalid_independent_plan_save_preserves_file_and_formula_reference_for_repair() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut next = initial.document;
        next.area_pricing = Some(independent_attribute_plan_area_sample());
        let saved = save(root, next.clone(), &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document;
        invalid
            .area_pricing
            .as_mut()
            .unwrap()
            .attributes
            .as_mut()
            .unwrap()[0]
            .tier_prices
            .as_mut()
            .unwrap()[0]
            .area_tier_id = "tier-1".into();
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);

        next.area_pricing
            .as_mut()
            .unwrap()
            .product_total_formulas
            .as_mut()
            .unwrap()[0]
            .product_id = "P999".into();
        let original = serde_json::to_vec_pretty(&next).unwrap();
        fs::write(price_path(root), &original).unwrap();
        let loaded = read_existing(root).unwrap();
        assert_eq!(loaded.document, next);
        assert!(save(root, loaded.document, &loaded.version)
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
    }

    #[test]
    fn template_matching_preserves_omitted_area_and_rejects_invalid_or_legacy_modes() {
        let original = serde_json::to_value(attribute_plan_area_sample()).unwrap();
        let parsed: AreaPricingDocument = serde_json::from_value(original.clone()).unwrap();
        validate_area_pricing(&parsed).unwrap();
        assert!(parsed
            .templates
            .iter()
            .all(|template| template.match_by.is_none()));
        assert_eq!(serde_json::to_value(parsed).unwrap(), original);

        for mode in ["area", "longest-side"] {
            let mut raw = original.clone();
            raw["templates"][0]["matchBy"] = json!(mode);
            let parsed: AreaPricingDocument = serde_json::from_value(raw.clone()).unwrap();
            validate_area_pricing(&parsed).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
        }
        for mode in [
            Value::Null,
            json!("longest"),
            json!(""),
            json!(true),
            json!(1),
        ] {
            let mut raw = original.clone();
            raw["templates"][0]["matchBy"] = mode;
            assert!(serde_json::from_value::<AreaPricingDocument>(raw).is_err());
        }
        for legacy in [
            area_sample(),
            category_area_sample(),
            priced_template_area_sample(),
        ] {
            for mode in ["area", "longest-side"] {
                let mut raw = serde_json::to_value(&legacy).unwrap();
                raw["templates"][0]["matchBy"] = json!(mode);
                let parsed: AreaPricingDocument = serde_json::from_value(raw).unwrap();
                assert!(validate_area_pricing(&parsed)
                    .unwrap_err()
                    .contains("版本不符"));
            }
        }
    }

    #[test]
    fn longest_side_formula_variable_requires_longest_side_template() {
        let mut area = attribute_plan_area_sample();
        area.templates[0].formula = Some("基本价 + 档位价格 * 最长边毫米".into());
        assert!(validate_area_pricing(&area)
            .unwrap_err()
            .contains("最长边毫米"));
        area.templates[0].match_by = Some(TemplateMatchBy::Area);
        assert!(validate_area_pricing(&area).is_err());
        area.templates[0].match_by = Some(TemplateMatchBy::LongestSide);
        validate_area_pricing(&area).unwrap();
        for formula in [
            "基本价 + 档位价格 * 面积平方毫米",
            "基本价 + 档位价格",
            "基本价 + 档位价格 * (最长边毫米 / 25.4)",
        ] {
            area.templates[0].formula = Some(formula.into());
            validate_area_pricing(&area).unwrap();
        }
        area.templates[1].formula = Some("最长边毫米 * 档位价格".into());
        assert!(validate_area_pricing(&area).is_err());
        area.templates[1].match_by = Some(TemplateMatchBy::LongestSide);
        validate_area_pricing(&area).unwrap();
    }

    #[test]
    fn longest_side_templates_roundtrip_for_base_and_additional_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut area = attribute_plan_area_sample();
        area.templates[0].match_by = Some(TemplateMatchBy::LongestSide);
        area.templates[0].unit = "in".into();
        area.templates[0].boundary_mode = Some(AreaBoundaryMode::UpperInclusive);
        area.templates[0].tiers[0].max_area = Some("2.5".into());
        area.templates[0].formula = Some("基本价 + 档位价格 * 面积平方毫米".into());
        area.templates[1].match_by = Some(TemplateMatchBy::LongestSide);
        area.templates[1].unit = "mm".into();
        area.templates[1].tiers[0].max_area = Some("63.5".into());
        area.templates[1].formula = Some("基本价 + 档位价格 * 最长边毫米".into());
        area.templates[1].tier_prices.as_mut().unwrap()[0].price =
            Some("0.000000000000000013".into());
        let mut next = initial.document.clone();
        next.area_pricing = Some(area.clone());
        let saved = save(root, next, &initial.version).unwrap();
        assert_eq!(saved.document.area_pricing, Some(area.clone()));
        let loaded = read_existing(root).unwrap();
        assert_eq!(loaded.document.area_pricing, Some(area));
        assert_eq!(loaded.document.products, initial.document.products);
        assert_eq!(
            loaded.document.accessory_prices,
            initial.document.accessory_prices
        );
        let stored: Value = serde_json::from_slice(&fs::read(price_path(root)).unwrap()).unwrap();
        assert_eq!(
            stored["areaPricing"]["templates"][0]["matchBy"],
            "longest-side"
        );
        assert_eq!(
            stored["areaPricing"]["templates"][1]["matchBy"],
            "longest-side"
        );
        assert_eq!(
            stored["areaPricing"]["templates"][1]["tierPrices"][0]["price"],
            "0.000000000000000013"
        );
        assert!(stored["areaPricing"]["templates"][1]["tierPrices"][1]["price"].is_null());
        assert_eq!(
            stored["areaPricing"]["categories"][0]["areaTemplateId"],
            "area-1"
        );
        assert_eq!(
            stored["areaPricing"]["attributes"][0]["areaTemplateId"],
            "area-extra"
        );
        let saved_again = save(root, loaded.document.clone(), &loaded.version).unwrap();
        assert_eq!(saved_again.document, loaded.document);
    }

    #[test]
    fn invalid_longest_side_template_save_preserves_existing_area_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut next = initial.document.clone();
        next.area_pricing = Some(attribute_plan_area_sample());
        let saved = save(root, next, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document.clone();
        invalid.area_pricing.as_mut().unwrap().templates[0].formula =
            Some("基本价 + 档位价格 * 最长边毫米".into());
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
        let mut invalid = saved.document.clone();
        invalid.area_pricing.as_mut().unwrap().templates[0].match_by =
            Some(TemplateMatchBy::LongestSide);
        invalid.area_pricing.as_mut().unwrap().templates[0].tiers[0].max_area = Some("0".into());
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
        let reread = read_existing(root).unwrap();
        assert_eq!(reread.document, saved.document);
        let raw = serde_json::to_value(reread.document).unwrap();
        assert!(raw["areaPricing"]["templates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|template| template.get("matchBy").is_none()));
    }

    #[test]
    fn attribute_plans_require_versioned_fields_without_duplicate_prices() {
        let area = attribute_plan_area_sample();
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &category_area_bundle()).unwrap();
        let current = serde_json::to_value(&area).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for field in ["categoryAttributeBindings", "productAttributeOverrides"] {
            let mut raw = current.clone();
            raw.as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing {field}");
            let mut raw = current.clone();
            raw[field] = Value::Null;
            assert!(invalid(raw), "null {field}");
            for legacy in [
                area_sample(),
                category_area_sample(),
                priced_template_area_sample(),
            ] {
                let mut raw = serde_json::to_value(legacy).unwrap();
                raw[field] = json!([]);
                assert!(invalid(raw), "legacy with {field}");
            }
        }
        for field in ["name", "areaTemplateId"] {
            let mut raw = current.clone();
            raw["attributes"][0].as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing plan {field}");
            for value in [Value::Null, json!(""), json!(" ")] {
                let mut raw = current.clone();
                raw["attributes"][0][field] = value;
                assert!(invalid(raw), "invalid plan {field}");
            }
            let mut legacy = serde_json::to_value(priced_template_area_sample()).unwrap();
            legacy["attributes"][0][field] = current["attributes"][0][field].clone();
            assert!(invalid(legacy), "legacy plan with {field}");
        }
        let old = serde_json::to_value(area_sample()).unwrap();
        for charge in [old["attributes"][0]["charge"].clone(), Value::Null] {
            let mut raw = current.clone();
            raw["attributes"][0]["charge"] = charge;
            assert!(invalid(raw));
        }
        let mut raw = current.clone();
        raw["attributes"][0]["areaTemplateId"] = json!("missing");
        assert!(invalid(raw));
        for field in ["basePrice", "tierPrices", "formula"] {
            let mut raw = current.clone();
            raw["templates"][0].as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing template {field}");
        }
        let mut raw = current;
        raw["attributes"][1]["areaAttributePriceId"] = json!("attribute-1");
        assert!(invalid(raw));
    }

    #[test]
    fn attribute_bindings_validate_uniqueness_entity_and_plan_ownership() {
        let current = serde_json::to_value(attribute_plan_area_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        for field in ["categoryAttributeBindings", "productAttributeOverrides"] {
            let mut raw = current.clone();
            let duplicate = raw[field][0].clone();
            raw[field].as_array_mut().unwrap().push(duplicate);
            assert!(invalid(raw), "duplicate {field}");
            let mut raw = current.clone();
            raw[field][0]
                .as_object_mut()
                .unwrap()
                .remove("areaAttributePriceId");
            assert!(invalid(raw), "missing plan selection {field}");
            for id in ["missing", "", " "] {
                let mut raw = current.clone();
                raw[field][0]["areaAttributePriceId"] = json!(id);
                assert!(invalid(raw));
            }
            for reference in [
                json!({"id":"G11"}),
                json!({"techniqueId":"G12"}),
                json!({"holoFilmId":"G11"}),
                json!({"techniqueId":"G11","holoFilmId":"M1"}),
            ] {
                let mut raw = current.clone();
                raw[field][0]["reference"] = reference;
                assert!(invalid(raw), "wrong entity in {field}");
            }
            let mut raw = current.clone();
            raw[field][0]["optionName"] = json!("Holo Film");
            raw[field][0]["reference"] = json!({"holoFilmId":"M1"});
            assert!(invalid(raw), "cross attribute plan in {field}");
        }
        let mut raw = current;
        raw["categoryAttributeBindings"][0]["categoryId"] = json!("");
        assert!(invalid(raw));
    }

    #[test]
    fn attribute_plans_exclude_print_and_fixed_accessories_even_without_accessory_table() {
        let current = serde_json::to_value(attribute_plan_area_sample()).unwrap();
        for (name, reference) in [
            ("Print Option", json!({"printOptionId":"Y1"})),
            ("Accessories Style", json!({"accessoryStyleId":"A1"})),
        ] {
            let mut raw = current.clone();
            raw["attributes"][0]["optionName"] = json!(name);
            raw["attributes"][0]["reference"] = reference.clone();
            let area: AreaPricingDocument = serde_json::from_value(raw).unwrap();
            assert!(validate_area_pricing(&area).is_err());
            for field in ["categoryAttributeBindings", "productAttributeOverrides"] {
                let mut raw = current.clone();
                raw[field][0]["optionName"] = json!(name);
                raw[field][0]["reference"] = reference.clone();
                raw[field][0]["areaAttributePriceId"] = Value::Null;
                let area: AreaPricingDocument = serde_json::from_value(raw).unwrap();
                assert!(validate_area_pricing(&area).is_err());
            }
        }
    }

    #[test]
    fn attribute_bindings_preserve_explicit_unpriced_and_validate_unassigned_references() {
        let mut area = attribute_plan_area_sample();
        area.category_attribute_bindings.as_mut().unwrap()[0].area_attribute_price_id = None;
        area.product_attribute_overrides.as_mut().unwrap()[0].area_attribute_price_id = None;
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &category_area_bundle()).unwrap();
        let raw = serde_json::to_value(&area).unwrap();
        assert!(raw["categoryAttributeBindings"][0]["areaAttributePriceId"].is_null());
        assert!(raw["productAttributeOverrides"][0]["areaAttributePriceId"].is_null());
        assert_eq!(
            serde_json::from_value::<AreaPricingDocument>(raw).unwrap(),
            area
        );
        let mut invalid = area.clone();
        invalid.product_attribute_overrides.as_mut().unwrap()[0].product_id = "P999".into();
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        let mut invalid = area.clone();
        invalid.category_attribute_bindings.as_mut().unwrap()[0].reference =
            json!({"techniqueId":"missing"});
        assert!(validate_area_links(&invalid, &category_area_bundle()).is_err());
        let mut invalid = area.clone();
        invalid.product_attribute_overrides.as_mut().unwrap()[0].reference =
            json!({"techniqueId":"missing"});
        assert!(validate_area_links(&invalid, &category_area_bundle()).is_err());
        let mut invalid = area.clone();
        invalid.category_attribute_bindings.as_mut().unwrap()[0].category_id = "missing".into();
        assert!(validate_area_links(&invalid, &category_area_bundle()).is_err());
        let mut ungrouped = category_area_bundle();
        let product = ungrouped.main["categories"][0]["products"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        ungrouped.main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(product);
        assert!(validate_area_links(&area, &ungrouped)
            .unwrap_err()
            .contains("尚未归属产品大类"));
    }

    #[test]
    fn attribute_plan_migration_roundtrips_and_preserves_v3_backup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut prior = initial.document;
        prior.area_pricing = Some(priced_template_area_sample());
        let legacy = save(root, prior, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut next = legacy.document.clone();
        next.area_pricing = Some(attribute_plan_area_sample());
        let saved = save(root, next.clone(), &legacy.version).unwrap();
        assert_eq!(saved.document, next);
        assert_eq!(read_existing(root).unwrap().document, next);
        assert_eq!(saved.document.products, legacy.document.products);
        assert_eq!(
            saved.document.accessory_prices,
            legacy.document.accessory_prices
        );
        let raw: Value = serde_json::from_slice(&fs::read(price_path(root)).unwrap()).unwrap();
        assert_eq!(raw["areaPricing"]["schemaVersion"], 4);
        assert_eq!(
            raw["areaPricing"]["templates"][1]["tierPrices"][0]["price"],
            "0"
        );
        assert!(raw["areaPricing"]["templates"][1]["tierPrices"][1]["price"].is_null());
        assert!(raw["areaPricing"]["attributes"][0].get("charge").is_none());
        assert_eq!(
            raw["areaPricing"]["productAttributeOverrides"][0]["areaAttributePriceId"],
            "attribute-2"
        );
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            legacy.document.schema_version
        ));
        assert_eq!(fs::read(&backup).unwrap(), original);
        let saved_again = save(root, saved.document, &saved.version).unwrap();
        assert_eq!(saved_again.document, next);
        assert_eq!(fs::read(&backup).unwrap(), original);
    }

    #[test]
    fn invalid_attribute_plan_save_preserves_file_and_old_binding_on_read() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut next = initial.document;
        next.area_pricing = Some(attribute_plan_area_sample());
        let saved = save(root, next.clone(), &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut invalid = saved.document.clone();
        invalid
            .area_pricing
            .as_mut()
            .unwrap()
            .category_attribute_bindings
            .as_mut()
            .unwrap()[0]
            .area_attribute_price_id = Some("missing".into());
        assert!(save(root, invalid, &saved.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
        next.area_pricing
            .as_mut()
            .unwrap()
            .product_attribute_overrides
            .as_mut()
            .unwrap()[0]
            .product_id = "P999".into();
        let original = serde_json::to_vec_pretty(&next).unwrap();
        fs::write(price_path(root), &original).unwrap();
        let loaded = read_existing(root).unwrap();
        assert_eq!(loaded.document, next);
        assert!(save(root, loaded.document, &loaded.version)
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
    }

    #[test]
    fn priced_area_templates_require_complete_versioned_price_fields() {
        let current = serde_json::to_value(priced_template_area_sample()).unwrap();
        let invalid = |raw| {
            serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true)
        };
        validate_area_pricing(&priced_template_area_sample()).unwrap();
        for field in ["basePrice", "tierPrices", "formula"] {
            let mut raw = current.clone();
            raw["templates"][0].as_object_mut().unwrap().remove(field);
            assert!(invalid(raw), "missing template {field}");
            for legacy in [area_sample(), category_area_sample()] {
                let mut raw = serde_json::to_value(legacy).unwrap();
                raw["templates"][0][field] = current["templates"][0][field].clone();
                assert!(invalid(raw), "legacy template with {field}");
            }
        }
        for field in ["tierPrices", "formula"] {
            let mut raw = current.clone();
            raw["templates"][0][field] = Value::Null;
            assert!(invalid(raw));
        }
        let mut unpriced = current.clone();
        unpriced["templates"][0]["basePrice"] = Value::Null;
        let area: AreaPricingDocument = serde_json::from_value(unpriced.clone()).unwrap();
        validate_area_pricing(&area).unwrap();
        assert_eq!(serde_json::to_value(area).unwrap(), unpriced);

        for field in ["categories", "productOverrides"] {
            let mut raw = current.clone();
            raw.as_object_mut().unwrap().remove(field);
            assert!(invalid(raw));
            let mut raw = current.clone();
            raw[field] = Value::Null;
            assert!(invalid(raw));
        }
        for (field, value) in [
            ("products", json!([])),
            (
                "limits",
                json!({"min":{"width":"","height":"","unit":"in"},"max":{"width":"","height":"","unit":"in"}}),
            ),
        ] {
            let mut raw = current.clone();
            raw[field] = value;
            assert!(invalid(raw));
        }
        let mut raw = current.clone();
        raw["categories"][0]["body"] =
            serde_json::to_value(category_area_sample()).unwrap()["categories"][0]["body"].clone();
        assert!(invalid(raw));
        let mut raw = current;
        raw["categories"][0]
            .as_object_mut()
            .unwrap()
            .remove("areaTemplateId");
        assert!(invalid(raw));
        for legacy in [area_sample(), category_area_sample()] {
            let mut raw = serde_json::to_value(legacy).unwrap();
            raw["productOverrides"] = json!([]);
            assert!(invalid(raw));
        }
    }

    #[test]
    fn priced_area_templates_validate_amounts_tiers_and_independent_attribute_charges() {
        let area = priced_template_area_sample();
        validate_area_pricing(&area).unwrap();
        let mut invalid = area.clone();
        invalid.templates[0].base_price = Some(Some("-0.5".into()));
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.templates[0].formula = Some(" ".into());
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.templates[0].tier_prices.as_mut().unwrap()[0].price = Some("NaN".into());
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.templates[0].tier_prices.as_mut().unwrap()[0].area_tier_id = "other-tier".into();
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        let row = invalid.templates[0].tier_prices.as_ref().unwrap()[0].clone();
        invalid.templates[0].tier_prices.as_mut().unwrap().push(row);
        assert!(validate_area_pricing(&invalid).is_err());
        let mut changed = area.clone();
        changed.templates[0].base_price = Some(Some("9.5".into()));
        validate_area_pricing(&changed).unwrap();
        assert_eq!(changed.attributes, area.attributes);
        let stored = serde_json::to_value(changed).unwrap();
        assert_eq!(stored["attributes"][0]["charge"]["basePrice"], "0");
        assert_eq!(stored["templates"][0]["basePrice"], "9.5");
    }

    #[test]
    fn priced_area_template_bindings_validate_category_inheritance_and_product_ownership() {
        let mut area = priced_template_area_sample();
        area.categories.as_mut().unwrap()[0].area_template_id = Some(None);
        area.product_overrides = Some(vec![AreaProductOverride {
            product_id: "P31".into(),
            area_template_id: "area-1".into(),
        }]);
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &category_area_bundle()).unwrap();
        let stored = serde_json::to_value(&area).unwrap();
        assert!(stored["categories"][0]["areaTemplateId"].is_null());
        assert!(stored["categories"][0].get("body").is_none());
        let mut invalid = area.clone();
        invalid.categories.as_mut().unwrap()[0].area_template_id =
            Some(Some("missing-template".into()));
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.product_overrides.as_mut().unwrap()[0].area_template_id = "missing-template".into();
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        let row = invalid.product_overrides.as_ref().unwrap()[0].clone();
        invalid.product_overrides.as_mut().unwrap().push(row);
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.product_overrides.as_mut().unwrap()[0].product_id = "P999".into();
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        let mut ungrouped = category_area_bundle();
        let product = ungrouped.main["categories"][0]["products"]
            .as_array_mut()
            .unwrap()
            .pop()
            .unwrap();
        ungrouped.main["uncategorizedProducts"]
            .as_array_mut()
            .unwrap()
            .push(product);
        assert!(validate_area_links(&area, &ungrouped)
            .unwrap_err()
            .contains("尚未归属产品大类"));
    }

    #[test]
    fn priced_area_template_migration_roundtrips_and_preserves_v2_backup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut prior = initial.document;
        prior.area_pricing = Some(category_area_sample());
        let legacy = save(root, prior, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut next = legacy.document.clone();
        let mut area = priced_template_area_sample();
        area.product_overrides = Some(vec![AreaProductOverride {
            product_id: "P31".into(),
            area_template_id: "area-1".into(),
        }]);
        next.area_pricing = Some(area);
        let saved = save(root, next.clone(), &legacy.version).unwrap();
        assert_eq!(saved.document, next);
        assert_eq!(read_existing(root).unwrap().document, next);
        assert_eq!(saved.document.products, legacy.document.products);
        assert_eq!(
            saved.document.accessory_prices,
            legacy.document.accessory_prices
        );
        assert_eq!(
            saved.document.area_pricing.as_ref().unwrap().attributes,
            legacy.document.area_pricing.as_ref().unwrap().attributes
        );
        let stored: Value = serde_json::from_slice(&fs::read(price_path(root)).unwrap()).unwrap();
        assert_eq!(stored["areaPricing"]["schemaVersion"], 3);
        assert_eq!(stored["areaPricing"]["templates"][0]["basePrice"], "0.5");
        assert_eq!(
            stored["areaPricing"]["categories"][0]["areaTemplateId"],
            "area-1"
        );
        assert!(stored["areaPricing"]["categories"][0].get("body").is_none());
        assert!(stored["areaPricing"].get("products").is_none());
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            legacy.document.schema_version
        ));
        assert_eq!(fs::read(&backup).unwrap(), original);
        let saved_again = save(root, saved.document, &saved.version).unwrap();
        assert_eq!(saved_again.document, next);
        assert_eq!(fs::read(backup).unwrap(), original);
    }

    #[test]
    fn priced_area_read_preserves_deleted_product_binding_for_explicit_repair() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut document = initial.document;
        let mut area = priced_template_area_sample();
        area.product_overrides = Some(vec![AreaProductOverride {
            product_id: "P999".into(),
            area_template_id: "area-1".into(),
        }]);
        document.area_pricing = Some(area.clone());
        let original = serde_json::to_vec_pretty(&document).unwrap();
        fs::write(price_path(root), &original).unwrap();
        let loaded = read_existing(root).unwrap();
        assert_eq!(loaded.document.area_pricing, Some(area));
        assert!(save(root, loaded.document, &loaded.version)
            .unwrap_err()
            .contains("产品 P999 已不存在"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
    }

    #[test]
    fn category_area_prices_validate_explicit_categories_and_charges() {
        let area = category_area_sample();
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &category_area_bundle()).unwrap();

        for id in ["", " keychains", "keychains "] {
            let mut invalid = area.clone();
            invalid.categories.as_mut().unwrap()[0].category_id = id.into();
            assert!(validate_area_pricing(&invalid).is_err());
        }
        let mut invalid = area.clone();
        let duplicate = invalid.categories.as_ref().unwrap()[0].clone();
        invalid.categories.as_mut().unwrap().push(duplicate);
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.categories.as_mut().unwrap()[0]
            .body
            .as_mut()
            .unwrap()
            .base_price = Some("-0.5".into());
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.categories.as_mut().unwrap()[0]
            .body
            .as_mut()
            .unwrap()
            .area_template_id = "missing".into();
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area.clone();
        invalid.categories.as_mut().unwrap()[0]
            .body
            .as_mut()
            .unwrap()
            .tier_prices[0]
            .area_tier_id = "missing".into();
        assert!(validate_area_pricing(&invalid).is_err());
        let mut invalid = area;
        invalid.categories.as_mut().unwrap()[0].category_id = "missing".into();
        assert!(validate_area_links(&invalid, &category_area_bundle())
            .unwrap_err()
            .contains("产品大类 missing 已不存在"));

        let mut missing_id = category_area_bundle();
        missing_id.main["categories"][0]
            .as_object_mut()
            .unwrap()
            .remove("name");
        assert!(validate_area_links(&category_area_sample(), &missing_id).is_err());
        let mut duplicate_id = category_area_bundle();
        duplicate_id.main["categories"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"keychains", "products":[]}));
        assert!(validate_area_links(&category_area_sample(), &duplicate_id).is_err());
    }

    #[test]
    fn area_schema_versions_reject_mixed_missing_and_nullable_price_scopes() {
        let legacy = serde_json::to_value(area_sample()).unwrap();
        let category = serde_json::to_value(category_area_sample()).unwrap();
        assert!(category.get("products").is_none());
        assert!(category.get("limits").is_none());
        assert!(legacy.get("categories").is_none());
        for (base, field, value) in [
            (&legacy, "categories", json!([])),
            (&category, "products", json!([])),
            (&legacy, "schemaVersion", json!(2)),
            (&category, "schemaVersion", json!(1)),
            (&category, "schemaVersion", json!(3)),
            (
                &category,
                "limits",
                serde_json::to_value(bounded_area_sample().limits.unwrap()).unwrap(),
            ),
        ] {
            let mut raw = base.clone();
            raw[field] = value;
            let invalid: AreaPricingDocument = serde_json::from_value(raw).unwrap();
            assert!(validate_area_pricing(&invalid).is_err());
        }
        for (base, field) in [(&legacy, "products"), (&category, "categories")] {
            let mut raw = base.clone();
            raw.as_object_mut().unwrap().remove(field);
            let invalid: AreaPricingDocument = serde_json::from_value(raw.clone()).unwrap();
            assert!(validate_area_pricing(&invalid).is_err());
            raw[field] = Value::Null;
            assert!(serde_json::from_value::<AreaPricingDocument>(raw).is_err());
        }
        for field in ["categoryId", "body"] {
            let mut raw = category.clone();
            raw["categories"][0].as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<AreaPricingDocument>(raw)
                .map(|area| validate_area_pricing(&area).is_err())
                .unwrap_or(true));
        }
        for (field, value) in [
            ("productId", json!("P31")),
            ("totalFormula", json!("主体价")),
        ] {
            let mut raw = category.clone();
            raw["categories"][0][field] = value;
            assert!(serde_json::from_value::<AreaPricingDocument>(raw).is_err());
        }
    }

    #[test]
    fn category_area_migration_backs_up_legacy_area_prices_and_roundtrips() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut legacy_document = initial.document;
        legacy_document.area_pricing = Some(area_sample());
        let legacy = save(root, legacy_document, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut next = legacy.document.clone();
        next.area_pricing = Some(category_area_sample());
        let saved = save(root, next.clone(), &legacy.version).unwrap();
        assert_eq!(saved.document, next);
        let reloaded = read_existing(root).unwrap();
        assert_eq!(reloaded.document, next);
        assert_eq!(saved.document.products, legacy.document.products);
        assert_eq!(
            saved.document.accessory_prices,
            legacy.document.accessory_prices
        );
        let stored: Value = serde_json::from_slice(&fs::read(price_path(root)).unwrap()).unwrap();
        assert_eq!(stored["areaPricing"]["schemaVersion"], 2);
        assert_eq!(
            stored["areaPricing"]["categories"][0]["categoryId"],
            "keychains"
        );
        assert_eq!(
            stored["areaPricing"]["categories"][0]["body"]["basePrice"],
            "0.5"
        );
        assert!(stored["areaPricing"].get("products").is_none());
        assert!(stored["areaPricing"].get("limits").is_none());
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            legacy.document.schema_version
        ));
        assert_eq!(fs::read(&backup).unwrap(), original);
        let saved_again = save(root, reloaded.document, &reloaded.version).unwrap();
        assert_eq!(saved_again.document, next);
        assert_eq!(fs::read(&backup).unwrap(), original);
    }

    #[test]
    fn invalid_category_save_and_failed_migration_backup_preserve_original() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let initial = read(root).unwrap();
        let mut legacy_document = initial.document;
        legacy_document.area_pricing = Some(area_sample());
        let legacy = save(root, legacy_document, &initial.version).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut next = legacy.document.clone();
        let mut invalid = category_area_sample();
        invalid.categories.as_mut().unwrap()[0].category_id = "unknown-category".into();
        next.area_pricing = Some(invalid);
        assert!(save(root, next.clone(), &legacy.version)
            .unwrap_err()
            .contains("产品大类"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);

        next.area_pricing = Some(category_area_sample());
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            legacy.document.schema_version
        ));
        fs::write(&backup, b"different existing backup").unwrap();
        assert!(save(root, next, &legacy.version).is_err());
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
    }

    #[test]
    fn category_area_read_retains_deleted_category_reference_for_explicit_repair() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let mut document = loaded.document;
        let mut area = category_area_sample();
        area.categories.as_mut().unwrap()[0].category_id = "removed-category".into();
        document.area_pricing = Some(area.clone());
        let original = serde_json::to_vec_pretty(&document).unwrap();
        fs::write(price_path(root), &original).unwrap();
        let reloaded = read_existing(root).unwrap();
        assert_eq!(reloaded.document.area_pricing, Some(area));
        assert!(save(root, reloaded.document, &reloaded.version)
            .unwrap_err()
            .contains("产品大类 removed-category 已不存在"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
    }

    #[test]
    fn area_pricing_validates_templates_prices_and_explicit_references() {
        let area = area_sample();
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &bundle()).unwrap();
        let mut invalid = area.clone();
        invalid.templates[0].tiers[0].max_area = Some("0".into());
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.templates[0].tiers[0].max_area = None;
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.templates[0].tiers[1].max_area = Some("20".into());
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.products.as_mut().unwrap()[0].body.tier_prices[0].area_tier_id =
            "other-template-tier".into();
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.products.as_mut().unwrap()[0].body.base_price = Some("-0.1".into());
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.attributes.as_mut().unwrap()[0].reference = json!({"id": "G11"});
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.attributes.as_mut().unwrap()[0].reference = json!({"holoFilmId": "G11"});
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area;
        invalid.attributes.as_mut().unwrap()[0].reference = json!({"techniqueId": "G999"});
        assert!(validate_area_links(&invalid, &bundle()).is_err());
    }

    fn bounded_area_sample() -> AreaPricingDocument {
        let mut raw = serde_json::to_value(area_sample()).unwrap();
        raw["limits"] = json!({
            "min": {"width": "0.5", "height": "0.5", "unit": "in"},
            "max": {"width": "275", "height": "400", "unit": "mm"}
        });
        raw["accessoryPrices"] = json!([
            {"accessoryPriceId":"fixed-P8", "accessoryStyleId":"P8", "accessoryColorId":null, "unitPrice":"0.30"},
            {"accessoryPriceId":"fixed-P-C1", "accessoryStyleId":"P8", "accessoryColorId":"P-C1", "unitPrice":null}
        ]);
        serde_json::from_value(raw).unwrap()
    }

    #[test]
    fn legacy_area_limits_do_not_restrict_template_boundaries() {
        let mut area = bounded_area_sample();
        area.templates[0].unit = "mm".into();
        for boundary in ["0.001", "161.28", "161.29", "110000", "110001", "1000000"] {
            area.templates[0].tiers[0].max_area = Some(boundary.into());
            validate_area_pricing(&area).unwrap();
        }
        for boundary in ["0", "-1", "NaN", "1e2"] {
            area.templates[0].tiers[0].max_area = Some(boundary.into());
            assert!(validate_area_pricing(&area).is_err(), "{boundary}");
        }
    }

    #[test]
    fn legacy_area_limits_are_retained_without_validating_their_values() {
        let original = serde_json::to_value(bounded_area_sample()).unwrap();
        for limits in [
            json!({"min":{"width":"", "height":"", "unit":"in"}, "max":{"width":"", "height":"", "unit":"in"}}),
            json!({"min":{"width":"500", "height":"400", "unit":"mm"}, "max":{"width":"1", "height":"1", "unit":"mm"}}),
            json!({"min":{"width":"-1", "height":"NaN", "unit":"inch"}, "max":{"width":"0", "height":"1e2", "unit":""}}),
        ] {
            let mut raw = original.clone();
            raw["limits"] = limits;
            let area: AreaPricingDocument = serde_json::from_value(raw.clone()).unwrap();
            validate_area_pricing(&area).unwrap();
            assert_eq!(serde_json::to_value(area).unwrap(), raw);
        }
    }

    #[test]
    fn empty_and_partial_area_limits_roundtrip_without_inserting_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut snapshot = read(root).unwrap();
        for dimensions in [
            json!({"min":{"width":"", "height":"", "unit":"in"}, "max":{"width":"", "height":"", "unit":"in"}}),
            json!({"min":{"width":"1.2", "height":"", "unit":"cm"}, "max":{"width":"275", "height":"400", "unit":"mm"}}),
            json!({"min":{"width":"1", "height":"2", "unit":"cm"}, "max":{"width":"", "height":"30", "unit":"cm"}}),
        ] {
            let mut area = bounded_area_sample();
            area.accessory_prices.as_mut().unwrap().truncate(1);
            area.limits = Some(serde_json::from_value(dimensions.clone()).unwrap());
            validate_area_pricing(&area).unwrap();
            let mut document = snapshot.document;
            document.area_pricing = Some(area.clone());
            let saved = save(root, document, &snapshot.version).unwrap();
            assert_eq!(saved.document.area_pricing, Some(area.clone()));
            snapshot = read_existing(root).unwrap();
            assert_eq!(snapshot.document.area_pricing, Some(area));
            assert_eq!(
                serde_json::to_value(snapshot.document.area_pricing.as_ref().unwrap()).unwrap()
                    ["limits"],
                dimensions
            );
        }
    }

    #[test]
    fn unbounded_area_pricing_saves_without_reintroducing_limits() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let mut document = loaded.document;
        let mut area = bounded_area_sample();
        area.accessory_prices.as_mut().unwrap().truncate(1);
        area.limits = None;
        area.templates[0].unit = "cm".into();
        area.templates[0].boundary_mode = Some(AreaBoundaryMode::LowerInclusive);
        document.area_pricing = Some(area.clone());
        let saved = save(root, document, &loaded.version).unwrap();
        assert_eq!(saved.document.area_pricing, Some(area.clone()));
        let reloaded = read_existing(root).unwrap();
        assert_eq!(reloaded.document.area_pricing, Some(area));
        let stored: Value = serde_json::from_slice(&fs::read(price_path(root)).unwrap()).unwrap();
        assert!(stored["areaPricing"].get("limits").is_none());
        assert_eq!(
            stored["areaPricing"]["templates"][0]["tiers"][1]["maxArea"],
            Value::Null
        );
    }

    #[test]
    fn fixed_accessories_validate_nullable_amounts_entity_ownership_and_legacy_compatibility() {
        let area = bounded_area_sample();
        validate_area_pricing(&area).unwrap();
        validate_area_links(&area, &bundle()).unwrap();
        let mut color_mode = area.clone();
        color_mode.accessory_pricing = AccessoryPricing::Color;
        validate_area_pricing(&color_mode).unwrap();
        let mut invalid = area.clone();
        invalid.accessory_prices.as_mut().unwrap()[1].accessory_color_id = Some("P-C2".into());
        assert!(validate_area_links(&invalid, &bundle()).is_err());
        invalid = area.clone();
        invalid.accessory_prices.as_mut().unwrap()[0].accessory_style_id = "missing".into();
        assert!(validate_area_links(&invalid, &bundle()).is_err());
        invalid = area.clone();
        invalid.accessory_prices.as_mut().unwrap()[0].unit_price = Some("-0.01".into());
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        let duplicate = invalid.accessory_prices.as_ref().unwrap()[0].clone();
        invalid.accessory_prices.as_mut().unwrap().push(duplicate);
        assert!(validate_area_pricing(&invalid).is_err());
        invalid = area.clone();
        invalid.accessory_prices.as_mut().unwrap()[1].accessory_color_id = None;
        assert!(validate_area_pricing(&invalid).is_err());

        for (name, reference) in [
            ("Print Option", json!({"printOptionId":"R1"})),
            ("Accessories Style", json!({"accessoryStyleId":"P8"})),
        ] {
            let mut legacy = area_sample();
            legacy.attributes.as_mut().unwrap()[0].option_name = name.into();
            legacy.attributes.as_mut().unwrap()[0].reference = reference;
            validate_area_pricing(&legacy).unwrap();
            legacy.accessory_prices = Some(Vec::new());
            assert!(validate_area_pricing(&legacy).is_err());
        }
    }

    #[test]
    fn new_area_fields_reject_null_missing_nullable_values_and_unknown_keys() {
        let value = serde_json::to_value(bounded_area_sample()).unwrap();
        for field in ["limits", "accessoryPrices"] {
            let mut invalid = value.clone();
            invalid[field] = Value::Null;
            assert!(serde_json::from_value::<AreaPricingDocument>(invalid).is_err());
        }
        for field in ["accessoryColorId", "unitPrice"] {
            let mut invalid = value.clone();
            invalid["accessoryPrices"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(serde_json::from_value::<AreaPricingDocument>(invalid).is_err());
        }
        let mut invalid = value.clone();
        invalid["limits"]["min"]["area"] = json!("0.25");
        assert!(serde_json::from_value::<AreaPricingDocument>(invalid).is_err());
        let mut invalid = value;
        invalid["accessoryPrices"][0]["id"] = json!("P8");
        assert!(serde_json::from_value::<AreaPricingDocument>(invalid).is_err());
        let old = serde_json::to_value(area_sample()).unwrap();
        assert!(old.get("limits").is_none());
        assert!(old.get("accessoryPrices").is_none());
        assert_eq!(
            serde_json::from_value::<AreaPricingDocument>(old).unwrap(),
            area_sample()
        );
    }

    #[test]
    fn bounded_area_and_fixed_accessories_roundtrip_without_rewriting_legacy_prices() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let original_accessories = loaded.document.accessory_prices.clone();
        let mut updated = loaded.document;
        let mut area = bounded_area_sample();
        area.accessory_prices.as_mut().unwrap().truncate(1);
        updated.area_pricing = Some(area.clone());
        let saved = save(root, updated, &loaded.version).unwrap();
        assert_eq!(saved.document.area_pricing, Some(area.clone()));
        assert_eq!(saved.document.accessory_prices, original_accessories);
        let reloaded = read_existing(root).unwrap();
        assert_eq!(reloaded.document.area_pricing, Some(area));
        assert_eq!(reloaded.document.accessory_prices, original_accessories);
    }

    #[test]
    fn area_template_boundary_mode_preserves_legacy_omission_and_rejects_invalid_values() {
        let old = serde_json::to_value(area_sample()).unwrap();
        assert!(old["templates"][0].get("boundaryMode").is_none());
        let decoded: AreaPricingDocument = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(decoded.templates[0].boundary_mode, None);
        assert_eq!(serde_json::to_value(decoded).unwrap(), old);
        for mode in ["upper-inclusive", "lower-inclusive"] {
            let mut raw = old.clone();
            raw["templates"][0]["boundaryMode"] = json!(mode);
            let area: AreaPricingDocument = serde_json::from_value(raw.clone()).unwrap();
            validate_area_pricing(&area).unwrap();
            assert_eq!(serde_json::to_value(area).unwrap(), raw);
        }
        for mode in [
            Value::Null,
            json!(""),
            json!("lower"),
            json!("UpperInclusive"),
            json!(1),
        ] {
            let mut raw = old.clone();
            raw["templates"][0]["boundaryMode"] = mode;
            assert!(serde_json::from_value::<AreaPricingDocument>(raw).is_err());
        }
    }

    #[test]
    fn lower_inclusive_area_template_roundtrips_through_desktop_storage() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let mut document = loaded.document;
        let mut area = area_sample();
        area.templates[0].unit = "cm".into();
        area.templates[0].boundary_mode = Some(AreaBoundaryMode::LowerInclusive);
        document.area_pricing = Some(area.clone());
        let saved = save(root, document, &loaded.version).unwrap();
        assert_eq!(saved.document.area_pricing, Some(area.clone()));
        let reloaded = read_existing(root).unwrap();
        assert_eq!(reloaded.document.area_pricing, Some(area));
        let stored: Value = serde_json::from_slice(&fs::read(price_path(root)).unwrap()).unwrap();
        assert_eq!(
            stored["areaPricing"]["templates"][0]["boundaryMode"],
            "lower-inclusive"
        );
    }

    #[test]
    fn area_pricing_roundtrips_with_historical_references_and_original_backup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut updated = loaded.document;
        updated.area_pricing = Some(area_sample());
        let old_product = updated
            .products
            .iter_mut()
            .find(|product| product.product_id == "P31")
            .unwrap();
        old_product.base_prices[0].size_band_id = "old-size-removed-after-deduplication".into();
        let saved = save(root, updated.clone(), &loaded.version).unwrap();
        assert_eq!(saved.document, updated);
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            updated.schema_version
        ));
        assert_eq!(fs::read(&backup).unwrap(), original);
        let saved_again = save(root, saved.document, &saved.version).unwrap();
        assert_eq!(saved_again.document.area_pricing, Some(area_sample()));
        assert_eq!(fs::read(&backup).unwrap(), original);
    }

    #[test]
    fn deduplicated_size_catalog_loads_historical_prices_until_area_save() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for (file, seed) in PRODUCT_FILES {
            write(
                root,
                &format!("settings/product-options/{file}"),
                seed.as_bytes(),
            );
        }
        write(
            root,
            "settings/product-pricing/product-pricing.json",
            SEED.as_bytes(),
        );
        let loaded = read_existing(root).unwrap();
        assert!(loaded.document.area_pricing.is_none());
        assert_eq!(fs::read(price_path(root)).unwrap(), SEED.as_bytes());
        let mut updated = loaded.document;
        updated.area_pricing = Some(area_sample());
        let saved = save(root, updated, &loaded.version).unwrap();
        assert_eq!(saved.document.area_pricing, Some(area_sample()));
        for (file, seed) in PRODUCT_FILES {
            assert_eq!(
                fs::read(root.join("settings/product-options").join(file)).unwrap(),
                seed.as_bytes()
            );
        }
    }

    #[test]
    fn malformed_area_pricing_and_failed_backup_preserve_original_file() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let loaded = read(root).unwrap();
        let original = fs::read(price_path(root)).unwrap();
        let mut raw = serde_json::to_value(&loaded.document).unwrap();
        raw["areaPricing"] = Value::Null;
        assert!(serde_json::from_value::<Document>(raw).is_err());
        let mut updated = loaded.document;
        updated.area_pricing = Some(area_sample());
        let digest = format!("{:x}", Sha256::digest(&original));
        let backup = price_path(root).parent().unwrap().join(format!(
            "product-pricing.v{}-{digest}.json",
            updated.schema_version
        ));
        fs::write(&backup, b"existing backup").unwrap();
        assert!(save(root, updated, &loaded.version)
            .unwrap_err()
            .contains("备份内容不符"));
        assert_eq!(fs::read(price_path(root)).unwrap(), original);
        assert_eq!(fs::read(backup).unwrap(), b"existing backup");
    }

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
    fn standee_component_pricing_roundtrips_through_desktop_storage() {
        let directory = tempfile::tempdir().unwrap();
        let loaded = read(directory.path()).unwrap();
        let mut edited = loaded.document.clone();
        let product = edited
            .products
            .iter_mut()
            .find(|product| product.product_id == "P23")
            .unwrap();
        let marker = json!({
            "schemaVersion": 1,
            "baseComponents": [],
            "techniqueComponents": [],
            "holoFilmComponents": [],
            "materialComponents": [],
            "compositeComponents": [],
            "compositions": []
        });
        product.standee_pricing = Some(marker.clone());
        let saved = save(directory.path(), edited, &loaded.version).unwrap();
        assert_eq!(
            saved
                .document
                .products
                .iter()
                .find(|product| product.product_id == "P23")
                .unwrap()
                .standee_pricing,
            Some(marker.clone())
        );
        assert_eq!(
            read_existing(directory.path())
                .unwrap()
                .document
                .products
                .iter()
                .find(|product| product.product_id == "P23")
                .unwrap()
                .standee_pricing,
            Some(marker)
        );
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
                            && option["name"] != "Foil Stamping"
                            && option["name"] != "Sticker Holo Film"
                            && option["name"] != "Tinplate Holo Film"
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
                        && option["name"] != "Foil Stamping"
                        && option["name"] != "Sticker Holo Film"
                        && option["name"] != "Tinplate Holo Film"
                        && option["name"] != "Tinplate Material"
                });
        }
        // Model an actual pre-area eight-file bundle rather than combining the
        // newly deduplicated size catalog with historical fixed-size prices.
        crate::product_option_settings::remove_seed_size_options(&mut main);
        let historical_source: Value = serde_json::from_str(include_str!(
            "../../src/modules/settings/product-options/data/size-migration.json"
        ))
        .unwrap();
        let mut historical_sizes = Value::Null;
        crate::product_option_settings::complete_size_options(
            &mut main,
            &mut historical_sizes,
            &historical_source,
            true,
        )
        .unwrap();
        let original = serde_json::to_vec(&main).unwrap();
        write(
            root,
            "settings/product-options/product-options.clean.json",
            &original,
        );
        for (file, seed) in &PRODUCT_FILES[1..8] {
            let bytes = if *file == "sizes.json" {
                serde_json::to_vec(&historical_sizes).unwrap()
            } else {
                seed.as_bytes().to_vec()
            };
            write(root, &format!("settings/product-options/{file}"), &bytes);
        }
        let loaded = read(root).unwrap();
        let expected: Document = serde_json::from_str(SEED).unwrap();
        assert_eq!(loaded.document, expected);
        let product = product_index(&loaded.bundle).unwrap()["P31"];
        for (file, name) in [
            ("foil-stamping.json", "Foil Stamping"),
            ("sticker-holo-films.json", "Sticker Holo Film"),
            ("tinplate-holo-films.json", "Tinplate Holo Film"),
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
            ("foilStampingId", "FS1"),
            ("stickerHoloFilmId", "SHF1"),
            ("tinplateHoloFilmId", "THF1"),
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
    fn new_pricing_attributes_require_their_own_explicit_entity_keys() {
        let definitions = [
            (
                "Foil Stamping",
                "foilStampingId",
                "FS1",
                "foil-stamping.json",
            ),
            (
                "Sticker Holo Film",
                "stickerHoloFilmId",
                "SHF1",
                "sticker-holo-films.json",
            ),
            (
                "Tinplate Holo Film",
                "tinplateHoloFilmId",
                "THF1",
                "tinplate-holo-films.json",
            ),
        ];
        for (name, key, id, file) in definitions {
            let reference = json!({key:id});
            assert_eq!(
                area_option_reference(name, &reference).unwrap(),
                (file, key, id)
            );
            for (_, other_key, other_id, _) in definitions {
                if key != other_key {
                    assert!(area_option_reference(name, &json!({other_key:other_id})).is_err());
                }
            }
            assert!(area_option_reference(name, &json!({"id":id})).is_err());
            assert!(area_option_reference(name, &json!({key:id,"holoFilmId":"M1"})).is_err());
        }
        assert!(area_option_reference(
            "Tinplate Sticker Film",
            &json!({"tinplateStickerFilmId":"TF1"})
        )
        .is_err());
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
