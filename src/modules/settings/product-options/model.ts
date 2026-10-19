export const definitions = [
  { name: 'Print Option', title: '印刷选项', file: 'print-options.json', prefix: 'Y' },
  { name: 'Technique', title: '工艺', file: 'techniques.json', prefix: 'G' },
  { name: 'Holo Film', title: '全息膜', file: 'holo-films.json', prefix: 'M' },
  { name: 'Material', title: '材质', file: 'materials.json', prefix: 'C' },
  { name: 'Accessories Style', title: '配件样式', file: 'accessory-styles.json', prefix: 'P' },
] as const

export type OptionValue = { id: string; name: string; labelZh?: string; image?: string; isDefault?: boolean; sortOrder: number; colors?: OptionValue[] }
export type Catalog = { name: string; label?: string; labelZh: string; defaultValue?: string; values: OptionValue[]; nextId: number; nextColorId?: number }
export type ProductOption = { name: string; deleted: boolean; disabledValues?: string[]; label?: string; labelZh?: string; defaultValue?: string; values?: OptionValue[]; nextId?: number }
export type Product = { title: string; titleZh: string; productOptions: ProductOption[] }
export type Category = { name: string; title: string; titleZh: string; products: Product[] }
export type ProductDocument = { categories: Category[]; uncategorizedProducts: Product[] }
export type Bundle = { main: ProductDocument; catalogs: Record<string, Catalog> }
export type Location = { category: number; product: number }
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const display = (value: { name?: string; labelZh?: string; title?: string; titleZh?: string }) => value.titleZh || value.labelZh || value.title || value.name || '未命名'
export const ordered = (values: OptionValue[]) => [...values].sort((a, b) => a.sortOrder - b.sortOrder)
export function productList(main: ProductDocument, category: number) { return category < 0 ? main.uncategorizedProducts : main.categories[category]?.products ?? [] }
export function allProducts(main: ProductDocument) { return [...main.categories.flatMap(category => category.products), ...main.uncategorizedProducts] }
export function locations(main: ProductDocument, filter: number): Location[] {
  return [...main.categories.flatMap((category, index) => category.products.map((_, product) => ({ category: index, product }))), ...main.uncategorizedProducts.map((_, product) => ({ category: -1, product }))].filter(location => filter === -2 || location.category === filter)
}
export function getProduct(main: ProductDocument, location?: Location) { return location ? productList(main, location.category)[location.product] : undefined }
export function optionFor(product: Product, name: string) { return product.productOptions.find(option => option.name === name) }
export function isEnabled(option: ProductOption | undefined, id: string) { return !option?.disabledValues?.includes(id) }
export function setEnabled(option: ProductOption, id: string, enabled: boolean) {
  const ids = new Set(option.disabledValues ?? [])
  if (enabled) ids.delete(id); else ids.add(id)
  if (ids.size) option.disabledValues = [...ids]; else delete option.disabledValues
}
export function makeProduct(): Product { return { title: 'New Product', titleZh: '新产品', productOptions: definitions.map(({ name }) => ({ name, deleted: true })) } }
export function addValue(catalog: Catalog, style?: OptionValue) {
  const definition = definitions.find(item => item.name === catalog.name)
  const prefix = style ? 'P-C' : definition?.prefix ?? 'X'
  let next = style ? catalog.nextColorId ?? 1 : catalog.nextId
  const ids = new Set(catalog.values.flatMap(value => [value.id, ...(value.colors ?? []).map(color => color.id)]))
  while (ids.has(`${prefix}${next}`)) next++
  const values = style ? (style.colors ??= []) : catalog.values
  const value: OptionValue = { id: `${prefix}${next}`, name: `New ${prefix}${next}`, labelZh: style ? '新颜色' : '新选项值', image: '', isDefault: false, sortOrder: Math.max(0, ...values.map(item => item.sortOrder)) + 1 }
  if (!style && definition?.prefix === 'P') value.colors = []
  values.push(value)
  if (style) catalog.nextColorId = next + 1; else catalog.nextId = next + 1
  return value
}
export function changeOrder(values: OptionValue[], id: string, rank: number) {
  const value = values.find(item => item.id === id)
  if (!value || !Number.isSafeInteger(rank) || rank < 1 || rank === value.sortOrder) return
  value.sortOrder = rank
  const rest = ordered(values.filter(item => item !== value))
  const next = rest.findIndex(item => item.sortOrder > rank)
  rest.splice(next < 0 ? rest.length : next, 0, value)
  values.splice(0, values.length, ...rest)
}
export function deleteValue(bundle: Bundle, catalog: Catalog, value: OptionValue, style?: OptionValue) {
  const values = style ? style.colors! : catalog.values
  values.splice(values.indexOf(value), 1)
  const ids = new Set([value.id, ...(value.colors ?? []).map(color => color.id)])
  if (!style && catalog.defaultValue === value.name) delete catalog.defaultValue
  allProducts(bundle.main).forEach(product => {
    const option = optionFor(product, catalog.name)
    if (option?.disabledValues) { option.disabledValues = option.disabledValues.filter(id => !ids.has(id)); if (!option.disabledValues.length) delete option.disabledValues }
  })
}
export function setDefault(catalog: Catalog, id: string, style?: OptionValue) {
  const values = style ? style.colors ?? [] : catalog.values
  values.forEach(value => { value.isDefault = value.id === id })
  if (!style) { const value = values.find(item => item.id === id); if (value) catalog.defaultValue = value.name; else delete catalog.defaultValue }
}
export function deleteCategory(main: ProductDocument, index: number) { main.uncategorizedProducts.push(...main.categories[index].products); main.categories.splice(index, 1) }
export function applyMembership(main: ProductDocument, index: number, retained: number[], included: number[]) {
  const category = main.categories[index]
  const removed = category.products.filter((_, i) => !retained.includes(i))
  category.products = [...category.products.filter((_, i) => retained.includes(i)), ...main.uncategorizedProducts.filter((_, i) => included.includes(i))]
  main.uncategorizedProducts = [...main.uncategorizedProducts.filter((_, i) => !included.includes(i)), ...removed]
}
export function validateBundle(bundle: Bundle): void {
  if (!bundle?.main || !Array.isArray(bundle.main.categories) || !Array.isArray(bundle.main.uncategorizedProducts) || !bundle.catalogs) throw new Error('配置格式错误：需要产品类别、未归类产品和公共选项数据')
  const categoryIds = new Set<string>()
  bundle.main.categories.forEach(category => {
    if (!category.name || categoryIds.has(category.name) || typeof category.title !== 'string' || typeof category.titleZh !== 'string' || !Array.isArray(category.products)) throw new Error('产品类别名称重复或格式错误')
    categoryIds.add(category.name)
  })
  definitions.forEach(definition => {
    const catalog = bundle.catalogs[definition.file]
    if (!catalog || catalog.name !== definition.name || !Array.isArray(catalog.values) || typeof catalog.labelZh !== 'string') throw new Error(`缺少或无效的公共选项：${definition.title}`)
    if (['label', 'defaultValue'].some(key => key in catalog && typeof catalog[key as 'label'] !== 'string')) throw new Error('选项显示名称或默认值格式错误')
    const ids = new Set<string>(); let max = 0; let colorMax = 0
    const check = (value: OptionValue, color = false) => {
      const prefix = color ? 'P-C' : definition.prefix
      if (!value || typeof value.id !== 'string' || !new RegExp(`^${prefix}[1-9][0-9]*$`).test(value.id) || ids.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || !Number.isSafeInteger(value.sortOrder) || value.sortOrder < 1 || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')) throw new Error(`${definition.title}选项值格式错误或 ID 重复`)
      if (['deleted', 'hidden', 'isHidden', 'isDeleted', 'showInEditor', 'editorVisible', 'linkedParent', 'parentValues'].some(key => key in value)) throw new Error('公共选项值不能保存产品开关或旧关联字段')
      if (['labelZh', 'image'].some(key => key in value && typeof value[key as 'labelZh'] !== 'string')) throw new Error('选项中文名或图片地址格式错误')
      ids.add(value.id)
      const number = Number(value.id.slice(prefix.length)); if (color) colorMax = Math.max(colorMax, number); else max = Math.max(max, number)
      if (value.colors !== undefined) {
        if (definition.prefix !== 'P' || color || !Array.isArray(value.colors)) throw new Error('配件颜色结构错误')
        value.colors.forEach(item => check(item, true))
      }
    }
    catalog.values.forEach(value => check(value))
    if (!Number.isSafeInteger(catalog.nextId) || catalog.nextId <= max || (definition.prefix === 'P' && (!Number.isSafeInteger(catalog.nextColorId) || catalog.nextColorId! <= colorMax))) throw new Error(`${definition.title}的 ID 计数器无效`)
    allProducts(bundle.main).forEach(product => {
      if (typeof product.title !== 'string' || !product.title.trim() || typeof product.titleZh !== 'string' || !Array.isArray(product.productOptions)) throw new Error('产品数据格式错误')
      const option = optionFor(product, definition.name)
      if (!option || typeof option.deleted !== 'boolean' || Object.keys(option).some(key => !['name', 'deleted', 'disabledValues'].includes(key)) || (option.disabledValues !== undefined && (!Array.isArray(option.disabledValues) || option.disabledValues.some(id => !ids.has(id))))) throw new Error(`${product.title}的选项开关或禁用 ID 无效`)
      if (product.productOptions.length < definitions.length || new Set(product.productOptions.map(item => item.name)).size !== product.productOptions.length) throw new Error('每个产品必须包含五类公共选项开关，且选项名称不能重复')
    })
  })
  allProducts(bundle.main).forEach(product => product.productOptions.filter(option => !definitions.some(item => item.name === option.name)).forEach(option => {
    if (!option.name.trim() || typeof option.deleted !== 'boolean' || !Array.isArray(option.values) || typeof option.labelZh !== 'string') throw new Error('自定义选项格式错误')
    const ids = new Set<string>(); let max = 0
    option.values.forEach(value => {
      if (!/^X[1-9][0-9]*$/.test(value.id) || ids.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || !Number.isSafeInteger(value.sortOrder) || value.sortOrder < 1 || value.colors !== undefined || ['deleted', 'hidden', 'isHidden', 'isDeleted', 'showInEditor', 'editorVisible'].some(key => key in value)) throw new Error('自定义选项值格式错误')
      ids.add(value.id); max = Math.max(max, Number(value.id.slice(1)))
    })
    if (!Number.isSafeInteger(option.nextId) || option.nextId! <= max || option.disabledValues?.some(id => !ids.has(id))) throw new Error('自定义选项的 ID 无效')
  }))
}
export function parseImport(text: string, current: Bundle): Bundle {
  const data: unknown = JSON.parse(text)
  const candidate = data && typeof data === 'object' && 'main' in data ? data as Bundle : { main: data as ProductDocument, catalogs: clone(current.catalogs) }
  validateBundle(candidate)
  return clone(candidate)
}
