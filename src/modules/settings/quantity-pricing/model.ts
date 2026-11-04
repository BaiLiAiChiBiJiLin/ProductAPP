export type QuantityTier = {
  quantityTierId: string
  minQty: number
  maxQty: number | null
  discountPercent: number
}

export type CategoryPricing = { categoryId: string; tiers: QuantityTier[] }
export type QuantityPricingDocument = { schemaVersion: 1; categoryRules: CategoryPricing[] }
export type PricingCategory = { categoryId: string; title: string; titleZh: string; productCount: number }
export type TierIssue = {
  quantityTierId: string
  field: 'minQty' | 'maxQty' | 'discountPercent' | 'range' | 'quantityTierId'
  message: string
}

export const cloneDocument = (document: QuantityPricingDocument): QuantityPricingDocument => structuredClone(document)

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim()
const validQuantity = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const validDiscount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function exactKeys(value: Record<string, unknown>, keys: string[], message: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(message)
}

export function getTierIssues(tiers: QuantityTier[]): TierIssue[] {
  const issues: TierIssue[] = []
  const add = (tier: QuantityTier, field: TierIssue['field'], message: string) => {
    if (!issues.some(issue => issue.quantityTierId === tier.quantityTierId && issue.field === field && issue.message === message)) {
      issues.push({ quantityTierId: tier.quantityTierId, field, message })
    }
  }
  const ids = new Set<string>()
  for (const tier of tiers) {
    if (!validId(tier.quantityTierId) || ids.has(tier.quantityTierId)) add(tier, 'quantityTierId', '阶梯标识不能为空或重复')
    ids.add(tier.quantityTierId)
    if (!validQuantity(tier.minQty)) add(tier, 'minQty', '起始数量必须是大于 0 的整数')
    if (tier.maxQty !== null && !validQuantity(tier.maxQty)) add(tier, 'maxQty', '截止数量必须是大于 0 的整数，或留空表示不限')
    if (validQuantity(tier.minQty) && validQuantity(tier.maxQty) && tier.maxQty < tier.minQty) add(tier, 'maxQty', '截止数量不能小于起始数量')
    if (!validDiscount(tier.discountPercent)) add(tier, 'discountPercent', '减价比例须为 0–100，最多保留两位小数')
  }
  const ranges = tiers.filter(tier => validQuantity(tier.minQty) && (tier.maxQty === null || validQuantity(tier.maxQty) && tier.maxQty >= tier.minQty)).slice().sort((a, b) => a.minQty - b.minQty)
  let covering: QuantityTier | undefined
  for (const tier of ranges) {
    if (covering && tier.minQty <= (covering.maxQty ?? Infinity)) {
      add(covering, 'range', '数量区间与其他阶梯重叠')
      add(tier, 'range', '数量区间与其他阶梯重叠')
    }
    if (!covering || (tier.maxQty ?? Infinity) > (covering.maxQty ?? Infinity)) covering = tier
  }
  return issues
}

export function validateDocument(value: unknown): asserts value is QuantityPricingDocument {
  if (!record(value)) throw new Error('价格阶梯配置必须是对象')
  exactKeys(value, ['schemaVersion', 'categoryRules'], '价格阶梯配置仅允许版本和大类阶梯')
  if (value.schemaVersion !== 1 || !Array.isArray(value.categoryRules)) throw new Error('价格阶梯配置版本或大类列表无效')
  const categoryIds = new Set<string>()
  const tierIds = new Set<string>()
  for (const rule of value.categoryRules) {
    if (!record(rule)) throw new Error('大类阶梯格式错误')
    exactKeys(rule, ['categoryId', 'tiers'], '大类阶梯仅允许 categoryId 和 tiers')
    if (!validId(rule.categoryId) || categoryIds.has(rule.categoryId) || !Array.isArray(rule.tiers)) throw new Error('大类关联标识无效、重复或缺少阶梯列表')
    categoryIds.add(rule.categoryId)
    for (const tier of rule.tiers) {
      if (!record(tier)) throw new Error('阶梯行格式错误')
      exactKeys(tier, ['quantityTierId', 'minQty', 'maxQty', 'discountPercent'], '阶梯行仅允许标识、数量范围和减价比例')
      if (!validId(tier.quantityTierId) || tierIds.has(tier.quantityTierId)) throw new Error('阶梯标识不能为空或重复')
      tierIds.add(tier.quantityTierId)
      if (!validQuantity(tier.minQty)) throw new Error(`${rule.categoryId}：起始数量必须是大于 0 的整数`)
      if (tier.maxQty !== null && !validQuantity(tier.maxQty)) throw new Error(`${rule.categoryId}：截止数量必须是正整数或空值`)
      if (typeof tier.maxQty === 'number' && tier.maxQty < tier.minQty) throw new Error(`${rule.categoryId}：截止数量不能小于起始数量`)
      if (!validDiscount(tier.discountPercent)) throw new Error(`${rule.categoryId}：减价比例须为 0–100，最多保留两位小数`)
    }
    // The row fields above establish the typed shape before checking interval relationships.
    const ranges = rule.tiers as QuantityTier[]
    const issues = getTierIssues(ranges)
    if (issues.length) throw new Error(`${rule.categoryId}：${issues[0].message}`)
  }
}

export function validateCategoryLinks(document: QuantityPricingDocument, categories: PricingCategory[]): void {
  validateDocument(document)
  const categoryIds = new Set(categories.map(category => category.categoryId))
  const missing = document.categoryRules.filter(rule => !categoryIds.has(rule.categoryId)).map(rule => rule.categoryId)
  if (missing.length) throw new Error(`以下产品大类已不存在，请移除失效关联：${missing.join('、')}`)
}

/** Quantity gaps and finite upper limits are explicit: no match means no discount. */
export function matchQuantityTier(tiers: QuantityTier[], quantity: number): QuantityTier | undefined {
  if (!validQuantity(quantity) || getTierIssues(tiers).length) return undefined
  return tiers.find(tier => quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty))
}
