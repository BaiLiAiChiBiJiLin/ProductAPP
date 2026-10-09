import type { Asset, Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { refreshStandeeDefaultSize, rulerDimensionLabel, type DimensionDisplayOverride, type DimensionDisplayPrecision } from './imageDimensionService.ts'

function detailsForDisplay(details: NonNullable<ImageGroup['details']>, page: Page, assets: Map<string, Asset>, itemIds: string[], selected: Set<string>, precision: DimensionDisplayPrecision, decimalPlaces: number, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  const labels = new Map<string, string>()
  const firstItem = itemIds.find(id => page.items.some(item => item.id === id && !item.derivedFrom))
  for (const item of page.items) {
    if (!itemIds.includes(item.id)) continue
    const asset = assets.get(item.assetId)
    if (asset) {
      const override = displayOverrides?.get(item.id)
      const explicitDisplay = selected.has(item.id) || Boolean(override)
      const currentLabel = details.sizes?.length ? details.sizes.find(value => value.itemId === item.id)?.label
        : item.id === firstItem ? details.size : undefined
      const label = explicitDisplay
        ? rulerDimensionLabel(asset, item, override?.precision ?? precision, override?.decimalPlaces ?? decimalPlaces)
        : currentLabel !== undefined ? refreshStandeeDefaultSize(asset, item, currentLabel) : undefined
      if (label && (explicitDisplay || label !== currentLabel)) labels.set(item.id, label)
    }
  }
  if (!labels.size) return details
  const firstLabel = [...labels].find(([id]) => selected.has(id) || displayOverrides?.has(id))?.[1]
    ?? labels.values().next().value
  return { ...details,
    size: details.sizes?.length ? details.size : firstLabel ?? details.size,
    sizes: details.sizes?.map(value => labels.has(value.itemId) ? { ...value, label: labels.get(value.itemId)! } : value),
  }
}

export function groupForDimensionDisplay(group: ImageGroup, page: Page | undefined, assets: Map<string, Asset> | undefined, selectedItemIds: string[] = [], precision: DimensionDisplayPrecision = 'default', decimalPlaces = 1, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  if (!page || !assets) return group
  const selected = new Set(selectedItemIds)
  const details = group.details
    ? detailsForDisplay(group.details, page, assets, group.itemIds, selected, precision, decimalPlaces, displayOverrides)
    : group.details
  const detailGroups = group.detailGroups?.map(panel => {
    const details = detailsForDisplay(panel.details, page, assets, panel.itemIds, selected, precision, decimalPlaces, displayOverrides)
    return details === panel.details ? panel : { ...panel, details }
  })
  const panelsChanged = detailGroups?.some((panel, index) => panel !== group.detailGroups?.[index])
  return details === group.details && !panelsChanged ? group : { ...group, details, detailGroups }
}

/** Build export-only labels with the same display rules as the canvas. */
export function pageForDimensionDisplay(page: Page, assets: Map<string, Asset>, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>): Page {
  const imageGroups = page.imageGroups?.map(group => groupForDimensionDisplay(group, page, assets, [], 'default', 1, displayOverrides))
  return imageGroups?.some((group, index) => group !== page.imageGroups?.[index]) ? { ...page, imageGroups } : page
}
