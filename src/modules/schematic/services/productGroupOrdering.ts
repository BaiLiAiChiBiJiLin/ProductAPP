import type { Asset } from '../../../model'

/** Put product groups first in badge-number order, then retain ordinary image order. */
export function orderAssetsByProductGroup(assets: Asset[]): Asset[] {
  const grouped = new Map<string, Asset[]>()
  const ordinary: Asset[] = []
  for (const asset of assets) {
    const groupId = asset.productGroupId
    if (!groupId) {
      ordinary.push(asset)
      continue
    }
    const existing = grouped.get(groupId)
    if (existing) {
      existing.push(asset)
      continue
    }
    grouped.set(groupId, [asset])
  }
  return [...[...grouped.values()].map(members => members.some(asset => (asset.productGroupPosition ?? 0) > 0)
    ? [...members].sort((a, b) => (a.productGroupPosition ?? 0) - (b.productGroupPosition ?? 0))
    : members).flat(), ...ordinary]
}
