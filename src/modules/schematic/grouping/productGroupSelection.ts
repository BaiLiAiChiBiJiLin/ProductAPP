import type { Asset } from '../../../model'

/** Confirmed artwork cannot be recruited into a guide, including bulk selection. */
export function initialGroupAssets(assets: Asset[], selectedIds: string[], allowConfirmed = false): Asset[] {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  return [...new Set(selectedIds)].flatMap(id => {
    const asset = byId.get(id)
    return asset && !asset.productGroupId && (allowConfirmed || !asset.attributesConfirmed) ? [asset] : []
  })
}

export function canSelectGroupAsset(asset: Asset, memberIds: string[], source: 'list' | 'thumbnail' = 'list', free = false): boolean {
  // Existing thumbnails edit members without recruiting a confirmed image again.
  if (source === 'thumbnail') return memberIds.includes(asset.id)
  if (free) return !asset.productGroupId || memberIds.includes(asset.id)
  return !asset.attributesConfirmed && (!asset.productGroupId || memberIds.includes(asset.id))
}
