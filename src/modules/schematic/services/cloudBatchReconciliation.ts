import type { Asset } from '../../../model'
import type { BatchMetadata } from '../types'

function sameAttributes(left: Asset['attributes'], right: Asset['attributes']) {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])
  return [...keys].every(key => left?.[key] === right?.[key])
}

/** A background reply can enrich a submitted snapshot, never replace newer edits. */
export function reconcileCloudBatchAssets(current: Asset[], submitted: Asset[], persisted: Asset[]): Asset[] {
  const submittedById = new Map(submitted.map(asset => [asset.id, asset]))
  const persistedById = new Map(persisted.map(asset => [asset.id, asset]))
  return current.map(asset => {
    const before = submittedById.get(asset.id)
    const saved = persistedById.get(asset.id)
    // Shared saves retain IDs. Never borrow a deleted/replaced image's result by index.
    if (!before || !saved) return asset
    const unchanged = asset.productId === before.productId
      && asset.productName === before.productName
      && asset.finishMatchDisabled === before.finishMatchDisabled
      && sameAttributes(asset.attributes, before.attributes)
    const attributes = unchanged ? saved.attributes ?? asset.attributes : asset.attributes
    const storagePath = asset.storagePath === before.storagePath ? saved.storagePath || asset.storagePath : asset.storagePath
    return attributes === asset.attributes && storagePath === asset.storagePath ? asset : { ...asset, attributes, storagePath }
  })
}

export function reconcileCloudBatchMetadata(current: BatchMetadata, submitted: Partial<BatchMetadata>, persisted: Partial<BatchMetadata>): BatchMetadata {
  const next = { ...current }
  for (const key of ['customerName', 'drawingDate', 'estimatedShipDate', 'designer'] as const) {
    if (current[key] === submitted[key] && typeof persisted[key] === 'string') next[key] = persisted[key]
  }
  return next
}
