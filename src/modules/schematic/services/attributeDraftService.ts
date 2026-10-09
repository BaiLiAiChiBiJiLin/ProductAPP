import type { Asset } from '../../../model'
import type { ProductConfig } from './productConfigService'
import { availableOptionValues, type ProductAttributePatch } from './productOptionRules.ts'

export type AttributeDraft = { productId: string; attributes: Record<string, string>; images: Record<string, string>; note: string; noteImage: string; finishMatchDisabled?: boolean }
export const emptyAttributeDraft = (): AttributeDraft => ({ productId: '', attributes: {}, images: {}, note: '', noteImage: '', finishMatchDisabled: false })

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
    noteImage: selected.every(asset => (asset.noteImage ?? '') === (first.noteImage ?? '')) ? first.noteImage ?? '' : previous.noteImage,
    finishMatchDisabled: selected.length === 1 ? Boolean(first.finishMatchDisabled) : previous.finishMatchDisabled }
}

/** Hidden or invalid dependent values cannot be confirmed from a stale draft. */
export function catalogConfirmationPatch(draft: AttributeDraft, product: ProductConfig): ProductAttributePatch {
  const attributes: Record<string, string> = {}
  const attributeImages: Record<string, string> = {}
  // Keep the catalog option names separate from the persisted attribute keys.
  // In particular, `Finish` is stored as the canonical `工艺` field. Using
  // the output map as the processed marker makes `attributes.Finish` stay
  // empty and causes the dependency pass below to loop forever.
  const resolvedOptions = new Set<string>()
  const selections: Record<string, string> = {}
  let changed = true
  while (changed) {
    changed = false
    for (const option of product.options) {
      if (resolvedOptions.has(option.name)) continue
      const draftValue = draft.attributes[option.name] ?? (option.name.trim().toLowerCase() === 'finish' ? draft.attributes['工艺'] : undefined)
      const selected = availableOptionValues(option, selections).find(value => value.name === draftValue)
      if (!selected) continue
      resolvedOptions.add(option.name)
      selections[option.name] = selected.name
      // Catalog configs may call the process option `Finish`, while the
      // canvas uses the canonical `工艺` field. Keep one stored value.
      const targetKey = option.name.trim().toLowerCase() === 'finish' ? '工艺' : option.name
      attributes[targetKey] = selected.name
      const image = draft.images[option.name] || (option.name.trim().toLowerCase() === 'finish' ? draft.images['工艺'] : '') || selected.image || option.image
      if (image) attributeImages[targetKey] = image
      changed = true
    }
  }
  if (draft.attributes.QT) attributes.QT = draft.attributes.QT
  return { productId: product.id, productName: product.title, attributes, attributeImages, clearAttributes: true, note: draft.note, noteImage: draft.noteImage, suppressFinishMatch: Boolean(draft.finishMatchDisabled) }
}
