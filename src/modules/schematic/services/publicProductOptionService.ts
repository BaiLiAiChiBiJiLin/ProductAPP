import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ProductConfig, ProductOption, ProductOptionValue } from './productConfigService'

type RecordValue = Record<string, unknown>
const asRecord = (value: unknown): RecordValue | null => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : value == null ? fallback : String(value)
const asNonEmptyString = (value: unknown, fallback = '') => {
  const text = asString(value).trim()
  return text ? text : fallback
}
const asBoolean = (value: unknown) => {
  if (value === true || value === 1) return true
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'y', 'hidden'].includes(value.trim().toLowerCase())
}
const isExplicitFalse = (value: unknown) => value === false || value === 0
  || typeof value === 'string' && ['0', 'false', 'no', 'n', 'hidden:false'].includes(value.trim().toLowerCase())

/** Public responses have used both deletion flags and editor visibility flags. */
const isHiddenRecord = (value: RecordValue) => {
  if (['hidden', 'deleted', 'isHidden', 'isDeleted'].some(key => asBoolean(value[key]))) return true
  return ['showInEditor', 'editorVisible'].some(key => isExplicitFalse(value[key]))
}

function normalizeValue(raw: unknown): ProductOptionValue | null {
  if (typeof raw === 'string' || typeof raw === 'number') return { name: String(raw), label: String(raw), hidden: false, deleted: false, parentValues: [] }
  const value = asRecord(raw)
  if (!value || isHiddenRecord(value)) return null
  // Keep the human-readable name as the persisted value. valueId is an API
  // implementation key and is not useful in the schematic's image attributes.
  const name = asNonEmptyString(value.name, asNonEmptyString(value.value, asNonEmptyString(value.valueId)))
  if (!name) return null
  const parentValues = Array.isArray(value.parentValues) ? value.parentValues.map(item => asString(item)).filter(Boolean) : []
  return { name, label: asNonEmptyString(value.labelZh, asNonEmptyString(value.label, name)), image: asString(value.image) || undefined, hidden: false, deleted: false, parentValues }
}

function normalizeOption(raw: unknown): ProductOption | null {
  const value = asRecord(raw)
  if (!value || isHiddenRecord(value)) return null
  const name = asNonEmptyString(value.name, asNonEmptyString(value.label, '未命名选项'))
  const rawValues = Array.isArray(value.values) ? value.values : []
  const values = rawValues.map(normalizeValue).filter((item): item is ProductOptionValue => Boolean(item))
  const rawDefault = value.defaultValue
  let defaultValue = typeof rawDefault === 'string' || typeof rawDefault === 'number' ? asNonEmptyString(rawDefault) : ''
  if (!defaultValue && rawDefault && typeof rawDefault === 'object') {
    const reference = Object.values(asRecord(rawDefault) ?? {}).map(item => asString(item)).find(Boolean)
    if (reference) {
      const defaultIndex = rawValues.findIndex(item => {
        const record = asRecord(item)
        return record && [record.valueId, record.id, record.entityId].some(candidate => asString(candidate) === reference)
      })
      if (defaultIndex >= 0) {
        const normalizedBefore = rawValues.slice(0, defaultIndex).map(normalizeValue).filter((item): item is ProductOptionValue => Boolean(item)).length
        defaultValue = values[normalizedBefore]?.name ?? ''
      }
    }
  }
  if (!defaultValue) {
    for (const rawItem of rawValues) {
      const record = asRecord(rawItem)
      if (record && asBoolean(record.isDefault)) {
        const normalizedItem = normalizeValue(rawItem)
        if (normalizedItem) { defaultValue = normalizedItem.name; break }
      }
    }
  }
  return { name, label: asNonEmptyString(value.labelZh, asNonEmptyString(value.label, name)), image: asString(value.image) || undefined, defaultValue: defaultValue || undefined, linkedParent: asString(value.linkedParent) || undefined, values }
}

/** The public API nests colors inside each accessory style. Adapt them to the
 * existing dependent option so selecting, clearing and saving share one path. */
function isAccessoryStyleOption(option: ProductOption) {
  return [option.name, option.label].some(value => /accessor(?:y|ies)\s*style|配件样式/i.test(value.replace(/[_-]/g, ' ')))
}

function accessoryColors(raw: unknown, option: ProductOption): ProductOption | null {
  if (!isAccessoryStyleOption(option)) return null
  const record = asRecord(raw)
  const styles = record && Array.isArray(record.values) ? record.values : []
  const values = styles.flatMap<ProductOptionValue>(rawStyle => {
    const style = normalizeValue(rawStyle)
    const source = asRecord(rawStyle)
    if (!style || !source || !Array.isArray(source.colors)) return []
    return source.colors.flatMap(rawColor => {
      const color = normalizeValue(rawColor)
      return color ? [{ ...color, parentValues: [style.name] }] : []
    })
  })
  return values.length ? { name: 'Accessories Color', label: '配件颜色', linkedParent: option.name, values } : null
}

function normalizeProduct(raw: unknown, index: number): ProductConfig | null {
  const value = asRecord(raw)
  if (!value || isHiddenRecord(value)) return null
  const rawId = asNonEmptyString(value.productId, asNonEmptyString(value.id, `product-${index + 1}`))
  if (!rawId) return null
  const rawOptions = Array.isArray(value.options) ? value.options : Array.isArray(value.productOptions) ? value.productOptions : []
  const normalized = rawOptions.map(rawOption => ({ raw: rawOption, option: normalizeOption(rawOption) }))
  const hasColorOption = normalized.some(({ option }) => option?.name === 'Accessories Color' && option.values.length > 0)
  const options = normalized.flatMap<ProductOption>(({ raw, option }) => {
    if (!option?.values.length) return []
    const colors = !hasColorOption ? accessoryColors(raw, option) : null
    return colors ? [option, colors] : [option]
  })
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
  if (force && typeof window !== 'undefined') window.dispatchEvent(new Event(PUBLIC_PRODUCT_OPTIONS_UPDATED_EVENT))
  return request
}

export function refreshPublicProductConfigs(): Promise<ProductConfig[]> {
  if (refreshRequest) return refreshRequest
  refreshRequest = invoke('refresh_public_product_options').then(() => loadPublicProductConfigs(true))
    .finally(() => { refreshRequest = undefined })
  return refreshRequest
}
