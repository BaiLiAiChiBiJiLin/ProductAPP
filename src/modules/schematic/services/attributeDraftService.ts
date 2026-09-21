import type { Asset } from '../../../model'
import type { ProductConfig } from './productConfigService'
import { availableOptionValues, type ProductAttributePatch } from './productOptionRules.ts'

export type AttributeDraft = { productId: string; attributes: Record<string, string>; images: Record<string, string>; note: string; noteImage: string }
export const emptyAttributeDraft = (): AttributeDraft => ({ productId: '', attributes: {}, images: {}, note: '', noteImage: '' })

/** A blank asset inherits the previous form without changing any asset. */
export function readSelectionDraft(previous: AttributeDraft, selected: Asset[]): AttributeDraft {
  const first = selected[0]
  if (!first || !first.productId || first.productId === 'a' || !selected.every(asset => asset.productId === first.productId)) return previous
  const sameProduct = previous.productId === first.productId
  const attributes = sameProduct ? { ...previous.attributes } : {}
  const images = sameProduct ? { ...previous.images } : {}
  const keys = new Set(selected.flatMap(asset => Object.keys(asset.attributes ?? {})))
  for (const key of keys) if (selected.every(asset => (asset.attributes?.[key] ?? '') === (first.attributes?.[key] ?? ''))) attributes[key] = first.attributes?.[key] ?? ''
  const imageKeys = new Set(selected.flatMap(asset => Object.keys(asset.attributeImages ?? {})))
  for (const key of imageKeys) if (selected.every(asset => (asset.attributeImages?.[key] ?? '') === (first.attributeImages?.[key] ?? ''))) images[key] = first.attributeImages?.[key] ?? ''
  return { productId: first.productId, attributes: selected.length === 1 ? { ...first.attributes } : attributes, images: selected.length === 1 ? { ...first.attributeImages } : images,
    note: selected.every(asset => (asset.note ?? '') === (first.note ?? '')) ? first.note ?? '' : previous.note,
    noteImage: selected.every(asset => (asset.noteImage ?? '') === (first.noteImage ?? '')) ? first.noteImage ?? '' : previous.noteImage }
}

/** Hidden or invalid dependent values cannot be confirmed from a stale draft. */
export function catalogConfirmationPatch(draft: AttributeDraft, product: ProductConfig): ProductAttributePatch {
  const attributes: Record<string, string> = {}
  const attributeImages: Record<string, string> = {}
  let changed = true
  while (changed) {
    changed = false
    for (const option of product.options) {
      if (attributes[option.name]) continue
      const selected = availableOptionValues(option, attributes).find(value => value.name === draft.attributes[option.name])
      if (!selected) continue
      attributes[option.name] = selected.name
      const image = draft.images[option.name] || selected.image || option.image
      if (image) attributeImages[option.name] = image
      changed = true
    }
  }
  if (draft.attributes.QT) attributes.QT = draft.attributes.QT
  return { productId: product.id, productName: product.title, attributes, attributeImages, clearAttributes: true, note: draft.note, noteImage: draft.noteImage }
}
