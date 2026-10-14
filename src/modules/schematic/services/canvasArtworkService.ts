import type { Asset, Page } from '../../../model'
import type { ImageDetails, ImageGroup } from '../layoutTypes'
import { replaceAssetArtwork } from './assetReplacementService'
import { rulerDimensionLabel, type DimensionDisplayOverride } from './imageDimensionService'

/** Replace one canvas instance without changing other instances of its source asset. */
export function replaceCanvasItemArtwork(assets: Asset[], pages: Page[], itemId: string, artwork: Asset, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>): { assets: Asset[]; pages: Page[] } {
  const pageIndex = pages.findIndex(page => page.items.some(item => item.id === itemId))
  if (pageIndex < 0) throw new Error('需要更换的图片已不在当前示意图中')
  const page = pages[pageIndex]
  const itemIndex = page.items.findIndex(item => item.id === itemId)
  const item = page.items[itemIndex]
  const original = assets.find(asset => asset.id === item.assetId)
  if (!original) throw new Error('需要更换的图片资源已不存在，请重新载入示意图')
  if (![artwork.width, artwork.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('新图片尺寸无效，请重新选择文件')
  }

  // Reuse the list replacement's artwork/property merge and resource-ID checks.
  // The old asset and its group leader remain available to the other canvas items.
  const replacement = replaceAssetArtwork(assets, original.id, artwork).find(asset => asset.id === artwork.id)!
  const canvasAsset = { ...replacement, productGroupLeaderId: original.productGroupLeaderId }
  const scale = Math.min(item.w / artwork.width, item.h / artwork.height)
  const nextItem = {
    ...item, assetId: artwork.id, arrangementSourceAssetId: item.arrangementSourceAssetId ?? item.assetId,
    w: artwork.width * scale, h: artwork.height * scale, backSvg: undefined, svgLayerId: undefined,
  }
  const override = displayOverrides?.get(itemId)
  const label = rulerDimensionLabel(canvasAsset, nextItem, override?.precision, override?.decimalPlaces)
    // Disabled rulers hide Size at render time. Keep its replacement value in
    // saved details so turning the ruler back on cannot restore the old size.
    ?? rulerDimensionLabel(canvasAsset, {
      ...nextItem, rulerWidth: nextItem.sizeAxis ? nextItem.sizeAxis === 'width' : undefined,
      rulerHeight: nextItem.sizeAxis ? nextItem.sizeAxis === 'height' : undefined,
    }, override?.precision, override?.decimalPlaces)!
  const refreshDetails = (details: ImageDetails, itemIds: string[]): ImageDetails => {
    if (!itemIds.includes(itemId)) return details
    if (details.sizes) {
      if (!details.sizes.some(value => value.itemId === itemId)) return details
      return { ...details, sizes: details.sizes.map(value => value.itemId === itemId ? { ...value, label } : value) }
    }
    const mainId = itemIds.find(id => page.items.some(candidate => candidate.id === id
      && !candidate.derivedFrom && candidate.caption?.trim().toLowerCase() !== 'base'))
    return mainId === itemId ? { ...details, size: label } : details
  }
  const refreshGroup = (group: ImageGroup): ImageGroup => {
    const details = group.details && refreshDetails(group.details, group.itemIds)
    const detailGroups = group.detailGroups?.map(panel => {
      const details = refreshDetails(panel.details, panel.itemIds)
      return details === panel.details ? panel : { ...panel, details }
    })
    const panelsChanged = detailGroups?.some((panel, index) => panel !== group.detailGroups?.[index])
    return details === group.details && !panelsChanged ? group : { ...group, details, detailGroups }
  }
  const imageGroups = page.imageGroups?.map(refreshGroup)
  return {
    assets: [...assets, canvasAsset],
    pages: pages.map((candidate, index) => index === pageIndex
      ? { ...candidate, items: candidate.items.map((value, index) => index === itemIndex ? nextItem : value),
        ...(imageGroups?.some((group, index) => group !== page.imageGroups?.[index]) ? { imageGroups } : {}) }
      : candidate),
  }
}
