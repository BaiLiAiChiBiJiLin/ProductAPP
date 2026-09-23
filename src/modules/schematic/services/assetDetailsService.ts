import { dimensionForItem } from './imageDimensionService.ts'
import type { Asset } from '../../../model.ts'
import type { ImageDetails } from '../layoutTypes.ts'
import type { ProductConfig } from './productConfigService.ts'
import type { FinishLookup } from './finishService.ts'
import { finishNameFromLookup } from './finishService.ts'

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
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
  const saved = attr(asset, ['工艺']) || (asset.productId.startsWith('custom:') ? attr(asset, ['Finish']) : '')
  if (saved) return saved
  const value = attr(asset, ['Finish', '表面', '工艺'])
  if (!value) return ''
  const cached = finishNameFromLookup(value, finishLookup)
  if (cached) return cached
  // Product configuration is a useful fallback while an older desktop build
  // has no local finish cache yet. It still returns the canonical option name.
  const product = configs.find(config => config.id === asset.productId)
  const option = product?.options.find(candidate => ['finish', '表面', '工艺'].includes(normalize(candidate.name)) || ['finish', '表面', '工艺'].includes(normalize(candidate.label)))
  const match = option?.values.find(candidate => normalize(candidate.name) === normalize(value) || normalize(candidate.label) === normalize(value))
  // Older batches can be opened before the local finish cache finishes loading.
  // Keep the saved process visible in that case; the cache still takes
  // precedence whenever it contains a canonical name.
  return match?.name ?? value
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

export function detailsForAsset(asset: Asset, configs: ProductConfig[] = []): ImageDetails {
  const details: ImageDetails = {
    size: dimensionForItem(asset, {}).label,
    qt: attr(asset, ['QT', '数量', 'Quantity']),
    finish: finishName(asset, configs),
    accessoryImage: accessoryImage(asset),
  }
  const code = accessoryCode(asset)
  const note = asset.note?.trim() || ''
  const noteImage = asset.noteImage?.trim() || ''
  if (code) details.accessoryCode = code
  if (note) details.note = note
  if (noteImage) details.noteImage = noteImage
  return details
}



