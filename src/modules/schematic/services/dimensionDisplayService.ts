import type { Asset, Page } from '../../../model.ts'
import type { ImageGroup } from '../layoutTypes.ts'
import { refreshStandeeDefaultSize, rulerDimensionAxis, rulerDimensionLabel, rulerSizeAxis, type DimensionDisplayOverride, type DimensionDisplayPrecision } from './imageDimensionService.ts'

function detailsForDisplay(details: NonNullable<ImageGroup['details']>, page: Page, assets: Map<string, Asset>, itemIds: string[], selected: Set<string>, precision: DimensionDisplayPrecision, decimalPlaces: number, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>) {
  const labels = new Map<string, string>()
  const hidden = new Set<string>()
  const firstItem = itemIds.find(id => page.items.some(item => item.id === id && !item.derivedFrom))
  for (const item of page.items) {
    if (!itemIds.includes(item.id)) continue
    const asset = assets.get(item.assetId)
    if (item.suppressRuler || (asset ? rulerDimensionAxis(asset, item) === 'none' : item.rulerWidth === false && item.rulerHeight === false)) {
      hidden.add(item.id)
      continue
    }
    if (asset) {
      const override = displayOverrides?.get(item.id)
      const sizeAxis = rulerSizeAxis(asset, item)
      const sizeOverrideMm = sizeAxis === 'width' ? item.rulerWidthMm : sizeAxis === 'height' ? item.rulerHeightMm : undefined
      const currentLabel = details.sizes?.length ? details.sizes.find(value => value.itemId === item.id)?.label
        : item.id === firstItem ? details.size : undefined
      const explicitDisplay = selected.has(item.id) || Boolean(override) || (currentLabel !== undefined && sizeOverrideMm !== undefined && Number.isFinite(sizeOverrideMm) && sizeOverrideMm > 0)
      const label = explicitDisplay
        ? rulerDimensionLabel(asset, item, override?.precision ?? (selected.has(item.id) ? precision : 'default'), override?.decimalPlaces ?? (selected.has(item.id) ? decimalPlaces : 1))
        : currentLabel !== undefined ? refreshStandeeDefaultSize(asset, item, currentLabel) : undefined
      if (label && (explicitDisplay || label !== currentLabel)) labels.set(item.id, label)
    }
  }
  const sizes = details.sizes?.filter(value => !hidden.has(value.itemId))
  const hideSize = details.sizes?.length ? !sizes?.length : Boolean(firstItem && hidden.has(firstItem))
  if (!labels.size && !hideSize && sizes?.length === details.sizes?.length) return details
  const firstLabel = [...labels].find(([id]) => selected.has(id) || displayOverrides?.has(id))?.[1]
    ?? labels.values().next().value
  return { ...details,
    // Hide display-only labels without deleting saved text, so re-enabling a
    // ruler restores its Size. Empty per-image lists must not fall back to Size.
    size: hideSize ? '' : details.sizes?.length ? details.size : firstLabel ?? details.size,
    sizes: sizes?.map(value => labels.has(value.itemId) ? { ...value, label: labels.get(value.itemId)! } : value),
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
