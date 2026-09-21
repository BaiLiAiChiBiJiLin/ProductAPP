import type { Asset, Page } from '../../../model.ts'
import type { ProductConfig } from '../services/productConfigService.ts'
import { buildProductGroupDetails } from './productGroupDetails.ts'

/** Removing artwork must also remove its detail panel and measurement cell. */
export function removeArrangedAsset(page: Page, assetId: string, assets: Asset[], configs: ProductConfig[] = []): Page {
  const items = page.items.filter(item => item.assetId !== assetId)
  const byItem = new Map(items.map(item => [item.id, item]))
  const byAsset = new Map(assets.map(asset => [asset.id, asset]))
  return { ...page, items, imageGroups: page.imageGroups?.map(group => {
    const itemIds = group.itemIds.filter(id => byItem.has(id))
    const detailGroups = group.productGroupId ? buildProductGroupDetails(itemIds.map(id => byItem.get(id)!), byAsset, configs) : group.detailGroups
    return { ...group, itemIds, detailGroups, imageCells: group.imageCells?.filter(cell => byItem.has(cell.itemId)).map((cell, index) => ({ ...cell, label: `图 ${index + 1}` })) }
  }).filter(group => group.itemIds.length) }
}
