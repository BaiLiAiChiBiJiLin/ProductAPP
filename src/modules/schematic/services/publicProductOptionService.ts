import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ProductConfig, ProductOption, ProductOptionValue } from './productConfigService'

type RecordValue = Record<string, unknown>
const asRecord = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : value == null ? fallback : String(value)
const asNonEmptyString = (value: unknown, fallback = '') => {
  const text = asString(value).trim()
  return text ? text : fallback
}
const asBoolean = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true'

function normalizeValue(raw: unknown): ProductOptionValue | null {
  if (typeof raw === 'string' || typeof raw === 'number') return { name: String(raw), label: String(raw), hidden: false, deleted: false, parentValues: [] }
  const value = asRecord(raw)
  if (!value || asBoolean(value.hidden) || asBoolean(value.deleted) || asBoolean(value.isHidden) || asBoolean(value.isDeleted)) return null
  // Keep the human-readable name as the persisted value. valueId is an API
  // implementation key and is not useful in the schematic's image attributes.
  const name = asNonEmptyString(value.name, asNonEmptyString(value.value, asNonEmptyString(value.valueId)))
  if (!name) return null
  const parentValues = Array.isArray(value.parentValues) ? value.parentValues.map(item => asString(item)).filter(Boolean) : []
  return { name, label: asNonEmptyString(value.labelZh, asNonEmptyString(value.label, name)), image: asString(value.image) || undefined, hidden: false, deleted: false, parentValues }
}

function normalizeOption(raw: unknown): ProductOption | null {
  const value = asRecord(raw)
  if (!value || asBoolean(value.hidden) || asBoolean(value.deleted) || asBoolean(value.isHidden) || asBoolean(value.isDeleted)) return null
  const name = asNonEmptyString(value.name, asNonEmptyString(value.label, '未命名选项'))
  const values = (Array.isArray(value.values) ? value.values : []).map(normalizeValue).filter((item): item is ProductOptionValue => Boolean(item))
  return { name, label: asNonEmptyString(value.labelZh, asNonEmptyString(value.label, name)), image: asString(value.image) || undefined, defaultValue: asString(value.defaultValue) || undefined, linkedParent: asString(value.linkedParent) || undefined, values }
}

function normalizeProduct(raw: unknown, index: number): ProductConfig | null {
  const value = asRecord(raw)
  if (!value || asBoolean(value.hidden) || asBoolean(value.deleted) || asBoolean(value.isHidden) || asBoolean(value.isDeleted)) return null
  const rawId = asNonEmptyString(value.productId, asNonEmptyString(value.id, `product-${index + 1}`))
  if (!rawId) return null
  const options = (Array.isArray(value.options) ? value.options : Array.isArray(value.productOptions) ? value.productOptions : [])
    .map(normalizeOption).filter((item): item is ProductOption => Boolean(item)).filter(item => item.values.length > 0)
  return { id: rawId.startsWith('public:') ? rawId : `public:${rawId}`, title: asNonEmptyString(value.titleZh, asNonEmptyString(value.title, asNonEmptyString(value.name, `产品 ${index + 1}`))), options }
}

/** Normalize the public endpoint's category wrapper into the same editor model as local products. */
export function normalizePublicProductOptions(value: unknown): ProductConfig[] {
  const root = asRecord(value)
  const categories = root && Array.isArray(root.categories) ? root.categories : []
  const products = categories.flatMap(category => {
    const record = asRecord(category)
    return record && Array.isArray(record.products) ? record.products : []
  })
  if (root && Array.isArray(root.uncategorizedProducts)) products.push(...root.uncategorizedProducts)
  return products.map(normalizeProduct).filter((item): item is ProductConfig => Boolean(item))
}

let request: Promise<ProductConfig[]> | undefined
let refreshRequest: Promise<ProductConfig[]> | undefined
let lastError = ''
export const PUBLIC_PRODUCT_OPTIONS_STATUS_EVENT = 'printflow-public-product-options-status'
export const PUBLIC_PRODUCT_OPTIONS_UPDATED_EVENT = 'public-product-options-updated'
export const publicProductOptionsError = () => lastError

function report(error: unknown) {
  lastError = error instanceof Error ? error.message : String(error ?? '')
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PUBLIC_PRODUCT_OPTIONS_STATUS_EVENT))
}

export function loadPublicProductConfigs(force = false): Promise<ProductConfig[]> {
  if (!isTauri()) return Promise.resolve([])
  if (force) request = undefined
  request ??= invoke<string>('load_public_product_options').then(raw => {
    const products = normalizePublicProductOptions(JSON.parse(raw))
    if (!products.length) throw new Error('在线产品配置中没有可用产品')
    report('')
    return products
  }).catch(error => { request = undefined; report(error); throw error })
  return request
}

export function refreshPublicProductConfigs(): Promise<ProductConfig[]> {
  if (refreshRequest) return refreshRequest
  refreshRequest = invoke('refresh_public_product_options').then(() => loadPublicProductConfigs(true))
    .finally(() => { refreshRequest = undefined })
  return refreshRequest
}
