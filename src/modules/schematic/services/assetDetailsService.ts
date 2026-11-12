import { dimensionForItem } from './imageDimensionService.ts'
import type { Asset } from '../../../model.ts'
import type { ImageDetails } from '../layoutTypes.ts'
import type { ProductConfig } from './productConfigService.ts'
import type { FinishLookup } from './finishService.ts'
import { finishNameFromLookup } from './finishService.ts'
import { DEFAULT_NOTE_COLOR, DEFAULT_NOTE_FONT_SIZE, getNoteImages } from './assetNotesService.ts'
import { isHiddenAttributeValue } from './attributeDisplayService.ts'

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
export const cleanFinishLabel = (value: string) => {
  const label = value.replace(/^\s*\d+\s*\/\s*/, '').trim()
  return isHiddenAttributeValue(label) ? '' : label
}
const attr = (asset: Asset, keys: string[]) => {
  const values = asset.attributes ?? {}
  const wanted = keys.map(normalize)
  const key = Object.keys(values).find(candidate => wanted.includes(normalize(candidate)))
  return key ? String(values[key] ?? '').trim() : ''
}

let finishLookup: FinishLookup = new Map()

/** Install the compact local-cache index before a batch is paginated. */
export function setFinishLookup(next: FinishLookup) {
  finishLookup = next
}

function finishName(asset: Asset, configs: ProductConfig[]) {
  // Existing products may have a legacy duplicate Finish field. The canonical
  // persisted process is 工艺; prefer it whenever present.
  // Legacy numeric flags/counts are not process names. Skip them before
  // choosing a field so they cannot hide a real Finish on the same asset.
  const value = ['工艺', 'Finish', '表面'].map(key => attr(asset, [key]))
    .find(candidate => candidate && !/^[+-]?\d+(?:\.\d+)?$/.test(candidate))
  if (!value || !cleanFinishLabel(value)) return ''
  const cached = finishNameFromLookup(value, finishLookup)
  if (cached) return cleanFinishLabel(cached)
  // Product configuration is a useful fallback while an older desktop build
  // has no local finish cache yet. It still returns the canonical option name.
  const product = configs.find(config => config.id === asset.productId)
  const option = product?.options.find(candidate => ['finish', '表面', '工艺'].includes(normalize(candidate.name)) || ['finish', '表面', '工艺'].includes(normalize(candidate.label)))
  const match = option?.values.find(candidate => normalize(candidate.name) === normalize(value) || normalize(candidate.label) === normalize(value))
  // Older batches can be opened before the local finish cache finishes loading.
  // Keep the saved process visible in that case; the cache still takes
  // precedence whenever it contains a canonical name.
  return cleanFinishLabel(match?.name ?? value)
}

function accessoryImage(asset: Asset) {
  // The canvas accessory is defined only by the image selected for the
  // persisted attribute. Product configuration images describe options and
  // must not be used as a fallback for an uploaded image.
  const value = asset.attributeImages?.['Accessories Color']
  const image = typeof value === 'string' ? value.trim() : ''
  return image || undefined
}

function accessoryCode(asset: Asset) {
  const value = attr(asset, ['Accessories Color'])
  return value.match(/(\d+)\s*$/)?.[1] || ''
}

/**
 * Public products keep process-related selections under their catalog names
 * (Technique, Holo Film, Material, etc.), while older products use the
 * canonical Finish/工艺 field rendered at the bottom of the details panel.
 * Keep the latter in the existing footer and expose the other production
 * attributes as one editable row each.
 */
function productionAttributeFields(asset: Asset, productName: string | undefined) {
  const sticker = /stickers?|贴纸/i.test(productName ?? '')
  const fields: Array<{ key: string; text: string }> = []
  for (const [key, raw] of Object.entries(asset.attributes ?? {})) {
    const value = String(raw ?? '').trim()
    const normalizedKey = normalize(key)
    if (!value || ['size', 'qt', 'quantity', '数量'].includes(normalizedKey)) continue
    // Finish/工艺/表面 is normalized to the red footer below. A sticker's
    // material is already included in that footer as “材质 工艺”.
    if (['finish', '工艺', '表面'].includes(normalizedKey)) continue
    if (sticker && ['material', '材质'].includes(normalizedKey)) continue
    if (!/(technique|epoxy|holo|film|material|surface|工艺|膜|材质)/i.test(key)) continue
    if (isHiddenAttributeValue(value)) continue
    const kind = /(holo|film|膜)/i.test(key) ? 'film'
      : /(material|材质)/i.test(key) ? 'material' : 'technique'
    // Public and local catalogs use different option names and occasionally
    // differ only in English capitalization. Use the shared Chinese labels
    // and a stable display case so equivalent products produce the same page.
    const displayValue = value.replace(/\b[a-z][a-z']*/gi, word => /^[A-Z0-9]+$/.test(word) ? word : word.length === 1 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
    fields.push({ key: `attribute-${kind}-${fields.length}`, text: `${kind === 'film' ? '膜' : kind === 'material' ? '材质' : '工艺'}: ${displayValue}` })
  }
  return fields
}

export function detailsForAsset(asset: Asset, configs: ProductConfig[] = []): ImageDetails {
  const finish = finishName(asset, configs)
  const material = /stickers?|贴纸/i.test(asset.productName ?? '')
    ? attr(asset, ['Material', '材质']) : ''
  const details: ImageDetails = {
    size: dimensionForItem(asset, {}).label,
    qt: attr(asset, ['QT', '数量', 'Quantity']),
    finish: [material, finish].filter(Boolean).join(' '),
    fields: productionAttributeFields(asset, asset.productName),
    accessoryImage: accessoryImage(asset),
  }
  const code = accessoryCode(asset)
  const note = asset.note?.trim() || ''
  const noteImages = getNoteImages(asset)
  if (code) details.accessoryCode = code
  if (note) {
    details.note = note
    details.textOverrides = { note: {
      fontSize: Number.isFinite(asset.noteFontSize) ? Math.max(6, Math.min(72, asset.noteFontSize!)) : DEFAULT_NOTE_FONT_SIZE,
      color: asset.noteColor || DEFAULT_NOTE_COLOR,
    } }
  }
  if (noteImages.length) { details.noteImages = noteImages; details.noteImage = noteImages[0].src }
  return details
}



