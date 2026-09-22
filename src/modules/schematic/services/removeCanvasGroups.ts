import type { Page } from '../../../model.ts'
import { headerFor } from '../arrangement/pageSections.ts'

/** Remove placements only. Original assets and their product-group metadata stay in the pool. */
export function removeCanvasGroups(pages: Page[], groupIds: string[]): Page[] {
  const selected = new Set(groupIds)
  return pages.map(page => {
    const removed = page.imageGroups?.filter(group => selected.has(group.id)) ?? []
    if (!removed.length) return page
    const ids = new Set(removed.flatMap(group => group.itemIds))
    const imageGroups = page.imageGroups!.filter(group => !selected.has(group.id))
    const items = page.items.filter(item => !ids.has(item.id) && !(item.derivedFrom && ids.has(item.derivedFrom)))
    const usedHeaders = new Set(imageGroups.map(group => headerFor(page, group)))
    const headerBlocks = page.headerBlocks?.filter(header => !header.auto || usedHeaders.has(header))
    return { ...page, items, imageGroups, headerBlocks }
  })
}
