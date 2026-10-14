import { defaultLayoutBounds, type Asset, type Item, type LayoutBounds, type Page } from '../../../model.ts'
import type { ProductConfig } from './productConfigService.ts'
import { paginateThreeColumns } from '../arrangement/threeColumnLayout.ts'
import { rulerDimensionLabel } from './imageDimensionService.ts'
export function paginateAssets(assets: Asset[], _pageSize = 12, bounds: LayoutBounds = defaultLayoutBounds, configs: ProductConfig[] = []): Page[] {
  return paginateThreeColumns(assets, bounds, configs)
}
export function autoArrangePages(pages: Page[], _activePage: number, assets: Asset[], bounds: LayoutBounds, configs: ProductConfig[] = [], additionalAssetIds: readonly string[] = []): Page[] {
  const previousItems = pages.flatMap(page => page.items)
  const sourceId = (item: Item) => item.arrangementSourceAssetId ?? item.assetId
  const originals = previousItems.filter(item => !item.derivedFrom)
  const used = new Set([...originals.map(sourceId), ...additionalAssetIds])
  const assetsById = new Map(assets.map(asset => [asset.id, asset]))
  const previousByRole = new Map<string, Item[]>()
  const roleKey = (item: Item) => `${sourceId(item)}:${item.derivedFrom ? 'back' : 'front'}`
  for (const item of previousItems) {
    const key = roleKey(item)
    const candidates = previousByRole.get(key) ?? []
    candidates.push(item)
    previousByRole.set(key, candidates)
  }
  const groupByAsset = new Map<string, string>()
  for (const page of pages) for (const group of page.imageGroups ?? []) {
    if (group.stacked !== 'vertical') continue
    for (const item of page.items) if (group.itemIds.includes(item.id)) groupByAsset.set(sourceId(item), group.productGroupId || group.id)
  }
  const chosen = assets.filter(asset => used.has(asset.id)).map(asset => groupByAsset.has(asset.id) ? { ...asset, productGroupId: groupByAsset.get(asset.id) } : asset)
  const result = paginateThreeColumns(chosen, bounds, configs)
  for (const page of result) {
    page.items = page.items.map(item => {
      const candidates = previousByRole.get(roleKey(item))
      if (!candidates?.length) return item
      const exactIndex = candidates.findIndex(candidate => candidate.id === item.id)
      const [previous] = candidates.splice(exactIndex < 0 ? 0 : exactIndex, 1)
      const restored = { ...item, rulerUnit: previous.rulerUnit, rulerWidth: previous.rulerWidth, rulerHeight: previous.rulerHeight, sizeAxis: previous.sizeAxis, rulerWidthRange: previous.rulerWidthRange, rulerHeightRange: previous.rulerHeightRange }
      // Front and Back are independent canvas instances. Restore only explicit
      // artwork edits; unedited backs retain the newly generated default layer.
      if (!previous.arrangementSourceAssetId && previous.svgLayerId === undefined) return restored
      const artwork = assetsById.get(previous.assetId)
      if (!artwork) return restored
      const scale = Math.min(item.w / artwork.width, item.h / artwork.height)
      return {
        ...restored, assetId: previous.assetId, arrangementSourceAssetId: previous.arrangementSourceAssetId,
        backSvg: previous.backSvg, svgLayerId: previous.svgLayerId, mirrorX: previous.mirrorX,
        ...(previous.arrangementSourceAssetId ? { w: artwork.width * scale, h: artwork.height * scale } : {}),
      }
    })
    for (const group of page.imageGroups ?? []) {
      const firstMember = page.items.find(item => group.itemIds.includes(item.id))
      if (firstMember && groupByAsset.has(sourceId(firstMember))) group.stacked = 'vertical'
      const item = page.items.find(item => group.itemIds.includes(item.id) && !item.derivedFrom)
      const asset = item && assetsById.get(item.assetId)
      if (group.details?.sizes) group.details.sizes = group.details.sizes.map(value => {
        const member = page.items.find(item => item.id === value.itemId)
        const source = member && assetsById.get(member.assetId)
        const label = member && source ? rulerDimensionLabel(source, member) : undefined
        return label ? { ...value, label } : value
      })
      const label = item && asset ? rulerDimensionLabel(asset, item) : undefined
      if (label && group.details) group.details.size = label
    }
  }
  return result
}


