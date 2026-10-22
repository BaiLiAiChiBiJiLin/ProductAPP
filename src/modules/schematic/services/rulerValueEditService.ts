import type { Asset, Page } from '../../../model.ts'
import { rulerDimensionLabel, rulerSizeAxis, type DimensionDisplayOverride } from './imageDimensionService.ts'

/** Update one measurement and its matching Size; visual ruler endpoints stay in place. */
export function updateRulerDimensionValue(page: Page, itemId: string, axis: 'width' | 'height', value: number, assets: Map<string, Asset>, displayOverrides?: ReadonlyMap<string, DimensionDisplayOverride>): Page {
  if (!Number.isFinite(value) || value <= 0) return page
  const item = page.items.find(candidate => candidate.id === itemId)
  const asset = item && assets.get(item.assetId)
  if (!item || !asset || item.suppressRuler) return page
  const valueMm = value * (item.rulerUnit === 'cm' ? 10 : item.rulerUnit === 'in' ? 25.4 : 1)
  if (!Number.isFinite(valueMm)) return page
  const updated = { ...item, ...(axis === 'width' ? { rulerWidthMm: valueMm } : { rulerHeightMm: valueMm }) }
  const items = page.items.map(candidate => candidate.id === itemId ? updated : candidate)
  if (rulerSizeAxis(asset, updated) !== axis) return { ...page, items }
  const override = displayOverrides?.get(itemId)
  const label = rulerDimensionLabel(asset, updated, override?.precision, override?.decimalPlaces)
  if (!label) return { ...page, items }
  const updateDetails = (details: NonNullable<Page['imageGroups']>[number]['details'], ids: string[]) => {
    if (!details || !ids.includes(itemId)) return details
    const primary = ids.find(id => items.some(candidate => candidate.id === id && !candidate.derivedFrom))
    return { ...details,
      size: primary === itemId ? label : details.size,
      sizes: details.sizes?.map(entry => entry.itemId === itemId ? { ...entry, label } : entry),
    }
  }
  return { ...page, items, imageGroups: page.imageGroups?.map(group => ({ ...group,
    details: updateDetails(group.details, group.itemIds),
    detailGroups: group.detailGroups?.map(panel => ({ ...panel, details: updateDetails(panel.details, panel.itemIds)! })),
  })) }
}
