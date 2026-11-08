import bases from './data/migration-bases.json'
import { allProducts, catalogFor, getEntityId, isEnabled, optionFor, type Bundle } from '../product-options/model'
import { initialBundle as defaultOptionBundle } from '../product-options/service'
import { cloneDocument, isUnitPrice, subtractPrices, upgradeStandeePricing, validateDocument, type BodyPrice, type ProductPricingDocument, type SharedAttributePrice } from './model'

const fields = ['techniqueId', 'holoFilmId', 'materialId'] as const
const dimensions = [{ field: 'techniqueId', option: 'Technique' }, { field: 'holoFilmId', option: 'Holo Film' }, { field: 'materialId', option: 'Material' }] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.trim() === value
function keys(value: Record<string, unknown>, expected: string[], label: string) {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error(`${label}字段无效`)
}
function reserve(id: string, occupied: Set<string>): string {
  if (!occupied.has(id)) { occupied.add(id); return id }
  let index = 1
  while (occupied.has(`migrated-${id}-${index}`)) index++
  const result = `migrated-${id}-${index}`; occupied.add(result); return result
}
function rowIds(document: ProductPricingDocument): Set<string> {
  return new Set([
    ...document.accessoryPrices.map(row => row.accessoryPriceId),
    ...document.products.flatMap(product => [...product.basePrices.map(row => row.basePriceId), ...product.attributePrices.map(row => row.attributePriceId), ...product.legacyBodyPrices.map(row => row.productPriceId), ...product.dimensionPrices.map(row => row.productPriceId)]),
  ])
}

/** Product options own size membership from v4; monetary rows keep their stable size references. */
export function upgradeV3(value: unknown): ProductPricingDocument {
  if (record(value) && (value.schemaVersion === 4 || value.schemaVersion === 5)) { validateDocument(value); return cloneDocument(value) }
  if (!record(value)) throw new Error('旧产品定价格式错误')
  keys(value, ['schemaVersion', 'currency', 'sizeBands', 'accessoryPricing', 'accessoryPrices', 'products'], '旧产品定价')
  if (value.schemaVersion !== 3 || !Array.isArray(value.sizeBands) || !Array.isArray(value.products)) throw new Error('旧产品定价版本或尺寸列表无效')
  const ids = new Set<string>()
  for (const band of value.sizeBands) {
    if (!record(band)) throw new Error('旧尺寸档格式错误')
    keys(band, ['sizeBandId', 'label'], '旧尺寸档')
    if (!validId(band.sizeBandId) || ids.has(band.sizeBandId) || !validId(band.label)) throw new Error('旧尺寸档标识或名称无效')
    ids.add(band.sizeBandId)
  }
  const products = value.products.map(product => {
    if (!record(product)) throw new Error('旧产品价表格式错误')
    keys(product, ['productId', 'printPricing', 'pricingMode', 'fixedUnitPrice', 'sizeBandIds', 'basePrices', 'attributePrices', 'legacyBodyPrices', 'dimensionPrices'], '旧产品价表')
    if (!Array.isArray(product.sizeBandIds) || product.sizeBandIds.some(id => !validId(id)) || new Set(product.sizeBandIds).size !== product.sizeBandIds.length) throw new Error('旧产品尺寸标识无效')
    if (product.pricingMode !== 'table' && product.sizeBandIds.length) throw new Error('旧产品尺寸与计价方式不一致')
    const { sizeBandIds: _sizes, ...rest } = structuredClone(product)
    return rest
  })
  const { sizeBands: _sizes, ...rest } = structuredClone(value)
  const upgraded = { ...rest, schemaVersion: 4, products }
  validateDocument(upgraded)
  return upgraded
}

/** Old complete rows are first validated as inert evidence, then split only with an audited source basis. */
export function upgradeV2(value: unknown, defaults: ProductPricingDocument, bundle?: Bundle): ProductPricingDocument {
  validateDocument(defaults)
  if (record(value) && (value.schemaVersion === 3 || value.schemaVersion === 4 || value.schemaVersion === 5)) return upgradeV3(value)
  if (!record(value)) throw new Error('旧产品定价格式错误')
  keys(value, ['schemaVersion', 'currency', 'sizeBands', 'accessoryPricing', 'accessoryPrices', 'products'], '旧产品定价')
  if (value.schemaVersion !== 2 || !Array.isArray(value.products)) throw new Error('旧产品定价版本或列表无效')
  const staged = upgradeV3({
    ...structuredClone(value), schemaVersion: 3,
    products: value.products.map(product => {
      if (!record(product)) throw new Error('旧产品价表格式错误')
      keys(product, ['productId', 'printPricing', 'pricingMode', 'fixedUnitPrice', 'sizeBandIds', 'bodyPrices', 'dimensionPrices'], '旧产品价表')
      const { bodyPrices, ...rest } = structuredClone(product)
      return { ...rest, basePrices: [], attributePrices: [], legacyBodyPrices: bodyPrices }
    }),
  })
  const occupied = rowIds(staged)
  for (const product of staged.products) {
    if (product.pricingMode === 'table') {
      const source = bases.products.find(item => item.productId === product.productId)
      const pending: BodyPrice[] = []
      for (const row of product.legacyBodyPrices) {
        const basis = source?.basePrices.find(item => item.sizeBandId === row.sizeBandId)
        const count = fields.filter(field => row[field] !== null).length
        if (!basis || count > 1 || count === 0 && subtractPrices(row.unitPrice, basis.unitPrice) !== '0') { pending.push(row); continue }
        if (!product.basePrices.some(item => item.sizeBandId === row.sizeBandId)) product.basePrices.push({ ...basis, basePriceId: reserve(basis.basePriceId, occupied) })
        if (count === 1) product.attributePrices.push({ attributePriceId: row.productPriceId, techniqueId: row.techniqueId, holoFilmId: row.holoFilmId, materialId: row.materialId, sizeBandId: row.sizeBandId, unitPrice: subtractPrices(row.unitPrice, basis.unitPrice) })
      }
      product.legacyBodyPrices = pending
    } else if (product.pricingMode === 'fixed' && product.fixedUnitPrice !== null) {
      // v2 fixed quotes explicitly ignored active attributes. Preserve that policy only for a priced product.
      const options = bundle ?? defaultOptionBundle
      const optionProduct = allProducts(options.main).find(item => item.productId === product.productId)
      if (optionProduct) for (const dimension of dimensions) {
        const option = optionFor(optionProduct, dimension.option)
        if (!option || option.deleted) continue
        for (const value of catalogFor(options, optionProduct, dimension.option).values.filter(value => isEnabled(option, value))) {
          const entityId = getEntityId(value)
          product.attributePrices.push({ attributePriceId: reserve(`attribute-${product.productId}-${dimension.field}-${entityId}`, occupied), techniqueId: null, holoFilmId: null, materialId: null, [dimension.field]: entityId, sizeBandId: null, unitPrice: '0' })
        }
      }
      else if (!bundle) for (const row of defaults.products.find(item => item.productId === product.productId)?.attributePrices ?? []) {
        if (row.sizeBandId === null && subtractPrices(row.unitPrice, '0') === '0') product.attributePrices.push({ ...row, attributePriceId: reserve(row.attributePriceId, occupied) })
      }
    }
  }
  validateDocument(staged)
  return staged
}

/** Keep edited/deleted v1 cells and custom sizes; defaults add only wholly absent products. */
export function upgradeV1(value: unknown, defaults: ProductPricingDocument, bundle?: Bundle): ProductPricingDocument {
  validateDocument(defaults)
  if (record(value) && value.schemaVersion !== 1) return upgradeV2(value, defaults, bundle)
  if (!record(value)) throw new Error('旧产品定价格式错误')
  keys(value, ['schemaVersion', 'currency', 'sizeBands', 'products'], '旧产品定价')
  if (value.currency !== 'USD' || !Array.isArray(value.sizeBands) || !Array.isArray(value.products)) throw new Error('旧产品定价版本、币种或列表无效')
  const legacySizes = value.sizeBands
  const occupied = new Set<string>()
  const unique = (id: unknown) => { if (!validId(id) || occupied.has(id)) throw new Error('旧价格行标识为空或重复'); occupied.add(id) }
  const products = value.products.map(product => {
    if (!record(product)) throw new Error('旧产品价表格式错误')
    keys(product, ['productId', 'printPricing', 'bodyPrices', 'accessoryPricing', 'accessoryPrices'], '旧产品价表')
    if (!Array.isArray(product.bodyPrices) || !Array.isArray(product.accessoryPrices) || !['included', 'style', 'color'].includes(String(product.accessoryPricing))) throw new Error('旧产品计价方式或列表无效')
    const accessoryKeys = new Set<string>()
    for (const row of product.accessoryPrices) {
      if (!record(row)) throw new Error('旧配件价格行格式错误')
      keys(row, ['accessoryPriceId', 'accessoryStyleId', 'accessoryColorId', 'unitPrice'], '旧配件价格行'); unique(row.accessoryPriceId)
      if (!validId(row.accessoryStyleId) || row.accessoryColorId !== null && !validId(row.accessoryColorId) || !isUnitPrice(row.unitPrice)) throw new Error('旧配件价格无效')
      const key = JSON.stringify([row.accessoryStyleId, row.accessoryColorId])
      if (accessoryKeys.has(key)) throw new Error('旧配件价格不能重复')
      accessoryKeys.add(key)
      if (product.accessoryPricing === 'included' || product.accessoryPricing === 'style' && row.accessoryColorId !== null || product.accessoryPricing === 'color' && row.accessoryColorId === null) throw new Error('旧配件计价方式不一致')
    }
    const bodyPrices = product.bodyPrices.map(row => {
      if (!record(row)) throw new Error('旧主体价格行格式错误')
      keys(row, ['productPriceId', 'techniqueId', 'sizeBandId', 'unitPrice'], '旧主体价格行'); unique(row.productPriceId)
      return { ...row, holoFilmId: null, materialId: null }
    })
    return { productId: product.productId, printPricing: product.printPricing, pricingMode: 'table', fixedUnitPrice: null, sizeBandIds: legacySizes.map(band => record(band) ? band.sizeBandId : null), bodyPrices, dimensionPrices: [] }
  })
  const document = upgradeV2({ schemaVersion: 2, currency: value.currency, sizeBands: value.sizeBands, accessoryPricing: defaults.accessoryPricing, accessoryPrices: defaults.accessoryPrices.map(row => ({ ...row, accessoryPriceId: reserve(row.accessoryPriceId, occupied) })), products }, defaults, bundle)
  const currentIds = rowIds(document)
  for (const product of defaults.products) if (!document.products.some(item => item.productId === product.productId)) {
    const added = structuredClone(product)
    for (const row of added.basePrices) row.basePriceId = reserve(row.basePriceId, currentIds)
    for (const row of added.attributePrices) row.attributePriceId = reserve(row.attributePriceId, currentIds)
    for (const row of added.legacyBodyPrices) row.productPriceId = reserve(row.productPriceId, currentIds)
    for (const row of added.dimensionPrices) row.productPriceId = reserve(row.productPriceId, currentIds)
    if (defaults.schemaVersion === 5 && added.pricingMode !== 'standee') {
      // Only reconstruct defaults for wholly absent products. A known option
      // snapshot supplies membership; IDs and equal size labels cannot imply it.
      const options = bundle ?? defaultOptionBundle
      const optionProduct = allProducts(options.main).find(item => item.productId === added.productId)
      if (optionProduct) for (const row of defaults.sharedAttributePrices ?? []) {
        if (added.pricingMode === 'table' ? !added.basePrices.some(base => base.sizeBandId === row.sizeBandId) : row.sizeBandId !== null) continue
        const name = row.techniqueId !== null ? 'Technique' : 'Holo Film'
        const id = row.techniqueId ?? row.holoFilmId
        const option = optionFor(optionProduct, name)
        const value = catalogFor(options, optionProduct, name).values.find(value => getEntityId(value) === id)
        if (!option || option.deleted || !value || !isEnabled(option, value)) continue
        added.attributePrices.push({ attributePriceId: reserve(`${row.sharedAttributePriceId}-${added.productId}`, currentIds), techniqueId: row.techniqueId, holoFilmId: row.holoFilmId, materialId: null, sizeBandId: row.sizeBandId, unitPrice: row.unitPrice })
      }
    }
    document.products.push(added)
  }
  validateDocument(document)
  return document
}

/** Consolidate only an identical explicit attribute/size key; size labels never take part. */
export function upgradeSharedAttributePrices(document: ProductPricingDocument): ProductPricingDocument {
  validateDocument(document)
  const next = cloneDocument(document)
  if (next.schemaVersion === 5) return next
  const shared = new Map<string, { row: SharedAttributePrice; productId: string }>()
  for (const product of next.products) for (const row of product.attributePrices) {
    if (row.materialId !== null) continue
    const key = JSON.stringify([row.techniqueId, row.holoFilmId, row.sizeBandId])
    const previous = shared.get(key)
    if (previous) {
      // Legacy spreadsheet subtraction differs at ~1e-15. Compare exact decimals,
      // preserve the first source string, and reject real differences instead of guessing.
      const difference = subtractPrices(row.unitPrice, previous.row.unitPrice).replace(/^-/, '')
      const [whole, fraction = ''] = difference.split('.')
      const scaled = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
      if (scaled > 1_000_000n) throw new Error(`公共价格迁移冲突：${row.techniqueId ? `techniqueId=${row.techniqueId}` : `holoFilmId=${row.holoFilmId}`}，sizeBandId=${row.sizeBandId ?? '不区分尺寸'}，产品 ${previous.productId} (${previous.row.unitPrice}) 与 ${product.productId} (${row.unitPrice}) 金额不同`)
    } else shared.set(key, { productId: product.productId, row: { sharedAttributePriceId: row.attributePriceId, techniqueId: row.techniqueId, holoFilmId: row.holoFilmId, sizeBandId: row.sizeBandId, unitPrice: row.unitPrice } })
  }
  next.schemaVersion = 5
  next.sharedAttributePrices = [...shared.values()].map(value => value.row)
  for (const product of next.products) product.attributePrices = product.attributePrices.filter(row => row.materialId !== null)
  validateDocument(next)
  return next
}

export function upgradePricingDocument(value: unknown, defaults: ProductPricingDocument, bundle?: Bundle): ProductPricingDocument {
  return upgradeStandeePricing(upgradeSharedAttributePrices(upgradeV1(value, defaults, bundle)))
}
