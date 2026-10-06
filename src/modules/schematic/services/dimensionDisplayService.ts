import type { Asset, Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { rulerDimensionLabel, type DimensionDisplayOverride, type DimensionDisplayPrecision } from './imageDimensionService.ts'

function detailsForDisplay(details: NonNullable<ImageGroup['details']>, page: Page, assets: Map<string, Asset>, itemIds: string[], selected: Set<string>, precision: DimensionDisplayPrecision, decimalPlaces: number, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  const labels = new Map<string, string>()
  for (const item of page.items) {
    if (!itemIds.includes(item.id) || (!selected.has(item.id) && !displayOverrides?.has(item.id))) continue
    const asset = assets.get(item.assetId)
    if (asset) {
      const override = displayOverrides?.get(item.id)
      const label = rulerDimensionLabel(asset, item, override?.precision ?? precision, override?.decimalPlaces ?? decimalPlaces)
      if (label) labels.set(item.id, label)
    }
  }
  if (!labels.size) return details
  const firstLabel = labels.values().next().value as string | undefined
  return { ...details,
    size: details.sizes?.length ? details.size : firstLabel ?? details.size,
    sizes: details.sizes?.map(value => labels.has(value.itemId) ? { ...value, label: labels.get(value.itemId)! } : value),
  }
}

export function groupForDimensionDisplay(group: ImageGroup, page: Page | undefined, assets: Map<string, Asset> | undefined, selectedItemIds: string[] = [], precision: DimensionDisplayPrecision = 'default', decimalPlaces = 1, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  if (!page || !assets || (!selectedItemIds.length && !displayOverrides?.size)) return group
  const selected = new Set(selectedItemIds)
  const isDisplayed = (id: string) => selected.has(id) || Boolean(displayOverrides?.has(id))
  const details = group.details && group.itemIds.some(isDisplayed)
    ? detailsForDisplay(group.details, page, assets, group.itemIds, selected, precision, decimalPlaces, displayOverrides)
    : group.details
  const detailGroups = group.detailGroups?.map(panel => panel.itemIds.some(isDisplayed)
    ? { ...panel, details: detailsForDisplay(panel.details, page, assets, panel.itemIds, selected, precision, decimalPlaces, displayOverrides) }
    : panel)
  return details === group.details && detailGroups === group.detailGroups ? group : { ...group, details, detailGroups }
}

/** Build export-only labels with the same display rules as the canvas. */
export function pageForDimensionDisplay(page: Page, assets: Map<string, Asset>, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>): Page {
  if (!displayOverrides?.size) return page
  return { ...page, imageGroups: page.imageGroups?.map(group => groupForDimensionDisplay(group, page, assets, [], 'default', 1, displayOverrides)) }
}
