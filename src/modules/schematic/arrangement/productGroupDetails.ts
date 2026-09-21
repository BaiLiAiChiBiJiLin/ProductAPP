import type { Asset, Item } from '../../../model.ts'
import type { ImageDetails, ImageGroup } from '../layoutTypes.ts'
import type { ProductConfig } from '../services/productConfigService.ts'
import { detailsForAsset } from '../services/assetDetailsService.ts'

/** Product-group panels are intentionally limited to the four production fields. */
export function buildProductGroupDetails(items: Item[], assets: Map<string, Asset>, configs: ProductConfig[] = []): NonNullable<ImageGroup['detailGroups']> {
  const grouped = new Map<string, { itemIds: string[]; details: ImageDetails }>()
  items.forEach(item => {
    const asset = assets.get(item.assetId)
    if (!asset) return
    const visible = detailsForAsset(asset, configs)
    const key = JSON.stringify([visible.size, visible.qt, visible.finish, visible.accessoryImage ?? '', visible.accessoryCode ?? '', visible.note ?? '', visible.noteImage ?? ''])
    const previous = grouped.get(key)
    if (previous) { previous.itemIds.push(item.id); return }
    grouped.set(key, { itemIds: [item.id], details: visible })
  })
  return [...grouped.values()].map(({ itemIds, details }) => ({ itemIds, details }))
}

/** Reuse the existing right-half details renderer in independently bounded grid panels. */
export function detailPanelsForGroup(group: ImageGroup): ImageGroup[] {
  if (!group.detailGroups?.length) return [{ ...group, height: group.detailsHeight ?? group.height }]
  const count = group.detailGroups.length
  const columns = Math.min(group.imageColumns ?? 1, count)
  const rows = Math.ceil(count / columns)
  const detailsStart = group.detailsX ?? group.x + group.width / 2
  const totalDetailWidth = group.detailWidth ?? group.width / 2
  const width = totalDetailWidth / columns
  const height = group.height / rows
  return group.detailGroups.map((panel, index) => ({ ...group, id: `${group.id}-details-${index}`, itemIds: panel.itemIds,
    // imageDetailsLayout uses detailsX as the panel's content origin.
    x: detailsStart + (index % columns) * width - width,
    y: group.y + Math.floor(index / columns) * height, width: width * 2, height,
    details: panel.details, detailGroups: undefined, detailWidth: width,
    detailsX: detailsStart + (index % columns) * width,
  }))
}


