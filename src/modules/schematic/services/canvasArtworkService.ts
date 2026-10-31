import type { Asset, Item, Page } from '../../../model'
import type { ImageDetails, ImageGroup } from '../layoutTypes'
import { productLayoutKind } from '../arrangement/threeColumnLayout'
import { replaceAssetArtwork } from './assetReplacementService'
import { rulerDimensionLabel, type DimensionDisplayOverride } from './imageDimensionService'
import { backLayerSvg } from './svgBackLayerService'

/** Replace the list artwork and every canvas reference to that resource together. */
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

  const nextAssets = replaceAssetArtwork(assets, original.id, artwork)
  const replacement = nextAssets.find(asset => asset.id === artwork.id)!
  const isMain = (candidate: Item) => !candidate.derivedFrom && candidate.caption?.trim().toLowerCase() !== 'base'
  let replacementBack: string | undefined
  return {
    assets: nextAssets,
    pages: pages.map(candidate => {
      const labels = new Map<string, string>()
      const items = candidate.items.map(value => {
        const sourceId = value.arrangementSourceAssetId === original.id ? artwork.id : value.arrangementSourceAssetId
        if (value.assetId !== original.id) {
          return sourceId === value.arrangementSourceAssetId ? value : { ...value, arrangementSourceAssetId: sourceId }
        }
        const scale = Math.min(value.w / artwork.width, value.h / artwork.height)
        const nextItem: Item = {
          ...value, assetId: artwork.id, arrangementSourceAssetId: sourceId === artwork.id ? undefined : sourceId,
          w: artwork.width * scale, h: artwork.height * scale,
          backSvg: value.derivedFrom
            ? replacementBack ??= backLayerSvg(replacement.svg, productLayoutKind(replacement) === 'standee', replacement.sourceImages)
            : undefined,
          svgLayerId: undefined, svgLayerIds: undefined,
        }
        if (isMain(nextItem)) {
          const override = displayOverrides?.get(value.id)
          // Hidden rulers still need the replacement Size for when they are enabled again.
          const label = rulerDimensionLabel(replacement, nextItem, override?.precision, override?.decimalPlaces)
            ?? rulerDimensionLabel(replacement, {
              ...nextItem, rulerWidth: nextItem.sizeAxis ? nextItem.sizeAxis === 'width' : undefined,
              rulerHeight: nextItem.sizeAxis ? nextItem.sizeAxis === 'height' : undefined,
            }, override?.precision, override?.decimalPlaces)!
          labels.set(value.id, label)
        }
        return nextItem
      })
      const refreshDetails = (details: ImageDetails, itemIds: string[]): ImageDetails => {
        if (details.sizes) {
          if (!details.sizes.some(value => labels.has(value.itemId))) return details
          return { ...details, sizes: details.sizes.map(value => labels.has(value.itemId)
            ? { ...value, label: labels.get(value.itemId)! } : value) }
        }
        const mainId = itemIds.find(id => items.some(value => value.id === id && isMain(value)))
        const label = mainId && labels.get(mainId)
        return label === undefined ? details : { ...details, size: label }
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
      const imageGroups = candidate.imageGroups?.map(refreshGroup)
      const headerBlocks = candidate.headerBlocks?.map(header => header.assetIds?.includes(original.id)
        ? { ...header, assetIds: header.assetIds.map(id => id === original.id ? artwork.id : id) } : header)
      const itemsChanged = items.some((value, index) => value !== candidate.items[index])
      const groupsChanged = imageGroups?.some((value, index) => value !== candidate.imageGroups?.[index])
      const headersChanged = headerBlocks?.some((value, index) => value !== candidate.headerBlocks?.[index])
      if (!itemsChanged && !groupsChanged && !headersChanged) return candidate
      return { ...candidate,
        ...(itemsChanged ? { items } : {}),
        ...(groupsChanged ? { imageGroups } : {}),
        ...(headersChanged ? { headerBlocks } : {}),
      }
    }),
  }
}

/** Replace only the canvas placement under a pool drop, keeping the old asset in the pool. */
export function replaceCanvasItemWithAsset(pages: Page[], itemId: string, artwork: Asset, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>): Page[] {
  const pageIndex = pages.findIndex(page => page.items.some(item => item.id === itemId))
  if (pageIndex < 0) throw new Error('需要更换的图片已不在当前示意图中')
  if (![artwork.width, artwork.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('新图片尺寸无效，请重新选择文件')
  const page = pages[pageIndex]
  const item = page.items.find(value => value.id === itemId)!
  const scale = Math.min(item.w / artwork.width, item.h / artwork.height)
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('无法计算新图片尺寸')
  const labels = new Map<string, string>()
  const nextItem: Item = {
    ...item,
    assetId: artwork.id,
    arrangementSourceAssetId: undefined,
    w: artwork.width * scale,
    h: artwork.height * scale,
    backSvg: item.derivedFrom ? backLayerSvg(artwork.svg, productLayoutKind(artwork) === 'standee', artwork.sourceImages) : undefined,
    svgLayerId: undefined,
    svgLayerIds: undefined,
  }
  if (!nextItem.derivedFrom && nextItem.caption?.trim().toLowerCase() !== 'base') {
    const override = displayOverrides?.get(item.id)
    labels.set(item.id, rulerDimensionLabel(artwork, nextItem, override?.precision, override?.decimalPlaces)
      ?? rulerDimensionLabel(artwork, { ...nextItem, rulerWidth: nextItem.sizeAxis ? nextItem.sizeAxis === 'width' : undefined, rulerHeight: nextItem.sizeAxis ? nextItem.sizeAxis === 'height' : undefined }, override?.precision, override?.decimalPlaces)!)
  }
  const updateDetails = (details: ImageDetails | undefined, itemIds: string[]) => {
    if (!details || !labels.size || !itemIds.some(id => labels.has(id))) return details
    if (details.sizes) return { ...details, sizes: details.sizes.map(value => labels.has(value.itemId) ? { ...value, label: labels.get(value.itemId)! } : value) }
    const mainId = itemIds.find(id => labels.has(id))
    return mainId ? { ...details, size: labels.get(mainId)! } : details
  }
  const updateGroup = (group: ImageGroup) => {
    const details = updateDetails(group.details, group.itemIds)
    const detailGroups = group.detailGroups?.map(panel => ({ ...panel, details: updateDetails(panel.details, panel.itemIds)! }))
    const panelsChanged = detailGroups?.some((panel, index) => panel.details !== group.detailGroups?.[index]?.details) ?? false
    return details === group.details && !panelsChanged ? group : { ...group, details, detailGroups }
  }
  return pages.map((candidate, index) => index !== pageIndex ? candidate : {
    ...candidate,
    items: candidate.items.map(value => value.id === itemId ? nextItem : value),
    imageGroups: candidate.imageGroups?.map(updateGroup),
  })
}
