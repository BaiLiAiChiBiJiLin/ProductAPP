import { allProducts, catalogFor, getEntityId, getProductSizes, isEnabled, optionFor, ordered, resolvePreview, type Bundle, type Product } from '../product-options/model'
import { matchQuantityTier, validateDocument as validateQuantityDocument, type QuantityPricingDocument } from '../quantity-pricing/model'
import { validateAreaPricing, validateAreaReferences, type AnyAreaPricingDocument } from './areaPricing'

export type PriceSelections = { techniqueId: string | null; holoFilmId: string | null; materialId: string | null }
export type BasePrice = { basePriceId: string; sizeBandId: string; unitPrice: string }
export type AttributePrice = PriceSelections & { attributePriceId: string; sizeBandId: string | null; unitPrice: string }
/** A null size is the explicit, size-independent band used by fixed-price products. */
export type SharedAttributePrice = { sharedAttributePriceId: string; techniqueId: string | null; holoFilmId: string | null; sizeBandId: string | null; unitPrice: string }
/** Preserved migration evidence only; these rows never participate in quotes. */
export type BodyPrice = PriceSelections & { productPriceId: string; sizeBandId: string; unitPrice: string }
export type AccessoryPrice = { accessoryPriceId: string; accessoryStyleId: string; accessoryColorId: string | null; unitPrice: string }
export type PriceRange = { rangeId: string; minMm: string; maxMm: string; kind: 'fixed' | 'area'; amount: string; coefficient: string }
export type DimensionPanel = { panelId: string; label: string; pieceBands: PriceRange[]; baseBands: PriceRange[]; baseAdjustment: string }
export type DimensionPrice = PriceSelections & { productPriceId: string; baseUnitPrice: string; panels: DimensionPanel[] }
/** Signed range used by the new standee component model.  Attribute rows are
 * adjustments, so their intercept or area coefficient can legitimately be
 * negative even though the final panel price must remain non-negative. */
export type SignedPriceRange = Omit<PriceRange, 'amount' | 'coefficient'> & { amount: string; coefficient: string }
export type StandeeComponentKind = 'base' | 'technique' | 'holoFilm' | 'material' | 'composite'
export type StandeePriceComponent = {
  componentId: string
  panelTemplateId: string
  kind: StandeeComponentKind
  techniqueId: string | null
  holoFilmId: string | null
  materialId: string | null
  pieceBands: SignedPriceRange[]
  baseBands: SignedPriceRange[]
  baseAdjustment: string
}
export type StandeeCompositionGroup = { groupId: string; panelTemplateId: string; label: string; componentIds: string[] }
export type StandeeComposition = PriceSelections & { compositionId: string; legacyProductPriceId: string; baseUnitPrice: string; groups: StandeeCompositionGroup[] }
/** Product-level decomposition of standee prices. Legacy `dimensionPrices`
 * remains as migration evidence and a safe fallback for incomplete rows. */
export type StandeePricing = {
  schemaVersion: 1
  baseComponents: StandeePriceComponent[]
  techniqueComponents: StandeePriceComponent[]
  holoFilmComponents: StandeePriceComponent[]
  materialComponents: StandeePriceComponent[]
  compositeComponents: StandeePriceComponent[]
  compositions: StandeeComposition[]
}
export type ProductPricing = { productId: string; printPricing: 'included'; pricingMode: 'table' | 'standee' | 'fixed'; fixedUnitPrice: string | null; basePrices: BasePrice[]; attributePrices: AttributePrice[]; legacyBodyPrices: BodyPrice[]; dimensionPrices: DimensionPrice[]; standeePricing?: StandeePricing }
export type ProductPricingDocument = { schemaVersion: 4 | 5; currency: 'USD'; accessoryPricing: 'style' | 'color'; accessoryPrices: AccessoryPrice[]; sharedAttributePrices?: SharedAttributePrice[]; products: ProductPricing[]; areaPricing?: AnyAreaPricingDocument }
export type Dimensions = { widthMm: string; heightMm: string }
export type PanelInput = { panelId: string; standeeQuantityId?: string | null; parts: Dimensions[]; base: Dimensions }
export type StandeeSizeInput = { standeeQuantityId?: string | null; parts: Dimensions[]; base: Dimensions }
export type QuoteInput = { productId: string; sizeBandId: string; techniqueId: string | null; holoFilmId?: string | null; materialId?: string | null; accessoryStyleId: string | null; accessoryColorId: string | null; quantity: number; panelInputs?: PanelInput[]; standee?: StandeeSizeInput; standeeQuantityId?: string | null }
export type QuoteResult = { bodyUnitPrice: string; techniqueUnitPrice: string; holoFilmUnitPrice: string; materialUnitPrice: string; attributeUnitPrice: string; accessoryUnitPrice: string; unitPrice: string; discountPercent: number; discountedUnitPrice: string; totalPrice: string; quantityTierId: string | null }
export const cloneDocument = (value: ProductPricingDocument): ProductPricingDocument => structuredClone(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.trim() === value
export const isUnitPrice = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/.test(value)
export const isAttributePrice = (value: unknown): value is string => typeof value === 'string' && isUnitPrice(value.startsWith('-') ? value.slice(1) : value)
const active = (product: Product, name: string) => !!optionFor(product, name) && !optionFor(product, name)!.deleted
const dimensions = [{ field: 'techniqueId', option: 'Technique', label: '工艺' }, { field: 'holoFilmId', option: 'Holo Film', label: '全息膜' }, { field: 'materialId', option: 'Material', label: '材质' }] as const
const selectionFields = dimensions.map(item => item.field)
const selectionKey = (value: PriceSelections) => JSON.stringify(selectionFields.map(field => value[field]))

// Exact signed decimals preserve all component precision until the final line total.
type Decimal = { coefficient: bigint; scale: number }
const zero: Decimal = { coefficient: 0n, scale: 0 }
const parse = (value: string): Decimal => {
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  return { coefficient: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length }
}
const ten = (scale: number) => 10n ** BigInt(scale)
const add = (a: Decimal, b: Decimal): Decimal => {
  const scale = Math.max(a.scale, b.scale)
  return { coefficient: a.coefficient * ten(scale - a.scale) + b.coefficient * ten(scale - b.scale), scale }
}
const multiply = (a: Decimal, b: Decimal): Decimal => ({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale })
const compare = (a: Decimal, b: Decimal): number => {
  const scale = Math.max(a.scale, b.scale)
  const difference = a.coefficient * ten(scale - a.scale) - b.coefficient * ten(scale - b.scale)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}
const format = ({ coefficient, scale }: Decimal, fixed = false): string => {
  const negative = coefficient < 0n
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0')
  if (!scale) return `${negative ? '-' : ''}${digits}`
  const fraction = fixed ? digits.slice(-scale) : digits.slice(-scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}${fraction ? `.${fraction}` : ''}`
}
const cents = (value: Decimal): string => {
  if (value.scale <= 2) return format({ coefficient: value.coefficient * ten(2 - value.scale), scale: 2 }, true)
  const divisor = ten(value.scale - 2)
  return format({ coefficient: (value.coefficient + divisor / 2n) / divisor, scale: 2 }, true)
}
function keys(value: Record<string, unknown>, fields: string[], label: string) {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error(`${label}字段无效`)
}
function uniqueId(value: unknown, ids: Set<string>, label: string): asserts value is string {
  if (!validId(value) || ids.has(value)) throw new Error(`${label}标识为空或重复`)
  ids.add(value)
}
function amount(value: unknown, label: string): asserts value is string {
  if (!isUnitPrice(value)) throw new Error(`${label}须为非负十进制金额，整数最多9位、小数最多18位`)
}
function signedAmount(value: unknown, label: string): asserts value is string {
  if (!isAttributePrice(value)) throw new Error(`${label}须为十进制金额，整数最多9位、小数最多18位`)
}
function selections(value: Record<string, unknown>): void {
  for (const dimension of dimensions) if (value[dimension.field] !== null && !validId(value[dimension.field])) throw new Error(`${dimension.label}引用无效`)
}
function validateRanges(value: unknown, ids: Set<string>): asserts value is PriceRange[] {
  if (!Array.isArray(value)) throw new Error('尺寸区间必须是数组')
  for (const range of value) {
    if (!record(range)) throw new Error('尺寸区间格式错误')
    keys(range, ['rangeId', 'minMm', 'maxMm', 'kind', 'amount', 'coefficient'], '尺寸区间'); uniqueId(range.rangeId, ids, '尺寸区间')
    amount(range.minMm, '最小尺寸'); amount(range.maxMm, '最大尺寸')
    if (compare(parse(range.minMm), zero) <= 0 || compare(parse(range.maxMm), parse(range.minMm)) < 0) throw new Error('尺寸区间必须大于零，且上限不能小于下限')
    amount(range.amount, '区间金额'); amount(range.coefficient, '面积系数')
    if (range.kind !== 'fixed' && range.kind !== 'area') throw new Error('尺寸区间计价方式无效')
    if (range.kind === 'fixed' && parse(range.coefficient).coefficient !== 0n) throw new Error('固定区间的面积系数必须为0')
  }
  const sorted = (value as PriceRange[]).slice().sort((a, b) => compare(parse(a.minMm), parse(b.minMm)))
  for (let index = 1; index < sorted.length; index++) if (compare(parse(sorted[index].minMm), parse(sorted[index - 1].maxMm)) <= 0) throw new Error('尺寸区间不能重叠（边界包含在区间内）')
}
function validateSignedRanges(value: unknown, ids: Set<string>): asserts value is SignedPriceRange[] {
  if (!Array.isArray(value)) throw new Error('立牌组成区间必须是数组')
  for (const range of value) {
    if (!record(range)) throw new Error('立牌组成区间格式错误')
    keys(range, ['rangeId', 'minMm', 'maxMm', 'kind', 'amount', 'coefficient'], '立牌组成区间'); uniqueId(range.rangeId, ids, '立牌组成区间')
    amount(range.minMm, '最小尺寸'); amount(range.maxMm, '最大尺寸')
    if (compare(parse(range.minMm), zero) <= 0 || compare(parse(range.maxMm), parse(range.minMm)) < 0) throw new Error('立牌组成区间必须大于零，且上限不能小于下限')
    signedAmount(range.amount, '立牌组成金额'); signedAmount(range.coefficient, '立牌组成面积系数')
    if (range.kind !== 'fixed' && range.kind !== 'area') throw new Error('立牌组成区间计价方式无效')
    if (range.kind === 'fixed' && parse(range.coefficient).coefficient !== 0n) throw new Error('固定立牌组成区间的面积系数必须为0')
  }
  const sorted = (value as SignedPriceRange[]).slice().sort((a, b) => compare(parse(a.minMm), parse(b.minMm)))
  for (let index = 1; index < sorted.length; index++) if (compare(parse(sorted[index].minMm), parse(sorted[index - 1].maxMm)) <= 0) throw new Error('立牌组成区间不能重叠（边界包含在区间内）')
}
function validateStandeePricing(value: unknown, componentIds: Set<string>, panelIds: Set<string>, rangeIds: Set<string>): asserts value is StandeePricing {
  if (!record(value)) throw new Error('立牌组成价格格式错误')
  keys(value, ['schemaVersion', 'baseComponents', 'techniqueComponents', 'holoFilmComponents', 'materialComponents', 'compositeComponents', 'compositions'], '立牌组成价格')
  if (value.schemaVersion !== 1 || !Array.isArray(value.compositions)) throw new Error('立牌组成价格版本或组合列表无效')
  const model = value as unknown as StandeePricing
  const components = [...(model.baseComponents ?? []), ...(model.techniqueComponents ?? []), ...(model.holoFilmComponents ?? []), ...(model.materialComponents ?? []), ...(model.compositeComponents ?? [])]
  const localIds = new Set<string>()
  for (const component of components) {
    if (!record(component)) throw new Error('立牌价格组成格式错误')
    keys(component, ['componentId', 'panelTemplateId', 'kind', 'techniqueId', 'holoFilmId', 'materialId', 'pieceBands', 'baseBands', 'baseAdjustment'], '立牌价格组成')
    uniqueId(component.componentId, localIds, '立牌价格组成')
    if (componentIds.has(component.componentId)) throw new Error('立牌价格组成标识不能与价格行重复')
    componentIds.add(component.componentId)
    if (!validId(component.panelTemplateId) || !['base', 'technique', 'holoFilm', 'material', 'composite'].includes(String(component.kind))) throw new Error('立牌价格组成面板或类型无效')
    if ((component.techniqueId !== null && !validId(component.techniqueId)) || (component.holoFilmId !== null && !validId(component.holoFilmId)) || (component.materialId !== null && !validId(component.materialId))) throw new Error('立牌价格组成属性引用无效')
    if (component.kind === 'base' && (component.techniqueId !== null || component.holoFilmId !== null || component.materialId !== null)) throw new Error('立牌基础组成不能关联属性')
    if (component.kind === 'technique' && (component.techniqueId === null || component.holoFilmId !== null || component.materialId !== null)) throw new Error('立牌工艺组成引用无效')
    if (component.kind === 'holoFilm' && (component.holoFilmId === null || component.techniqueId !== null || component.materialId !== null)) throw new Error('立牌全息膜组成引用无效')
    if (component.kind === 'material' && (component.materialId === null || component.techniqueId !== null || component.holoFilmId !== null)) throw new Error('立牌材质组成引用无效')
    signedAmount(component.baseAdjustment, '立牌组成底座调整金额')
    validateSignedRanges(component.pieceBands, rangeIds); validateSignedRanges(component.baseBands, rangeIds)
  }
  const compositionIds = new Set<string>(); const keysSeen = new Set<string>()
  for (const composition of value.compositions) {
    if (!record(composition)) throw new Error('立牌价格组合格式错误')
    keys(composition, ['compositionId', 'legacyProductPriceId', 'techniqueId', 'holoFilmId', 'materialId', 'baseUnitPrice', 'groups'], '立牌价格组合')
    uniqueId(composition.compositionId, compositionIds, '立牌价格组合'); if (!validId(composition.legacyProductPriceId)) throw new Error('立牌旧配方引用无效')
    selections(composition); amount(composition.baseUnitPrice, '立牌组合基础价')
    const key = JSON.stringify(selectionFields.map(field => composition[field])); if (keysSeen.has(key)) throw new Error('立牌组成的工艺、全息膜和材质组合不能重复'); keysSeen.add(key)
    if (!Array.isArray(composition.groups) || !composition.groups.length) throw new Error('立牌价格组合至少需要一个组成组')
    for (const group of composition.groups) {
      if (!record(group)) throw new Error('立牌组成组格式错误')
      keys(group, ['groupId', 'panelTemplateId', 'label', 'componentIds'], '立牌组成组')
      if (!validId(group.groupId) || !validId(group.panelTemplateId) || !validId(group.label) || !Array.isArray(group.componentIds) || !group.componentIds.length || group.componentIds.some(id => !validId(id) || !componentIds.has(id))) throw new Error('立牌组成组引用无效')
    }
    const baseCount = composition.groups.flatMap(group => group.componentIds).filter(id => components.find(component => component.componentId === id)?.kind === 'base').length
    if (baseCount !== 1) throw new Error('立牌价格组合必须且只能有一个产品基础组成')
  }
  void panelIds
}
export function validateDocument(value: unknown): asserts value is ProductPricingDocument {
  if (!record(value)) throw new Error('产品定价格式错误')
  keys(value, ['schemaVersion', 'currency', 'accessoryPricing', 'accessoryPrices', 'products', ...(value.schemaVersion === 5 ? ['sharedAttributePrices'] : []), ...(Object.hasOwn(value, 'areaPricing') ? ['areaPricing'] : [])], '产品定价')
  if (Object.hasOwn(value, 'areaPricing')) validateAreaPricing(value.areaPricing)
  if (value.schemaVersion !== 4 && value.schemaVersion !== 5 || value.currency !== 'USD' || !Array.isArray(value.products)) throw new Error('产品定价版本、币种或列表无效')
  if (value.accessoryPricing !== 'style' && value.accessoryPricing !== 'color' || !Array.isArray(value.accessoryPrices)) throw new Error('公共配件计价方式无效')
  const productIds = new Set<string>(); const rowIds = new Set<string>(); const panelIds = new Set<string>(); const rangeIds = new Set<string>()
  if (value.schemaVersion === 5) {
    if (!Array.isArray(value.sharedAttributePrices)) throw new Error('公共属性价格必须是数组')
    const sharedKeys = new Set<string>()
    for (const row of value.sharedAttributePrices) {
      if (!record(row)) throw new Error('公共属性价格格式错误')
      keys(row, ['sharedAttributePriceId', 'techniqueId', 'holoFilmId', 'sizeBandId', 'unitPrice'], '公共属性价格')
      uniqueId(row.sharedAttributePriceId, rowIds, '价格行')
      if ((row.techniqueId !== null && !validId(row.techniqueId)) || (row.holoFilmId !== null && !validId(row.holoFilmId)) || Number(row.techniqueId !== null) + Number(row.holoFilmId !== null) !== 1) throw new Error('公共属性价格必须且只能关联一个工艺或全息膜 ID')
      if (row.sizeBandId !== null && !validId(row.sizeBandId)) throw new Error('公共属性价格尺寸引用无效')
      if (!isAttributePrice(row.unitPrice)) throw new Error('公共属性价格须为十进制金额，整数最多9位、小数最多18位')
      const key = JSON.stringify([row.techniqueId, row.holoFilmId, row.sizeBandId])
      if (sharedKeys.has(key)) throw new Error('同一公共属性与尺寸的价格不能重复')
      sharedKeys.add(key)
    }
  }
  const accessoryKeys = new Set<string>()
  for (const row of value.accessoryPrices) {
    if (!record(row)) throw new Error('配件价格行格式错误')
    keys(row, ['accessoryPriceId', 'accessoryStyleId', 'accessoryColorId', 'unitPrice'], '配件价格行'); uniqueId(row.accessoryPriceId, rowIds, '价格行')
    if (!validId(row.accessoryStyleId) || row.accessoryColorId !== null && !validId(row.accessoryColorId)) throw new Error('配件样式或颜色引用无效')
    if (value.accessoryPricing === 'style' && row.accessoryColorId !== null || value.accessoryPricing === 'color' && row.accessoryColorId === null) throw new Error('配件价格行与按样式／颜色计价方式不一致')
    amount(row.unitPrice, '配件价格')
    const key = JSON.stringify([row.accessoryStyleId, row.accessoryColorId])
    if (accessoryKeys.has(key)) throw new Error('公共配件样式和颜色价格不能重复')
    accessoryKeys.add(key)
  }
  for (const product of value.products) {
    if (!record(product)) throw new Error('产品价表格式错误')
    const productFields = ['productId', 'printPricing', 'pricingMode', 'fixedUnitPrice', 'basePrices', 'attributePrices', 'legacyBodyPrices', 'dimensionPrices', ...(product.pricingMode === 'standee' && Object.hasOwn(product, 'standeePricing') ? ['standeePricing'] : [])]
    keys(product, productFields, '产品价表'); uniqueId(product.productId, productIds, '产品')
    if (product.printPricing !== 'included' || !['table', 'standee', 'fixed'].includes(String(product.pricingMode)) || !Array.isArray(product.basePrices) || !Array.isArray(product.attributePrices) || !Array.isArray(product.legacyBodyPrices) || !Array.isArray(product.dimensionPrices)) throw new Error('产品计价方式或列表无效')
    if (product.pricingMode === 'fixed') {
      if (product.fixedUnitPrice !== null) amount(product.fixedUnitPrice, '固定单价')
      if (product.basePrices.length || product.legacyBodyPrices.length || product.dimensionPrices.length) throw new Error('固定单价不能同时配置尺寸或组合价表')
    } else if (product.fixedUnitPrice !== null) throw new Error('非固定计价必须将固定单价设为空值')
    if (product.pricingMode === 'table' && product.dimensionPrices.length || product.pricingMode === 'standee' && (product.basePrices.length || product.attributePrices.length || product.legacyBodyPrices.length)) throw new Error('价表内容与计价方式不一致')
    const baseKeys = new Set<string>(); const attributeKeys = new Set<string>()
    for (const row of product.basePrices) {
      if (!record(row)) throw new Error('主体基本价格式错误')
      keys(row, ['basePriceId', 'sizeBandId', 'unitPrice'], '主体基本价'); uniqueId(row.basePriceId, rowIds, '价格行')
      if (!validId(row.sizeBandId)) throw new Error('主体基本价尺寸引用无效')
      amount(row.unitPrice, '主体基本价')
      if (baseKeys.has(row.sizeBandId)) throw new Error('同一尺寸的主体基本价不能重复')
      baseKeys.add(row.sizeBandId)
    }
    for (const row of product.attributePrices) {
      if (!record(row)) throw new Error('属性价格行格式错误')
      keys(row, ['attributePriceId', ...selectionFields, 'sizeBandId', 'unitPrice'], '属性价格行'); uniqueId(row.attributePriceId, rowIds, '价格行'); selections(row)
      if (value.schemaVersion === 5 && (row.techniqueId !== null || row.holoFilmId !== null)) throw new Error('工艺和全息膜必须配置在公共价格中，产品内只保留材质加价')
      if (selectionFields.filter(field => row[field] !== null).length !== 1) throw new Error('属性价格必须且只能关联一个工艺、全息膜或材质')
      if (product.pricingMode === 'table' ? !validId(row.sizeBandId) : product.pricingMode !== 'fixed' || row.sizeBandId !== null) throw new Error('属性价格尺寸与产品计价方式不一致')
      if (!isAttributePrice(row.unitPrice)) throw new Error('属性价格须为十进制金额，整数最多9位、小数最多18位')
      const key = JSON.stringify([...selectionFields.map(field => row[field]), row.sizeBandId])
      if (attributeKeys.has(key)) throw new Error('同一属性与尺寸的价格不能重复')
      attributeKeys.add(key)
    }
    const bodyKeys = new Set<string>(); const dimensionKeys = new Set<string>()
    for (const row of product.legacyBodyPrices) {
      if (!record(row)) throw new Error('主体价格行格式错误')
      keys(row, ['productPriceId', ...selectionFields, 'sizeBandId', 'unitPrice'], '主体价格行'); uniqueId(row.productPriceId, rowIds, '价格行'); selections(row)
      if (!validId(row.sizeBandId)) throw new Error('主体价尺寸档引用无效')
      amount(row.unitPrice, '主体价格')
      const key = JSON.stringify([...selectionFields.map(field => row[field]), row.sizeBandId])
      if (bodyKeys.has(key)) throw new Error('同一产品、工艺、全息膜、材质和尺寸的主体价不能重复')
      bodyKeys.add(key)
    }
    for (const row of product.dimensionPrices) {
      if (!record(row)) throw new Error('尺寸配方格式错误')
      keys(row, ['productPriceId', ...selectionFields, 'baseUnitPrice', 'panels'], '尺寸配方'); uniqueId(row.productPriceId, rowIds, '价格行'); selections(row); amount(row.baseUnitPrice, '配方基础价')
      const key = JSON.stringify(selectionFields.map(field => row[field]))
      if (dimensionKeys.has(key)) throw new Error('同一工艺、全息膜和材质的尺寸配方不能重复')
      dimensionKeys.add(key)
      if (!Array.isArray(row.panels) || !row.panels.length) throw new Error('尺寸配方至少需要一个面板')
      for (const panel of row.panels) {
        if (!record(panel)) throw new Error('尺寸面板格式错误')
        keys(panel, ['panelId', 'label', 'pieceBands', 'baseBands', 'baseAdjustment'], '尺寸面板'); uniqueId(panel.panelId, panelIds, '尺寸面板')
        if (!validId(panel.label) || !isAttributePrice(panel.baseAdjustment)) throw new Error('尺寸面板名称或底座调整金额无效')
        validateRanges(panel.pieceBands, rangeIds); validateRanges(panel.baseBands, rangeIds)
      }
    }
    if (Object.hasOwn(product, 'standeePricing')) {
      if (product.pricingMode !== 'standee') throw new Error('只有立牌产品可以配置立牌组成价格')
      validateStandeePricing(product.standeePricing, rowIds, panelIds, rangeIds)
    }
  }
}
type RangeLike = Pick<PriceRange, 'minMm' | 'maxMm' | 'kind' | 'amount' | 'coefficient'>
function signedRangeDelta(source: RangeLike, base: RangeLike, rangeId: string): SignedPriceRange {
  const kind = source.kind === 'fixed' && base.kind === 'fixed' ? 'fixed' : 'area'
  return {
    rangeId,
    minMm: source.minMm,
    maxMm: source.maxMm,
    kind,
    amount: subtractPrices(source.amount, base.amount),
    coefficient: kind === 'fixed' ? '0' : subtractPrices(source.coefficient, base.coefficient),
  }
}
function signedBandDelta(source: RangeLike[], base: RangeLike[], prefix: string): SignedPriceRange[] {
  if (source.length !== base.length || source.some((range, index) => range.minMm !== base[index].minMm || range.maxMm !== base[index].maxMm)) throw new Error('立牌组成区间边界不一致，需保留旧组合配方')
  return source.map((range, index) => signedRangeDelta(range, base[index], `${prefix}-${index + 1}`))
}
function signedBand(source: PriceRange, rangeId: string): SignedPriceRange {
  return { ...source, rangeId }
}
function componentSignature(component: StandeePriceComponent): string {
  return JSON.stringify([component.panelTemplateId, component.kind, component.techniqueId, component.holoFilmId, component.materialId, component.pieceBands, component.baseBands, component.baseAdjustment])
}
function aggregateBands(panels: DimensionPanel[], field: 'pieceBands' | 'baseBands', prefix: string): SignedPriceRange[] {
  if (!panels.length) throw new Error('立牌基础组成至少需要一个面板')
  let result = panels[0][field].map((range, index) => signedBand(range, `${prefix}-${index + 1}`))
  for (const panel of panels.slice(1)) {
    if (panel[field].length !== result.length || panel[field].some((range, index) => range.minMm !== result[index].minMm || range.maxMm !== result[index].maxMm)) throw new Error('立牌组成区间边界不一致，需保留旧组合配方')
    result = result.map((range, index) => {
      const other = panel[field][index]; const kind = range.kind === 'fixed' && other.kind === 'fixed' ? 'fixed' : 'area'
      return { ...range, rangeId: `${prefix}-${index + 1}`, kind, amount: addSigned(range.amount, other.amount), coefficient: kind === 'fixed' ? '0' : addSigned(range.coefficient, other.coefficient) }
    })
  }
  return result
}
function aggregatePanels(panels: DimensionPanel[], field: 'pieceBands' | 'baseBands'): SignedPriceRange[] {
  return aggregateBands(panels, field, `standee-aggregate-${field}`)
}
function aggregateSignedBands(panels: DimensionPanel[], field: 'pieceBands' | 'baseBands'): SignedPriceRange[] {
  return aggregatePanels(panels, field)
}
function addSigned(left: string, right: string): string {
  return format(add(parse(left), parse(right)))
}
/** Build the additive standee model from the existing dimension recipes. The
 * migration is deterministic and lossless for the current catalog: all
 * baseline legacy panels are aggregated into one product-level base component,
 * while single-attribute recipes are represented as signed adjustments.
 * Combinations with more than one changed attribute become composite
 * components so they remain exactly reproducible. */
export function buildStandeePricingModel(pricing: ProductPricing): StandeePricing | null {
  if (pricing.pricingMode !== 'standee' || !pricing.dimensionPrices.length) return null
  const baseline = pricing.dimensionPrices.find(row => row.techniqueId === 'G1' && (row.holoFilmId === 'M12' || row.holoFilmId === 'M1')) ?? pricing.dimensionPrices[0]
  const productPanelTemplateId = `standee-panel-${pricing.productId}`
  const baseComponents: StandeePriceComponent[] = [{
    componentId: `standee-base-${pricing.productId}`,
    panelTemplateId: productPanelTemplateId,
    kind: 'base', techniqueId: null, holoFilmId: null, materialId: null,
    pieceBands: aggregateBands(baseline.panels, 'pieceBands', `standee-base-${pricing.productId}-piece`),
    baseBands: aggregateBands(baseline.panels, 'baseBands', `standee-base-${pricing.productId}-base`),
    baseAdjustment: baseline.panels.map(panel => panel.baseAdjustment).reduce(addSigned),
  }]
  const techniqueComponents: StandeePriceComponent[] = []; const holoFilmComponents: StandeePriceComponent[] = []; const materialComponents: StandeePriceComponent[] = []; const compositeComponents: StandeePriceComponent[] = []
  const getOrCreate = (kind: StandeeComponentKind, value: string, sourcePanels: DimensionPanel[]): StandeePriceComponent => {
    const panelTemplateId = productPanelTemplateId
    const key = `${kind}:${value}:${panelTemplateId}`
    const collection = kind === 'technique' ? techniqueComponents : kind === 'holoFilm' ? holoFilmComponents : materialComponents
    const existing = collection.find(component => component.componentId === key)
    const component: StandeePriceComponent = {
      componentId: key, panelTemplateId, kind,
      techniqueId: kind === 'technique' ? value : null,
      holoFilmId: kind === 'holoFilm' ? value : null,
      materialId: kind === 'material' ? value : null,
      pieceBands: signedBandDelta(aggregatePanels(sourcePanels, 'pieceBands'), aggregateSignedBands(baseline.panels, 'pieceBands'), `${key}-piece`),
      baseBands: signedBandDelta(aggregatePanels(sourcePanels, 'baseBands'), aggregateSignedBands(baseline.panels, 'baseBands'), `${key}-base`),
      baseAdjustment: subtractPrices(sourcePanels.map(panel => panel.baseAdjustment).reduce(addSigned), baseComponents[0].baseAdjustment),
    }
    if (existing) {
      if (componentSignature(existing) !== componentSignature(component)) throw new Error(`立牌属性 ${value} 在产品 ${pricing.productId} 的不同组合中价格不一致，请保留旧组合配方`)
      return existing
    }
    collection.push(component); return component
  }
  const compositions: StandeeComposition[] = []
  for (const recipe of pricing.dimensionPrices) {
    const changed = selectionFields.filter(field => recipe[field] !== baseline[field])
    let componentIds = [baseComponents[0].componentId]
    const sourcePanels = recipe.panels
    const label = sourcePanels.map(panel => panel.label).join(' + ')
    if (changed.length === 1) {
      const field = changed[0]; const value = recipe[field]
      if (!value) throw new Error(`立牌组合 ${recipe.productPriceId} 的属性引用为空`)
      const component = getOrCreate(field === 'techniqueId' ? 'technique' : field === 'holoFilmId' ? 'holoFilm' : 'material', value, sourcePanels)
      componentIds = [...componentIds, component.componentId]
    } else if (changed.length > 1) {
      const componentId = `standee-composite-${pricing.productId}-${recipe.productPriceId}`
      const component: StandeePriceComponent = {
        componentId, panelTemplateId: productPanelTemplateId, kind: 'composite', techniqueId: recipe.techniqueId, holoFilmId: recipe.holoFilmId, materialId: recipe.materialId,
        pieceBands: signedBandDelta(aggregatePanels(sourcePanels, 'pieceBands'), aggregateSignedBands(baseline.panels, 'pieceBands'), `${componentId}-piece`),
        baseBands: signedBandDelta(aggregatePanels(sourcePanels, 'baseBands'), aggregateSignedBands(baseline.panels, 'baseBands'), `${componentId}-base`),
        baseAdjustment: subtractPrices(sourcePanels.map(panel => panel.baseAdjustment).reduce(addSigned), baseComponents[0].baseAdjustment),
      }
      if (!compositeComponents.some(item => item.componentId === componentId)) compositeComponents.push(component)
      componentIds = [...componentIds, componentId]
    }
    compositions.push({ compositionId: `standee-composition-${recipe.productPriceId}`, legacyProductPriceId: recipe.productPriceId, techniqueId: recipe.techniqueId, holoFilmId: recipe.holoFilmId, materialId: recipe.materialId, baseUnitPrice: recipe.baseUnitPrice, groups: [{ groupId: `standee-group-${recipe.productPriceId}`, panelTemplateId: productPanelTemplateId, label, componentIds }] })
  }
  return { schemaVersion: 1, baseComponents, techniqueComponents, holoFilmComponents, materialComponents, compositeComponents, compositions }
}
export function upgradeStandeePricing(document: ProductPricingDocument): ProductPricingDocument {
  const next = cloneDocument(document)
  for (const product of next.products) if (product.pricingMode === 'standee' && !product.standeePricing && product.dimensionPrices.length) product.standeePricing = buildStandeePricingModel(product) ?? undefined
  validateDocument(next)
  return next
}
function selectionIssues(value: PriceSelections, product: Product, bundle: Bundle): string[] {
  const issues: string[] = []
  for (const dimension of getPricingDimensions(bundle, product, value)) {
    if ((dimension.required ? !dimension.values.some(item => getEntityId(item) === value[dimension.field]) : value[dimension.field] !== null) || value[dimension.field] !== dimension.resolvedId) issues.push(`${dimension.label}已不存在、被禁用或与产品开关不符`)
  }
  return issues
}
/** The editor and quotes share the product's enabled attribute and value IDs. */
export function getPricingDimensions(bundle: Bundle, product: Product, value: PriceSelections, _otherSelections: Record<string, string> = {}) {
  return dimensions.map(dimension => {
    const enabled = active(product, dimension.option)
    const values = enabled ? catalogFor(bundle, product, dimension.option).values.filter(item => isEnabled(optionFor(product, dimension.option), item)) : []
    return { ...dimension, enabled, required: enabled, values, resolvedId: values.some(item => getEntityId(item) === value[dimension.field]) ? value[dimension.field] : null }
  })
}
/** Piece counts come from the selected entity's numeric value, never its label or ID. */
export function getStandeeQuantityOptions(bundle: Bundle, product: Product, _value: PriceSelections, otherSelections: Record<string, string> = {}) {
  const option = optionFor(product, 'Standee Quantity')
  const enabled = !!option && !option.deleted
  if (!enabled) return { enabled, values: [], defaultId: null }
  const catalog = catalogFor(bundle, product, 'Standee Quantity')
  const resolved = resolvePreview(bundle, product, otherSelections)
  const values = ordered(catalog.values).filter(item => isEnabled(option, item))
  const defaultId = values.some(item => getEntityId(item) === resolved.selections['Standee Quantity']) ? resolved.selections['Standee Quantity'] : null
  return { enabled, values, defaultId }
}
function attributeReferenceIssues(row: AttributePrice, product: Product, bundle: Bundle): string[] {
  return dimensions.flatMap(dimension => {
    const id = row[dimension.field]
    if (id === null) return []
    const option = optionFor(product, dimension.option)
    const value = catalogFor(bundle, product, dimension.option).values.find(value => getEntityId(value) === id)
    return !option || option.deleted || !value || !isEnabled(option, value) ? [`${dimension.label}已不存在、被禁用或与产品开关不符`] : []
  })
}
/** Migration uses exact subtraction rather than rounding component prices independently. */
export function subtractPrices(total: string, base: string): string {
  const value = parse(base)
  return format(add(parse(total), { ...value, coefficient: -value.coefficient }))
}
function validAccessoryReference(row: AccessoryPrice, bundle: Bundle): boolean {
  const style = bundle.catalogs['accessory-styles.json'].values.find(value => getEntityId(value) === row.accessoryStyleId)
  return !!style && (row.accessoryColorId === null || !!style.colors?.some(value => getEntityId(value) === row.accessoryColorId))
}
function validSharedAttributeReference(row: SharedAttributePrice, bundle: Bundle): boolean {
  const attribute = row.techniqueId !== null
    ? bundle.catalogs['techniques.json'].values.some(value => getEntityId(value) === row.techniqueId)
    : bundle.catalogs['holo-films.json'].values.some(value => getEntityId(value) === row.holoFilmId)
  return attribute && (row.sizeBandId === null || bundle.catalogs['sizes.json'].values.some(value => getEntityId(value) === row.sizeBandId))
}
function enabledSizeIds(bundle: Bundle, product: Product): Set<string> {
  const option = optionFor(product, 'Size')
  return new Set(option && !option.deleted ? catalogFor(bundle, product, 'Size').values.filter(value => isEnabled(option, value)).map(getEntityId) : [])
}
export function getReferenceIssues(document: ProductPricingDocument, bundle: Bundle): string[] {
  if (document.areaPricing) {
    try { validateAreaReferences(document.areaPricing, bundle); return [] }
    catch (failure) { return [String(failure).replace(/^Error: /, '')] }
  }
  const issues: string[] = []; const products = allProducts(bundle.main)
  for (const row of document.accessoryPrices) if (!validAccessoryReference(row, bundle)) issues.push(`公共配件价格 ${row.accessoryPriceId} 的样式已不存在或颜色不属于该样式`)
  for (const row of document.sharedAttributePrices ?? []) if (!validSharedAttributeReference(row, bundle)) issues.push(`公共属性价格 ${row.sharedAttributePriceId} 的属性或尺寸已不存在`)
  for (const pricing of document.products) {
    const product = products.find(product => product.productId === pricing.productId); const prefix = `产品 ${pricing.productId}`
    if (!product) { issues.push(`${prefix} 已不存在`); continue }
    const sizes = enabledSizeIds(bundle, product)
    for (const row of pricing.basePrices) if (!sizes.has(row.sizeBandId)) issues.push(`${prefix} 的基本价 ${row.basePriceId} 关联的尺寸档不存在或不属于该产品`)
    for (const row of pricing.attributePrices) {
      if (row.sizeBandId !== null && (!sizes.has(row.sizeBandId))) issues.push(`${prefix} 的属性价 ${row.attributePriceId} 关联的尺寸档不存在或不属于该产品`)
      for (const issue of attributeReferenceIssues(row, product, bundle)) issues.push(`${prefix} 的属性价 ${row.attributePriceId}：${issue}`)
    }
    for (const row of pricing.legacyBodyPrices) {
      if (!sizes.has(row.sizeBandId)) issues.push(`${prefix} 的主体价格 ${row.productPriceId} 关联的尺寸档不存在或不属于该产品`)
      for (const issue of selectionIssues(row, product, bundle)) issues.push(`${prefix} 的主体价格 ${row.productPriceId}：${issue}`)
    }
    for (const row of pricing.dimensionPrices) for (const issue of selectionIssues(row, product, bundle)) issues.push(`${prefix} 的尺寸配方 ${row.productPriceId}：${issue}`)
  }
  return [...new Set(issues)]
}
export function validateReferences(document: ProductPricingDocument, bundle: Bundle): void {
  validateDocument(document)
  const issues = getReferenceIssues(document, bundle)
  if (issues.length) throw new Error(issues.join('；'))
}
export function pruneInvalidReferences(document: ProductPricingDocument, bundle: Bundle): ProductPricingDocument {
  const next = cloneDocument(document); const products = allProducts(bundle.main)
  next.accessoryPrices = next.accessoryPrices.filter(row => validAccessoryReference(row, bundle))
  if (next.sharedAttributePrices) next.sharedAttributePrices = next.sharedAttributePrices.filter(row => validSharedAttributeReference(row, bundle))
  next.products = next.products.filter(pricing => products.some(product => product.productId === pricing.productId))
  for (const pricing of next.products) {
    const product = products.find(product => product.productId === pricing.productId)!
    const sizes = enabledSizeIds(bundle, product)
    pricing.basePrices = pricing.basePrices.filter(row => sizes.has(row.sizeBandId))
    pricing.attributePrices = pricing.attributePrices.filter(row => (row.sizeBandId === null || sizes.has(row.sizeBandId)) && !attributeReferenceIssues(row, product, bundle).length)
    pricing.legacyBodyPrices = pricing.legacyBodyPrices.filter(row => sizes.has(row.sizeBandId) && !selectionIssues(row, product, bundle).length)
    pricing.dimensionPrices = pricing.dimensionPrices.filter(row => !selectionIssues(row, product, bundle).length)
  }
  return next
}
export { upgradeV1, upgradeV2, upgradeV3, upgradeSharedAttributePrices, upgradePricingDocument } from './migration'
function rangePrice(bands: PriceRange[], size: Dimensions, label: string): Decimal {
  if (!size || !isUnitPrice(size.widthMm) || !isUnitPrice(size.heightMm)) throw new Error(`${label}宽高必须是大于零的十进制毫米尺寸`)
  const width = parse(size.widthMm); const height = parse(size.heightMm)
  if (compare(width, zero) <= 0 || compare(height, zero) <= 0) throw new Error(`${label}宽高必须大于零`)
  const longest = compare(width, height) >= 0 ? width : height
  const band = bands.find(band => compare(longest, parse(band.minMm)) >= 0 && compare(longest, parse(band.maxMm)) <= 0)
  if (!band) throw new Error(`${label}尺寸未配置价格（含区间空档或超出范围）`)
  return band.kind === 'fixed' ? parse(band.amount) : add(multiply(multiply(width, height), parse(band.coefficient)), parse(band.amount))
}
function signedRangePrice(bands: SignedPriceRange[], size: Dimensions, label: string): Decimal {
  if (!size || !isUnitPrice(size.widthMm) || !isUnitPrice(size.heightMm)) throw new Error(`${label}宽高必须是大于零的十进制毫米尺寸`)
  const width = parse(size.widthMm); const height = parse(size.heightMm)
  if (compare(width, zero) <= 0 || compare(height, zero) <= 0) throw new Error(`${label}宽高必须大于零`)
  const longest = compare(width, height) >= 0 ? width : height
  const band = bands.find(item => compare(longest, parse(item.minMm)) >= 0 && compare(longest, parse(item.maxMm)) <= 0)
  if (!band) throw new Error(`${label}尺寸未配置价格（含区间空档或超出范围）`)
  return band.kind === 'fixed' ? parse(band.amount) : add(multiply(multiply(width, height), parse(band.coefficient)), parse(band.amount))
}
export function quoteProduct(document: ProductPricingDocument, bundle: Bundle, quantityPricing: QuantityPricingDocument, input: QuoteInput): QuoteResult {
  validateDocument(document); validateQuantityDocument(quantityPricing)
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new Error('购买数量必须是大于零的整数')
  const product = allProducts(bundle.main).find(product => product.productId === input.productId); const pricing = document.products.find(product => product.productId === input.productId)
  if (!product) throw new Error('产品已不存在，请重新选择')
  if (!pricing) throw new Error('该产品尚未配置价格')
  const selectedShared = document.sharedAttributePrices?.filter(row => pricing.pricingMode !== 'standee' && row.sizeBandId === (pricing.pricingMode === 'table' ? input.sizeBandId : null) && (row.techniqueId !== null && row.techniqueId === input.techniqueId || row.holoFilmId !== null && row.holoFilmId === input.holoFilmId))
  validateReferences({ ...document, products: [pricing], accessoryPrices: [], ...(selectedShared ? { sharedAttributePrices: selectedShared } : {}) }, bundle)
  const unsupported = product.productOptions.filter(option => !option.deleted && !['Print Option', 'Technique', 'Holo Film', 'Material', 'Accessories Style', 'Standee Quantity', 'Size'].includes(option.name))
  if (unsupported.length) throw new Error(`当前定价尚不支持这些已启用选项：${unsupported.map(option => option.labelZh || option.name).join('、')}`)
  const selected: PriceSelections = { techniqueId: input.techniqueId, holoFilmId: input.holoFilmId ?? null, materialId: input.materialId ?? null }
  if (active(product, 'Size')) {
    if (!getProductSizes(bundle, product).some(size => getEntityId(size) === input.sizeBandId)) throw new Error('请选择属于当前产品的有效尺寸档，所选尺寸可能已关闭或删除')
  } else {
    if (input.sizeBandId) throw new Error('该产品未开启尺寸选项，请清空尺寸选择')
    if (pricing.pricingMode === 'table') throw new Error('该产品尚未开启尺寸选项，请先在产品选项配置中设置尺寸')
  }
  for (const dimension of getPricingDimensions(bundle, product, selected)) {
    if (dimension.required ? !selected[dimension.field] : selected[dimension.field] !== null) throw new Error(dimension.required ? `请选择${dimension.label}` : `该产品未启用${dimension.label}，请清空选择`)
    if (selected[dimension.field] && !dimension.values.some(value => getEntityId(value) === selected[dimension.field])) throw new Error(`所选${dimension.label}已失效或被禁用`)
  }
  const accessoryOption = optionFor(product, 'Accessories Style')
  const hasAccessories = active(product, 'Accessories Style')
  const enabledAccessories = hasAccessories ? catalogFor(bundle, product, 'Accessories Style').values.filter(value => isEnabled(accessoryOption, value)) : []
  if (hasAccessories ? !input.accessoryStyleId : input.accessoryStyleId !== null || input.accessoryColorId !== null) throw new Error(hasAccessories ? '请选择配件样式' : '该产品未启用配件，请清空配件选择')
  const accessoryStyle = enabledAccessories.find(value => getEntityId(value) === input.accessoryStyleId)
  if (input.accessoryStyleId && !accessoryStyle) throw new Error('所选配件样式已失效或被禁用')
  if (input.accessoryColorId && !accessoryStyle?.colors?.some(value => getEntityId(value) === input.accessoryColorId && isEnabled(accessoryOption, value))) throw new Error('所选配件颜色不属于该样式或被禁用')
  const pieceCount = (id: string | null | undefined): number => {
    const options = getStandeeQuantityOptions(bundle, product, selected, { 'Standee Quantity': id ?? '' })
    if (!options.enabled) {
      if (id != null) throw new Error('该产品未启用主体片数，请清空片数选择')
      return 1
    }
    if (!id) throw new Error('请选择主体片数')
    const value = options.values.find(value => getEntityId(value) === id)
    if (!value) throw new Error('所选主体片数已失效或被禁用')
    if (!Number.isInteger(value.pieceCount) || value.pieceCount! < 1 || value.pieceCount! > 4) throw new Error('主体片数配置无效，必须为 1、2、3、4 片')
    return value.pieceCount!
  }
  if (pricing.pricingMode !== 'standee' && pieceCount(input.standeeQuantityId) !== 1) throw new Error('该产品尚未配置多片尺寸配方，请先在主体价格中设置片材和底座计价')
  if (pricing.pricingMode === 'standee' && input.standeeQuantityId != null) throw new Error('请在各尺寸面板中选择主体片数')
  let body: Decimal
  if (pricing.pricingMode === 'fixed') {
    if (pricing.fixedUnitPrice === null) throw new Error('该产品尚未配置固定单价')
    body = parse(pricing.fixedUnitPrice)
  } else if (pricing.pricingMode === 'table') {
    if (pricing.legacyBodyPrices.some(row => row.sizeBandId === input.sizeBandId && selectionKey(row) === selectionKey(selected))) throw new Error('该组合保留了待拆分的旧价格，请先确认基本价和属性价格')
    const row = pricing.basePrices.find(row => row.sizeBandId === input.sizeBandId)
    if (!row) throw new Error('该尺寸未配置主体基本价')
    body = parse(row.unitPrice)
  } else {
    const model = pricing.standeePricing
    const composition = model?.compositions.find(row => selectionKey(row) === selectionKey(selected))
    // The new flat model is opt-in through `standee`; existing panelInputs
    // intentionally stay on the legacy path so edits to the legacy dialog can
    // be previewed without a stale migrated snapshot.
    const modelInput = input.standee
    if (composition && modelInput && model) {
      if (!Array.isArray(modelInput.parts) || !modelInput.parts.length) throw new Error('立牌主体至少需要一片部件')
      const count = pieceCount(modelInput.standeeQuantityId)
      if (modelInput.parts.length !== count) throw new Error(`立牌片材尺寸数量必须与主体片数一致（${count} 片）`)
      const components = new Map<string, StandeePriceComponent>([...(model.baseComponents ?? []), ...(model.techniqueComponents ?? []), ...(model.holoFilmComponents ?? []), ...(model.materialComponents ?? []), ...(model.compositeComponents ?? [])].map(component => [component.componentId, component]))
      body = parse(composition.baseUnitPrice)
      for (const group of composition.groups) for (const componentId of group.componentIds) {
        const component = components.get(componentId); if (!component) throw new Error('立牌组成引用已失效，请回退到旧配方')
        for (const size of modelInput.parts) body = add(body, signedRangePrice(component.pieceBands, size, `${group.label}部件`))
        body = add(body, signedRangePrice(component.baseBands, modelInput.base, `${group.label}底座`)); body = add(body, parse(component.baseAdjustment))
      }
    } else {
      const recipe = pricing.dimensionPrices.find(row => selectionKey(row) === selectionKey(selected))
      if (!recipe) throw new Error('该工艺、全息膜和材质组合未配置尺寸配方')
      if (!Array.isArray(input.panelInputs) || input.panelInputs.length !== recipe.panels.length || new Set(input.panelInputs.map(panel => panel.panelId)).size !== recipe.panels.length || input.panelInputs.some(panel => !recipe.panels.some(recipePanel => recipePanel.panelId === panel.panelId))) throw new Error('请完整填写配方中的所有尺寸面板，不能缺少、重复或增加面板')
      body = parse(recipe.baseUnitPrice)
      for (const panel of recipe.panels) {
        const selectedPanel = input.panelInputs.find(item => item.panelId === panel.panelId)!
        if (!Array.isArray(selectedPanel.parts) || !selectedPanel.parts.length) throw new Error(`${panel.label}至少需要一片部件`)
        const count = pieceCount(selectedPanel.standeeQuantityId)
        if (selectedPanel.parts.length !== count) throw new Error(`${panel.label}的片材尺寸数量必须与主体片数一致（${count} 片）`)
        for (const size of selectedPanel.parts) body = add(body, rangePrice(panel.pieceBands, size, `${panel.label}部件`))
        body = add(body, rangePrice(panel.baseBands, selectedPanel.base, `${panel.label}底座`)); body = add(body, parse(panel.baseAdjustment))
      }
    }
    if (body.coefficient < 0n) throw new Error('尺寸配方产生了负主体价格，请检查底座调整')
  }
  const attributeAmounts: Record<keyof PriceSelections, Decimal> = { techniqueId: zero, holoFilmId: zero, materialId: zero }
  if (pricing.pricingMode !== 'standee') for (const dimension of dimensions) {
    if (selected[dimension.field] === null) continue
    const field = dimension.field
    const sizeBandId = pricing.pricingMode === 'table' ? input.sizeBandId : null
    const row = document.schemaVersion === 5 && field !== 'materialId'
      ? document.sharedAttributePrices!.find(row => row[field] === selected[field] && row.sizeBandId === sizeBandId)
      : pricing.attributePrices.find(row => row[field] === selected[field] && row.sizeBandId === sizeBandId)
    if (!row) throw new Error(`所选${dimension.label}未配置属性价格，免费也需明确填写0`)
    attributeAmounts[dimension.field] = parse(row.unitPrice)
  }
  const attributes = selectionFields.reduce((sum, field) => add(sum, attributeAmounts[field]), zero)
  const combinedBody = add(body, attributes)
  if (combinedBody.coefficient < 0n) throw new Error('基本价与属性价格合计不能为负数')
  let accessoryPrice = '0'
  if (hasAccessories) {
    if (document.accessoryPricing === 'color' && !input.accessoryColorId) throw new Error('请选择配件颜色')
    const accessory = document.accessoryPrices.find(row => row.accessoryStyleId === input.accessoryStyleId && row.accessoryColorId === (document.accessoryPricing === 'color' ? input.accessoryColorId : null))
    if (!accessory || !validAccessoryReference(accessory, bundle)) throw new Error('所选配件尚未配置有效的公共价格')
    accessoryPrice = accessory.unitPrice
  }
  const unit = add(combinedBody, parse(accessoryPrice)); const category = bundle.main.categories.find(category => category.products.some(product => product.productId === input.productId))
  const tiers = quantityPricing.categoryRules.find(rule => rule.categoryId === category?.name)?.tiers ?? []
  const tier = matchQuantityTier(tiers, input.quantity); const discountPercent = tier?.discountPercent ?? 0
  const discounted = { coefficient: unit.coefficient * BigInt(10000 - Math.round(discountPercent * 100)), scale: unit.scale + 4 }
  const total = { coefficient: discounted.coefficient * BigInt(input.quantity), scale: discounted.scale }
  return { bodyUnitPrice: format(body), techniqueUnitPrice: format(attributeAmounts.techniqueId), holoFilmUnitPrice: format(attributeAmounts.holoFilmId), materialUnitPrice: format(attributeAmounts.materialId), attributeUnitPrice: format(attributes), accessoryUnitPrice: accessoryPrice, unitPrice: format(unit), discountPercent, discountedUnitPrice: format(discounted), totalPrice: cents(total), quantityTierId: tier?.quantityTierId ?? null }
}
