import type { Asset } from '../../../model.ts'

/** Toggle an asset; grouped assets are always selected or cleared together. */
export function toggleReviewAssetSelection(assets: Asset[], selectedIds: Set<string>, id: string) {
  const asset = assets.find(item => item.id === id)
  const memberIds = asset?.productGroupId
    ? assets.filter(item => item.productGroupId === asset.productGroupId).map(item => item.id)
    : [id]
  const groupSelected = memberIds.every(memberId => selectedIds.has(memberId))
  const next = new Set(selectedIds)
  memberIds.forEach(memberId => groupSelected ? next.delete(memberId) : next.add(memberId))
  return next
}
