import standeeQuantities from './data/standee-quantities.json'
import sizes from './data/sizes.json'
import sizeMigration from './data/size-migration.json'
import tinplateStickerFilms from './data/tinplate-sticker-films.json'
import tinplateMaterials from './data/tinplate-materials.json'

export const definitions = [
  { name: 'Size', title: '尺寸', file: 'sizes.json', prefix: 'S', idKey: 'sizeBandId' },
  { name: 'Print Option', title: '印刷选项', file: 'print-options.json', prefix: 'Y', idKey: 'printOptionId' },
  { name: 'Technique', title: '工艺', file: 'techniques.json', prefix: 'G', idKey: 'techniqueId' },
  { name: 'Holo Film', title: '全息膜', file: 'holo-films.json', prefix: 'M', idKey: 'holoFilmId' },
  { name: 'Tinplate Sticker Film', title: '马口铁/贴纸膜', file: 'tinplate-sticker-films.json', prefix: 'TF', idKey: 'tinplateStickerFilmId' },
  { name: 'Material', title: '材质', file: 'materials.json', prefix: 'C', idKey: 'materialId' },
  { name: 'Tinplate Material', title: '马口铁材质', file: 'tinplate-materials.json', prefix: 'TM', idKey: 'tinplateMaterialId' },
  { name: 'Accessories Style', title: '配件样式', file: 'accessory-styles.json', prefix: 'P', idKey: 'accessoryStyleId' },
  { name: 'Standee Quantity', title: '主体片数', file: 'standee-quantities.json', prefix: 'SQ', idKey: 'standeeQuantityId' },
] as const

export const identityKeys = ['sizeBandId', 'printOptionId', 'techniqueId', 'holoFilmId', 'tinplateStickerFilmId', 'materialId', 'tinplateMaterialId', 'accessoryStyleId', 'accessoryColorId', 'standeeQuantityId', 'customOptionValueId'] as const
export type EntityKey = typeof identityKeys[number]
export type EntityReference = { [K in EntityKey]: { [P in K]: string } & Partial<Record<Exclude<EntityKey, K>, never>> }[EntityKey]
export type OptionValue = EntityReference & { name: string; labelZh?: string; image?: string; isDefault?: boolean; sortOrder: number; colors?: OptionValue[]; pieceCount?: number }
export type Catalog = { name: string; label?: string; labelZh: string; defaultValue?: EntityReference; values: OptionValue[]; nextId: number; nextColorId?: number }
export type ProductOption = { name: string; deleted: boolean; disabledValues?: EntityReference[]; label?: string; labelZh?: string; defaultValue?: EntityReference; values?: OptionValue[]; nextId?: number }
export type Product = { productId: string; title: string; titleZh: string; productOptions: ProductOption[] }
export type Category = { name: string; title: string; titleZh: string; products: Product[] }
export type ProductDocument = { categories: Category[]; uncategorizedProducts: Product[]; nextProductId: number }
export type Bundle = { main: ProductDocument; catalogs: Record<string, Catalog> }
export type Location = { category: number; product: number }
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const display = (value: { name?: string; labelZh?: string; title?: string; titleZh?: string }) => value.titleZh || value.labelZh || value.title || value.name || '未命名'

// Identity comes from the field, never from a prefix shared by different entities.
export function getEntityKey(value: EntityReference): EntityKey {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'id' in value || 'productId' in value) throw new Error('选项 ID 必须明确所属实体，不能使用通用 id')
  const keys = identityKeys.filter(key => Object.hasOwn(value, key))
  if (keys.length !== 1 || typeof value[keys[0]] !== 'string' || !value[keys[0]]) throw new Error('选项记录必须且只能包含一个所属实体 ID')
  return keys[0]
}
export function getEntityId(value: EntityReference): string { return value[getEntityKey(value)]! }
function makeReference(key: EntityKey, id: string): EntityReference {
  switch (key) {
    case 'sizeBandId': return { sizeBandId: id }
    case 'printOptionId': return { printOptionId: id }
    case 'techniqueId': return { techniqueId: id }
    case 'holoFilmId': return { holoFilmId: id }
    case 'tinplateStickerFilmId': return { tinplateStickerFilmId: id }
    case 'materialId': return { materialId: id }
    case 'tinplateMaterialId': return { tinplateMaterialId: id }
    case 'accessoryStyleId': return { accessoryStyleId: id }
    case 'accessoryColorId': return { accessoryColorId: id }
    case 'standeeQuantityId': return { standeeQuantityId: id }
    case 'customOptionValueId': return { customOptionValueId: id }
  }
}
export function entityReference(value: EntityReference): EntityReference { return makeReference(getEntityKey(value), getEntityId(value)) }
export function sameEntity(left: EntityReference | undefined, right: EntityReference | undefined): boolean {
  return !!left && !!right && getEntityKey(left) === getEntityKey(right) && getEntityId(left) === getEntityId(right)
}
const referenceKey = (value: EntityReference) => `${getEntityKey(value)}:${getEntityId(value)}`
const validateReference = (value: EntityReference) => {
  getEntityKey(value)
  if (Object.keys(value).length !== 1) throw new Error('实体引用只能包含对应的 ID 字段')
}
export const valueLabel = (value: OptionValue, peers: OptionValue[]) => getEntityKey(value) !== 'holoFilmId' && peers.some(peer => !sameEntity(peer, value) && display(peer) === display(value)) ? `${display(value)}（${getEntityId(value)}）` : display(value)
export const ordered = (values: OptionValue[]) => [...values].sort((a, b) => a.sortOrder - b.sortOrder)
export function productList(main: ProductDocument, category: number) { return category < 0 ? main.uncategorizedProducts : main.categories[category]?.products ?? [] }
export function allProducts(main: ProductDocument) { return [...main.categories.flatMap(category => category.products), ...main.uncategorizedProducts] }
/** Retired rule payloads are discarded at storage/import boundaries, including malformed old rules. */
export function stripDeprecatedOptionRules(bundle: Bundle): Bundle {
  if (!bundle?.main || !Array.isArray(bundle.main.categories) || !Array.isArray(bundle.main.uncategorizedProducts) || !bundle.catalogs) throw new Error('配置格式错误：需要产品类别、未归类产品和公共选项数据')
  const cleaned = clone(bundle)
  for (const product of allProducts(cleaned.main)) if (product && typeof product === 'object') Reflect.deleteProperty(product, 'optionRules')
  return cleaned
}
export function locations(main: ProductDocument, filter: number): Location[] {
  return [...main.categories.flatMap((category, index) => category.products.map((_, product) => ({ category: index, product }))), ...main.uncategorizedProducts.map((_, product) => ({ category: -1, product }))].filter(location => filter === -2 || location.category === filter)
}
export function getProduct(main: ProductDocument, location?: Location) { return location ? productList(main, location.category)[location.product] : undefined }
export function optionFor(product: Product, name: string) { return product.productOptions.find(option => option.name === name) }
export function isEnabled(option: ProductOption | undefined, value: EntityReference) { return !option?.disabledValues?.some(disabled => sameEntity(disabled, value)) }
export function setEnabled(option: ProductOption, value: EntityReference, enabled: boolean) {
  const values = (option.disabledValues ?? []).filter(disabled => !sameEntity(disabled, value))
  if (!enabled) values.push(entityReference(value))
  if (values.length) option.disabledValues = values; else delete option.disabledValues
}
function newStandeeQuantityOption(enabled: boolean, catalog: Catalog): ProductOption {
  const option: ProductOption = { name: 'Standee Quantity', deleted: !enabled }
  if (catalog.values?.some(value => value.standeeQuantityId === 'SQ1')) option.defaultValue = { standeeQuantityId: 'SQ1' }
  return option
}
export function makeProduct(main: ProductDocument, categoryName?: string, standeeCatalog: Catalog = standeeQuantities, sizeCatalog: Catalog = sizes): Product { return { productId: `P${main.nextProductId++}`, title: 'New Product', titleZh: '新产品', productOptions: definitions.map(({ name }) => name === 'Standee Quantity' ? newStandeeQuantityOption(categoryName === 'standees', standeeCatalog) : name === 'Size' ? { name, deleted: true, disabledValues: sizeCatalog.values.map(entityReference) } : { name, deleted: true }) } }

/** Add only missing shared catalogs and product switches; existing edits stay authoritative. */
export function upgradeAdditionalAttributeBundle(bundle: Bundle): Bundle {
  const upgraded = stripDeprecatedOptionRules(bundle)
  const additions = [
    { file: 'tinplate-sticker-films.json', catalog: tinplateStickerFilms },
    { file: 'tinplate-materials.json', catalog: tinplateMaterials },
  ]
  for (const { file, catalog } of additions) if (!Object.hasOwn(upgraded.catalogs, file)) upgraded.catalogs[file] = clone(catalog)
  for (const product of allProducts(upgraded.main)) {
    if (!product || !Array.isArray(product.productOptions)) throw new Error('产品数据格式错误')
    for (const { catalog } of additions) {
      if (optionFor(product, catalog.name)) continue
      product.productOptions.push({ name: catalog.name, deleted: true })
    }
  }
  return upgraded
}

export type ProductSizeSource = { schemaVersion?: number; sizeBands?: { sizeBandId: string; label: string }[]; products?: { productId: string; sizeBandIds?: string[] }[] }
/** Migrate only missing dimensions; configured switches and shared values remain authoritative. */
export function upgradeProductSizeBundle(bundle: Bundle, source?: ProductSizeSource): Bundle {
  if (!bundle?.main || !Array.isArray(bundle.main.categories) || !Array.isArray(bundle.main.uncategorizedProducts) || !bundle.catalogs) throw new Error('配置格式错误：需要产品类别、未归类产品和公共选项数据')
  const upgraded = upgradeAdditionalAttributeBundle(bundle)
  const bands = new Map(sizeMigration.sizeBands.map(size => [size.sizeBandId, size]))
  const sourceProducts = new Map(sizeMigration.products.map(product => [product.productId, new Set(product.sizeBandIds)]))
  if (Array.isArray(source?.sizeBands) && Array.isArray(source?.products)) {
    for (const size of source.sizeBands) bands.set(size.sizeBandId, size)
    for (const product of source.products) sourceProducts.set(product.productId, new Set(source.schemaVersion === 1 ? source.sizeBands.map(size => size.sizeBandId) : product.sizeBandIds ?? []))
  }
  if (!Object.hasOwn(upgraded.catalogs, 'sizes.json')) {
    const values: OptionValue[] = [...bands.values()].map((size, index) => ({ sizeBandId: size.sizeBandId, name: size.label, labelZh: size.label, isDefault: false, sortOrder: index + 1 }))
    const nextId = Math.max(0, ...values.flatMap(value => /^S[1-9][0-9]*$/.test(value.sizeBandId!) ? [Number(value.sizeBandId!.slice(1))] : [])) + 1
    upgraded.catalogs['sizes.json'] = { name: 'Size', label: 'Size', labelZh: '尺寸', values, nextId }
  }
  const catalog = upgraded.catalogs['sizes.json']
  for (const product of allProducts(upgraded.main)) {
    if (!product || !Array.isArray(product.productOptions)) throw new Error('产品数据格式错误')
    if (optionFor(product, 'Size')) continue
    const allowed = sourceProducts.get(product.productId) ?? new Set<string>()
    const enabled = catalog.values.some(value => allowed.has(getEntityId(value)))
    product.productOptions.unshift({ name: 'Size', deleted: !enabled, disabledValues: catalog.values.filter(value => !allowed.has(getEntityId(value))).map(entityReference) })
  }
  return upgraded
}

export function getProductSizes(bundle: Bundle, product: Product, _requested: Record<string, string> = {}): OptionValue[] {
  const option = optionFor(product, 'Size')
  if (!option || option.deleted) return []
  return ordered(catalogFor(bundle, product, 'Size').values).filter(value => isEnabled(option, value))
}

/** Add only the new catalog and missing switches; existing user choices are authoritative. */
export function upgradeStandeeQuantityBundle(bundle: Bundle): Bundle {
  if (!bundle?.main || !Array.isArray(bundle.main.categories) || !Array.isArray(bundle.main.uncategorizedProducts) || !bundle.catalogs) throw new Error('配置格式错误：需要产品类别、未归类产品和公共选项数据')
  const upgraded = stripDeprecatedOptionRules(bundle)
  if (!Object.hasOwn(upgraded.catalogs, 'standee-quantities.json')) upgraded.catalogs['standee-quantities.json'] = clone(standeeQuantities)
  const append = (product: Product, enabled: boolean) => {
    if (!product || !Array.isArray(product.productOptions)) throw new Error('产品数据格式错误')
    if (!optionFor(product, 'Standee Quantity')) product.productOptions.push(newStandeeQuantityOption(enabled, upgraded.catalogs['standee-quantities.json']))
  }
  for (const category of upgraded.main.categories) {
    if (!category || !Array.isArray(category.products)) throw new Error('产品类别名称重复或格式错误')
    for (const product of category.products) append(product, category.name === 'standees')
  }
  for (const product of upgraded.main.uncategorizedProducts) append(product, false)
  return upgraded
}

/** Names and IDs may change independently of the physical piece count. */
export function getStandeePieceCount(bundle: Bundle, reference: EntityReference | undefined): number | undefined {
  if (!reference || getEntityKey(reference) !== 'standeeQuantityId') return undefined
  const value = bundle.catalogs['standee-quantities.json']?.values.find(value => sameEntity(value, reference))
  return value && Number.isSafeInteger(value.pieceCount) && value.pieceCount! >= 1 && value.pieceCount! <= 4 ? value.pieceCount : undefined
}
export function catalogFor(bundle: Bundle, product: Product, name: string): Catalog {
  const definition = definitions.find(item => item.name === name)
  return (definition ? bundle.catalogs[definition.file] : optionFor(product, name)) as Catalog
}
export const flattenedValues = (catalog: Catalog) => catalog.values.flatMap(value => [value, ...(value.colors ?? [])])
// UI choices are scoped by the explicit option key. Returned selectedValues are
// typed entity references for consumers outside the select controls.
// Each option is independent; invalid or disabled choices are cleared locally.
export function resolvePreview(bundle: Bundle, product: Product, requested: Record<string, string>) {
  const selections = { ...requested }
  const roots = product.productOptions.map(option => ({ option, catalog: catalogFor(bundle, product, option.name) }))
  for (const { option, catalog } of roots) {
    if (!Object.hasOwn(selections, option.name)) {
      const value = !option.deleted ? ordered(catalog.values).find(value => isEnabled(option, value) && (option.name === 'Standee Quantity' ? sameEntity(value, option.defaultValue) : value.isDefault || sameEntity(value, catalog.defaultValue))) : undefined
      selections[option.name] = value ? getEntityId(value) : ''
    }
    const style = catalog.values.find(value => getEntityId(value) === selections[option.name])
    const key = `${option.name}:color`
    if (!Object.hasOwn(selections, key)) {
      const color = !option.deleted && style ? ordered(style.colors ?? []).find(color => isEnabled(option, color) && color.isDefault) : undefined
      selections[key] = color ? getEntityId(color) : ''
    }
  }
  for (const { option, catalog } of roots) {
    const allowed = (value: OptionValue) => !option.deleted && isEnabled(option, value)
    const chosen = catalog.values.find(value => getEntityId(value) === selections[option.name] && allowed(value))
    if (!chosen) selections[option.name] = ''
    const key = `${option.name}:color`
    if (selections[key] && !chosen?.colors?.some(value => getEntityId(value) === selections[key] && allowed(value))) selections[key] = ''
  }
  const selectedValues: Record<string, EntityReference> = {}
  for (const { option, catalog } of roots) {
    const value = catalog.values.find(value => getEntityId(value) === selections[option.name])
    if (!value) continue
    selectedValues[option.name] = entityReference(value)
    const key = `${option.name}:color`
    const color = value.colors?.find(color => getEntityId(color) === selections[key])
    if (color) selectedValues[key] = entityReference(color)
  }
  return { selections, selectedValues }
}
export function addValue(catalog: Catalog, style?: OptionValue) {
  const definition = definitions.find(item => item.name === catalog.name)
  if (style && (definition?.idKey !== 'accessoryStyleId' || getEntityKey(style) !== 'accessoryStyleId' || !catalog.values.includes(style))) throw new Error('颜色必须添加到所属配件样式中')
  const pieceCount = definition?.idKey === 'standeeQuantityId' ? [1, 2, 3, 4].find(count => !catalog.values.some(value => value.pieceCount === count)) : undefined
  if (definition?.idKey === 'standeeQuantityId' && (catalog.values.length >= 4 || pieceCount === undefined)) throw new Error('主体片数仅支持1至4片，最多四个数量值')
  const prefix = style ? 'P-C' : definition?.prefix ?? 'X'
  const key = style ? 'accessoryColorId' : definition?.idKey ?? 'customOptionValueId'
  let next = style ? catalog.nextColorId ?? 1 : catalog.nextId
  const ids = new Set(flattenedValues(catalog).map(getEntityId))
  while (ids.has(`${prefix}${next}`)) next++
  const values = style ? (style.colors ??= []) : catalog.values
  const reference = makeReference(key, `${prefix}${next}`)
  const value: OptionValue = { ...reference, name: `New ${prefix}${next}`, labelZh: style ? '新颜色' : '新选项值', image: '', isDefault: false, sortOrder: Math.max(0, ...values.map(item => item.sortOrder)) + 1 }
  if (pieceCount !== undefined) { value.pieceCount = pieceCount; value.name = `${pieceCount} ${pieceCount === 1 ? 'piece' : 'pieces'}`; value.labelZh = `${pieceCount}片` }
  if (!style && definition?.idKey === 'accessoryStyleId') value.colors = []
  values.push(value)
  if (style) catalog.nextColorId = next + 1; else catalog.nextId = next + 1
  return value
}
export function changeOrder(values: OptionValue[], reference: EntityReference, rank: number) {
  const value = values.find(item => sameEntity(item, reference))
  if (!value || !Number.isSafeInteger(rank) || rank < 1 || rank === value.sortOrder) return
  value.sortOrder = rank
  const rest = ordered(values.filter(item => item !== value))
  const next = rest.findIndex(item => item.sortOrder > rank)
  rest.splice(next < 0 ? rest.length : next, 0, value)
  values.splice(0, values.length, ...rest)
}
export function deleteValue(bundle: Bundle, catalog: Catalog, value: OptionValue, style?: OptionValue) {
  const values = style ? style.colors! : catalog.values
  const index = values.indexOf(value)
  if (index < 0) return
  values.splice(index, 1)
  const references = [value, ...(value.colors ?? [])].map(entityReference)
  const keys = new Set(references.map(referenceKey))
  if (!style && sameEntity(catalog.defaultValue, value)) delete catalog.defaultValue
  allProducts(bundle.main).forEach(product => {
    const option = optionFor(product, catalog.name)
    if (option?.defaultValue && keys.has(referenceKey(option.defaultValue))) delete option.defaultValue
    if (option?.disabledValues) { option.disabledValues = option.disabledValues.filter(value => !keys.has(referenceKey(value))); if (!option.disabledValues.length) delete option.disabledValues }
  })
}
export function setDefault(catalog: Catalog, reference: EntityReference | undefined, style?: OptionValue) {
  const values = style ? style.colors ?? [] : catalog.values
  const selected = reference ? values.find(value => sameEntity(value, reference)) : undefined
  if (reference && !selected) throw new Error('默认值不属于当前选项或配件样式')
  values.forEach(value => { value.isDefault = value === selected })
  if (!style) { if (selected) catalog.defaultValue = entityReference(selected); else delete catalog.defaultValue }
}
export function setStandeeQuantityDefault(product: Product, catalog: Catalog, reference: EntityReference | undefined) {
  const option = optionFor(product, 'Standee Quantity')
  if (!option || catalog.name !== 'Standee Quantity') throw new Error('主体片数属性不存在')
  if (reference && !catalog.values.some(value => sameEntity(value, reference))) throw new Error('默认值不属于主体片数目录')
  if (reference) option.defaultValue = entityReference(reference); else delete option.defaultValue
}
export function deleteCategory(main: ProductDocument, index: number) { main.uncategorizedProducts.push(...main.categories[index].products); main.categories.splice(index, 1) }
export function applyMembership(main: ProductDocument, index: number, retained: number[], included: number[]) {
  const category = main.categories[index]
  const removed = category.products.filter((_, i) => !retained.includes(i))
  category.products = [...category.products.filter((_, i) => retained.includes(i)), ...main.uncategorizedProducts.filter((_, i) => included.includes(i))]
  main.uncategorizedProducts = [...main.uncategorizedProducts.filter((_, i) => !included.includes(i)), ...removed]
}
function validateReferences(values: EntityReference[] | undefined, allowed: Set<string>, message: string) {
  if (values === undefined) return
  if (!Array.isArray(values)) throw new Error(message)
  const seen = new Set<string>()
  for (const value of values) {
    validateReference(value)
    const key = referenceKey(value)
    if (!allowed.has(key) || seen.has(key)) throw new Error(message)
    seen.add(key)
  }
}
function validateDefault(catalog: Pick<Catalog, 'values' | 'defaultValue'>) {
  if (catalog.defaultValue === undefined) return
  validateReference(catalog.defaultValue)
  if (!catalog.values.some(value => sameEntity(value, catalog.defaultValue))) throw new Error('默认值的实体引用不属于当前选项')
}
export function validateBundle(bundle: Bundle): void {
  if (!bundle?.main || !Array.isArray(bundle.main.categories) || !Array.isArray(bundle.main.uncategorizedProducts) || !bundle.catalogs) throw new Error('配置格式错误：需要产品类别、未归类产品和公共选项数据')
  const categoryIds = new Set<string>()
  bundle.main.categories.forEach(category => {
    if (!category || !category.name || categoryIds.has(category.name) || typeof category.title !== 'string' || typeof category.titleZh !== 'string' || !Array.isArray(category.products)) throw new Error('产品类别名称重复或格式错误')
    categoryIds.add(category.name)
  })
  const products = allProducts(bundle.main)
  const productIds = new Set<string>(); let maxProductId = 0
  products.forEach(product => {
    if (!product || 'id' in product || identityKeys.some(key => key in product) || typeof product.productId !== 'string' || !/^P[1-9][0-9]*$/.test(product.productId) || productIds.has(product.productId)) throw new Error('产品 productId 格式错误、重复或包含其他实体 ID')
    if (typeof product.title !== 'string' || !product.title.trim() || typeof product.titleZh !== 'string' || !Array.isArray(product.productOptions)) throw new Error('产品数据格式错误')
    if (product.productOptions.length < definitions.length || product.productOptions.some(option => !option || typeof option.name !== 'string') || new Set(product.productOptions.map(item => item.name)).size !== product.productOptions.length) throw new Error('每个产品必须包含全部公共选项开关，且选项名称不能重复')
    productIds.add(product.productId); maxProductId = Math.max(maxProductId, Number(product.productId.slice(1)))
  })
  if (!Number.isSafeInteger(bundle.main.nextProductId) || bundle.main.nextProductId <= maxProductId) throw new Error('产品 ID 计数器无效')
  definitions.forEach(definition => {
    const catalog = bundle.catalogs[definition.file]
    if (!catalog || catalog.name !== definition.name || !Array.isArray(catalog.values) || typeof catalog.labelZh !== 'string') throw new Error(`缺少或无效的公共选项：${definition.title}`)
    if ('label' in catalog && typeof catalog.label !== 'string') throw new Error('选项显示名称格式错误')
    const ids = new Set<string>(); const pieceCounts = new Set<number>(); let max = 0; let colorMax = 0
    const check = (value: OptionValue, color = false) => {
      const prefix = color ? 'P-C' : definition.prefix
      const expectedKey = color ? 'accessoryColorId' : definition.idKey
      const key = getEntityKey(value); const id = getEntityId(value); const token = referenceKey(value)
      const numberedId = new RegExp(`^${prefix}[1-9][0-9]*$`).test(id)
      const validId = definition.idKey === 'sizeBandId' ? !!id.trim() && id.trim() === id : numberedId
      if (key !== expectedKey || !validId || ids.has(token) || typeof value.name !== 'string' || !value.name.trim() || !Number.isSafeInteger(value.sortOrder) || value.sortOrder < 1 || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')) throw new Error(`${definition.title}选项值格式错误、所属实体不符或 ID 重复`)
      if (['deleted', 'hidden', 'isHidden', 'isDeleted', 'showInEditor', 'editorVisible', 'linkedParent', 'parentValues'].some(key => key in value)) throw new Error('公共选项值不能保存产品开关或旧关联字段')
      if (['labelZh', 'image'].some(key => key in value && typeof value[key as 'labelZh'] !== 'string')) throw new Error('选项中文名或图片地址格式错误')
      if (definition.idKey === 'standeeQuantityId') {
        if (!Number.isSafeInteger(value.pieceCount) || value.pieceCount! < 1 || value.pieceCount! > 4 || pieceCounts.has(value.pieceCount!)) throw new Error('主体片数必须是1至4的整数，且数量不能重复')
        pieceCounts.add(value.pieceCount!)
      } else if (Object.hasOwn(value, 'pieceCount')) throw new Error('pieceCount只能用于主体片数目录')
      ids.add(token)
      if (numberedId) { const number = Number(id.slice(prefix.length)); if (color) colorMax = Math.max(colorMax, number); else max = Math.max(max, number) }
      if (value.colors !== undefined) {
        if (definition.idKey !== 'accessoryStyleId' || color || !Array.isArray(value.colors)) throw new Error('配件颜色结构错误')
        value.colors.forEach(item => check(item, true))
      }
    }
    catalog.values.forEach(value => check(value))
    validateDefault(catalog)
    if (!Number.isSafeInteger(catalog.nextId) || catalog.nextId <= max || (definition.idKey === 'accessoryStyleId' && (!Number.isSafeInteger(catalog.nextColorId) || catalog.nextColorId! <= colorMax))) throw new Error(`${definition.title}的 ID 计数器无效`)
    products.forEach(product => {
      const option = optionFor(product, definition.name)
      const allowedKeys = definition.idKey === 'standeeQuantityId' ? ['name', 'deleted', 'disabledValues', 'defaultValue'] : ['name', 'deleted', 'disabledValues']
      if (!option || typeof option.deleted !== 'boolean' || Object.keys(option).some(key => !allowedKeys.includes(key))) throw new Error(`${product.title}的选项开关或禁用 ID 无效`)
      validateReferences(option.disabledValues, ids, `${product.title}的禁用实体引用无效或重复`)
      if (definition.idKey === 'standeeQuantityId') validateDefault({ values: catalog.values, defaultValue: option.defaultValue })
    })
  })
  products.forEach(product => product.productOptions.filter(option => !definitions.some(item => item.name === option.name)).forEach(option => {
    if (!option.name.trim() || typeof option.deleted !== 'boolean' || !Array.isArray(option.values) || typeof option.labelZh !== 'string') throw new Error('自定义选项格式错误')
    if ('label' in option && typeof option.label !== 'string') throw new Error('自定义选项显示名称格式错误')
    const ids = new Set<string>(); let max = 0
    option.values.forEach(value => {
      const key = getEntityKey(value); const id = getEntityId(value); const token = referenceKey(value)
      if (key !== 'customOptionValueId' || !/^X[1-9][0-9]*$/.test(id) || ids.has(token) || typeof value.name !== 'string' || !value.name.trim() || !Number.isSafeInteger(value.sortOrder) || value.sortOrder < 1 || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean') || value.colors !== undefined || ['deleted', 'hidden', 'isHidden', 'isDeleted', 'showInEditor', 'editorVisible', 'linkedParent', 'parentValues', 'pieceCount'].some(key => key in value)) throw new Error('自定义选项值格式错误')
      if (['labelZh', 'image'].some(key => key in value && typeof value[key as 'labelZh'] !== 'string')) throw new Error('自定义选项中文名或图片地址格式错误')
      ids.add(token); max = Math.max(max, Number(id.slice(1)))
    })
    validateDefault({ values: option.values, defaultValue: option.defaultValue })
    if (!Number.isSafeInteger(option.nextId) || option.nextId! <= max) throw new Error('自定义选项的 ID 计数器无效')
    validateReferences(option.disabledValues, ids, '自定义选项的禁用实体引用无效或重复')
  }))

}
export function parseImport(text: string, current: Bundle): Bundle {
  const data: unknown = JSON.parse(text)
  const candidate = upgradeProductSizeBundle(upgradeStandeeQuantityBundle(data && typeof data === 'object' && 'main' in data ? data as Bundle : { main: data as ProductDocument, catalogs: clone(current.catalogs) }))
  validateBundle(candidate)
  return clone(candidate)
}
