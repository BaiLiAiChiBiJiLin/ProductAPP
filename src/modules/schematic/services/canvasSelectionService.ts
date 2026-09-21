import type { Asset, Item, Page } from '../../../model.ts'
import { dimensionForItem } from './imageDimensionService.ts'

export type RulerPatch = Partial<Pick<Item, 'rulerUnit' | 'rulerWidth' | 'rulerHeight'>>
export type CanvasPoint = { x: number; y: number }
export function selectionBounds(start: CanvasPoint, end: CanvasPoint) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}
export function itemsInSelection(items: Item[], start: CanvasPoint, end: CanvasPoint): string[] {
  const box = selectionBounds(start, end)
  return items.filter(item => {
    const radians = item.rotation * Math.PI / 180
    const w = Math.abs(item.w * Math.cos(radians)) + Math.abs(item.h * Math.sin(radians))
    const h = Math.abs(item.w * Math.sin(radians)) + Math.abs(item.h * Math.cos(radians))
    return item.x + w / 2 >= box.x && item.x - w / 2 <= box.x + box.width && item.y + h / 2 >= box.y && item.y - h / 2 <= box.y + box.height
  }).map(item => item.id)
}
export function rulerAxes(item: Item, asset: Asset) {
  if (item.suppressRuler) return { rulerWidth: false, rulerHeight: false }
  const horizontal = dimensionForItem(asset, item).horizontal
  return { rulerWidth: item.rulerWidth ?? horizontal, rulerHeight: item.rulerHeight ?? !horizontal }
}
/** Apply once to page state; preserve each image's other axis and every group's Size list. */
export function updateSelectedRulers(page: Page, ids: string[], patch: RulerPatch, assets: Map<string, Asset>): Page {
  const selected = new Set(ids)
  const items = page.items.map(item => {
    const asset = assets.get(item.assetId)
    return selected.has(item.id) && asset && !item.suppressRuler ? { ...item, ...rulerAxes(item, asset), ...patch } : item
  })
  const byId = new Map(items.map(item => [item.id, item]))
  const label = (id: string) => {
    const item = byId.get(id), asset = item && assets.get(item.assetId)
    return item && asset ? dimensionForItem(asset, item).label : undefined
  }
  return { ...page, items, imageGroups: page.imageGroups?.map(group => {
    if (!group.details || !group.itemIds.some(id => selected.has(id))) return group
    const first = group.itemIds.find(id => !byId.get(id)?.derivedFrom)
    return { ...group, details: { ...group.details, size: first ? label(first) ?? group.details.size : group.details.size,
      sizes: group.details.sizes?.map(value => ({ ...value, label: label(value.itemId) ?? value.label })) } }
  }) }
}
