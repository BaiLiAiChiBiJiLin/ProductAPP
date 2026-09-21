import { defaultLayoutBounds, type Asset, type LayoutBounds, type Page } from '../../../model.ts'
import type { ProductConfig } from './productConfigService.ts'
import { paginateThreeColumns } from '../arrangement/threeColumnLayout.ts'
import { dimensionForItem } from './imageDimensionService.ts'
export function paginateAssets(assets: Asset[], _pageSize = 12, bounds: LayoutBounds = defaultLayoutBounds, configs: ProductConfig[] = []): Page[] {
  return paginateThreeColumns(assets, bounds, configs)
}
export function autoArrangePages(pages: Page[], _activePage: number, assets: Asset[], bounds: LayoutBounds, configs: ProductConfig[] = []): Page[] {
  const originals = pages.flatMap(page => page.items.filter(item => !item.derivedFrom))
  const used = new Set(originals.map(item => item.assetId))
  const groupByAsset = new Map<string, string>()
  for (const page of pages) for (const group of page.imageGroups ?? []) {
    if (group.stacked !== 'vertical') continue
    for (const item of page.items) if (group.itemIds.includes(item.id)) groupByAsset.set(item.assetId, group.productGroupId || group.id)
  }
  const chosen = assets.filter(asset => used.has(asset.id)).map(asset => groupByAsset.has(asset.id) ? { ...asset, productGroupId: groupByAsset.get(asset.id) } : asset)
  const result = paginateThreeColumns(chosen, bounds, configs)
  for (const page of result) {
    page.items = page.items.map(item => {
      const previous = originals.find(candidate => candidate.assetId === item.assetId)
      return previous ? { ...item, rulerUnit: previous.rulerUnit, rulerWidth: previous.rulerWidth, rulerHeight: previous.rulerHeight } : item
    })
    for (const group of page.imageGroups ?? []) {
      if (groupByAsset.has(page.items.find(item => group.itemIds.includes(item.id))?.assetId ?? '')) group.stacked = 'vertical'
      const item = page.items.find(item => group.itemIds.includes(item.id) && !item.derivedFrom)
      const asset = chosen.find(asset => asset.id === item?.assetId)
      if (group.details?.sizes) group.details.sizes = group.details.sizes.map(value => {
        const member = page.items.find(item => item.id === value.itemId)
        const source = chosen.find(asset => asset.id === member?.assetId)
        return member && source ? { ...value, label: dimensionForItem(source, member).label } : value
      })
      if (item && asset && group.details) group.details.size = dimensionForItem(asset, item).label
    }
  }
  return result
}


