import type { Page } from '../../../model.ts'
import { headerFor } from '../arrangement/pageSections.ts'

/**
 * Remove only the selected artwork placements from the canvas.
 *
 * A page group is a visual container, so deleting one member must keep the
 * remaining members and the container alive. Detail cells and per-item size
 * labels are pruned alongside the removed placement. If a derived placement
 * remains after its source is deleted, it becomes an independent placement
 * instead of keeping a dangling `derivedFrom` reference.
 */
export function removeCanvasItems(pages: Page[], itemIds: string[]): Page[] {
  const removed = new Set(itemIds)
  if (!removed.size) return pages
  const trimDetails = (details: NonNullable<NonNullable<Page['imageGroups']>[number]['details']>) => {
    if (!details.sizes) return details
    const sizes = details.sizes.filter(entry => !removed.has(entry.itemId))
    return { ...details, sizes, ...(sizes[0] ? { size: sizes[0].label } : {}) }
  }
  return pages.map(page => {
    if (!page.items.some(item => removed.has(item.id))) return page
    const items = page.items
      .filter(item => !removed.has(item.id))
      .map(item => item.derivedFrom && removed.has(item.derivedFrom) ? { ...item, derivedFrom: undefined } : item)
    const remaining = new Set(items.map(item => item.id))
    const imageGroups = page.imageGroups?.map(group => {
      const nextItemIds = group.itemIds.filter(id => remaining.has(id))
      const details = group.details ? trimDetails(group.details) : group.details
      const detailGroups = group.detailGroups?.map(panel => ({
        ...panel,
        itemIds: panel.itemIds.filter(id => remaining.has(id)),
        details: trimDetails(panel.details),
      })).filter(panel => panel.itemIds.length)
      return {
        ...group,
        itemIds: nextItemIds,
        imageCells: group.imageCells?.filter(cell => !removed.has(cell.itemId)),
        details,
        detailGroups,
      }
    }).filter(group => group.itemIds.length)
    const usedHeaders = new Set((imageGroups ?? []).map(group => headerFor(page, group)))
    const headerBlocks = page.headerBlocks?.filter(header => !header.auto || usedHeaders.has(header))
    return { ...page, items, imageGroups, headerBlocks }
  })
}
