import {
  allProducts,
  catalogFor,
  display,
  definitions,
  entityReference,
  getEntityId,
  getEntityKey,
  isEnabled,
  optionFor,
  type Bundle,
  type EntityReference,
  type Product,
} from '../product-options/model'
import { matchQuantityTier, validateDocument as validateQuantityPricing, type QuantityPricingDocument } from '../quantity-pricing/model'

export type AreaUnit = 'in' | 'cm' | 'mm'
export type TemplateMatchBy = 'area' | 'longest-side' | 'exact-size'
export type AreaDimensions = { width: string; height: string; unit: AreaUnit }
export type AreaLimits = { min: AreaDimensions; max: AreaDimensions }
export type FixedAccessoryPrice = { accessoryPriceId: string; accessoryStyleId: string; accessoryColorId: string | null; unitPrice: string | null }
export type AreaTier = { areaTierId: string; maxArea: string | null; minArea?: string; minInclusive?: boolean }
export type ExactSizeRule = { areaTierId: string; width: string; height: string; unit: AreaUnit; allowRotation: boolean }
export type PricingFormulaDefinition = { formulaId: string; name: string; formula: string }
export type TierCalculation =
  | { kind: 'fixed' }
  | { kind: 'area'; basePrice: string | null; areaUnit: AreaUnit }
  | { kind: 'formula'; basePrice: string | null; formulaId: string }
export type AreaTierPrice = { areaTierId: string; price: string | null; calculation?: TierCalculation }
export type AreaTemplate = { areaTemplateId: string; name: string; unit: AreaUnit; tiers: AreaTier[]; boundaryMode?: 'upper-inclusive' | 'lower-inclusive'; matchBy?: TemplateMatchBy; exactSizes?: ExactSizeRule[]; formulas?: PricingFormulaDefinition[] }
export type AreaCharge = {
  basePrice: string | null
  areaTemplateId: string
  tierPrices: AreaTierPrice[]
  formula: string
}
export type StandeeBaseTemplate = Omit<AreaTemplate, 'areaTemplateId' | 'name'> & Pick<AreaCharge, 'basePrice' | 'tierPrices' | 'formula'>
export type StandeeBasePrices = Pick<AreaCharge, 'basePrice' | 'tierPrices'>
export type AreaProductCharge = AreaCharge & { standeeBase?: StandeeBasePrices }
export type PricedAreaTemplate = AreaTemplate & Omit<AreaCharge, 'areaTemplateId'> & { standeeBase?: StandeeBaseTemplate }
export type AreaProductPrice = { productId: string; body: AreaCharge; totalFormula: string }
export type AreaCategoryPrice = { categoryId: string; body: AreaCharge }
export type AreaCategoryBinding = { categoryId: string; areaTemplateId: string | null }
export type AreaProductOverride = { productId: string; areaTemplateId: string }
export type AreaPricingCategory = { categoryId: string; title: string; productCount: number }
export type LegacyAreaAttributePrice = { areaAttributePriceId: string; optionName: string; reference: EntityReference; charge: AreaCharge }
export type LegacySchemeAreaAttributePrice = { areaAttributePriceId: string; name: string; optionName: string; reference: EntityReference; areaTemplateId: string }
export type LegacyIndependentAreaAttributePrice = LegacySchemeAreaAttributePrice & Pick<AreaCharge, 'basePrice' | 'tierPrices'>
export type AreaAttributePrice = Omit<LegacyIndependentAreaAttributePrice, 'name'> & { standeeBase?: StandeeBasePrices }
export type AdditionalPricePlan = { additionalPricePlanId: string; name: string; prices: AreaAttributePrice[] }
export type CategoryAdditionalPlanBinding = { categoryId: string; additionalPricePlanId: string | null }
export type ProductAdditionalPlanOverride = { productId: string; additionalPricePlanId: string | null }
export type AreaAttributeBinding = { optionName: string; reference: EntityReference; areaAttributePriceId: string | null }
export type AreaCategoryAttributeBinding = AreaAttributeBinding & { categoryId: string }
export type AreaProductAttributeOverride = AreaAttributeBinding & { productId: string }
type AreaPricingShared = {
  accessoryPricing: 'style' | 'color'
  templates: AreaTemplate[]
  attributes: LegacyAreaAttributePrice[]
  limits?: AreaLimits
  accessoryPrices?: FixedAccessoryPrice[]
}
export type LegacyAreaPricingDocument = AreaPricingShared & { schemaVersion: 1; products: AreaProductPrice[] }
export type LegacyCategoryAreaPricingDocument = AreaPricingShared & { schemaVersion: 2; categories: AreaCategoryPrice[] }
export type LegacyPricedAreaPricingDocument = Omit<AreaPricingShared, 'templates'> & {
  schemaVersion: 3
  templates: PricedAreaTemplate[]
  categories: AreaCategoryBinding[]
  productOverrides: AreaProductOverride[]
}
export type LegacySchemeAreaPricingDocument = Omit<LegacyPricedAreaPricingDocument, 'schemaVersion' | 'attributes'> & {
  schemaVersion: 4
  attributes: LegacySchemeAreaAttributePrice[]
  categoryAttributeBindings: AreaCategoryAttributeBinding[]
  productAttributeOverrides: AreaProductAttributeOverride[]
}
export type LegacyIndependentAreaPricingDocument = Omit<LegacySchemeAreaPricingDocument, 'schemaVersion' | 'attributes'> & {
  schemaVersion: 5
  attributes: LegacyIndependentAreaAttributePrice[]
  productTotalFormulas: { productId: string; formula: string }[]
}
export type LegacyGroupedAreaPricingDocument = Omit<LegacyIndependentAreaPricingDocument, 'schemaVersion' | 'attributes' | 'categoryAttributeBindings' | 'productAttributeOverrides'> & {
  schemaVersion: 6
  additionalPricePlans: AdditionalPricePlan[]
  categoryAdditionalPlanBindings: CategoryAdditionalPlanBinding[]
  productAdditionalPlanOverrides: ProductAdditionalPlanOverride[]
}
export type AreaPricingDocument = Omit<LegacyGroupedAreaPricingDocument, 'schemaVersion'> & {
  schemaVersion: 7
  productAdjustments: { productId: string; amount: string | null }[]
}
type GroupedAreaPricingDocument = LegacyGroupedAreaPricingDocument | AreaPricingDocument
export type AnyAreaPricingDocument = LegacyAreaPricingDocument | LegacyCategoryAreaPricingDocument | LegacyPricedAreaPricingDocument | LegacySchemeAreaPricingDocument | LegacyIndependentAreaPricingDocument | GroupedAreaPricingDocument
export type AreaStandeeInput = { parts: AreaDimensions[]; base: AreaDimensions }
export type AreaQuoteInput = {
  productId: string
  width: string
  height: string
  unit: AreaUnit
  sizeBandId?: string
  selections: Record<string, string | null | undefined>
  accessoryColorId?: string | null
  quantity: number
  standeeQuantityId?: string | null
  standee?: AreaStandeeInput
}
export type AreaQuoteStep = {
  pricingKind?: 'area' | 'fixed'
  key: string
  label: string
  optionName?: string
  reference?: EntityReference
  planName?: string
  basePrice: string | null
  tierPrice: string | null
  areaTemplateId: string
  templateName: string
  areaTierId: string
  tierLabel: string
  areaMm2: string
  matchBy?: TemplateMatchBy
  longestSideMm?: string
  calculationKind?: 'inherited' | TierCalculation['kind'] | 'adjustment'
  widthMm?: string
  heightMm?: string
  formula: string
  substitutedFormula: string
  amount: string
  parts?: AreaQuoteStep[]
}
export type AreaQuoteResult = {
  steps: AreaQuoteStep[]
  areaMm2: string
  longestSideMm: string
  discountPercent: number
  discountFactor: string
  quantityTierId: string | null
  unitPrice: string
  totalPrice: string
  formula: string
  substitutedFormula: string
  variables: Record<string, string>
}

export const AREA_ATTRIBUTE_OPTIONS = [
  { name: 'Technique', label: '滴胶工艺', idKey: 'techniqueId', variable: '工艺价' },
  { name: 'Foil Stamping', label: '烫金工艺', idKey: 'foilStampingId', variable: '烫金工艺价' },
  { name: 'Holo Film', label: '亚克力全息膜', idKey: 'holoFilmId', variable: '全息膜价' },
  { name: 'Sticker Holo Film', label: '贴纸全息膜', idKey: 'stickerHoloFilmId', variable: '贴纸全息膜价' },
  { name: 'Tinplate Holo Film', label: '马口铁全息膜', idKey: 'tinplateHoloFilmId', variable: '马口铁全息膜价' },
  { name: 'Material', label: '贴纸材质', idKey: 'materialId', variable: '材质价' },
  { name: 'Tinplate Material', label: '马口铁材质', idKey: 'tinplateMaterialId', variable: '马口铁材质价' },
  { name: 'Accessories Style', label: '配件', idKey: 'accessoryStyleId', variable: '配件价' },
] as const
export const AREA_CHARGE_VARIABLES = ['基本价', '档位价格', '面积平方毫米'] as const
export const LONGEST_SIDE_CHARGE_VARIABLES = [...AREA_CHARGE_VARIABLES, '最长边毫米'] as const
export const AREA_TOTAL_VARIABLES = ['大类主体价', '属性价', ...AREA_ATTRIBUTE_OPTIONS.map(option => option.variable), '面积平方毫米', '最长边毫米', '主体片数', '折扣系数', '数量'] as const
export const DEFAULT_AREA_FORMULA = '基本价 + 档位价格 * 面积平方毫米'
export const DEFAULT_TOTAL_FORMULA = '(大类主体价 + 属性价 + 配件价) * 折扣系数 * 数量'
export const EXACT_SIZE_REQUIRED_MESSAGE = '请先新增至少一个指定尺寸'
export const EXACT_SIZE_DIMENSIONS_REQUIRED_MESSAGE = '请填写指定尺寸的宽和高'
const COMPATIBLE_TOTAL_VARIABLES = ['主体价', ...AREA_ATTRIBUTE_OPTIONS.map(option => option.variable), '折扣系数', '数量', '主体片数', '面积平方毫米', '印刷价']
export const DEFAULT_AREA_LIMITS: AreaLimits = { min: { width: '', height: '', unit: 'in' }, max: { width: '', height: '', unit: 'in' } }

export function getTemplateMatchBy(template: Pick<AreaTemplate, 'matchBy'>): TemplateMatchBy { return template.matchBy ?? 'area' }
export function templateUnitLabel(template: Pick<AreaTemplate, 'unit' | 'matchBy'>): string { return getTemplateMatchBy(template) === 'area' ? `${template.unit}²` : template.unit }
export function getTemplateFormulaVariables(template: Pick<AreaTemplate, 'matchBy'>): readonly string[] { return getTemplateMatchBy(template) === 'area' ? AREA_CHARGE_VARIABLES : LONGEST_SIDE_CHARGE_VARIABLES }
export function getDefaultTemplateFormula(matchBy: TemplateMatchBy): string { return matchBy === 'area' ? DEFAULT_AREA_FORMULA : '基本价 + 档位价格' }
export function getTemplatePriceRules(template: Pick<AreaTemplate, 'tiers' | 'exactSizes'>): (AreaTier | ExactSizeRule)[] { return [...template.tiers, ...(template.exactSizes ?? [])] }
function createUnpricedRule(rule: AreaTier | ExactSizeRule): AreaTierPrice {
  return { areaTierId: rule.areaTierId, price: null, ...('width' in rule ? { calculation: { kind: 'fixed' as const } } : {}) }
}

export function getProductTotalVariables(bundle: Bundle, productId: string): string[] {
  const product = allProducts(bundle.main).find(row => row.productId === productId)
  if (!product) throw new Error(`总价公式引用的产品 ${productId} 已不存在`)
  const enabled = (name: string) => {
    const option = optionFor(product, name)
    return !!option && !option.deleted && catalogFor(bundle, product, name).values.some(value => isEnabled(option, value))
  }
  const attributes = AREA_ATTRIBUTE_OPTIONS.filter(option => enabled(option.name))
  return ['大类主体价', ...(attributes.some(option => option.name !== 'Accessories Style') ? ['属性价'] : []), ...attributes.map(option => option.variable), ...(enabled('Size') || enabled('Standee Quantity') ? ['面积平方毫米', '最长边毫米'] : []), ...(enabled('Standee Quantity') ? ['主体片数'] : []), '折扣系数', '数量']
}
export function getDefaultProductTotalFormula(bundle: Bundle, productId: string): string {
  const variables = getProductTotalVariables(bundle, productId)
  return `(${['大类主体价', ...AREA_ATTRIBUTE_OPTIONS.map(option => option.variable)].filter(name => variables.includes(name)).join(' + ')}) * 折扣系数 * 数量`
}
export function resolveProductTotalFormula(document: Pick<AreaPricingDocument, 'productTotalFormulas'>, bundle: Bundle, productId: string): string {
  return document.productTotalFormulas.find(row => row.productId === productId)?.formula ?? getDefaultProductTotalFormula(bundle, productId)
}

export function getAreaPricingCategories(bundle: Bundle): AreaPricingCategory[] {
  return bundle.main.categories.map(category => ({ categoryId: category.name, title: category.titleZh || category.title || category.name, productCount: category.products.length }))
}
export function getProductPricingCategory(bundle: Bundle, productId: string): AreaPricingCategory | undefined {
  const category = bundle.main.categories.find(item => item.products.some(product => product.productId === productId))
  return category ? { categoryId: category.name, title: category.titleZh || category.title || category.name, productCount: category.products.length } : undefined
}
export function getAreaCharges(document: AnyAreaPricingDocument): AreaCharge[] {
  if (document.schemaVersion === 4 || document.schemaVersion === 5 || document.schemaVersion === 6 || document.schemaVersion === 7) return []
  return [...(document.schemaVersion === 3 ? [] : (document.schemaVersion === 1 ? document.products : document.categories).map(row => row.body)), ...document.attributes.map(row => row.charge)]
}
function sameAttribute(left: { optionName: string; reference: EntityReference }, right: { optionName: string; reference: EntityReference }): boolean {
  return left.optionName === right.optionName && getEntityKey(left.reference) === getEntityKey(right.reference) && getEntityId(left.reference) === getEntityId(right.reference)
}
export function additionalPlanMatchesTemplate(plan: AdditionalPricePlan | undefined, templateId: string | null | undefined): boolean {
  return !!templateId && !!plan?.prices.length && plan.prices.every(price => price.areaTemplateId === templateId)
}
function boundProductAdditionalPlan(document: GroupedAreaPricingDocument, bundle: Bundle, productId: string): { plan: AdditionalPricePlan | undefined; source: 'product' | 'category' | 'none' } {
  const category = getProductPricingCategory(bundle, productId)
  const override = document.productAdditionalPlanOverrides.find(row => row.productId === productId)
  const fallback = document.categoryAdditionalPlanBindings.find(row => row.categoryId === category?.categoryId)
  const binding = override ?? fallback
  return { plan: document.additionalPricePlans.find(row => row.additionalPricePlanId === binding?.additionalPricePlanId), source: override ? 'product' : fallback ? 'category' : 'none' }
}
export function resolveProductAdditionalPlan(document: GroupedAreaPricingDocument, bundle: Bundle, productId: string): { plan: AdditionalPricePlan | undefined; source: 'product' | 'category' | 'none' } {
  const resolved = boundProductAdditionalPlan(document, bundle, productId)
  const template = resolveProductBaseTemplate(document, bundle, productId).template
  return { ...resolved, plan: additionalPlanMatchesTemplate(resolved.plan, template?.areaTemplateId) ? resolved.plan : undefined }
}
/** Clear only bindings affected by a user changing a category/product selection. */
export function clearIncompatibleAdditionalPlanBindings(document: AreaPricingDocument, bundle: Bundle, categoryId: string, productId?: string): void {
  const category = document.categories.find(row => row.categoryId === categoryId)
  const fallback = document.categoryAdditionalPlanBindings.find(row => row.categoryId === categoryId)
  if (!productId && fallback?.additionalPricePlanId && !additionalPlanMatchesTemplate(document.additionalPricePlans.find(plan => plan.additionalPricePlanId === fallback.additionalPricePlanId), category?.areaTemplateId)) fallback.additionalPricePlanId = null
  const products = bundle.main.categories.find(row => row.name === categoryId)?.products ?? []
  for (const product of products.filter(row => !productId || row.productId === productId)) {
    const override = document.productAdditionalPlanOverrides.find(row => row.productId === product.productId)
    const binding = override ?? fallback
    if (!binding?.additionalPricePlanId) continue
    const template = resolveProductBaseTemplate(document, bundle, product.productId).template
    const plan = document.additionalPricePlans.find(row => row.additionalPricePlanId === binding.additionalPricePlanId)
    if (!additionalPlanMatchesTemplate(plan, template?.areaTemplateId)) {
      if (override) override.additionalPricePlanId = null
      else document.productAdditionalPlanOverrides.push({ productId: product.productId, additionalPricePlanId: null })
    }
  }
}
export function resolveProductAttributePlan(document: GroupedAreaPricingDocument, bundle: Bundle, productId: string, optionName: string, reference: EntityReference): { plan: AdditionalPricePlan | undefined; price: AreaAttributePrice | undefined; template: PricedAreaTemplate | undefined; source: 'product' | 'category' | 'none' } {
  const resolved = resolveProductAdditionalPlan(document, bundle, productId)
  const price = resolved.plan?.prices.find(row => sameAttribute(row, { optionName, reference }))
  return { ...resolved, price, template: document.templates.find(row => row.areaTemplateId === price?.areaTemplateId) }
}
export function getAdditionalAttributePrices(document: GroupedAreaPricingDocument): AreaAttributePrice[] {
  return document.additionalPricePlans.flatMap(plan => plan.prices)
}
export function createAdditionalPricePlan(bundle: Bundle, template: AreaTemplate & { standeeBase?: StandeeBaseTemplate }, name = '新附加价格方案'): AdditionalPricePlan {
  const prices = AREA_ATTRIBUTE_OPTIONS.filter(option => option.name !== 'Accessories Style').flatMap(option => {
    const definition = definitions.find(row => row.name === option.name)!
    return (bundle.catalogs[definition.file]?.values ?? []).map(value => ({
      areaAttributePriceId: `area-${getEntityKey(value)}-${getEntityId(value)}`, optionName: option.name,
      reference: entityReference(value), areaTemplateId: template.areaTemplateId, ...createAttributePlanPrices(template),
    }))
  })
  return { additionalPricePlanId: `additional-plan-${crypto.randomUUID()}`, name, prices }
}
export function getTemplatePriceCharge(template: PricedAreaTemplate): AreaProductCharge {
  return { areaTemplateId: template.areaTemplateId, basePrice: template.basePrice, tierPrices: template.tierPrices, formula: template.formula,
    ...(template.standeeBase ? { standeeBase: { basePrice: template.standeeBase.basePrice, tierPrices: template.standeeBase.tierPrices } } : {}) }
}
export function createAttributePlanPrices(template: AreaTemplate & { standeeBase?: StandeeBaseTemplate }): Pick<AreaAttributePrice, 'basePrice' | 'tierPrices' | 'standeeBase'> {
  return { basePrice: null, tierPrices: getTemplatePriceRules(template).map(createUnpricedRule),
    ...(template.standeeBase ? { standeeBase: { basePrice: null, tierPrices: getTemplatePriceRules(template.standeeBase).map(createUnpricedRule) } } : {}) }
}
export function getAttributePlanCharge(plan: AreaAttributePrice, template: PricedAreaTemplate): AreaProductCharge {
  return { areaTemplateId: plan.areaTemplateId, basePrice: plan.basePrice, tierPrices: plan.tierPrices, formula: template.formula,
    ...(plan.standeeBase ? { standeeBase: plan.standeeBase } : {}) }
}
export function createStandeeBaseTemplate(): StandeeBaseTemplate {
  const areaTierId = `standee-base-tier-${crypto.randomUUID()}`
  return { unit: 'mm', matchBy: 'longest-side', boundaryMode: 'upper-inclusive', tiers: [{ areaTierId, maxArea: null }],
    basePrice: null, tierPrices: [{ areaTierId, price: null }], formula: getDefaultTemplateFormula('longest-side') }
}
/** Keep amounts for existing tier identities; newly added tiers remain unpriced. */
export function syncAttributeTemplatePrices(price: AreaAttributePrice, template: PricedAreaTemplate): void {
  price.tierPrices = getTemplatePriceRules(template).map(tier => structuredClone(price.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? createUnpricedRule(tier)))
  if (template.standeeBase) price.standeeBase = {
    basePrice: price.standeeBase?.basePrice ?? null,
    tierPrices: getTemplatePriceRules(template.standeeBase).map(tier => structuredClone(price.standeeBase?.tierPrices.find(row => row.areaTierId === tier.areaTierId) ?? createUnpricedRule(tier))),
  }
  else delete price.standeeBase
}
export function resolveProductBaseTemplate(document: Pick<AreaPricingDocument, 'templates' | 'productOverrides' | 'categories'>, bundle: Bundle, productId: string): { template: PricedAreaTemplate | undefined; category: AreaPricingCategory | undefined; source: 'product' | 'category' | 'none' } {
  const category = getProductPricingCategory(bundle, productId)
  if (!category) return { category, template: undefined, source: 'none' }
  const override = document.productOverrides.find(row => row.productId === productId)
  const binding = document.categories.find(row => row.categoryId === category.categoryId)
  const id = override?.areaTemplateId ?? binding?.areaTemplateId
  return { category, template: document.templates.find(template => template.areaTemplateId === id), source: override ? 'product' : id ? 'category' : 'none' }
}

const UNIT_MM = { in: '25.4', cm: '10', mm: '1' } satisfies Record<AreaUnit, string>
const MAX_FORMULA_LENGTH = 2000
const MAX_FORMULA_TOKENS = 512
const MAX_FORMULA_DEPTH = 32
const DECIMAL = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value
const validUnit = (value: unknown): value is AreaUnit => value === 'in' || value === 'cm' || value === 'mm'

// Rational arithmetic keeps divisions exact until the final order total is rounded.
type Rational = { numerator: bigint; denominator: bigint }
const ZERO: Rational = { numerator: 0n, denominator: 1n }
const ONE: Rational = { numerator: 1n, denominator: 1n }
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) [a, b] = [b, a % b]
  return a
}
function fraction(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new Error('公式不能除以 0')
  const divisor = gcd(numerator, denominator)
  const sign = denominator < 0n ? -1n : 1n
  return { numerator: numerator / divisor * sign, denominator: denominator / divisor * sign }
}
function decimal(value: string): Rational {
  const negative = value.startsWith('-')
  const [whole, digits = ''] = (negative ? value.slice(1) : value).split('.')
  return fraction(BigInt((whole || '0') + digits) * (negative ? -1n : 1n), 10n ** BigInt(digits.length))
}
const add = (left: Rational, right: Rational) => fraction(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator)
const subtract = (left: Rational, right: Rational) => fraction(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator)
const multiply = (left: Rational, right: Rational) => fraction(left.numerator * right.numerator, left.denominator * right.denominator)
const divide = (left: Rational, right: Rational) => fraction(left.numerator * right.denominator, left.denominator * right.numerator)
const compare = (left: Rational, right: Rational) => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}
function numberText(value: Rational): string {
  const negative = value.numerator < 0n
  const magnitude = negative ? -value.numerator : value.numerator
  const whole = magnitude / value.denominator
  let remainder = magnitude % value.denominator
  let digits = ''
  // Recurring decimals are display-only. The original fraction remains in calculations.
  while (remainder && digits.length < 36) {
    remainder *= 10n
    digits += String(remainder / value.denominator)
    remainder %= value.denominator
  }
  digits = digits.replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${digits ? `.${digits}` : ''}`
}
function moneyText(value: Rational): string {
  if (value.numerator < 0n) throw new Error('公式计算的最终价格不能为负数')
  const scaled = value.numerator * 100n
  const cents = scaled / value.denominator + (scaled % value.denominator * 2n >= value.denominator ? 1n : 0n)
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
function decimalInputText(value: Rational): string {
  const scale = 10n ** 18n
  const scaled = value.numerator * scale
  const rounded = scaled / value.denominator + (scaled % value.denominator * 2n >= value.denominator ? 1n : 0n)
  return numberText(fraction(rounded, scale))
}

type FormulaNode =
  | { kind: 'number'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: '+' | '-'; child: FormulaNode }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
type Token = { value: string; kind: 'number' | 'variable' | 'operator' }
function normalizeFormula(formula: string): string {
  return formula.trim().replace(/^=/, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/（/g, '(').replace(/）/g, ')').replace(/−/g, '-')
}
function tokenizeFormula(formula: string): Token[] {
  if (typeof formula !== 'string' || !formula.trim() || formula.length > MAX_FORMULA_LENGTH) throw new Error(`公式不能为空，且不能超过 ${MAX_FORMULA_LENGTH} 个字符`)
  let remaining = normalizeFormula(formula)
  const tokens: Token[] = []
  while (remaining.length) {
    const whitespace = /^\s+/.exec(remaining)
    if (whitespace) { remaining = remaining.slice(whitespace[0].length); continue }
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(remaining)
    const variable = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(remaining)
    if (number) {
      const value = number[0].startsWith('.') ? `0${number[0]}` : number[0]
      if (value.length > 40) throw new Error('公式中的数字过长')
      tokens.push({ kind: 'number', value })
      remaining = remaining.slice(number[0].length)
    } else if (variable) {
      tokens.push({ kind: 'variable', value: variable[0] })
      remaining = remaining.slice(variable[0].length)
    } else if ('+-*/()'.includes(remaining[0])) {
      tokens.push({ kind: 'operator', value: remaining[0] })
      remaining = remaining.slice(1)
    } else throw new Error(`公式包含不支持的字符“${remaining[0]}”，仅支持变量、数字、四则运算和括号`)
    if (tokens.length > MAX_FORMULA_TOKENS) throw new Error('公式过长，请简化运算')
  }
  return tokens
}
function compileFormula(formula: string, allowedVariables: readonly string[]): { root: FormulaNode; tokens: Token[] } {
  const tokens = tokenizeFormula(formula)
  const allowed = new Set(allowedVariables)
  let position = 0
  const parsePrimary = (depth: number): FormulaNode => {
    if (depth > MAX_FORMULA_DEPTH) throw new Error('公式括号或正负号嵌套过深')
    const token = tokens[position++]
    if (!token) throw new Error('公式不完整，请检查运算符和括号')
    if (token.kind === 'number') return { kind: 'number', value: token.value }
    if (token.kind === 'variable') {
      if (!allowed.has(token.value)) throw new Error(`公式变量“${token.value}”不可用`)
      return { kind: 'variable', name: token.value }
    }
    if (token.value === '+' || token.value === '-') return { kind: 'unary', operator: token.value, child: parsePrimary(depth + 1) }
    if (token.value === '(') {
      const node = parseExpression(depth + 1)
      if (tokens[position++]?.value !== ')') throw new Error('公式括号不匹配')
      return node
    }
    throw new Error(`公式中的“${token.value}”位置无效`)
  }
  const parseTerm = (depth: number): FormulaNode => {
    let node = parsePrimary(depth)
    while (tokens[position]?.value === '*' || tokens[position]?.value === '/') {
      const operator = tokens[position++].value as '*' | '/'
      node = { kind: 'binary', operator, left: node, right: parsePrimary(depth) }
    }
    return node
  }
  const parseExpression = (depth: number): FormulaNode => {
    let node = parseTerm(depth)
    while (tokens[position]?.value === '+' || tokens[position]?.value === '-') {
      const operator = tokens[position++].value as '+' | '-'
      node = { kind: 'binary', operator, left: node, right: parseTerm(depth) }
    }
    return node
  }
  const root = parseExpression(0)
  if (position !== tokens.length) throw new Error('公式缺少运算符或包含多余的括号')
  return { root, tokens }
}
function evaluateNode(node: FormulaNode, variables: Record<string, Rational | null | undefined>): Rational {
  if (node.kind === 'number') return decimal(node.value)
  if (node.kind === 'variable') {
    const value = variables[node.name]
    if (value == null) throw new Error(`“${node.name}”未定价或尚未填写`)
    return value
  }
  if (node.kind === 'unary') {
    const value = evaluateNode(node.child, variables)
    return node.operator === '-' ? fraction(-value.numerator, value.denominator) : value
  }
  const left = evaluateNode(node.left, variables)
  const right = evaluateNode(node.right, variables)
  switch (node.operator) {
    case '+': return add(left, right)
    case '-': return subtract(left, right)
    case '*': return multiply(left, right)
    case '/': return divide(left, right)
  }
}
function substituteTokens(tokens: Token[], variables: Record<string, Rational | null | undefined>): string {
  return tokens.map(token => {
    if (token.kind !== 'variable') return token.value
    const value = variables[token.value]
    return value == null ? '未定价' : `(${numberText(value)})`
  }).join(' ')
}
export function validateAreaFormula(formula: string, allowedVariables: readonly string[] = AREA_CHARGE_VARIABLES): void {
  compileFormula(formula, allowedVariables)
}
export function evaluateAreaFormula(formula: string, variables: Record<string, string | null | undefined>): string {
  const parsed = compileFormula(formula, Object.keys(variables))
  const values = Object.fromEntries(Object.entries(variables).map(([name, value]) => {
    if (value != null && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`“${name}”必须是十进制数值`)
    return [name, value == null ? null : decimal(value)]
  }))
  return numberText(evaluateNode(parsed.root, values))
}

function positiveAmount(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DECIMAL.test(value) || compare(decimal(value), ZERO) <= 0) throw new Error(`${label}须为大于 0 的十进制数，整数最多 9 位、小数最多 18 位`)
}
function optionalPrice(value: unknown, label: string): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || !DECIMAL.test(value))) throw new Error(`${label}须为非负十进制金额或空值，整数最多 9 位、小数最多 18 位`)
}
function optionalSignedPrice(value: unknown, label: string): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || !DECIMAL.test(value.startsWith('-') ? value.slice(1) : value))) throw new Error(`${label}须为十进制金额或空值，整数最多 9 位、小数最多 18 位`)
}
function exactKeys(value: Record<string, unknown>, fields: string[], label: string): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error(`${label}字段无效`)
}
function uniqueId(value: unknown, ids: Set<string>, label: string): asserts value is string {
  if (!validId(value) || ids.has(value)) throw new Error(`${label}标识为空或重复`)
  ids.add(value)
}
type QuoteDimensions = { area: Rational; longestSide: Rational; widthMm?: Rational; heightMm?: Rational }
function quoteDimensions(width: string, height: string, unit: AreaUnit): QuoteDimensions {
  positiveAmount(width, '宽度')
  positiveAmount(height, '高度')
  if (!validUnit(unit)) throw new Error('尺寸单位必须为 in、cm 或 mm')
  const factor = decimal(UNIT_MM[unit])
  const widthMm = multiply(decimal(width), factor)
  const heightMm = multiply(decimal(height), factor)
  return { area: multiply(widthMm, heightMm), longestSide: compare(widthMm, heightMm) >= 0 ? widthMm : heightMm, widthMm, heightMm }
}
function areaValue(width: string, height: string, unit: AreaUnit): Rational {
  return quoteDimensions(width, height, unit).area
}
export function areaSquareMm(width: string, height: string, unit: AreaUnit): string {
  return numberText(areaValue(width, height, unit))
}
/** Converts square-unit boundaries, while dimensions use the separate linear conversion. */
export function convertAreaValue(value: string, from: AreaUnit, to: AreaUnit): string {
  if (value === '') return ''
  positiveAmount(value, '面积')
  if (!validUnit(from) || !validUnit(to)) throw new Error('面积单位无效')
  const ratio = divide(decimal(UNIT_MM[from]), decimal(UNIT_MM[to]))
  return decimalInputText(multiply(decimal(value), multiply(ratio, ratio)))
}
/** Converts longest-side boundaries as lengths, without squaring the unit factor. */
export function convertLengthValue(value: string, from: AreaUnit, to: AreaUnit): string {
  if (value === '') return ''
  positiveAmount(value, '长度')
  if (!validUnit(from) || !validUnit(to)) throw new Error('长度单位无效')
  return decimalInputText(multiply(decimal(value), divide(decimal(UNIT_MM[from]), decimal(UNIT_MM[to]))))
}
export function getAreaLimits(document: Pick<AreaPricingDocument, 'limits'>): AreaLimits {
  return document.limits ?? structuredClone(DEFAULT_AREA_LIMITS)
}
function areaBounds(limits: AreaLimits): { min?: Rational; max?: Rational } {
  const value = (dimension: AreaDimensions) => dimension.width === '' || dimension.height === '' ? undefined : areaValue(dimension.width, dimension.height, dimension.unit)
  return { min: value(limits.min), max: value(limits.max) }
}
// Unit conversion exposes 18 decimal digits. This tolerance is far smaller than
// a measurable area and avoids rejecting the same boundary after unit changes.
function compareArea(left: Rational, right: Rational): number {
  const difference = subtract(left, right)
  const magnitude = fraction(difference.numerator < 0n ? -difference.numerator : difference.numerator, difference.denominator)
  return compare(magnitude, decimal('0.000000001')) <= 0 ? 0 : compare(left, right)
}
export function areaRangeInUnit(document: Pick<AreaPricingDocument, 'limits'>, unit: AreaUnit): { minArea: string; maxArea: string } {
  if (!validUnit(unit)) throw new Error('面积单位无效')
  const bounds = areaBounds(getAreaLimits(document))
  const scale = multiply(decimal(UNIT_MM[unit]), decimal(UNIT_MM[unit]))
  return { minArea: bounds.min ? decimalInputText(divide(bounds.min, scale)) : '', maxArea: bounds.max ? decimalInputText(divide(bounds.max, scale)) : '' }
}
export function getAreaTierBounds(template: Pick<AreaTemplate, 'tiers' | 'boundaryMode'>, tier: AreaTier): { minArea: string; minInclusive: boolean; maxArea: string | null; maxInclusive: boolean } {
  const index = template.tiers.findIndex(row => row.areaTierId === tier.areaTierId)
  const explicit = tier.minArea !== undefined
  return {
    minArea: explicit ? tier.minArea! : index > 0 ? template.tiers[index - 1].maxArea ?? '0' : '0',
    minInclusive: explicit ? tier.minInclusive ?? false : index > 0 && template.boundaryMode === 'lower-inclusive',
    maxArea: tier.maxArea,
    maxInclusive: template.boundaryMode !== 'lower-inclusive',
  }
}
function compareTierBoundaries(template: Pick<AreaTemplate, 'unit' | 'matchBy'>, left: Rational, right: Rational): number {
  const factor = decimal(UNIT_MM[template.unit])
  if (getTemplateMatchBy(template) === 'longest-side') return compareLength(multiply(left, factor), multiply(right, factor))
  const scale = multiply(factor, factor)
  return compareArea(multiply(left, scale), multiply(right, scale))
}
export function areaTierLabel(template: AreaTemplate, tier: AreaTier | ExactSizeRule, _limits?: AreaLimits): string {
  if ('width' in tier) return `${tier.width} × ${tier.height} ${tier.unit}${tier.allowRotation ? '（可旋转）' : ''}`
  if (tier.minArea !== undefined) {
    const bounds = getAreaTierBounds(template, tier)
    const variable = getTemplateMatchBy(template) === 'longest-side' ? 'L' : 'A'
    return `${bounds.minArea || '待填写'} ${bounds.minInclusive ? '≤' : '<'} ${variable} ${bounds.maxArea !== null && bounds.maxInclusive ? '≤' : '<'} ${bounds.maxArea === null ? '∞' : bounds.maxArea || '待填写'} ${templateUnitLabel(template)}`
  }
  const index = template.tiers.findIndex(item => item.areaTierId === tier.areaTierId)
  const lower = index > 0 ? template.tiers[index - 1].maxArea : null
  const upper = tier.maxArea
  const unit = templateUnitLabel(template)
  const variable = getTemplateMatchBy(template) === 'longest-side' ? 'L' : 'A'
  const lowerInclusive = template.boundaryMode === 'lower-inclusive'
  if (index === 0) return upper === null ? `${variable} > 0 ${unit}` : `${variable} ${lowerInclusive ? '<' : '≤'} ${upper || '待填写'} ${unit}`
  if (upper === null) return `${variable} ${lowerInclusive ? '≥' : '>'} ${lower || '待填写'} ${unit}`
  return `${lower || '待填写'} ${lowerInclusive ? '≤' : '<'} ${variable} ${lowerInclusive ? '<' : '≤'} ${upper || '待填写'} ${unit}`
}

export function createAreaCharge(template: AreaTemplate): AreaCharge {
  return {
    basePrice: null,
    areaTemplateId: template.areaTemplateId,
    tierPrices: getTemplatePriceRules(template).map(createUnpricedRule),
    formula: getDefaultTemplateFormula(getTemplateMatchBy(template)),
  }
}
export function createDefaultAreaTemplate(): AreaTemplate {
  return {
    areaTemplateId: 'area-template-cm2-10-20-40-100',
    name: '平方厘米面积档位（10 / 20 / 40 / 100）',
    unit: 'cm',
    boundaryMode: 'lower-inclusive',
    tiers: [
      { areaTierId: 'area-tier-cm2-lt-10', maxArea: '10' },
      { areaTierId: 'area-tier-cm2-lt-20', maxArea: '20' },
      { areaTierId: 'area-tier-cm2-lt-40', maxArea: '40' },
      { areaTierId: 'area-tier-cm2-lt-100', maxArea: '100' },
      { areaTierId: 'area-tier-cm2-gte-100', maxArea: null },
    ],
  }
}
export function createPricedAreaTemplate(template: AreaTemplate = createDefaultAreaTemplate()): PricedAreaTemplate {
  const { areaTemplateId: _id, ...price } = createAreaCharge(template)
  return { ...structuredClone(template), ...price }
}
export function createAreaPricing(bundle: Bundle, legacyAccessoryPrices: FixedAccessoryPrice[] = []): AreaPricingDocument {
  const template = createPricedAreaTemplate()
  return {
    schemaVersion: 7,
    productAdjustments: [],
    accessoryPricing: 'style',
    templates: [template],
    categories: getAreaPricingCategories(bundle).map(category => ({ categoryId: category.categoryId, areaTemplateId: null })),
    productOverrides: [],
    additionalPricePlans: [],
    categoryAdditionalPlanBindings: [],
    productAdditionalPlanOverrides: [],
    productTotalFormulas: [],
    accessoryPrices: accessoryCatalogRows(bundle).map(row => ({ ...row, unitPrice: legacyAccessoryPrices.find(item => item.accessoryStyleId === row.accessoryStyleId && item.accessoryColorId === row.accessoryColorId)?.unitPrice ?? null })),
  }
}
function accessoryCatalogRows(bundle: Bundle): FixedAccessoryPrice[] {
  const styles = bundle.catalogs['accessory-styles.json'].values
  return styles.flatMap(style => [null, ...(style.colors ?? [])].map(color => ({
    accessoryPriceId: color ? `fixed-accessory-color-${getEntityId(color)}` : `fixed-accessory-style-${getEntityId(style)}`,
    accessoryStyleId: getEntityId(style),
    accessoryColorId: color ? getEntityId(color) : null,
    unitPrice: null,
  })))
}
/** Preserve configured prices while separating free printing and fixed accessories. */
function upgradeLegacyCategoryPricing(document: LegacyAreaPricingDocument | LegacyCategoryAreaPricingDocument, bundle: Bundle, legacyAccessoryPrices: FixedAccessoryPrice[] = []): LegacyCategoryAreaPricingDocument {
  validateAreaPricing(document)
  const next = structuredClone(document)
  delete next.limits
  const defaultTemplate = createDefaultAreaTemplate()
  const oldDefault = next.templates.find(template => template.areaTemplateId === 'area-template-default'
    && template.unit === 'in' && template.boundaryMode !== 'lower-inclusive'
    && template.tiers.length === 3 && template.tiers.every((tier, index) => tier.maxArea === ['10', '20', null][index]))
  if (oldDefault) {
    const replacement = next.templates.find(template => template.areaTemplateId === defaultTemplate.areaTemplateId) ?? defaultTemplate
    if (!next.templates.includes(replacement)) next.templates.push(replacement)
    const charges = getAreaCharges(next)
      .filter(charge => charge.areaTemplateId === oldDefault.areaTemplateId)
    // Existing coefficients cannot be converted to different physical intervals.
    // Replace only the untouched, unpriced starter; preserve configured prices.
    if (charges.every(charge => charge.tierPrices.every(tier => tier.price === null))) {
      for (const charge of charges) {
        charge.areaTemplateId = replacement.areaTemplateId
        charge.tierPrices = replacement.tiers.map(tier => ({ areaTierId: tier.areaTierId, price: null }))
      }
      next.templates = next.templates.filter(template => template !== oldDefault)
    }
  }
  const defaultIndex = next.templates.findIndex(template => template.areaTemplateId === defaultTemplate.areaTemplateId)
  if (defaultIndex > 0) next.templates.unshift(...next.templates.splice(defaultIndex, 1))
  const existing = next.accessoryPrices ?? []
  const legacyAreaAccessories = next.attributes.filter(row => row.optionName === 'Accessories Style')
  for (const row of accessoryCatalogRows(bundle)) {
    if (existing.some(item => item.accessoryStyleId === row.accessoryStyleId && item.accessoryColorId === row.accessoryColorId)) continue
    const legacyArea = legacyAreaAccessories.find(item => row.accessoryColorId === null ? item.reference.accessoryStyleId === row.accessoryStyleId : item.reference.accessoryColorId === row.accessoryColorId)
    const legacyFixed = legacyAccessoryPrices.find(item => item.accessoryStyleId === row.accessoryStyleId && item.accessoryColorId === row.accessoryColorId)
    existing.push({ ...row, unitPrice: legacyArea?.charge.basePrice ?? legacyFixed?.unitPrice ?? null })
  }
  next.accessoryPrices = existing
  next.attributes = next.attributes.filter(row => row.optionName !== 'Print Option' && row.optionName !== 'Accessories Style')
  const defaults = createAreaPricing(bundle)
  const template = next.templates[0]
  if (next.schemaVersion === 2) {
    for (const row of defaults.categories) if (!next.categories.some(item => item.categoryId === row.categoryId)) next.categories.push({ categoryId: row.categoryId, body: createAreaCharge(template) })
    return next
  }
  const configured = (charge: AreaCharge) => charge.basePrice !== null || charge.tierPrices.some(tier => tier.price !== null) || normalizeFormula(charge.formula) !== DEFAULT_AREA_FORMULA
  const signature = (charge: AreaCharge) => JSON.stringify({
    basePrice: charge.basePrice === null ? null : numberText(decimal(charge.basePrice)),
    areaTemplateId: charge.areaTemplateId,
    tiers: next.templates.find(row => row.areaTemplateId === charge.areaTemplateId)!.tiers.map(tier => {
      const value = charge.tierPrices.find(price => price.areaTierId === tier.areaTierId)?.price ?? null
      return [tier.areaTierId, value === null ? null : numberText(decimal(value))]
    }),
    formula: tokenizeFormula(charge.formula).map(token => token.value).join(' '),
  })
  for (const row of next.products) {
    if (configured(row.body) && !getProductPricingCategory(bundle, row.productId)) throw new Error(`产品 ${row.productId} 已有主体价格，但未归属产品大类；请先在产品选项配置中设置大类后再迁移`)
  }
  const categories = getAreaPricingCategories(bundle).map(category => {
    const rows = next.products.filter(row => getProductPricingCategory(bundle, row.productId)?.categoryId === category.categoryId && configured(row.body))
    if (new Set(rows.map(row => signature(row.body))).size > 1) throw new Error(`大类“${category.title}”存在不同的主体价格（${rows.map(row => row.productId).join('、')}），请先统一后再迁移`)
    return { categoryId: category.categoryId, body: rows.length ? rows[0].body : createAreaCharge(template) }
  })
  const { products: _products, schemaVersion: _schemaVersion, ...shared } = next
  return { ...shared, schemaVersion: 2, categories }
}
function upgradePricedAreaPricing(document: LegacyAreaPricingDocument | LegacyCategoryAreaPricingDocument | LegacyPricedAreaPricingDocument, bundle: Bundle, legacyAccessoryPrices: FixedAccessoryPrice[] = []): LegacyPricedAreaPricingDocument {
  validateAreaPricing(document)
  if (document.schemaVersion === 3) {
    const next = structuredClone(document)
    const defaults = createAreaPricing(bundle, legacyAccessoryPrices)
    for (const category of defaults.categories) if (!next.categories.some(row => row.categoryId === category.categoryId)) next.categories.push(category)
    const legacyAccessories = next.attributes.filter(row => row.optionName === 'Accessories Style')
    next.accessoryPrices ??= []
    for (const accessory of defaults.accessoryPrices ?? []) if (!next.accessoryPrices.some(row => row.accessoryStyleId === accessory.accessoryStyleId && row.accessoryColorId === accessory.accessoryColorId)) {
      const legacy = legacyAccessories.find(row => accessory.accessoryColorId === null ? row.reference.accessoryStyleId === accessory.accessoryStyleId : row.reference.accessoryColorId === accessory.accessoryColorId)
      next.accessoryPrices.push({ ...accessory, unitPrice: legacy?.charge.basePrice ?? accessory.unitPrice })
    }
    next.attributes = next.attributes.filter(row => row.optionName !== 'Print Option' && row.optionName !== 'Accessories Style')
    return next
  }
  const legacy = upgradeLegacyCategoryPricing(document, bundle, legacyAccessoryPrices)
  const templates = legacy.templates.map(template => createPricedAreaTemplate(template))
  const assigned = new Map<string, Map<string, string>>()
  const ids = new Set([...templates.map(template => template.areaTemplateId), ...templates.flatMap(template => template.tiers.map(tier => tier.areaTierId))])
  let sequence = 1
  const configured = (charge: AreaCharge) => charge.basePrice !== null || charge.tierPrices.some(tier => tier.price !== null) || tokenizeFormula(charge.formula).map(token => token.value).join(' ') !== tokenizeFormula(DEFAULT_AREA_FORMULA).map(token => token.value).join(' ')
  const categories = legacy.categories.map(category => {
    const charge = category.body
    if (!configured(charge)) return { categoryId: category.categoryId, areaTemplateId: null }
    const source = legacy.templates.find(template => template.areaTemplateId === charge.areaTemplateId)!
    const sourceAssignments = assigned.get(source.areaTemplateId) ?? new Map<string, string>()
    assigned.set(source.areaTemplateId, sourceAssignments)
    const signature = JSON.stringify({ basePrice: charge.basePrice === null ? null : numberText(decimal(charge.basePrice)), prices: source.tiers.map(tier => {
      const price = charge.tierPrices.find(row => row.areaTierId === tier.areaTierId)?.price ?? null
      return price === null ? null : numberText(decimal(price))
    }), formula: tokenizeFormula(charge.formula).map(token => token.value).join(' ') })
    const existing = sourceAssignments.get(signature)
    if (existing) return { categoryId: category.categoryId, areaTemplateId: existing }
    let template = templates.find(row => row.areaTemplateId === source.areaTemplateId)!
    if (sourceAssignments.size) {
      let id: string
      do { id = `area-template-price-${sequence++}` } while (ids.has(id) || source.tiers.some((_, index) => ids.has(`${id}-tier-${index + 1}`)))
      const title = getAreaPricingCategories(bundle).find(row => row.categoryId === category.categoryId)?.title ?? category.categoryId
      template = createPricedAreaTemplate({ ...source, areaTemplateId: id, name: `${source.name} · ${title}`, tiers: source.tiers.map((tier, index) => ({ ...tier, areaTierId: `${id}-tier-${index + 1}` })) })
      ids.add(id)
      template.tiers.forEach(tier => ids.add(tier.areaTierId))
      templates.push(template)
    }
    template.basePrice = charge.basePrice
    template.formula = charge.formula
    template.tierPrices = source.tiers.map((tier, index) => ({ areaTierId: template.tiers[index].areaTierId, price: charge.tierPrices.find(row => row.areaTierId === tier.areaTierId)?.price ?? null }))
    sourceAssignments.set(signature, template.areaTemplateId)
    return { categoryId: category.categoryId, areaTemplateId: template.areaTemplateId }
  })
  const { categories: _categories, schemaVersion: _schemaVersion, templates: _templates, ...shared } = legacy
  const upgraded: LegacyPricedAreaPricingDocument = { ...shared, schemaVersion: 3, templates, categories, productOverrides: [] }
  validateAreaPricing(upgraded)
  return upgraded
}
/** Move every old attribute charge into its own template without coupling unrelated prices. */
function upgradeSchemeAreaPricing(document: Exclude<AnyAreaPricingDocument, GroupedAreaPricingDocument | LegacyIndependentAreaPricingDocument>, bundle: Bundle, legacyAccessoryPrices: FixedAccessoryPrice[] = []): LegacySchemeAreaPricingDocument {
  validateAreaPricing(document)
  if (document.schemaVersion === 4) {
    const next = structuredClone(document)
    const defaults = createAreaPricing(bundle, legacyAccessoryPrices)
    for (const category of defaults.categories) if (!next.categories.some(row => row.categoryId === category.categoryId)) next.categories.push(category)
    next.accessoryPrices ??= []
    for (const accessory of defaults.accessoryPrices ?? []) if (!next.accessoryPrices.some(row => row.accessoryStyleId === accessory.accessoryStyleId && row.accessoryColorId === accessory.accessoryColorId)) next.accessoryPrices.push(accessory)
    return next
  }
  const legacy = upgradePricedAreaPricing(document, bundle, legacyAccessoryPrices)
  const templates = structuredClone(legacy.templates)
  const ids = new Set([...templates.map(row => row.areaTemplateId), ...templates.flatMap(row => row.tiers.map(tier => tier.areaTierId))])
  const attributes: LegacySchemeAreaAttributePrice[] = []
  const categoryAttributeBindings: AreaCategoryAttributeBinding[] = []
  for (const attribute of legacy.attributes) {
    const definition = definitions.find(row => row.name === attribute.optionName)
    const value = definition ? bundle.catalogs[definition.file]?.values.find(row => getEntityKey(row) === getEntityKey(attribute.reference) && getEntityId(row) === getEntityId(attribute.reference)) : undefined
    const name = `${value ? display(value) : `${getEntityKey(attribute.reference)}=${getEntityId(attribute.reference)}`} · 默认方案`
    const source = legacy.templates.find(row => row.areaTemplateId === attribute.charge.areaTemplateId)!
    const stem = `area-template-${attribute.areaAttributePriceId}`
    let id = stem
    let sequence = 1
    while (ids.has(id) || source.tiers.some((_, index) => ids.has(`${id}-tier-${index + 1}`))) id = `${stem}-${sequence++}`
    ids.add(id)
    const tiers = source.tiers.map((tier, index) => ({ ...tier, areaTierId: `${id}-tier-${index + 1}` }))
    tiers.forEach(tier => ids.add(tier.areaTierId))
    templates.push({
      ...source, areaTemplateId: id, name: `${definition?.title ?? attribute.optionName} · ${value ? display(value) : getEntityId(attribute.reference)} · ${getEntityId(attribute.reference)}`, tiers,
      basePrice: attribute.charge.basePrice, formula: attribute.charge.formula,
      tierPrices: tiers.map((tier, index) => ({ areaTierId: tier.areaTierId, price: attribute.charge.tierPrices.find(row => row.areaTierId === source.tiers[index].areaTierId)?.price ?? null })),
    })
    const plan: LegacySchemeAreaAttributePrice = { areaAttributePriceId: attribute.areaAttributePriceId, name, optionName: attribute.optionName, reference: structuredClone(attribute.reference), areaTemplateId: id }
    attributes.push(plan)
    for (const category of getAreaPricingCategories(bundle)) categoryAttributeBindings.push({ categoryId: category.categoryId, optionName: plan.optionName, reference: structuredClone(plan.reference), areaAttributePriceId: plan.areaAttributePriceId })
  }
  const upgraded: LegacySchemeAreaPricingDocument = { ...legacy, schemaVersion: 4, templates, attributes, categoryAttributeBindings, productAttributeOverrides: [] }
  validateAreaPricing(upgraded)
  return upgraded
}

/** Keep scheme amounts independent while sharing only equivalent interval and formula definitions. */
function upgradeIndependentAreaPricing(document: Exclude<AnyAreaPricingDocument, GroupedAreaPricingDocument>, bundle: Bundle, legacyAccessoryPrices: FixedAccessoryPrice[] = []): LegacyIndependentAreaPricingDocument {
  validateAreaPricing(document)
  if (document.schemaVersion === 5) {
    const next = structuredClone(document)
    const defaults = createAreaPricing(bundle, legacyAccessoryPrices)
    for (const category of defaults.categories) if (!next.categories.some(row => row.categoryId === category.categoryId)) next.categories.push(category)
    next.accessoryPrices ??= []
    for (const accessory of defaults.accessoryPrices ?? []) if (!next.accessoryPrices.some(row => row.accessoryStyleId === accessory.accessoryStyleId && row.accessoryColorId === accessory.accessoryColorId)) next.accessoryPrices.push(accessory)
    return next
  }
  const legacy = upgradeSchemeAreaPricing(document, bundle, legacyAccessoryPrices)
  const bodyIds = new Set([...legacy.categories.map(row => row.areaTemplateId), ...legacy.productOverrides.map(row => row.areaTemplateId)])
  const attributeIds = new Set(legacy.attributes.map(row => row.areaTemplateId))
  const signature = (template: PricedAreaTemplate) => JSON.stringify({
    matchBy: getTemplateMatchBy(template), unit: template.unit, boundaryMode: template.boundaryMode ?? 'upper-inclusive',
    boundaries: template.tiers.map(tier => tier.maxArea === null ? null : numberText(decimal(tier.maxArea))),
    formula: tokenizeFormula(template.formula).map(token => token.value),
  })
  const retained = legacy.templates.filter(template => bodyIds.has(template.areaTemplateId) || !attributeIds.has(template.areaTemplateId))
  const reusable = new Map<string, PricedAreaTemplate>()
  // Prefer a body template, even when a matching unused template appears earlier.
  for (const template of [...retained.filter(row => bodyIds.has(row.areaTemplateId)), ...retained]) {
    if (!reusable.has(signature(template))) reusable.set(signature(template), template)
  }
  const replacements = new Map<string, PricedAreaTemplate>()
  for (const template of legacy.templates) {
    if (!attributeIds.has(template.areaTemplateId)) continue
    let target = bodyIds.has(template.areaTemplateId) ? template : reusable.get(signature(template))
    if (!target) {
      const { basePrice, tierPrices } = createAttributePlanPrices(template)
      target = { ...template, name: `${getTemplateMatchBy(template) === 'longest-side' ? '最长边' : '面积'}档位（${template.tiers.map(tier => tier.maxArea ?? '不限').join(' / ')} ${templateUnitLabel(template)}）`, basePrice, tierPrices }
      retained.push(target)
      reusable.set(signature(template), target)
    }
    replacements.set(template.areaTemplateId, target)
  }
  const attributes = legacy.attributes.map(plan => {
    const source = legacy.templates.find(template => template.areaTemplateId === plan.areaTemplateId)!
    const target = replacements.get(plan.areaTemplateId)!
    return { ...plan, areaTemplateId: target.areaTemplateId, basePrice: source.basePrice, tierPrices: source.tiers.map((tier, index) => ({ areaTierId: target.tiers[index].areaTierId, price: source.tierPrices.find(row => row.areaTierId === tier.areaTierId)?.price ?? null })) }
  })
  const next: LegacyIndependentAreaPricingDocument = { ...legacy, schemaVersion: 5, templates: retained.length ? retained : [createPricedAreaTemplate()], attributes, productTotalFormulas: [] }
  validateAreaPricing(next)
  return next
}
/** One product selects one complete set of additional prices. */
export function upgradeAreaPricing(document: AnyAreaPricingDocument, bundle: Bundle, legacyAccessoryPrices: FixedAccessoryPrice[] = []): AreaPricingDocument {
  validateAreaPricing(document)
  if (document.schemaVersion === 6 || document.schemaVersion === 7) {
    const next: AreaPricingDocument = { ...structuredClone(document), schemaVersion: 7, productAdjustments: document.schemaVersion === 7 ? structuredClone(document.productAdjustments) : [] }
    const defaults = createAreaPricing(bundle, legacyAccessoryPrices)
    for (const category of defaults.categories) if (!next.categories.some(row => row.categoryId === category.categoryId)) next.categories.push(category)
    next.accessoryPrices ??= []
    for (const accessory of defaults.accessoryPrices ?? []) if (!next.accessoryPrices.some(row => row.accessoryStyleId === accessory.accessoryStyleId && row.accessoryColorId === accessory.accessoryColorId)) next.accessoryPrices.push(accessory)
    for (const price of getAdditionalAttributePrices(next)) {
      const template = next.templates.find(row => row.areaTemplateId === price.areaTemplateId)
      if (template?.standeeBase && !price.standeeBase) price.standeeBase = createAttributePlanPrices(template).standeeBase
    }
    return next
  }
  const legacy = upgradeIndependentAreaPricing(document, bundle, legacyAccessoryPrices)
  const plans: AdditionalPricePlan[] = []
  const signatures = new Map<string, string>()
  const usedRows = new Set<string>()
  const byId = new Map(legacy.attributes.map(row => [row.areaAttributePriceId, row]))
  const entityKey = (row: { optionName: string; reference: EntityReference }) => JSON.stringify([row.optionName, getEntityKey(row.reference), getEntityId(row.reference)])
  const makePlan = (rows: LegacyIndependentAreaAttributePrice[], name: string): string | null => {
    if (!rows.length) return null
    const signature = JSON.stringify(rows.map(row => [entityKey(row), row.areaAttributePriceId]).sort(([a], [b]) => a.localeCompare(b)))
    const existing = signatures.get(signature)
    if (existing) return existing
    const additionalPricePlanId = `additional-plan-${plans.length + 1}`
    const prices = rows.map(({ name: _name, ...row }) => { usedRows.add(row.areaAttributePriceId); return structuredClone(row) })
    plans.push({ additionalPricePlanId, name: plans.length ? name : '默认附加价格方案', prices })
    signatures.set(signature, additionalPricePlanId)
    return additionalPricePlanId
  }
  const effectiveRows = (bindings: AreaAttributeBinding[]): LegacyIndependentAreaAttributePrice[] => {
    const merged = new Map<string, string | null>()
    for (const binding of bindings) merged.set(entityKey(binding), binding.areaAttributePriceId)
    return [...merged.values()].flatMap(id => id === null ? [] : [byId.get(id)!])
  }
  const categoryAdditionalPlanBindings: CategoryAdditionalPlanBinding[] = []
  const categoryIds = [...new Set(legacy.categoryAttributeBindings.map(row => row.categoryId))]
  for (const categoryId of categoryIds) {
    const bindings = legacy.categoryAttributeBindings.filter(row => row.categoryId === categoryId)
    const title = bundle.main.categories.find(row => row.name === categoryId)
    categoryAdditionalPlanBindings.push({ categoryId, additionalPricePlanId: makePlan(effectiveRows(bindings), `${title ? display(title) : categoryId}附加价格方案`) })
  }
  const productAdditionalPlanOverrides: ProductAdditionalPlanOverride[] = []
  for (const productId of [...new Set(legacy.productAttributeOverrides.map(row => row.productId))]) {
    const categoryId = getProductPricingCategory(bundle, productId)?.categoryId
    const bindings = [...legacy.categoryAttributeBindings.filter(row => row.categoryId === categoryId), ...legacy.productAttributeOverrides.filter(row => row.productId === productId)]
    productAdditionalPlanOverrides.push({ productId, additionalPricePlanId: makePlan(effectiveRows(bindings), `${productId} 附加价格方案`) })
  }
  // Preserve unused alternatives without silently binding them or placing a duplicate entity in a set.
  const unused = legacy.attributes.filter(row => !usedRows.has(row.areaAttributePriceId))
  while (unused.length) {
    const entities = new Set<string>()
    const rows: LegacyIndependentAreaAttributePrice[] = []
    for (let index = 0; index < unused.length;) {
      const key = entityKey(unused[index])
      if (entities.has(key)) { index++; continue }
      entities.add(key)
      rows.push(unused.splice(index, 1)[0])
    }
    makePlan(rows, `未关联附加价格方案 ${plans.length + 1}`)
  }
  const { attributes: _attributes, categoryAttributeBindings: _categoryBindings, productAttributeOverrides: _productBindings, schemaVersion: _version, ...shared } = legacy
  const next: AreaPricingDocument = { ...shared, schemaVersion: 7, productAdjustments: [], additionalPricePlans: plans, categoryAdditionalPlanBindings, productAdditionalPlanOverrides }
  validateAreaPricing(next)
  return next
}
function validateCharge(value: unknown, templates: Map<string, AreaTemplate>, label: string, allowRuleValues = false): asserts value is AreaCharge {
  if (!record(value)) throw new Error(`${label}格式错误`)
  exactKeys(value, ['basePrice', 'areaTemplateId', 'tierPrices', 'formula'], label)
  const validatePrice: (value: unknown, label: string) => void = allowRuleValues ? optionalSignedPrice : optionalPrice
  validatePrice(value.basePrice, `${label}基本价`)
  if (!validId(value.areaTemplateId) || !templates.has(value.areaTemplateId) || !Array.isArray(value.tierPrices)) throw new Error(`${label}的面积模板引用无效`)
  const template = templates.get(value.areaTemplateId)!
  const ids = new Set<string>()
  for (const price of value.tierPrices) {
    if (!record(price)) throw new Error(`${label}档位价格格式错误`)
    exactKeys(price, ['areaTierId', 'price', ...(allowRuleValues && Object.hasOwn(price, 'calculation') ? ['calculation'] : [])], `${label}档位价格`)
    uniqueId(price.areaTierId, ids, `${label}档位价格`)
    if (!getTemplatePriceRules(template).some(tier => tier.areaTierId === price.areaTierId)) throw new Error(`${label}档位价格不属于所选模板`)
    validatePrice(price.price, `${label}档位价格`)
    if (Object.hasOwn(price, 'calculation')) {
      const calculation = price.calculation
      if (!record(calculation)) throw new Error(`${label}计价方式无效`)
      if (calculation.kind === 'fixed') exactKeys(calculation, ['kind'], `${label}固定计价`)
      else if (calculation.kind === 'area') {
        exactKeys(calculation, ['kind', 'basePrice', 'areaUnit'], `${label}面积计价`)
        optionalSignedPrice(calculation.basePrice, `${label}行基础费`)
        if (!validUnit(calculation.areaUnit)) throw new Error(`${label}行面积单位无效`)
      } else if (calculation.kind === 'formula') {
        exactKeys(calculation, ['kind', 'basePrice', 'formulaId'], `${label}公式计价`)
        optionalSignedPrice(calculation.basePrice, `${label}行基础费`)
        if (!validId(calculation.formulaId) || !template.formulas?.some(formula => formula.formulaId === calculation.formulaId)) throw new Error(`${label}引用的行公式不存在`)
      } else throw new Error(`${label}计价方式无效`)
    }
  }
  if (typeof value.formula !== 'string') throw new Error(`${label}公式格式错误`)
  validateAreaFormula(value.formula, getTemplateFormulaVariables(template))
}
function independentValidationView(document: GroupedAreaPricingDocument): LegacyIndependentAreaPricingDocument {
  const { additionalPricePlans, categoryAdditionalPlanBindings: _categoryBindings, productAdditionalPlanOverrides: _productBindings, schemaVersion: _version, productAdjustments: _adjustments, ...shared } = { ...document, productAdjustments: document.schemaVersion === 7 ? document.productAdjustments : [] }
  const templates = document.templates.map(({ standeeBase: _base, ...template }) => template)
  const baseTemplateIds = new Map<string, string>()
  for (const template of document.templates) if (template.standeeBase) {
    let id = `standee-base:${template.areaTemplateId}`
    while (templates.some(row => row.areaTemplateId === id)) id += ':'
    baseTemplateIds.set(template.areaTemplateId, id)
    templates.push({ ...template.standeeBase, areaTemplateId: id, name: `${template.name} · 底座` })
  }
  return {
    ...shared, templates, schemaVersion: 5, categoryAttributeBindings: [], productAttributeOverrides: [],
    attributes: additionalPricePlans.flatMap(plan => plan.prices.flatMap(({ standeeBase, ...price }) => {
      const row = { ...price, name: plan.name, areaAttributePriceId: JSON.stringify([plan.additionalPricePlanId, price.areaAttributePriceId]) }
      if (!standeeBase) return [row]
      const areaTemplateId = baseTemplateIds.get(price.areaTemplateId)
      if (!areaTemplateId) throw new Error('附加价格底座必须使用具有底座区间的档位模板')
      return [row, { ...row, ...standeeBase, areaTemplateId, areaAttributePriceId: JSON.stringify([plan.additionalPricePlanId, price.areaAttributePriceId, 'base']) }]
    })),
  }
}
function validateAdditionalPlanPricing(value: Record<string, unknown>): void {
  const allowRuleValues = value.schemaVersion === 7
  exactKeys(value, ['schemaVersion', 'accessoryPricing', 'templates', 'categories', 'productOverrides', 'additionalPricePlans', 'categoryAdditionalPlanBindings', 'productAdditionalPlanOverrides', 'productTotalFormulas', ...(allowRuleValues ? ['productAdjustments'] : []), ...(Object.hasOwn(value, 'accessoryPrices') ? ['accessoryPrices'] : [])], '面积定价')
  if (!Array.isArray(value.templates) || !Array.isArray(value.additionalPricePlans) || !Array.isArray(value.categoryAdditionalPlanBindings) || !Array.isArray(value.productAdditionalPlanOverrides)) throw new Error('附加价格方案或关联列表无效')
  for (const template of value.templates) {
    if (!record(template)) throw new Error('档位模板格式错误')
    if (Object.hasOwn(template, 'standeeBase')) {
      const base = template.standeeBase
      if (!record(base)) throw new Error('底座档位模板格式错误')
      exactKeys(base, ['unit', 'tiers', 'basePrice', 'tierPrices', 'formula', ...(Object.hasOwn(base, 'boundaryMode') ? ['boundaryMode'] : []), ...(Object.hasOwn(base, 'matchBy') ? ['matchBy'] : []), ...(allowRuleValues && Object.hasOwn(base, 'exactSizes') ? ['exactSizes'] : []), ...(allowRuleValues && Object.hasOwn(base, 'formulas') ? ['formulas'] : [])], '底座档位模板')
    }
  }
  const planIds = new Set<string>()
  for (const plan of value.additionalPricePlans) {
    if (!record(plan)) throw new Error('附加价格方案格式错误')
    exactKeys(plan, ['additionalPricePlanId', 'name', 'prices'], '附加价格方案')
    uniqueId(plan.additionalPricePlanId, planIds, '附加价格方案')
    if (!validId(plan.name) || !Array.isArray(plan.prices)) throw new Error('附加价格方案名称或价格列表无效')
    const rowIds = new Set<string>()
    const entities = new Set<string>()
    for (const price of plan.prices) {
      if (!record(price)) throw new Error('附加价格行格式错误')
      exactKeys(price, ['areaAttributePriceId', 'optionName', 'reference', 'areaTemplateId', 'basePrice', 'tierPrices', ...(Object.hasOwn(price, 'standeeBase') ? ['standeeBase'] : [])], '附加价格行')
      if (Object.hasOwn(price, 'standeeBase')) {
        if (!record(price.standeeBase)) throw new Error('附加底座价格格式错误')
        exactKeys(price.standeeBase, ['basePrice', 'tierPrices'], '附加底座价格')
      }
      uniqueId(price.areaAttributePriceId, rowIds, '附加价格行')
      if (!record(price.reference) || Object.keys(price.reference).length !== 1) throw new Error('属性价格须关联明确的属性实体')
      const key = JSON.stringify([price.optionName, price.reference])
      if (entities.has(key)) throw new Error('同一附加价格方案内的属性实体不能重复')
      entities.add(key)
    }
  }
  for (const [rows, ownerKey] of [[value.categoryAdditionalPlanBindings, 'categoryId'], [value.productAdditionalPlanOverrides, 'productId']] as const) {
    const owners = new Set<string>()
    for (const row of rows) {
      if (!record(row)) throw new Error('附加价格方案关联格式错误')
      exactKeys(row, [ownerKey, 'additionalPricePlanId'], '附加价格方案关联')
      uniqueId(row[ownerKey], owners, '附加价格方案关联')
      if (row.additionalPricePlanId !== null && (!validId(row.additionalPricePlanId) || !planIds.has(row.additionalPricePlanId))) throw new Error('附加价格关联的方案已不存在')
    }
  }
  if (allowRuleValues) {
    if (!Array.isArray(value.productAdjustments)) throw new Error('产品调整项列表无效')
    const ids = new Set<string>()
    for (const row of value.productAdjustments) {
      if (!record(row)) throw new Error('产品调整项格式错误')
      exactKeys(row, ['productId', 'amount'], '产品调整项')
      uniqueId(row.productId, ids, '产品调整项')
      optionalSignedPrice(row.amount, '产品调整金额')
    }
  }
  validateAreaPricing(independentValidationView(value as GroupedAreaPricingDocument), allowRuleValues)
}
export function validateAreaPricing(value: unknown, allowRuleValues = false): asserts value is AnyAreaPricingDocument {
  if (!record(value)) throw new Error('面积定价格式错误')
  if (value.schemaVersion === 6 || value.schemaVersion === 7) { validateAdditionalPlanPricing(value); return }
  const bodyKey = value.schemaVersion === 1 ? 'products' : 'categories'
  const pricedTemplates = value.schemaVersion === 3 || value.schemaVersion === 4 || value.schemaVersion === 5
  const schemePrices = value.schemaVersion === 4 || value.schemaVersion === 5
  exactKeys(value, ['schemaVersion', 'accessoryPricing', 'templates', bodyKey, 'attributes', ...(pricedTemplates ? ['productOverrides'] : []), ...(schemePrices ? ['categoryAttributeBindings', 'productAttributeOverrides'] : []), ...(value.schemaVersion === 5 ? ['productTotalFormulas'] : []), ...(value.schemaVersion === 1 && Object.hasOwn(value, 'limits') ? ['limits'] : []), ...(Object.hasOwn(value, 'accessoryPrices') ? ['accessoryPrices'] : [])], '面积定价')
  if (![1, 2, 3, 4, 5].includes(Number(value.schemaVersion)) || typeof value.schemaVersion !== 'number' || !['style', 'color'].includes(String(value.accessoryPricing)) || !Array.isArray(value.templates) || !value.templates.length || !Array.isArray(value[bodyKey]) || !Array.isArray(value.attributes) || pricedTemplates && !Array.isArray(value.productOverrides) || schemePrices && (!Array.isArray(value.categoryAttributeBindings) || !Array.isArray(value.productAttributeOverrides)) || value.schemaVersion === 5 && !Array.isArray(value.productTotalFormulas)) throw new Error('面积定价版本或列表无效')
  if (Object.hasOwn(value, 'accessoryPrices')) {
    if (!Array.isArray(value.accessoryPrices)) throw new Error('公共配件价格格式错误')
    const ids = new Set<string>()
    const references = new Set<string>()
    for (const row of value.accessoryPrices) {
      if (!record(row)) throw new Error('公共配件价格行格式错误')
      exactKeys(row, ['accessoryPriceId', 'accessoryStyleId', 'accessoryColorId', 'unitPrice'], '公共配件价格')
      uniqueId(row.accessoryPriceId, ids, '公共配件价格')
      if (!validId(row.accessoryStyleId) || row.accessoryColorId !== null && !validId(row.accessoryColorId)) throw new Error('公共配件价格必须关联明确的配件样式和颜色')
      const key = `${row.accessoryStyleId}:${row.accessoryColorId ?? ''}`
      if (references.has(key)) throw new Error('公共配件价格样式和颜色不能重复')
      references.add(key)
      optionalPrice(row.unitPrice, '公共配件固定单价')
    }
  }
  const templateIds = new Set<string>()
  const tierIds = new Set<string>()
  const templates = new Map<string, AreaTemplate>()
  for (const template of value.templates) {
    if (!record(template)) throw new Error('面积档位模板格式错误')
    exactKeys(template, ['areaTemplateId', 'name', 'unit', 'tiers', ...(pricedTemplates ? ['basePrice', 'tierPrices', 'formula'] : []), ...(Object.hasOwn(template, 'boundaryMode') ? ['boundaryMode'] : []), ...(schemePrices && Object.hasOwn(template, 'matchBy') ? ['matchBy'] : []), ...(allowRuleValues && Object.hasOwn(template, 'exactSizes') ? ['exactSizes'] : []), ...(allowRuleValues && Object.hasOwn(template, 'formulas') ? ['formulas'] : [])], '面积档位模板')
    uniqueId(template.areaTemplateId, templateIds, '面积档位模板')
    if (!validId(template.name) || !validUnit(template.unit) || !Array.isArray(template.tiers) || template.matchBy !== 'exact-size' && !template.tiers.length) throw new Error('面积模板名称、单位或档位列表无效')
    if (Object.hasOwn(template, 'boundaryMode') && template.boundaryMode !== 'upper-inclusive' && template.boundaryMode !== 'lower-inclusive') throw new Error('面积模板边界模式无效')
    if (Object.hasOwn(template, 'matchBy') && template.matchBy !== 'area' && template.matchBy !== 'longest-side' && !(allowRuleValues && template.matchBy === 'exact-size')) throw new Error('模板分档依据无效')
    if (template.matchBy === 'exact-size' && template.tiers.length) throw new Error('指定尺寸模板不能同时配置区间')
    if (template.matchBy === 'exact-size' && (!Array.isArray(template.exactSizes) || !template.exactSizes.length)) throw new Error(EXACT_SIZE_REQUIRED_MESSAGE)
    if (Object.hasOwn(template, 'exactSizes')) {
      if (!Array.isArray(template.exactSizes)) throw new Error('指定尺寸列表无效')
      const prior: ExactSizeRule[] = []
      for (const rule of template.exactSizes) {
        if (!record(rule)) throw new Error('指定尺寸格式错误')
        exactKeys(rule, ['areaTierId', 'width', 'height', 'unit', 'allowRotation'], '指定尺寸')
        uniqueId(rule.areaTierId, tierIds, '指定尺寸')
        if (typeof rule.width === 'string' && !rule.width.trim() || typeof rule.height === 'string' && !rule.height.trim()) throw new Error(EXACT_SIZE_DIMENSIONS_REQUIRED_MESSAGE)
        positiveAmount(rule.width, '指定尺寸宽度')
        positiveAmount(rule.height, '指定尺寸高度')
        if (!validUnit(rule.unit) || typeof rule.allowRotation !== 'boolean') throw new Error('指定尺寸单位或旋转设置无效')
        const current = rule as ExactSizeRule
        const dimensions = quoteDimensions(current.width, current.height, current.unit)
        if (prior.some(other => exactSizeMatches({ ...other, allowRotation: other.allowRotation || current.allowRotation }, dimensions))) throw new Error('指定尺寸存在重复或旋转后的匹配冲突')
        prior.push(current)
      }
    }
    if (Object.hasOwn(template, 'formulas')) {
      if (!Array.isArray(template.formulas)) throw new Error('行公式列表无效')
      const ids = new Set<string>()
      for (const formula of template.formulas) {
        if (!record(formula)) throw new Error('行公式格式错误')
        exactKeys(formula, ['formulaId', 'name', 'formula'], '行公式')
        uniqueId(formula.formulaId, ids, '行公式')
        if (!validId(formula.name) || typeof formula.formula !== 'string') throw new Error('行公式名称或表达式无效')
        validateAreaFormula(formula.formula, getTemplateFormulaVariables(template as AreaTemplate))
      }
    }
    const tierSubject = template.matchBy === 'longest-side' ? '最长边' : '面积'
    let previous = ZERO
    let explicitRanges: boolean | undefined
    let previousRange: { min: Rational; max: Rational | null; maxInclusive: boolean } | undefined
    for (const [index, tier] of template.tiers.entries()) {
      if (!record(tier)) throw new Error('面积档位格式错误')
      const explicit = Object.hasOwn(tier, 'minArea') || Object.hasOwn(tier, 'minInclusive')
      exactKeys(tier, ['areaTierId', 'maxArea', ...(allowRuleValues && explicit ? ['minArea', 'minInclusive'] : [])], '面积档位')
      uniqueId(tier.areaTierId, tierIds, '面积档位')
      if (explicitRanges !== undefined && explicitRanges !== explicit) throw new Error('同一组档位须全部填写起止值，不能混用显式和隐式下限')
      explicitRanges = explicit
      if (tier.maxArea === null) {
        if (index !== template.tiers.length - 1) throw new Error(`不限${tierSubject}只能放在最后一个档位`)
      } else {
        positiveAmount(tier.maxArea, `${tierSubject}档位上限`)
        const current = decimal(tier.maxArea)
        if (!explicit && compare(current, previous) <= 0) throw new Error(`${tierSubject}档位上限必须按从小到大排列且不能重复`)
        previous = current
      }
      if (explicit) {
        if (typeof tier.minArea !== 'string' || !DECIMAL.test(tier.minArea) || typeof tier.minInclusive !== 'boolean') throw new Error(`${tierSubject}档位下限须为非负十进制数，并明确是否包含下限`)
        const min = decimal(tier.minArea)
        const max = tier.maxArea === null ? null : decimal(tier.maxArea as string)
        const maxInclusive = template.boundaryMode !== 'lower-inclusive'
        if (max !== null) {
          if (compare(min, max) > 0) throw new Error(`${tierSubject}档位下限不能大于上限`)
          if (compareTierBoundaries(template as AreaTemplate, min, max) === 0 && (!tier.minInclusive || !maxInclusive)) throw new Error(`${tierSubject}档位区间不能为空，相同起止值须包含两端`)
        }
        if (previousRange) {
          if (compare(min, previousRange.min) < 0) throw new Error(`${tierSubject}档位须按下限从小到大排列`)
          const touching = previousRange.max === null ? -1 : compareTierBoundaries(template as AreaTemplate, min, previousRange.max)
          if (previousRange.max === null || compare(min, previousRange.max) < 0 || touching === 0 && previousRange.maxInclusive && tier.minInclusive) throw new Error(`${tierSubject}档位区间不能重叠，包括重复包含的边界`)
        }
        previousRange = { min, max, maxInclusive }
      }
    }
    if (!explicitRanges && template.matchBy !== 'exact-size' && template.tiers.at(-1)?.maxArea !== null) throw new Error(`${tierSubject}模板最后一个档位须为不限${tierSubject}`)
    templates.set(template.areaTemplateId, template as AreaTemplate)
  }
  if (pricedTemplates) for (const template of value.templates as PricedAreaTemplate[]) validateCharge(getTemplatePriceCharge(template), templates, `模板 ${template.name}`, allowRuleValues)
  const bodyIds = new Set<string>()
  for (const row of value[bodyKey] as unknown[]) {
    if (!record(row)) throw new Error('主体面积定价格式错误')
    if (value.schemaVersion === 1) {
      exactKeys(row, ['productId', 'body', 'totalFormula'], '产品面积定价')
      uniqueId(row.productId, bodyIds, '产品面积定价')
      validateCharge(row.body, templates, `产品 ${row.productId}`)
      if (typeof row.totalFormula !== 'string') throw new Error('总价公式格式错误')
      validateAreaFormula(row.totalFormula, COMPATIBLE_TOTAL_VARIABLES)
    } else if (value.schemaVersion === 2) {
      exactKeys(row, ['categoryId', 'body'], '大类面积定价')
      uniqueId(row.categoryId, bodyIds, '大类面积定价')
      validateCharge(row.body, templates, `大类 ${row.categoryId}`)
    } else {
      exactKeys(row, ['categoryId', 'areaTemplateId'], '大类模板关联')
      uniqueId(row.categoryId, bodyIds, '大类模板关联')
      if (row.areaTemplateId !== null && (!validId(row.areaTemplateId) || !templates.has(row.areaTemplateId))) throw new Error(`大类 ${row.categoryId} 的面积模板引用无效`)
    }
  }
  if (pricedTemplates) {
    const overrides = new Set<string>()
    for (const row of value.productOverrides as unknown[]) {
      if (!record(row)) throw new Error('子类模板关联格式错误')
      exactKeys(row, ['productId', 'areaTemplateId'], '子类模板关联')
      uniqueId(row.productId, overrides, '子类模板关联')
      if (!validId(row.areaTemplateId) || !templates.has(row.areaTemplateId)) throw new Error(`子类 ${row.productId} 的面积模板引用无效`)
    }
  }
  const attributeIds = new Set<string>()
  const referenceKeys = new Set<string>()
  for (const attribute of value.attributes) {
    if (!record(attribute)) throw new Error('属性面积定价格式错误')
    exactKeys(attribute, ['areaAttributePriceId', 'optionName', 'reference', ...(schemePrices ? ['name', 'areaTemplateId'] : ['charge']), ...(value.schemaVersion === 5 ? ['basePrice', 'tierPrices'] : [])], '属性面积定价')
    uniqueId(attribute.areaAttributePriceId, attributeIds, '属性面积定价')
    const legacyPrint = { name: 'Print Option', label: '印刷', idKey: 'printOptionId' }
    const option = AREA_ATTRIBUTE_OPTIONS.find(item => item.name === attribute.optionName) ?? (!schemePrices && value.accessoryPrices === undefined && attribute.optionName === 'Print Option' ? legacyPrint : undefined)
    if (!option || !record(attribute.reference) || Object.keys(attribute.reference).length !== 1) throw new Error('属性价格须关联明确的属性实体')
    if ((schemePrices || value.accessoryPrices !== undefined) && (attribute.optionName === 'Print Option' || attribute.optionName === 'Accessories Style')) throw new Error('印刷不计价，配件请使用公共固定单价')
    const reference = attribute.reference as EntityReference
    const key = getEntityKey(reference)
    if (key !== option.idKey && !(option.name === 'Accessories Style' && key === 'accessoryColorId')) throw new Error('属性价格的实体字段与属性类型不一致')
    if (!validId(getEntityId(reference))) throw new Error('属性价格的实体标识无效')
    const token = `${key}:${getEntityId(reference)}`
    if (!schemePrices && referenceKeys.has(token)) throw new Error('同一个属性实体只能有一份面积价格')
    referenceKeys.add(token)
    if (schemePrices) {
      if (!validId(attribute.name)) throw new Error('附加价格方案名称不能为空')
      if (!validId(attribute.areaTemplateId) || !templates.has(attribute.areaTemplateId)) throw new Error('附加价格方案的面积模板引用无效')
      if (value.schemaVersion === 5) validateCharge({ areaTemplateId: attribute.areaTemplateId, basePrice: attribute.basePrice, tierPrices: attribute.tierPrices, formula: (templates.get(attribute.areaTemplateId) as PricedAreaTemplate).formula }, templates, `附加价格方案 ${attribute.name}`, allowRuleValues)
    } else validateCharge(attribute.charge, templates, `${option.label} ${getEntityId(reference)}`)
  }
  if (schemePrices) {
    const plans = value.attributes as LegacySchemeAreaAttributePrice[]
    for (const [rows, ownerKey] of [[value.categoryAttributeBindings, 'categoryId'], [value.productAttributeOverrides, 'productId']] as const) {
      const bindings = new Set<string>()
      for (const binding of rows as unknown[]) {
        if (!record(binding)) throw new Error('附加价格关联格式错误')
        exactKeys(binding, [ownerKey, 'optionName', 'reference', 'areaAttributePriceId'], '附加价格关联')
        if (!validId(binding[ownerKey])) throw new Error('附加价格关联的所属实体标识无效')
        const option = AREA_ATTRIBUTE_OPTIONS.find(row => row.name === binding.optionName && row.name !== 'Accessories Style')
        if (!option || !record(binding.reference) || Object.keys(binding.reference).length !== 1 || !validId(binding.reference[option.idKey])) throw new Error('附加价格关联须使用与属性类型一致的实体字段')
        const reference = binding.reference as EntityReference
        const key = JSON.stringify([binding[ownerKey], binding.optionName, getEntityKey(reference), getEntityId(reference)])
        if (bindings.has(key)) throw new Error('同一产品或大类的属性价格关联不能重复')
        bindings.add(key)
        if (binding.areaAttributePriceId !== null) {
          if (!validId(binding.areaAttributePriceId)) throw new Error('附加价格关联的方案标识无效')
          const plan = plans.find(row => row.areaAttributePriceId === binding.areaAttributePriceId)
          if (!plan) throw new Error('附加价格关联的方案已不存在')
          if (!sameAttribute(plan, { optionName: String(binding.optionName), reference })) throw new Error('附加价格关联的方案不属于当前属性')
        }
      }
    }
  }
  if (value.schemaVersion === 5) {
    const products = new Set<string>()
    for (const row of value.productTotalFormulas as unknown[]) {
      if (!record(row)) throw new Error('产品总价公式格式错误')
      exactKeys(row, ['productId', 'formula'], '产品总价公式')
      uniqueId(row.productId, products, '产品总价公式')
      if (typeof row.formula !== 'string') throw new Error('产品总价公式格式错误')
      validateAreaFormula(row.formula, AREA_TOTAL_VARIABLES)
    }
  }
}
export function validateAreaReferences(document: AnyAreaPricingDocument, bundle: Bundle, allowRuleValues = false): void {
  validateAreaPricing(document, allowRuleValues)
  const products = allProducts(bundle.main)
  const productIds = new Set(products.map(product => product.productId))
  if (document.schemaVersion === 6 || document.schemaVersion === 7) {
    if (document.schemaVersion === 7) for (const row of document.productAdjustments) if (!productIds.has(row.productId)) throw new Error(`产品调整项引用的产品 ${row.productId} 已不存在`)
    const categoryIds = new Set(getAreaPricingCategories(bundle).map(category => category.categoryId))
    for (const binding of document.categoryAdditionalPlanBindings) if (!categoryIds.has(binding.categoryId)) throw new Error(`附加价格关联的大类 ${binding.categoryId} 已不存在`)
    for (const binding of document.productAdditionalPlanOverrides) {
      if (!productIds.has(binding.productId)) throw new Error(`附加价格关联的产品 ${binding.productId} 已不存在`)
      if (!getProductPricingCategory(bundle, binding.productId)) throw new Error(`附加价格关联的产品 ${binding.productId} 尚未归属产品大类`)
    }
    validateAreaReferences(independentValidationView(document), bundle, document.schemaVersion === 7)
    return
  }
  if (document.schemaVersion === 1) for (const row of document.products) {
    if (!productIds.has(row.productId)) throw new Error(`面积价格引用的产品 ${row.productId} 已不存在`)
  }
  else {
    const categoryIds = new Set(getAreaPricingCategories(bundle).map(category => category.categoryId))
    for (const row of document.categories) if (!categoryIds.has(row.categoryId)) throw new Error(`面积价格引用的大类 ${row.categoryId} 已不存在`)
  }
  if (document.schemaVersion === 3 || document.schemaVersion === 4 || document.schemaVersion === 5) for (const row of document.productOverrides) {
    if (!productIds.has(row.productId)) throw new Error(`面积模板引用的产品 ${row.productId} 已不存在`)
    if (!getProductPricingCategory(bundle, row.productId)) throw new Error(`面积模板引用的产品 ${row.productId} 尚未归属产品大类`)
  }
  if (document.schemaVersion === 4 || document.schemaVersion === 5) {
    const categoryIds = new Set(getAreaPricingCategories(bundle).map(category => category.categoryId))
    for (const binding of document.categoryAttributeBindings) if (!categoryIds.has(binding.categoryId)) throw new Error(`附加价格关联的大类 ${binding.categoryId} 已不存在`)
    for (const binding of document.productAttributeOverrides) {
      if (!productIds.has(binding.productId)) throw new Error(`附加价格关联的产品 ${binding.productId} 已不存在`)
      if (!getProductPricingCategory(bundle, binding.productId)) throw new Error(`附加价格关联的产品 ${binding.productId} 尚未归属产品大类`)
    }
  }
  if (document.schemaVersion === 5) for (const row of document.productTotalFormulas) {
    if (!productIds.has(row.productId)) throw new Error(`总价公式引用的产品 ${row.productId} 已不存在`)
    if (!getProductPricingCategory(bundle, row.productId)) throw new Error(`总价公式引用的产品 ${row.productId} 尚未归属产品大类`)
    try { validateAreaFormula(row.formula, getProductTotalVariables(bundle, row.productId)) }
    catch (error) { throw new Error(`产品 ${row.productId} 的总价公式无效：${error instanceof Error ? error.message : String(error)}`) }
  }
  const attributes = [...document.attributes, ...(document.schemaVersion === 4 || document.schemaVersion === 5 ? [...document.categoryAttributeBindings, ...document.productAttributeOverrides] : [])]
  for (const attribute of attributes) {
    const definition = definitions.find(row => row.name === attribute.optionName)
    const catalog = definition ? bundle.catalogs[definition.file] : undefined
    const values = catalog?.values.flatMap(value => [value, ...(value.colors ?? [])]) ?? []
    if (!values.some(value => getEntityKey(value) === getEntityKey(attribute.reference) && getEntityId(value) === getEntityId(attribute.reference))) throw new Error(`面积价格引用的属性 ${getEntityKey(attribute.reference)}=${getEntityId(attribute.reference)} 已不存在`)
  }
  for (const accessory of document.accessoryPrices ?? []) {
    const style = bundle.catalogs['accessory-styles.json'].values.find(value => getEntityId(value) === accessory.accessoryStyleId)
    if (!style || accessory.accessoryColorId !== null && !style.colors?.some(color => getEntityId(color) === accessory.accessoryColorId)) throw new Error(`公共配件价格 ${accessory.accessoryPriceId} 的样式已不存在或颜色不属于该样式`)
  }
}
function compareLength(left: Rational, right: Rational): number {
  const difference = subtract(left, right)
  const magnitude = fraction(difference.numerator < 0n ? -difference.numerator : difference.numerator, difference.denominator)
  return compare(magnitude, decimal('0.000000000001')) <= 0 ? 0 : compare(left, right)
}
function exactSizeMatches(rule: ExactSizeRule, dimensions: QuoteDimensions): boolean {
  if (!dimensions.widthMm || !dimensions.heightMm) return false
  const expected = quoteDimensions(rule.width, rule.height, rule.unit)
  const same = compareLength(dimensions.widthMm, expected.widthMm!) === 0 && compareLength(dimensions.heightMm, expected.heightMm!) === 0
  const rotated = rule.allowRotation && compareLength(dimensions.widthMm, expected.heightMm!) === 0 && compareLength(dimensions.heightMm, expected.widthMm!) === 0
  return same || rotated
}
function quoteCharge(charge: AreaCharge, template: AreaTemplate, dimensions: QuoteDimensions, label: string, key: string, allowNegative = false): { value: Rational; step: AreaQuoteStep } {
  const { area, longestSide } = dimensions
  const templateMatchBy = getTemplateMatchBy(template)
  const unitFactor = decimal(UNIT_MM[template.unit])
  const exact = template.exactSizes?.find(rule => exactSizeMatches(rule, dimensions))
  const tier = exact ?? (templateMatchBy === 'exact-size' ? undefined : template.tiers.find(tier => {
    const bounds = getAreaTierBounds(template, tier)
    const compareBoundary = (boundary: string) => templateMatchBy === 'longest-side'
      ? compareLength(longestSide, multiply(decimal(boundary), unitFactor))
      : compareArea(area, multiply(decimal(boundary), multiply(unitFactor, unitFactor)))
    // Positive dimensions remain valid even when they are smaller than the unit-conversion tolerance.
    const lower = compare(decimal(bounds.minArea), ZERO) === 0 ? compare(templateMatchBy === 'longest-side' ? longestSide : area, ZERO) : compareBoundary(bounds.minArea)
    if (bounds.minInclusive ? lower < 0 : lower <= 0) return false
    if (bounds.maxArea === null) return true
    const upper = compareBoundary(bounds.maxArea)
    return bounds.maxInclusive ? upper <= 0 : upper < 0
  }))
  if (!tier) throw new Error(`${label}没有匹配的${templateMatchBy === 'exact-size' ? '指定尺寸' : templateMatchBy === 'longest-side' ? '最长边' : '面积'}档位`)
  const row = charge.tierPrices.find(price => price.areaTierId === tier.areaTierId)
  const tierPrice = row?.price ?? null
  const calculation = row?.calculation
  // An explicit match never falls through to a less-specific interval, including an unpriced exact size.
  if (exact && !row) throw new Error(`${label}：命中“${areaTierLabel(template, tier)}”，档位价格未定价`)
  let basePrice = charge.basePrice
  let formula = charge.formula
  if (calculation?.kind === 'fixed') {
    basePrice = null
    formula = '档位价格'
  } else if (calculation?.kind === 'area') {
    basePrice = calculation.basePrice
    const scale = multiply(decimal(UNIT_MM[calculation.areaUnit]), decimal(UNIT_MM[calculation.areaUnit]))
    formula = `基本价 + 档位价格 * 面积平方毫米${calculation.areaUnit === 'mm' ? '' : ` / ${numberText(scale)}`}`
  } else if (calculation?.kind === 'formula') {
    basePrice = calculation.basePrice
    const definition = template.formulas?.find(row => row.formulaId === calculation.formulaId)
    if (!definition) throw new Error(`${label}引用的行公式不存在`)
    formula = definition.formula
  }
  const variables = { 基本价: basePrice === null ? null : decimal(basePrice), 档位价格: tierPrice === null ? null : decimal(tierPrice), 面积平方毫米: area, 最长边毫米: longestSide }
  const parsed = compileFormula(formula, getTemplateFormulaVariables(template))
  let value: Rational
  try { value = evaluateNode(parsed.root, variables) }
  catch (error) { throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`) }
  if (!allowNegative && value.numerator < 0n) throw new Error(`${label}公式计算的价格不能为负数`)
  return {
    value,
    step: { key, label, pricingKind: calculation?.kind === 'fixed' ? 'fixed' : 'area', calculationKind: calculation?.kind ?? 'inherited', matchBy: exact ? 'exact-size' : templateMatchBy,
      ...(dimensions.widthMm ? { widthMm: numberText(dimensions.widthMm) } : {}), ...(dimensions.heightMm ? { heightMm: numberText(dimensions.heightMm) } : {}),
      longestSideMm: numberText(longestSide), basePrice, tierPrice, areaTemplateId: template.areaTemplateId, templateName: template.name, areaTierId: tier.areaTierId,
      tierLabel: areaTierLabel(template, tier), areaMm2: numberText(area), formula, substitutedFormula: substituteTokens(parsed.tokens, variables), amount: numberText(value) },
  }
}
/** Preview one charge even when a different selected charge is still unpriced. */
export function previewAreaCharge(charge: AreaCharge, template: AreaTemplate, dimensions: AreaDimensions, label: string, key: string, options?: { allowNegative?: boolean }): AreaQuoteStep {
  return quoteCharge(charge, template, quoteDimensions(dimensions.width, dimensions.height, dimensions.unit), label, key, options?.allowNegative).step
}
type StandeeQuoteDimensions = { parts: QuoteDimensions[]; base: QuoteDimensions }
function standeeDimensions(input: AreaStandeeInput): StandeeQuoteDimensions {
  if (!input || !Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 4) throw new Error('立牌需要填写 1 至 4 片主体的尺寸')
  const read = (dimensions: AreaDimensions, label: string) => {
    try {
      if (!dimensions) throw new Error('请填写宽高')
      return quoteDimensions(dimensions.width, dimensions.height, dimensions.unit)
    } catch (error) { throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`) }
  }
  return { parts: input.parts.map((part, index) => read(part, `主体第 ${index + 1} 片`)), base: read(input.base, '底座') }
}
function aggregateStandeeDimensions(standee: StandeeQuoteDimensions): QuoteDimensions {
  const all = [...standee.parts, standee.base]
  return { area: all.reduce((sum, dimensions) => add(sum, dimensions.area), ZERO),
    longestSide: all.reduce((longest, dimensions) => compare(longest, dimensions.longestSide) >= 0 ? longest : dimensions.longestSide, ZERO) }
}
function quoteProductCharge(charge: AreaProductCharge, template: PricedAreaTemplate, dimensions: QuoteDimensions, standee: StandeeQuoteDimensions | undefined, label: string, key: string, allowNegative = false): { value: Rational; step: AreaQuoteStep } {
  if (!standee) {
    if (template.standeeBase) throw new Error(`${label}需要填写各片主体和底座尺寸`)
    return quoteCharge(charge, template, dimensions, label, key, allowNegative)
  }
  if (!template.standeeBase) throw new Error(`${label}模板尚未配置底座区间，请在产品单价档位中启用逐片和底座计价`)
  if (!charge.standeeBase) throw new Error(`${label}底座未定价，请填写底座基础费和档位价格`)
  const pieces = standee.parts.map((part, index) => quoteCharge(charge, template, part, `${label} · 主体第 ${index + 1} 片`, `${key}:piece:${index + 1}`, allowNegative))
  const baseTemplate: PricedAreaTemplate = { ...template.standeeBase, areaTemplateId: template.areaTemplateId, name: `${template.name} · 底座` }
  const baseCharge: AreaCharge = { ...charge.standeeBase, areaTemplateId: template.areaTemplateId, formula: template.standeeBase.formula }
  const base = quoteCharge(baseCharge, baseTemplate, standee.base, `${label} · 底座`, `${key}:base`, allowNegative)
  const values = [...pieces, base]
  const value = values.reduce((sum, item) => add(sum, item.value), ZERO)
  return { value, step: { ...pieces[0].step, key, label, basePrice: null, tierPrice: null, areaTierId: '',
    widthMm: undefined, heightMm: undefined, calculationKind: undefined,
    tierLabel: `${pieces.length} 片主体分别匹配档位，底座计算一次`, areaMm2: numberText(dimensions.area), longestSideMm: numberText(dimensions.longestSide),
    formula: [...pieces.map((_part, index) => `主体第 ${index + 1} 片`), '底座'].join(' + '),
    substitutedFormula: values.map(item => `(${item.step.amount})`).join(' + '), amount: numberText(value), parts: values.map(item => item.step) } }
}
/** A product adjustment is counted once after summing its body pieces and base. */
function applyProductAdjustment(quoted: { value: Rational; step: AreaQuoteStep }, adjustment: string | null | undefined): { value: Rational; step: AreaQuoteStep } {
  if (adjustment === undefined) return quoted
  if (adjustment === null) throw new Error('产品调整项未定价')
  optionalSignedPrice(adjustment, '产品调整金额')
  const value = add(quoted.value, decimal(adjustment))
  if (value.numerator < 0n) throw new Error('产品调整后的主体价格不能为负数')
  const { parts: _parts, ...bodyPart } = quoted.step
  const adjustmentPart: AreaQuoteStep = {
    key: `${quoted.step.key}:adjustment`, label: '产品固定调整', pricingKind: 'fixed', calculationKind: 'adjustment',
    basePrice: adjustment, tierPrice: null, areaTemplateId: '', templateName: '产品固定调整', areaTierId: '', tierLabel: '每件产品仅计算一次',
    areaMm2: quoted.step.areaMm2, formula: '产品固定调整', substitutedFormula: adjustment, amount: adjustment,
  }
  const parts = [...(quoted.step.parts ?? [{ ...bodyPart, key: `${bodyPart.key}:unadjusted`, label: '主体原价' }]), adjustmentPart]
  return { value, step: { ...quoted.step, basePrice: null, tierPrice: null, amount: numberText(value), parts,
    formula: parts.map(part => part.label).join(' + '), substitutedFormula: parts.map(part => `(${part.amount})`).join(' + ') } }
}
/** Calculate one complete price component while preserving all piece and base details. */
export function previewAreaProductCharge(charge: AreaProductCharge, template: PricedAreaTemplate, dimensions: AreaDimensions, standeeInput: AreaStandeeInput | undefined, label: string, key: string, options?: { allowNegative?: boolean; adjustment?: string | null }): AreaQuoteStep {
  const standee = standeeInput ? standeeDimensions(standeeInput) : undefined
  const measured = standee ? aggregateStandeeDimensions(standee) : quoteDimensions(dimensions.width, dimensions.height, dimensions.unit)
  return applyProductAdjustment(quoteProductCharge(charge, template, measured, standee, label, key, options?.allowNegative), options?.adjustment).step
}
function selectedPieceCount(bundle: Bundle, product: Product, input: AreaQuoteInput): number {
  const option = optionFor(product, 'Standee Quantity')
  const id = input.standeeQuantityId ?? input.selections['Standee Quantity']
  if (!option || option.deleted) {
    if (id) throw new Error('该产品未启用主体片数')
    return 1
  }
  const values = catalogFor(bundle, product, 'Standee Quantity').values
  if (!id && !values.some(value => isEnabled(option, value))) return 1
  const selected = id ? values.find(value => getEntityId(value) === id && isEnabled(option, value)) : undefined
  if (!selected) throw new Error('请选择有效的主体片数')
  if (!Number.isSafeInteger(selected.pieceCount) || selected.pieceCount! < 1 || selected.pieceCount! > 4) throw new Error('主体片数必须是 1 至 4 的整数')
  return selected.pieceCount!
}
function selectedStandardDimensions(bundle: Bundle, product: Product, input: AreaQuoteInput): QuoteDimensions | undefined {
  if (input.sizeBandId === undefined) return undefined
  const option = optionFor(product, 'Size')
  const value = option && !option.deleted
    ? catalogFor(bundle, product, 'Size').values.find(value => getEntityId(value) === input.sizeBandId && isEnabled(option, value))
    : undefined
  if (!value) throw new Error('所选尺寸不属于当前产品或尚未启用')
  const size = value
  if (size.isCustom) return undefined
  if (!size.area) throw new Error('所选尺寸尚未填写面积宽高')
  const expectedDimensions = quoteDimensions(size.area.width, size.area.height, size.area.unit)
  const factor = decimal(UNIT_MM[input.unit])
  const expectedFactor = decimal(UNIT_MM[size.area.unit])
  const width = multiply(decimal(input.width), factor)
  const height = multiply(decimal(input.height), factor)
  const expectedWidth = multiply(decimal(size.area.width), expectedFactor)
  const expectedHeight = multiply(decimal(size.area.height), expectedFactor)
  const sameLength = (left: Rational, right: Rational) => {
    const difference = subtract(left, right)
    return compare(fraction(difference.numerator < 0n ? -difference.numerator : difference.numerator, difference.denominator), decimal('0.000000001')) <= 0
  }
  const original = sameLength(width, expectedWidth) && sameLength(height, expectedHeight)
  const rotated = sameLength(width, expectedHeight) && sameLength(height, expectedWidth)
  if (!original && !rotated) throw new Error('标准尺寸宽高必须使用产品选项中的面积配置，自定义尺寸需先启用')
  // Unit changes may display recurring decimals. Preserve the configured physical size.
  return expectedDimensions
}
export function quoteAreaProduct(source: AnyAreaPricingDocument, bundle: Bundle, quantityPricing: QuantityPricingDocument, input: AreaQuoteInput): AreaQuoteResult {
  validateAreaPricing(source)
  const document = source.schemaVersion === 7 ? source : upgradeAreaPricing(source, bundle)
  validateQuantityPricing(quantityPricing)
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new Error('购买数量必须是大于 0 的整数')
  const product = allProducts(bundle.main).find(product => product.productId === input.productId)
  if (!product) throw new Error('产品已不存在，请重新选择')
  const category = getProductPricingCategory(bundle, input.productId)
  if (!category) throw new Error('该产品尚未归属产品大类，请先在产品选项配置中设置大类')
  const resolved = resolveProductBaseTemplate(document, bundle, input.productId)
  if (!resolved.template) throw new Error(`产品“${display(product)}”尚未选择面积档位模板，请在产品基础单价中设置`)
  const pieceCount = selectedPieceCount(bundle, product, input)
  const pieceOption = optionFor(product, 'Standee Quantity')
  const hasPieceCount = !!pieceOption && !pieceOption.deleted && catalogFor(bundle, product, 'Standee Quantity').values.some(value => isEnabled(pieceOption, value))
  const usesStandee = (source.schemaVersion === 6 || source.schemaVersion === 7) && (hasPieceCount || !!resolved.template.standeeBase)
  let standee: StandeeQuoteDimensions | undefined
  if (usesStandee) {
    if (!resolved.template.standeeBase) throw new Error('当前产品单价档位尚未配置底座区间，请启用逐片和底座计价')
    if (!input.standee) throw new Error('请按主体片数填写每片主体的宽高和底座宽高')
    if (!Array.isArray(input.standee.parts) || input.standee.parts.length !== pieceCount) throw new Error(`主体尺寸数量必须与所选主体片数一致（${pieceCount} 片）`)
    standee = standeeDimensions(input.standee)
  } else if ((source.schemaVersion === 6 || source.schemaVersion === 7) && input.standee) throw new Error('当前产品未启用逐片和底座计价')
  const enteredDimensions = standee ? aggregateStandeeDimensions(standee) : quoteDimensions(input.width, input.height, input.unit)
  const dimensions = standee ? enteredDimensions : selectedStandardDimensions(bundle, product, input) ?? enteredDimensions
  const { area, longestSide } = dimensions
  const unknown = product.productOptions.find(option => !option.deleted && option.name !== 'Size' && option.name !== 'Standee Quantity' && option.name !== 'Print Option' && !AREA_ATTRIBUTE_OPTIONS.some(item => item.name === option.name))
  if (unknown) throw new Error(`当前面积定价尚不支持属性“${unknown.labelZh || unknown.name}”`)
  if (input.selections['Print Option']) {
    const printOption = optionFor(product, 'Print Option')
    const printValue = catalogFor(bundle, product, 'Print Option').values.find(value => getEntityId(value) === input.selections['Print Option'])
    if (!printOption || printOption.deleted || !printValue || !isEnabled(printOption, printValue)) throw new Error('请选择有效的印刷选项')
  }
  const body = applyProductAdjustment(quoteProductCharge(getTemplatePriceCharge(resolved.template), resolved.template, dimensions, standee, '大类主体价', 'body'), document.productAdjustments.find(row => row.productId === product.productId)?.amount)
  // Older formats allowed body and attributes to use separate templates.
  // Keep that historical calculation readable; current plans must match the body template.
  const additional = source.schemaVersion === 6 || source.schemaVersion === 7
    ? resolveProductAdditionalPlan(document, bundle, product.productId)
    : boundProductAdditionalPlan(document, bundle, product.productId)
  const steps = [body.step]
  const variables: Record<string, Rational> = { 大类主体价: body.value, 属性价: ZERO, 配件价: ZERO, 面积平方毫米: area, 最长边毫米: longestSide, 主体片数: fraction(BigInt(pieceCount)), 数量: fraction(BigInt(input.quantity)) }
  let unitPrice = body.value
  for (const definition of AREA_ATTRIBUTE_OPTIONS) {
    const option = optionFor(product, definition.name)
    const selectedId = input.selections[definition.name]
    if (!option || option.deleted) {
      if (selectedId || definition.name === 'Accessories Style' && (input.accessoryColorId || input.selections['Accessories Style:color'])) throw new Error(`该产品未启用${definition.label}，请清空选择`)
      continue
    }
    const catalog = catalogFor(bundle, product, definition.name)
    const available = catalog.values.filter(value => isEnabled(option, value))
    if (!available.length && !selectedId && !(definition.name === 'Accessories Style' && (input.accessoryColorId || input.selections['Accessories Style:color']))) continue
    let selected = available.find(value => getEntityId(value) === selectedId)
    if (!selected) throw new Error(`请选择有效的${definition.label}选项`)
    if (definition.name === 'Accessories Style') {
      const style = selected
      const colorId = input.accessoryColorId ?? input.selections['Accessories Style:color']
      const color = colorId ? selected.colors?.find(value => getEntityId(value) === colorId && isEnabled(option, value)) : undefined
      if (colorId && !color) throw new Error('所选配件颜色不属于该样式或已被禁用')
      if (document.accessoryPricing === 'color') {
        if (!color) throw new Error('请选择配件颜色')
        selected = color
      }
      const pricedColorId = document.accessoryPricing === 'color' ? getEntityId(selected) : null
      const fixed = document.accessoryPrices?.find(row => row.accessoryStyleId === getEntityId(style) && row.accessoryColorId === pricedColorId)
      const reference = entityReference(selected)
      const price = fixed?.unitPrice
      if (price == null) throw new Error(`配件“${display(selected)}”的公共固定单价未定价`)
      const value = decimal(price)
      variables[definition.variable] = value
      unitPrice = add(unitPrice, value)
      steps.push({ key: fixed!.accessoryPriceId, label: `配件 · ${display(selected)}`, pricingKind: 'fixed', optionName: definition.name, reference, basePrice: price, tierPrice: null, areaTemplateId: '', templateName: '公共固定单价', areaTierId: '', tierLabel: '不按面积计价', areaMm2: numberText(area), formula: '配件固定单价', substitutedFormula: price, amount: numberText(value) })
      continue
    }
    const reference = entityReference(selected)
    const price = additional.plan?.prices.find(row => sameAttribute(row, { optionName: definition.name, reference }))
    const resolvedAttribute = { ...additional, price, template: document.templates.find(row => row.areaTemplateId === price?.areaTemplateId) }
    if (!resolvedAttribute.plan) {
      const bound = boundProductAdditionalPlan(document, bundle, product.productId).plan
      if (bound) throw new Error(`附加价格方案“${bound.name}”与当前档位模板不匹配，请在产品基础单价中重新选择`)
    }
    if (!resolvedAttribute.plan || !resolvedAttribute.price || !resolvedAttribute.template) throw new Error(`${definition.label}“${display(selected)}”未定价，请先关联附加价格方案`)
    const attribute = resolvedAttribute.price
    const priced = quoteProductCharge(getAttributePlanCharge(attribute, resolvedAttribute.template), resolvedAttribute.template, dimensions, standee, `${definition.label} · ${display(selected)}`, `${resolvedAttribute.plan.additionalPricePlanId}:${attribute.areaAttributePriceId}`, true)
    variables[definition.variable] = priced.value
    variables['属性价'] = add(variables['属性价'], priced.value)
    unitPrice = add(unitPrice, priced.value)
    steps.push({ ...priced.step, planName: resolvedAttribute.plan.name, optionName: definition.name, reference })
  }
  if (unitPrice.numerator < 0n) throw new Error('折扣前主体、属性与配件的合计单价不能为负数')
  const tiers = quantityPricing.categoryRules.find(rule => rule.categoryId === category.categoryId)?.tiers ?? []
  const quantityTier = matchQuantityTier(tiers, input.quantity)
  const discountPercent = quantityTier?.discountPercent ?? 0
  const discountFactor = subtract(ONE, divide(decimal(String(discountPercent)), fraction(100n)))
  variables['折扣系数'] = discountFactor
  const availableVariables = getProductTotalVariables(bundle, input.productId)
  const totalFormula = resolveProductTotalFormula(document, bundle, input.productId)
  const parsed = compileFormula(totalFormula, availableVariables)
  const total = evaluateNode(parsed.root, variables)
  if (total.numerator < 0n) throw new Error('总价公式计算的最终价格不能为负数')
  return {
    steps,
    areaMm2: numberText(area),
    longestSideMm: numberText(longestSide),
    discountPercent,
    discountFactor: numberText(discountFactor),
    quantityTierId: quantityTier?.quantityTierId ?? null,
    unitPrice: numberText(unitPrice),
    totalPrice: moneyText(total),
    formula: totalFormula,
    substitutedFormula: substituteTokens(parsed.tokens, variables),
    variables: Object.fromEntries(Object.entries(variables).filter(([name]) => availableVariables.includes(name)).map(([name, value]) => [name, numberText(value)])),
  }
}
