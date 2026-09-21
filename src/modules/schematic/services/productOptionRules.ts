import type { Asset } from '../../../model'
import type { ProductOption, ProductOptionValue } from './productConfigService'

export type ProductAttributePatch = {
  productId?: string
  productName?: string
  attribute?: { key: string; value: string }
  attributes?: Record<string, string>
  attributeImages?: Record<string, string>
  clearAttributes?: boolean
  clearAttributeKeys?: string[]
  attributeImage?: { key: string; url: string }
  note?: string
  noteImage?: string
}

export type CommonSelectionValues = { productId?: string; attributes: Record<string, string>; attributeImages: Record<string, string> }

const normalized = (value: string) => value.trim().toLowerCase()

/** Return only values shared by every selected asset. Missing attributes count as empty. */
export function commonSelectionValues(assets: Asset[], selectedIds: Set<string>, optionNames: string[]): CommonSelectionValues {
  const selected = assets.filter(asset => selectedIds.has(asset.id))
  if (!selected.length) return { attributes: {}, attributeImages: {} }
  const firstProduct = selected[0].productId
  const sameProduct = Boolean(firstProduct) && selected.every(asset => asset.productId === firstProduct)
  if (!sameProduct) return { attributes: {}, attributeImages: {} }
  const attributes: Record<string, string> = {}
  const attributeImages: Record<string, string> = {}
  for (const name of optionNames) {
    const firstValue = selected[0].attributes?.[name] ?? ''
    if (selected.every(asset => (asset.attributes?.[name] ?? '') === firstValue)) attributes[name] = firstValue
  }
  const imageKeys = new Set(selected.flatMap(asset => Object.keys(asset.attributeImages ?? {})))
  for (const name of imageKeys) {
    const firstImage = selected[0].attributeImages?.[name] ?? ''
    if (firstImage && selected.every(asset => (asset.attributeImages?.[name] ?? '') === firstImage)) attributeImages[name] = firstImage
  }
  return { productId: firstProduct, attributes, attributeImages }
}

/** Filter before deduplication: the same value can belong to different parents. */
export function availableOptionValues(option: ProductOption, selections: Record<string, string>): ProductOptionValue[] {
  const parent = option.linkedParent ? selections[option.linkedParent] : undefined
  if (option.linkedParent && !parent) return []
  const seen = new Set<string>()
  return option.values.filter(value => {
    if (value.hidden || value.deleted) return false
    if (option.linkedParent && !value.parentValues.some(candidate => normalized(candidate) === normalized(parent!))) return false
    if (seen.has(value.name)) return false
    seen.add(value.name)
    return true
  })
}

/** Changing/clearing a parent invalidates every descendant, even shared labels. */
export function dependentOptionNames(options: ProductOption[], parentName: string): string[] {
  const visited = new Set([parentName])
  const pending = [parentName]
  for (let index = 0; index < pending.length; index++) {
    for (const option of options) {
      if (option.linkedParent !== pending[index] || visited.has(option.name)) continue
      visited.add(option.name)
      pending.push(option.name)
    }
  }
  return pending.slice(1)
}

export function applyAttributeValues(current: Record<string, string> = {}, patch: ProductAttributePatch): Record<string, string> {
  const next = patch.clearAttributes ? {} : { ...current }
  for (const name of patch.clearAttributeKeys ?? []) delete next[name]
  for (const [name, value] of Object.entries(patch.attributes ?? {})) {
    if (value) next[name] = value
    else delete next[name]
  }
  if (patch.attribute) {
    if (patch.attribute.value) next[patch.attribute.key] = patch.attribute.value
    else delete next[patch.attribute.key]
  }
  return next
}

export function applyAttributeImages(current: Record<string, string> = {}, patch: ProductAttributePatch): Record<string, string> {
  const next = patch.clearAttributes ? {} : { ...current }
  for (const name of patch.clearAttributeKeys ?? []) delete next[name]
  for (const [name, value] of Object.entries(patch.attributeImages ?? {})) {
    if (value) next[name] = value
    else delete next[name]
  }
  if (patch.attributeImage) {
    if (patch.attributeImage.url) next[patch.attributeImage.key] = patch.attributeImage.url
    else delete next[patch.attributeImage.key]
  } else if (patch.attribute) {
    // Clearing a value must also clear the image that belonged to it.
    if (!patch.attribute.value) delete next[patch.attribute.key]
  }
  return next
}

export function applyProductAttributePatch(asset: Asset, patch: ProductAttributePatch): Asset {
  return {
    ...asset,
    ...(patch.productId !== undefined ? { productId: patch.productId } : {}),
    ...(patch.productName !== undefined ? { productName: patch.productName } : {}),
    attributes: applyAttributeValues(asset.attributes, patch),
    attributeImages: applyAttributeImages(asset.attributeImages, patch),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.noteImage !== undefined ? { noteImage: patch.noteImage } : {}),
  }
}
