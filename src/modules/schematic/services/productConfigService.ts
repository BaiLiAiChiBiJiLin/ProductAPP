import { invoke, isTauri } from '@tauri-apps/api/core'

export type ProductOptionValue = {
  name: string
  label: string
  image?: string
  hidden: boolean
  deleted: boolean
  parentValues: string[]
}

export type ProductOption = {
  name: string
  label: string
  image?: string
  defaultValue?: string
  linkedParent?: string
  values: ProductOptionValue[]
}

export type ProductConfig = {
  id: string
  title: string
  options: ProductOption[]
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : value == null ? fallback : String(value)

/**
 * The product-config endpoint has shipped these flags as booleans, but some
 * cached/older responses use 0/1 or string values. Normalize them before
 * deciding whether a product option/value belongs in the editor. Keeping this
 * rule in the catalog normalizer means every existing-product dropdown gets
 * the same visibility behavior.
 */
const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'hidden'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'visible'].includes(normalized)) return false
  return undefined
}

const isHidden = (value: Record<string, unknown>) => {
  const hidden = ['hidden', 'isHidden', 'deleted', 'isDeleted']
    .some(key => asBoolean(value[key]) === true)
  const editorVisibility = ['showInEditor', 'editorVisible']
    .some(key => asBoolean(value[key]) === false)
  return hidden || editorVisibility
}

function normalizeOption(value: unknown): ProductOption | null {
  const record = asRecord(value)
  if (!record || isHidden(record)) return null
  const name = asString(record.name, asString(record.label, '未命名选项'))
  const label = asString(record.labelZh, asString(record.label, name))
  const rawValues = Array.isArray(record.values) ? record.values : []
  const values = rawValues.flatMap<ProductOptionValue>((entry) => {
    if (typeof entry === 'string' || typeof entry === 'number') return [{ name: String(entry), label: String(entry), hidden: false, deleted: false, parentValues: [] }]
    const item = asRecord(entry)
    if (!item || isHidden(item)) return []
    const itemName = asString(item.name, asString(item.value, ''))
    if (!itemName) return []
    const parentValues = Array.isArray(item.parentValues) ? item.parentValues.map(value => asString(value)).filter(Boolean) : []
    return [{ name: itemName, label: asString(item.labelZh, asString(item.label, itemName)), image: asString(item.image) || undefined, hidden: false, deleted: false, parentValues }]
  })
  return { name, label, image: asString(record.image) || undefined, defaultValue: asString(record.defaultValue), linkedParent: asString(record.linkedParent) || undefined, values }
}

function normalizeProduct(value: unknown, index: number): ProductConfig | null {
  const record = asRecord(value)
  if (!record || isHidden(record)) return null
  const id = asString(record.productId, asString(record.id, `product-${index + 1}`))
  const title = asString(record.title, asString(record.name, `产品 ${index + 1}`))
  const options = (Array.isArray(record.productOptions) ? record.productOptions : [])
    .map(normalizeOption)
    .filter((option): option is ProductOption => option !== null)
    .filter(option => option.values.length > 0)
  return { id, title, options }
}

export function normalizeProductConfigs(value: unknown): ProductConfig[] {
  const root = asRecord(value)
  const products = root && Array.isArray(root.products) ? root.products : Array.isArray(value) ? value : []
  return products.map(normalizeProduct).filter((product): product is ProductConfig => product !== null)
}

let productConfigsRequest: Promise<ProductConfig[]> | undefined

export const PRODUCT_CONFIGS_UPDATED_EVENT = 'printflow-product-configs-updated'
export const PRODUCT_CONFIGS_STATUS_EVENT = 'printflow-product-configs-status'
let refreshRequest: Promise<ProductConfig[]> | undefined
let refreshError = ''
export const productConfigRefreshError = () => refreshError
export function reportProductConfigError(reason: unknown) {
  refreshError = reason instanceof Error ? reason.message : String(reason ?? '')
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRODUCT_CONFIGS_STATUS_EVENT))
}
export function refreshProductConfigs(): Promise<ProductConfig[]> {
  if (refreshRequest) return refreshRequest
  reportProductConfigError('')
  refreshRequest = invoke('refresh_product_configs').then(() => loadProductConfigs(true))
    .catch(reason => { reportProductConfigError(reason); throw reason })
    .finally(() => { refreshRequest = undefined })
  return refreshRequest
}

export function loadProductConfigs(force = false): Promise<ProductConfig[]> {
  if (!isTauri()) return Promise.resolve([])
  if (force) productConfigsRequest = undefined
  // Share the normalized catalog between the dropdown and cards. Read the
  // large local cache once, rather than once per component or image.
  productConfigsRequest ??= invoke<string>('load_product_configs')
    .then(raw => {
      const products = normalizeProductConfigs(JSON.parse(raw))
      if (!products.length) throw new Error('产品配置中没有可用产品，请刷新重新获取。')
      return products
    })
    .catch(error => {
      productConfigsRequest = undefined
      throw error
    })
  if (force && typeof window !== 'undefined') window.dispatchEvent(new Event(PRODUCT_CONFIGS_UPDATED_EVENT))
  return productConfigsRequest
}
